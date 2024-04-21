import { useAuthContext } from "./provider/client"
import { useRequiredAuth } from "./required"

export function useUser() {
  return useAuthContext().user
}

export function useRequiredUser() {
  return useRequiredAuth().user
}
