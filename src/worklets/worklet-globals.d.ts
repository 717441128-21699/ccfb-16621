/**
 * AudioWorklet 全局作用域的最小环境声明。
 * AudioWorkletProcessor / registerProcessor / 全局 sampleRate
 * 不属于 lib.dom，需在此声明以便 worklet 文件通过 tsc 检查。
 */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters?: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: typeof AudioWorkletProcessor,
): void;

declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;
