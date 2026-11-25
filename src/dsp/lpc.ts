/**
 * 全极点声道模型：自相关法 + Levinson–Durbin 递推。
 * 模型 H(z) = G / A(z)，A(z) = 1 + a1 z^-1 + ... + ap z^-p。
 */

/** 有偏自相关估计 r[k] = sum_{n=0}^{N-1-k} x[n] x[n+k] */
export function autocorrelation(x: ArrayLike<number>, order: number): Float64Array {
  const n = x.length;
  const r = new Float64Array(order + 1);
  for (let k = 0; k <= order; k++) {
    let acc = 0;
    const lim = n - k;
    for (let i = 0; i < lim; i++) acc += x[i] * x[i + k];
    r[k] = acc;
  }
  return r;
}

export interface LevinsonResult {
  /** 预测系数，a[0] = 1 */
  a: Float64Array;
  /** 预测残差能量（激励增益平方） */
  error: number;
  /** 模型是否稳定（全部反射系数 |k| < 1） */
  stable: boolean;
}

export function levinsonDurbin(r: ArrayLike<number>, order: number): LevinsonResult {
  const a = new Float64Array(order + 1);
  const prev = new Float64Array(order + 1);
  a[0] = 1;
  let error = Math.max(r[0], 1e-12);
  let stable = true;

  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    let k = -acc / error;
    if (!Number.isFinite(k)) {
      stable = false;
      k = 0;
    }
    // 钳制反射系数到安全半径，保证合成滤波器 1/A(z) 极点严格在单位圆内
    if (Math.abs(k) >= 0.98) {
      stable = false;
      k = Math.sign(k) * 0.98;
    }
    prev.set(a.subarray(0, i + 1));
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    error = Math.max(error * (1 - k * k), 1e-12);
  }
  return { a, error, stable };
}

/**
 * LPC 阶数经验规则：采样率每 kHz 取 2 阶再加 2，
 * 保证 4 kHz 以下每共振峰约 2 极。
 */
export function recommendedLpcOrder(sampleRate: number): number {
  return Math.round(sampleRate / 1000) * 2 + 2;
}
