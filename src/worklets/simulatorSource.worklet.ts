/**
 * 氦语音模拟声源 Worklet：在音频线程实时合成"面罩麦克风信号"。
 * 复用 HelioxSimulator 的共振峰合成逻辑，以 render quantum 为粒度输出。
 */
import { HelioxSimulator, SCRIPTED_UTTERANCES } from '../dsp/simulator.ts';
import { DEFAULT_BETA, DEFAULT_F_REF } from '../dsp/warping.ts';
import type { MainToWorklet } from './messages.ts';
import type { Diver } from '../model/diveLog.ts';

class SimulatorSourceProcessor extends AudioWorkletProcessor {
  private sim: HelioxSimulator | null = null;
  private buffer: Float64Array = new Float64Array(0);
  private readPos = 0;
  private utteranceIndex = 0;
  private running = true;
  private diver: Diver;
  private s = 0.7;
  private beta = DEFAULT_BETA;
  private valveNoise = 0.05;
  private bubbleNoise = 0.08;
  private seed = 20261126;

  constructor() {
    super();
    this.diver = {
      id: 'D01',
      name: '陈海生',
      role: '主潜水员',
      f0Mean: 118,
      f0Jitter: 9,
      vocalTractScale: 1.02,
    };
    this.port.onmessage = (ev: MessageEvent<MainToWorklet>) => this.handle(ev.data);
    this.rebuild();
  }

  private handle(msg: MainToWorklet): void {
    if (msg.type === 'sourceConfig') {
      this.diver = msg.diver;
      this.s = msg.s;
      this.beta = msg.beta;
      this.valveNoise = msg.valveNoise;
      this.bubbleNoise = msg.bubbleNoise;
      this.utteranceIndex = msg.utteranceIndex;
      this.running = msg.running;
      this.rebuild();
    } else if (msg.type === 'correction') {
      this.s = msg.s;
      this.beta = msg.beta;
      this.rebuild();
    }
  }

  private rebuild(): void {
    this.sim = new HelioxSimulator({
      sampleRate: sampleRate,
      diver: this.diver,
      warp: { s: this.s, beta: this.beta, fRef: DEFAULT_F_REF },
      valveNoiseLevel: this.valveNoise,
      bubbleNoiseLevel: this.bubbleNoise,
      seed: this.seed + this.utteranceIndex * 97,
    });
    this.generateNext();
  }

  private generateNext(): void {
    if (!this.sim) return;
    const syllables =
      SCRIPTED_UTTERANCES[this.utteranceIndex % SCRIPTED_UTTERANCES.length];
    const { audio } = this.sim.generate(syllables);
    // 句间补 0.6 s 停顿
    const gap = new Float64Array(Math.round(sampleRate * 0.6));
    this.buffer = new Float64Array(audio.length + gap.length);
    this.buffer.set(audio, 0);
    this.buffer.set(gap, audio.length);
    this.readPos = 0;
    this.utteranceIndex++;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const block = out[0];
    if (!this.running || !this.sim) {
      for (const ch of out) ch.fill(0);
      return true;
    }
    for (let i = 0; i < block.length; i++) {
      if (this.readPos >= this.buffer.length) this.generateNext();
      const v = this.buffer[this.readPos++];
      for (const ch of out) ch[i] = v;
    }
    return true;
  }
}

registerProcessor('simulator-source', SimulatorSourceProcessor);
