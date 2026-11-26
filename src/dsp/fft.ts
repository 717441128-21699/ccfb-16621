/**
 * 迭代基-2 FFT（原地运算，实部/虚部分离存储）
 * 长度必须为 2 的幂。供 LPC 包络计算与多频带维纳滤波使用。
 */

export function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT 长度必须为 2 的幂');
  if (im.length !== n) throw new Error('实部虚部长度不一致');

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = curR * re[b] - curI * im[b];
        const ti = curR * im[b] + curI * re[b];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }
}

export function ifftRadix2(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < im.length; i++) im[i] = -im[i];
  fftRadix2(re, im);
  const n = re.length;
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

export function magnitudeSpectrum(re: Float64Array, im: Float64Array): Float64Array {
  const out = new Float64Array(re.length);
  for (let i = 0; i < re.length; i++) out[i] = Math.hypot(re[i], im[i]);
  return out;
}
