/**
 * 共振峰提取与氦语音极点搬移
 * - Durand-Kerner (Weierstrass) 复数求根，把 LPC 多项式分解为极点
 * - 上半平面极点 → 共振峰频率/带宽
 * - 按物理弯折系数 q(F) 把极点沿频率轴拉回空气位置，带宽保持绝对值，音高（激励）不动
 */

import { allPoleMagnitude } from './lpc.ts';
import { correctFrequency, type GasMix, type WallEffectOptions } from './physics.ts';

export interface Complex {
  re: number;
  im: number;
}

export interface Pole {
  f: number; // 共振峰频率 Hz
  bw: number; // 带宽 Hz
  z: Complex; // z 平面极点
}

export interface Formant extends Pole {
  index: number;
}

function cAdd(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}
function cSub(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}
function cMul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}
function cDiv(a: Complex, b: Complex): Complex {
  const d = b.re * b.re + b.im * b.im || 1e-20;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}
function cAbs(a: Complex): number {
  return Math.hypot(a.re, a.im);
}

/** 多项式求值，降幂系数 coef[0]·z^p + ... + coef[p]（Horner 法） */
function polyEval(coef: Float64Array, z: Complex): Complex {
  let acc: Complex = { re: coef[0], im: 0 };
  for (let i = 1; i < coef.length; i++) {
    acc = cAdd(cMul(acc, z), { re: coef[i], im: 0 });
  }
  return acc;
}

/**
 * Durand-Kerner 同时迭代求全部根。
 * 降幂首一多项式，根均在单位圆内，初值取半径 0.4 的分散小圆。
 */
export function polynomialRoots(coef: Float64Array, maxIter = 300, tol = 1e-12): Complex[] {
  const p = coef.length - 1;
  // 归一为首一多项式，避免系数尺度影响收敛
  const monic = new Float64Array(coef.length);
  for (let i = 0; i < coef.length; i++) monic[i] = coef[i] / coef[0];
  const roots: Complex[] = [];
  const seed: Complex = { re: 0.4, im: 0.9 };
  let pow: Complex = { re: 1, im: 0 };
  for (let i = 0; i < p; i++) {
    roots.push({ ...pow });
    pow = cMul(pow, seed);
  }

  for (let iter = 0; iter < maxIter; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < p; i++) {
      let denom: Complex = { re: 1, im: 0 };
      for (let j = 0; j < p; j++) {
        if (j === i) continue;
        denom = cMul(denom, cSub(roots[i], roots[j]));
      }
      const delta = cDiv(polyEval(monic, roots[i]), denom);
      roots[i] = cSub(roots[i], delta);
      maxDelta = Math.max(maxDelta, cAbs(delta));
    }
    if (maxDelta < tol) break;
  }
  return roots;
}

/** 由 LPC 系数求极点（仅上半平面共轭对，实根忽略） */
export function polesFromLpc(a: Float64Array, sampleRate: number): Pole[] {
  const coef = new Float64Array(a.length + 1);
  coef[0] = 1;
  coef.set(a, 1);
  const roots = polynomialRoots(coef);
  const poles: Pole[] = [];
  for (const z of roots) {
    if (z.im <= 1e-6) continue; // 实根或下半平面共轭
    const r = Math.min(cAbs(z), 0.9995);
    const ang = Math.atan2(z.im, z.re);
    const f = (ang * sampleRate) / (2 * Math.PI);
    const bw = (-Math.log(r) * sampleRate) / Math.PI;
    if (f > 30 && f < sampleRate / 2 - 50) {
      poles.push({ f, bw, z: { re: z.re, im: z.im } });
    }
  }
  poles.sort((u, v) => u.f - v.f);
  return poles;
}

/** 取前若干个共振峰（按频率升序的 F1/F2/F3…定义）。
 * 先剔除物理上不可能的候选（超带宽/伪尖峰/过低频率），再直接按频率取前 N。
 * 不做尖锐度重排——F1/F2 的语义就是频率序，重排会把相邻的 F2 误提为 F1。 */
export function findFormants(a: Float64Array, sampleRate: number, count = 4): Formant[] {
  return polesFromLpc(a, sampleRate)
    .filter(
      (p) =>
        p.f >= FORMANT_MIN_FREQ &&
        Math.hypot(p.z.re, p.z.im) < FORMANT_MAX_RADIUS &&
        p.bw >= MIN_FORMANT_BW &&
        p.bw <= MAX_FORMANT_BW,
    )
    .slice(0, count)
    .map((p, i) => ({ ...p, index: i + 1 }));
}

export interface WarpResult {
  a: Float64Array;
  gain: number;
  /** 每对极点的搬移映射 {氦语音频率 → 校正后频率} */
  mapping: { from: number; to: number; bw: number }[];
}

