/** 舱压深度页：实时深度/压力、声速校正系数、深度剖面曲线、阶段与事件 */
import { h, fmt } from './dom.ts';
import { store } from '../state/store.ts';
import { DIVE_PHASES, formatClock } from '../model/diveLog.ts';
import {
  AIR_SPEED_20C,
  chamberTempKelvin,
  formatMix,
  partialPressureO2,
  soundSpeed,
} from '../dsp/physics.ts';
import { drawLineChart } from './canvas.ts';

export function renderDepthPage(root: HTMLElement): () => void {
  const timers: number[] = [];
  const log = store.diveLog;

  root.append(
    h('div', { class: 'grid three' },
      metric('当前深度', 'depth-val', 'msw'),
      metric('舱内绝对压力', 'pres-val', 'bar'),
      metric('校正系数 s = c空气/c混合气', 's-val2', ''),
    ),
    h('div', { class: 'grid two', style: 'margin-top:14px' },
      h('div', { class: 'card' },
        h('h2', {}, '潜水深度剖面（随潜水日志自动推进）'),
        h('canvas', { id: 'depth-chart', height: '260' }),
        timeControls(),
      ),
      h('div', { class: 'card' },
        h('h2', {}, '混合气与声学参数'),
        gasPanel(),
        h('h2', { style: 'margin-top:18px' }, '任务阶段'),
        phaseTable(),
      ),
    ),
    h('div', { class: 'card', style: 'margin-top:14px' },
      h('h2', {}, '潜水日志事件'),
      eventTable(),
    ),
  );

  const refresh = () => {
    const sample = log.sample();
    const cMix = soundSpeed(sample.mix, chamberTempKelvin(log.chamberCelsius));
    root.querySelector<HTMLElement>('#depth-val')!.textContent = fmt(sample.depth, 1);
    root.querySelector<HTMLElement>('#pres-val')!.textContent = fmt(sample.pressure, 2);
    root.querySelector<HTMLElement>('#s-val2')!.textContent = fmt(sample.correction, 3);
    root.querySelector<HTMLElement>('#gas-mix')!.textContent = formatMix(sample.mix);
    root.querySelector<HTMLElement>('#gas-speed')!.textContent =
      `${fmt(cMix, 0)} m/s（空气 ${fmt(AIR_SPEED_20C, 0)} m/s）`;
    root.querySelector<HTMLElement>('#gas-ppo2')!.textContent =
      `${fmt(partialPressureO2(sample.mix, sample.depth), 2)} bar（安全窗 0.4~1.6）`;
    root.querySelector<HTMLElement>('#gas-temp')!.textContent =
      `${log.chamberCelsius} ℃（${fmt(chamberTempKelvin(log.chamberCelsius), 1)} K）`;
    root.querySelector<HTMLElement>('#clock-val')!.textContent = formatClock(log.timeSec);
    root.querySelector<HTMLElement>('#phase-val')!.textContent = sample.phase.name;
    root.querySelector<HTMLElement>('#ratio-note')!.textContent =
      `氦语音共振峰按 ${fmt(1 / sample.correction, 2)}× 上移，校正器反向搬移；` +
      '理想气体声速与绝对压力无关，深度通过各阶段配比进入校正系数。';

    const chart = root.querySelector<HTMLCanvasElement>('#depth-chart')!;
    const profile = log.profileSamples(20);
    drawLineChart(
      chart,
      [{ label: '深度 msw', color: '#38bdf8', points: profile.map((p) => ({ x: p.timeSec, y: p.depth })) }],
      {
        xLabel: '任务时间 s',
        yLabel: 'msw',
        xMax: log.totalSec,
        yMax: 210,
        markers: [{ x: log.timeSec, label: `当前 ${fmt(sample.depth, 0)}m`, color: '#fbbf24' }],
      },
    );
  };
  const tick = () => {
    refresh();
    timers.push(window.setTimeout(tick, 250));
  };
  tick();

  const seek = root.querySelector<HTMLInputElement>('#seek')!;
  seek.addEventListener('input', () => store.seek(Number(seek.value)));

  return () => timers.forEach(clearTimeout);
}

