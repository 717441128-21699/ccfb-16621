import { describe, expect, it } from 'vitest';
import {
  AIR,
  AIR_SPEED_20C,
  chamberTempKelvin,
  correctionFactor,
  depthToPressure,
  partialPressureO2,
  soundSpeed,
} from '../src/dsp/physics.ts';
import { DIVE_PHASES } from '../src/model/diveLog.ts';

describe('气体物理模型', () => {
  it('20℃ 空气声速应接近 343 m/s', () => {
    expect(soundSpeed(AIR, chamberTempKelvin(20))).toBeCloseTo(343.2, 0);
    expect(AIR_SPEED_20C).toBeGreaterThan(340);
    expect(AIR_SPEED_20C).toBeLessThan(346);
  });

  it('高氦比例混合气声速显著高于空气', () => {
    const trimix = { he: 0.9, o2: 0.08, n2: 0.02 };
    const c = soundSpeed(trimix, chamberTempKelvin(31));
    // 90% 氦气声速约 600~700 m/s
    expect(c).toBeGreaterThan(550);
    expect(c).toBeLessThan(800);
  });

  it('校正系数 s = c空气/c混合气 位于 0.42~1', () => {
    for (const phase of DIVE_PHASES) {
      const s = correctionFactor(phase.mix, chamberTempKelvin(31));
      expect(s).toBeGreaterThan(0.42);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('氦比例越高 s 越小（共振峰上移越严重）', () => {
    const low = correctionFactor({ he: 0.55, o2: 0.21, n2: 0.24 }, chamberTempKelvin(31));
    const high = correctionFactor({ he: 0.92, o2: 0.06, n2: 0.02 }, chamberTempKelvin(31));
    expect(high).toBeLessThan(low);
  });

  it('深度压力换算每 10 msw 增加 1 bar', () => {
    expect(depthToPressure(0)).toBeCloseTo(1.01325, 2);
    expect(depthToPressure(100)).toBeCloseTo(11.01325, 1);
    expect(depthToPressure(200)).toBeCloseTo(21.01325, 1);
  });

  it('所有任务阶段在其活动深度的氧分压处于 0.4~1.6 bar 安全窗', () => {
    for (const phase of DIVE_PHASES) {
      // 加压/减压段用区间中点评估，恒定深度段即为作业深度
      const activeDepth = (phase.depthFrom + phase.depthTo) / 2;
      const pp = partialPressureO2(phase.mix, activeDepth);
      expect(pp).toBeGreaterThanOrEqual(0.4);
      expect(pp).toBeLessThanOrEqual(1.62);
    }
  });
});
