/** 物理模型测试：声速、弯折系数、深度/压力、日志插值 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  soundSpeed,
  airSoundSpeed,
  pressureAtDepth,
  formantShiftFactor,
  correctFrequency,
  uniformShiftRatio,
  oxygenPartialPressure,
  AIR_MIX,
} from '../src/dsp/physics.ts';
import { sampleDiveLog, DIVE_LOG } from '../src/data/divedata.ts';

test('37℃ 空气中声速约 353 m/s', () => {
  const c = airSoundSpeed();
  assert.ok(c > 350 && c < 357, `实际 ${c}`);
  assert.ok(Math.abs(soundSpeed(AIR_MIX) - c) < 1e-9);
});

test('95.6% He + 2.1% O2 在 180m 深度声速显著高于空气', () => {
  const mix = { he: 0.956, o2: 0.021, n2: 0.023 };
  const c = soundSpeed(mix);
  assert.ok(c > 900 && c < 1100, `实际 ${c}`);
  const q = uniformShiftRatio(mix);
  assert.ok(q > 2.5 && q < 3.1, `q0=${q}`);
});

test('深度与绝对压力换算', () => {
  assert.equal(pressureAtDepth(0), 1);
  assert.ok(Math.abs(pressureAtDepth(180) - 19) < 1e-12);
  assert.ok(Math.abs(oxygenPartialPressure({ he: 0.956, o2: 0.021, n2: 0.023 }, 180) - 0.399) < 0.01);
});

test('弯折系数 q(F) 高频趋近 q0、低频因舱壁效应更大', () => {
  const mix = { he: 0.956, o2: 0.021, n2: 0.023 };
  const q0 = uniformShiftRatio(mix);
  const qLow = formantShiftFactor(300, mix, 180);
  const qHigh = formantShiftFactor(3000, mix, 180);
  assert.ok(qLow > qHigh, `低频 ${qLow} 应大于高频 ${qHigh}`);
  assert.ok(Math.abs(qHigh - q0) / q0 < 0.06, '高频应趋近均匀 q0');
});

test('correctFrequency 是 formantShiftFactor 的逆', () => {
  const mix = { he: 0.9, o2: 0.05, n2: 0.05 };
  for (const fAir of [250, 500, 1000, 2000, 3000]) {
    const fHe = formantShiftFactor(fAir, mix, 120) * fAir;
    const back = correctFrequency(fHe, mix, 120);
    assert.ok(Math.abs(back - fAir) / fAir < 0.02, `F=${fAir} 往返误差 ${back}`);
  }
});

test('潜水日志插值在控制点精确、在区间内单调', () => {
  const p85 = sampleDiveLog(85);
  assert.equal(p85.depthM, 180);
  const mid = sampleDiveLog(72.5);
  assert.ok(mid.depthM > 130 && mid.depthM < 180);
  assert.ok(Math.abs(mid.mix.he + mid.mix.o2 + mid.mix.n2 - 1) < 1e-9);
  assert.equal(DIVE_LOG[0].tMin, 0);
  assert.equal(DIVE_LOG[DIVE_LOG.length - 1].depthM, 0);
});
