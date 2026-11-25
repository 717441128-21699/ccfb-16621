/**
 * 气体物理模型 —— 氦氧混合气声速与共振峰校正系数
 *
 * 理想气体声速： c = sqrt(gamma * R_specific * T) = sqrt(gamma * R * T / M)
 * 混合气体按摩尔分数加权平均摩尔质量 M 与定压摩尔热容 Cp，
 * 再由 gamma = Cp / (Cp - R/M) 求比热比。
 *
 * 注意：理想气体声速只与温度和气体组分有关，与绝对压力无关。
 * 舱压对语音的影响通过"各深度对应的混合气配比"进入模型，
 * 舱壁/面罩造成的低频额外位移由 warping 模块的 beta 项描述。
 */

/** 通用气体常数 J/(mol·K) */
export const R_UNIVERSAL = 8.314462618;

/** 摩尔质量 kg/mol */
export const M_HE = 0.004002602;
export const M_O2 = 0.0319988;
export const M_N2 = 0.0280134;

/** 25℃ 附近定压质量热容 J/(kg·K) */
export const CP_HE = 5193;
export const CP_O2 = 918;
export const CP_N2 = 1039;

/** 气体组分，摩尔分数，三者之和为 1 */
export interface GasMix {
  he: number;
  o2: number;
  n2: number;
}

export const AIR: GasMix = { he: 0, o2: 0.2095, n2: 0.7905 };

export function mixMolarMass(mix: GasMix): number {
  return mix.he * M_HE + mix.o2 * M_O2 + mix.n2 * M_N2;
}

export function mixCp(mix: GasMix): number {
  return mix.he * CP_HE + mix.o2 * CP_O2 + mix.n2 * CP_N2;
}

/** 混合气体比热比 gamma（质量基准：cv = cp - R_specific） */
export function mixGamma(mix: GasMix): number {
  const cp = mixCp(mix);
  const rSpecific = R_UNIVERSAL / mixMolarMass(mix);
  return cp / (cp - rSpecific);
}

/** 声速 m/s，T 为绝对温度 K */
export function soundSpeed(mix: GasMix, tempKelvin: number): number {
  const rSpecific = R_UNIVERSAL / mixMolarMass(mix);
  return Math.sqrt(mixGamma(mix) * rSpecific * tempKelvin);
}

/** 20℃ 空气中声速 ~343 m/s，作为参考基准 */
export const AIR_SPEED_20C = soundSpeed(AIR, 293.15);

/**
 * 基础共振峰校正系数 s = c_air / c_mix。
 * 氦语音共振峰频率近似按 c_mix / c_air 上移，故搬移时整体除以 s。
 */
export function correctionFactor(mix: GasMix, tempKelvin: number): number {
  return AIR_SPEED_20C / soundSpeed(mix, tempKelvin);
}

/** 海水深度（米）→ 绝对压力 bar，每 10 msw 约增加 1 bar */
export function depthToPressure(depthMsw: number): number {
  return 1.01325 + depthMsw / 10;
}

export function pressureToDepth(pressureBar: number): number {
  return (pressureBar - 1.01325) * 10;
}

/** 氧分压 bar（潜水医学要求常态 0.4 ~ 1.6 bar） */
export function partialPressureO2(mix: GasMix, depthMsw: number): number {
  return mix.o2 * depthToPressure(depthMsw);
}

/** 组分百分比格式化 */
export function formatMix(mix: GasMix): string {
  return `He ${(mix.he * 100).toFixed(1)}% / O₂ ${(mix.o2 * 100).toFixed(1)}% / N₂ ${(mix.n2 * 100).toFixed(1)}%`;
}

/** 任务舱温（饱和潜水舱温通常 28~34℃），单位 K */
export function chamberTempKelvin(celsius: number): number {
  return celsius + 273.15;
}
