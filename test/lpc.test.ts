import { describe, expect, it } from 'vitest';
import { FFT, hannWindow } from '../src/dsp/fft.ts';
import { autocorrelation, levinsonDurbin, recommendedLpcOrder } from '../src/dsp/lpc.ts';
import { pickFormants, polesFromLpc } from '../src/dsp/formants.ts';

describe('FFT', () => {
  it('正逆变换还原信号', () => {
    const n = 256;
    const fft = new FFT(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 7 * i) / n) + 0.5 * Math.cos((2 * Math.PI * 13 * i) / n);
    const orig = re.slice();
    fft.transform(re, im);
    fft.inverse(re, im);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(orig[i], 9);
      expect(im[i]).toBeCloseTo(0, 9);
    }
  });

  it('单频正弦能量集中在对应 bin', () => {
    const n = 512;
    const fft = new FFT(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const k0 = 16;
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k0 * i) / n);
    fft.transform(re, im);
    let maxK = 0;
    let maxV = -1;
    for (let k = 0; k < n / 2; k++) {
      const v = Math.hypot(re[k], im[k]);
      if (v > maxV) {
        maxV = v;
        maxK = k;
      }
    }
    expect(maxK).toBe(k0);
  });

  it('Hann 窗 50% 重叠相加满足 COLA（重叠区窗权值和恒定）', () => {
    const n = 256;
    const w = hannWindow(n);
    // OLA 的归一化条件是窗函数（非平方）在重叠区之和恒定
    const sum = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      sum[i] += w[i];
      sum[i + n / 2] += w[i];
    }
    // 两帧重叠区 [n/2, n) 内窗权值和应近似常数（周期性 Hann 的 COLA 常数=1）
    const ref = sum[n / 2];
    expect(ref).toBeGreaterThan(0);
    for (let i = n / 2 + 1; i < n; i++) {
      expect(Math.abs(sum[i] - ref) / ref).toBeLessThan(1e-9);
    }
  });
});

describe('LPC 全极点建模', () => {
  it('推荐阶数随采样率增长（每 kHz 两阶 +2）', () => {
    expect(recommendedLpcOrder(8000)).toBe(18);
    expect(recommendedLpcOrder(16000)).toBe(34);
  });

  it('对已知共振峰合成信号稳定求根并回收峰位', () => {
    const sr = 16000;
    const n = 512;
    // 两级共振峰 IIR：700 Hz / 1200 Hz
    const formants: Array<[number, number]> = [
      [700, 90],
      [1200, 120],
    ];
    let a = new Float64Array([1]);
    for (const [f, bw] of formants) {
      const w = (2 * Math.PI * f) / sr;
      const r = Math.exp(-Math.PI * bw / sr);
      const c1 = -2 * r * Math.cos(w);
      const c2 = r * r;
      const next = new Float64Array(a.length + 2);
      for (let i = 0; i < a.length; i++) {
        next[i] += a[i];
        next[i + 1] += a[i] * c1;
        next[i + 2] += a[i] * c2;
      }
      a = next;
    }
    // 脉冲激励
    const x = new Float64Array(n);
    const state = new Float64Array(a.length - 1);
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296 - 0.5;
    };
    for (let i = 0; i < n; i++) {
      const e = i % 83 === 0 ? 1 : rand() * 0.05;
      let y = e;
      for (let k = 1; k < a.length; k++) y -= a[k] * state[k - 1];
      for (let k = state.length; k > 1; k--) state[k - 1] = state[k - 2];
      state[0] = y;
      x[i] = y;
    }

    const order = 12;
    const r = autocorrelation(x, order);
    const lev = levinsonDurbin(r, order);
    expect(lev.stable).toBe(true);
    const poles = polesFromLpc(lev.a, sr, sr / 2);
    const freqs = poles.map((p) => p.freq);
    expect(freqs.some((f) => Math.abs(f - 700) < 90)).toBe(true);
    expect(freqs.some((f) => Math.abs(f - 1200) < 130)).toBe(true);

    const fft = new FFT(512);
    const picked = pickFormants(lev.a, Math.sqrt(lev.error), sr, fft, 4);
    expect(picked.length).toBeGreaterThan(0);
    const f1 = picked[0].freq;
    expect(Math.abs(f1 - 700)).toBeLessThan(120);
  });
});
