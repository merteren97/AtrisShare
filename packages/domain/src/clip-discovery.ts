import type { ClipCandidate, ClipSignals } from "./clips.js";
import type { MediaEdit } from "./media.js";
import type { Transcript } from "./transcription.js";
import type { z } from "zod";
import type { clipOptionsSchema } from "./clips.js";

const overlap = (a: number, b: number, c: number, d: number) => Math.max(0, Math.min(b, d) - Math.max(a, c));
const round = (n: number) => Math.round(n * 1000) / 1000;
/** Reproducible, language-neutral editorial hints. Scores are not predicted reach. */
export function discoverClips(transcript: Transcript, signals: ClipSignals, options: z.infer<typeof clipOptionsSchema>, history: MediaEdit | null,
  id: () => string): ClipCandidate[] {
  const duration = transcript.duration ?? 0;
  if (duration < options.minSeconds) return [];
  const boundaries = [...new Set([0, duration, ...transcript.segments.flatMap(s => [s.start, s.end]), ...signals.scenes,
    ...signals.silences.flatMap(s => [s.start, s.end])])].sort((a, b) => a - b);
  const pool: ClipCandidate[] = [];
  const cutsSpeech = (time: number) => {
    let low = 0, high = transcript.segments.length;
    while (low < high) { const middle = (low + high) >>> 1; if (transcript.segments[middle]!.start < time) low = middle + 1; else high = middle; }
    return low > 0 && transcript.segments[low - 1]!.end > time;
  };
  // Up to 10k transcript segments; inspect bounded windows, then de-duplicate overlaps.
  for (let index = 0; index < transcript.segments.length; index += Math.max(1, Math.ceil(transcript.segments.length / 1000))) {
    const first = transcript.segments[index]!;
    const start = Math.max(transcript.segments[index - 1]?.end ?? 0, first.start - .12), ideal = Math.min(duration, start + options.targetSeconds);
    if (duration - start < options.minSeconds) continue;
    const ends = boundaries.filter(t => t >= start + options.minSeconds && t <= Math.min(duration, start + options.maxSeconds));
    let end = Math.min(duration, start + options.maxSeconds), best = Infinity;
    for (const time of ends) {
      const cost = Math.abs(time - ideal) + (cutsSpeech(time) ? options.targetSeconds * .5 : 0);
      if (cost < best) { best = cost; end = time; }
    }
    if (end - start < options.minSeconds) continue;
    const indices: number[] = [];
    for (let n = index; n < transcript.segments.length && transcript.segments[n]!.start < end; n++) if (transcript.segments[n]!.end > start) indices.push(n);
    const selected = indices.map(n => transcript.segments[n]!);
    const speech = selected.reduce((sum, s) => sum + overlap(start, end, s.start, s.end), 0);
    const silence = signals.silences.reduce((sum, s) => sum + overlap(start, end, s.start, s.end), 0);
    const speechRatio = round(Math.min(1, speech / (end - start)));
    const ranges = history ? history.segments ?? [{ inSeconds: history.inSeconds, outSeconds: history.outSeconds }] : [];
    const historyOverlap = round(Math.min(1, ranges.reduce((sum, r) => sum + overlap(start, end, r.inSeconds, r.outSeconds), 0) / (end - start)));
    const last = selected.at(-1), sentenceBoundary = !!last && last.end <= end + .001 && /[.!?。！？]["'”’)]?$/u.test(last.text);
    const scenes = signals.scenes.filter(t => t >= start && t < end);
    const score = Math.round(Math.max(0, Math.min(100, 45 * speechRatio + 20 * (1 - Math.min(1, Math.abs(end - start - options.targetSeconds) / options.targetSeconds))
      + (sentenceBoundary ? 20 : 0) + Math.min(5, scenes.length * 2) + 10 * historyOverlap - 15 * silence / (end - start))));
    pool.push({ id: id(), score, reason: null, edit: { inSeconds: start, outSeconds: end, crop: "vertical", cropX: .5, gainDb: 0, caption: "" },
      evidence: { start, end, partialSpeech: selected.some(s => s.start < start || s.end > end), segmentTimes: selected.slice(0, 150).map(s => ({ start: s.start, end: s.end })),
        segmentIndices: indices.slice(0, 150), excerpt: selected.map(s => s.text).join(" ").slice(0, 1200), scenes, speechRatio, historyOverlap, sentenceBoundary },
      renderId: null, artifactId: null, publicationId: null });
  }
  const result: ClipCandidate[] = [];
  for (const candidate of pool.sort((a, b) => b.score - a.score || a.edit.inSeconds - b.edit.inSeconds)) {
    if (result.some(old => overlap(old.edit.inSeconds, old.edit.outSeconds, candidate.edit.inSeconds, candidate.edit.outSeconds)
      / Math.min(old.edit.outSeconds - old.edit.inSeconds, candidate.edit.outSeconds - candidate.edit.inSeconds) > .65)) continue;
    result.push(candidate); if (result.length === 24) break;
  }
  return result;
}

/** Caption chunks preserve actual segment timestamps. No fabricated word alignment. */
export function clipCaptions(transcript: Transcript, start: number, end: number) {
  const cues: { start: number; end: number; text: string }[] = [];
  for (const segment of transcript.segments) {
    if (segment.end <= start || segment.start >= end) continue;
    // Long whisper segments require human text correction; do not invent word timings.
    if (segment.text.length > 300) throw new Error("clip_caption_segment_too_long");
    cues.push({ start: Math.max(start, segment.start), end: Math.min(end, segment.end), text: segment.text });
    if (cues.length > 100) throw new Error("clip_caption_limit");
  }
  return cues;
}
