"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { TRPCClientError } from "@trpc/client"
import { formatDistanceToNow } from "date-fns"
import { useState, type FormEvent } from "react"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useTRPC } from "@/modules/api/client"
import { DEVICE_NAME_MAX_LENGTH } from "@/modules/connections/device-name"
import { useDevice } from "@/modules/connections/use-device"
import { createClient } from "@/utils/supabase/client"

import { useRequiredUser } from "../use-user"

type DeviceRow = { id: string; name: string; last_seen_at: string }

export function Devices() {
  const user = useRequiredUser()
  const {
    device,
    error: registrationError,
    retry: retryRegistration,
  } = useDevice()
  const supabase = createClient()
  const queryClient = useQueryClient()
  const trpc = useTRPC()
  const [editing, setEditing] = useState<string>()
  const [removing, setRemoving] = useState<DeviceRow>()
  const [renameError, setRenameError] = useState("")
  const [removeError, setRemoveError] = useState("")
  const queryKey = ["devices", user.id]
  const devices = useQuery({
    queryKey,
    enabled: !!device,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("devices")
        .select("id, name, last_seen_at")
        .order("last_seen_at", { ascending: false })
        .order("id")
      if (error) throw error
      return data
    },
  })
  const rename = useMutation(trpc.devices.rename.mutationOptions())
  const remove = useMutation(trpc.devices.remove.mutationOptions())

  async function submitRename(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault()
    setRenameError("")
    try {
      await rename.mutateAsync({
        id,
        name: String(new FormData(event.currentTarget).get("name")),
      })
      setEditing(undefined)
      await queryClient.invalidateQueries({ queryKey })
    } catch (error) {
      const code =
        error instanceof TRPCClientError ? error.data?.code : undefined
      if (code === "NOT_FOUND") {
        setRenameError("This device was already removed.")
        await queryClient.invalidateQueries({ queryKey })
      } else if (code === "BAD_REQUEST") {
        setRenameError(
          `Enter a name (up to ${DEVICE_NAME_MAX_LENGTH} characters).`,
        )
      } else {
        setRenameError("Couldn’t rename this device. Try again.")
      }
    }
  }

  async function confirmRemove() {
    if (!removing) return
    setRemoveError("")
    try {
      await remove.mutateAsync({ id: removing.id })
    } catch (error) {
      const code =
        error instanceof TRPCClientError ? error.data?.code : undefined
      if (code !== "NOT_FOUND") {
        setRemoveError("Couldn’t remove this device. Try again.")
        return
      }
    }
    setRemoving(undefined)
    await queryClient.invalidateQueries({ queryKey })
  }

  const rows = devices.data?.slice().sort((a, b) =>
    a.id === device?.id ? -1
    : b.id === device?.id ? 1
    : Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at) ||
      a.id.localeCompare(b.id),
  )

  return (
    <section className="flex flex-col gap-3" aria-label="Devices">
      <h2 className="text-lg font-semibold">Devices</h2>
      <p>Browsers that have used Data Loom with this account.</p>
      {registrationError ?
        <div>
          <p role="alert">Couldn’t register this browser.</p>
          <Button variant="outline" onClick={retryRegistration}>
            Retry
          </Button>
        </div>
      : !device ?
        <p role="status">Registering this browser…</p>
      : devices.isError ?
        <div>
          <p role="alert">Couldn’t load devices.</p>
          <Button variant="outline" onClick={() => void devices.refetch()}>
            Retry
          </Button>
        </div>
      : devices.isPending ?
        <p role="status">Loading devices…</p>
      : <>
          {rows?.every((row) => row.id === device.id) && (
            <p>No other devices yet.</p>
          )}
          <ul className="flex flex-col gap-3">
            {rows?.map((row) => (
              <li key={row.id} className="rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <strong>{row.name}</strong>
                  {row.id === device.id && <span>This browser</span>}
                </div>
                <p>
                  Last seen{" "}
                  {formatDistanceToNow(new Date(row.last_seen_at), {
                    addSuffix: true,
                  })}
                </p>
                {editing === row.id ?
                  <form
                    onSubmit={(event) => void submitRename(event, row.id)}
                    className="flex flex-col gap-2"
                  >
                    <label htmlFor={`device-name-${row.id}`}>Device name</label>
                    <Input
                      id={`device-name-${row.id}`}
                      name="name"
                      defaultValue={row.name}
                      maxLength={DEVICE_NAME_MAX_LENGTH}
                    />
                    {renameError && <p role="alert">{renameError}</p>}
                    <div className="flex gap-2">
                      <Button disabled={rename.isPending}>Save</Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setEditing(undefined)
                          setRenameError("")
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                : <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setEditing(row.id)
                        setRenameError("")
                      }}
                    >
                      Rename
                    </Button>
                    {row.id !== device.id && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setRemoving(row)
                          setRemoveError("")
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                }
              </li>
            ))}
          </ul>
        </>
      }
      {removing && (
        <AlertDialog
          open={!!removing}
          onOpenChange={(open) => {
            if (!open && !remove.isPending) setRemoving(undefined)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Remove “{removing?.name}” from this list?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This deletes the entry and any file requests it’s still sending.
                It doesn’t sign that browser out. If it opens Data Loom again,
                it’s added back as a new entry.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {removeError && <p role="alert">{removeError}</p>}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>
                Cancel
              </AlertDialogCancel>
              <Button
                disabled={remove.isPending}
                onClick={() => void confirmRemove()}
              >
                Remove
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </section>
  )
}
