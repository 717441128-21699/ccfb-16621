import './ui/styles.css';
import { h, fmt } from './ui/dom.ts';
import { store, type PageId } from './state/store.ts';
import { renderCommsPage, renderCallFeed } from './ui/commsPage.ts';
import { renderDepthPage } from './ui/depthPage.ts';
import { renderFormantsPage } from './ui/formantsPage.ts';
import { renderLogPage } from './ui/logPage.ts';
import { formatMix } from './dsp/physics.ts';

const TABS: { id: PageId; label: string }[] = [
  { id: 'comms', label: '潜水员通话' },
  { id: 'depth', label: '舱压深度' },
  { id: 'formants', label: '共振峰显示' },
  { id: 'log', label: '通话记录' },
];

const app = document.querySelector<HTMLDivElement>('#app')!;
let cleanup: (() => void) | null = null;

function topbar(): HTMLElement {
  const chips = h('div', { class: 'status-chips', id: 'status-chips' });
  const bar = h('header', { class: 'topbar' },
    h('div', {},
      h('h1', {}, '氦语音实时校正系统'),
      h('div', { class: 'sub' }, '饱和潜水支持船 · 全极点声道建模 / 共振峰物理搬移 / AudioWorklet 实时处理'),
    ),
    chips,
  );
  return bar;
}

function refreshChips(): void {
  const s = store.get();
  const sample = store.diveLog.sample();
  const chips = document.querySelector('#status-chips');
  if (!chips) return;
  chips.replaceChildren(
    h('span', { class: `chip ${s.running ? 'live' : ''}` }, s.running ? '● 链路在线' : '○ 链路未启动'),
    h('span', { class: 'chip' }, '深度 ', h('b', {}, `${fmt(sample.depth, 1)} msw`)),
    h('span', { class: 'chip' }, '压力 ', h('b', {}, `${fmt(sample.pressure, 2)} bar`)),
    h('span', { class: 'chip mono' }, formatMix(sample.mix)),
    h('span', { class: 'chip' }, 's = ', h('b', { class: 'mono' }, fmt(sample.correction, 3))),
    h('span', { class: 'chip' }, s.bypass ? '旁路：原始氦语音' : '通道：校正输出'),
  );
}

function tabs(): HTMLElement {
  const nav = h('nav', { class: 'tabs' });
  for (const tab of TABS) {
    const btn = h('button', { type: 'button' }, tab.label);
    if (tab.id === store.get().page) btn.classList.add('active');
    btn.addEventListener('click', () => {
      store.goto(tab.id);
      mount();
    });
    nav.append(btn);
  }
  return nav;
}

function mount(): void {
  cleanup?.();
  const page = h('main', { id: 'page-root' });
  const existing = document.querySelector('#page-root');
  existing?.replaceWith(page);
  const s = store.get();
  if (s.page === 'comms') {
    cleanup = renderCommsPage(page);
    const feedTimer = window.setInterval(() => {
      const feed = page.querySelector<HTMLElement>('#call-feed');
      if (feed) renderCallFeed(feed);
    }, 500);
    const prev = cleanup;
    cleanup = () => {
      prev();
      clearInterval(feedTimer);
    };
  } else if (s.page === 'depth') {
    cleanup = renderDepthPage(page);
  } else if (s.page === 'formants') {
    cleanup = renderFormantsPage(page);
  } else {
    cleanup = renderLogPage(page);
  }
  // 同步 tab 高亮
  document.querySelectorAll('nav.tabs button').forEach((b, i) => {
    b.classList.toggle('active', TABS[i].id === s.page);
  });
  refreshChips();
}

app.append(topbar(), tabs(), h('main', { id: 'page-root' }));
store.subscribe(refreshChips);
mount();

// 启动即放一条系统记录
store.addRecord('系统上电，自检通过：FFT/LPC/Warp 模块就绪，等待音频链路启动', 'system');
