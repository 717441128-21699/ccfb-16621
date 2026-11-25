/**
 * 全局应用状态 —— 手写最小响应式 store（订阅/通知），不引入框架。
 */
import { AudioEngine } from '../audio/AudioEngine.ts';
import { DiveLog, DIVERS, type Diver } from '../model/diveLog.ts';
import type { WorkletStats } from '../worklets/messages.ts';

export type PageId = 'comms' | 'depth' | 'formants' | 'log';

export interface CallRecord {
  id: number;
  timeSec: number;
  clock: string;
  diverId: string;
  depth: number;
  text: string;
  corrected: boolean;
  kind: 'diver' | 'supervisor' | 'system';
}

export interface AppState {
  page: PageId;
  running: boolean;
  bypass: boolean;
  timeScale: number;
  depth: number;
  correction: number;
  beta: number;
  diver: Diver;
  valveNoise: number;
  bubbleNoise: number;
  volume: number;
  latestStats: WorkletStats | null;
  records: CallRecord[];
  latencyMs: number;
}

type Listener = (s: AppState) => void;

export class Store {
  readonly engine = new AudioEngine();
  readonly diveLog = new DiveLog();
  private state: AppState = {
    page: 'comms',
    running: false,
    bypass: false,
    timeScale: 30, // 模拟时钟倍速：1 真实秒 = 30 任务秒
    depth: 0,
    correction: 1,
    beta: 0.35,
    diver: DIVERS[0],
    valveNoise: 0.05,
    bubbleNoise: 0.08,
    volume: 0.9,
    latestStats: null,
    records: [],
    latencyMs: 0,
  };
  private listeners = new Set<Listener>();
  private recordSeq = 1;
  private clockTimer: number | null = null;

  get(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn(this.state));
  }

  patch(p: Partial<AppState>): void {
    this.state = { ...this.state, ...p };
    this.emit();
  }

  goto(page: PageId): void {
    this.patch({ page });
  }

  setDiver(diver: Diver): void {
    this.patch({ diver });
    if (this.state.running) {
      this.engine.updateSource(diver, this.state.correction, {
        valve: this.state.valveNoise,
        bubble: this.state.bubbleNoise,
      });
    }
  }

  setNoise(valve: number, bubble: number): void {
    this.patch({ valveNoise: valve, bubbleNoise: bubble });
    this.engine.updateSource(this.state.diver, this.state.correction, {
      valve,
      bubble,
    });
  }

  setBypass(bypass: boolean): void {
    this.engine.setBypass(bypass);
    this.patch({ bypass });
  }

  setVolume(v: number): void {
    this.engine.setVolume(v);
    this.patch({ volume: v });
  }

  setBeta(beta: number): void {
    this.patch({ beta });
    const s = this.diveLog.sample().correction;
    this.engine.setCorrection(s, beta, this.state.depth);
  }

  pushStats(stats: WorkletStats): void {
    this.state = { ...this.state, latestStats: stats, latencyMs: stats.latencyMs };
    this.emit();
  }

  addRecord(text: string, kind: CallRecord['kind'], corrected = false): void {
    const t = this.diveLog.timeSec;
    const rec: CallRecord = {
      id: this.recordSeq++,
      timeSec: t,
      clock: this.formatClock(t),
      diverId: this.state.diver.id,
      depth: this.diveLog.depthAt(t),
      text,
      corrected,
      kind,
    };
    this.patch({ records: [...this.state.records, rec] });
  }

  clearRecords(): void {
    this.patch({ records: [] });
  }

  private formatClock(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /** 启动模拟时钟：舱压深度按潜水日志连续推进，校正系数自动跟随 */
  startClock(): void {
    if (this.clockTimer !== null) return;
    let last = performance.now();
    this.clockTimer = window.setInterval(() => {
      const now = performance.now();
      const dtReal = (now - last) / 1000;
      last = now;
      const dtTask = dtReal * this.state.timeScale;
      this.diveLog.tick(dtTask);
      const sample = this.diveLog.sample();
      const correction = sample.correction;
      this.state = {
        ...this.state,
        depth: sample.depth,
        correction,
      };
      this.engine.setCorrection(correction, this.state.beta, sample.depth);
      this.emit();
      if (this.diveLog.timeSec >= this.diveLog.totalSec) this.stopClock();
    }, 100);
  }

  stopClock(): void {
    if (this.clockTimer !== null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  seek(taskSec: number): void {
    this.diveLog.seek(taskSec);
    const sample = this.diveLog.sample();
    this.engine.setCorrection(sample.correction, this.state.beta, sample.depth);
    this.patch({ depth: sample.depth, correction: sample.correction });
  }

  async startAudio(): Promise<void> {
    await this.engine.start();
    const sample = this.diveLog.sample();
    this.engine.setCorrection(sample.correction, this.state.beta, sample.depth);
    this.engine.updateSource(this.state.diver, sample.correction, {
      valve: this.state.valveNoise,
      bubble: this.state.bubbleNoise,
    });
    this.engine.onStats((s) => this.pushStats(s));
    this.patch({ running: true, correction: sample.correction, depth: sample.depth });
    this.startClock();
  }
}

export const store = new Store();
