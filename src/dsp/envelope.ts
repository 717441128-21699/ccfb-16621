/**
 * 频谱工具：FFT 幅度谱，供共振峰页面绘制
 */

import { fftRadix2 } from './fft.ts';

export interface EnvelopePoint {
  freq: number;
  magnitudeDb: number;
}

export function fftMagnitudeDb(frame: Float64Array, sampleRate: number): EnvelopePoint[] {
  const N = frame.length;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  re.set(frame);
  fftRadix2(re, im);
  const bins = N / 2;
  const out: EnvelopePoint[] = [];
  for (let k = 0; k <= bins; k++) {
    const mag = Math.hypot(re[k], im[k]) / N;
    out.push({
      freq: (k * sampleRate) / N,
      magnitudeDb: 20 * Math.log10(Math.max(mag, 1e-8)),
    });
  }
  return out;
}
