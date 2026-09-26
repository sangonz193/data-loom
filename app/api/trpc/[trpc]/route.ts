import { fetchRequestHandler } from "@trpc/server/adapters/fetch"

import { createContext } from "@/modules/api/context"
import { appRouter } from "@/modules/api/router"

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext(req),
  })

export { handler as GET, handler as POST }
