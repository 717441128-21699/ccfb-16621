import { describe, expect, it } from 'vitest';
import { forwardWarp, inverseWarp, resampleMagnitude, warpBinMap, DEFAULT_BETA, DEFAULT_F_REF } from '../src/dsp/warping.ts';

const params = (s: number) => ({ s, beta: DEFAULT_BETA, fRef: DEFAULT_F_REF });

describe('共振峰频率搬移', () => {
  it('正反映射互逆', () => {
    for (const s of [0.5, 0.65, 0.8, 0.95]) {
      const p = params(s);
      for (const f of [200, 400, 800, 1500, 2500, 3500]) {
        const he = forwardWarp(f, p);
        const back = inverseWarp(he, p);
        expect(back).toBeCloseTo(f, 4);
      }
    }
  });

  it('高频退化为线性 1/s，低频因舱壁/面罩项位移更大', () => {
    const p = params(0.6);
    const high = forwardWarp(4000, p);
    // beta 指数项在 4 kHz 已衰减到可忽略，与纯线性 1/s 相差 <0.5%
    expect(Math.abs(high - 4000 / 0.6) / (4000 / 0.6)).toBeLessThan(0.005);
    const low = forwardWarp(300, p);
    expect(low).toBeGreaterThan(300 / 0.6); // 低频额外上移
  });

  it('s=1 时映射为恒等', () => {
    const p = params(1);
    for (const f of [100, 500, 2000]) expect(forwardWarp(f, p)).toBeCloseTo(f, 6);
    expect(inverseWarp(777, p)).toBeCloseTo(777, 6);
  });

  it('bin 映射单调不减，谱重采样保持长度与能量量级', () => {
    const fftSize = 512;
    const sr = 16000;
    const map = warpBinMap(fftSize, sr, params(0.6));
    for (let k = 1; k < map.length; k++) expect(map[k]).toBeGreaterThanOrEqual(map[k - 1]);
    const mag = new Float64Array(fftSize / 2).fill(1).map((_, i) => 1 + 0.01 * i);
    const out = resampleMagnitude(mag, map, sr, fftSize);
    expect(out).toHaveLength(fftSize / 2);
    expect(out[0]).toBeGreaterThan(0);
  });
});
