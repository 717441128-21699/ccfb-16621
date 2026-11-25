/**
 * 基-2 迭代 FFT（Cooley–Tukey），预计算位反转与旋转因子。
 * 全极点声道建模与谱减降噪共用同一实例，避免每帧重复分配。
 */
export class FFT {
  readonly size: number;
  private readonly bits: number;
  private readonly rev: Uint32Array;
  private readonly twCos: Float64Array;
  private readonly twSin: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT 长度必须为 2 的幂，收到 ${size}`);
    }
    this.size = size;
    this.bits = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < this.bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
    const half = size >>> 1;
    this.twCos = new Float64Array(half);
    this.twSin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const ang = (-2 * Math.PI * k) / size;
      this.twCos[k] = Math.cos(ang);
      this.twSin[k] = Math.sin(ang);
    }
  }

  static nextPow2(n: number): number {
    return 1 << Math.ceil(Math.log2(Math.max(2, n)));
  }

  /** 原地正变换 */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        let k = 0;
        for (let j = 0; j < half; j++, k += step) {
          const wr = this.twCos[k];
          const wi = this.twSin[k];
          const a = i + j;
          const b = a + half;
          const ur = re[a];
          const ui = im[a];
          const vr = re[b] * wr - im[b] * wi;
          const vi = re[b] * wi + im[b] * wr;
          re[a] = ur + vr;
          im[a] = ui + vi;
          re[b] = ur - vr;
          im[b] = ui - vi;
        }
      }
    }
  }

  /** 原地逆变换（含 1/N 归一化） */
  inverse(re: Float64Array, im: Float64Array): void {
    for (let i = 0; i < this.size; i++) im[i] = -im[i];
    this.transform(re, im);
    const n = this.size;
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] = -im[i] / n;
    }
  }
}

/** 周期性 Hann 窗（50% 重叠相加时增益守恒） */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  }
  return w;
}
