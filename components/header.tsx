import { CreateConnectionDialog } from "../modules/connections/create/dialog/create-connection-dialog"

export function Header() {
  return (
    <div className="mx-auto h-14 w-full max-w-4xl flex-row items-center px-4">
      <CreateConnectionDialog className="ml-auto" />
    </div>
  )
}
