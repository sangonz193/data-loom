"use client"

import { useCallback } from "react"

import { useTRPCClient } from "@/modules/api/client"
import { useIdentityDevice } from "@/modules/auth/use-identity-device"
import { useRequiredUser } from "@/modules/auth/use-user"
import { createClient } from "@/utils/supabase/client"

import { deviceNameFromUserAgent } from "./device-name"
import { registerDevice } from "./register-device"

async function readUserId() {
  const { data, error } = await createClient().auth.getUser()
  if (error) throw error
  return data.user?.id
}

export function useDevice() {
  const trpcClient = useTRPCClient()
  const userId = useRequiredUser().id
  const register = useCallback(
    () =>
      registerDevice(userId, (id) =>
        trpcClient.devices.register.mutate({
          id,
          name: deviceNameFromUserAgent(navigator.userAgent),
        }),
      ),
    [trpcClient, userId],
  )
  return useIdentityDevice(userId, readUserId, register)
}
