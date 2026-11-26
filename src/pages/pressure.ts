/** 舱压深度页：潜水日志曲线 + 时间轴驱动校正系数 */

import { store } from '../state/store.ts';
import { audioGraph } from '../main.ts';
import { DIVE_LOG, DIVE_META, sampleDiveLog } from '../data/divedata.ts';
import { pressureAtDepth, soundSpeed, uniformShiftRatio, oxygenPartialPressure } from '../dsp/physics.ts';

function drawDepthChart(canvas: HTMLCanvasElement, cursorMin: number): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const padL = 46;
  const padB = 34;
  const padT = 14;
  const padR = 14;
  const tMax = DIVE_LOG[DIVE_LOG.length - 1].tMin;
  const dMax = 200;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a1120';
  ctx.fillRect(0, 0, W, H);

  const x = (t: number) => padL + ((W - padL - padR) * t) / tMax;
  const y = (d: number) => padT + ((H - padT - padB) * (dMax - d)) / dMax;

  // 网格
  ctx.strokeStyle = '#1c2a44';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#7d8fab';
  ctx.font = '11px Consolas, monospace';
  for (let d = 0; d <= 200; d += 50) {
    ctx.beginPath();
    ctx.moveTo(padL, y(d));
    ctx.lineTo(W - padR, y(d));
    ctx.stroke();
    ctx.fillText(`${d}`, 8, y(d) + 4);
  }
  for (let t = 0; t <= tMax; t += 60) {
    ctx.fillText(`${t}′`, x(t) - 8, H - 12);
  }

  // 阶段底色
  const phaseColor: Record<string, string> = {
    加压: 'rgba(56,189,248,0.07)',
    巡潜: 'rgba(167,139,250,0.10)',
    停留: 'rgba(52,211,153,0.07)',
    减压: 'rgba(251,191,36,0.07)',
  };
  for (let i = 0; i < DIVE_LOG.length - 1; i++) {
    ctx.fillStyle = phaseColor[DIVE_LOG[i].phase] ?? 'transparent';
    ctx.fillRect(x(DIVE_LOG[i].tMin), padT, x(DIVE_LOG[i + 1].tMin) - x(DIVE_LOG[i].tMin), H - padT - padB);
  }

  // 深度曲线
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  DIVE_LOG.forEach((p, i) => {
    if (i === 0) ctx.moveTo(x(p.tMin), y(p.depthM));
    else ctx.lineTo(x(p.tMin), y(p.depthM));
  });
  ctx.stroke();

  // 数据点
  ctx.fillStyle = '#22d3ee';
  for (const p of DIVE_LOG) {
    ctx.beginPath();
    ctx.arc(x(p.tMin), y(p.depthM), 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // 当前时间游标
  const cx = x(cursorMin);
  ctx.strokeStyle = '#f87171';
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, padT);
  ctx.lineTo(cx, H - padB);
  ctx.stroke();
  ctx.setLineDash([]);
  const cur = sampleDiveLog(cursorMin);
  ctx.fillStyle = '#f87171';
  ctx.beginPath();
  ctx.arc(cx, y(cur.depthM), 5, 0, Math.PI * 2);
  ctx.fill();

  // 轴标签
  ctx.fillStyle = '#93a4bf';
  ctx.font = '12px sans-serif';
  ctx.fillText('深度 (mSW)', 6, padT - 2);
  ctx.fillText('经过时间 (min)', W - 110, H - 12);
}

