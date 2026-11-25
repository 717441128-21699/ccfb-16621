/**
 * 潜水日志模型 —— 饱和潜水任务的深度计划、各阶段氦氧配比与事件记录。
 * 数据为演示任务自编（南海某平台饱和潜水支持船，45 分钟模拟任务时间轴）。
 * 校正系数随当前深度对应组分实时计算，加压/减压过程连续变化。
 */
import {
  correctionFactor,
  chamberTempKelvin,
  depthToPressure,
  partialPressureO2,
  type GasMix,
} from '../dsp/physics.ts';

export interface Diver {
  id: string;
  name: string;
  role: string;
  /** 平均基频 Hz */
  f0Mean: number;
  /** 自然语调抖动范围 ±Hz */
  f0Jitter: number;
  /** 个人声道尺度因子（1 = 标准） */
  vocalTractScale: number;
}

/** 自编潜水员嗓音档案 */
export const DIVERS: Diver[] = [
  { id: 'D01', name: '陈海生', role: '主潜水员', f0Mean: 118, f0Jitter: 9, vocalTractScale: 1.02 },
  { id: 'D02', name: '林伟东', role: '副潜水员', f0Mean: 135, f0Jitter: 11, vocalTractScale: 0.98 },
  { id: 'D03', name: '黄志强', role: '钟工', f0Mean: 98, f0Jitter: 7, vocalTractScale: 1.08 },
  { id: 'D04', name: '周雅琴', role: '预备潜水员', f0Mean: 205, f0Jitter: 16, vocalTractScale: 0.9 },
];

export interface DivePhase {
  name: string;
  startSec: number;
  endSec: number;
  depthFrom: number;
  depthTo: number;
  mix: GasMix;
  note: string;
}

/** 任务时间轴（秒）。各阶段配比保证氧分压处于 0.4~1.6 bar 安全窗内 */
export const DIVE_PHASES: DivePhase[] = [
  {
    name: '居住舱加压',
    startSec: 0,
    endSec: 120,
    depthFrom: 0,
    depthTo: 60,
    mix: { he: 0.6, o2: 0.16, n2: 0.24 },
    note: '舱内加压至 60 msw，初始混合气',
  },
  {
    name: '继续加压',
    startSec: 120,
    endSec: 480,
    depthFrom: 60,
    depthTo: 120,
    mix: { he: 0.78, o2: 0.14, n2: 0.08 },
    note: '提高氦比例，降低氮麻醉风险',
  },
  {
    name: '饱和居住深度',
    startSec: 480,
    endSec: 840,
    depthFrom: 120,
    depthTo: 180,
    mix: { he: 0.9, o2: 0.08, n2: 0.02 },
    note: '到达 180 msw 饱和深度，氧分压约 1.5 bar',
  },
  {
    name: '钟外巡潜作业',
    startSec: 840,
    endSec: 1380,
    depthFrom: 180,
    depthTo: 180,
    mix: { he: 0.9, o2: 0.08, n2: 0.02 },
    note: '海底法兰检修，通话最密集阶段',
  },
  {
    name: '深潜 excursion',
    startSec: 1380,
    endSec: 1740,
    depthFrom: 180,
    depthTo: 200,
    mix: { he: 0.93, o2: 0.05, n2: 0.02 },
    note: '下潜至 200 msw 最大作业深度，氧分压约 1.06 bar',
  },
  {
    name: '返回居住深度',
    startSec: 1740,
    endSec: 2040,
    depthFrom: 200,
    depthTo: 180,
    mix: { he: 0.9, o2: 0.08, n2: 0.02 },
    note: '回收潜水钟',
  },
  {
    name: '减压第一站',
    startSec: 2040,
    endSec: 2400,
    depthFrom: 180,
    depthTo: 60,
    mix: { he: 0.82, o2: 0.12, n2: 0.06 },
    note: '按减压表减速上升',
  },
  {
    name: '减压末站',
    startSec: 2400,
    endSec: 2700,
    depthFrom: 60,
    depthTo: 15,
    mix: { he: 0.55, o2: 0.21, n2: 0.24 },
    note: '浅深度切换富氧配方',
  },
];

