import type { SupabaseClient } from "@supabase/supabase-js"
import { fromCallback } from "xstate"
import { z } from "zod"

import { logger } from "@/logger"
import type { Database } from "@/supabase/types"

type Input = {
  supabase: SupabaseClient<Database>
  deviceId: string
  remoteUserId: string | undefined
}

export type WebRtcSignalsOutputEvent =
  | { type: "signals.ice-candidate"; iceCandidate: RTCIceCandidate }
  | { type: "signals.answer"; answer: RTCSessionDescriptionInit }
  | { type: "signals.offer"; offer: RTCSessionDescriptionInit }

const candidateSchema = z.object({ candidate: z.string() }).passthrough()
const answerSchema = z.object({ type: z.literal("answer") }).passthrough()
const offerSchema = z.object({ type: z.literal("offer") }).passthrough()

export const webRtcSignals = fromCallback<{ type: "noop" }, Input>((params) => {
  const sendBack = params.sendBack as (event: WebRtcSignalsOutputEvent) => void
  const { deviceId, remoteUserId, supabase } = params.input

  const channel = supabase
    .channel(`device:${deviceId}`, { config: { private: true } })
    .on("broadcast", { event: "signal" }, ({ payload }) => {
      const signal = payload as { fromPersonId?: string; payload?: unknown }
      if (remoteUserId && signal.fromPersonId !== remoteUserId) return

      const candidate = candidateSchema.safeParse(signal.payload)
      if (candidate.success) {
        sendBack({
          type: "signals.ice-candidate",
          iceCandidate: candidate.data as unknown as RTCIceCandidate,
        })
        return
      }

      const answer = answerSchema.safeParse(signal.payload)
      if (answer.success) {
        sendBack({
          type: "signals.answer",
          answer: answer.data as RTCSessionDescriptionInit,
        })
        return
      }

      const offer = offerSchema.safeParse(signal.payload)
      if (offer.success) {
        sendBack({
          type: "signals.offer",
          offer: offer.data as RTCSessionDescriptionInit,
        })
      }
    })
    .subscribe((status, error) => {
      if (error) logger.error("[webRtcSignals] subscription failed", error)
      else logger.info("[webRtcSignals] subscription", status)
    })

  return () => {
    supabase.removeChannel(channel)
  }
})
