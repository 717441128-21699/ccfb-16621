/** 分帧 / 叠接相加 (OLA) 工具 */

import { makeHann } from './windows.ts';

export interface FramingConfig {
  frameSize: number;
  hopSize: number;
  sampleRate: number;
}

/**
 * 流式分帧器：喂入任意长度样本，按 hop 吐出完整帧；
 * 不足一帧时内部缓存，flush 时补零输出尾帧。
 */
export class FrameFramer {
  readonly frameSize: number;
  readonly hopSize: number;
  private buf: number[] = [];

  constructor(cfg: Pick<FramingConfig, 'frameSize' | 'hopSize'>) {
    this.frameSize = cfg.frameSize;
    this.hopSize = cfg.hopSize;
  }

  push(samples: Float32Array | Float64Array | number[]): Float64Array[] {
    for (let i = 0; i < samples.length; i++) this.buf.push(samples[i]);
    const frames: Float64Array[] = [];
    while (this.buf.length >= this.frameSize) {
      const f = new Float64Array(this.frameSize);
      for (let i = 0; i < this.frameSize; i++) f[i] = this.buf[i];
      frames.push(f);
      this.buf.splice(0, this.hopSize);
    }
    return frames;
  }

  flush(): Float64Array[] {
    if (this.buf.length === 0) return [];
    const f = new Float64Array(this.frameSize);
    for (let i = 0; i < this.buf.length && i < this.frameSize; i++) f[i] = this.buf[i];
    this.buf = [];
    return [f];
  }

  get pending(): number {
    return this.buf.length;
  }
}

/**
 * 汉宁窗 OLA 合成器：汉宁窗在 hop = frameSize/2 时满足 COLA（常数叠接相加）。
 */
export class OlaSynthesizer {
  readonly frameSize: number;
  readonly hopSize: number;
  private readonly window: Float64Array;
  private overlap: Float64Array;
  private ready: number[] = [];

  constructor(cfg: Pick<FramingConfig, 'frameSize' | 'hopSize'>) {
    this.frameSize = cfg.frameSize;
    this.hopSize = cfg.hopSize;
    this.window = makeHann(cfg.frameSize);
    this.overlap = new Float64Array(cfg.frameSize);
  }

  addFrame(frame: Float64Array | Float32Array): Float32Array {
    for (let i = 0; i < this.frameSize; i++) this.overlap[i] += frame[i] * this.window[i];
    for (let i = 0; i < this.hopSize; i++) this.ready.push(this.overlap[i]);
    // 左移 hop
    const next = new Float64Array(this.frameSize);
    next.set(this.overlap.subarray(this.hopSize));
    this.overlap = next;
    const out = new Float32Array(this.ready.length);
    for (let i = 0; i < this.ready.length; i++) out[i] = this.ready[i];
    this.ready = [];
    return out;
  }

  flush(): Float32Array {
    const tail = new Float32Array(this.frameSize - this.hopSize);
    for (let i = 0; i < tail.length; i++) tail[i] = this.overlap[i];
    this.overlap.fill(0);
    return tail;
  }
}

/** 对一帧加汉宁窗（返回新数组） */
export function applyHann(frame: Float64Array): Float64Array {
  const w = makeHann(frame.length);
  const out = new Float64Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = frame[i] * w[i];
  return out;
}
