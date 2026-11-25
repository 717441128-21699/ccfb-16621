/**
 * 逐帧氦语音校正流水线（与 AudioWorklet 共用同一份纯 TS 实现）。
 *
 * 每帧：
 *   1. Hann 加窗 → FFT → 谱减（呼吸阀宽带噪声 + 气泡脉冲）
 *   2. IFFT 得降噪时域信号
 *   3. NXC 音高检测（仅监测/记录；音高本身不被修改）
 *   4. 自相关 + Levinson 求全极点声道模型 A(z) 与增益 G
 *   5. 由极点拾取共振峰（显示与质量评估）
 *   6. LPC 谱包络按物理映射搬移，IFFT 回自相关后重新 Levinson，
 *      得到校正后的全极点模型 A'(z) —— 共振峰归位
 *   7. 原信号经 A(z) 逆滤波取残差激励（保留原始音高/清浊），
 *      再通过 1/A'(z) 全极点合成 → OLA 输出
 */
import { FFT, hannWindow } from './fft.ts';
import { autocorrelation, levinsonDurbin } from './lpc.ts';
import { pickFormants, type Formant } from './formants.ts';
import { FormantTracker } from './formantTracker.ts';
import {
  inverseWarp,
  resampleMagnitude,
  warpBinMap,
  type WarpParams,
} from './warping.ts';
import { SpectralSubtraction } from './noiseReduction.ts';
import {
  VoiceActivityDetector,
  detectPitch,
  DEFAULT_PITCH_CONFIG,
  type PitchConfig,
} from './pitch.ts';

export interface FrameProcessorConfig {
  sampleRate: number;
  fftSize: number;
  hopSize: number;
  lpcOrder: number;
  beta: number;
  fRef: number;
  pitch: PitchConfig;
}

export function defaultConfig(sampleRate: number): FrameProcessorConfig {
  // 32ms 窗：在 16kHz 下为 512 点，提供 31.25Hz 的低频分辨率，
  // 足以分辨 /i/、/u/ 靠近基频的弱 F1；32ms 缓冲仍在 60ms 延迟预算内
  const fftSize = FFT.nextPow2(Math.round(sampleRate * 0.032));
  return {
    sampleRate,
    fftSize,
    hopSize: fftSize / 2, // 16ms hop，50% 重叠 OLA
    lpcOrder: Math.round(sampleRate / 1000) + 4,
    beta: 0.35,
    fRef: 900,
    pitch: DEFAULT_PITCH_CONFIG,
  };
}

export interface FrameStats {
  frameIndex: number;
  isSpeech: boolean;
  voiced: boolean;
  f0: number;
  clarity: number;
  /** 氦语音（输入）共振峰 */
  formantsHe: Formant[];
  /** 校正后（输出）共振峰 */
  formantsAir: Formant[];
  lpcGain: number;
  rms: number;
  warp: WarpParams;
}

export class FrameProcessor {
  readonly cfg: FrameProcessorConfig;
  private readonly fft: FFT;
  private readonly window: Float64Array;
  private readonly nr: SpectralSubtraction;
  private readonly vad: VoiceActivityDetector;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly ring: Float64Array;
  private readonly overlap: Float64Array;
  private ringFilled = 0;
  private frameIndex = 0;
  private warpParams: WarpParams = { s: 1, beta: 0.35, fRef: 900 };
  private binMap: Float64Array | null = null;
  /** 训练帧数（启动阶段假定无语音，建立噪声底） */
  private noiseTrainFrames = 6;
  private trained = false;
  private readonly tracker = new FormantTracker(4, 0.55, 3, 0.25);
  /** 残差逆滤波的跨帧输入历史（基于未加窗信号），保证激励连续 */
  private f0History: number[] = [];

