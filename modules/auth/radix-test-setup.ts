import { Window } from "happy-dom"

const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
const window = new Window()

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: window.document,
})

try {
  await import("@radix-ui/react-use-layout-effect")
} finally {
  if (previousDocument)
    Object.defineProperty(globalThis, "document", previousDocument)
  else Reflect.deleteProperty(globalThis, "document")
  await window.happyDOM.close()
}
