import { z } from "zod";

/** Display dimensions (after rotation), seconds, and presence of an audio stream. */
export const mediaProbeSchema = z.object({
  duration: z.number().finite().positive(),
  width: z.number().int().min(1).max(16384),
  height: z.number().int().min(1).max(16384),
  hasAudio: z.boolean()
}).strict();
export type MediaProbe = z.infer<typeof mediaProbeSchema>;

/** A single non-destructive clip; the end is exclusive and checked against its source. */
export const editSchema = z.object({
  inSeconds: z.number().finite().nonnegative(),
  outSeconds: z.number().finite().positive(),
  crop: z.enum(["original", "vertical", "square"]),
  gainDb: z.number().finite().min(-60).max(24),
  caption: z.string().max(2000).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u)
}).strict().refine(edit => edit.outSeconds > edit.inSeconds, {
  message: "outSeconds must be after inSeconds", path: ["outSeconds"]
});
export type MediaEdit = z.infer<typeof editSchema>;
