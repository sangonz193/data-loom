import { expect, test } from "bun:test"

import type { createAdminClient } from "@/utils/supabase/admin"

import { sendPairingRedemption } from "./pairing-redemption-delivery"

const payload = { remotePersonId: "redeemer", code: "PAIRCODE" }

for (const outcome of ["success", "rejected", "timed out"] as const) {
  test(`pairing notification ${outcome} cleans up its send-only channel`, async () => {
    const calls: string[] = []
    const channel = {
      httpSend: async (event: string, sentPayload: typeof payload) => {
        expect(event).toBe("pairing-redemption")
        expect(sentPayload).toEqual(payload)
        calls.push("send")
        if (outcome !== "success") throw new Error(outcome)
      },
    }
    const admin = {
      channel: (topic: string, options: unknown) => {
        expect(topic).toBe("device:owner-device")
        expect(options).toEqual({ config: { private: true } })
        return channel
      },
      removeChannel: async (removed: unknown) => {
        expect(removed).toBe(channel)
        calls.push("remove")
      },
    } as unknown as ReturnType<typeof createAdminClient>

    const delivery = sendPairingRedemption(admin, ["owner-device"], payload)
    if (outcome === "success") await delivery
    else await expect(delivery).rejects.toThrow(outcome)
    expect(calls).toEqual(["send", "remove"])
  })
}