export function renderPressurePage(root: HTMLElement): void {
  root.innerHTML = `
    <div class="grid two">
      <section class="card" style="grid-column:1/-1">
        <h2>舱压/深度潜水日志（作业票 ${DIVE_META.diveId} · ${DIVE_META.date}）</h2>
        <div class="canvas-wrap"><canvas id="depth-chart" width="1160" height="300"></canvas></div>
        <label class="field" style="margin-top:12px">
          日志时间轴（拖动可回放任意加压/减压时刻，校正系数自动跟随）
          <input type="range" id="time-scrub" min="0" max="360" step="1" value="${store.get().diveTimeMin}" />
        </label>
        <p class="section-note">
          通信链路运行时，时间轴每秒自动推进一个日志分钟；手动拖动可立即覆盖并把该时刻的
          深度与氦氧配比下发到 AudioWorklet。
        </p>
      </section>

      <section class="card">
        <h2>当前工况物理量</h2>
        <div class="grid three">
          <div class="metric"><span class="label">深度</span><span class="value" id="p-depth">–</span></div>
          <div class="metric"><span class="label">绝对舱压</span><span class="value" id="p-pres">–</span></div>
          <div class="metric"><span class="label">混合气声速</span><span class="value" id="p-c">–</span></div>
          <div class="metric"><span class="label">空气声速(37℃)</span><span class="value" id="p-cair">–</span></div>
          <div class="metric"><span class="label">均匀声速比 q₀</span><span class="value" id="p-q">–</span></div>
          <div class="metric"><span class="label">氧分压 ppO₂</span><span class="value" id="p-ppo2">–</span></div>
        </div>
        <h3>配比（可手动覆盖下发）</h3>
        <div class="grid three">
          <label class="field">He %<input type="number" id="in-he" min="0" max="100" step="0.1" /></label>
          <label class="field">O₂ %<input type="number" id="in-o2" min="0" max="100" step="0.1" /></label>
          <label class="field">N₂ %<input type="number" id="in-n2" min="0" max="100" step="0.1" /></label>
        </div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn primary" id="btn-apply">下发手动配比</button>
          <button class="btn" id="btn-reset-log">回到日志插值</button>
        </div>
      </section>

      <section class="card">
        <h2>日志控制点</h2>
        <div style="max-height:380px;overflow:auto">
          <table>
            <thead><tr><th>t(min)</th><th>深度(m)</th><th>压力(bar)</th><th>He%</th><th>O₂%</th><th>N₂%</th><th>阶段</th></tr></thead>
            <tbody>
              ${DIVE_LOG.map(
                (p) => `<tr>
                  <td class="mono">${p.tMin}</td>
                  <td class="mono">${p.depthM}</td>
                  <td class="mono">${pressureAtDepth(p.depthM).toFixed(2)}</td>
                  <td class="mono">${(p.mix.he * 100).toFixed(1)}</td>
                  <td class="mono">${(p.mix.o2 * 100).toFixed(1)}</td>
                  <td class="mono">${(p.mix.n2 * 100).toFixed(1)}</td>
                  <td><span class="pill info">${p.phase}</span></td>
                </tr>`,
              ).join('')}
            </tbody>
          </table>
        </div>
      </section>
    </div>`;

  const chart = root.querySelector('#depth-chart')! as HTMLCanvasElement;
  const scrub = root.querySelector('#time-scrub')! as HTMLInputElement;
  const inHe = root.querySelector('#in-he')! as HTMLInputElement;
  const inO2 = root.querySelector('#in-o2')! as HTMLInputElement;
  const inN2 = root.querySelector('#in-n2')! as HTMLInputElement;

  const refresh = () => {
    const s = store.get();
    drawDepthChart(chart, s.diveTimeMin);
    scrub.value = String(s.diveTimeMin);
    (root.querySelector('#p-depth')! as HTMLElement).innerHTML =
      `${s.depthM.toFixed(1)} <span class="unit">m</span>`;
    (root.querySelector('#p-pres')! as HTMLElement).innerHTML =
      `${pressureAtDepth(s.depthM).toFixed(2)} <span class="unit">bar</span>`;
    (root.querySelector('#p-c')! as HTMLElement).innerHTML =
      `${soundSpeed(s.mix).toFixed(1)} <span class="unit">m/s</span>`;
    (root.querySelector('#p-cair')! as HTMLElement).innerHTML =
      `${soundSpeed({ he: 0, o2: 0.21, n2: 0.79 }).toFixed(1)} <span class="unit">m/s</span>`;
    (root.querySelector('#p-q')! as HTMLElement).textContent = uniformShiftRatio(s.mix).toFixed(3);
    (root.querySelector('#p-ppo2')! as HTMLElement).innerHTML =
      `${oxygenPartialPressure(s.mix, s.depthM).toFixed(2)} <span class="unit">bar</span>`;
    inHe.value = (s.mix.he * 100).toFixed(1);
    inO2.value = (s.mix.o2 * 100).toFixed(1);
    inN2.value = (s.mix.n2 * 100).toFixed(1);
  };

  const unsub = store.subscribe(refresh);
  refresh();

  scrub.addEventListener('input', () => {
    const t = Number(scrub.value);
    const { depthM, mix } = sampleDiveLog(t);
    audioGraph.setEnvironment(depthM, mix);
    store.set({ diveTimeMin: t, depthM, mix });
  });

  root.querySelector('#btn-apply')!.addEventListener('click', () => {
    const he = Number(inHe.value) / 100;
    const o2 = Number(inO2.value) / 100;
    const n2 = Number(inN2.value) / 100;
    const sum = he + o2 + n2;
    if (Math.abs(sum - 1) > 0.01) {
      alert(`组分之和应为 100%，当前为 ${(sum * 100).toFixed(1)}%`);
      return;
    }
    const mix = { he, o2, n2 };
    audioGraph.setEnvironment(store.get().depthM, mix);
    store.set({ mix });
  });

  root.querySelector('#btn-reset-log')!.addEventListener('click', () => {
    const { depthM, mix } = sampleDiveLog(store.get().diveTimeMin);
    audioGraph.setEnvironment(depthM, mix);
    store.set({ depthM, mix });
  });

  const observer = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      unsub();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
