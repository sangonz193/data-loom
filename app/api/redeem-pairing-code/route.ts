import { NextResponse } from "next/server"
import { z } from "zod"

import { redeemPairingCode } from "@/modules/connections/create/actions"

const requestBody = z.object({
  code: z.string(),
})

export type RedeemPairingCodeRequestBody = z.infer<typeof requestBody>

export async function POST(request: Request) {
  try {
    const body = requestBody.parse(await request.json())
    const data = await redeemPairingCode(body.code)

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
