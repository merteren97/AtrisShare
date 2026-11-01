import { z } from "zod";

/** Display dimensions (after rotation), seconds, and presence of an audio stream. */
export const mediaProbeSchema = z.object({
  duration: z.number().finite().positive(),
  width: z.number().int().min(1).max(16384),
  height: z.number().int().min(1).max(16384),
  hasAudio: z.boolean()
}).strict();
export type MediaProbe = z.infer<typeof mediaProbeSchema>;

/** Original-source seconds, with an exclusive end. Sub-frame ranges remain valid. */
export const segmentSchema = z.object({
  inSeconds: z.number().finite().nonnegative(),
  outSeconds: z.number().finite().positive()
}).strict().refine(segment => segment.outSeconds > segment.inSeconds, {
  message: "outSeconds must be after inSeconds", path: ["outSeconds"]
});

/** Non-destructive source envelope and optional chronological kept ranges.
 * Without segments, the envelope is the single clip (the original contract).
 */
export const editSchema = z.object({
  inSeconds: z.number().finite().nonnegative(),
  outSeconds: z.number().finite().positive(),
  crop: z.enum(["original", "vertical", "square"]),
  gainDb: z.number().finite().min(-60).max(24),
  caption: z.string().max(2000).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u),
  segments: z.array(segmentSchema).min(1).max(32).optional()
}).strict().refine(edit => edit.outSeconds > edit.inSeconds, {
  message: "outSeconds must be after inSeconds", path: ["outSeconds"]
}).superRefine((edit, context) => {
  for (const [index, segment] of (edit.segments ?? []).entries()) {
    if (segment.inSeconds < edit.inSeconds || segment.outSeconds > edit.outSeconds) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "segment must be within the source envelope", path: ["segments", index] });
    }
    if (index > 0 && segment.inSeconds < edit.segments![index - 1]!.outSeconds) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "segments must be chronological and non-overlapping", path: ["segments", index] });
    }
  }
});
export type MediaEdit = z.infer<typeof editSchema>;
