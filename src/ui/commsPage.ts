/** 潜水员通话页：原始/校正波形、旁路对比、模拟通话记录 */
import { h, clear, fmt } from './dom.ts';
import { store } from '../state/store.ts';
import { DIVERS } from '../model/diveLog.ts';
import { drawWaveform } from './canvas.ts';
import { SCRIPTED_UTTERANCES } from '../dsp/simulator.ts';

const QUICK_PHRASES = [
  '海面收到，信号清晰',
  '当前深度正常，供气稳定',
  '准备开始法兰检修',
  '听到气泡声，请求确认',
  '能见度下降，放慢动作',
  '减压程序确认无误',
];

export function renderCommsPage(root: HTMLElement): () => void {
  const timers: number[] = [];
  root.append(
    h('div', { class: 'grid two' },
      h('div', { class: 'card' },
        h('h2', {}, '音频链路'),
        controlsCard(),
        h('h3', {}, '原始氦语音（面罩麦克风）'),
        h('canvas', { id: 'raw-wave', height: '120' }),
        h('h3', {}, '校正后语音（潜水监督耳机）'),
        h('canvas', { id: 'cor-wave', height: '120' }),
        metricsRow(),
      ),
      h('div', { class: 'card' },
        h('h2', {}, '模拟通话'),
        quickPhrases(),
        h('div', { id: 'call-feed', class: 'log-feed' }),
      ),
    ),
  );

  const draw = () => {
    const raw = root.querySelector<HTMLCanvasElement>('#raw-wave')!;
    const cor = root.querySelector<HTMLCanvasElement>('#cor-wave')!;
    drawWaveform(raw, store.engine.rawAnalyser, '#f472b6');
    drawWaveform(cor, store.engine.correctedAnalyser, '#4ade80');
  };
  const raf = () => {
    draw();
    timers.push(requestAnimationFrame(raf));
  };
  raf();

  const unsub = store.subscribe((s) => {
    const lat = root.querySelector('#lat-val');
    if (lat) lat.textContent = fmt(s.latencyMs, 1);
    const f0 = root.querySelector('#f0-val');
    if (f0) f0.textContent = s.latestStats?.voiced ? fmt(s.latestStats.f0, 0) : '—';
    const vad = root.querySelector('#vad-val');
    if (vad) vad.textContent = s.latestStats?.isSpeech ? '语音' : '静音/噪声';
    const sVal = root.querySelector('#s-val');
    if (sVal) sVal.textContent = fmt(s.correction, 3);
  });

  return () => {
    timers.forEach(cancelAnimationFrame);
    unsub();
  };
}

function controlsCard(): HTMLElement {
  const state = store.get();
  const startBtn = h('button', { class: 'btn primary', id: 'start-btn' }, state.running ? '音频运行中' : '启动音频链路');
  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    try {
      await store.startAudio();
      store.addRecord('校正系统上线，音频链路建立', 'system');
      startBtn.textContent = '音频运行中';
    } catch (err) {
      startBtn.disabled = false;
      alert('启动失败：' + (err instanceof Error ? err.message : String(err)));
    }
  });

  const diverSel = h('select', {}, ...DIVERS.map((d) => {
    const opt = h('option', { value: d.id }, `${d.id} ${d.name} · F0 ${d.f0Mean}Hz`);
    if (d.id === store.get().diver.id) opt.setAttribute('selected', 'true');
    return opt;
  }));
  diverSel.addEventListener('change', () => {
    const d = DIVERS.find((x) => x.id === diverSel.value)!;
    store.setDiver(d);
  });

  const bypass = h('input', { type: 'checkbox' }) as HTMLInputElement;
  bypass.checked = store.get().bypass;
  bypass.addEventListener('change', () => store.setBypass(bypass.checked));

  const valve = h('input', { type: 'range', min: '0', max: '0.2', step: '0.005', value: String(store.get().valveNoise) }) as HTMLInputElement;
  const bubble = h('input', { type: 'range', min: '0', max: '0.25', step: '0.005', value: String(store.get().bubbleNoise) }) as HTMLInputElement;
  const syncNoise = () => store.setNoise(Number(valve.value), Number(bubble.value));
  valve.addEventListener('input', syncNoise);
  bubble.addEventListener('input', syncNoise);

  const volume = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(store.get().volume) }) as HTMLInputElement;
  volume.addEventListener('input', () => store.setVolume(Number(volume.value)));

  return h('div', {},
    h('div', { class: 'row' }, startBtn, h('label', { class: 'switch' }, bypass, '旁路（听未校正氦语音）')),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, '潜水员嗓音', diverSel),
      h('label', { class: 'field' }, '监听音量', volume),
    ),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, `呼吸阀噪声 ${fmt(Number(valve.value), 3)}`, valve),
      h('label', { class: 'field' }, `气泡噪声 ${fmt(Number(bubble.value), 3)}`, bubble),
    ),
  );
}

function metricsRow(): HTMLElement {
  return h('div', { class: 'grid three', style: 'margin-top:12px' },
    h('div', { class: 'metric' }, h('div', { class: 'k' }, '算法延迟'), h('div', { class: 'v' }, h('span', { id: 'lat-val' }, '0.0'), h('span', { class: 'u' }, 'ms / 预算 60'))),
    h('div', { class: 'metric' }, h('div', { class: 'k' }, '音高 F0（保持不变）'), h('div', { class: 'v' }, h('span', { id: 'f0-val' }, '—'), h('span', { class: 'u' }, 'Hz'))),
    h('div', { class: 'metric' }, h('div', { class: 'k' }, 'VAD / 校正系数 s'), h('div', { class: 'v', style: 'font-size:16px;padding-top:8px' }, h('span', { id: 'vad-val' }, '—'), ' · s=', h('span', { id: 's-val', class: 'mono' }, '1.000'))),
  );
}

function quickPhrases(): HTMLElement {
  const wrap = h('div', {});
  const buttons = QUICK_PHRASES.map((text) => {
    const b = h('button', { class: 'btn' }, text);
    b.addEventListener('click', () => {
      const s = store.get();
      store.addRecord(`【${s.diver.name}】${text}`, 'diver', !s.bypass);
      setTimeout(() => {
        store.addRecord('海面监督台：收到', 'supervisor');
      }, 700);
    });
    return b;
  });
  const utterance = h('select', {},
    ...SCRIPTED_UTTERANCES.map((u, i) => h('option', { value: String(i) }, `合成语句 ${i + 1}：${u.join(' ')}`)),
  );
  utterance.addEventListener('change', () => {
    store.engine.updateSource(store.get().diver, store.get().correction, { utterance: Number(utterance.value) });
  });
  wrap.append(h('div', { class: 'row' }, ...buttons), h('div', { class: 'row' }, utterance));
  return wrap;
}

export function renderCallFeed(root: HTMLElement): void {
  clear(root);
  for (const rec of store.get().records) {
    const bubble = h('div', { class: `bubble ${rec.kind}` },
      h('div', { class: 'meta' }, `${rec.clock} · ${rec.diverId} · ${fmt(rec.depth, 0)} msw`),
      rec.text + (rec.kind === 'diver' ? (rec.corrected ? ' 〔校正通道〕' : ' 〔原始通道〕') : ''),
    );
    root.append(bubble);
  }
  root.scrollTop = root.scrollHeight;
}
