/**
 * AudioWorklet 全局作用域类型声明
 * Worklet 运行在独立的 AudioWorkletGlobalScope，没有 DOM 的 Window 类型，
 * 这里声明处理器基类、注册函数与全局 sampleRate。
 */

interface AudioWorkletProcessorImpl {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters?: Record<string, Float32Array>): boolean;
}

interface AudioWorkletProcessorConstructor {
  new (): AudioWorkletProcessorImpl;
}

declare class AudioWorkletProcessor implements AudioWorkletProcessorImpl {
  constructor();
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters?: Record<string, Float32Array>): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: AudioWorkletProcessorConstructor,
): void;

declare const sampleRate: number;
