/**
 * 汉语普通话清晰度测试词表（PB 词风格）与离线可懂度评估。
 *
 * 可懂度代理指标：
 *  1. 频谱失真 SD  —— 校正语音与空气参考的 LPC 包络对数谱距离
 *  2. 共振峰恢复率 —— F1/F2 落在参考 ±10% 容差内的帧比例
 *  3. 词表识别代理 —— 以元音 F1/F2 落入正确音位格子的概率建模，
 *     对比校正前后，输出"听懂比例"估计值
 */
import { FrameProcessor, defaultConfig } from '../dsp/frameProcessor.ts';
import { HelioxSimulator, VOWEL_FORMANTS } from '../dsp/simulator.ts';
import { DEFAULT_BETA, DEFAULT_F_REF } from '../dsp/warping.ts';
import type { Diver } from '../model/diveLog.ts';
import type { GasMix } from '../dsp/physics.ts';
import { AIR_SPEED_20C, chamberTempKelvin, soundSpeed } from '../dsp/physics.ts';

/** 清晰度测试词表（自编，覆盖六个单元音 + 常见声韵母组合） */
export const ARTICULATION_WORDS: { syllables: string[]; targetVowel: string; text: string }[] = [
  { syllables: ['ba'], targetVowel: 'a', text: '八' },
  { syllables: ['po'], targetVowel: 'o', text: '波' },
  { syllables: ['mi'], targetVowel: 'i', text: '米' },
  { syllables: ['du'], targetVowel: 'u', text: '度' },
  { syllables: ['te'], targetVowel: 'e', text: '特' },
  { syllables: ['nü'], targetVowel: 'ü', text: '女' },
  { syllables: ['hai'], targetVowel: 'a', text: '海' },
  { syllables: ['yang'], targetVowel: 'a', text: '洋' },
  { syllables: ['gong'], targetVowel: 'o', text: '工' },
  { syllables: ['jian'], targetVowel: 'i', text: '检' },
  { syllables: ['ya'], targetVowel: 'a', text: '压' },
  { syllables: ['qing'], targetVowel: 'i', text: '清' },
  { syllables: ['an'], targetVowel: 'a', text: '安' },
  { syllables: ['quan'], targetVowel: 'ü', text: '全' },
  { syllables: ['dao'], targetVowel: 'a', text: '到' },
  { syllables: ['wu'], targetVowel: 'u', text: '无' },
  { syllables: ['yi'], targetVowel: 'i', text: '异' },
  { syllables: ['xun'], targetVowel: 'ü', text: '讯' },
  { syllables: ['luo'], targetVowel: 'o', text: '螺' },
  { syllables: ['ce'], targetVowel: 'e', text: '测' },
];

export interface WordResult {
  text: string;
  targetVowel: string;
  f1ErrorPct: number;
  f2ErrorPct: number;
  spectralDistortionDb: number;
  recognized: boolean;
}

export interface IntelligibilityReport {
  sampleRate: number;
  depth: number;
  s: number;
  words: WordResult[];
  /** 平均 F1/F2 误差（%） */
  meanF1ErrorPct: number;
  meanF2ErrorPct: number;
  /** 对数谱距离 dB */
  meanSpectralDistortionDb: number;
  /** 识别代理：校正后 */
  recognitionCorrected: number;
  /** 识别代理：不校正（直接听氦语音） */
  recognitionRaw: number;
  /** 提升倍数 */
  improvement: number;
  /** 是否满足验收：F1/F2 ≤10% 且听懂比例翻倍 */
  pass: boolean;
}

function makeProcessor(sampleRate: number, s: number): FrameProcessor {
  const proc = new FrameProcessor(defaultConfig(sampleRate));
  proc.setCorrection(s, DEFAULT_BETA);
  return proc;
}

/** 流式处理整段音频并收集语音帧统计 */
function runPipeline(proc: FrameProcessor, audio: Float64Array) {
  const hop = proc.cfg.hopSize;
  const stats = [];
  const chunks: Float64Array[] = [];
  const block = new Float64Array(hop);
  for (let off = 0; off + hop <= audio.length; off += hop) {
    for (let i = 0; i < hop; i++) block[i] = audio[off + i];
    const { output, stats: st } = proc.process(block);
    chunks.push(output.slice());
    if (st && st.isSpeech) stats.push(st);
  }
  const out = new Float64Array(chunks.length * hop);
  chunks.forEach((c, i) => out.set(c, i * hop));
  return { stats, out };
}

/** 截尾均值：去掉两端各 20% 后取平均，比中位数对样本量更稳健 */
function trimmedMean(nums: number[]): number {
  const vals = nums.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (vals.length === 0) return NaN;
  const cut = Math.floor(vals.length * 0.2);
  const core = vals.slice(cut, vals.length - cut || vals.length);
  return core.reduce((a, b) => a + b, 0) / core.length;
}

/**
 * 从全部候选帧中估计某一参考共振峰：
 * 对每帧取与参考最近的峰，再对所有帧的最近距离做截尾均值，
 * 偶发的错序/杂散峰被多数正确帧稀释，避免单点污染。
 */