function metric(label: string, id: string, unit: string): HTMLElement {
  return h('div', { class: 'metric' },
    h('div', { class: 'k' }, label),
    h('div', { class: 'v' }, h('span', { id }), h('span', { class: 'u' }, unit)),
  );
}

function timeControls(): HTMLElement {
  const seek = h('input', {
    id: 'seek',
    type: 'range',
    min: '0',
    max: String(store.diveLog.totalSec),
    step: '10',
    value: '0',
    style: 'width:100%',
  }) as HTMLInputElement;
  const speed = h('select', {},
    ...[10, 30, 60, 120].map((x) =>
      h('option', { value: String(x), selected: x === store.get().timeScale ? 'true' : undefined }, `${x}× 加速`)),
  );
  speed.addEventListener('change', () => store.patch({ timeScale: Number(speed.value) }));
  return h('div', { class: 'row', style: 'margin-top:10px' },
    h('label', { class: 'field', style: 'flex:2' }, '拖动时间轴（加压/减压全过程系数自动跟随）', seek),
    h('label', { class: 'field' }, '模拟倍速', speed),
    h('div', { class: 'metric', style: 'flex:1' },
      h('div', { class: 'k' }, '任务时钟'),
      h('div', { class: 'v mono', id: 'clock-val', style: 'font-size:18px' }, '00:00')),
  );
}

function gasPanel(): HTMLElement {
  return h('div', { class: 'metric' },
    h('div', { class: 'row' }, h('span', { class: 'k' }, '当前配方'), h('b', { id: 'gas-mix', class: 'mono' })),
    h('div', { class: 'row' }, h('span', { class: 'k' }, '混合气声速'), h('b', { id: 'gas-speed', class: 'mono' })),
    h('div', { class: 'row' }, h('span', { class: 'k' }, '氧分压'), h('b', { id: 'gas-ppo2', class: 'mono' })),
    h('div', { class: 'row' }, h('span', { class: 'k' }, '舱温'), h('b', { id: 'gas-temp', class: 'mono' })),
    h('div', { class: 'row' }, h('span', { class: 'k' }, '当前阶段'), h('b', { id: 'phase-val' })),
    h('p', { class: 'muted', id: 'ratio-note', style: 'line-height:1.6' }),
  );
}

function phaseTable(): HTMLElement {
  return h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, '阶段'), h('th', {}, '时间'), h('th', {}, '深度 msw'), h('th', {}, 'He/O₂'))),
    h('tbody', {},
      ...DIVE_PHASES.map((p) => h('tr', {},
        h('td', { class: 'wrap' }, p.name),
        h('td', { class: 'mono' }, `${formatClock(p.startSec)}-${formatClock(p.endSec)}`),
        h('td', { class: 'mono' }, `${fmt(p.depthFrom, 0)}→${fmt(p.depthTo, 0)}`),
        h('td', { class: 'mono' }, `${fmt(p.mix.he * 100, 0)}/${fmt(p.mix.o2 * 100, 0)}`),
      )),
    ),
  );
}

function eventTable(): HTMLElement {
  const tbody = h('tbody', { id: 'event-body' });
  const render = () => {
    tbody.replaceChildren(...store.diveLog.entries.map((e) => h('tr', {},
      h('td', { class: 'mono' }, formatClock(e.timeSec)),
      h('td', { class: 'mono' }, fmt(e.depth, 0)),
      h('td', {}, h('span', { class: `tag ${e.level}` }, e.level.toUpperCase())),
      h('td', { class: 'wrap' }, e.text),
    )));
  };
  render();
  return h('div', {},
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '时间'), h('th', {}, '深度'), h('th', {}, '级别'), h('th', { class: 'wrap' }, '事件'))),
      tbody),
  );
}
