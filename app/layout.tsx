import "../styles/globals.css"
import "../styles/reset.css"

import { GeistSans } from "geist/font/sans"
import { PropsWithChildren } from "react"

import { cn } from "@/lib/cn"
import { themeClassNames } from "@/styles/themeClasses"

const defaultUrl = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000"

export const metadata = {
  metadataBase: new URL(defaultUrl),
  title: "Next.js and Supabase Starter Kit",
  description: "The fastest way to build apps with Next.js and Supabase",
}

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <html lang="en" className={GeistSans.className}>
      <body
        className={cn("bg-background text-foreground", themeClassNames.default)}
      >
        <main className="min-h-screen bg-background">{children}</main>
      </body>
    </html>
  )
}
