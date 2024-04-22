import { z } from "zod"

import { logger } from "@/logger"
import { Connections } from "@/modules/connections/connections"

export default async function Home() {
  const iceServers = await getIceServers()

  return <Connections iceServers={iceServers} />
}

async function getIceServers() {
  let iceServers: RTCIceServer[] = []
  if (!process.env.METERED_API_KEY) {
    return iceServers
  }

  try {
    const response = await fetch(
      "https://data-loom.metered.live/api/v1/turn/credentials?apiKey=" +
        process.env.METERED_API_KEY,
    )
    iceServers = z
      .array(z.object({ urls: z.string() }).passthrough())
      .parse(await response.json())

    return iceServers
  } catch (error) {
    logger.error("Failed to fetch TURN credentials", error)
  }

  return iceServers
}
