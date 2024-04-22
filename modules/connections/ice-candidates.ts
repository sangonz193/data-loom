import { logger } from "@/logger"

let iceServers: RTCIceServer[]

export function getIceServers() {
  return iceServers
}

export function setIceServers(servers: RTCIceServer[]) {
  logger.info("Setting ICE servers", servers)
  iceServers = servers
}
