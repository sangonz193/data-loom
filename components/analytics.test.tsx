import { expect, mock, test } from "bun:test"
import { Window } from "happy-dom"
import { act } from "react"
import { createRoot } from "react-dom/client"

import { Analytics } from "./analytics"

test("analytics redacts fragments before pageview and event callbacks", async () => {
  const window = new Window({
    url: "https://app.test/link-device#setup=ABCDEFGH",
  })
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  )
  const previousAct = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  )
  const calls: unknown[][] = []
  ;(window as unknown as { va: (...args: unknown[]) => void }).va = mock(
    (...args) => {
      calls.push(args)
    },
  )
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: window,
  })
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: window.document,
  })
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  })
  const script = window.document.createElement("script")
  script.src = "https://va.vercel-scripts.com/v1/script.debug.js"
  window.document.head.append(script)
  const root = createRoot(
    window.document.createElement("div") as unknown as HTMLElement,
  )
  try {
    await act(async () => root.render(<Analytics />))
    const beforeSend = calls.find(
      ([name]) => name === "beforeSend",
    )?.[1] as (event: { type: string; url: string }) => { url: string }
    expect(beforeSend).toBeDefined()
    for (const type of ["pageview", "event"])
      expect(
        beforeSend({ type, url: "https://app.test/link-device#setup=ABCDEFGH" })
          .url,
      ).toBe("https://app.test/link-device")
  } finally {
    await act(async () => root.unmount())
    if (previous) Object.defineProperty(globalThis, "window", previous)
    else Reflect.deleteProperty(globalThis, "window")
    if (previousDocument)
      Object.defineProperty(globalThis, "document", previousDocument)
    else Reflect.deleteProperty(globalThis, "document")
    if (previousAct)
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
    await window.happyDOM.close()
  }
})
