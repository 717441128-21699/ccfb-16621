/** 共振峰显示页：LPC 全极点谱、He/空气共振峰对比、F1-F2 元音轨迹与逐帧表 */
import { h, fmt } from './dom.ts';
import { store } from '../state/store.ts';
import { drawLineChart, drawSpectrum } from './canvas.ts';
import { VOWEL_FORMANTS } from '../dsp/simulator.ts';

interface TracePoint {
  t: number;
  he: number[];
  air: number[];
  f0: number;
}

const MAX_TRACE = 120;

export function renderFormantsPage(root: HTMLElement): () => void {
  const timers: number[] = [];
  const history: TracePoint[] = [];

  root.append(
    h('div', { class: 'grid two' },
      h('div', { class: 'card' },
        h('h2', {}, '全极点声道模型谱（逐帧 LPC，粉=氦语音，绿=校正后）'),
        h('canvas', { id: 'lpc-canvas', height: '280' }),
        h('p', { class: 'muted' }, '竖线为拾取的共振峰中心，短线段为极点带宽；低频 300 Hz 以下受音高保护区不搬移。'),
      ),
      h('div', { class: 'card' },
        h('h2', {}, '共振峰频率搬移（当前帧）'),
        formantTable(),
        h('h2', { style: 'margin-top:16px' }, 'F1–F2 元音空间轨迹'),
        h('canvas', { id: 'vowel-canvas', height: '240' }),
      ),
    ),
    h('div', { class: 'card', style: 'margin-top:14px' },
      h('h2', {}, '共振峰时间序列（最近帧）'),
      h('canvas', { id: 'track-canvas', height: '220' }),
    ),
  );

  const draw = () => {
    const stats = store.get().latestStats;
    const sr = store.engine.targetSampleRate;

    // LPC 谱（用 analyser 的 FFT 幅度近似显示，叠加共振峰标记）
    const canvas = root.querySelector<HTMLCanvasElement>('#lpc-canvas')!;
    const analyser = store.engine.rawAnalyser;
    const spectrum: { freqHz: number; magDb: number }[] = [];
    if (analyser) {
      const bins = analyser.frequencyBinCount;
      const mag = new Float32Array(bins);
      analyser.getFloatFrequencyData(mag);
      const binHz = sr / analyser.fftSize;
      for (let k = 0; k < bins; k++) spectrum.push({ freqHz: k * binHz, magDb: mag[k] });
    }
    drawSpectrum(
      canvas,
      spectrum,
      stats?.formantsHe ?? [],
      stats?.formantsAir ?? [],
      sr * 0.5,
    );

    if (stats?.isSpeech && (stats.formantsHe.length || stats.formantsAir.length)) {
      history.push({
        t: stats.frameIndex,
        he: stats.formantsHe.map((f) => f.freq),
        air: stats.formantsAir.map((f) => f.freq),
        f0: stats.f0,
      });
      if (history.length > MAX_TRACE) history.shift();
    }

    // F1-F2 元音空间
    const vowelCanvas = root.querySelector<HTMLCanvasElement>('#vowel-canvas')!;
    drawVowelSpace(vowelCanvas, history);

    // 时间序列
    const trackCanvas = root.querySelector<HTMLCanvasElement>('#track-canvas')!;
    drawLineChart(
      trackCanvas,
      [
        { label: 'F1 氦语音', color: '#f472b6', points: history.map((p) => ({ x: p.t, y: p.he[0] ?? 0 })) },
        { label: 'F1 校正', color: '#4ade80', points: history.map((p) => ({ x: p.t, y: p.air[0] ?? 0 })) },
        { label: 'F2 校正', color: '#38bdf8', points: history.map((p) => ({ x: p.t, y: p.air[1] ?? 0 })) },
        { label: 'F0（不动）', color: '#fbbf24', points: history.map((p) => ({ x: p.t, y: p.f0 })) },
      ],
      { xLabel: '帧', yLabel: 'Hz', xMax: Math.max(120, history[history.length - 1]?.t ?? 1), yMax: 3000 },
    );

    // 表格
    const tbody = root.querySelector('#formant-body')!;
    const rows = [];
    const he = stats?.formantsHe ?? [];
    const air = stats?.formantsAir ?? [];
    for (let i = 0; i < Math.max(he.length, air.length); i++) {
      const ratio = he[i] && air[i] ? he[i].freq / air[i].freq : 0;
      rows.push(h('tr', {},
        h('td', {}, `F${i + 1}`),
        h('td', { class: 'mono' }, he[i] ? fmt(he[i].freq, 0) : '—'),
        h('td', { class: 'mono' }, air[i] ? fmt(air[i].freq, 0) : '—'),
        h('td', { class: 'mono' }, ratio ? fmt(ratio, 2) + '×' : '—'),
        h('td', { class: 'mono' }, air[i] ? fmt(air[i].bandwidth, 0) : '—'),
      ));
    }
    tbody.replaceChildren(...rows);
  };

  const raf = () => {
    draw();
    timers.push(requestAnimationFrame(raf));
  };
  raf();
  return () => timers.forEach(cancelAnimationFrame);
}

function formantTable(): HTMLElement {
  return h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, '峰'), h('th', {}, 'He 频率 Hz'), h('th', {}, '校正后 Hz'),
      h('th', {}, '搬移比'), h('th', {}, '带宽 Hz'))),
    h('tbody', { id: 'formant-body' }),
  );
}

function drawVowelSpace(canvas: HTMLCanvasElement, history: TracePoint[]): void {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);
  const f1Min = 200;
  const f1Max = 1000;
  const f2Min = 600;
  const f2Max = 2600;
  // 横轴 F2（反向），纵轴 F1（反向），经典元音图
  const x = (f2: number) => 30 + ((f2Max - f2) / (f2Max - f2Min)) * (w - 50);
  const y = (f1: number) => 15 + ((f1Max - f1) / (f1Max - f1Min)) * (h - 40);

  ctx.font = '11px sans-serif';
  for (const [vowel, fs] of Object.entries(VOWEL_FORMANTS)) {
    const px = x(fs[1]);
    const py = y(fs[0]);
    ctx.fillStyle = 'rgba(138,163,196,0.9)';
    ctx.beginPath();
    ctx.arc(px, py, 10, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(138,163,196,0.5)';
    ctx.stroke();
    ctx.fillText(vowel, px - 4, py + 4);
  }

  const plot = (pts: number[][], color: string, fill: boolean) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.6;
    pts.forEach((p, i) => {
      if (p.length < 2) return;
      const px = x(p[1]);
      const py = y(p[0]);
      if (fill) {
        ctx.globalAlpha = 0.25 + 0.75 * (i / pts.length);
        ctx.beginPath();
        ctx.arc(px, py, 3.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalAlpha = 0.5;
        ctx.strokeRect(px - 2, py - 2, 4, 4);
      }
    });
    ctx.globalAlpha = 1;
  };
  plot(history.map((p) => p.he), '#f472b6', false);
  plot(history.map((p) => p.air), '#4ade80', true);

  ctx.fillStyle = 'rgba(138,163,196,0.85)';
  ctx.fillText('● 校正轨迹  □ 氦语音原始位置  圈=空气元音基准', 10, h - 6);
}
