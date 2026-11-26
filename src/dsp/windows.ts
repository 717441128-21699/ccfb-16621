/** 窗函数 */

export function hannWindow(n: number, N: number): number {
  return 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
}

export function makeHann(N: number): Float64Array {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = hannWindow(i, N);
  return w;
}
