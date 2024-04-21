import { fromCallback } from "xstate"
import { InvokeCallback } from "xstate/dist/declarations/src/actors/callback"

import { logger } from "@/logger"

type Input = {
  peerConnection: RTCPeerConnection
} & (
  | {
      calling: true
    }
  | {
      calling: false
      offer?: RTCSessionDescriptionInit
    }
)

export type ConnectPeerInputEvent =
  | {
      type: "description-received"
      description: RTCSessionDescriptionInit
    }
  | {
      type: "ice-candidate-received"
      candidate: RTCIceCandidate
    }

export type ConnectPeerOutputEvent =
  | {
      type: "peer-connection.description"
      description: RTCSessionDescriptionInit
    }
  | {
      type: "peer-connection.ice-candidate"
      candidate: RTCIceCandidate
    }
  | {
      type: "peer-connection.successful"
    }
  | {
      type: "peer-connection.failed"
    }

const invoke: InvokeCallback<
  ConnectPeerInputEvent,
  ConnectPeerOutputEvent,
  Input
> = ({ sendBack, receive, input }) => {
  const { calling, peerConnection } = input
  let dummyDataChannel: RTCDataChannel | undefined
  let pendingIceCandidates: RTCIceCandidate[] = []

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

  async function eventHandler(event: ConnectPeerInputEvent) {
    switch (event.type) {
      case "description-received": {
        if (peerConnection.remoteDescription) {
          console.warn(
            "Received description when remote description already exists. Ignoring.",
          )
          return
        }

        logger.info("[connect-peer] Received description", event.description)
        await peerConnection.setRemoteDescription(event.description)
        logger.info("[connect-peer] Remote description set")

        pendingIceCandidates.map((candidate) => {
          peerConnection.addIceCandidate(candidate)
        })

        pendingIceCandidates = []

        if (calling) return
        await peerConnection.setLocalDescription()
        logger.info("[connect-peer] Local description set")

        sendBack({
          type: "peer-connection.description",
          description: peerConnection.localDescription!,
        })
        break
      }
      case "ice-candidate-received": {
        logger.info("[connect-peer] Received ice candidate", event.candidate)
        if (peerConnection.remoteDescription) {
          peerConnection.addIceCandidate(event.candidate)
          logger.info("[connect-peer] Added Ice candidate", event.candidate)
        } else {
          pendingIceCandidates.push(event.candidate)
          logger.info(
            "[connect-peer] Added ice candidate to pending",
            event.candidate,
          )
        }
        break
      }
      default: {
        event satisfies never
        break
      }
    }
  }

  receive(eventHandler)
  if (!input.calling && input.offer) {
    eventHandler({ type: "description-received", description: input.offer })
  }

  registerEventHandler("icecandidate", (event) => {
    if (!event.candidate) return

    sendBack({
      type: "peer-connection.ice-candidate",
      candidate: event.candidate,
    })
  })

  registerEventHandler("connectionstatechange", () => {
    if (peerConnection.connectionState === "connected") {
      sendBack({ type: "peer-connection.successful" })
      logger.info("[connect-peer] Connection successful")
      dummyDataChannel?.close()
    } else if (peerConnection.connectionState === "failed") {
      sendBack({ type: "peer-connection.failed" })
      logger.info("[connect-peer] Connection failed")
    }
  })

  if (calling) {
    dummyDataChannel = peerConnection.createDataChannel("test")
    logger.info("[connect-peer] Created dummy data channel")
    console.log("dummyDataChannel", dummyDataChannel)
    peerConnection.setLocalDescription().then(() => {
      logger.info("[connect-peer] Local description set")
      sendBack({
        type: "peer-connection.description",
        description: peerConnection.localDescription!,
      })
    })
  }

  return () => {
    for (const [type, handler] of eventHandlers) {
      peerConnection.removeEventListener(type, handler as any)
    }
  }
}

export const connectPeer = fromCallback(invoke)
