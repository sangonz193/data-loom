import { subMinutes } from "date-fns"

import { CODE_EXPIRATION_MINUTES } from "@/modules/connections/create/constants"
import type { createAdminClient } from "@/utils/supabase/admin"

export async function getConnectionRedemptions(
  admin: ReturnType<typeof createAdminClient>,
  personId: string,
  remotePersonId: string,
) {
  return admin
    .from("pairing_code_redemptions")
    .select(
      "from_person_id, pairing_codes!inner(person_id, purpose, created_at)",
    )
    .in("from_person_id", [personId, remotePersonId])
    .in("pairing_codes.person_id", [personId, remotePersonId])
    .eq("pairing_codes.purpose", "connection")
    .gte(
      "pairing_codes.created_at",
      subMinutes(new Date(), CODE_EXPIRATION_MINUTES).toISOString(),
    )
}
