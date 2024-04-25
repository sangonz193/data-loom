import { z } from "zod"

export const requestPayloadSchema = z.object({
  files: z.array(
    z.object({
      name: z.string(),
      size: z.number(),
      mimeType: z.string(),
    }),
  ),
})
