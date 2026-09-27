import { SQL } from "bun"

/**
 * @typedef {readonly [string, ReadonlyArray<unknown>]} Statement
 */

/**
 * @param {string} databaseUrl
 * @param {string} text
 * @param {ReadonlyArray<unknown>} [params]
 * @returns {Promise<any[]>}
 */
export async function queryDatabase(databaseUrl, text, params = []) {
  const sql = new SQL(databaseUrl)
  try {
    return await sql.unsafe(text, [...params])
  } finally {
    await sql.close()
  }
}

/**
 * @param {string} databaseUrl
 * @param {{
 *   hold: ReadonlyArray<Statement>
 *   finish?: ReadonlyArray<Statement>
 *   outcome?: "commit" | "rollback"
 * }} options
 */
export async function holdDeviceLinkRows(
  databaseUrl,
  { hold, finish = [], outcome = "commit" },
) {
  const sql = new SQL(databaseUrl)
  const gate = Promise.withResolvers()
  const ready = Promise.withResolvers()
  const rollback = new Error("rollback")
  let holderPid

  const transaction = sql
    .begin(async (tx) => {
      const [{ pid }] = await tx`select pg_backend_pid()::int as pid`
      holderPid = pid
      for (const [text, params] of hold) await tx.unsafe(text, [...params])
      ready.resolve()
      await gate.promise
      for (const [text, params] of finish) await tx.unsafe(text, [...params])
      if (outcome === "rollback") throw rollback
    })
    .catch((error) => {
      if (error === rollback) return
      ready.reject(error)
      throw error
    })
  await ready.promise

  const poll = async (predicate, message) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(message)
  }

  return {
    waitForBlocked: (count = 1) =>
      poll(async () => {
        const [{ blocked }] =
          await sql`select count(*)::int as blocked from pg_stat_activity where ${holderPid} = any(pg_blocking_pids(pid))`
        return blocked >= count
      }, "Expected operations blocked by the held rows"),
    waitUntilBlocked: () =>
      poll(async () => {
        const [{ blocked }] =
          await sql`select cardinality(pg_blocking_pids(${holderPid})) > 0 as blocked`
        return blocked
      }, "Expected the held transaction to block"),
    release: async () => {
      gate.resolve()
      await transaction
    },
    close: async () => {
      gate.resolve()
      await transaction.catch(() => undefined)
      await sql.close()
    },
  }
}
