/**
 * 氦语音模拟器 —— 独立于校正器的声源-滤波器合成器。
 *
 * 空气语音：声门脉冲串/噪声激励 → 元音共振峰全极点滤波器
 * 氦气变换：按物理 warping 函数重排共振峰（与校正器互为逆过程），
 *           叠加呼吸阀宽带气流噪声与低频气泡脉冲簇。
 * 用于演示声源与端到端验收测试，不参与校正算法本身。
 */
import { FFT } from './fft.ts';
import { hannWindow } from './fft.ts';
import { forwardWarp, type WarpParams } from './warping.ts';
import type { Diver } from '../model/diveLog.ts';

/** 普通话单元音空气中共振峰目标值 Hz（F1/F2/F3/F4，标准声道） */
export const VOWEL_FORMANTS: Record<string, number[]> = {
  a: [730, 1090, 2440, 3500], // /a/
  o: [570, 840, 2410, 3300], // /o/
  e: [530, 1840, 2480, 3500], // /ɤ/
  i: [270, 2290, 3010, 3500], // /i/
  u: [300, 870, 2240, 3200], // /u/
  ü: [300, 1970, 2680, 3450], // /y/
};

export interface Phoneme {
  kind: 'vowel' | 'fricative' | 'silence';
  label: string;
  durationSec: number;
}

/** 演示语句（清晰度测试词表风格：声韵母组合） */
export const SCRIPTED_UTTERANCES: string[][] = [
  ['a', 'i', 'u', 'e', 'o', 'ü'],
  ['ba', 'mi', 'du', 'te', 'po'],
  ['hai', 'yang', 'gong', 'cheng'],
  ['jian', 'ya', 'tong', 'hua', 'qing', 'xi'],
  ['an', 'quan', 'dao', 'da', 'wu', 'yi'],
];

export interface SimulatorOptions {
  sampleRate: number;
  diver: Diver;
  warp: WarpParams;
  /** 呼吸阀噪声相对电平 */
  valveNoiseLevel: number;
  /** 气泡噪声相对电平 */
  bubbleNoiseLevel: number;
  seed: number;
}

