import type { createAdminClient } from "@/utils/supabase/admin"

export async function sendPairingRedemption(
  admin: ReturnType<typeof createAdminClient>,
  deviceIds: string[],
  payload: { remotePersonId: string; code: string },
) {
  await Promise.all(
    deviceIds.map(async (deviceId) => {
      const channel = admin.channel(`device:${deviceId}`, {
        config: { private: true },
      })
      try {
        await channel.httpSend("pairing-redemption", payload)
      } finally {
        await admin.removeChannel(channel)
      }
    }),
  )
}
