import type { SupabaseClient } from "@supabase/supabase-js"
import { fromCallback } from "xstate"
import { z } from "zod"

import { logger } from "@/logger"
import type { Database } from "@/supabase/types"

import { signalPayload } from "./signal-payload"

type Input = {
  supabase: SupabaseClient<Database>
  deviceId: string
  remoteUserId: string
  remoteDeviceId?: string
}

export type WebRtcSignalsOutputEvent =
  | { type: "signals.ready" }
  | { type: "signals.ice-candidate"; iceCandidate: RTCIceCandidate }
  | { type: "signals.answer"; answer: RTCSessionDescriptionInit }
  | {
      type: "signals.offer"
      offer: RTCSessionDescriptionInit
      fromDeviceId: string
    }

const envelopeSchema = z.object({
  fromPersonId: z.uuid(),
  fromDeviceId: z.uuid(),
  payload: signalPayload,
})

export function createSignalRouter(
  {
    remoteUserId,
    remoteDeviceId,
  }: Pick<Input, "remoteUserId" | "remoteDeviceId">,
  sendBack: (event: WebRtcSignalsOutputEvent) => void,
) {
  let pinnedDeviceId = remoteDeviceId
  return (payload: unknown) => {
    const parsed = envelopeSchema.safeParse(payload)
    if (!parsed.success) return
    const signal = parsed.data
    if (signal.fromPersonId !== remoteUserId) return
    if (pinnedDeviceId && signal.fromDeviceId !== pinnedDeviceId) return
    if (!pinnedDeviceId) {
      if (!("type" in signal.payload) || signal.payload.type !== "offer") return
      pinnedDeviceId = signal.fromDeviceId
    }

    if ("candidate" in signal.payload) {
      sendBack({
        type: "signals.ice-candidate",
        iceCandidate: signal.payload as RTCIceCandidate,
      })
    } else if (signal.payload.type === "answer") {
      sendBack({ type: "signals.answer", answer: signal.payload })
    } else {
      sendBack({
        type: "signals.offer",
        offer: signal.payload,
        fromDeviceId: signal.fromDeviceId,
      })
    }
  }
}

export function sendSignalChannelReady(
  status: string,
  sendBack: (event: WebRtcSignalsOutputEvent) => void,
) {
  if (status === "SUBSCRIBED") sendBack({ type: "signals.ready" })
}

export const webRtcSignals = fromCallback<{ type: "noop" }, Input>((params) => {
  const sendBack = params.sendBack as (event: WebRtcSignalsOutputEvent) => void
  const { deviceId, supabase } = params.input
  const routeSignal = createSignalRouter(params.input, sendBack)

  const channel = supabase
    .channel(`device:${deviceId}`, { config: { private: true } })
    .on("broadcast", { event: "signal" }, ({ payload }) => {
      routeSignal(payload)
    })
    .subscribe((status, error) => {
      if (error) logger.error("[webRtcSignals] subscription failed", error)
      else {
        logger.info("[webRtcSignals] subscription", status)
        sendSignalChannelReady(status, sendBack)
      }
    })

  return () => {
    supabase.removeChannel(channel)
  }
})
