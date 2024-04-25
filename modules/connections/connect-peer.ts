import { fromCallback } from "xstate"
import { InvokeCallback } from "xstate/dist/declarations/src/actors/callback"

import { logger } from "@/logger"

const TIMEOUT_AFTER_ICE_GATHERING_COMPLETE_IN_SECONDS = 15000

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

export type ConnectPeerError = {
  type: "unknown"
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
      error: ConnectPeerError
    }

const invoke: InvokeCallback<
  ConnectPeerInputEvent,
  ConnectPeerOutputEvent,
  Input
> = ({ sendBack, receive, input }) => {
  const { calling, peerConnection } = input
  let dummyDataChannel: RTCDataChannel | undefined
  let pendingIceCandidates: RTCIceCandidate[] = []

  const cleanupFunctions: (() => void)[] = []

  function registerEventHandler<K extends keyof RTCPeerConnectionEventMap>(
    type: K,
    handler: (event: RTCPeerConnectionEventMap[K]) => void,
  ) {
    peerConnection.addEventListener(type, handler)
    cleanupFunctions.push(() =>
      peerConnection.removeEventListener(type, handler as any),
    )
  }

  async function eventHandler(event: ConnectPeerInputEvent) {
    switch (event.type) {
      case "description-received": {
        if (peerConnection.remoteDescription) {
          logger.warn(
            "[connect-peer] Received description, but remote description already set. Ignoring.",
          )
          return
        }

        logger.info("[connect-peer] Received description", event.description)
        await peerConnection.setRemoteDescription(event.description)
        logger.info("[connect-peer] Remote description set")

        pendingIceCandidates.map((candidate) => {
          logger.info("[connect-peer] Adding pending ice candidate", candidate)
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
          logger.info("[connect-peer] ice candidate added", event.candidate)
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

  let abortTimeout: NodeJS.Timeout | undefined
  registerEventHandler("connectionstatechange", () => {
    clearTimeout(abortTimeout)

    if (peerConnection.connectionState === "connected") {
      sendBack({ type: "peer-connection.successful" })
      logger.info("[connect-peer] Connection successful")
      dummyDataChannel?.close()
    }

    if (peerConnection.connectionState === "failed") {
      sendBack({ type: "peer-connection.failed", error: { type: "unknown" } })
      logger.info("[connect-peer] Connection failed")
    }
  })

  registerEventHandler("icegatheringstatechange", () => {
    if (peerConnection.iceGatheringState !== "complete") {
      clearTimeout(abortTimeout)
      return
    }

    abortTimeout = setTimeout(() => {
      sendBack({ type: "peer-connection.failed", error: { type: "unknown" } })
      logger.info("[connect-peer] Connection failed")
    }, TIMEOUT_AFTER_ICE_GATHERING_COMPLETE_IN_SECONDS)

    cleanupFunctions.push(() => clearTimeout(abortTimeout))
  })
  registerEventHandler("iceconnectionstatechange", () => {
    if (peerConnection.iceConnectionState !== "failed") return

    sendBack({ type: "peer-connection.failed", error: { type: "unknown" } })
    logger.info("[connect-peer] Connection failed")
  })

  if (calling) {
    dummyDataChannel = peerConnection.createDataChannel("test")
    logger.info("[connect-peer] Created dummy data channel")
    peerConnection.setLocalDescription().then(() => {
      logger.info("[connect-peer] Local description set")
      sendBack({
        type: "peer-connection.description",
        description: peerConnection.localDescription!,
      })
    })
  }

  return () => {
    cleanupFunctions.forEach((fn) => fn())
  }
}

export const connectPeer = fromCallback(invoke)
