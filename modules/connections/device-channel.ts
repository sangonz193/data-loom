import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js"

import { logger } from "@/logger"
import type { Database } from "@/supabase/types"

const READY_TIMEOUT_MS = 10_000

type Listener = {
  event: "signal" | "pairing-redemption"
  onMessage: (payload: unknown) => void
  onReady: () => void
  onError: (error: unknown) => void
}

type Subscription = {
  channel?: RealtimeChannel
  listeners: Set<Listener>
  events: Set<Listener["event"]>
  ready: boolean
  hasSubscribed: boolean
  closing: boolean
  removal?: Promise<void>
}

const clients = new WeakMap<
  SupabaseClient<Database>,
  Map<string, Subscription>
>()

function closeSubscription(
  supabase: SupabaseClient<Database>,
  subscriptions: Map<string, Subscription>,
  deviceId: string,
  subscription: Subscription,
) {
  if (subscription.removal) return subscription.removal
  subscription.closing = true
  subscription.ready = false
  // Keep the topic reserved until removal finishes: the SDK removes by topic.
  subscription.removal = Promise.resolve()
    .then(async () => {
      if (subscription.channel) {
        try {
          const status = await supabase.removeChannel(subscription.channel)
          if (status === "error")
            throw new Error("Device channel removal failed")
          if (status === "timed out") subscription.channel.teardown()
        } catch (error) {
          logger.error({ error }, "[device-channel] retrying cleanup")
          const status = await subscription.channel.unsubscribe(0)
          if (status === "error")
            throw new Error("Device channel recovery failed")
          subscription.channel.teardown()
        }
      }
      subscriptions.delete(deviceId)
    })
    .finally(() => {
      subscription.removal = undefined
    })
  void subscription.removal.catch((error) => {
    logger.error({ error }, "[device-channel] cleanup failed")
  })
  return subscription.removal
}

export function subscribeDeviceChannel(
  supabase: SupabaseClient<Database>,
  deviceId: string,
  listener: Listener,
) {
  let subscriptions = clients.get(supabase)
  if (!subscriptions) {
    subscriptions = new Map()
    clients.set(supabase, subscriptions)
  }
  const registry = subscriptions
  let owned: Subscription | undefined
  let active = true
  let notifiedReady = false
  const timeout = setTimeout(() => {
    owner.onError(new Error("Device channel readiness timed out"))
  }, READY_TIMEOUT_MS)

  const release = () => {
    if (!active) return
    active = false
    clearTimeout(timeout)
    if (!owned) return
    owned.listeners.delete(owner)
    if (owned.listeners.size === 0) {
      closeSubscription(supabase, registry, deviceId, owned)
    }
  }

  const owner: Listener = {
    event: listener.event,
    onMessage: listener.onMessage,
    onReady: () => {
      if (!active || notifiedReady) return
      notifiedReady = true
      clearTimeout(timeout)
      listener.onReady()
    },
    onError: (error) => {
      if (!active) return
      release()
      listener.onError(error)
    },
  }

  function acquire() {
    if (!active) return
    let subscription = registry.get(deviceId)
    if (subscription?.closing) {
      void closeSubscription(supabase, registry, deviceId, subscription).then(
        acquire,
        owner.onError,
      )
      return
    }
    if (!subscription) {
      subscription = {
        listeners: new Set(),
        events: new Set(),
        ready: false,
        hasSubscribed: false,
        closing: false,
      }
      registry.set(deviceId, subscription)
    }
    const current = subscription
    owned = current
    current.listeners.add(owner)

    const fail = (error: unknown) => {
      if (current.closing) return
      closeSubscription(supabase, registry, deviceId, current)
      for (const member of [...current.listeners]) member.onError(error)
    }

    try {
      const first = !current.channel
      current.channel ??= supabase.channel(`device:${deviceId}`, {
        config: { private: true },
      })
      if (!current.events.has(owner.event)) {
        const event = owner.event
        current.events.add(event)
        current.channel.on("broadcast", { event }, ({ payload }) => {
          if (current.closing) return
          for (const member of [...current.listeners]) {
            if (member.event === event && current.listeners.has(member)) {
              member.onMessage(payload)
            }
          }
        })
      }
      if (first) {
        current.channel.subscribe((status, error) => {
          if (current.closing) return
          if (status === "CHANNEL_ERROR" && current.hasSubscribed) {
            current.ready = false
          } else if (error || status !== "SUBSCRIBED") {
            fail(error ?? new Error(`Device channel subscription ${status}`))
          } else if (!current.ready) {
            current.hasSubscribed = true
            current.ready = true
            for (const member of [...current.listeners]) member.onReady()
          }
        }, READY_TIMEOUT_MS)
      } else if (current.ready) owner.onReady()
    } catch (error) {
      fail(error)
    }
  }

  acquire()
  return release
}