/** 物理共振峰带宽下限 (Hz)：低于此值的尖峰视为降噪/求根伪极点 */
export const MIN_FORMANT_BW = 55;
/** 极点半径硬上限：保证 IIR 数值稳定、脉冲快速衰减 */
export const MAX_POLE_RADIUS = 0.975;
/** 共振峰候选极点的最大半径（r 越接近 1 带宽越窄，>0.99 为伪尖峰） */
export const FORMANT_MAX_RADIUS = 0.99;
/** 共振峰最低频率 (Hz)：低于此值的极点多为气流/低频扰动，非声道共振 */
export const FORMANT_MIN_FREQ = 120;
/** 共振峰最大带宽 (Hz)：宽于此值的极点视为噪声/谱倾斜，不承载共振峰。
 * 真实声道共振峰带宽多在 80~500 Hz，宽峰（>500）是噪声残留或谱包络倾斜。 */
export const MAX_FORMANT_BW = 500;

/**
 * 全极点滤波器频率搬移：
 * 求根得到每个共轭极点对 (f_he, bw) → (f_air = f_he / q(f_he), bw)，
 * 然后用实数二阶节 1/(1 - 2r cosω z^-1 + r² z^-2) 直接级联重建系数，
 * 全程实数运算，避免复数求根-重建的虚部残留导致系数爆炸。
 * 实根折叠为一阶节。增益按谱形平均幅度重新归一，保持响度一致。
 */
export function warpAllPoleFilter(
  a: Float64Array,
  gain: number,
  sampleRate: number,
  mix: GasMix,
  depthM: number,
  wall?: WallEffectOptions,
): WarpResult {
  const coef = new Float64Array(a.length + 1);
  coef[0] = 1;
  coef.set(a, 1);
  const roots = polynomialRoots(coef);
  const mapping: WarpResult['mapping'] = [];

  // 二阶节/一阶节的分母系数（每个节是 [b0=1, b1, b2] 或 [1, b1]）
  const sections: number[][] = [];

  const complex = roots.filter((z) => Math.abs(z.im) > 1e-4);
  const real = roots.filter((z) => Math.abs(z.im) <= 1e-4);

  for (const z of real) {
    const rr = Math.max(-MAX_POLE_RADIUS, Math.min(MAX_POLE_RADIUS, z.re));
    // 一阶节 1/(1 - rr z^-1)
    sections.push([1, -rr]);
  }

  const used = new Set<number>();
  for (let i = 0; i < complex.length; i++) {
    if (used.has(i)) continue;
    let partner = -1;
    let best = Infinity;
    for (let j = 0; j < complex.length; j++) {
      if (j === i || used.has(j)) continue;
      const d = Math.abs(complex[j].re - complex[i].re) + Math.abs(complex[j].im + complex[i].im);
      if (d < best) {
        best = d;
        partner = j;
      }
    }
    used.add(i);
    if (partner >= 0) used.add(partner);
    const upper0 = complex[i].im > 0 ? complex[i] : partner >= 0 ? complex[partner] : complex[i];

    const r0 = Math.min(cAbs(upper0), 0.9995);
    const fHe = (Math.atan2(Math.abs(upper0.im), upper0.re) * sampleRate) / (2 * Math.PI);
    const bwRaw = (-Math.log(r0) * sampleRate) / Math.PI;
    const bw = Math.max(bwRaw, MIN_FORMANT_BW);
    const fAir = correctFrequency(fHe, mix, depthM, wall);
    const sigma = Math.PI * bw / sampleRate;
    const omega = (2 * Math.PI * fAir) / sampleRate;
    const radius = Math.min(Math.exp(-sigma), MAX_POLE_RADIUS);

    // 共轭对 (r e±jω) → 二阶节分母 1 - 2r cosω z^-1 + r² z^-2
    sections.push([1, -2 * radius * Math.cos(omega), radius * radius]);
    mapping.push({ from: fHe, to: fAir, bw });
  }

  // 实数卷积级联所有节，得到首一分母多项式
  let poly = new Float64Array([1]);
  for (const sec of sections) {
    const next = new Float64Array(poly.length + sec.length - 1);
    for (let i = 0; i < poly.length; i++) {
      for (let j = 0; j < sec.length; j++) next[i + j] += poly[i] * sec[j];
    }
    poly = next;
  }
  // 截断/补齐到与原系数同阶
  const newA = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) newA[i] = poly[i + 1] ?? 0;

  // 谱增益匹配：对数谱中位数对齐，对共振峰深谷/尖峰稳健，避免均值被极值带偏
  const gridN = 64;
  const oldDb: number[] = [];
  const newDb: number[] = [];
  for (let i = 0; i < gridN; i++) {
    const f = 120 * (Math.min(4000, sampleRate / 2) / 120) ** (i / (gridN - 1));
    const omega = (2 * Math.PI * f) / sampleRate;
    oldDb.push(20 * Math.log10(Math.max(allPoleMagnitude(a, gain, omega), 1e-8)));
    newDb.push(20 * Math.log10(Math.max(allPoleMagnitude(newA, 1, omega), 1e-8)));
  }
  const median = (x: number[]) => {
    const s = [...x].sort((u, v) => u - v);
    return s[Math.floor(s.length / 2)];
  };
  // 使新旧包络的中位电平一致：newGain(dB) = oldMedian - newMedian
  const gainDb = median(oldDb) - median(newDb);
  const newGain = Math.max(1e-3, Math.min(20, 10 ** (gainDb / 20)));

  return { a: newA, gain: newGain, mapping };
}
