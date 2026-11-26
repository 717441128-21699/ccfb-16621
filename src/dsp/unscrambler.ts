/**
 * 氦语音校正引擎（逐帧，平台无关）
 * --------------------------------
 * 管线：加窗 → 多频带维纳降噪 → LPC 全极点建模 → 极点共振峰搬移
 *       → 原残差激励重合成（基音不变）→ OLA
 * AudioWorklet 与 Node 测试共用同一份实现，保证“测的就是跑的”。
 */

import { applyHann } from './framing.ts';
import { MultibandWiener } from './noise.ts';
import { lpcAnalyze } from './lpc.ts';
import { AllPoleFilter, InverseFilter } from './synthesis.ts';
import { warpAllPoleFilter, findFormants, type Formant } from './formants.ts';
import type { GasMix, WallEffectOptions } from './physics.ts';

export interface UnscramblerConfig {
  sampleRate: number;
  frameSize: number;
  hopSize: number;
  lpcOrder: number;
  /** 系数跨帧平滑（指向上一帧） */
  smoothing: number;
  denoise: boolean;
  wall?: WallEffectOptions;
}

export const DEFAULT_CONFIG: UnscramblerConfig = {
  sampleRate: 16000,
  frameSize: 400, // 25 ms
  hopSize: 160, // 10 ms
  lpcOrder: 16,
  smoothing: 0.25,
  denoise: true,
};

/** 预加重系数（标准语音前端 0.937~0.97） */
const PRE_EMPHASIS = 0.95;

export interface FrameTelemetry {
  index: number;
  rms: number;
  voiced: boolean;
  f0: number;
  formantsHe: Formant[];
  formantsAir: { from: number; to: number; bw: number }[];
  bandGains: number[];
}

export class UnscramblerEngine {
  readonly cfg: UnscramblerConfig;
  private wiener: MultibandWiener;
  private inverse: InverseFilter;
  private synth: AllPoleFilter;
  private prevA: Float64Array | null = null;
  private frameIndex = 0;

  constructor(cfg: Partial<UnscramblerConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.wiener = new MultibandWiener({
      fftSize: this.cfg.frameSize,
      sampleRate: this.cfg.sampleRate,
    });
    this.inverse = new InverseFilter(this.cfg.lpcOrder);
    this.synth = new AllPoleFilter(this.cfg.lpcOrder);
  }

  /**
   * 处理一帧（长度须等于 frameSize，无需预加窗）。
   * 返回校正后同长度帧（已加窗，供 OLA）与遥测。
   */
  processFrame(
    rawFrame: Float64Array | Float32Array,
    mix: GasMix,
    depthM: number,
    estimateF0: (f: Float64Array) => number,
  ): { frame: Float64Array; telemetry: FrameTelemetry } {
    const N = this.cfg.frameSize;
    const frame64 =
      rawFrame instanceof Float64Array ? rawFrame : Float64Array.from(rawFrame);

    let rms = 0;
    for (let i = 0; i < N; i++) rms += frame64[i] * frame64[i];
    rms = Math.sqrt(rms / N);

    // 0) 预加重：补偿声门谱倾斜（-6dB/oct），提升高频共振峰可估计性
    const pre = new Float64Array(N);
    pre[0] = frame64[0];
    for (let i = 1; i < N; i++) pre[i] = frame64[i] - PRE_EMPHASIS * frame64[i - 1];
    const windowed = applyHann(pre);

    // 1) 降噪
    const denoised = this.cfg.denoise ? this.wiener.process(windowed) : windowed;

    // 2) 全极点建模
    const lpc = lpcAnalyze(denoised, this.cfg.lpcOrder);
    const gain = Math.sqrt(Math.max(lpc.error, 1e-12));

    // 3) 共振峰搬移
    const warped = warpAllPoleFilter(
      lpc.a,
      gain,
      this.cfg.sampleRate,
      mix,
      depthM,
      this.cfg.wall,
    );

    // 4) 跨帧系数平滑，抑制帧间跳变
    let aUse = warped.a;
    if (this.prevA && this.prevA.length === aUse.length) {
      const s = this.cfg.smoothing;
      const merged = new Float64Array(aUse.length);
      for (let i = 0; i < aUse.length; i++) merged[i] = (1 - s) * aUse[i] + s * this.prevA[i];
      aUse = merged;
    }
    this.prevA = Float64Array.from(warped.a);

    // 5) 残差激励（基音/声门信息原样保留）→ 新滤波器合成。
    //    每帧独立滤波（重置 IIR 状态）：系数逐帧变化，跨帧沿用旧状态会把
    //    上一帧瞬态带入新滤波器产生寄生极点；帧间连续性由汉宁 OLA 保证。
    this.inverse.reset();
    this.synth.reset();
    const residual = this.inverse.process(denoised, lpc.a);
    let output = this.synth.process(residual, aUse, warped.gain);

    // 5b) 去加重，恢复自然谱倾斜
    const de = new Float64Array(N);
    de[0] = output[0];
    for (let i = 1; i < N; i++) de[i] = output[i] + PRE_EMPHASIS * de[i - 1];
    output = de;

    // 静音帧压制残留噪声
    if (rms < 0.006) {
      for (let i = 0; i < output.length; i++) output[i] *= 0.25;
    }

    // 6) 遥测
    const f0 = estimateF0(frame64);
    const formantsHe = findFormants(lpc.a, this.cfg.sampleRate, 3);
    const telemetry: FrameTelemetry = {
      index: this.frameIndex++,
      rms,
      voiced: f0 > 0,
      f0,
      formantsHe,
      formantsAir: warped.mapping.slice(0, 3),
      bandGains: [...this.wiener.lastBandGains],
    };

    // 输出加窗供 OLA
    const outWindowed = new Float64Array(N);
    for (let i = 0; i < N; i++) outWindowed[i] = output[i] * (0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1))));
    return { frame: outWindowed, telemetry };
  }

  reset(): void {
    this.wiener.reset();
    this.inverse.reset();
    this.synth.reset();
    this.prevA = null;
    this.frameIndex = 0;
  }
}
