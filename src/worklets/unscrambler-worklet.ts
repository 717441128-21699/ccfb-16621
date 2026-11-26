/**
 * 氦语音校正 AudioWorkletProcessor
 * --------------------------------
 * 逐帧全极点声道建模 + 共振峰搬移，运行在音频渲染线程。
 * 参数（深度/气体比例）通过消息实时更新，跟随潜水日志插值。
 * 算法全部来自 src/dsp（平台无关），本文件仅做音频线程适配。
 */

import { UnscramblerEngine, DEFAULT_CONFIG } from '../dsp/unscrambler.ts';
import { FrameFramer, OlaSynthesizer } from '../dsp/framing.ts';
import { estimatePitch } from '../dsp/pitch.ts';
import type { GasMix } from '../dsp/physics.ts';

interface WorkletParams {
  mix: GasMix;
  depthM: number;
  enabled: boolean;
  bypass: boolean;
}

class UnscramblerProcessor extends AudioWorkletProcessor {
  private readonly engine: UnscramblerEngine;
  private readonly framer: FrameFramer;
  private readonly ola: OlaSynthesizer;
  private readonly frameSize: number;
  private readonly hopSize: number;
  private params: WorkletParams = {
    mix: { he: 0.9, o2: 0.1, n2: 0 },
    depthM: 100,
    enabled: true,
    bypass: false,
  };
  private telemetryCounter = 0;

  constructor() {
    super();
    const cfg = { ...DEFAULT_CONFIG, sampleRate };
    this.engine = new UnscramblerEngine(cfg);
    this.frameSize = cfg.frameSize;
    this.hopSize = cfg.hopSize;
    this.framer = new FrameFramer({ frameSize: this.frameSize, hopSize: this.hopSize });
    this.ola = new OlaSynthesizer({ frameSize: this.frameSize, hopSize: this.hopSize });

    this.port.onmessage = (ev: MessageEvent<Partial<WorkletParams>>) => {
      this.params = { ...this.params, ...ev.data };
      if (ev.data.enabled === false) this.engine.reset();
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0][0];
    if (!input) {
      output.fill(0);
      return true;
    }

    if (this.params.bypass || !this.params.enabled) {
      output.set(input);
      return true;
    }

    const frames = this.framer.push(input);
    const chunks: Float32Array[] = [];
    for (const frame of frames) {
      const { frame: corrected, telemetry } = this.engine.processFrame(
        frame,
        this.params.mix,
        this.params.depthM,
        (f) => estimatePitch(f, sampleRate).f0,
      );
      chunks.push(this.ola.addFrame(corrected));

      // 每 3 帧（30 ms）上报一次遥测，降低消息开销
      this.telemetryCounter++;
      if (this.telemetryCounter % 3 === 0) {
        this.port.postMessage({ type: 'telemetry', telemetry });
      }
    }

    if (chunks.length === 0) {
      output.fill(0);
    } else {
      let off = 0;
      for (const c of chunks) {
        const n = Math.min(c.length, output.length - off);
        output.set(c.subarray(0, n), off);
        off += n;
      }
      if (off < output.length) output.fill(0, off);
    }
    return true;
  }
}

registerProcessor('helium-unscrambler', UnscramblerProcessor);