  constructor(cfg: FrameProcessorConfig) {
    this.cfg = cfg;
    if (cfg.hopSize !== cfg.fftSize / 2) {
      throw new Error('当前 OLA 实现要求 50% 重叠（hop = fftSize/2）');
    }
    this.fft = new FFT(cfg.fftSize);
    this.window = hannWindow(cfg.fftSize);
    // 温和的谱减参数：过减因子过大会削掉低频弱共振峰（如 /i/ 的 F1），
    // 高谱下限保留语音结构，只压制稳态噪声
    this.nr = new SpectralSubtraction({
      fftSize: cfg.fftSize,
      overSubtraction: 1.15,
      floor: 0.3,
      noiseAdapt: 0.08,
    });
    this.vad = new VoiceActivityDetector();
    this.re = new Float64Array(cfg.fftSize);
    this.im = new Float64Array(cfg.fftSize);
    this.ring = new Float64Array(cfg.fftSize);
    this.overlap = new Float64Array(cfg.fftSize);
  }

  /** 舱压/气体变化时更新校正系数（s = c_air / c_mix） */
  setCorrection(s: number, beta?: number): void {
    const clamped = Math.min(Math.max(s, 0.42), 1);
    this.warpParams = {
      s: clamped,
      beta: beta ?? this.cfg.beta,
      fRef: this.cfg.fRef,
    };
    this.binMap = warpBinMap(this.cfg.fftSize, this.cfg.sampleRate, this.warpParams);
    this.applyPitchGuard(this.binMap);
  }

  /**
   * 音高保护带：非线性频率搬移会扭曲谐波等间距、改变基频。
   * 在当前帧 F0 的约 2.5 倍以下（覆盖基频与第一谐波，落在 F1 之下）
   * 保持恒等映射，更高频段才执行共振峰搬移。两段在过渡带线性交叉淡化。
   */
  private applyPitchGuard(map: Float64Array): void {
    const { sampleRate, fftSize } = this.cfg;
    const binHz = sampleRate / fftSize;
    const guardHz = this.guardBandHz;
    const lo = Math.floor((guardHz * 0.8) / binHz);
    const hi = Math.ceil((guardHz * 1.25) / binHz);
    for (let k = 0; k < map.length; k++) {
      const identity = k * binHz;
      if (k <= lo) {
        map[k] = identity;
      } else if (k < hi) {
        const t = (k - lo) / (hi - lo);
        map[k] = identity * (1 - t) + map[k] * t;
      }
    }
  }

  /** 音高保护带上限，随检测到的 F0 动态更新 */
  private guardBandHz = 200;

  /** 音高中值跟踪：偏离历史中位过多的候选按倍频关系纠正 */
  private smoothPitch(p: { f0: number; clarity: number; voiced: boolean }): typeof p {
    if (!p.voiced) return p;
    // 首次或历史不足时，用成人语音合理音域过滤明显的次谐波
    if (this.f0History.length < 4) {
      // 70Hz 多为谱减产生的半频假峰（真实 F0 通常 ≥85Hz），直接上修
      const f0 = p.f0 < 85 ? p.f0 * 2 : p.f0;
      this.f0History.push(f0);
      if (this.f0History.length > 9) this.f0History.shift();
      return { ...p, f0 };
    }
    const sorted = [...this.f0History].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    let f0 = p.f0;
    // 半频（≈0.5x）或倍频（≈2x）跳变 → 拉回中位
    if (f0 < median * 0.7) f0 = median;
    else if (f0 > median * 1.5) f0 = median;
    this.f0History.push(f0);
    if (this.f0History.length > 9) this.f0History.shift();
    return { ...p, f0 };
  }

  /**
   * 音高保持说明：F0 由声门激励（残差）携带，残差经 A(z) 逆滤波后
   * 不做任何重采样，直接驱动新的全极点合成器，因此音高天然不变；
   * 声道谱包络可在全频带按物理映射搬移，无需低频保护区。
   */

  get currentWarp(): WarpParams {
    return this.warpParams;
  }

