/**
 * 共振峰频率搬移映射。
 *
 * 氦气中声速升高使共振峰整体上移，但低频段还受舱壁反射与面罩腔体
 * 影响，位移不成比例。采用带低频修正项的分段映射：
 *
 *   f_in = g(f_out)，校正后频率 f_out 的氦语音观测频率
 *
 *   g(f) = f / s + beta * fRef * (1 - s) / s * exp(-f / fRef)
 *
 * - s = c_air / c_mix（<1），整体收缩比
 * - beta 为低频额外位移系数（舱壁/面罩，默认 0.35）
 * - fRef = 900 Hz，修正项作用尺度，主要影响 F1
 *
 * 映射单调，用二分法求逆；高频 beta 项衰减后退化为纯线性 f/s。
 */

export interface WarpParams {
  /** c_air / c_mix */
  s: number;
  /** 低频（舱壁/面罩）额外位移系数 */
  beta: number;
  /** 修正项作用尺度 Hz */
  fRef: number;
}

export const DEFAULT_BETA = 0.35;
export const DEFAULT_F_REF = 900;

/** 校正后频率 → 氦语音中观测到的频率 */
export function forwardWarp(fOut: number, p: WarpParams): number {
  const { s, beta, fRef } = p;
  const linear = fOut / s;
  const lowBoost = beta * fRef * ((1 - s) / s) * Math.exp(-fOut / fRef);
  return linear + lowBoost;
}

/** 氦语音观测频率 → 校正后频率（单调逆映射，二分求解） */
export function inverseWarp(fIn: number, p: WarpParams): number {
  if (!(p.s > 0 && p.s < 1.0001)) return fIn;
  let lo = 0;
  let hi = Math.max(fIn * p.s * 2, fIn + 4000);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (forwardWarp(mid, p) > fIn) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** 谱线逐点搬移：输出 bin k 对应的输入频率 */
export function warpBinMap(fftSize: number, sampleRate: number, p: WarpParams): Float64Array {
  const bins = fftSize / 2;
  const map = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const fOut = (k * sampleRate) / fftSize;
    map[k] = forwardWarp(fOut, p);
  }
  return map;
}

/**
 * 频谱重采样（线性插值），按 bin 频率映射从输入谱取值。
 * 输入/输出均为单边幅度谱，长度 fftSize/2。
 */
export function resampleMagnitude(
  inputMag: ArrayLike<number>,
  binMap: ArrayLike<number>,
  sampleRate: number,
  fftSize: number,
): Float64Array {
  const out = new Float64Array(inputMag.length);
  const inBinHz = sampleRate / fftSize;
  for (let k = 0; k < out.length; k++) {
    const srcFreq = binMap[k];
    const x = srcFreq / inBinHz;
    const i0 = Math.floor(x);
    const frac = x - i0;
    const v0 = i0 < inputMag.length ? inputMag[i0] : 0;
    const v1 = i0 + 1 < inputMag.length ? inputMag[i0 + 1] : v0;
    out[k] = v0 * (1 - frac) + v1 * frac;
  }
  return out;
}
