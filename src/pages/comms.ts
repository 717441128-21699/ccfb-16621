/** 潜水员通话页 */

import { store } from '../state/store.ts';
import { audioGraph } from '../main.ts';
import { SIM_DIVERS } from '../dsp/simulator.ts';
import { soundSpeed, uniformShiftRatio, oxygenPartialPressure } from '../dsp/physics.ts';
import type { CallRecord } from '../state/store.ts';

function levelMeter(analyser: AnalyserNode | null, canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  let level = 0;
  if (analyser) {
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
  }
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0a1120';
  ctx.fillRect(0, 0, W, H);
  const bars = 42;
  const gap = 3;
  const bw = (W - gap * (bars - 1)) / bars;
  for (let i = 0; i < bars; i++) {
    const lit = i / bars < level;
    const x = i * (bw + gap);
    ctx.fillStyle = !lit ? '#1c2a44' : i < bars * 0.65 ? '#34d399' : i < bars * 0.85 ? '#fbbf24' : '#f87171';
    const h = lit ? (H * (i + 1)) / bars : 3;
    ctx.fillRect(x, H - h, bw, h);
  }
  return level;
}

export function renderCommsPage(root: HTMLElement): void {
  root.innerHTML = `
    <div class="grid two">
      <section class="card">
        <h2>通信链路控制</h2>
        <div class="btn-row" style="margin-bottom:14px">
          <button class="btn primary" id="btn-start-demo">启动演示信号</button>
          <button class="btn" id="btn-start-mic">麦克风实时氦化</button>
          <button class="btn danger" id="btn-stop">停止</button>
        </div>
        <label class="field" style="max-width:320px;margin-bottom:14px">
          潜水员（嗓音参数）
          <select id="sel-diver">
            ${SIM_DIVERS.map(
              (d) =>
                `<option value="${d.id}">${d.name} · F0 ${d.f0Mean} Hz · 声道缩放 ${d.formantScale.toFixed(2)}</option>`,
            ).join('')}
          </select>
        </label>
        <label class="switch" style="margin-bottom:14px">
          <input type="checkbox" id="chk-correct" checked />
          <span>启用氦语音校正（关闭则直通原始氦语音）</span>
        </label>
        <div class="btn-row">
          <button class="btn good" id="btn-rec">● 开始录音</button>
          <span class="muted" id="rec-state">未录音</span>
        </div>
        <p class="section-note">
          演示信号由内置源-滤波器合成器生成（已知共振峰地面真值），并叠加呼吸阀气流与气泡噪声；
          麦克风模式会把您的声音实时氦化后再送入同一校正链路，便于端到端试听。
        </p>
      </section>

      <section class="card">
        <h2>实时链路状态</h2>
        <div class="grid three" style="margin-bottom:12px">
          <div class="metric"><span class="label">当前深度</span><span class="value" id="m-depth">–</span></div>
          <div class="metric"><span class="label">声速比 q₀</span><span class="value" id="m-q">–</span></div>
          <div class="metric"><span class="label">端到端延迟</span><span class="value" id="m-lat">–</span></div>
          <div class="metric"><span class="label">混合气声速</span><span class="value" id="m-c">–</span></div>
          <div class="metric"><span class="label">氧分压 ppO₂</span><span class="value" id="m-ppo2">–</span></div>
          <div class="metric"><span class="label">链路状态</span><span class="value" id="m-state" style="font-size:15px">未启动</span></div>
        </div>
        <h3>输出电平</h3>
        <div class="canvas-wrap"><canvas id="meter" width="520" height="90"></canvas></div>
        <h3>当前配比</h3>
        <dl class="kv" id="mix-kv"></dl>
      </section>
    </div>

    <section class="card" style="margin-top:16px">
      <h2>处理管线（AudioWorklet 音频线程）</h2>
      <p class="mono muted" style="font-size:12.6px;line-height:1.9">
        麦克风/合成信号 → 25 ms 分帧(10 ms 跳) → 汉宁窗 → 多频带维纳降噪(呼吸阀/气泡)
        → Levinson-Durbin LPC(p=14) 全极点建模 → 复数求根得共振峰极点
        → 按 q(F)=c_He/c_air（含舱壁低频修正）拉回空气频率，带宽保持 → 原残差激励重合成（基音不变）
        → 汉宁 OLA → 扬声器
      </p>
    </section>`;

  const diverSel = root.querySelector('#sel-diver')! as HTMLSelectElement;
  diverSel.value = store.get().currentDiver.id;

  const startDemo = root.querySelector('#btn-start-demo')!;
  const startMic = root.querySelector('#btn-start-mic')!;
  const stopBtn = root.querySelector('#btn-stop')!;
  const chk = root.querySelector('#chk-correct')! as HTMLInputElement;
  const recBtn = root.querySelector('#btn-rec')!;
  const recState = root.querySelector('#rec-state')!;

  let recording = false;
  let recStart = 0;

  startDemo.addEventListener('click', async () => {
    const diver = SIM_DIVERS.find((d) => d.id === diverSel.value)!;
    store.set({ currentDiver: diver, source: 'demo' });
    await audioGraph.start('demo', diver);
    store.set({ running: true, latencyMs: audioGraph.state.latencyMs });
  });

  startMic.addEventListener('click', async () => {
    const diver = SIM_DIVERS.find((d) => d.id === diverSel.value)!;
    store.set({ currentDiver: diver, source: 'mic' });
    try {
      await audioGraph.start('mic', diver);
      store.set({ running: true, latencyMs: audioGraph.state.latencyMs });
    } catch (e) {
      alert('无法访问麦克风：' + (e as Error).message);
    }
  });

  stopBtn.addEventListener('click', async () => {
    if (recording) (recBtn as HTMLButtonElement).click();
    await audioGraph.stop();
    store.set({ running: false, telemetry: null });
  });

  chk.addEventListener('change', () => {
    audioGraph.setCorrectionEnabled(chk.checked);
    store.set({ correctionEnabled: chk.checked });
  });

  recBtn.addEventListener('click', () => {
    if (!store.get().running) {
      alert('请先启动通信链路');
      return;
    }
    if (!recording) {
      audioGraph.startRecording();
      recording = true;
      recStart = performance.now();
      recBtn.textContent = '■ 停止录音';
      recBtn.classList.remove('good');
      recBtn.classList.add('danger');
      recState.textContent = '录音中…';
    } else {
      const blob = audioGraph.stopRecording();
      recording = false;
      const durationSec = (performance.now() - recStart) / 1000;
      recBtn.textContent = '● 开始录音';
      recBtn.classList.add('good');
      recBtn.classList.remove('danger');
      recState.textContent = `已保存 ${durationSec.toFixed(1)} s 录音到通话记录页`;
      const s = store.get();
      const record: CallRecord = {
        id: `REC-${Date.now()}`,
        timeLabel: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        diver: s.currentDiver.name,
        depthM: s.depthM,
        durationSec,
        corrected: s.correctionEnabled,
        blob: blob ?? undefined,
        mime: blob?.type ?? 'audio/webm',
      };
      store.set({ records: [record, ...s.records] });
    }
  });

  const canvas = root.querySelector('#meter')! as HTMLCanvasElement;
  const unsub = store.subscribe((s) => {
    (root.querySelector('#m-depth')! as HTMLElement).innerHTML =
      `${s.depthM.toFixed(1)} <span class="unit">m</span>`;
    (root.querySelector('#m-q')! as HTMLElement).textContent = uniformShiftRatio(s.mix).toFixed(3);
    (root.querySelector('#m-lat')! as HTMLElement).innerHTML =
      `${s.latencyMs.toFixed(1)} <span class="unit">ms</span>`;
    (root.querySelector('#m-c')! as HTMLElement).innerHTML =
      `${soundSpeed(s.mix).toFixed(1)} <span class="unit">m/s</span>`;
    (root.querySelector('#m-ppo2')! as HTMLElement).innerHTML =
      `${oxygenPartialPressure(s.mix, s.depthM).toFixed(2)} <span class="unit">bar</span>`;
    const stateEl = root.querySelector('#m-state')! as HTMLElement;
    stateEl.innerHTML = s.running
      ? `<span class="pill ${s.correctionEnabled ? 'ok' : 'warn'}">${
          s.correctionEnabled ? '校正中' : '直通'
        }</span>`
      : '<span class="pill info">未启动</span>';
    (root.querySelector('#mix-kv')! as HTMLElement).innerHTML = `
      <dt>He 氦气</dt><dd>${(s.mix.he * 100).toFixed(1)} %</dd>
      <dt>O₂ 氧气</dt><dd>${(s.mix.o2 * 100).toFixed(1)} %</dd>
      <dt>N₂ 氮气</dt><dd>${(s.mix.n2 * 100).toFixed(1)} %</dd>`;
    chk.checked = s.correctionEnabled;
  });

  let raf = 0;
  const tick = () => {
    levelMeter(audioGraph.getAnalyser(), canvas);
    raf = requestAnimationFrame(tick);
  };
  tick();

  // 页面销毁时停止 RAF（重新切回会重新 render）
  const observer = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      cancelAnimationFrame(raf);
      unsub();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
