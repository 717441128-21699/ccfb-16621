/**
 * 主线程音频引擎：AudioContext 建图、Worklet 装载、
 * 模拟声源/麦克风流切换、校正旁路与统计订阅。
 *
 * 信号链：
 *   source(模拟声源 或 麦克风) → analyser(原始氦语音)
 *        → HelioxCorrectorWorklet → analyser(校正语音) → destination
 */
import type { Diver } from '../model/diveLog.ts';
import type { MainToWorklet, WorkletStats } from '../worklets/messages.ts';
import { DEFAULT_BETA } from '../dsp/warping.ts';

export type InputMode = 'simulator' | 'microphone';

export class AudioEngine {
  ctx: AudioContext | null = null;
  private sourceNode: AudioWorkletNode | null = null;
  private correctorNode: AudioWorkletNode | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private masterGain: GainNode | null = null;
  rawAnalyser: AnalyserNode | null = null;
  correctedAnalyser: AnalyserNode | null = null;
  bypass = false;
  inputMode: InputMode = 'simulator';
  private statsListeners = new Set<(s: WorkletStats) => void>();
  private workletBase = '';

  /** 输出采样率。16 kHz 足够覆盖 4 kHz 共振峰分析且降低 Worklet 算力 */
  readonly targetSampleRate = 16000;

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  onStats(fn: (s: WorkletStats) => void): () => void {
    this.statsListeners.add(fn);
    return () => this.statsListeners.delete(fn);
  }

  async start(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ sampleRate: this.targetSampleRate, latencyHint: 'interactive' });
    this.ctx = ctx;

    // worklet 由 vite.config 的 rollup 多入口打包到 dist/worklets/。
    // 构建期源目录无同名 .js，用 @vite-ignore 让 Vite 保留运行时 URL 解析
    const srcUrl = new URL(
      /* @vite-ignore */ '../worklets/simulatorSourceWorklet.js',
      import.meta.url,
    );
    const corUrl = new URL(
      /* @vite-ignore */ '../worklets/correctorWorklet.js',
      import.meta.url,
    );
    await ctx.audioWorklet.addModule(srcUrl);
    await ctx.audioWorklet.addModule(corUrl);
    this.workletBase = '';
    void this.workletBase;

    this.rawAnalyser = ctx.createAnalyser();
    this.rawAnalyser.fftSize = 1024;
    this.correctedAnalyser = ctx.createAnalyser();
    this.correctedAnalyser.fftSize = 1024;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.9;

    this.correctorNode = new AudioWorkletNode(ctx, 'heliox-corrector', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.correctorNode.port.onmessage = (ev: MessageEvent<WorkletStats>) => {
      if (ev.data?.type === 'stats') this.statsListeners.forEach((fn) => fn(ev.data));
    };

    this.correctorNode.connect(this.correctedAnalyser);
    this.correctedAnalyser.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    await this.attachSimulator();
  }

  private async attachSimulator(): Promise<void> {
    const ctx = this.ctx!;
    this.detachInput();
    this.sourceNode = new AudioWorkletNode(ctx, 'simulator-source', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.sourceNode.connect(this.rawAnalyser!);
    this.sourceNode.connect(this.correctorNode!);
  }

  private detachInput(): void {
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    this.micSource?.disconnect();
    this.micSource = null;
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
  }

  async switchInput(mode: InputMode, diver: Diver, s: number): Promise<void> {
    this.inputMode = mode;
    if (!this.ctx) return;
    if (mode === 'microphone') {
      this.detachInput();
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.micSource = this.ctx.createMediaStreamSource(this.micStream);
      this.micSource.connect(this.rawAnalyser!);
      this.micSource.connect(this.correctorNode!);
    } else {
      await this.attachSimulator();
      this.updateSource(diver, s);
    }
  }

  updateSource(diver: Diver, s: number, extra?: Partial<{ valve: number; bubble: number; utterance: number; running: boolean }>): void {
    if (!this.sourceNode || this.inputMode !== 'simulator') return;
    const msg: MainToWorklet = {
      type: 'sourceConfig',
      diver,
      s,
      beta: DEFAULT_BETA,
      valveNoise: extra?.valve ?? 0.05,
      bubbleNoise: extra?.bubble ?? 0.08,
      utteranceIndex: extra?.utterance ?? 0,
      running: extra?.running ?? true,
    };
    this.sourceNode.port.postMessage(msg);
  }

  setCorrection(s: number, beta: number, depth: number): void {
    const msg: MainToWorklet = { type: 'correction', s, beta, depth };
    this.correctorNode?.port.postMessage(msg);
    this.sourceNode?.port.postMessage(msg);
  }

  setBypass(bypass: boolean): void {
    this.bypass = bypass;
    this.correctorNode?.port.postMessage({ type: 'bypass', bypass } satisfies MainToWorklet);
  }

  setVolume(v: number): void {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }
  }

  /** 当前输出设备报告的往返延迟基线（ms），不含算法内部缓冲 */
  outputLatencyMs(): number {
    return (this.ctx?.baseLatency ?? 0) * 1000;
  }

  async suspend(): Promise<void> {
    await this.ctx?.suspend();
  }

  async resume(): Promise<void> {
    await this.ctx?.resume();
  }
}
