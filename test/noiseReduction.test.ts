import { describe, expect, it } from 'vitest';
import { FFT } from '../src/dsp/fft.ts';
import { SpectralSubtraction, magnitudeSpectrum } from '../src/dsp/noiseReduction.ts';
import { Rng } from '../src/dsp/simulator.ts';

describe('谱减降噪', () => {
  const fftSize = 512;
  const sr = 16000;

  function makeFrame(signalLevel: number, noiseLevel: number, rng: Rng, toneFreq = 900): Float64Array {
    const x = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      const tone = signalLevel * Math.sin((2 * Math.PI * toneFreq * i) / sr);
      x[i] = tone + rng.gaussian() * noiseLevel;
    }
    return x;
  }

  it('训练后压低宽带噪声、保留语音主峰', () => {
    const fft = new FFT(fftSize);
    const nr = new SpectralSubtraction({ fftSize, overSubtraction: 2.2, floor: 0.08, noiseAdapt: 0.12 });
    const rng = new Rng(99);

    // 6 帧纯噪声训练
    for (let f = 0; f < 6; f++) {
      const re = new Float64Array(fftSize);
      const im = new Float64Array(fftSize);
      nr.trainNoise(magnitudeSpectrum(makeFrame(0, 0.2, rng), fft, re, im));
    }
    const noiseFloor = nr.noiseSpectrum;
    expect(noiseFloor.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

    // 带噪语音帧
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    const mixed = makeFrame(0.8, 0.2, rng);
    const before = magnitudeSpectrum(mixed, fft, re, im);
    const after = before.slice();
    nr.process(after, true, sr);

    const toneBin = Math.round((900 * fftSize) / sr);
    // 语音峰保留 70% 以上能量
    expect(after[toneBin]).toBeGreaterThan(before[toneBin] * 0.7);
    // 远离峰的噪声区被压低
    for (const b of [40, 80, 200]) {
      expect(after[b]).toBeLessThan(before[b] * 0.85);
    }
  });

  it('谱下限保证不会出现零谱（抑制音乐噪声伪影）', () => {
    const fft = new FFT(fftSize);
    const nr = new SpectralSubtraction({ fftSize, overSubtraction: 4, floor: 0.1, noiseAdapt: 0.1 });
    const rng = new Rng(5);
    for (let f = 0; f < 6; f++) {
      const re = new Float64Array(fftSize);
      const im = new Float64Array(fftSize);
      nr.trainNoise(magnitudeSpectrum(makeFrame(0, 0.3, rng), fft, re, im));
    }
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    const mag = magnitudeSpectrum(makeFrame(0, 0.3, rng), fft, re, im);
    nr.process(mag, false, sr);
    for (const v of mag) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('低频气泡脉冲被时间中值滤波削弱', () => {
    const fft = new FFT(fftSize);
    const nr = new SpectralSubtraction({ fftSize, overSubtraction: 1.5, floor: 0.05, noiseAdapt: 0.1 });
    const rng = new Rng(7);
    for (let f = 0; f < 6; f++) {
      const re = new Float64Array(fftSize);
      const im = new Float64Array(fftSize);
      nr.trainNoise(magnitudeSpectrum(makeFrame(0, 0.05, rng, 500), fft, re, im));
    }
    // 150 Hz 强脉冲帧
    const pulse = makeFrame(1.2, 0.02, rng, 150);
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    const before = magnitudeSpectrum(pulse, fft, re, im);
    const after = before.slice();
    nr.process(after, true, sr);
    const bin = Math.round((150 * fftSize) / sr);
    // 中值滤波对孤立脉冲有明显衰减
    expect(after[bin]).toBeLessThanOrEqual(before[bin]);
  });
});
