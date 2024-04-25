import { fromCallback } from "xstate"
import { InvokeCallback } from "xstate/dist/declarations/src/actors/callback"

import { logger } from "@/logger"

type Input = {
  peerConnection: RTCPeerConnection
}

export type PeerConnectionEventsOutputEvents =
  | {
      type: "peer.datachannel"
      event: RTCPeerConnectionEventMap["datachannel"]
    }
  | {
      type: "peer.connectionstatechange"
      event: RTCPeerConnectionEventMap["connectionstatechange"]
    }

const callback: InvokeCallback<
  { type: "noop" },
  PeerConnectionEventsOutputEvents,
  Input
> = ({ input, sendBack }) => {
  const { peerConnection } = input

  const eventHandlers: {
    [K in keyof RTCPeerConnectionEventMap]: [
      K,
      (event: RTCPeerConnectionEventMap[K]) => void,
    ]
  }[keyof RTCPeerConnectionEventMap][] = []

  function registerEventHandler<K extends keyof RTCPeerConnectionEventMap>(
    type: K,
    handler: (event: RTCPeerConnectionEventMap[K]) => void,
  ) {
    peerConnection.addEventListener(type, handler)
    eventHandlers.push([type, handler as any])
  }

  registerEventHandler("datachannel", (event) => {
    logger.info("[peer-connection-events] datachannel", event.channel)
    sendBack({ type: "peer.datachannel", event })
  })
  registerEventHandler("connectionstatechange", (event) => {
    logger.info(
      "[peer-connection-events] connectionstatechange",
      peerConnection.connectionState,
    )
    sendBack({ type: "peer.connectionstatechange", event })
  })

  return () => {
    eventHandlers.forEach(([type, handler]) => {
      peerConnection.removeEventListener(type, handler as any)
    })
  }
}

export const peerConnectionEvents = fromCallback(callback)
