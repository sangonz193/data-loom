import Link from "next/link"

import { Button } from "@/components/ui/button"

export default async function Index() {
  return (
    <div>
      Index
      <Button asChild>
        <Link href="/home">Home</Link>
      </Button>
    </div>
  )
}
