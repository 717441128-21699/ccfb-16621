/**
 * 多频带维纳降噪
 * ---------------
 * 针对面罩呼吸阀（低频宽带气流）与气泡声（中高频突发）：
 * - FFT 域分 6 个 mel 间距频带，逐带估计语音/噪声功率谱
 * - 低能量帧用 EMA 更新噪声估计（呼吸阀持续存在，气泡间隙可追踪）
 * - 维纳增益 H_b = max(1 - α·N_b/S_b, floor)，时间平滑防音乐噪声
 * 帧长无需为 2 的幂：内部零填充到下一个 2 的幂做 FFT，输出截回原帧长。
 */

import { fftRadix2, ifftRadix2 } from './fft.ts';

export interface DenoiseOptions {
  /** 输入帧长（无需 2 的幂） */
  fftSize: number;
  sampleRate: number;
  /** 噪声过估因子（越大降噪越激进） */
  overSubtraction: number;
  /** 增益地板，防止过度衰减产生水声 */
  gainFloor: number;
  /** 增益时间平滑系数（指向新增益） */
  gainSmoothing: number;
  /** 噪声谱 EMA 更新系数 */
  noiseEma: number;
  /** 低于该能量比例（相对当前噪声）判定为噪声-only 帧 */
  noiseFrameRatio: number;
  bandEdges?: number[];
}

export const DEFAULT_DENOISE: Omit<DenoiseOptions, 'fftSize' | 'sampleRate'> = {
  overSubtraction: 1.1,
  gainFloor: 0.35,
  gainSmoothing: 0.25,
  noiseEma: 0.08,
  noiseFrameRatio: 1.6,
};

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function melBands(sampleRate: number, fftN: number, nBands = 6): number[] {
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
  const inv = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const maxF = Math.min(4200, sampleRate / 2);
  const edges: number[] = [];
  for (let i = 0; i <= nBands; i++) {
    const f = inv((mel(maxF) * i) / nBands);
    edges.push(Math.min(fftN / 2, Math.max(1, Math.round((f * fftN) / sampleRate))));
  }
  // 保证边界单调递增且不越界
  edges[0] = 1;
  edges[edges.length - 1] = fftN / 2;
  return edges;
}

export class MultibandWiener {
  readonly opts: DenoiseOptions;
  private readonly frameLen: number;
  private readonly fftN: number;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly bandEdges: number[];
  private readonly noisePsd: Float64Array; // 每 bin
  private initialized = false;
  /** 最近一次的分带增益（界面监测用） */
  lastBandGains: number[] = [];

  constructor(opts: Partial<DenoiseOptions> & Pick<DenoiseOptions, 'fftSize' | 'sampleRate'>) {
    this.opts = { ...DEFAULT_DENOISE, ...opts };
    this.frameLen = this.opts.fftSize;
    this.fftN = nextPow2(this.frameLen);
    this.re = new Float64Array(this.fftN);
    this.im = new Float64Array(this.fftN);
    this.bandEdges = this.opts.bandEdges ?? melBands(this.opts.sampleRate, this.fftN);
    this.noisePsd = new Float64Array(this.fftN / 2 + 1);
    this.lastBandGains = new Array(this.bandEdges.length - 1).fill(1);
  }

  /** 处理一帧已加窗信号，返回同长度滤波帧 */
  process(frame: Float64Array | Float32Array): Float64Array {
    const N = this.frameLen;
    const P = this.fftN;
    if (frame.length !== N) throw new Error('帧长与配置不一致');
    this.re.fill(0);
    this.im.fill(0);
    for (let i = 0; i < N; i++) this.re[i] = frame[i];
    fftRadix2(this.re, this.im);

    const bins = P / 2 + 1;
    const psd = new Float64Array(bins);
    for (let k = 0; k < bins; k++) psd[k] = this.re[k] ** 2 + this.im[k] ** 2;

    // 分带功率与噪声更新
    const nBands = this.bandEdges.length - 1;
    const bandPower = new Float64Array(nBands);
    const bandNoise = new Float64Array(nBands);
    const bandCount = new Uint16Array(nBands);
    for (let b = 0; b < nBands; b++) {
      for (let k = this.bandEdges[b]; k < this.bandEdges[b + 1]; k++) {
        bandPower[b] += psd[k];
        bandNoise[b] += this.noisePsd[k];
        bandCount[b]++;
      }
      bandPower[b] /= bandCount[b] || 1;
      bandNoise[b] /= bandCount[b] || 1;
    }

    if (!this.initialized) {
      for (let k = 0; k < bins; k++) this.noisePsd[k] = psd[k] + 1e-12;
      this.initialized = true;
    } else {
      const totalPower = bandPower.reduce((s, v) => s + v, 0) / nBands;
      const totalNoise = bandNoise.reduce((s, v) => s + v, 0) / nBands;
      if (totalPower < this.opts.noiseFrameRatio * totalNoise) {
        for (let k = 0; k < bins; k++) {
          this.noisePsd[k] = (1 - this.opts.noiseEma) * this.noisePsd[k] + this.opts.noiseEma * psd[k];
        }
      }
    }

    // 逐带维纳增益并映射到 bin
    const gains = new Float64Array(bins).fill(1);
    for (let b = 0; b < nBands; b++) {
      const nB = bandNoise[b];
      // 最低两个频带承载 F1/F2，给更高增益地板，避免把低频共振峰当呼吸阀噪声压掉
      const bandFloor = b < 2 ? Math.max(this.opts.gainFloor, 0.4) : this.opts.gainFloor;
      const wiener = Math.max(
        bandFloor,
        1 - (this.opts.overSubtraction * nB) / (bandPower[b] + 1e-12),
      );
      // 非对称平滑：增益上升（语音进入）攻击快，下降（语音消失）释放慢，
      // 既快速保留突发语音，又避免音乐噪声与增益抖动
      const prev = this.lastBandGains[b];
      const attack = 0.7;
      const release = this.opts.gainSmoothing;
      const coef = wiener > prev ? attack : release;
      const smoothed = (1 - coef) * prev + coef * wiener;
      this.lastBandGains[b] = smoothed;
      for (let k = this.bandEdges[b]; k < this.bandEdges[b + 1]; k++) gains[k] = smoothed;
    }

    for (let k = 0; k < bins; k++) {
      const g = gains[k];
      this.re[k] *= g;
      this.im[k] *= g;
    }
    // 负频率按共轭对称重建（实信号 IFFT 前提）
    for (let k = 1; k < P / 2; k++) {
      this.re[P - k] = this.re[k];
      this.im[P - k] = -this.im[k];
    }

    ifftRadix2(this.re, this.im);
    const out = new Float64Array(N);
    out.set(this.re.subarray(0, N));
    return out;
  }

  reset(): void {
    this.initialized = false;
    this.noisePsd.fill(0);
    this.lastBandGains = new Array(this.bandEdges.length - 1).fill(1);
  }
}
