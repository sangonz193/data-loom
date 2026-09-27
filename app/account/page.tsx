import { Account } from "@/modules/auth/account/account"

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ confirmation?: string }>
}) {
  const { confirmation } = await searchParams
  return <Account confirmation={confirmation} />
}
