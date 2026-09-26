import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { createAdminClient } from "@/utils/supabase/admin"

import { protectedProcedure, router } from "./trpc"
import { canonicalConnectionIds } from "../connections/create/connection-ids"

export const appRouter = router({
  connections: router({
    delete: protectedProcedure
      .input(z.object({ remotePersonId: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        const admin = createAdminClient()
        const { data: person, error: personError } = await admin
          .from("people")
          .select("id")
          .eq("auth_user_id", ctx.userId)
          .maybeSingle()
        if (personError) throw personError
        if (!person) throw new TRPCError({ code: "FORBIDDEN" })

        const [person_1_id, person_2_id] = canonicalConnectionIds(
          person.id,
          input.remotePersonId,
        )
        const { data, error } = await admin
          .from("connections")
          .delete()
          .match({ person_1_id, person_2_id })
          .select("person_1_id")
          .maybeSingle()
        if (error) throw error
        if (!data) throw new TRPCError({ code: "NOT_FOUND" })
      }),
  }),
})

export type AppRouter = typeof appRouter
