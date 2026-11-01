import { AsyncLocalStorage } from "node:async_hooks"
import type { Pool, PoolClient } from "pg"

// Better Auth 1.7.14's Kysely PostgreSQL adapter acquires/releases a PoolClient
// for each query. During a login the application owns the enclosing transaction:
// bind those acquisitions to that client, keeping password verification, one-time
// redemption, session insertion and audit in the same row-lock lifetime.
export const authTransaction = new AsyncLocalStorage<PoolClient>()

export function transactionAwareAuthPool(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect") return async () => {
        const client = authTransaction.getStore()
        if (!client) return target.connect()
        return new Proxy(client, {
          get(connection, member) {
            if (member === "release") return () => undefined
            const value = Reflect.get(connection, member)
            return typeof value === "function" ? value.bind(connection) : value
          },
        })
      }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
