import { z } from "zod"

export const requestPayloadSchema = z.object({
  file: z.object({
    name: z.string(),
    size: z.number(),
    mimeType: z.string(),
  }),
})
