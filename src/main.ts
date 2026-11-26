/** 应用入口与标签页路由 */

import './styles.css';
import { store, type PageId } from './state/store.ts';
import { renderCommsPage } from './pages/comms.ts';
import { renderPressurePage } from './pages/pressure.ts';
import { renderFormantPage } from './pages/formant.ts';
import { renderLogPage } from './pages/log.ts';
import { AudioGraphManager } from './audio/AudioGraphManager.ts';
import { sampleDiveLog } from './data/divedata.ts';
import type { FrameTelemetry } from './dsp/unscrambler.ts';

const TABS: { id: PageId; label: string }[] = [
  { id: 'comms', label: '潜水员通话' },
  { id: 'pressure', label: '舱压深度' },
  { id: 'formant', label: '共振峰显示' },
  { id: 'log', label: '通话记录' },
];

/** 全局唯一音频图 */
export let audioGraph: AudioGraphManager;

function renderTabs(): void {
  const el = document.getElementById('tabs')!;
  el.innerHTML = '';
  for (const t of TABS) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (store.get().page === t.id ? ' active' : '');
    btn.textContent = t.label;
    btn.onclick = () => store.set({ page: t.id });
    el.appendChild(btn);
  }
}

const pageRoot = document.getElementById('page-root')!;

function renderPage(): void {
  renderTabs();
  pageRoot.innerHTML = '';
  switch (store.get().page) {
    case 'comms':
      renderCommsPage(pageRoot);
      break;
    case 'pressure':
      renderPressurePage(pageRoot);
      break;
    case 'formant':
      renderFormantPage(pageRoot);
      break;
    case 'log':
      renderLogPage(pageRoot);
      break;
  }
}

function updateTopbar(): void {
  const s = store.get();
  const el = document.getElementById('topbar-status')!;
  const ppo2 = s.mix.o2 * (1 + s.depthM / 10);
  el.textContent =
    `作业票 ${s.diveId}\n` +
    `深度 ${s.depthM.toFixed(1)} m · ppO₂ ${ppo2.toFixed(2)} bar · 延迟 ${s.latencyMs.toFixed(1)} ms`;
}

/**
 * 潜水日志时间轴驱动：每秒推进 1 个日志分钟（演示加速），
 * 深度与氦氧配比自动插值并下发 Worklet。
 */
let diveTimer: number | null = null;
function startDiveClock(): void {
  if (diveTimer !== null) return;
  diveTimer = window.setInterval(() => {
    const s = store.get();
    if (!s.running) return;
    const next = Math.min(360, s.diveTimeMin + 1);
    const { depthM, mix } = sampleDiveLog(next);
    audioGraph?.setEnvironment(depthM, mix);
    store.set({ diveTimeMin: next, depthM, mix });
  }, 1000);
}

export function bootstrap(): void {
  audioGraph = new AudioGraphManager((telemetry: FrameTelemetry) => {
    store.set({ telemetry });
  });

  const lastPageRef = { current: store.get().page as PageId };

  store.subscribe(() => {
    renderTabs();
    updateTopbar();
  });
  store.subscribe((s) => {
    // 页面切换时重渲染；同页内状态变化由各页面自行订阅
    if (lastPageRef.current !== s.page) {
      lastPageRef.current = s.page;
      renderPage();
    }
  });

  renderPage();
  updateTopbar();
  startDiveClock();
}

bootstrap();
