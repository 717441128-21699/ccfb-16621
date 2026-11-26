/**
 * 全极点声道模型：自相关法 LPC + Levinson-Durbin 递推
 * 模型 H(z) = G / A(z)，A(z) = 1 + Σ a_k z^-k
 */

/** 有偏自相关序列 r(0..order)，输入应已加窗 */
export function autocorrelation(frame: Float64Array, order: number): Float64Array {
  const r = new Float64Array(order + 1);
  const N = frame.length;
  for (let k = 0; k <= order; k++) {
    let s = 0;
    for (let n = k; n < N; n++) s += frame[n] * frame[n - k];
    r[k] = s;
  }
  return r;
}

export interface LpcResult {
  /** 预测系数 a1..ap（A(z)=1+a1 z^-1+...） */
  a: Float64Array;
  /** 线性预测残差能量（增益平方） */
  error: number;
  /** 反射系数 */
  k: Float64Array;
}

/** Levinson-Durbin 求解 Yule-Walker  Toeplitz 系统 */
export function levinsonDurbin(r: Float64Array, order: number): LpcResult {
  const a = new Float64Array(order);
  const k = new Float64Array(order);
  if (r[0] <= 1e-12) {
    return { a, error: 0, k };
  }
  // 按阶索引的预测系数，prev[j] 表示 A(z)=1+Σ a_j z^-j 中的 a_j（j=1..i）
  let prev = new Float64Array(order + 1);
  let err = r[0];

  for (let i = 1; i <= order; i++) {
    // 反射系数 k_i = -(r[i] + Σ_{j=1}^{i-1} a_{i-1}[j] r[i-j]) / err
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += prev[j] * r[i - j];
    const ki = -acc / err;
    k[i - 1] = ki;

    const cur = new Float64Array(order + 1);
    cur[i] = ki;
    for (let j = 1; j < i; j++) {
      cur[j] = prev[j] + ki * prev[i - j];
    }
    err *= 1 - ki * ki;
    if (err < 1e-12 * r[0]) err = 1e-12 * r[0];
    prev = cur;
  }
  for (let j = 1; j <= order; j++) a[j - 1] = prev[j];
  return { a, error: Math.max(err, 0), k };
}

/** 一步完整 LPC 分析（帧需预先加窗）。
 * 对自相关 r(0) 注入小量白噪（带宽展宽），消除浊音周期信号导致的
 * Toeplitz 矩阵近奇异（pitch-locking，极点贴单位圆锁到谐波）。 */
export function lpcAnalyze(frame: Float64Array, order: number): LpcResult {
  const r = autocorrelation(frame, order);
  const floor = 1e-3 * r[0] + 1e-12;
  r[0] += floor;
  return levinsonDurbin(r, order);
}

/** 全极点模型在角频率 omega 处的幅度响应 |H(e^jω)| */
export function allPoleMagnitude(a: Float64Array, gain: number, omega: number): number {
  let re = 1;
  let im = 0;
  for (let k = 0; k < a.length; k++) {
    const ang = -omega * (k + 1);
    re += a[k] * Math.cos(ang);
    im += a[k] * Math.sin(ang);
  }
  return gain / Math.max(Math.hypot(re, im), 1e-12);
}
