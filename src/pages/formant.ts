/** 共振峰显示页：实时谱/包络、氦→空气共振峰搬移对照、基音与降噪增益 */

import { store } from '../state/store.ts';
import { audioGraph } from '../main.ts';
import { fftMagnitudeDb } from '../dsp/envelope.ts';
import { estimatePitch } from '../dsp/pitch.ts';
import { applyHann } from '../dsp/framing.ts';
import { lpcAnalyze } from '../dsp/lpc.ts';
import { findFormants, warpAllPoleFilter } from '../dsp/formants.ts';
import { DEFAULT_CONFIG } from '../dsp/unscrambler.ts';

export function renderFormantPage(root: HTMLElement): void {
  root.innerHTML = `
    <div class="grid two">
      <section class="card" style="grid-column:1/-1">
        <h2>实时频谱与全极点声道包络</h2>
        <div class="canvas-wrap"><canvas id="spec" width="1160" height="340"></canvas></div>
        <p class="section-note">
          灰线＝输入信号 FFT 幅度谱；紫线＝氦语音 LPC 全极点包络；青色虚线＝校正后包络。
          紫色标记为氦语音极点，青色标记为按 q(F) 拉回的空气位置（F1/F2/F3）。
        </p>
      </section>

      <section class="card">
        <h2>共振峰搬移对照（最近帧）</h2>
        <table>
          <thead><tr><th>峰</th><th>氦语音 F (Hz)</th><th>校正后 F (Hz)</th><th>带宽 (Hz)</th><th>搬移比</th></tr></thead>
          <tbody id="fm-table"><tr><td colspan="5" class="muted">等待语音帧…</td></tr></tbody>
        </table>
        <h3>基音与发声状态</h3>
        <dl class="kv">
          <dt>基音 F0</dt><dd id="f0-val">– Hz</dd>
          <dt>发声状态</dt><dd id="voiced-val">–</dd>
          <dt>帧 RMS</dt><dd id="rms-val">–</dd>
        </dl>
      </section>

      <section class="card">
        <h2>多频带维纳降噪增益</h2>
        <div class="canvas-wrap"><canvas id="bands" width="560" height="240"></canvas></div>
        <p class="section-note">
          6 个 mel 频带的实时增益：增益越低表示该带被判为呼吸阀气流/气泡噪声而压制。
        </p>
      </section>
    </div>`;

  const specCanvas = root.querySelector('#spec')! as HTMLCanvasElement;
  const bandCanvas = root.querySelector('#bands')! as HTMLCanvasElement;
  const table = root.querySelector('#fm-table')! as HTMLTableSectionElement;

  function drawBands(gains: number[]): void {
    const ctx = bandCanvas.getContext('2d')!;
    const W = bandCanvas.width;
    const H = bandCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a1120';
    ctx.fillRect(0, 0, W, H);
    const n = gains.length || 1;
    const gap = 10;
    const bw = (W - 40 - gap * (n - 1)) / n;
    gains.forEach((g, i) => {
      const x = 30 + i * (bw + gap);
      const h = (H - 50) * g;
      ctx.fillStyle = g > 0.7 ? '#34d399' : g > 0.35 ? '#fbbf24' : '#f87171';
      ctx.fillRect(x, H - 30 - h, bw, h);
      ctx.fillStyle = '#93a4bf';
      ctx.font = '11px sans-serif';
      ctx.fillText(`B${i + 1}`, x + bw / 2 - 8, H - 14);
      ctx.fillText(g.toFixed(2), x + bw / 2 - 10, H - 34 - h);
    });
  }

  let raf = 0;
  const draw = () => {
    raf = requestAnimationFrame(draw);
    const s = store.get();
    const analyser = audioGraph.getAnalyser();
    const ctx = specCanvas.getContext('2d')!;
    const W = specCanvas.width;
    const H = specCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a1120';
    ctx.fillRect(0, 0, W, H);

    if (!analyser) {
      ctx.fillStyle = '#7d8fab';
      ctx.font = '14px sans-serif';
      ctx.fillText('请先在通话页启动通信链路', W / 2 - 110, H / 2);
      drawBands(new Array(6).fill(1));
      return;
    }

    const sr = audioGraph.sampleRate;
    const N = analyser.fftSize;
    const time = new Float32Array(N);
    analyser.getFloatTimeDomainData(time);
    // 取长度接近 25ms 的窗做 LPC
    const frameN = Math.min(DEFAULT_CONFIG.frameSize, N);
    const frame = new Float64Array(frameN);
    for (let i = 0; i < frameN; i++) frame[i] = time[i];
    const windowed = applyHann(frame);

    const fft = fftMagnitudeDb(windowed, sr);
    const lpc = lpcAnalyze(windowed, DEFAULT_CONFIG.lpcOrder);
    const gain = Math.sqrt(Math.max(lpc.error, 1e-12));
    const formantsHe = findFormants(lpc.a, sr, 3);
    const warped = warpAllPoleFilter(lpc.a, gain, sr, s.mix, s.depthM);
    const pitch = estimatePitch(frame, sr);

    const maxF = Math.min(4200, sr / 2);
    const x = (f: number) => (f / maxF) * (W - 60) + 50;
    const dbMin = -90;
    const dbMax = 10;
    const y = (db: number) => H - 36 - ((db - dbMin) / (dbMax - dbMin)) * (H - 56);

    // 频率网格
    ctx.strokeStyle = '#16233b';
    ctx.fillStyle = '#7d8fab';
    ctx.font = '11px Consolas, monospace';
    for (let f = 0; f <= maxF; f += 500) {
      ctx.beginPath();
      ctx.moveTo(x(f), 12);
      ctx.lineTo(x(f), H - 32);
      ctx.stroke();
      ctx.fillText(`${f}`, x(f) - 12, H - 16);
    }

    // FFT
    ctx.strokeStyle = 'rgba(180,196,220,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    fft.forEach((p, i) => {
      if (p.freq > maxF) return;
      const px = x(p.freq);
      const py = y(p.magnitudeDb);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    // LPC 包络（氦）
    const drawEnv = (a: Float64Array, g: number, color: string, dash: number[]) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
      ctx.setLineDash(dash);
      ctx.beginPath();
      for (let f = 60; f <= maxF; f += 12) {
        const om = (2 * Math.PI * f) / sr;
        let re = 1;
        let im = 0;
        for (let k = 0; k < a.length; k++) {
          const ang = -om * (k + 1);
          re += a[k] * Math.cos(ang);
          im += a[k] * Math.sin(ang);
        }
        const mag = g / Math.max(Math.hypot(re, im), 1e-12);
        const db = 20 * Math.log10(Math.max(mag, 1e-8));
        const px = x(f);
        const py = y(db);
        if (f === 60) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    drawEnv(lpc.a, gain, '#a78bfa', []);
    drawEnv(warped.a, warped.gain, '#22d3ee', [7, 5]);

    // 共振峰标记
    formantsHe.forEach((fm, i) => {
      const px = x(fm.f);
      ctx.strokeStyle = '#a78bfa';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(px, 16);
      ctx.lineTo(px, H - 34);
      ctx.stroke();
      ctx.fillStyle = '#a78bfa';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(`F${i + 1}`, px - 6, 14);
    });
    warped.mapping.slice(0, 3).forEach((m, i) => {
      const px = x(m.to);
      ctx.strokeStyle = '#22d3ee';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, 26);
      ctx.lineTo(px, H - 34);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#22d3ee';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(`F${i + 1}′`, px - 7, 26);
    });

    // 表格与基音
    if (formantsHe.length > 0) {
      table.innerHTML = warped.mapping
        .slice(0, 3)
        .map((m, i) => {
          const ratio = m.to / m.from;
          return `<tr>
            <td>F${i + 1}</td>
            <td class="mono">${m.from.toFixed(0)}</td>
            <td class="mono" style="color:var(--accent-2)">${m.to.toFixed(0)}</td>
            <td class="mono">${m.bw.toFixed(0)}</td>
            <td class="mono">×${ratio.toFixed(3)}</td>
          </tr>`;
        })
        .join('');
    }
    (root.querySelector('#f0-val')! as HTMLElement).textContent =
      pitch.f0 > 0 ? `${pitch.f0.toFixed(1)} Hz（清晰度 ${(pitch.clarity * 100).toFixed(0)}%）` : '清音/无声';
    (root.querySelector('#voiced-val')! as HTMLElement).innerHTML = pitch.f0 > 0
      ? '<span class="pill ok">浊音</span>'
      : '<span class="pill info">清音/静默</span>';
    let rms = 0;
    for (const v of frame) rms += v * v;
    (root.querySelector('#rms-val')! as HTMLElement).textContent = Math.sqrt(rms / frame.length).toFixed(4);

    drawBands(s.telemetry?.bandGains ?? new Array(6).fill(1));
  };
  draw();

  const observer = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      cancelAnimationFrame(raf);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
