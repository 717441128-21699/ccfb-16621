/**
 * 源-滤波器合成与全极点滤波工具
 */

/** 全极点 IIR：y[n] = G·x[n] - Σ a_k y[n-k]，支持跨帧保持状态 */
export class AllPoleFilter {
  private readonly state: Float64Array;

  constructor(order: number) {
    this.state = new Float64Array(order);
  }

  process(input: Float64Array | number[], a: Float64Array, gain: number): Float64Array {
    const out = new Float64Array(input.length);
    for (let n = 0; n < input.length; n++) {
      let v = gain * input[n];
      for (let k = 0; k < a.length; k++) v -= a[k] * this.state[k];
      // 数值兜底：仅在真正非有限时清零，不做幅度限幅以免误伤谐振
      if (!Number.isFinite(v)) v = 0;
      out[n] = v;
      // 状态右移
      for (let k = this.state.length - 1; k > 0; k--) this.state[k] = this.state[k - 1];
      this.state[0] = v;
    }
    return out;
  }

  reset(): void {
    this.state.fill(0);
  }
}

/** 逆滤波（求 LPC 残差/激励）：e[n] = x[n] + Σ a_k x[n-k]，再乘增益归一 */
export class InverseFilter {
  private readonly state: Float64Array;

  constructor(order: number) {
    this.state = new Float64Array(order);
  }

  process(frame: Float64Array, a: Float64Array): Float64Array {
    const out = new Float64Array(frame.length);
    for (let n = 0; n < frame.length; n++) {
      let e = frame[n];
      for (let k = 0; k < a.length; k++) e += a[k] * this.state[k];
      out[n] = e;
      for (let k = this.state.length - 1; k > 0; k--) this.state[k] = this.state[k - 1];
      this.state[0] = frame[n];
    }
    return out;
  }

  reset(): void {
    this.state.fill(0);
  }
}

export interface GlottalSourceOptions {
  sampleRate: number;
  f0: number;
  /** 开相比（声门脉冲宽度/周期） */
  openQuotient?: number;
}

/**
 * 生成 Rosenberg 型声门脉冲串（浊音激励）。
 * phase 为样本级相位（跨帧连续），返回 [新相位, 波形]。
 */
export function glottalPulseTrain(opts: GlottalSourceOptions, nSamples: number, phase: number): {
  phase: number;
  signal: Float64Array;
} {
  const { sampleRate, f0 } = opts;
  const oq = opts.openQuotient ?? 0.6;
  const signal = new Float64Array(nSamples);
  const period = sampleRate / f0;
  let ph = phase;
  for (let n = 0; n < nSamples; n++) {
    const t = ph % period;
    const tOpen = oq * period;
    if (t < tOpen) {
      const u = t / tOpen;
      // Rosenberg 多项式：平滑开启、快速闭合
      signal[n] = 3 * u * u - 2 * u * u * u;
    }
    ph += 1;
  }
  return { phase: ph, signal };
}

/** 白噪声（清音激励），使用确定性 PRNG 保证测试可复现 */
export function whiteNoise(nSamples: number, seed: number): Float64Array {
  let s = seed >>> 0 || 1;
  const out = new Float64Array(nSamples);
  for (let i = 0; i < nSamples; i++) {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = (s / 0xffffffff) * 2 - 1;
  }
  return out;
}
