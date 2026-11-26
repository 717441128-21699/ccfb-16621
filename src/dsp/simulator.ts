/**
 * 氦语音模拟合成器（离线生成测试/演示信号，含已知地面真值）
 * ---------------------------------------------------------
 * 1. 用声门脉冲串 + 全极点声道滤波器合成正常空气语音（元音-辅音串）
 * 2. 用与校正端相同的物理弯折 q(F) 把极点上移 → 氦语音（基音不变）
 * 3. 叠加呼吸阀气流噪声（低频持续）与气泡声（中高频突发）
 * 因为合成参数全部已知，可精确考核校正误差（≤10% 指标）。
 */

import { AllPoleFilter, glottalPulseTrain, whiteNoise } from './synthesis.ts';
import { formantShiftFactor, type GasMix } from './physics.ts';

export interface VowelSpec {
  label: string;
  /** 空气中共振峰 [F1, F2, F3] Hz 与带宽 */
  formants: { f: number; bw: number }[];
  /** 时长 s */
  duration: number;
  /** 浊音/清音 */
  voiced: boolean;
}

/** 汉语普通话五个基础元音的典型共振峰（成年男性参考值） */
export const MANDARIN_VOWELS: Record<string, VowelSpec> = {
  a: {
    label: 'a',
    voiced: true,
    duration: 0.32,
    formants: [
      { f: 850, bw: 180 },
      { f: 1250, bw: 220 },
      { f: 2900, bw: 280 },
    ],
  },
  i: {
    label: 'i',
    voiced: true,
    duration: 0.32,
    formants: [
      { f: 300, bw: 150 },
      { f: 2300, bw: 220 },
      { f: 3100, bw: 280 },
    ],
  },
  u: {
    label: 'u',
    voiced: true,
    duration: 0.32,
    formants: [
      { f: 320, bw: 150 },
      { f: 800, bw: 200 },
      { f: 2500, bw: 300 },
    ],
  },
  e: {
    label: 'e',
    voiced: true,
    duration: 0.32,
    formants: [
      { f: 500, bw: 170 },
      { f: 1600, bw: 220 },
      { f: 2600, bw: 280 },
    ],
  },
  o: {
    label: 'o',
    voiced: true,
    duration: 0.32,
    formants: [
      { f: 500, bw: 170 },
      { f: 950, bw: 210 },
      { f: 2500, bw: 300 },
    ],
  },
};

export interface DiverVoice {
  id: string;
  name: string;
  /** 平均基音 Hz 与自然抖动范围 */
  f0Mean: number;
  f0Jitter: number;
  /** 共振峰相对参考值的个体缩放（声道长度差异） */
  formantScale: number;
}

export const SIM_DIVERS: DiverVoice[] = [
  { id: 'd01', name: '张深', f0Mean: 118, f0Jitter: 1.4, formantScale: 1.0 },
  { id: 'd02', name: '李潜', f0Mean: 142, f0Jitter: 1.8, formantScale: 0.94 },
  { id: 'd03', name: '王瀚', f0Mean: 102, f0Jitter: 1.1, formantScale: 1.07 },
  { id: 'd04', name: '赵涌', f0Mean: 165, f0Jitter: 2.0, formantScale: 0.9 },
];

/** 把 {f,bw} 极点列表转换为全极点系数（共轭对 + 谱倾斜实极点） */
export function polesToCoefficients(
  poles: { f: number; bw: number }[],
  sampleRate: number,
): Float64Array {
  // 逐个二阶节展开：(1 - 2r cosω z^-1 + r² z^-2)
  let coef = new Float64Array([1]);
  for (const p of poles) {
    const r = Math.exp((-Math.PI * p.bw) / sampleRate);
    const w = (2 * Math.PI * p.f) / sampleRate;
    const b1 = -2 * r * Math.cos(w);
    const b2 = r * r;
    const next = new Float64Array(coef.length + 2);
    for (let i = 0; i < coef.length; i++) {
      next[i] += coef[i];
      next[i + 1] += coef[i] * b1;
      next[i + 2] += coef[i] * b2;
    }
    coef = next;
  }
  return coef.subarray(1) as Float64Array;
}

/** 按氦氧环境把空气极点弯折成氦语音极点 */
export function heliumPoles(
  poles: { f: number; bw: number }[],
  mix: GasMix,
  depthM: number,
): { f: number; bw: number }[] {
  return poles.map((p) => ({
    f: formantShiftFactor(p.f, mix, depthM) * p.f,
    bw: p.bw,
  }));
}

export interface SimulatorOptions {
  sampleRate: number;
  diver: DiverVoice;
  mix: GasMix;
  depthM: number;
  /** 元音序列（默认清晰度词表音节） */
  utterance?: string;
  /** 呼吸阀噪声相对电平 */
  valveNoiseLevel?: number;
  /** 气泡噪声相对电平 */
  bubbleNoiseLevel?: number;
  seed?: number;
}

export interface SimulatedSignal {
  /** 正常空气语音（地面真值） */
  air: Float32Array;
  /** 氦语音（无环境噪声） */
  heliumClean: Float32Array;
  /** 氦语音 + 呼吸阀 + 气泡（麦克风采到的信号） */
  heliumNoisy: Float32Array;
  /** 每段的空气真值共振峰 */
  truth: { label: string; start: number; end: number; formants: { f: number; bw: number }[] }[];
  sampleRate: number;
}

/** 确定性伪随机（与 synthesis.whiteNoise 同款 xorshift32） */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

