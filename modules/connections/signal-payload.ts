import { z } from "zod"

export const signalPayload = z.union([
  z.object({ type: z.literal("offer"), sdp: z.string() }).strict(),
  z.object({ type: z.literal("answer"), sdp: z.string() }).strict(),
  z
    .object({
      candidate: z.string(),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
      usernameFragment: z.string().nullable().optional(),
    })
    .strict(),
])
