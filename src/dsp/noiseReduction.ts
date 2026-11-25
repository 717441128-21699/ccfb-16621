/**
 * 谱减降噪：针对面罩呼吸阀的宽带气流噪声与周期性气泡声。
 * - 前若干帧（无语音）估计噪声底谱，运行中按 VAD 慢速更新
 * - 过减法 + 谱下限（spectral floor）抑制"音乐噪声"
 * - 气泡声为低频脉冲簇，额外对 300 Hz 以下做时间中值滤波
 */
import { FFT } from './fft.ts';

export interface SpectralSubtractionConfig {
  fftSize: number;
  /** 过减因子 alpha，越大压得越狠 */
  overSubtraction: number;
  /** 谱下限比例（保留的最低能量比） */
  floor: number;
  /** 噪声更新平滑系数 */
  noiseAdapt: number;
}

export const DEFAULT_NR_CONFIG: SpectralSubtractionConfig = {
  fftSize: 512,
  overSubtraction: 2.2,
  floor: 0.08,
  noiseAdapt: 0.12,
};

export class SpectralSubtraction {
  readonly cfg: SpectralSubtractionConfig;
  private readonly noiseMag: Float64Array;
  private readonly prevMag: Float64Array;
  private readonly medianHist: Float64Array[];
  private frameCount = 0;
  private readonly bins: number;

  constructor(cfg: SpectralSubtractionConfig = DEFAULT_NR_CONFIG) {
    this.cfg = cfg;
    this.bins = cfg.fftSize / 2;
    this.noiseMag = new Float64Array(this.bins);
    this.prevMag = new Float64Array(this.bins);
    // 低频中值滤波历史（气泡声抑制），覆盖 300 Hz 以下
    this.medianHist = Array.from({ length: this.bins }, () => new Float64Array(5));
  }

  /** 训练阶段直接喂入纯噪声帧幅度谱 */
  trainNoise(mag: ArrayLike<number>): void {
    if (this.frameCount === 0) {
      for (let k = 0; k < this.bins; k++) this.noiseMag[k] = mag[k];
    } else {
      const a = 0.25;
      for (let k = 0; k < this.bins; k++) {
        this.noiseMag[k] = (1 - a) * this.noiseMag[k] + a * mag[k];
      }
    }
    this.frameCount++;
  }

  /**
   * 对单边幅度谱就地降噪。
   * @param mag 幅度谱（fftSize/2）
   * @param isSpeech 当前帧是否判为语音
   * @param sampleRate 采样率
   */
  process(mag: Float64Array, isSpeech: boolean, sampleRate: number): Float64Array {
    const { overSubtraction, floor, noiseAdapt } = this.cfg;
    const lowCutBin = Math.ceil((300 * this.cfg.fftSize) / sampleRate);
    // 低频保护边界：800Hz 以下减弱过减，保护基频与 /i/、/u/ 的低频 F1
    const protectBin = Math.ceil((800 * this.cfg.fftSize) / sampleRate);

    if (!isSpeech) {
      // 噪声段慢速跟踪噪声底
      for (let k = 0; k < this.bins; k++) {
        this.noiseMag[k] = (1 - noiseAdapt) * this.noiseMag[k] + noiseAdapt * mag[k];
      }
    }

    for (let k = 0; k < this.bins; k++) {
      // 低频用过减因子向 1 线性收敛，避免削掉弱共振峰；高频用完整过减
      const alpha =
        k < protectBin
          ? 1 + (overSubtraction - 1) * (k / protectBin)
          : overSubtraction;
      let clean = mag[k] - alpha * this.noiseMag[k];
      const floored = floor * mag[k];
      if (clean < floored) clean = floored;

      // 低频时间中值：压掉孤立的气泡脉冲
      if (k < lowCutBin) {
        const hist = this.medianHist[k];
        hist.copyWithin(0, 1);
        hist[4] = clean;
        const sorted = Float64Array.from(hist).sort();
        clean = 0.7 * clean + 0.3 * sorted[2];
      }
      this.prevMag[k] = clean;
      mag[k] = clean;
    }
    return mag;
  }

  get noiseSpectrum(): Float64Array {
    return this.noiseMag.slice();
  }

  reset(): void {
    this.noiseMag.fill(0);
    this.prevMag.fill(0);
    this.medianHist.forEach((h) => h.fill(0));
    this.frameCount = 0;
  }
}

/** 计算单边幅度谱与相位（外部复用 FFT 缓冲） */
export function magnitudeSpectrum(
  frame: ArrayLike<number>,
  fft: FFT,
  re: Float64Array,
  im: Float64Array,
): Float64Array {
  const n = fft.size;
  re.fill(0);
  im.fill(0);
  const len = Math.min(frame.length, n);
  for (let i = 0; i < len; i++) re[i] = frame[i];
  fft.transform(re, im);
  const mag = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}
