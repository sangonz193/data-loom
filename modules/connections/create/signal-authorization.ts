type PairingRedemption = {
  fromPersonId: string
  codePersonId: string
}

export function canSendSignal({
  hasConnection,
  fromPersonId,
  toPersonId,
  freshPairingRedemptions,
}: {
  hasConnection: boolean
  fromPersonId: string
  toPersonId: string
  freshPairingRedemptions: readonly PairingRedemption[]
}) {
  if (fromPersonId === toPersonId || hasConnection) return true

  return freshPairingRedemptions.some(
    ({ fromPersonId: redemptionPersonId, codePersonId }) =>
      (redemptionPersonId === fromPersonId && codePersonId === toPersonId) ||
      (redemptionPersonId === toPersonId && codePersonId === fromPersonId),
  )
}
