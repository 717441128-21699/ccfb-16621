/**
 * 氦语音模拟 AudioWorkletProcessor
 * --------------------------------
 * 在音频线程实时把普通麦克风语音“氦化”，供无真实潜水员时的端到端演示：
 * 分帧 LPC 求极点 → 按 q(F) 上移 → 残差重合成（基音保持）。
 * 与离线 simulator.ts 的区别：这里对真实输入做变换，而非从零合成。
 */

import { lpcAnalyze } from '../dsp/lpc.ts';
import { polynomialRoots } from '../dsp/formants.ts';
import { AllPoleFilter, InverseFilter } from '../dsp/synthesis.ts';
import { FrameFramer, OlaSynthesizer, applyHann } from '../dsp/framing.ts';
import { formantShiftFactor, type GasMix } from '../dsp/physics.ts';
import { DEFAULT_CONFIG } from '../dsp/unscrambler.ts';

interface Cplx {
  re: number;
  im: number;
}

class HeliumSimProcessor extends AudioWorkletProcessor {
  private readonly order: number;
  private readonly frameSize: number;
  private readonly hopSize: number;
  private readonly framer: FrameFramer;
  private readonly ola: OlaSynthesizer;
  private readonly inverse: InverseFilter;
  private readonly synth: AllPoleFilter;
  private mix: GasMix = { he: 0.9, o2: 0.1, n2: 0 };
  private depthM = 100;

  constructor() {
    super();
    const sr = sampleRate;
    this.order = DEFAULT_CONFIG.lpcOrder;
    this.frameSize = Math.round((DEFAULT_CONFIG.frameSize / DEFAULT_CONFIG.sampleRate) * sr);
    this.hopSize = Math.round((DEFAULT_CONFIG.hopSize / DEFAULT_CONFIG.sampleRate) * sr);
    this.framer = new FrameFramer({ frameSize: this.frameSize, hopSize: this.hopSize });
    this.ola = new OlaSynthesizer({ frameSize: this.frameSize, hopSize: this.hopSize });
    this.inverse = new InverseFilter(this.order);
    this.synth = new AllPoleFilter(this.order);

    this.port.onmessage = (ev: MessageEvent<{ mix?: GasMix; depthM?: number }>) => {
      if (ev.data.mix) this.mix = ev.data.mix;
      if (typeof ev.data.depthM === 'number') this.depthM = ev.data.depthM;
    };
  }

  /** 极点乘 q(F) 的氦化（校正端 correctFrequency 的逆运算） */
  private helmholtzize(a: Float64Array, gain: number): { a: Float64Array; gain: number } {
    const coef = new Float64Array(a.length + 1);
    coef[0] = 1;
    coef.set(a, 1);
    const roots = polynomialRoots(coef);
    const newRoots: Cplx[] = [];
    const sr = sampleRate;

    for (const z of roots) {
      const r = Math.min(Math.hypot(z.re, z.im), 0.9995);
      if (Math.abs(z.im) <= 1e-6) {
        newRoots.push({ re: z.re, im: 0 });
        continue;
      }
      if (z.im < 0) continue;
      const fAir = (Math.atan2(z.im, z.re) * sr) / (2 * Math.PI);
      const q = formantShiftFactor(fAir, this.mix, this.depthM);
      const fTarget = fAir * q;
      const bw = (-Math.log(r) * sr) / Math.PI;
      const radius = Math.min(Math.exp((-Math.PI * bw) / sr), 0.9995);
      const omega = (2 * Math.PI * fTarget) / sr;
      newRoots.push(
        { re: radius * Math.cos(omega), im: radius * Math.sin(omega) },
        { re: radius * Math.cos(omega), im: -radius * Math.sin(omega) },
      );
    }

    // 首一多项式重建（共轭根使虚部抵消，仅保留实部）
    let poly = new Float64Array([1]);
    for (const root of newRoots) {
      const d = root.re * root.re + root.im * root.im || 1e-20;
      const invRe = root.re / d;
      const next = new Float64Array(poly.length + 1);
      for (let i = 0; i < poly.length; i++) {
        next[i] += poly[i];
        next[i + 1] -= poly[i] * invRe;
      }
      poly = next;
    }
    return { a: poly.subarray(1) as Float64Array, gain };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0][0];
    if (!input) {
      output.fill(0);
      return true;
    }

    const frames = this.framer.push(input);
    const chunks: Float32Array[] = [];
    for (const raw of frames) {
      const windowed = applyHann(raw);
      const lpc = lpcAnalyze(windowed, this.order);
      const gain = Math.sqrt(Math.max(lpc.error, 1e-12));
      const he = this.helmholtzize(lpc.a, gain);
      const residual = this.inverse.process(windowed, lpc.a);
      const y = this.synth.process(residual, he.a, he.gain);
      const wy = new Float64Array(y.length);
      for (let i = 0; i < y.length; i++) {
        wy[i] = y[i] * (0.5 * (1 - Math.cos((2 * Math.PI * i) / (y.length - 1))));
      }
      chunks.push(this.ola.addFrame(wy));
    }

    if (chunks.length === 0) output.fill(0);
    else {
      let off = 0;
      for (const c of chunks) {
        const n = Math.min(c.length, output.length - off);
        output.set(c.subarray(0, n), off);
        off += n;
      }
      if (off < output.length) output.fill(0, off);
    }
    return true;
  }
}

registerProcessor('helium-sim', HeliumSimProcessor);
