"use server"

import { subMinutes } from "date-fns"
import { z } from "zod"

import { createAdminClient } from "@/utils/supabase/admin"
import { createClient } from "@/utils/supabase/server"

import { canonicalConnectionIds } from "./connection-ids"
import { CODE_EXPIRATION_MINUTES } from "./constants"
import { canSendSignal } from "./signal-authorization"

const uuid = z.string().uuid()

async function currentPerson() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("User not found")

  const admin = createAdminClient()
  const { data: person, error } = await admin
    .from("people")
    .select("id")
    .eq("auth_user_id", user.id)
    .single()
  if (error || !person) throw error ?? new Error("Person not found")
  return person
}

export async function sendSignal(input: {
  toPersonId: string
  payload: unknown
}) {
  const toPersonId = uuid.parse(input.toPersonId)
  const person = await currentPerson()
  const admin = createAdminClient()
  const [person_1_id, person_2_id] = canonicalConnectionIds(
    person.id,
    toPersonId,
  )
  const { data: connection, error } = await admin
    .from("connections")
    .select("person_1_id")
    .match({ person_1_id, person_2_id })
    .maybeSingle()
  if (error) throw error
  let freshPairingRedemptions: {
    fromPersonId: string
    codePersonId: string
  }[] = []
  if (!connection && person.id !== toPersonId) {
    const { data: redemptions, error: redemptionError } = await admin
      .from("pairing_code_redemptions")
      .select("from_person_id, pairing_codes!inner(person_id)")
      .eq("pairing_codes.purpose", "connection")
      .gte(
        "pairing_codes.created_at",
        subMinutes(new Date(), CODE_EXPIRATION_MINUTES).toISOString(),
      )
    if (redemptionError) throw redemptionError
    freshPairingRedemptions = redemptions.map((redemption) => ({
      fromPersonId: redemption.from_person_id,
      codePersonId: redemption.pairing_codes.person_id,
    }))
  }
  if (
    !canSendSignal({
      hasConnection: !!connection,
      fromPersonId: person.id,
      toPersonId,
      freshPairingRedemptions,
    })
  )
    throw new Error("Connection not found")

  const { data: devices, error: devicesError } = await admin
    .from("devices")
    .select("id")
    .eq("person_id", toPersonId)
  if (devicesError) throw devicesError

  await Promise.all(
    devices.map((device) =>
      admin.channel(`device:${device.id}`, { config: { private: true } }).send({
        type: "broadcast",
        event: "signal",
        payload: { fromPersonId: person.id, payload: input.payload },
      }),
    ),
  )
}
