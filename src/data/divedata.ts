/**
 * 内置模拟数据：潜水日志、气体配比、潜水员档案、清晰度词表
 * （全部为虚构演示数据，单位与真实饱和潜水作业一致）
 */

import type { GasMix } from '../dsp/physics.ts';
import { SIM_DIVERS } from '../dsp/simulator.ts';

export interface DiveLogPoint {
  /** 作业经过时间 (min) */
  tMin: number;
  /** 舱压对应深度 (mSW) */
  depthM: number;
  /** 该时刻舱内氦氧配比 */
  mix: GasMix;
  /** 阶段标注 */
  phase: '加压' | '巡潜' | '停留' | '减压';
  note?: string;
}

/**
 * 一次 180 m 饱和潜水的舱压曲线（节选 0~360 min）：
 * 加压 → 180 m 巡潜 → 逐级减压停留。配比按氧分压 0.4 bar 上限反算。
 */
export const DIVE_LOG: DiveLogPoint[] = [
  { tMin: 0, depthM: 0, mix: { he: 0, o2: 0.21, n2: 0.79 }, phase: '加压', note: '舱内初始空气' },
  { tMin: 15, depthM: 30, mix: { he: 0.7, o2: 0.12, n2: 0.18 }, phase: '加压' },
  { tMin: 35, depthM: 80, mix: { he: 0.88, o2: 0.05, n2: 0.07 }, phase: '加压' },
  { tMin: 60, depthM: 130, mix: { he: 0.93, o2: 0.032, n2: 0.038 }, phase: '加压' },
  { tMin: 85, depthM: 180, mix: { he: 0.956, o2: 0.021, n2: 0.023 }, phase: '巡潜', note: '到达工作深度，ppO2≈0.40 bar' },
  { tMin: 150, depthM: 180, mix: { he: 0.956, o2: 0.021, n2: 0.023 }, phase: '停留' },
  { tMin: 180, depthM: 150, mix: { he: 0.948, o2: 0.025, n2: 0.027 }, phase: '减压' },
  { tMin: 220, depthM: 120, mix: { he: 0.937, o2: 0.031, n2: 0.032 }, phase: '停留' },
  { tMin: 260, depthM: 90, mix: { he: 0.917, o2: 0.04, n2: 0.043 }, phase: '减压' },
  { tMin: 300, depthM: 60, mix: { he: 0.879, o2: 0.057, n2: 0.064 }, phase: '停留' },
  { tMin: 330, depthM: 30, mix: { he: 0.78, o2: 0.1, n2: 0.12 }, phase: '减压' },
  { tMin: 360, depthM: 0, mix: { he: 0, o2: 0.21, n2: 0.79 }, phase: '减压', note: '回到常压' },
];

export interface DiveProfileMeta {
  diveId: string;
  date: string;
  bellDepthMax: number;
  bottomTimeMin: number;
  divers: typeof SIM_DIVERS;
}

export const DIVE_META: DiveProfileMeta = {
  diveId: 'SAT-2026-1127-03',
  date: '2026-11-27',
  bellDepthMax: 180,
  bottomTimeMin: 65,
  divers: SIM_DIVERS,
};

/**
 * 由日志线性插值求任意时刻的深度与配比（加压/减压全程系数自动跟随）。
 */
export function sampleDiveLog(tMin: number): { depthM: number; mix: GasMix } {
  const log = DIVE_LOG;
  if (tMin <= log[0].tMin) return { depthM: log[0].depthM, mix: { ...log[0].mix } };
  const last = log[log.length - 1];
  if (tMin >= last.tMin) return { depthM: last.depthM, mix: { ...last.mix } };

  for (let i = 0; i < log.length - 1; i++) {
    const a = log[i];
    const b = log[i + 1];
    if (tMin >= a.tMin && tMin <= b.tMin) {
      const w = (tMin - a.tMin) / (b.tMin - a.tMin);
      return {
        depthM: a.depthM + (b.depthM - a.depthM) * w,
        mix: {
          he: a.mix.he + (b.mix.he - a.mix.he) * w,
          o2: a.mix.o2 + (b.mix.o2 - a.mix.o2) * w,
          n2: a.mix.n2 + (b.mix.n2 - a.mix.n2) * w,
        },
      };
    }
  }
  return { depthM: last.depthM, mix: { ...last.mix } };
}

/**
 * 汉语清晰度测试（押韵/Rhyme 测试风格）词表：
 * 每组词仅关键字位不同，监督听辨打分。覆盖 a/i/u/e/o 与常用音节。
 */
export interface IntelligibilitySet {
  id: string;
  category: string;
  words: string[];
}

export const INTELLIGIBILITY_WORDS: IntelligibilitySet[] = [
  { id: 's1', category: '元音对比', words: ['妈', '眯', '摸', '咩', '吗'] },
  { id: 's2', category: '声母对比', words: ['搬', '攀', '瞒', '番', '担'] },
  { id: 's3', category: '鼻韵尾', words: ['班', '帮', '奔', '崩', '宾'] },
  { id: 's4', category: '作业指令', words: ['供气', '停气', '上升', '下潜', '待命'] },
  { id: 's5', category: '数字通讯', words: ['一动', '两动', '三动', '四动', '五动'] },
  { id: 's6', category: '故障报告', words: ['漏气', '进水', '报警', '正常', '换人'] },
];

/** 完整测试音节序列（模拟器逐字发声用，取元音字） */
export const TEST_UTTERANCE = 'aiueoaieou';
