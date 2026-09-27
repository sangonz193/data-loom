import { expect, test } from "bun:test"

import type { createAdminClient } from "@/utils/supabase/admin"

import { sendSignalBroadcast } from "./signal-delivery"

for (const fails of [false, true]) {
  test(`signal delivery ${fails ? "propagates failure" : "succeeds"} and removes channels`, async () => {
    const removed: string[] = []
    const admin = {
      channel: (topic: string, options: unknown) => {
        expect(options).toEqual({ config: { private: true } })
        return {
          topic,
          httpSend: async (event: string, payload: unknown) => {
            expect(event).toBe("signal")
            expect(payload).toEqual({
              fromPersonId: "sender",
              fromDeviceId: "sender-device",
              payload: { type: "offer", sdp: "sdp" },
            })
            if (fails && topic === "device:second") throw new Error("offline")
          },
        }
      },
      removeChannel: async (channel: { topic: string }) => {
        removed.push(channel.topic)
      },
    } as unknown as ReturnType<typeof createAdminClient>

    const send = sendSignalBroadcast(admin, "second", {
      fromPersonId: "sender",
      fromDeviceId: "sender-device",
      payload: { type: "offer", sdp: "sdp" },
    })
    if (fails) await expect(send).rejects.toThrow("offline")
    else await send
    expect(removed.sort()).toEqual(["device:second"])
  })
}
