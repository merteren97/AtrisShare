import { z } from "zod";
import { idSchema } from "./workspace.js";
import { studioContextSchema, type StudioArtifact } from "./studio.js";
import { editSchema, type MediaEdit } from "./media.js";

export const sequenceProfileSchema = z.object({ width: z.number().int().min(128).max(3840).multipleOf(2), height: z.number().int().min(128).max(3840).multipleOf(2),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]), sampleRate: z.literal(48000) }).strict();
export const sequenceClipSchema = z.object({ id: idSchema, sourceArtifactId: idSchema, sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  inFrame: z.number().int().nonnegative(), outFrame: z.number().int().positive(), gapBeforeFrames: z.number().int().nonnegative().max(216000).default(0),
  crop: z.enum(["original", "vertical", "square"]), gainDb: z.number().finite().min(-60).max(24),
  caption: z.string().max(2000).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u), cropX: z.number().finite().min(0).max(1).optional(),
  timedCaptions: z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive(), text: z.string().min(1).max(300).regex(/^[^\u0000-\u001f\u007f]*$/u) }).strict()).max(100).optional()
}).strict().refine(c => c.outFrame > c.inFrame, "sequence_bounds");
export type SequenceClip = z.infer<typeof sequenceClipSchema>;
export type SequenceProfile = z.infer<typeof sequenceProfileSchema>;
export const sequenceStateSchema = z.object({ profile: sequenceProfileSchema, clips: z.array(sequenceClipSchema).max(128) }).strict();
export type SequenceState = z.infer<typeof sequenceStateSchema>;
export interface SequenceSnapshot extends SequenceState { schemaVersion: 1; id: string; context: { accountId: string; projectId: string }; revision: number; cursor: number; historyLength: number }
export const sequenceOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("appendClips"), clips: z.array(sequenceClipSchema).min(1).max(128) }).strict(),
  z.object({ type: z.literal("insertClip"), index: z.number().int().nonnegative(), clip: sequenceClipSchema }).strict(),
  z.object({ type: z.literal("trimClip"), clipId: idSchema, inFrame: z.number().int().nonnegative(), outFrame: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("splitClip"), clipId: idSchema, atFrame: z.number().int().positive(), newClipId: idSchema }).strict(),
  z.object({ type: z.literal("moveClip"), clipId: idSchema, index: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("removeClip"), clipId: idSchema, closeGap: z.boolean() }).strict(),
  z.object({ type: z.literal("duplicateClip"), clipId: idSchema, newClipId: idSchema }).strict(),
  z.object({ type: z.literal("setClipGain"), clipId: idSchema, gainDb: z.number().finite().min(-60).max(24) }).strict(),
  z.object({ type: z.literal("setClipFraming"), clipId: idSchema, crop: z.enum(["original", "square", "vertical"]), cropX: z.number().min(0).max(1).optional() }).strict(),
  z.object({ type: z.literal("setCaption"), clipId: idSchema, caption: z.string().max(2000) }).strict(),
  z.object({ type: z.literal("setProfile"), profile: sequenceProfileSchema }).strict()
]);
export type SequenceOperation = z.infer<typeof sequenceOperationSchema>;
export const sequenceMutationSchema = z.object({ context: studioContextSchema, expectedRevision: z.number().int().nonnegative(), operations: z.array(sequenceOperationSchema).min(1).max(128) }).strict();
export const sequenceActionSchema = sequenceMutationSchema.omit({ operations: true });
export const defaultSequenceProfile: SequenceProfile = { width: 1920, height: 1080, fps: 30, sampleRate: 48000 };
export function sequenceFrames(state: SequenceState): number { return state.clips.reduce((n, c) => n + c.gapBeforeFrames + c.outFrame - c.inFrame, 0); }
export function sequencePositions(state: SequenceState) { let at = 0; return state.clips.map(clip => { at += clip.gapBeforeFrames; const startFrame = at; at += clip.outFrame - clip.inFrame; return { clip, startFrame, endFrame: at }; }); }
/** Integer output-frame clock. VFR footage is sampled at the declared output fps. */
export function validateSequence(state: SequenceState, source: (id: string) => StudioArtifact): SequenceState {
  const value = sequenceStateSchema.parse(state), ids = new Set<string>();
  for (const clip of value.clips) {
    if (ids.has(clip.id)) throw new Error("sequence_duplicate_clip"); ids.add(clip.id);
    const artifact = source(clip.sourceArtifactId);
    if (artifact.kind === "preview" || artifact.kind === "proxy" || artifact.sha256 !== clip.sourceSha256) throw new Error("media_source_changed");
    if (!artifact.probe || clip.outFrame > Math.floor(artifact.probe.duration * value.profile.fps + .001)) throw new Error("sequence_bounds");
    editSchema.parse({ inSeconds: clip.inFrame / value.profile.fps, outSeconds: clip.outFrame / value.profile.fps, crop: clip.crop, gainDb: clip.gainDb, caption: clip.caption, cropX: clip.cropX, timedCaptions: clip.timedCaptions });
  }
  if (sequenceFrames(value) > value.profile.fps * 7200) throw new Error("sequence_duration_limit"); return value;
}
/** Pure atomic batch compiler, shared by manual, AI and MCP proposals. */
export function applySequenceOperations(current: SequenceState, operations: SequenceOperation[], source: (id: string) => StudioArtifact): SequenceState {
  const state = structuredClone(current);
  for (const raw of operations) {
    const op = sequenceOperationSchema.parse(raw);
    if (op.type === "appendClips") { state.clips.push(...op.clips); continue; }
    if (op.type === "insertClip") { if (op.index > state.clips.length) throw new Error("sequence_bounds"); state.clips.splice(op.index, 0, op.clip); continue; }
    if (op.type === "setProfile") { const ratio = op.profile.fps / state.profile.fps; state.clips = state.clips.map(c => ({ ...c, inFrame: Math.round(c.inFrame * ratio), outFrame: Math.round(c.outFrame * ratio), gapBeforeFrames: Math.round(c.gapBeforeFrames * ratio) })); state.profile = op.profile; continue; }
    const index = state.clips.findIndex(c => c.id === op.clipId), clip = state.clips[index]; if (!clip) throw new Error("sequence_clip_not_found");
    switch (op.type) {
      case "trimClip": Object.assign(clip, { inFrame: op.inFrame, outFrame: op.outFrame }); break;
      case "splitClip": { if (op.atFrame <= clip.inFrame || op.atFrame >= clip.outFrame) throw new Error("sequence_bounds"); const right = { ...clip, id: op.newClipId, inFrame: op.atFrame, gapBeforeFrames: 0 }; clip.outFrame = op.atFrame; state.clips.splice(index + 1, 0, right); break; }
      case "moveClip": if (op.index >= state.clips.length) throw new Error("sequence_bounds"); state.clips.splice(index, 1); state.clips.splice(op.index, 0, clip); break;
      case "removeClip": { const next = state.clips[index + 1]; if (!op.closeGap && !next) throw new Error("sequence_trailing_gap_unsupported"); if (!op.closeGap && next) next.gapBeforeFrames += clip.gapBeforeFrames + clip.outFrame - clip.inFrame; state.clips.splice(index, 1); break; }
      case "duplicateClip": state.clips.splice(index + 1, 0, { ...clip, id: op.newClipId, gapBeforeFrames: 0 }); break;
      case "setClipGain": clip.gainDb = op.gainDb; break;
      case "setClipFraming": clip.crop = op.crop; if (op.cropX !== undefined) clip.cropX = op.cropX; break;
      case "setCaption": clip.caption = op.caption; break;
    }
  }
  return validateSequence(state, source);
}
/** Explicit conversion; legacy timelines and their undo states stay intact. */
export function legacySequenceClips(artifact: StudioArtifact, edit: MediaEdit | undefined, fps: number, newId: () => string): SequenceClip[] {
  if (!artifact.probe) throw new Error("sequence_bounds");
  return (edit?.segments ?? [{ inSeconds: edit?.inSeconds ?? 0, outSeconds: edit?.outSeconds ?? artifact.probe.duration }]).map(range => ({ id: newId(), sourceArtifactId: artifact.id, sourceSha256: artifact.sha256,
    inFrame: Math.round(range.inSeconds * fps), outFrame: Math.min(Math.floor(artifact.probe!.duration * fps + .001), Math.round(range.outSeconds * fps)), gapBeforeFrames: 0, crop: edit?.crop ?? "original", gainDb: edit?.gainDb ?? 0, caption: edit?.caption ?? "",
    ...(edit?.cropX === undefined ? {} : { cropX: edit.cropX }), ...(edit?.timedCaptions ? { timedCaptions: edit.timedCaptions } : {}) }));
}
export interface SequenceJob { id: string; context: { accountId: string; projectId: string }; sequenceId: string; sequenceRevision: number; snapshotDigest: string; snapshot: SequenceSnapshot; kind: "preview" | "export"; proposalId: string | null; state: "running" | "succeeded" | "failed" | "cancelled"; progress: number; artifactId: string | null; error: string | null; createdAt: string }
export interface SequenceProposal { id: string; context: { accountId: string; projectId: string }; baseSequenceRevision: number; sourceIds: string[]; state: "running" | "ready" | "accepted" | "rejected" | "failed" | "cancelled"; summary: string | null; operations: SequenceOperation[]; error: string | null; previewJobId: string | null; model: string; createdAt: string }