export interface DiveEvent {
  timeSec: number;
  depth: number;
  level: 'info' | 'warn' | 'alarm';
  text: string;
}

export const DIVE_EVENTS: DiveEvent[] = [
  { timeSec: 0, depth: 0, level: 'info', text: '任务开始，居住舱加压' },
  { timeSec: 120, depth: 60, level: 'info', text: '60 msw 稳压，切换 He60 配方' },
  { timeSec: 480, depth: 120, level: 'info', text: '120 msw，氦语音明显，校正器在线' },
  { timeSec: 840, depth: 180, level: 'info', text: '到达饱和居住深度 180 msw' },
  { timeSec: 990, depth: 180, level: 'warn', text: 'D02 面罩呼吸阀噪声升高，降噪模块自适应' },
  { timeSec: 1380, depth: 180, level: 'info', text: '开始深潜 excursion 至 200 msw' },
  { timeSec: 1560, depth: 200, level: 'alarm', text: '气泡声干扰增强，监督切换备用频道' },
  { timeSec: 2040, depth: 180, level: 'info', text: '减压程序启动' },
  { timeSec: 2400, depth: 60, level: 'info', text: '减压第一站结束' },
  { timeSec: 2700, depth: 15, level: 'info', text: '任务结束，准备出舱' },
];

export interface DepthSample {
  timeSec: number;
  depth: number;
  pressure: number;
  mix: GasMix;
  /** c_air / c_mix 校正系数 */
  correction: number;
  ppO2: number;
  phase: DivePhase;
}

export class DiveLog {
  /** 模拟时钟，秒 */
  timeSec = 0;
  readonly totalSec = 2700;
  readonly chamberCelsius = 31;
  readonly entries: DiveEvent[] = DIVE_EVENTS.map((e) => ({ ...e }));

  get phase(): DivePhase {
    return this.phaseAt(this.timeSec);
  }

  phaseAt(t: number): DivePhase {
    const clamped = Math.min(Math.max(t, 0), this.totalSec);
    return (
      DIVE_PHASES.find((p) => clamped >= p.startSec && clamped < p.endSec) ??
      DIVE_PHASES[DIVE_PHASES.length - 1]
    );
  }

  depthAt(t: number): number {
    const p = this.phaseAt(t);
    const span = Math.max(p.endSec - p.startSec, 1);
    const k = Math.min(Math.max((t - p.startSec) / span, 0), 1);
    return p.depthFrom + (p.depthTo - p.depthFrom) * k;
  }

  mixAt(t: number): GasMix {
    return this.phaseAt(t).mix;
  }

  sampleAt(t: number): DepthSample {
    const phase = this.phaseAt(t);
    const depth = this.depthAt(t);
    const mix = phase.mix;
    return {
      timeSec: t,
      depth,
      pressure: depthToPressure(depth),
      mix,
      correction: correctionFactor(mix, chamberTempKelvin(this.chamberCelsius)),
      ppO2: partialPressureO2(mix, depth),
      phase,
    };
  }

  sample(): DepthSample {
    return this.sampleAt(this.timeSec);
  }

  tick(dtSec: number): void {
    this.timeSec = Math.min(this.timeSec + dtSec, this.totalSec);
  }

  seek(t: number): void {
    this.timeSec = Math.min(Math.max(t, 0), this.totalSec);
  }

  /** 通话记录追加 */
  logEvent(text: string, level: DiveEvent['level'] = 'info'): void {
    this.entries.push({ timeSec: this.timeSec, depth: this.depthAt(this.timeSec), level, text });
  }

  /** 全时间轴采样，用于深度曲线图 */
  profileSamples(stepSec = 30): DepthSample[] {
    const out: DepthSample[] = [];
    for (let t = 0; t <= this.totalSec; t += stepSec) out.push(this.sampleAt(t));
    return out;
  }
}

export function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
