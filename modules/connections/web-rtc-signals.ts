import { SupabaseClient, User } from "@supabase/supabase-js"
import { fromCallback } from "xstate"
import { z } from "zod"

import { logger } from "@/logger"
import { Database, Tables } from "@/supabase/types"

type Input = {
  supabase: SupabaseClient<Database>
  currentUser: User
  remoteUserId: string | undefined
}

export type WebRtcSignalsOutputEvent =
  | {
      type: "signals.ice-candidate"
      iceCandidate: RTCIceCandidate
      remoteUserId: string
    }
  | {
      type: "signals.answer"
      answer: RTCSessionDescriptionInit
      remoteUserId: string
    }
  | {
      type: "signals.offer"
      offer: RTCSessionDescriptionInit
      remoteUserId: string
    }

export const webRtcSignals = fromCallback<{ type: "noop" }, Input>((params) => {
  const sendBack = params.sendBack as (event: WebRtcSignalsOutputEvent) => void
  const { currentUser, remoteUserId, supabase } = params.input

  function handleRow(newRow: Tables<"web_rtc_signals">) {
    if (newRow.to_user_id !== currentUser.id) {
      if (newRow.from_user_id === currentUser.id) {
        // This is a signal that we sent, ignore it
      } else {
        logger.info(
          `[webRtcSignals] Ignoring signal for another user ${newRow.to_user_id}`,
        )
      }
      return
    }

    const candidateValidation = candidateSchema.safeParse(newRow.payload)
    if (candidateValidation.success) {
      const candidate = candidateValidation.data
      logger.info("[webRtcSignals] received ice-candidate", candidate)
      sendBack({
        type: "signals.ice-candidate",
        iceCandidate: candidate as unknown as RTCIceCandidate,
        remoteUserId: newRow.from_user_id,
      })
      return
    }

    const answerValidation = answerSchema.safeParse(newRow.payload)
    if (answerValidation.success) {
      const answer = answerValidation.data
      logger.info("[webRtcSignals] received answer", answer)
      sendBack({
        type: "signals.answer",
        answer: answer as unknown as RTCSessionDescription,
        remoteUserId: newRow.from_user_id,
      })
      return
    }

    const offerValidation = offerSchema.safeParse(newRow.payload)
    if (offerValidation.success) {
      const offer = offerValidation.data
      logger.info("[webRtcSignals] received offer", offer)
      sendBack({
        type: "signals.offer",
        offer: offer as unknown as RTCSessionDescription,
        remoteUserId: newRow.from_user_id,
      })
      return
    }

    logger.error(
      "[webRtcSignals] Ignoring signal with unknown payload",
      newRow.payload,
    )
  }

  const channel = supabase
    .channel(Math.random().toString().substring(2, 20))
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "web_rtc_signals" satisfies keyof Database["public"]["Tables"],
        filter: remoteUserId ? `from_user_id=eq.${remoteUserId}` : undefined,
      },
      (payload) => {
        const newRow = payload.new as Tables<"web_rtc_signals">
        handleRow(newRow)
      },
    )
    .subscribe((status, error) => {
      if (error) {
        logger.error("[webRtcSignals] Error subscribing to channel", error)
      } else {
        logger.info("[webRtcSignals] Subscribed to channel", status)
      }
    })

  return () => {
    supabase.removeChannel(channel)
  }
})

const candidateSchema = z
  .object({
    candidate: z.string(),
  })
  .passthrough()

const answerSchema = z
  .object({
    type: z.literal("answer"),
  })
  .passthrough()

const offerSchema = z
  .object({
    type: z.literal("offer"),
  })
  .passthrough()
