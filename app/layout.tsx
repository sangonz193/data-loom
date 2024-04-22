import "../styles/globals.css"
import "../styles/reset.css"

import { GeistSans } from "geist/font/sans"
import { PropsWithChildren } from "react"

import { Footer } from "@/components/footer"
import { cn } from "@/lib/cn"
import { AuthProvider } from "@/modules/auth/provider/server"
import { themeClassNames } from "@/styles/themeClasses"
import { Tables } from "@/supabase/types"
import { ReactQueryProvider } from "@/utils/react-query/provider"
import { createClient } from "@/utils/supabase/server"

const defaultUrl = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000"

export const metadata = {
  metadataBase: new URL(defaultUrl),
  title: "Data Loom | Seamless Real-Time File Sharing",
  description:
    "Data Loom offers instant, secure, and anonymous file sharing directly between devices. Start sharing immediately with one-click access—no sign up required.",
}

export default async function RootLayout({ children }: PropsWithChildren) {
  const supabase = createClient()
  const authUser = await supabase.auth.getUser().then((res) => res.data.user)
  let user: Tables<"users"> | null = null
  if (authUser) {
    user = await supabase
      .from("users")
      .select("*")
      .eq("id", authUser.id)
      .single()
      .then((res) => res.data)
  }

  return (
    <html lang="en" className={GeistSans.className}>
      <body
        className={cn(
          "overflow-auto bg-background text-foreground",
          themeClassNames[
            (user?.color_id as keyof typeof themeClassNames) || "default"
          ],
        )}
      >
        <main className="min-h-screen bg-background">
          <ReactQueryProvider>
            <AuthProvider>{children}</AuthProvider>
          </ReactQueryProvider>
        </main>

        <Footer />
      </body>
    </html>
  )
}
