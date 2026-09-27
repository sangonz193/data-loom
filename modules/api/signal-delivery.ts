import type { createAdminClient } from "@/utils/supabase/admin"

export async function sendSignalBroadcast(
  admin: ReturnType<typeof createAdminClient>,
  deviceIds: string[],
  payload: { fromPersonId: string; payload: unknown },
) {
  await Promise.all(
    deviceIds.map(async (deviceId) => {
      const channel = admin.channel(`device:${deviceId}`, {
        config: { private: true },
      })
      try {
        await channel.httpSend("signal", payload)
      } finally {
        await admin.removeChannel(channel)
      }
    }),
  )
}
