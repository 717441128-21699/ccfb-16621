/** 全局应用状态（轻量发布订阅 store，无框架依赖） */

import type { GasMix } from '../dsp/physics.ts';
import type { FrameTelemetry } from '../dsp/unscrambler.ts';
import { SIM_DIVERS, type DiverVoice } from '../dsp/simulator.ts';
import { DIVE_META } from '../data/divedata.ts';

export type PageId = 'comms' | 'pressure' | 'formant' | 'log';

export interface CallRecord {
  id: string;
  timeLabel: string;
  diver: string;
  depthM: number;
  durationSec: number;
  corrected: boolean;
  blob?: Blob;
  mime: string;
  note?: string;
}

export interface AppState {
  page: PageId;
  running: boolean;
  correctionEnabled: boolean;
  source: 'mic' | 'demo';
  currentDiver: DiverVoice;
  /** 潜水日志时间轴位置 (min) */
  diveTimeMin: number;
  depthM: number;
  mix: GasMix;
  telemetry: FrameTelemetry | null;
  records: CallRecord[];
  latencyMs: number;
  diveId: string;
}

type Listener = (s: AppState) => void;

const initial: AppState = {
  page: 'comms',
  running: false,
  correctionEnabled: true,
  source: 'demo',
  currentDiver: SIM_DIVERS[0],
  diveTimeMin: 85,
  depthM: 180,
  mix: { he: 0.956, o2: 0.021, n2: 0.023 },
  telemetry: null,
  records: [],
  latencyMs: 0,
  diveId: DIVE_META.diveId,
};

class Store {
  private state: AppState = { ...initial };
  private listeners = new Set<Listener>();

  get(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn(this.state));
  }
}

export const store = new Store();
