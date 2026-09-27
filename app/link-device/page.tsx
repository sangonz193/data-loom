import { assertUser } from "@/app/utils/user-session"
import { LinkDevice } from "@/modules/auth/device-link/link-device"
import { RequiredAuthClient } from "@/modules/auth/required"

export default async function Page() {
  const user = await assertUser({ redirectTo: "/link-device" })
  return (
    <RequiredAuthClient user={user}>
      <LinkDevice />
    </RequiredAuthClient>
  )
}
