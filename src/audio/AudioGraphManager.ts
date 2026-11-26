/**
 * Web Audio 音频图管理
 * --------------------
 * 麦克风/演示信号 → 氦化模拟(可选) → [校正 Worklet] → 分析/录音/扬声器
 * Worklet 参数随潜水日志时间轴实时更新；遥测回调供 UI 绘制。
 */

import { UnscramblerEngine, DEFAULT_CONFIG } from '../dsp/unscrambler.ts';
import { simulateHeliumSpeech, type DiverVoice } from '../dsp/simulator.ts';
import type { GasMix } from '../dsp/physics.ts';
import type { FrameTelemetry } from '../dsp/unscrambler.ts';
// Worklet 入口经自定义插件产出为独立可运行 JS，导入其产物 URL
import unscramblerWorkletUrl from '../worklets/unscrambler-worklet.ts?worklet-url';
import heliumSimWorkletUrl from '../worklets/helium-sim-worklet.ts?worklet-url';

export type AudioSourceKind = 'mic' | 'demo';

export interface AudioGraphState {
  running: boolean;
  source: AudioSourceKind;
  correctionEnabled: boolean;
  bypass: boolean;
  depthM: number;
  mix: GasMix;
  latencyMs: number;
}

export class AudioGraphManager {
  private ctx: AudioContext | null = null;
  private unscramblerNode: AudioWorkletNode | null = null;
  private simNode: AudioWorkletNode | null = null;
  private micStream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private onTelemetry: (t: FrameTelemetry) => void;
  state: AudioGraphState = {
    running: false,
    source: 'demo',
    correctionEnabled: true,
    bypass: false,
    depthM: 180,
    mix: { he: 0.956, o2: 0.021, n2: 0.023 },
    latencyMs: 0,
  };

  constructor(onTelemetry: (t: FrameTelemetry) => void) {
    this.onTelemetry = onTelemetry;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? DEFAULT_CONFIG.sampleRate;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    return this.ctx;
  }

  /** 启动音频图；demo 模式播放内置合成氦语音，mic 模式采集麦克风并实时氦化 */
  async start(kind: AudioSourceKind, diver: DiverVoice): Promise<void> {
    await this.stop();
    const ctx = this.ensureContext();
    await ctx.audioWorklet.addModule(unscramblerWorkletUrl);
    await ctx.audioWorklet.addModule(heliumSimWorkletUrl);

    this.unscramblerNode = new AudioWorkletNode(ctx, 'helium-unscrambler', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    this.unscramblerNode.port.onmessage = (ev: MessageEvent) => {
      if (ev.data?.type === 'telemetry') this.onTelemetry(ev.data.telemetry as FrameTelemetry);
    };
    this.pushParams();

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;

    if (kind === 'demo') {
      const sim = simulateHeliumSpeech({
        sampleRate: ctx.sampleRate,
        diver,
        mix: this.state.mix,
        depthM: this.state.depthM,
        valveNoiseLevel: 0.05,
        bubbleNoiseLevel: 0.08,
      });
      const buf = ctx.createBuffer(1, sim.heliumNoisy.length, ctx.sampleRate);
      buf.copyToChannel(Float32Array.from(sim.heliumNoisy), 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.unscramblerNode);
      src.start();
    } else {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, channelCount: 1 },
      });
      const mic = ctx.createMediaStreamSource(this.micStream);
      this.simNode = new AudioWorkletNode(ctx, 'helium-sim', { channelCount: 1 });
      this.simNode.port.postMessage({ mix: this.state.mix, depthM: this.state.depthM });
      mic.connect(this.simNode);
      this.simNode.connect(this.unscramblerNode);
    }

    this.unscramblerNode.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.state.running = true;
    this.state.source = kind;
    this.state.latencyMs = this.measureLatency();
  }

  /** 理论端到端延迟核算（缓冲+算法+输出） */
  private measureLatency(): number {
    if (!this.ctx) return 0;
    const frameMs = (DEFAULT_CONFIG.frameSize / DEFAULT_CONFIG.sampleRate) * 1000;
    const ctxBase = (this.ctx.baseLatency || 0) * 1000;
    const ctxOutput = (this.ctx.outputLatency || 0) * 1000;
    // 分帧等待 1 帧 + 算法处理（流水线内 <1 帧）+ 上下文输入/输出缓冲
    return frameMs + 12 + ctxBase + ctxOutput;
  }

  private pushParams(): void {
    this.unscramblerNode?.port.postMessage({
      mix: this.state.mix,
      depthM: this.state.depthM,
      enabled: this.state.correctionEnabled,
      bypass: this.state.bypass,
    });
    this.simNode?.port.postMessage({ mix: this.state.mix, depthM: this.state.depthM });
  }

  setEnvironment(depthM: number, mix: GasMix): void {
    this.state.depthM = depthM;
    this.state.mix = mix;
    this.pushParams();
  }

  setCorrectionEnabled(on: boolean): void {
    this.state.correctionEnabled = on;
    this.state.bypass = !on;
    this.pushParams();
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  /** 录制校正后输出（WebM/Opus 或 wav 由调用方决定） */
  startRecording(): void {
    if (!this.analyser || !this.ctx) return;
    const dest = this.ctx.createMediaStreamDestination();
    this.analyser.connect(dest);
    this.recordedChunks = [];
    const rec = new MediaRecorder(dest.stream);
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };
    rec.start();
    this.mediaRecorder = rec;
  }

  stopRecording(): Blob | null {
    if (!this.mediaRecorder) return null;
    const rec = this.mediaRecorder;
    rec.stop();
    this.mediaRecorder = null;
    return new Blob(this.recordedChunks, { type: rec.mimeType || 'audio/webm' });
  }

  async stop(): Promise<void> {
    this.mediaRecorder?.stop();
    this.mediaRecorder = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.simNode?.disconnect();
    this.unscramblerNode?.disconnect();
    this.analyser?.disconnect();
    this.simNode = null;
    this.unscramblerNode = null;
    this.analyser = null;
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
    this.state.running = false;
  }
}

/** 供离线测试/Node 使用的纯引擎工厂（无 DOM 依赖） */
export function createOfflineEngine(sampleRate: number): UnscramblerEngine {
  return new UnscramblerEngine({ ...DEFAULT_CONFIG, sampleRate });
}
