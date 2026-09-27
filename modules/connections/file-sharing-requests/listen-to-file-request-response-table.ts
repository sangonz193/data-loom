import { type AnyEventObject, fromCallback } from "xstate"

import type { Tables } from "@/supabase/types"
import { createClient } from "@/utils/supabase/client"

type Input = {
  supabase: ReturnType<typeof createClient>
  requestId: string
}

export type ListenToFileRequestResponseTableOutputEvent =
  | {
      type: "file-request-response"
      response: Tables<"share_request_responses">
    }
  | { type: "file-request-response.failed" }
  | { type: "file-request.cancelled"; requestId: string }
  | { type: "file-request.expired"; requestId: string }

export const listenToFileRequestResponseTable = fromCallback<
  AnyEventObject,
  Input
>(({ input: { supabase, requestId }, sendBack }) => {
  let stopped = false
  let cancelled = false
  let expired = false
  let deliveredResponse = false
  let failed = false
  let reading = false
  let readQueued = false
  let ready = false
  let response: Tables<"share_request_responses"> | undefined
  let expiresAt: string | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let readTimer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined

  const cancel = () => {
    if (stopped || cancelled) return
    cancelled = true
    clearTimeout(expiryTimer)
    sendBack({ type: "file-request.cancelled", requestId })
  }
  const fail = () => {
    if (stopped || cancelled || failed) return
    failed = true
    sendBack({ type: "file-request-response.failed" })
  }
  const deliver = (snapshotStartedAt?: number) => {
    if (stopped || cancelled || expired || !ready) return
    clearTimeout(expiryTimer)
    if (response) {
      if (!deliveredResponse) {
        deliveredResponse = true
        sendBack({ type: "file-request-response", response })
      }
    } else if (expiresAt) {
      const deadline = new Date(expiresAt).getTime()
      if (snapshotStartedAt !== undefined && snapshotStartedAt >= deadline) {
        expired = true
        sendBack({ type: "file-request.expired", requestId })
      } else {
        expiryTimer = setTimeout(
          () => void readSnapshot(),
          Math.max(0, deadline - Date.now()),
        )
      }
    }
  }
  const readSnapshot = async () => {
    if (stopped || cancelled || expired) return
    if (reading) {
      readQueued = true
      return
    }
    reading = true
    readQueued = false
    ready = false
    clearTimeout(expiryTimer)
    const snapshotStartedAt = Date.now()
    const readController = new AbortController()
    controller = readController
    readTimer = setTimeout(() => {
      readController.abort()
      fail()
    }, 15_000)
    try {
      const [requestResult, responseResult] = await Promise.all([
        supabase
          .from("share_requests")
          .select()
          .eq("id", requestId)
          .abortSignal(readController.signal)
          .maybeSingle(),
        supabase
          .from("share_request_responses")
          .select()
          .eq("request_id", requestId)
          .abortSignal(readController.signal)
          .maybeSingle(),
      ])
      if (stopped || cancelled || readController.signal.aborted) return
      if (requestResult.error) throw requestResult.error
      if (!requestResult.data || requestResult.data.cancelled_at) {
        cancel()
        return
      }
      if (readQueued) return
      if (responseResult.error) throw responseResult.error
      expiresAt = requestResult.data.expires_at
      response ??= responseResult.data ?? undefined
      ready = true
      failed = false
      deliver(snapshotStartedAt)
    } catch {
      fail()
    } finally {
      reading = false
      clearTimeout(readTimer)
      if (readQueued) void readSnapshot()
    }
  }

  const subscriptionTimer = setTimeout(fail, 15_000)
  const channel = supabase
    .channel(`file_request:${requestId}:${crypto.randomUUID()}`, {
      config: { postgres_changes_options: { wait: true } },
    })
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "share_requests",
        filter: `id=eq.${requestId}`,
      },
      (payload) => {
        if ((payload.new as Tables<"share_requests">).cancelled_at) cancel()
      },
    )
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "share_request_responses",
        filter: `request_id=eq.${requestId}`,
      },
      (payload) => {
        if (stopped || cancelled) return
        response ??= payload.new as Tables<"share_request_responses">
        deliver()
      },
    )
    .subscribe((status, error) => {
      if (stopped || cancelled) return
      if (error || ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status))
        fail()
      else if (status === "SUBSCRIBED") {
        clearTimeout(subscriptionTimer)
        void readSnapshot()
      }
    })

  return () => {
    stopped = true
    clearTimeout(expiryTimer)
    clearTimeout(readTimer)
    clearTimeout(subscriptionTimer)
    controller?.abort()
    void supabase.removeChannel(channel)
  }
})