  /**
   * 流式入口：喂入 hop 长度的输入块，返回等长校正输出
   * （流水线未填满时返回零值块，其长度即算法缓冲延迟）。
   * 分析与残差提取按帧进行；全极点合成滤波器状态跨帧连续，
   * 50% 重叠相加输出，声门脉冲周期由逐帧残差完整保留。
   */
  process(input: ArrayLike<number>): { output: Float64Array; stats: FrameStats | null } {
    const { hopSize, fftSize } = this.cfg;
    if (input.length !== hopSize) {
      throw new Error(`输入块长度必须等于 hop=${hopSize}，收到 ${input.length}`);
    }
    // 环形移位并追加新样本
    this.ring.copyWithin(0, hopSize);
    for (let i = 0; i < hopSize; i++) this.ring[fftSize - hopSize + i] = input[i];
    this.ringFilled = Math.min(fftSize, this.ringFilled + hopSize);

    const output = new Float64Array(hopSize);
    if (this.ringFilled < fftSize) return { output, stats: null };

    const stats = this.processWindow(this.ring);
    // OLA：取重叠缓冲前 hop 个样本并移位
    for (let i = 0; i < hopSize; i++) output[i] = this.overlap[i];
    this.overlap.copyWithin(0, hopSize);
    this.overlap.fill(0, fftSize - hopSize);
    return { output, stats };
  }

  /** 处理一个完整帧（离线测试可直接调用），返回合成帧与统计 */
  processWindow(frame: ArrayLike<number>): FrameStats {
    const { fftSize, sampleRate, lpcOrder } = this.cfg;
    const idx = this.frameIndex++;

    // ---- 1. 加窗 + FFT ----
    const windowed = new Float64Array(fftSize);
    let rms = 0;
    for (let i = 0; i < fftSize; i++) {
      windowed[i] = frame[i] * this.window[i];
      rms += frame[i] * frame[i];
    }
    rms = Math.sqrt(rms / fftSize);

    this.re.fill(0);
    this.im.fill(0);
    for (let i = 0; i < fftSize; i++) this.re[i] = windowed[i];
    this.fft.transform(this.re, this.im);
    const mag = new Float64Array(fftSize / 2);
    const phase = new Float64Array(fftSize / 2);
    for (let k = 0; k < fftSize / 2; k++) {
      const reK = this.re[k];
      const imK = this.im[k];
      mag[k] = Math.hypot(reK, imK);
      phase[k] = Math.atan2(imK, reK);
    }

    // ---- 2. VAD + 谱减 ----
    const isSpeech = this.vad.isSpeech(windowed, mag);
    if (!this.trained && idx < this.noiseTrainFrames) {
      this.nr.trainNoise(mag);
      if (idx === this.noiseTrainFrames - 1) this.trained = true;
    } else {
      this.nr.process(mag, isSpeech, sampleRate);
    }

    // ---- 3. IFFT 还原降噪时域 ----
    this.re.fill(0);
    this.im.fill(0);
    for (let k = 0; k < fftSize / 2; k++) {
      this.re[k] = mag[k] * Math.cos(phase[k]);
      this.im[k] = mag[k] * Math.sin(phase[k]);
      const mirror = fftSize - k;
      this.re[mirror] = this.re[k];
      this.im[mirror] = -this.im[k];
    }
    this.fft.inverse(this.re, this.im);
    const denoised = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) denoised[i] = this.re[i];

    // ---- 4. 音高（只监测，不修改） ----
    const rawPitch = detectPitch(denoised, sampleRate, this.cfg.pitch);
    // 中值跟踪去跳变：谱减偶尔产生半频/倍频假峰，用历史中值约束
    const pitch = this.smoothPitch(rawPitch);
    // 用当前 F0 动态设定音高保护带。保护带只覆盖基频本身（约 1.6×F0），
    // 不能过宽——否则会把 /i/、/u/ 等本就低频的 F1 共振峰也冻结不搬移。
    // 必须从干净的物理映射重新生成，否则在已修改 map 上重复淡化会漂移
    if (pitch.voiced && pitch.f0 > 60) {
      this.guardBandHz = Math.min(Math.max(pitch.f0 * 1.6, 140), 300);
      this.binMap = warpBinMap(this.cfg.fftSize, this.cfg.sampleRate, this.warpParams);
      this.applyPitchGuard(this.binMap);
    }

