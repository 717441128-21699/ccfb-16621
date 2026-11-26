/** DSP 算法单元测试：FFT 自洽、LPC 重建已知极点、降噪、OLA 重建、基音 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { fftRadix2, ifftRadix2 } from '../src/dsp/fft.ts';
import { lpcAnalyze, autocorrelation } from '../src/dsp/lpc.ts';
import { findFormants, warpAllPoleFilter, polynomialRoots } from '../src/dsp/formants.ts';
import { MultibandWiener } from '../src/dsp/noise.ts';
import { FrameFramer, OlaSynthesizer } from '../src/dsp/framing.ts';
import { estimatePitch } from '../src/dsp/pitch.ts';
import { polesToCoefficients } from '../src/dsp/simulator.ts';

const SR = 16000;

test('FFT→IFFT 还原原信号', () => {
  const N = 256;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = Math.sin((2 * Math.PI * 7 * i) / N) + 0.5 * Math.cos((2 * Math.PI * 13 * i) / N);
  const orig = Float64Array.from(re);
  fftRadix2(re, im);
  ifftRadix2(re, im);
  for (let i = 0; i < N; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-10);
});

test('LPC 求根能恢复已知共振峰（误差 <4%）', () => {
  const truth = [
    { f: 730, bw: 90 },
    { f: 1090, bw: 110 },
    { f: 2450, bw: 160 },
    { f: 3400, bw: 200 },
  ];
  const a = polesToCoefficients(truth, SR);
  const found = findFormants(a, SR, 4);
  assert.equal(found.length, 4);
  truth.forEach((t, i) => {
    const err = Math.abs(found[i].f - t.f) / t.f;
    assert.ok(err < 0.04, `F${i + 1} 真值 ${t.f} 测得 ${found[i].f.toFixed(1)} 误差 ${(err * 100).toFixed(2)}%`);
  });
});

test('Durand-Kerner 求根：根的频率/半径与理论极点吻合，且共轭对称', () => {
  const truth = [
    { f: 500, bw: 100 },
    { f: 1500, bw: 140 },
  ];
  const a = polesToCoefficients(truth, SR);
  const coef = new Float64Array(a.length + 1);
  coef[0] = 1;
  coef.set(a, 1);
  const roots = polynomialRoots(coef);
  assert.equal(roots.length, 4);

  // 共轭对称：根应两两成共轭对
  const upper = roots.filter((r) => r.im > 0);
  const lower = roots.filter((r) => r.im < 0);
  assert.equal(upper.length, 2);
  assert.equal(lower.length, 2);
  for (const u of upper) {
    const partner = lower.find((l) => Math.abs(l.re - u.re) < 1e-9 && Math.abs(l.im + u.im) < 1e-9);
    assert.ok(partner, '每个上半平面根应有共轭伙伴');
  }

  // 上半平面根的频率与理论共振峰吻合（<2%）
  const gotFreq = upper.map((r) => (Math.atan2(r.im, r.re) * SR) / (2 * Math.PI)).sort((x, y) => x - y);
  const wantFreq = truth.map((t) => t.f).sort((x, y) => x - y);
  gotFreq.forEach((g, i) => {
    assert.ok(Math.abs(g - wantFreq[i]) / wantFreq[i] < 0.02, `频率 ${g} vs ${wantFreq[i]}`);
  });

  // 所有根在单位圆内（稳定极点）
  for (const r of roots) assert.ok(Math.hypot(r.re, r.im) < 1, '极点应在单位圆内');
});

test('warpAllPoleFilter 在空气环境（q=1）下基本保持原频率', () => {
  const truth = [
    { f: 800, bw: 90 },
    { f: 1200, bw: 110 },
  ];
  const a = polesToCoefficients(truth, SR);
  const out = warpAllPoleFilter(a, 1, SR, { he: 0, o2: 0.21, n2: 0.79 }, 0);
  const restored = findFormants(out.a, SR, 2);
  truth.forEach((t, i) => {
    assert.ok(Math.abs(restored[i].f - t.f) / t.f < 0.03);
  });
});

test('多频带维纳：噪声-only 帧被压制，强语音帧对应频带增益回升', () => {
  const N = 256;
  const wnr = new MultibandWiener({ fftSize: N, sampleRate: SR });
  // 先喂 15 帧纯噪声建立稳定噪声估计
  for (let k = 0; k < 15; k++) {
    const noise = new Float64Array(N).map(() => (Math.random() - 0.5) * 0.2);
    wnr.process(noise);
  }
  const noiseGains = [...wnr.lastBandGains];
  // 纯噪声帧：高频带增益应被压到较低水平（低频带受共振峰保护地板约束）
  const highBandNoiseGain = noiseGains.slice(2).reduce((s, v) => s + v, 0) / (noiseGains.length - 2);
  assert.ok(highBandNoiseGain < 0.4, `噪声帧高频带增益 ${highBandNoiseGain} 应较低`);

  // 强语音帧：高能量正弦 + 少量噪声
  const speech = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    speech[i] = 0.8 * Math.sin((2 * Math.PI * 600 * i) / SR) + (Math.random() - 0.5) * 0.05;
  }
  wnr.process(speech);
  const speechGains = [...wnr.lastBandGains];
  // 600 Hz 落在第 1~2 个 mel 带，语音带增益应明显高于噪声帧对应带
  const speechLowGain = Math.max(speechGains[0], speechGains[1]);
  const noiseLowGain = Math.max(noiseGains[0], noiseGains[1]);
  assert.ok(speechLowGain > noiseLowGain, `语音带增益 ${speechLowGain} 应高于噪声帧 ${noiseLowGain}`);
  // 语音带保留一半以上能量（不被抹掉）
  assert.ok(speechLowGain >= 0.5, `语音主体保留比 ${speechLowGain} 应≥0.5`);
});

test('分帧 + OLA 恒等系统可近似重建输入（能量守恒量级）', () => {
  const frameSize = 400;
  const hop = 160;
  const framer = new FrameFramer({ frameSize, hopSize: hop });
  const ola = new OlaSynthesizer({ frameSize, hopSize: hop });
  const input = new Float32Array(4000);
  for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 220 * i) / SR);
  const frames = [...framer.push(input), ...framer.flush()];
  const chunks: Float32Array[] = [];
  for (const f of frames) {
    const win = new Float64Array(f.length);
    for (let i = 0; i < f.length; i++) win[i] = f[i] * (0.5 * (1 - Math.cos((2 * Math.PI * i) / (f.length - 1))));
    chunks.push(ola.addFrame(win));
  }
  chunks.push(ola.flush());
  const out = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  // 比较中部稳定区间
  let inE = 0;
  let outE = 0;
  for (let i = 800; i < 3200; i++) {
    inE += input[i] ** 2;
    outE += out[i] ** 2;
  }
  const ratio = outE / inE;
  assert.ok(ratio > 0.8 && ratio < 1.2, `能量比 ${ratio}`);
});

test('自相关基音检测对 120 Hz 合成声门信号误差 <2%', () => {
  const N = 640;
  const f0 = 120;
  const frame = new Float64Array(N);
  const period = SR / f0;
  for (let i = 0; i < N; i++) {
    const t = i % period;
    frame[i] = t < 0.6 * period ? 3 * (t / (0.6 * period)) ** 2 - 2 * (t / (0.6 * period)) ** 3 : 0;
  }
  const p = estimatePitch(frame, SR);
  assert.ok(p.f0 > 0);
  assert.ok(Math.abs(p.f0 - f0) / f0 < 0.02, `测得 ${p.f0}`);
});

test('自相关 r(0) 等于帧能量', () => {
  const frame = new Float64Array(128).map((_, i) => Math.sin(i * 0.2));
  const r = autocorrelation(frame, 8);
  let e = 0;
  for (const v of frame) e += v * v;
  assert.ok(Math.abs(r[0] - e) < 1e-10);
  void lpcAnalyze;
});