/** 可复现的确定性伪随机数（mulberry32） */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gaussian(): number {
    const u = Math.max(this.next(), 1e-9);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** 音节 → 音素序列：声母（摩擦）+ 主元音 + 鼻韵尾（摩擦） */
function syllableToPhonemes(syllable: string): Phoneme[] {
  const out: Phoneme[] = [];
  const initials = new Set(['b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x']);
  // 显式音节到主元音的映射，覆盖测试词表中的全部音节
  const nucleusMap: Record<string, string> = {
    ba: 'a', po: 'o', mi: 'i', du: 'u', te: 'e', nü: 'ü',
    hai: 'a', yang: 'a', gong: 'o', jian: 'i', ya: 'a', qing: 'i',
    an: 'a', quan: 'ü', dao: 'a', wu: 'u', yi: 'i', xun: 'ü',
    luo: 'o', ce: 'e',
  };
  const first = syllable[0];
  let rest = syllable;
  if (initials.has(first)) {
    out.push({ kind: 'fricative', label: first, durationSec: 0.07 });
    rest = syllable.slice(1);
  }
  const nucleus = nucleusMap[syllable];
  if (nucleus) {
    out.push({ kind: 'vowel', label: nucleus, durationSec: 0.26 });
    // 主元音之后的字符视为鼻韵尾/介音，用短摩擦占位
    const nucleusIndex = syllable.indexOf(nucleus === 'ü' ? (syllable.includes('ü') ? 'ü' : 'u') : nucleus);
    const tail = nucleusIndex >= 0 ? syllable.slice(nucleusIndex + 1) : rest.slice(1);
    for (const ch of tail) {
      if (VOWEL_FORMANTS[ch]) continue;
      out.push({ kind: 'fricative', label: ch, durationSec: 0.08 });
    }
  } else {
    // 回退：逐字符处理
    for (const ch of rest) {
      if (VOWEL_FORMANTS[ch]) out.push({ kind: 'vowel', label: ch, durationSec: 0.26 });
      else out.push({ kind: 'fricative', label: ch, durationSec: 0.08 });
    }
  }
  out.push({ kind: 'silence', label: '_', durationSec: 0.08 });
  return out;
}

export function utteranceToPhonemes(syllables: string[]): Phoneme[] {
  const out: Phoneme[] = [{ kind: 'silence', label: '_', durationSec: 0.12 }];
  for (const syl of syllables) out.push(...syllableToPhonemes(syl));
  return out;
}

/** 共振峰/带宽 → 全极点系数（每对共轭极 z = r e±jω） */
function formantsToPoles(
  formants: Array<[number, number]>,
  sampleRate: number,
): Float64Array {
  // 多项式连乘 (1 - 2r cosω z^-1 + r² z^-2)
  let a = new Float64Array([1]);
  for (const [freq, bw] of formants) {
    const w = (2 * Math.PI * freq) / sampleRate;
    const r = Math.exp(-Math.PI * bw / sampleRate);
    const c1 = -2 * r * Math.cos(w);
    const c2 = r * r;
    const next = new Float64Array(a.length + 2);
    for (let i = 0; i < a.length; i++) {
      next[i] += a[i];
      next[i + 1] += a[i] * c1;
      next[i + 2] += a[i] * c2;
    }
    a = next;
  }
  return a;
}

export class HelioxSimulator {
  readonly opts: SimulatorOptions;
  private readonly rng: Rng;
  private f0Phase = 0;

  constructor(opts: SimulatorOptions) {
    this.opts = opts;
    this.rng = new Rng(opts.seed);
  }

  /** 合成一句完整的"面罩采集信号"（含氦气效应与噪声） */
  generate(syllables: string[]): { audio: Float64Array; phonemes: Phoneme[]; airAudio: Float64Array } {
    const { sampleRate, diver, warp } = this.opts;
    const phonemes = utteranceToPhonemes(syllables);
    const total = phonemes.reduce((s, p) => s + p.durationSec, 0);
    const n = Math.ceil(total * sampleRate);
    const air = new Float64Array(n);
    const heliox = new Float64Array(n);
    const win = hannWindow(Math.round(0.02 * sampleRate));

    let cursor = 0;
    for (const ph of phonemes) {
      const len = Math.round(ph.durationSec * sampleRate);
      if (ph.kind === 'vowel') {
        const base = VOWEL_FORMANTS[ph.label];
        // 较窄带宽（尤其 F1）使低频共振峰在 LPC 谱中形成可分辨的局部峰，
        // 避免 /i/、/u/ 的弱 F1 被声门谐波和噪声掩盖
        const airFormants: Array<[number, number]> = base.map((f, i) => [
          f / diver.vocalTractScale,
          50 + i * 25,
        ]);
        const heFormants: Array<[number, number]> = airFormants.map(([f, bw]) => [
          forwardWarp(f, warp),
          bw,
        ]);
        this.renderVoiced(air.subarray(cursor, cursor + len), airFormants, diver, false, win);
        this.renderVoiced(heliox.subarray(cursor, cursor + len), heFormants, diver, true, win);
      } else if (ph.kind === 'fricative') {
        this.renderNoise(air.subarray(cursor, cursor + len), 0.06);
        this.renderNoise(heliox.subarray(cursor, cursor + len), 0.09);
      }
      cursor += len;
    }

    this.addValveNoise(heliox);
    this.addBubbleNoise(heliox);

    // 整体归一化
    let peak = 1e-9;
    for (const v of heliox) peak = Math.max(peak, Math.abs(v));
    const g = 0.9 / peak;
    for (let i = 0; i < n; i++) {
      heliox[i] *= g;
      air[i] *= g;
    }
    return { audio: heliox, phonemes, airAudio: air };
  }

  /** 浊音段：声门脉冲激励经全极点声道滤波 */
  private renderVoiced(
    out: Float64Array,
    formants: Array<[number, number]>,
    diver: Diver,
    helium: boolean,
    win: Float64Array,
  ): void {
    const sr = this.opts.sampleRate;
    const a = formantsToPoles(formants, sr);
    const order = a.length - 1;
    const state = new Float64Array(order);
    const pitchMarks: number[] = [];
    let n = 0;
    while (n < out.length) {
      const f0 =
        diver.f0Mean + this.rng.gaussian() * diver.f0Jitter * 0.35 +
        Math.sin(2 * Math.PI * n / (sr * 0.9)) * diver.f0Jitter * 0.25;
      const period = Math.max(8, Math.round(sr / Math.max(f0, 50)));
      pitchMarks.push(n);
      n += period;
    }

    const excitation = new Float64Array(out.length);
    for (const m of pitchMarks) {
      // Rosenberg 声门波：每个基频周期内的平滑脉冲，
      // 频谱以基频为最强周期分量（区别于冲激串的谐波等幅），
      // 氦气中激励形状不变，仅声道共振峰改变 → 音高天然保持
      const period = Math.max(16, Math.round(sr / Math.max(diver.f0Mean, 50)));
      const open = Math.max(4, Math.round(period * 0.6)); // 开放相占 60%
      for (let j = 0; j < open && m + j < excitation.length; j++) {
        const t = j / open;
        // 上升正弦平方 + 指数闭合，近似声门流导数
        excitation[m + j] += 0.5 * (1 - Math.cos(Math.PI * t)) * Math.exp(-1.5 * t);
      }
    }
    for (let i = 0; i < out.length; i++) {
      let y = excitation[i];
      for (let k = 1; k <= order; k++) {
        y -= a[k] * state[k - 1];
      }
      for (let k = order; k > 1; k--) state[k - 1] = state[k - 2];
      state[0] = y;
      out[i] = y;
    }
    // 段两端淡入淡出，避免拼接爆音
    const fade = Math.min(win.length, Math.floor(out.length / 2));
    for (let i = 0; i < fade; i++) {
      out[i] *= win[Math.floor((i / fade) * win.length)];
      out[out.length - 1 - i] *= win[Math.floor((i / fade) * win.length)];
    }
    void helium;
    void this.f0Phase;
  }

  /** 清音摩擦：带通整形白噪声 */
  private renderNoise(out: Float64Array, level: number): void {
    let prev = 0;
    for (let i = 0; i < out.length; i++) {
      const white = this.rng.gaussian();
      const hp = white - prev * 0.85; // 高通倾斜，能量集中在中高频
      prev = white;
      out[i] = hp * level;
    }
  }

  /** 呼吸阀噪声：平稳宽带气流声，全时段叠加 */
  private addValveNoise(buf: Float64Array): void {
    const sr = this.opts.sampleRate;
    const lvl = this.opts.valveNoiseLevel;
    let lp = 0;
    for (let i = 0; i < buf.length; i++) {
      const white = this.rng.gaussian();
      lp = 0.72 * lp + 0.28 * white; // 低通气流谱
      const t = i / sr;
      const breath = 1 + 0.4 * Math.sin(2 * Math.PI * 0.35 * t); // 呼吸节律
      buf[i] += lp * lvl * breath;
    }
  }

  /** 气泡声：随机出现的低频脉冲簇 */
  private addBubbleNoise(buf: Float64Array): void {
    const sr = this.opts.sampleRate;
    const lvl = this.opts.bubbleNoiseLevel;
    let t = 0.2 + this.rng.next() * 0.5;
    while (t < buf.length / sr) {
      const cluster = 3 + Math.floor(this.rng.next() * 5);
      for (let c = 0; c < cluster; c++) {
        const center = Math.round((t + c * (0.012 + this.rng.next() * 0.02)) * sr);
        const fBubble = 90 + this.rng.next() * 180;
        const decay = Math.round(sr * 0.02);
        for (let i = 0; i < decay && center + i < buf.length; i++) {
          const env = Math.exp(-i / (decay * 0.35));
          buf[center + i] += lvl * env * Math.sin(2 * Math.PI * fBubble * (i / sr));
        }
      }
      t += 0.8 + this.rng.next() * 1.6;
    }
  }
}

/** 供测试使用的辅助：把声道响应在指定频率处的峰值找出来 */
export function spectralPeaks(audio: Float64Array, sampleRate: number, fftSize: number): number[] {
  const fft = new FFT(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const len = Math.min(audio.length, fftSize);
  for (let i = 0; i < len; i++) re[i] = audio[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len));
  fft.transform(re, im);
  const peaks: number[] = [];
  const binHz = sampleRate / fftSize;
  for (let k = 2; k < fftSize / 2 - 2; k++) {
    const m = re[k] * re[k] + im[k] * im[k];
    if (
      m > re[k - 1] ** 2 + im[k - 1] ** 2 &&
      m > re[k + 1] ** 2 + im[k + 1] ** 2 &&
      k * binHz > 150
    ) {
      peaks.push(k * binHz);
    }
  }
  return peaks;
}
