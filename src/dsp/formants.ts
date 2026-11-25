/**
 * 共振峰提取：FFT、LPC 谱峰校验与 Durand–Kerner 多项式求根。
 */
import type { FFT } from './fft.ts';

export interface PolePair {
  freq: number;
  bandwidth: number;
}

export interface Formant extends PolePair {
  index: number;
}

interface Complex {
  re: number;
  im: number;
}

/**
 * Durand–Kerner（Weierstrass）同时迭代求多项式全部根。
 * 多项式 P(z) = c[0] + c[1] z + ... + c[p] z^p，系数升幂。
 * 对低阶全极点分母（p ≤ 20）收敛稳定，无需初值猜测。
 */
export function durandKernerRoots(c: ArrayLike<number>, maxIter = 60, tol = 1e-10): Complex[] {
  const degree = c.length - 1;
  const roots: Complex[] = [];
  // 初始根均匀分布在单位圆内，带复偏移避免共轭退化停滞
  const seed = { re: 0.4, im: 0.9 };
  let z = seed;
  for (let k = 0; k < degree; k++) {
    roots.push({ re: z.re, im: z.im });
    z = complexMul(z, seed);
  }

  const evalP = (z0: Complex): Complex => {
    // Horner，升幂系数从最高次向下
    let val = { re: c[degree], im: 0 };
    for (let j = degree - 1; j >= 0; j--) {
      val = complexAdd(complexMul(val, z0), { re: c[j], im: 0 });
    }
    return val;
  };

  for (let iter = 0; iter < maxIter; iter++) {
    let maxDelta = 0;
    for (let k = 0; k < degree; k++) {
      const pz = evalP(roots[k]);
      let denom: Complex = { re: 1, im: 0 };
      for (let j = 0; j < degree; j++) {
        if (j === k) continue;
        denom = complexMul(denom, complexSub(roots[k], roots[j]));
      }
      const delta = complexDiv(pz, denom);
      roots[k] = complexSub(roots[k], delta);
      maxDelta = Math.max(maxDelta, Math.hypot(delta.re, delta.im));
    }
    if (maxDelta < tol) break;
  }
  return roots;
}

function complexMul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}
function complexDiv(a: Complex, b: Complex): Complex {
  const d = b.re * b.re + b.im * b.im || 1e-18;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}
function complexAdd(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}
function complexSub(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}

/**
 * 由 LPC 预测系数求共振峰。
 * @param a 预测系数 a[0]=1（对应 A(z) 按 z^0..z^p 升幂）
 * @param sampleRate 采样率 Hz
 * @param maxFreq 只保留该频率以下的峰
 */
export function polesFromLpc(a: ArrayLike<number>, sampleRate: number, maxFreq: number): PolePair[] {
  const roots = durandKernerRoots(a);
  const pairs: PolePair[] = [];
  for (const z of roots) {
    const mag = Math.hypot(z.re, z.im);
    if (mag <= 1e-6 || mag > 1.05) continue; // 剔除近零根与明显发散根
    if (z.im <= 1e-7) continue; // 只取共轭极对的上半平面成员
    const ang = Math.atan2(z.im, z.re);
    const freq = (ang * sampleRate) / (2 * Math.PI);
    // 单位圆上的极带宽为 0，钳到 40 Hz 下限，避免除零
    const bandwidth = Math.max(40, (-Math.log(Math.min(mag, 0.9999)) * sampleRate) / Math.PI);
    if (freq > 60 && freq < maxFreq && bandwidth < 900) {
      pairs.push({ freq, bandwidth });
    }
  }
  pairs.sort((p, q) => p.freq - q.freq);
  return pairs;
}

/** LPC 幅度谱 dB，用于峰值校验与界面绘制 */
export function lpcSpectrumDb(
  a: ArrayLike<number>,
  gain: number,
  fft: FFT,
): Float64Array {
  const n = fft.size;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < a.length; i++) re[i] = a[i];
  fft.transform(re, im);
  const out = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    const mag2 = Math.max(re[k] * re[k] + im[k] * im[k], 1e-12);
    out[k] = 10 * Math.log10((gain * gain) / mag2);
  }
  return out;
}

/**
 * 共振峰拾取：以 LPC 谱局部峰值为主（对宽带极稳健），
 * 极对仅用于为命中的谱峰提供带宽估计。
 * 实践中宽带共振峰的极频率可能与谱峰偏差较大，而谱峰始终对准共振中心。
 */
export function pickFormants(
  a: ArrayLike<number>,
  gain: number,
  sampleRate: number,
  fft: FFT,
  maxCount = 4,
): Formant[] {
  const poles = polesFromLpc(a, sampleRate, sampleRate * 0.46);
  const specDb = lpcSpectrumDb(a, gain, fft);
  const binHz = sampleRate / fft.size;
  const peaks: number[] = [];
  for (let k = 2; k < specDb.length - 2; k++) {
    if (
      specDb[k] > specDb[k - 1] &&
      specDb[k] >= specDb[k + 1] &&
      specDb[k] > specDb[k - 2] &&
      specDb[k] >= specDb[k + 2]
    ) {
      peaks.push(k * binHz);
    }
  }

  const result: Formant[] = [];
  let lastFreq = 120; // F1 下限，剔除根部伪峰但保留 /i/、/u/ 的低频 F1
  for (const peakFreq of peaks) {
    if (peakFreq < 160 || peakFreq > sampleRate * 0.45) continue;
    if (peakFreq - lastFreq < 180) continue; // 相邻共振峰最小间隔
    // 用最近的极估计带宽；没有匹配极时给经验带宽
    let bandwidth = 120;
    let bestDist = Infinity;
    for (const pole of poles) {
      const d = Math.abs(pole.freq - peakFreq);
      if (d < bestDist) {
        bestDist = d;
        bandwidth = pole.bandwidth;
      }
    }
    // 过宽的带宽（>600Hz）说明极不可靠，回退到经验值
    if (!(bandwidth > 0 && bandwidth < 600)) bandwidth = 120;
    result.push({ index: result.length + 1, freq: peakFreq, bandwidth });
    lastFreq = peakFreq;
    if (result.length >= maxCount) break;
  }
  return result;
}
