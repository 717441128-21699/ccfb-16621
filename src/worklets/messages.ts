/**
 * Worklet 线程消息协议（主线程 <-> AudioWorklet）
 */
import type { Diver } from '../model/diveLog.ts';

export interface CorrectionMessage {
  type: 'correction';
  /** c_air / c_mix */
  s: number;
  beta: number;
  depth: number;
}

export interface BypassMessage {
  type: 'bypass';
  bypass: boolean;
}

export interface SourceConfigMessage {
  type: 'sourceConfig';
  diver: Diver;
  s: number;
  beta: number;
  valveNoise: number;
  bubbleNoise: number;
  utteranceIndex: number;
  running: boolean;
}

export interface WorkletStats {
  type: 'stats';
  frameIndex: number;
  isSpeech: boolean;
  voiced: boolean;
  f0: number;
  clarity: number;
  formantsHe: { freq: number; bandwidth: number }[];
  formantsAir: { freq: number; bandwidth: number }[];
  rms: number;
  s: number;
  depth: number;
  /** 实测算法延迟 ms */
  latencyMs: number;
}

export type MainToWorklet = CorrectionMessage | BypassMessage | SourceConfigMessage;
