/**
 * 共振峰轨道锁定（无状态、对初始化鲁棒）
 * ------------------------------------
 * 不做逐帧贪心跟踪（短窗口初始化不稳），而是收集窗口内全部帧的候选极点，
 * 在每个共振峰的语音学先验频带内做频率聚类，取成员最多的簇的中心。
 * 偶发误配/缺失帧因成不了主簇而被自然剔除，等价于"多数投票"。
 */

import type { Pole } from './formants.ts';

export interface FormantBand {
  min: number;
  max: number;
}

/** 校正到空气域后 F1/F2/F3 的先验频带。
 * F1/F2 在 600-1000 重叠以容纳 u 这类低 F2（~800）元音，靠去重分配解决争抢。 */
export const AIR_FORMANT_BANDS: FormantBand[] = [
  { min: 150, max: 1000 },
  { min: 600, max: 2700 },
  { min: 1600, max: 3800 },
];

/** 单簇 */
interface Cluster {
  members: number[];
  center: number;
}

function cluster1D(values: number[], maxGapRatio = 0.18): Cluster[] {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: Cluster[] = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(v - last.center) <= last.center * maxGapRatio) {
      last.members.push(v);
      last.center = last.members.reduce((s, x) => s + x, 0) / last.members.length;
    } else {
      clusters.push({ members: [v], center: v });
    }
  }
  return clusters;
}

export interface LockedFormant {
  f: number;
  bw: number;
  /** 该轨道在窗口内的命中率（成员帧数/总帧数），作为置信度 */
  hitRate: number;
}

/**
 * 对一个元音窗口内的逐帧极点做轨道锁定。
 * 做法：收集所有帧候选 → 全局频率聚类 → 按频率顺序分配给 F1/F2/F3，
 * 每个簇只被一个轨道使用（去重），先验频带仅用于剔除明显越界的簇。
 * 这样 u（F1=320/F2=800 同处低频）这类相邻共振峰也能正确分列。
 */
export function lockFormantTracks(
  framePoles: Pole[][],
  totalFrames: number,
  count = 3,
  bands: FormantBand[] = AIR_FORMANT_BANDS,
): LockedFormant[] {
  // 1) 收集全部候选
  const allFreq: number[] = [];
  const bwByFreq = new Map<number, number[]>();
  for (const poles of framePoles) {
    for (const p of poles) {
      if (!Number.isFinite(p.f)) continue;
      allFreq.push(p.f);
      const arr = bwByFreq.get(p.f) ?? [];
      arr.push(p.bw);
      bwByFreq.set(p.f, arr);
    }
  }

  const result: LockedFormant[] = [];
  if (allFreq.length === 0) {
    for (let t = 0; t < count; t++) result.push({ f: NaN, bw: NaN, hitRate: 0 });
    return result;
  }

  // 2) 全局聚类
  const clusters = cluster1D(allFreq);
  const enriched = clusters.map((c) => {
    const cBws = c.members.flatMap((ff) => bwByFreq.get(ff) ?? []);
    const meanBw = cBws.reduce((s, x) => s + x, 0) / (cBws.length || 1);
    return { center: c.center, size: c.members.length, meanBw };
  });

  // 3) 按频率顺序，为每个轨道在其先验频带内挑最显著的未用簇（去重，每簇只归一个轨道）
  const used = new Set<number>();
  for (let t = 0; t < count; t++) {
    const band = bands[t] ?? { min: 0, max: Infinity };
    const center0 = (band.min + band.max) / 2;
    const maxSize = Math.max(1, ...enriched.map((c) => c.size));
    let bestIdx = -1;
    let bestScore = -Infinity;
    enriched.forEach((c, idx) => {
      if (used.has(idx)) return;
      if (c.center < band.min || c.center > band.max) return;
      const sizeScore = c.size / maxSize;
      const bwScore = 1 / (1 + c.meanBw / 400);
      const priorScore = 1 - Math.min(1, Math.abs(c.center - center0) / (band.max - band.min));
      const score = sizeScore * 0.5 + bwScore * 0.3 + priorScore * 0.2;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    });

    if (bestIdx < 0) {
      result.push({ f: NaN, bw: NaN, hitRate: 0 });
      continue;
    }
    used.add(bestIdx);
    const chosen = enriched[bestIdx];
    result.push({
      f: chosen.center,
      bw: chosen.meanBw,
      hitRate: chosen.size / Math.max(1, totalFrames),
    });
  }
  return result;
}
