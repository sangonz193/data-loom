"use server"

import { addMinutes, subMinutes } from "date-fns"
import { z } from "zod"

import { createAdminClient } from "@/utils/supabase/admin"
import { createClient } from "@/utils/supabase/server"

import { canCreateConnection } from "./connection-authorization"
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

export async function notifyPairingCodeRedeemed(codeInput: string) {
  const code = z.string().trim().min(1).max(32).toUpperCase().parse(codeInput)
  const person = await currentPerson()
  const admin = createAdminClient()
  const { data: redemption, error: redemptionError } = await admin
    .from("pairing_code_redemptions")
    .select("code, pairing_codes!inner(person_id, purpose)")
    .match({ code, from_person_id: person.id })
    .eq("pairing_codes.purpose", "connection")
    .single()
  if (redemptionError || !redemption)
    throw redemptionError ?? new Error("Pairing code redemption not found")

  const pairingCode = redemption.pairing_codes

  const { data: devices, error: devicesError } = await admin
    .from("devices")
    .select("id")
    .eq("person_id", pairingCode.person_id)
  if (devicesError) throw devicesError
  await Promise.all(
    devices.map((device) =>
      admin.channel(`device:${device.id}`, { config: { private: true } }).send({
        type: "broadcast",
        event: "pairing-redemption",
        payload: { remotePersonId: person.id, code },
      }),
    ),
  )
}

export async function createConnection(remotePersonIdInput: string) {
  const remotePersonId = uuid.parse(remotePersonIdInput)
  const person = await currentPerson()
  const admin = createAdminClient()
  const { data: redemptions, error: redemptionError } = await admin
    .from("pairing_code_redemptions")
    .select(
      "from_person_id, pairing_codes!inner(person_id, purpose, created_at)",
    )
    .eq("pairing_codes.purpose", "connection")
    .gte(
      "pairing_codes.created_at",
      subMinutes(new Date(), CODE_EXPIRATION_MINUTES).toISOString(),
    )
  if (redemptionError) throw redemptionError
  const redeemedTogether = canCreateConnection({
    personId: person.id,
    remotePersonId,
    pairingRedemptions: redemptions.map((redemption) => ({
      fromPersonId: redemption.from_person_id,
      codePersonId: redemption.pairing_codes.person_id,
      codeCreatedAt: redemption.pairing_codes.created_at,
    })),
  })
  if (!redeemedTogether) throw new Error("Pairing code redemption not found")

  const [person_1_id, person_2_id] = canonicalConnectionIds(
    person.id,
    remotePersonId,
  )
  const { error } = await admin
    .from("connections")
    .upsert({ person_1_id, person_2_id })
  if (error) throw error
}

export async function registerDevice(deviceIdInput: string) {
  const id = uuid.parse(deviceIdInput)
  const person = await currentPerson()
  const admin = createAdminClient()
  const { data: existing, error: existingError } = await admin
    .from("devices")
    .select("person_id")
    .eq("id", id)
    .maybeSingle()
  if (existingError) throw existingError
  if (existing && existing.person_id !== person.id) {
    throw new Error("Device belongs to another person")
  }

  const { error } = await admin.from("devices").upsert({
    id,
    person_id: person.id,
    name: "This device",
    last_seen_at: new Date().toISOString(),
  })
  if (error) throw error
  return { id, personId: person.id }
}

export async function createShareRequest(input: {
  deviceId: string
  toPersonId: string
  payload: unknown
}) {
  const deviceId = uuid.parse(input.deviceId)
  const toPersonId = uuid.parse(input.toPersonId)
  const person = await currentPerson()
  const admin = createAdminClient()
  const { data: device, error: deviceError } = await admin
    .from("devices")
    .select("id")
    .match({ id: deviceId, person_id: person.id })
    .single()
  if (deviceError || !device) throw deviceError ?? new Error("Device not found")

  const [person_1_id, person_2_id] = canonicalConnectionIds(
    person.id,
    toPersonId,
  )
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .select("person_1_id")
    .match({ person_1_id, person_2_id })
    .maybeSingle()
  if (connectionError) throw connectionError
  if (!connection && person.id !== toPersonId)
    throw new Error("Connection not found")

  const { data, error } = await admin
    .from("share_requests")
    .insert({
      from_person_id: person.id,
      from_device_id: deviceId,
      to_person_id: toPersonId,
      payload: input.payload as never,
      expires_at: addMinutes(new Date(), 10).toISOString(),
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function respondToShareRequest(input: {
  requestId: string
  accepted: boolean
  deviceId: string
}) {
  const requestId = uuid.parse(input.requestId)
  const deviceId = uuid.parse(input.deviceId)
  const person = await currentPerson()
  const admin = createAdminClient()
  const { data: request, error: requestError } = await admin
    .from("share_requests")
    .select("id")
    .match({ id: requestId, to_person_id: person.id })
    .gt("expires_at", new Date().toISOString())
    .single()
  if (requestError || !request)
    throw requestError ?? new Error("Share request not found")

  const { data: device, error: deviceError } = await admin
    .from("devices")
    .select("id")
    .match({ id: deviceId, person_id: person.id })
    .single()
  if (deviceError || !device) throw deviceError ?? new Error("Device not found")

  const { data, error } = await admin
    .from("share_request_responses")
    .upsert({
      request_id: request.id,
      accepted: input.accepted,
      accepted_by_device_id: input.accepted ? device.id : null,
    })
    .select()
    .single()
  if (error) throw error
  return data
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
