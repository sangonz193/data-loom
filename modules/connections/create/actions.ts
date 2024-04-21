"use server"

import { subMinutes } from "date-fns"

import { logger } from "@/logger"
import { createAdminClient } from "@/utils/supabase/admin"
import { createClient } from "@/utils/supabase/server"

import { CODE_EXPIRATION_MINUTES, CODE_LENGTH } from "./constants"

export async function createPairingCode() {
  const supabase = createClient()
  const supabaseAdmin = createAdminClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    throw new Error("User not found")
  }

  await supabase.from("pairing_codes").delete().match({
    user_id: user.id,
  })

  const { data, error } = await supabaseAdmin
    .from("pairing_codes")
    .insert({
      code: getRandomCode(),
      user_id: user.id,
    })
    .select()
    .single()

  if (error) {
    throw error
  }

  return {
    code: data.code,
    created_at: data.created_at,
  }
}

function getRandomCode() {
  return Math.random()
    .toString()
    .substring(2, CODE_LENGTH + 2)
}

export async function redeemPairingCode(code: string) {
  const supabaseAdmin = createAdminClient()
  const supabase = createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    throw new Error("User not found")
  }

  const pairingCodeResponse = await supabaseAdmin
    .from("pairing_codes")
    .select()
    .eq("code", code)
    .gte(
      "created_at",
      subMinutes(new Date(), CODE_EXPIRATION_MINUTES).toISOString(),
    )
    .single()

  if (pairingCodeResponse.error) {
    throw pairingCodeResponse.error
  }
  const pairingCode = pairingCodeResponse.data

  const redemptionResponse = await supabaseAdmin
    .from("pairing_code_redemptions")
    .insert({
      pairing_code: pairingCode.code,
      user_id: user.id,
    })

  if (redemptionResponse.error) {
    throw redemptionResponse.error
  }

  logger.info(
    `[pairing-code/redeem] User ${user.id} redeemed pairing code ${pairingCode.code}`,
  )

  return {
    remoteUserId: pairingCode.user_id,
  }
}
