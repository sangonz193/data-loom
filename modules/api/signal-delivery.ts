import type { createAdminClient } from "@/utils/supabase/admin"

export async function sendSignalBroadcast(
  admin: ReturnType<typeof createAdminClient>,
  deviceId: string,
  payload: { fromPersonId: string; fromDeviceId: string; payload: unknown },
) {
  const channel = admin.channel(`device:${deviceId}`, {
    config: { private: true },
  })
  try {
    await channel.httpSend("signal", payload)
  } finally {
    await admin.removeChannel(channel)
  }
}
