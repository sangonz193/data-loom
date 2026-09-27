import { createClient } from "@supabase/supabase-js"
import { expect, test } from "bun:test"

import { canCreateConnection } from "@/modules/connections/create/connection-authorization"
import type { Database } from "@/supabase/types"

import { getConnectionRedemptions } from "./connection-redemptions"

test("connection ownership query constrains both people, purpose, and expiry", async () => {
  const urls: URL[] = []
  const client = createClient<Database>("http://localhost:54321", "test-key", {
    global: {
      fetch: async (input) => {
        urls.push(new URL(String(input)))
        return new Response(
          JSON.stringify([
            {
              from_person_id: "person-b",
              pairing_codes: {
                person_id: "person-a",
                purpose: "connection",
                created_at: new Date().toISOString(),
              },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      },
    },
  })

  const { data, error } = await getConnectionRedemptions(
    client,
    "person-a",
    "person-b",
  )
  expect(error).toBeNull()
  expect(urls).toHaveLength(1)
  const query = urls[0]!.searchParams
  expect(query.get("select")).toContain("pairing_codes!inner")
  expect(query.get("from_person_id")).toBe("in.(person-a,person-b)")
  expect(query.get("pairing_codes.person_id")).toBe("in.(person-a,person-b)")
  expect(query.get("pairing_codes.purpose")).toBe("eq.connection")
  expect(query.get("pairing_codes.created_at")).toStartWith("gte.")
  expect(
    canCreateConnection({
      personId: "person-a",
      remotePersonId: "person-b",
      pairingRedemptions: data!.map((row) => ({
        fromPersonId: row.from_person_id,
        codePersonId: row.pairing_codes.person_id,
        codeCreatedAt: row.pairing_codes.created_at,
      })),
    }),
  ).toBe(true)
})
