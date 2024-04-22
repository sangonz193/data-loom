import { ChevronRightIcon } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"

export default function Index() {
  return (
    <div className="my-auto px-4 py-10">
      <h1 className="mx-auto text-8xl font-bold tracking-tight">Data Loom</h1>

      <span className="mx-auto mt-4 w-full max-w-xl text-center text-lg text-muted-foreground">
        Seamless file and text sharing directly between devices. Built on the
        power of WebRTC technology, Data-Loom ensures your data transfers are
        secure, fast, and direct—no middlemen involved.
      </span>

      <Button className="mx-auto mt-10" size="lg" asChild>
        <Link href="/home">
          Start Sharing Files
          <ChevronRightIcon />
        </Link>
      </Button>
    </div>
  )
}
