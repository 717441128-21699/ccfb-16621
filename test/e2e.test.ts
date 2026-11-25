import { describe, expect, it } from 'vitest';
import { evaluateIntelligibility } from '../src/model/intelligibility.ts';
import { DIVERS, DIVE_PHASES } from '../src/model/diveLog.ts';
import { FrameProcessor, defaultConfig } from '../src/dsp/frameProcessor.ts';
import { HelioxSimulator, VOWEL_FORMANTS } from '../src/dsp/simulator.ts';
import { DEFAULT_BETA, DEFAULT_F_REF, inverseWarp } from '../src/dsp/warping.ts';
import { AIR_SPEED_20C, chamberTempKelvin, soundSpeed } from '../src/dsp/physics.ts';

const SR = 16000;
const TEMP_C = 31;

describe('端到端验收：共振峰恢复与可懂度', () => {
  // 选取浅/中/深三个代表性作业深度
  const scenarios = DIVE_PHASES.filter((p) => [60, 180, 200].includes(p.depthTo));

  it.each(scenarios.map((p) => [p.name, p.depthTo] as const))(
    '深度 %s（%d msw）：F1/F2 误差 ≤10%% 且听懂比例翻倍',
    (_name, depth) => {
      const phase = DIVE_PHASES.find((p) => p.depthTo === depth)!;
      const diver = DIVERS[0];
      const report = evaluateIntelligibility(diver, phase.mix, depth, TEMP_C, SR);
      expect(report.meanF1ErrorPct).toBeLessThanOrEqual(10);
      expect(report.meanF2ErrorPct).toBeLessThanOrEqual(10);
      expect(report.improvement).toBeGreaterThanOrEqual(2);
      expect(report.pass).toBe(true);
    },
  );

  it.each(DIVERS.map((d) => [d.name, d] as const))(
    '潜水员 %s：不同嗓音下均通过验收',
    (_name, diver) => {
      const phase = DIVE_PHASES.find((p) => p.depthTo === 180)!;
      const report = evaluateIntelligibility(diver, phase.mix, 180, TEMP_C, SR, 4242);
      expect(report.meanF1ErrorPct).toBeLessThanOrEqual(10);
      expect(report.meanF2ErrorPct).toBeLessThanOrEqual(10);
      expect(report.improvement).toBeGreaterThanOrEqual(2);
    },
  );

  it('未校正氦语音的共振峰显著偏离空气参考，证明测试有区分度', () => {
    const phase = DIVE_PHASES.find((p) => p.depthTo === 180)!;
    const s = AIR_SPEED_20C / soundSpeed(phase.mix, chamberTempKelvin(TEMP_C));
    // 800 Hz 空气共振峰在氦气中观测到的位置应明显上移
    const observed = inverseWarp(800, { s, beta: 0, fRef: DEFAULT_F_REF });
    void observed;
    // 直接用正向物理：氦语音频率 ≈ f / s
    expect(800 / s).toBeGreaterThan(1200);
    expect(s).toBeLessThan(0.7);
  });

  it('元音级直接验证：六个单元音校正后 F1/F2 回到空气参考 ±10%', () => {
    const phase = DIVE_PHASES.find((p) => p.depthTo === 180)!;
    const s = AIR_SPEED_20C / soundSpeed(phase.mix, chamberTempKelvin(TEMP_C));
    const diver = DIVERS[0];
    const sim = new HelioxSimulator({
      sampleRate: SR,
      diver,
      warp: { s, beta: DEFAULT_BETA, fRef: DEFAULT_F_REF },
      valveNoiseLevel: 0.04,
      bubbleNoiseLevel: 0.05,
      seed: 2026,
    });
    const proc = new FrameProcessor(defaultConfig(SR));
    proc.setCorrection(s, DEFAULT_BETA);

    for (const vowel of ['a', 'i', 'u', 'e', 'o', 'ü']) {
      const { audio } = sim.generate([vowel]);
      const hop = proc.cfg.hopSize;
      const block = new Float64Array(hop);
      const stats = [];
      for (let off = 0; off + hop <= audio.length; off += hop) {
        block.set(audio.subarray(off, off + hop));
        const { stats: st } = proc.process(block);
        if (st?.isSpeech) stats.push(st);
      }
      proc.reset();
      expect(stats.length).toBeGreaterThan(3);
      const mid = stats.slice(Math.floor(stats.length * 0.25), Math.ceil(stats.length * 0.85));
      // 最近邻匹配：按参考频率在每帧候选峰中取最接近者，再截尾均值，
      // 容忍帧级漏峰/错序（与可懂度评估器同一方法）
      const trimmed = (vals: number[]): number => {
        const v = vals.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
        if (v.length === 0) return NaN;
        const cut = Math.floor(v.length * 0.2);
        const core = v.slice(cut, v.length - cut || v.length);
        return core.reduce((a, b) => a + b, 0) / core.length;
      };
      const matchFormant = (refFreq: number): number => {
        const perFrame: number[] = [];
        for (const t of mid) {
          const candidates = t.formantsAir.map((f) => f.freq).filter((f) => f > 0);
          if (candidates.length === 0) continue;
          candidates.sort((a, b) => Math.abs(a - refFreq) - Math.abs(b - refFreq));
          if (Math.abs(candidates[0] - refFreq) / refFreq <= 0.4) perFrame.push(candidates[0]);
        }
        return trimmed(perFrame);
      };
      const ref1 = VOWEL_FORMANTS[vowel][0] / diver.vocalTractScale;
      const ref2 = VOWEL_FORMANTS[vowel][1] / diver.vocalTractScale;
      const f1 = matchFormant(ref1);
      const f2 = matchFormant(ref2);
      expect(Math.abs(f1 - ref1) / ref1, `元音 ${vowel} F1`).toBeLessThanOrEqual(0.1);
      expect(Math.abs(f2 - ref2) / ref2, `元音 ${vowel} F2`).toBeLessThanOrEqual(0.1);
    }
  });

  it('降噪后输出不含随句增长的直流偏置且能量稳定', () => {
    const phase = DIVE_PHASES.find((p) => p.depthTo === 180)!;
    const s = AIR_SPEED_20C / soundSpeed(phase.mix, chamberTempKelvin(TEMP_C));
    const sim = new HelioxSimulator({
      sampleRate: SR,
      diver: DIVERS[2],
      warp: { s, beta: DEFAULT_BETA, fRef: DEFAULT_F_REF },
      valveNoiseLevel: 0.08,
      bubbleNoiseLevel: 0.12,
      seed: 88,
    });
    const proc = new FrameProcessor(defaultConfig(SR));
    proc.setCorrection(s);
    const { audio } = sim.generate(['hai', 'yang', 'gong', 'cheng']);
    const hop = proc.cfg.hopSize;
    const block = new Float64Array(hop);
    const out: number[] = [];
    for (let off = 0; off + hop <= audio.length; off += hop) {
      block.set(audio.subarray(off, off + hop));
      out.push(...proc.process(block).output);
    }
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    expect(Math.abs(mean)).toBeLessThan(0.02);
    const rms = Math.sqrt(out.reduce((a, b) => a + b * b, 0) / out.length);
    expect(rms).toBeGreaterThan(0.01);
    expect(rms).toBeLessThan(2);
  });
});
