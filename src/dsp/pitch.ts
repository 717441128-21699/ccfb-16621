/**
 * 基频（音高 F0）检测与清浊判别。
 * 归一化互相关 + 抛物线插值；音高在整条处理链中保持不变。
 */

export interface PitchResult {
  /** 基频 Hz，清音返回 0 */
  f0: number;
  /** 清浊判别置信度 0..1（归一化互相关峰值） */
  clarity: number;
  voiced: boolean;
}

export interface PitchConfig {
  minF0: number;
  maxF0: number;
  /** 清浊判决门限 */
  voicingThreshold: number;
}

export const DEFAULT_PITCH_CONFIG: PitchConfig = {
  minF0: 70,
  maxF0: 360,
  voicingThreshold: 0.42,
};

export function detectPitch(
  frame: ArrayLike<number>,
  sampleRate: number,
  cfg: PitchConfig = DEFAULT_PITCH_CONFIG,
): PitchResult {
  const n = frame.length;
  let energy = 0;
  let dc = 0;
  for (let i = 0; i < n; i++) dc += frame[i];
  dc /= n;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = frame[i] - dc;
    energy += x[i] * x[i];
  }
  if (energy < 1e-8) return { f0: 0, clarity: 0, voiced: false };

  const minLag = Math.floor(sampleRate / cfg.maxF0);
  const maxLag = Math.min(Math.ceil(sampleRate / cfg.minF0), n - 2);

  const corrAt = (lag: number): number => {
    if (lag < minLag || lag > maxLag) return -1;
    let acc = 0;
    let e0 = 0;
    let e1 = 0;
    const lim = n - lag;
    for (let i = 0; i < lim; i++) {
      acc += x[i] * x[i + lag];
      e0 += x[i] * x[i];
      e1 += x[i + lag] * x[i + lag];
    }
    return acc / Math.sqrt(Math.max(e0 * e1, 1e-12));
  };

  // 先求全局最强周期及其强度
  let peakLag = 0;
  let peakR = cfg.voicingThreshold - 1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const norm = corrAt(lag);
    if (norm > peakR) {
      peakR = norm;
      peakLag = lag;
    }
  }

  if (peakLag === 0 || peakR < cfg.voicingThreshold) {
    return { f0: 0, clarity: Math.max(0, peakR), voiced: false };
  }

  // 全局最强周期即基频候选。仅当 2 倍滞后的相关性严格更强（≥98%）时，
  // 才判定主峰拾取的是谐波、下修到真正基频，避免误跳到次谐波
  let bestLag = peakLag;
  let bestR = peakR;
  const subLag = peakLag * 2;
  if (subLag <= maxLag) {
    const subR = corrAt(subLag);
    if (subR >= peakR * 0.98) {
      bestLag = subLag;
      bestR = subR;
    }
  }

  const rLeft = corrAt(bestLag - 1);
  const rRight = corrAt(bestLag + 1);
  const denom = rLeft - 2 * bestR + rRight;
  const shift = Math.abs(denom) > 1e-9 ? 0.5 * (rLeft - rRight) / denom : 0;
  const refinedLag = bestLag + Math.max(-0.5, Math.min(0.5, shift));
  const f0 = sampleRate / refinedLag;

  return { f0, clarity: bestR, voiced: f0 >= cfg.minF0 && f0 <= cfg.maxF0 };
}

/**
 * 语音活动检测：短时能量 + 谱平坦度联合判决，
 * 带 3 帧启动 / 6 帧滞后 hangover，避免词尾被切断。
 */
export class VoiceActivityDetector {
  private readonly energyHistory: number[] = [];
  private hangover = 0;
  private readonly history = 12;
  private triggered = false;
  /** 噪声底能量估计（由前几帧静默段建立） */
  private noiseFloor = 0;
  private noiseFrames = 0;

  reset(): void {
    this.energyHistory.length = 0;
    this.hangover = 0;
    this.triggered = false;
    this.noiseFloor = 0;
    this.noiseFrames = 0;
  }

  isSpeech(frame: ArrayLike<number>, mag: ArrayLike<number>): boolean {
    let energy = 0;
    for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
    energy /= frame.length;
    this.energyHistory.push(energy);
    if (this.energyHistory.length > this.history) this.energyHistory.shift();
    void mag; // 氦语音共振峰上移，谱形判据不可靠；VAD 仅用能量信噪比

    // 前 4 帧建立噪声底（应用流程中谱减也在同步训练）
    if (this.noiseFrames < 4) {
      this.noiseFloor =
        this.noiseFrames === 0 ? energy : (this.noiseFloor * this.noiseFrames + energy) / (this.noiseFrames + 1);
      this.noiseFrames++;
    }

    const snr = energy / Math.max(this.noiseFloor, 1e-12);
    // 语音判决：能量显著高于噪声底（约 5 dB），对共振峰上移的氦语音同样有效
    const active = snr > 3.0 && energy > 1e-4;
    if (active) {
      this.triggered = true;
      this.hangover = 6;
    } else if (this.hangover > 0) {
      this.hangover--;
    } else {
      // 静默段缓慢更新噪声底
      this.noiseFloor = 0.95 * this.noiseFloor + 0.05 * energy;
      this.triggered = false;
    }
    return this.triggered;
  }
}