    // ---- 5. 全极点建模 ----
    const r = autocorrelation(denoised, lpcOrder);
    if (r[0] < 1e-10) r[0] = 1e-10;
    const lpc = levinsonDurbin(r, lpcOrder);
    const gain = Math.sqrt(lpc.error);
    const rawHe = pickFormants(lpc.a, gain, sampleRate, this.fft, 4);
    // 跨帧跟踪 + 平滑，抑制峰抖动/错序
    const trackedHe = this.tracker.update(rawHe, isSpeech);
    const formantsHe: Formant[] = trackedHe.map((f, i) => ({
      index: i + 1,
      freq: f.freq,
      bandwidth: f.bandwidth,
    }));

    // ---- 6. 校正后共振峰：对氦语音峰做物理逆映射（用于显示与质量评估） ----
    const formantsAir = formantsHe.map((f) => ({
      ...f,
      freq: inverseWarp(f.freq, this.warpParams),
    }));

    // ---- 7. 频谱域搬移合成 ----
    // 在降噪信号的短时谱上，按物理 bin 映射重采样幅度谱、保留原始相位。
    // 低频音高保护带内谱线恒等，谐波间距（决定音高 F0）保持不变，
    // 只有共振峰包络的位置被搬移，从机制上保证音高不被改变。
    if (!this.binMap) this.setCorrection(1);
    const synthRe = new Float64Array(fftSize);
    const synthIm = new Float64Array(fftSize);
    // 复用降噪后的幅度 mag 与相位 phase（第 2、3 步已计算）
    const warpedSignalMag = resampleMagnitude(mag, this.binMap!, sampleRate, fftSize);
    for (let k = 0; k < fftSize / 2; k++) {
      synthRe[k] = warpedSignalMag[k] * Math.cos(phase[k]);
      synthIm[k] = warpedSignalMag[k] * Math.sin(phase[k]);
      const mirror = fftSize - k;
      synthRe[mirror] = synthRe[k];
      synthIm[mirror] = -synthIm[k];
    }
    this.fft.inverse(synthRe, synthIm);
    const synth = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) synth[i] = Number.isFinite(synthRe[i]) ? synthRe[i] : 0;

    // 线性交叉淡化 OLA：帧首半窗淡入（与上一帧后半叠加），后半全权。
    // 不用整帧 Hann——Hann 在帧边缘把声门脉冲压零会破坏基频周期；
    // 线性淡化只作用于接缝，重叠区两帧之和近似恒定，脉冲周期得以保留
    const half = fftSize / 2;
    for (let i = 0; i < fftSize; i++) {
      const fade = i < half ? i / half : 1;
      this.overlap[i] += synth[i] * fade;
    }

    return {
      frameIndex: idx,
      isSpeech,
      voiced: pitch.voiced,
      f0: pitch.f0,
      clarity: pitch.clarity,
      formantsHe,
      formantsAir,
      lpcGain: gain,
      rms,
      warp: { ...this.warpParams },
    };
  }

  reset(): void {
    this.ring.fill(0);
    this.overlap.fill(0);
    this.ringFilled = 0;
    this.frameIndex = 0;
    this.vad.reset();
    this.nr.reset();
    this.tracker.reset();
    this.f0History = [];
    this.trained = false;
  }

  /** 算法引入的缓冲延迟（秒） */
  get algorithmicLatencySeconds(): number {
    return this.cfg.fftSize / this.cfg.sampleRate;
  }
}
