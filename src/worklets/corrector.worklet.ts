/**
 * 氦语音校正 Worklet：逐帧全极点声道建模 + 共振峰搬移 + 残差合成。
 * 所有重计算复用 src/dsp 下与 Node 测试完全相同的 FrameProcessor，
 * 保证"测试通过的算法"与"浏览器跑的算法"是同一份代码。
 */
import { FrameProcessor, defaultConfig } from '../dsp/frameProcessor.ts';
import type { FrameStats } from '../dsp/frameProcessor.ts';
import type { MainToWorklet, WorkletStats } from './messages.ts';

class CorrectorProcessor extends AudioWorkletProcessor {
  private readonly processor: FrameProcessor;
  private readonly hop: number;
  private readonly accum: Float32Array;
  private accLen = 0;
  private bypass = false;
  private statCounter = 0;
  private depth = 0;

  constructor() {
    super();
    const cfg = defaultConfig(sampleRate);
    this.processor = new FrameProcessor(cfg);
    this.processor.setCorrection(1);
    this.hop = cfg.hopSize;
    this.accum = new Float32Array(this.hop);
    this.port.onmessage = (ev: MessageEvent<MainToWorklet>) => this.handle(ev.data);
  }

  private handle(msg: MainToWorklet): void {
    if (msg.type === 'correction') {
      this.processor.setCorrection(msg.s, msg.beta);
      this.depth = msg.depth;
    } else if (msg.type === 'bypass') {
      this.bypass = msg.bypass;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const out = outputs[0][0];
    if (!input) {
      out.fill(0);
      return true;
    }
    if (this.bypass) {
      out.set(input);
      for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(input);
      return true;
    }

    let produced = 0;
    let latestStats: FrameStats | null = null;
    for (let i = 0; i < input.length; i++) {
      this.accum[this.accLen++] = input[i];
      if (this.accLen === this.hop) {
        const { output, stats } = this.processor.process(this.accum);
        for (let j = 0; j < this.hop && produced < out.length; j++, produced++) {
          out[produced] = output[j];
        }
        if (stats) latestStats = stats;
        this.accLen = 0;
      }
    }
    // 量子边界不足一帧时补零保持实时节拍
    for (; produced < out.length; produced++) out[produced] = 0;
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);

    if (latestStats && ++this.statCounter % 4 === 0) {
      const s: WorkletStats = {
        type: 'stats',
        frameIndex: latestStats.frameIndex,
        isSpeech: latestStats.isSpeech,
        voiced: latestStats.voiced,
        f0: latestStats.f0,
        clarity: latestStats.clarity,
        formantsHe: latestStats.formantsHe.map((f) => ({ freq: f.freq, bandwidth: f.bandwidth })),
        formantsAir: latestStats.formantsAir.map((f) => ({ freq: f.freq, bandwidth: f.bandwidth })),
        rms: latestStats.rms,
        s: latestStats.warp.s,
        depth: this.depth,
        latencyMs: (this.processor.algorithmicLatencySeconds * 1000),
      };
      this.port.postMessage(s);
    }
    return true;
  }
}

registerProcessor('heliox-corrector', CorrectorProcessor);
