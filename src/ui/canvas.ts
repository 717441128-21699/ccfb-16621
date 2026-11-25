/** Canvas 2D 绘制工具：波形、深度曲线、频谱与共振峰标记 */
export function setupCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  analyser: AnalyserNode | null,
  color: string,
): void {
  const ctx = setupCanvas(canvas);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (!analyser) {
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    return;
  }
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  const step = Math.max(1, Math.floor(data.length / w));
  for (let x = 0; x < w; x++) {
    const i = x * step;
    const y = h / 2 - data[i] * (h * 0.45);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(138,163,196,0.25)';
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

export interface Trace {
  label: string;
  color: string;
  points: { x: number; y: number }[];
}

export function drawLineChart(
  canvas: HTMLCanvasElement,
  traces: Trace[],
  opts: { xLabel: string; yLabel: string; xMax: number; yMax: number; yMin?: number; markers?: { x: number; label: string; color: string }[] },
): void {
  const ctx = setupCanvas(canvas);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const padL = 46;
  const padB = 28;
  const padT = 12;
  const padR = 12;
  const pw = w - padL - padR;
  const ph = h - padT - padB;
  const yMin = opts.yMin ?? 0;
  const x = (v: number) => padL + (v / opts.xMax) * pw;
  const y = (v: number) => padT + ph - ((v - yMin) / (opts.yMax - yMin)) * ph;

  ctx.strokeStyle = 'rgba(138,163,196,0.18)';
  ctx.fillStyle = 'rgba(138,163,196,0.8)';
  ctx.font = '10px sans-serif';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const gy = padT + (ph / 4) * g;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(w - padR, gy);
    ctx.stroke();
    const val = opts.yMax - ((opts.yMax - yMin) / 4) * g;
    ctx.fillText(val.toFixed(0), 6, gy + 3);
  }
  ctx.fillText(opts.yLabel, 4, padT - 2);
  ctx.fillText(opts.xLabel, w - padR - 30, h - 8);

  for (const trace of traces) {
    ctx.strokeStyle = trace.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    trace.points.forEach((p, i) => {
      const px = x(p.x);
      const py = y(Math.min(Math.max(p.y, yMin), opts.yMax));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  if (opts.markers) {
    for (const m of opts.markers) {
      const px = x(m.x);
      ctx.strokeStyle = m.color;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + ph);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m.color;
      ctx.fillText(m.label, px + 4, padT + 10);
    }
  }

  // 图例
  traces.forEach((t, i) => {
    const lx = padL + 8 + i * 130;
    ctx.fillStyle = t.color;
    ctx.fillRect(lx, padT + 2, 14, 3);
    ctx.fillStyle = 'rgba(220,231,247,0.9)';
    ctx.fillText(t.label, lx + 18, padT + 7);
  });
}

export interface SpectrumDraw {
  freqHz: number;
  magDb: number;
}

export function drawSpectrum(
  canvas: HTMLCanvasElement,
  spectrum: SpectrumDraw[],
  markersHe: { freq: number; bandwidth: number }[],
  markersAir: { freq: number; bandwidth: number }[],
  maxFreq: number,
): void {
  const ctx = setupCanvas(canvas);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const padL = 46;
  const padB = 26;
  const padT = 10;
  const pw = w - padL - 10;
  const ph = h - padT - padB;
  const dbMin = -40;
  const dbMax = 20;
  const x = (f: number) => padL + (f / maxFreq) * pw;
  const y = (db: number) => padT + ph - ((db - dbMin) / (dbMax - dbMin)) * ph;

  ctx.strokeStyle = 'rgba(138,163,196,0.18)';
  ctx.font = '10px sans-serif';
  for (let g = 0; g <= 4; g++) {
    const gy = padT + (ph / 4) * g;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(w - 10, gy);
    ctx.stroke();
    ctx.fillStyle = 'rgba(138,163,196,0.8)';
    ctx.fillText((dbMax - ((dbMax - dbMin) / 4) * g).toFixed(0) + 'dB', 6, gy + 3);
  }

  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  spectrum.forEach((p, i) => {
    const px = x(p.freqHz);
    const py = y(p.magDb);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  const drawMarker = (m: { freq: number; bandwidth: number }, color: string, label: string) => {
    const px = x(m.freq);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, padT);
    ctx.lineTo(px, padT + ph);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(`${label}${Math.round(m.freq)}`, px + 3, padT + 12);
    // 带宽弧
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x(Math.max(0, m.freq - m.bandwidth)), padT + ph - 4);
    ctx.lineTo(x(m.freq + m.bandwidth), padT + ph - 4);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  markersHe.forEach((m, i) => drawMarker(m, '#f472b6', `F${i + 1}He `));
  markersAir.forEach((m, i) => drawMarker(m, '#4ade80', `F${i + 1}空气 `));

  ctx.fillStyle = 'rgba(138,163,196,0.8)';
  for (let f = 0; f <= maxFreq; f += 1000) {
    ctx.fillText(`${f / 1000}k`, x(f) - 6, h - 8);
  }
}
