/**
 * 跨帧共振峰跟踪器。
 * 帧级 LPC 峰拾取存在抖动、漏峰和错序，本跟踪器用：
 *  1. 最近邻数据关联把当前帧候选峰分配给已有轨迹
 *  2. 指数平滑抑制帧间跳动
 *  3. 漏帧保持 + 生命周期管理，避免轨迹频繁生灭
 * 输出稳定的 F1..Fn 时间序列，供搬移、显示与质量评估使用。
 */
export interface TrackedFormant {
  freq: number;
  bandwidth: number;
}

interface Track extends TrackedFormant {
  missCount: number;
  age: number;
}

export class FormantTracker {
  private tracks: Track[] = [];
  private readonly alpha: number;
  private readonly maxMiss: number;
  private readonly maxTracks: number;
  /** 关联门限：候选与轨迹频率差超过该比例则视为新轨迹 */
  private readonly gatePct: number;

  constructor(maxTracks = 4, alpha = 0.35, maxMiss = 4, gatePct = 0.28) {
    this.maxTracks = maxTracks;
    this.alpha = alpha;
    this.maxMiss = maxMiss;
    this.gatePct = gatePct;
  }

  /**
   * 输入当前帧原始拾取峰（已按频率排序），返回平滑后的稳定峰。
   * @param isSpeech 当前帧是否语音；静音帧不更新但保持轨迹
   */
  update(candidates: TrackedFormant[], isSpeech: boolean): TrackedFormant[] {
    if (!isSpeech) {
      // 静音段冻结轨迹，仅累计缺失
      for (const t of this.tracks) t.missCount++;
      this.prune();
      return this.snapshot();
    }

    const assigned = new Set<number>();
    // 按轨迹频率从低到高做贪心最近邻关联
    const orderedTracks = this.tracks
      .map((t, i) => ({ t, i }))
      .sort((a, b) => a.t.freq - b.t.freq);

    for (const { t } of orderedTracks) {
      let best = -1;
      let bestDist = Infinity;
      for (let c = 0; c < candidates.length; c++) {
        if (assigned.has(c)) continue;
        const rel = Math.abs(candidates[c].freq - t.freq) / t.freq;
        if (rel < bestDist) {
          bestDist = rel;
          best = c;
        }
      }
      if (best >= 0 && bestDist <= this.gatePct) {
        const cand = candidates[best];
        assigned.add(best);
        t.freq = (1 - this.alpha) * t.freq + this.alpha * cand.freq;
        t.bandwidth = (1 - this.alpha) * t.bandwidth + this.alpha * cand.bandwidth;
        t.missCount = 0;
        t.age++;
      } else {
        t.missCount++;
      }
    }

    // 未分配候选 → 诞生新轨迹（先以候选值初始化，不参与本帧平滑输出）
    for (let c = 0; c < candidates.length; c++) {
      if (assigned.has(c)) continue;
      if (this.tracks.length >= this.maxTracks) break;
      this.tracks.push({ freq: candidates[c].freq, bandwidth: candidates[c].bandwidth, missCount: 0, age: 0 });
    }

    this.prune();
    return this.snapshot();
  }

  private prune(): void {
    this.tracks = this.tracks.filter((t) => t.missCount <= this.maxMiss);
  }

  private snapshot(): TrackedFormant[] {
    return this.tracks
      .filter((t) => t.age > 0 || t.missCount === 0)
      .map((t) => ({ freq: t.freq, bandwidth: t.bandwidth }))
      .sort((a, b) => a.freq - b.freq)
      .slice(0, this.maxTracks);
  }

  reset(): void {
    this.tracks = [];
  }
}
