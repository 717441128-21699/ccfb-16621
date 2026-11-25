/** 通话记录页：逐条通话/系统事件、导出 JSON、离线清晰度验收测试 */
import { h, fmt } from './dom.ts';
import { store } from '../state/store.ts';
import { DIVERS, DIVE_PHASES } from '../model/diveLog.ts';
import { evaluateIntelligibility, type IntelligibilityReport } from '../model/intelligibility.ts';

export function renderLogPage(root: HTMLElement): () => void {
  root.append(
    h('div', { class: 'grid two' },
      h('div', { class: 'card' },
        h('h2', {}, '通话与事件记录'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', id: 'export-json' }, '导出记录 JSON'),
          h('button', { class: 'btn danger', id: 'clear-log' }, '清空通话记录'),
        ),
        recordTable(),
      ),
      h('div', { class: 'card' },
        h('h2', {}, '清晰度验收测试（离线全量评估）'),
        testPanel(),
      ),
    ),
  );

  root.querySelector<HTMLButtonElement>('#clear-log')!.addEventListener('click', () => {
    store.clearRecords();
    mountTable();
  });
  root.querySelector<HTMLButtonElement>('#export-json')!.addEventListener('click', () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      diveTotalSec: store.diveLog.totalSec,
      records: store.get().records,
      diveEvents: store.diveLog.entries,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: 'heliox-call-log.json' }) as HTMLAnchorElement;
    a.click();
    URL.revokeObjectURL(url);
  });

  mountTable();
  return () => undefined;
}

let tableHost: HTMLElement | null = null;

function mountTable(): void {
  if (!tableHost) return;
  tableHost.replaceChildren(
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '时间'), h('th', {}, '潜水员'), h('th', {}, '深度'),
        h('th', {}, '通道'), h('th', { class: 'wrap' }, '内容'))),
      h('tbody', {},
        ...store.get().records.map((r) => h('tr', {},
          h('td', { class: 'mono' }, r.clock),
          h('td', {}, r.diverId),
          h('td', { class: 'mono' }, fmt(r.depth, 0)),
          h('td', {}, h('span', { class: `tag ${r.kind === 'system' ? 'warn' : r.corrected ? 'ok' : 'bad'}` },
            r.kind === 'system' ? '系统' : r.corrected ? '校正' : '原始')),
          h('td', { class: 'wrap' }, r.text),
        )),
      ),
    ),
  );
}

function recordTable(): HTMLElement {
  tableHost = h('div', { style: 'max-height:420px;overflow-y:auto' });
  return tableHost;
}

function testPanel(): HTMLElement {
  const host = h('div', {});
  const diverSel = h('select', {}, ...DIVERS.map((d) => h('option', { value: d.id }, `${d.id} ${d.name}`)));
  const phaseSel = h('select', {},
    ...DIVE_PHASES.filter((p) => p.depthTo >= 50).map((p, i) =>
      h('option', { value: String(i) }, `${p.name} · ${fmt(p.depthTo, 0)} msw · He${fmt(p.mix.he * 100, 0)}`)),
  );
  const runBtn = h('button', { class: 'btn primary' }, '运行 20 词清晰度评估');
  const result = h('div', { id: 'test-result' });
  runBtn.addEventListener('click', () => {
    runBtn.disabled = true;
    result.replaceChildren(h('p', { class: 'muted' }, '评估中（逐词 LPC 建模 + 共振峰比对）…'));
    setTimeout(() => {
      const diver = DIVERS.find((d) => d.id === diverSel.value)!;
      const phase = DIVE_PHASES.filter((p) => p.depthTo >= 50)[Number(phaseSel.value)];
      const report = evaluateIntelligibility(diver, phase.mix, phase.depthTo, store.diveLog.chamberCelsius);
      result.replaceChildren(renderReport(report));
      runBtn.disabled = false;
    }, 30);
  });
  host.append(
    h('div', { class: 'row' },
      h('label', { class: 'field' }, '潜水员', diverSel),
      h('label', { class: 'field' }, '深度/配方', phaseSel),
    ),
    h('div', { class: 'row' }, runBtn),
    result,
  );
  return host;
}

function renderReport(r: IntelligibilityReport): HTMLElement {
  const pass = h('span', { class: r.pass ? 'pass' : 'fail' }, r.pass ? '验收通过 ✓' : '未达标 ✗');
  return h('div', {},
    h('div', { class: 'grid three', style: 'margin:10px 0' },
      box('F1 平均误差', `${fmt(r.meanF1ErrorPct, 2)}%`, r.meanF1ErrorPct <= 10),
      box('F2 平均误差', `${fmt(r.meanF2ErrorPct, 2)}%`, r.meanF2ErrorPct <= 10),
      box('听懂比例提升', `${fmt(r.improvement, 2)}×`, r.improvement >= 2),
    ),
    h('p', { class: 'muted' },
      `深度 ${fmt(r.depth, 0)} msw，s=${fmt(r.s, 3)}；校正后听懂率 ${fmt(r.recognitionCorrected * 100, 1)}%，` +
      `未校正 ${fmt(r.recognitionRaw * 100, 1)}%；平均对数谱距离 ${fmt(r.meanSpectralDistortionDb, 2)} dB。验收结论：`),
    h('p', {}, pass),
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '词'), h('th', {}, '元音'), h('th', {}, 'F1 误差'), h('th', {}, 'F2 误差'), h('th', {}, '识别'))),
      h('tbody', {},
        ...r.words.map((w) => h('tr', {},
          h('td', {}, w.text),
          h('td', {}, w.targetVowel),
          h('td', { class: 'mono' }, fmt(w.f1ErrorPct, 1) + '%'),
          h('td', { class: 'mono' }, fmt(w.f2ErrorPct, 1) + '%'),
          h('td', {}, h('span', { class: `tag ${w.recognized ? 'ok' : 'bad'}` }, w.recognized ? '听懂' : '混淆')),
        )),
      ),
    ),
  );
}

function box(k: string, v: string, ok: boolean): HTMLElement {
  return h('div', { class: 'metric' },
    h('div', { class: 'k' }, k),
    h('div', { class: `v ${ok ? 'pass' : 'fail' }`, style: 'font-size:20px' }, v),
  );
}
