/**
 * 氦氧混合气物理模型
 * ------------------
 * 声速: c = sqrt(gamma * R_u * T / M_mix)
 * 混合气体摩尔质量 M_mix = Σ x_i M_i，比热比由摩尔定容热容混合后求得。
 * 共振峰弯折系数 q(F) 参考 Fant 氦语音模型：均匀比例 q0 = c_he / c_air，
 * 低频段额外的舱壁/面罩腔体扰动以高斯项建模，随深度略增。
 */

export interface GasMix {
  /** 各组分摩尔分数 0..1，he+o2+n2 ≈ 1 */
  he: number;
  o2: number;
  n2: number;
}

export const R_U = 8.314462618; // 通用气体常数 J/(mol·K)
/** 人体气道内气体温度 37°C */
export const BODY_TEMP_K = 310.15;

interface GasProps {
  M: number; // 摩尔质量 kg/mol
  gamma: number; // 比热比
}

const GAS_PROPS: Record<keyof GasMix, GasProps> = {
  he: { M: 0.0040026, gamma: 5 / 3 },
  o2: { M: 0.031998, gamma: 1.397 },
  n2: { M: 0.0280134, gamma: 1.4 },
};

/** 空气（21% O2 + 79% N2） */
export const AIR_MIX: GasMix = { he: 0, o2: 0.21, n2: 0.79 };

function assertMix(mix: GasMix): void {
  const s = mix.he + mix.o2 + mix.n2;
  if (Math.abs(s - 1) > 0.02) {
    throw new Error(`气体组分之和应为 1，当前为 ${s.toFixed(4)}`);
  }
}

/** 混合气体中的声速 (m/s) */
export function soundSpeed(mix: GasMix, T: number = BODY_TEMP_K): number {
  assertMix(mix);
  let M = 0;
  let Cv = 0; // 摩尔定容热容 J/(mol·K)
  (Object.keys(GAS_PROPS) as (keyof GasMix)[]).forEach((k) => {
    const x = mix[k];
    const p = GAS_PROPS[k];
    M += x * p.M;
    Cv += x * (R_U / (p.gamma - 1));
  });
  const Cp = Cv + R_U;
  const gamma = Cp / Cv;
  return Math.sqrt((gamma * R_U * T) / M);
}

/** 空气中的声速 (m/s)，37°C 时约 353.5 m/s */
export function airSoundSpeed(T: number = BODY_TEMP_K): number {
  return soundSpeed(AIR_MIX, T);
}

/** 绝对环境压力 (bar)，深度 d 单位米（海水，每 10 m 增加 1 bar） */
export function pressureAtDepth(depthM: number): number {
  return 1 + depthM / 10;
}

/** 由绝对压力反推深度 (m) */
export function depthFromPressure(pressureBar: number): number {
  return (pressureBar - 1) * 10;
}

/** 氧分压 (bar)，用于潜水日志安全校核 */
export function oxygenPartialPressure(mix: GasMix, depthM: number): number {
  return mix.o2 * pressureAtDepth(depthM);
}

export interface WallEffectOptions {
  /** 低频舱壁/面罩附加位移的最大幅度（相对 q0 的比例） */
  wallGain: number;
  /** 附加效应的截止频率 Hz */
  wallFc: number;
}

export const DEFAULT_WALL: WallEffectOptions = { wallGain: 0.14, wallFc: 1200 };

/**
 * 频率相关的氦语音共振峰上移系数 q(F)
 * F_he = q(F) * F_air；校正时 F_corr = F_he / q(F_he)
 * 低频段（F1、F2 底部）受舱壁/面罩影响位移更大，高频趋向均匀 q0。
 */
export function formantShiftFactor(
  freqHz: number,
  mix: GasMix,
  depthM: number,
  wall: WallEffectOptions = DEFAULT_WALL,
): number {
  const q0 = soundSpeed(mix) / airSoundSpeed();
  // 面罩/舱壁腔体扰动是氦气环境特有效应：随氦气比例缩放，纯空气时为 0
  const heFrac = mix.he;
  // 面罩腔体刚度随压力升高，壁面效应略增强
  const gain = (wall.wallGain + 0.05 * Math.min(Math.max(depthM, 0) / 100, 1)) * heFrac;
  const extra = gain * Math.exp(-((freqHz / wall.wallFc) ** 2));
  return q0 * (1 + extra);
}

/** 均匀声速比 q0（界面显示与日志用） */
export function uniformShiftRatio(mix: GasMix): number {
  return soundSpeed(mix) / airSoundSpeed();
}

/** 校正端：由氦语音频率反推正常频率。q 随频率变化，用二分法求 fAir 使 fAir·q(fAir)=fHe */
export function correctFrequency(
  freqHe: number,
  mix: GasMix,
  depthM: number,
  wall?: WallEffectOptions,
): number {
  // q(F) >= 1，故 fAir <= fHe；下界取 fHe/4 足够宽松
  let lo = freqHe / 4;
  let hi = freqHe;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const predicted = mid * formantShiftFactor(mid, mix, depthM, wall);
    if (predicted < freqHe) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
