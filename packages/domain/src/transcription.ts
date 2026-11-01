import { z } from "zod";
import { studioContextSchema } from "./studio.js";
import { idSchema } from "./workspace.js";

export const transcriptContextSchema = studioContextSchema;
export const transcriptionErrorSchema = z.enum([
  "transcription_failed", "transcript_interrupted", "transcription_unavailable", "transcription_timeout",
  "media_source_changed", "transcription_no_audio", "transcription_invalid_source", "transcription_invalid_audio",
  "transcription_invalid_output", "transcription_invalid_timestamps", "transcription_output_limit",
  "transcription_tool_unavailable", "transcription_tool_timeout", "transcription_tool_output_limit",
  "transcription_ffmpeg_failed", "transcription_whisper_failed", "transcription_whisper_incompatible",
  "transcription_model_unavailable_absolute_path_required", "transcription_invalid_progress",
  "transcription_unsupported_duration_limit_7200s"
]);
export const transcriptSegmentSchema = z.object({
  start: z.number().finite().nonnegative(), end: z.number().finite().positive(),
  text: z.string().min(1).max(200_000).regex(/^[^\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]*$/u)
    .refine(text => !/[\uD800-\uDFFF]/u.test(text), "Transcript text must be well-formed Unicode")
}).strict();

/** Persisted DB text only; no paths, CLI diagnostics, captions or output artifacts. */
export const transcriptSchema = z.object({
  id: idSchema, accountId: idSchema, projectId: idSchema, artifactId: idSchema,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(["running", "succeeded", "failed", "cancelled"]), progress: z.number().finite().min(0).max(1),
  language: z.string().regex(/^[a-z]{2,3}$/u).nullable(), segments: z.array(transcriptSegmentSchema).max(10_000),
  duration: z.number().finite().positive().max(7200).nullable(), error: transcriptionErrorSchema.nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), cancelRequested: z.boolean().optional()
}).strict().superRefine((value, ctx) => {
  let end = 0, length = 0;
  for (const segment of value.segments) {
    length += segment.text.length;
    if (segment.start < end || segment.end <= segment.start || value.duration === null || segment.end > value.duration) {
      ctx.addIssue({ code: "custom", message: "Invalid transcript timestamps", path: ["segments"] });
      break;
    }
    end = segment.end;
  }
  if (length > 200_000) ctx.addIssue({ code: "custom", message: "Transcript text limit", path: ["segments"] });
  if (value.state === "succeeded" ? value.duration === null || value.language === null || value.progress !== 1 || value.error !== null
    : value.duration !== null || value.language !== null || value.segments.length !== 0
      || (value.state === "failed" ? value.error === null : value.error !== null)) {
    ctx.addIssue({ code: "custom", message: "Invalid transcript state" });
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) ctx.addIssue({ code: "custom", message: "Invalid transcript clock" });
});
export type Transcript = z.infer<typeof transcriptSchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type TranscriptContext = z.infer<typeof transcriptContextSchema>;
