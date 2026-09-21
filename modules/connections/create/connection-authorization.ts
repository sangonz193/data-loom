import { subMinutes } from "date-fns"

import { CODE_EXPIRATION_MINUTES } from "./constants"

type PairingRedemption = {
  fromPersonId: string
  codePersonId: string
  codeCreatedAt: string
}

export function canCreateConnection({
  personId,
  remotePersonId,
  pairingRedemptions,
  now = new Date(),
}: {
  personId: string
  remotePersonId: string
  pairingRedemptions: readonly PairingRedemption[]
  now?: Date
}) {
  const expiry = subMinutes(now, CODE_EXPIRATION_MINUTES)

  return pairingRedemptions.some(
    ({ fromPersonId, codePersonId, codeCreatedAt }) =>
      new Date(codeCreatedAt) >= expiry &&
      ((fromPersonId === personId && codePersonId === remotePersonId) ||
        (fromPersonId === remotePersonId && codePersonId === personId)),
  )
}