/** 一阶低通滤波（用于塑造呼吸阀频谱） */
function lowpass(x: Float64Array, cutoff: number, fs: number): Float64Array {
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / fs;
  const alpha = dt / (rc + dt);
  const y = new Float64Array(x.length);
  y[0] = x[0] * alpha;
  for (let i = 1; i < x.length; i++) y[i] = y[i - 1] + alpha * (x[i] - y[i - 1]);
  return y;
}

function synthesizeEnv(
  vowels: VowelSpec[],
  diver: DiverVoice,
  sampleRate: number,
  helium: boolean,
  mix: GasMix,
  depthM: number,
  rng: () => number,
): { signal: Float64Array; truth: SimulatedSignal['truth'] } {
  const total = vowels.reduce((s, v) => s + v.duration, 0);
  const n = Math.round(total * sampleRate);
  const out = new Float64Array(n);
  const truth: SimulatedSignal['truth'] = [];
  const filter = new AllPoleFilter(8);
  let cursor = 0;
  let phase = 0;

  for (const v of vowels) {
    const segN = Math.round(v.duration * sampleRate);
    const scaled = v.formants.map((p) => ({
      f: p.f * diver.formantScale,
      bw: p.bw,
    }));
    const poles = helium ? heliumPoles(scaled, mix, depthM) : scaled;
    const a = polesToCoefficients(poles, sampleRate);
    // 高 Q 全极点谐振器对周期脉冲的稳态增益很大，用小激励增益避免削波
    const gain = 0.05;

    // 激励：浊音声门脉冲（带慢漂+抖动），清音白噪声
    let excitation: Float64Array;
    if (v.voiced) {
      const drift = 1 + 0.02 * Math.sin((2 * Math.PI * cursor) / (sampleRate * 1.8));
      const f0 = diver.f0Mean * drift * (1 + (rng() - 0.5) * 2 * (diver.f0Jitter / 100));
      const built = glottalPulseTrain({ sampleRate, f0 }, segN, phase);
      phase = built.phase % (sampleRate / f0);
      excitation = built.signal;
    } else {
      excitation = whiteNoise(segN, Math.floor(rng() * 1e9));
    }

    const seg = filter.process(excitation, a, gain);
    // 段两端 8 ms 淡入淡出，模拟协同发音
    const fade = Math.min(Math.round(0.008 * sampleRate), segN >> 1);
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      seg[i] *= g;
      seg[segN - 1 - i] *= g;
    }
    out.set(seg, cursor);
    truth.push({
      label: v.label,
      start: cursor / sampleRate,
      end: (cursor + segN) / sampleRate,
      formants: scaled,
    });
    cursor += segN;
  }
  return { signal: out, truth };
}

/** 叠加呼吸阀（持续低频气流）+ 气泡（随机突发中高频） */
function addEnvironmentalNoise(
  clean: Float64Array,
  sampleRate: number,
  valveLevel: number,
  bubbleLevel: number,
  rng: () => number,
): Float64Array {
  const noisy = new Float64Array(clean.length);
  noisy.set(clean);

  const rawValve = new Float64Array(clean.length);
  for (let i = 0; i < rawValve.length; i++) rawValve[i] = rng() * 2 - 1;
  const valve = lowpass(rawValve, 420, sampleRate);
  let valvePeak = 1e-9;
  for (const x of valve) valvePeak = Math.max(valvePeak, Math.abs(x));

  const bubble = new Float64Array(clean.length);
  // 平均每 0.9 秒一个气泡串，每串 3~7 个脉冲
  let t = 0.2;
  while (t < clean.length / sampleRate) {
    const bursts = 3 + Math.floor(rng() * 5);
    const base = Math.round(t * sampleRate);
    for (let b = 0; b < bursts; b++) {
      const idx = base + b * Math.round(sampleRate * (0.012 + rng() * 0.02));
      const len = Math.round(sampleRate * (0.008 + rng() * 0.015));
      const f0 = 900 + rng() * 1800;
      for (let i = 0; i < len && idx + i < bubble.length; i++) {
        const env = Math.exp(-3 * (i / len));
        bubble[idx + i] += env * Math.sin(2 * Math.PI * f0 * (i / sampleRate));
      }
    }
    t += 0.6 + rng() * 0.9;
  }
  let bubblePeak = 1e-9;
  for (const x of bubble) bubblePeak = Math.max(bubblePeak, Math.abs(x));

  for (let i = 0; i < clean.length; i++) {
    noisy[i] += valveLevel * (valve[i] / valvePeak);
    noisy[i] += bubbleLevel * (bubble[i] / bubblePeak);
  }
  return noisy;
}

/** 峰值归一 */
function normalize(x: Float64Array, target = 0.9): Float32Array {
  let peak = 1e-9;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = (x[i] / peak) * target;
  return out;
}

export function simulateHeliumSpeech(opts: SimulatorOptions): SimulatedSignal {
  const rng = makeRng(opts.seed ?? 20261127);
  const labels = opts.utterance?.split('').filter((c) => MANDARIN_VOWELS[c]) ?? [
    'a', 'i', 'u', 'e', 'o', 'a', 'i',
  ];
  const vowels = labels.map((l) => MANDARIN_VOWELS[l]);

  const air = synthesizeEnv(vowels, opts.diver, opts.sampleRate, false, opts.mix, 0, rng);
  const he = synthesizeEnv(vowels, opts.diver, opts.sampleRate, true, opts.mix, opts.depthM, rng);
  const noisy = addEnvironmentalNoise(
    he.signal,
    opts.sampleRate,
    opts.valveNoiseLevel ?? 0.05,
    opts.bubbleNoiseLevel ?? 0.08,
    rng,
  );

  return {
    air: normalize(air.signal),
    heliumClean: normalize(he.signal),
    heliumNoisy: normalize(noisy),
    truth: air.truth,
    sampleRate: opts.sampleRate,
  };
}
