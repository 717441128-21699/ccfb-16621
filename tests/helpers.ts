/** 测试公共工具：分帧跑完整校正引擎、稳定段共振峰提取 */

import { UnscramblerEngine, DEFAULT_CONFIG } from '../src/dsp/unscrambler.ts';
import { FrameFramer, OlaSynthesizer } from '../src/dsp/framing.ts';
import { lpcAnalyze } from '../src/dsp/lpc.ts';
import { polesFromLpc, type Pole } from '../src/dsp/formants.ts';
import { lockFormantTracks } from '../src/dsp/tracking.ts';
import { estimatePitch } from '../src/dsp/pitch.ts';
import type { GasMix } from '../src/dsp/physics.ts';

export function processOffline(
  signal: Float32Array,
  sampleRate: number,
  mix: GasMix,
  depthM: number,
  correction: boolean,
): Float32Array {
  const engine = new UnscramblerEngine({ ...DEFAULT_CONFIG, sampleRate });
  const framer = new FrameFramer({ frameSize: DEFAULT_CONFIG.frameSize, hopSize: DEFAULT_CONFIG.hopSize });
  const ola = new OlaSynthesizer({ frameSize: DEFAULT_CONFIG.frameSize, hopSize: DEFAULT_CONFIG.hopSize });
  const chunks: Float32Array[] = [];
  const frames = [...framer.push(signal), ...framer.flush()];
  for (const f of frames) {
    const { frame } = engine.processFrame(
      f,
      correction ? mix : { he: 0, o2: 0.21, n2: 0.79 },
      correction ? depthM : 0,
      (x) => estimatePitch(x, sampleRate).f0,
    );
    chunks.push(ola.addFrame(frame));
  }
  chunks.push(ola.flush());
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return merged;
}

/** 在某时间区间内用簇锁定求稳健的前三个共振峰（对初始化/偶发误配鲁棒） */
export function averageFormants(
  signal: Float32Array,
  sampleRate: number,
  tStart: number,
  tEnd: number,
): { f: number; bw: number }[] {
  const N = DEFAULT_CONFIG.frameSize;
  const hop = DEFAULT_CONFIG.hopSize;
  const startIdx = Math.round(tStart * sampleRate);
  const endIdx = Math.round(tEnd * sampleRate);
  const framePoles: Pole[][] = [];

  for (let i = startIdx; i + N < endIdx; i += hop) {
    const raw = new Float64Array(N);
    for (let j = 0; j < N; j++) raw[j] = signal[i + j];
    const frame = new Float64Array(N);
    frame[0] = raw[0];
    for (let j = 1; j < N; j++) frame[j] = raw[j] - 0.95 * raw[j - 1];
    for (let j = 0; j < N; j++) frame[j] *= 0.5 * (1 - Math.cos((2 * Math.PI * j) / (N - 1)));
    const lpc = lpcAnalyze(frame, DEFAULT_CONFIG.lpcOrder);
    framePoles.push(polesFromLpc(lpc.a, sampleRate));
  }

  const locked = lockFormantTracks(framePoles, framePoles.length, 3);
  return locked.map((x) => ({ f: x.f, bw: x.bw }));
}

/** 倒谱距离（LPC 对数谱失真，dB），客观可懂度代理 */
export function cepstralDistance(
  sigA: Float32Array,
  sigB: Float32Array,
  sampleRate: number,
  tStart: number,
  tEnd: number,
): number {
  const N = DEFAULT_CONFIG.frameSize;
  const hop = DEFAULT_CONFIG.hopSize;
  const startIdx = Math.round(tStart * sampleRate);
  const endIdx = Math.round(tEnd * sampleRate);
  const dists: number[] = [];

  for (let i = startIdx; i + N < endIdx; i += hop) {
    const fa = new Float64Array(N);
    const fb = new Float64Array(N);
    for (let j = 0; j < N; j++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * j) / (N - 1)));
      fa[j] = sigA[i + j] * w;
      fb[j] = sigB[i + j] * w;
    }
    const la = lpcAnalyze(fa, DEFAULT_CONFIG.lpcOrder);
    const lb = lpcAnalyze(fb, DEFAULT_CONFIG.lpcOrder);
    // 用全极点系数的 LPC 倒谱递推
    const cepA = lpcToCepstrum(la.a, 16);
    const cepB = lpcToCepstrum(lb.a, 16);
    let d = 0;
    for (let m = 1; m < cepA.length; m++) d += (cepA[m] - cepB[m]) ** 2;
    dists.push((10 / Math.LN10) * Math.sqrt(2 * d));
  }
  return dists.reduce((s, v) => s + v, 0) / (dists.length || 1);
}

function lpcToCepstrum(a: Float64Array, nCeps: number): number[] {
  const c = new Array(nCeps).fill(0);
  for (let n = 1; n < nCeps; n++) {
    let acc = 0;
    for (let k = 1; k < Math.min(n, a.length + 1); k++) {
      acc += ((n - k) / n) * c[n - k] * (a[k - 1] ?? 0);
    }
    c[n] = -(a[n - 1] ?? 0) - acc;
  }
  return c;
}
