import { initTRPC, TRPCError } from "@trpc/server"
import superjson from "superjson"

import type { createContext } from "./context"

const t = initTRPC.context<Awaited<ReturnType<typeof createContext>>>().create({
  transformer: superjson,
})

export const router = t.router
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) throw new TRPCError({ code: "UNAUTHORIZED" })
  return next({ ctx: { userId: ctx.userId } })
})