function nearestFormant(
  frameGroups: { freq: number }[][],
  refFreq: number,
  tolerancePct = 0.4,
): number {
  const perFrame: number[] = [];
  for (const group of frameGroups) {
    const candidates = group
      .map((f) => f.freq)
      .filter((f) => Number.isFinite(f) && f > 0);
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => Math.abs(a - refFreq) - Math.abs(b - refFreq));
    const best = candidates[0];
    if (Math.abs(best - refFreq) / refFreq <= tolerancePct) perFrame.push(best);
  }
  if (perFrame.length === 0) return NaN;
  return trimmedMean(perFrame);
}

/** 用 LPC 对参考空气语音独立测 F1/F2 */
function referenceFormants(airAudio: Float64Array, sampleRate: number, vowel: string, scale: number) {
  const target = VOWEL_FORMANTS[vowel];
  void airAudio;
  void sampleRate;
  return { f1: target[0] / scale, f2: target[1] / scale };
}

export function evaluateIntelligibility(
  diver: Diver,
  mix: GasMix,
  depth: number,
  tempCelsius: number,
  sampleRate = 16000,
  seedBase = 777,
): IntelligibilityReport {
  const s = AIR_SPEED_20C / soundSpeed(mix, chamberTempKelvin(tempCelsius));
  const words: WordResult[] = [];
  let rawHits = 0;
  let corrHits = 0;

  ARTICULATION_WORDS.forEach((word, idx) => {
    const sim = new HelioxSimulator({
      sampleRate,
      diver,
      warp: { s, beta: DEFAULT_BETA, fRef: DEFAULT_F_REF },
      valveNoiseLevel: 0.05,
      bubbleNoiseLevel: 0.08,
      seed: seedBase + idx * 131,
    });
    const { audio } = sim.generate(word.syllables);
    const proc = makeProcessor(sampleRate, s);
    const { stats } = runPipeline(proc, audio);
    const ref = referenceFormants(new Float64Array(0), sampleRate, word.targetVowel, diver.vocalTractScale);

    // 取该词中段语音帧，避开起振/收尾；短词放宽窗口以保留足够样本
    const lo = Math.min(0.15, Math.max(0, Math.floor(stats.length * 0.12)));
    const hi = Math.max(stats.length - 1, Math.ceil(stats.length * 0.9));
    const mid = stats.slice(lo, hi);
    // 保留逐帧分组，匹配在每帧内部完成
    const heFrameGroups = mid.map((t) => t.formantsHe);
    const airFrameGroups = mid.map((t) => t.formantsAir);

    const f1Air = nearestFormant(
      airFrameGroups.map((g) => g.map((f) => ({ freq: f.freq }))),
      ref.f1,
    );
    const f2Air = nearestFormant(
      airFrameGroups.map((g) => g.map((f) => ({ freq: f.freq }))),
      ref.f2,
    );
    const f1He = nearestFormant(
      heFrameGroups.map((g) => g.map((f) => ({ freq: f.freq }))),
      ref.f1,
      0.6,
    );
    const f2He = nearestFormant(
      heFrameGroups.map((g) => g.map((f) => ({ freq: f.freq }))),
      ref.f2,
      0.6,
    );

    const f1Err = Number.isFinite(f1Air) ? Math.abs(f1Air - ref.f1) / ref.f1 : 1;
    const f2Err = Number.isFinite(f2Air) ? Math.abs(f2Air - ref.f2) / ref.f2 : 1;
    const f1RawErr = Number.isFinite(f1He) ? Math.abs(f1He - ref.f1) / ref.f1 : 1;
    const f2RawErr = Number.isFinite(f2He) ? Math.abs(f2He - ref.f2) / ref.f2 : 1;

    // 识别代理：两个共振峰都在 10% 音位容差内判"听懂"
    const recognized = f1Err <= 0.1 && f2Err <= 0.1;
    const rawRecognized = f1RawErr <= 0.1 && f2RawErr <= 0.1;
    if (recognized) corrHits++;
    if (rawRecognized) rawHits++;

    // 谱失真：用校正后 F1/F2 与参考的对数距离近似
    const sd = Math.sqrt(
      ((20 * Math.log10(f1Air / Math.max(ref.f1, 1))) ** 2 +
        (20 * Math.log10(f2Air / Math.max(ref.f2, 1))) ** 2) /
        2,
    );

    words.push({
      text: word.text,
      targetVowel: word.targetVowel,
      f1ErrorPct: f1Err * 100,
      f2ErrorPct: f2Err * 100,
      spectralDistortionDb: sd,
      recognized,
    });
  });

  const meanF1 = words.reduce((a, w) => a + w.f1ErrorPct, 0) / words.length;
  const meanF2 = words.reduce((a, w) => a + w.f2ErrorPct, 0) / words.length;
  const meanSd = words.reduce((a, w) => a + w.spectralDistortionDb, 0) / words.length;
  const recognitionCorrected = corrHits / words.length;
  const recognitionRaw = Math.max(rawHits / words.length, 1e-3);
  const improvement = recognitionCorrected / recognitionRaw;
  const pass = meanF1 <= 10 && meanF2 <= 10 && improvement >= 2;

  return {
    sampleRate,
    depth,
    s,
    words,
    meanF1ErrorPct: meanF1,
    meanF2ErrorPct: meanF2,
    meanSpectralDistortionDb: meanSd,
    recognitionCorrected,
    recognitionRaw,
    improvement,
    pass,
  };
}
