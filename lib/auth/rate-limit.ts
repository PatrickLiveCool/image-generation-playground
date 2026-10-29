import { createHash, randomUUID } from "node:crypto"
import { getDatabase } from "../database"
import { AccountError } from "./errors"

const limits = { "sign-in": 10, "change-password": 5, "admin-password": 10 } as const
const WINDOW_MS = 60_000

// This query commits before any password work or business transaction starts.
// Failed verification and rolled-back mutations still consume their allowance.
// PostgreSQL's unique-key conflict lock serializes concurrent requests across
// processes. Neither the key nor its subject is derived from forwarded IPs.
export async function consumeAccountRateLimit(scope: keyof typeof limits, subject: string) {
  const pool = await getDatabase()
  const key = `accounts:${scope}:${createHash("sha256").update(subject).digest("hex")}`
  const { rowCount } = await pool.query(
    `INSERT INTO app."rateLimit" (id,key,count,"lastRequest")
     VALUES ($1,$2,1,floor(extract(epoch FROM statement_timestamp())*1000)::bigint)
     ON CONFLICT (key) DO UPDATE SET
       count=CASE WHEN app."rateLimit"."lastRequest" <= floor(extract(epoch FROM statement_timestamp())*1000)::bigint-$3 THEN 1 ELSE app."rateLimit".count+1 END,
       "lastRequest"=CASE WHEN app."rateLimit"."lastRequest" <= floor(extract(epoch FROM statement_timestamp())*1000)::bigint-$3 THEN floor(extract(epoch FROM statement_timestamp())*1000)::bigint ELSE app."rateLimit"."lastRequest" END
     WHERE app."rateLimit"."lastRequest" <= floor(extract(epoch FROM statement_timestamp())*1000)::bigint-$3 OR app."rateLimit".count<$4
     RETURNING count`,
    [randomUUID(), key, WINDOW_MS, limits[scope]],
  )
  if (!rowCount) throw new AccountError("RATE_LIMITED", 429, "尝试次数过多，请一分钟后重试。")
}
