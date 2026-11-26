/**
 * 基音周期估计：自相关法 + 抛物线插值
 * 仅用于监测/合成端激励生成；校正链本身不改变基音（残差直通）。
 */

export interface PitchResult {
  f0: number; // Hz，清音/无声返回 0
  clarity: number; // 0..1 周期性置信度
}

export function estimatePitch(
  frame: Float64Array,
  sampleRate: number,
  fMin = 65,
  fMax = 400,
): PitchResult {
  const N = frame.length;
  const lagMin = Math.floor(sampleRate / fMax);
  const lagMax = Math.min(Math.ceil(sampleRate / fMin), N - 1);

  let r0 = 0;
  for (let i = 0; i < N; i++) r0 += frame[i] * frame[i];
  if (r0 < 1e-8) return { f0: 0, clarity: 0 };

  let bestLag = -1;
  let bestVal = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = lag; i < N; i++) s += frame[i] * frame[i - lag];
    const norm = s / r0;
    if (norm > bestVal) {
      bestVal = norm;
      bestLag = lag;
    }
  }

  if (bestLag < 0 || bestVal < 0.45) return { f0: 0, clarity: Math.max(0, bestVal) };

  // 八度纠错：若最佳滞后的一半（更高基频）也有足够强的周期性，
  // 说明当前锁到了次谐波（基频被低估一倍），优先取更短滞后
  const acfAt = (lag: number) => {
    let s = 0;
    for (let i = lag; i < N; i++) s += frame[i] * frame[i - lag];
    return s / r0;
  };
  const halfLag = bestLag / 2;
  if (halfLag >= lagMin) {
    const halfVal = acfAt(Math.round(halfLag));
    if (halfVal > 0.82 * bestVal) {
      bestLag = Math.round(halfLag);
      bestVal = halfVal;
    }
  }

  // 抛物线插值细化峰值
  let sL = 0;
  let sC = 0;
  let sR = 0;
  for (let i = bestLag; i < N; i++) sC += frame[i] * frame[i - bestLag];
  if (bestLag > lagMin) {
    for (let i = bestLag - 1; i < N; i++) sL += frame[i] * frame[i - (bestLag - 1)];
  }
  if (bestLag < lagMax) {
    for (let i = bestLag + 1; i < N; i++) sR += frame[i] * frame[i - (bestLag + 1)];
  }
  const denom = sL - 2 * sC + sR;
  const shift = denom !== 0 ? 0.5 * (sL - sR) / denom : 0;
  const refined = bestLag + Math.max(-1, Math.min(1, shift));

  return { f0: sampleRate / refined, clarity: Math.min(1, bestVal) };
}
