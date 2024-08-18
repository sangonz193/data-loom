import { NextResponse } from "next/server"

import { createPairingCode } from "@/modules/connections/create/actions"

export async function POST() {
  try {
    const data = await createPairingCode()
    return NextResponse.json(data)
  } catch (error) {
    console.error(error)
    return NextResponse.json(
      {
        error: "Failed to create pairing code",
      },
      {
        status: 500,
      },
    )
  }
}
