import { betterAuth } from "better-auth"
import { APIError } from "better-auth/api"
import { admin, username } from "better-auth/plugins"
import { getDatabase } from "../database"
import { authConfiguration } from "./config"
import { authTransaction, transactionAwareAuthPool } from "./transaction"

async function createAuth() {
  const config = authConfiguration()
  const pool = await getDatabase()
  return betterAuth({
    appName: "图像生成实验室",
    baseURL: config.origin,
    basePath: "/api/auth",
    secret: config.secret,
    trustedOrigins: [config.origin],
    database: transactionAwareAuthPool(pool),
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128 },
    plugins: [
      username({ minUsernameLength: 3, maxUsernameLength: 32, usernameValidator: (value) => /^[a-zA-Z0-9_-]{3,32}$/.test(value) }),
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
    ],
    user: { additionalFields: {
      mustChangePassword: { type: "boolean", required: true, defaultValue: true, input: false },
      temporaryPasswordExpiresAt: { type: "date", required: false, input: false, returned: false },
      temporaryPasswordUsedAt: { type: "date", required: false, input: false, returned: false },
    } },
    session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false }, disableSessionRefresh: true },
    // Public sign-in is wrapped by our atomic, per-username PostgreSQL limiter.
    // The library's shared fallback bucket would let one client block everyone.
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: config.secure,
      // No client-supplied forwarded IP is trusted.
      ipAddress: { ipAddressHeaders: [] },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: config.secure, path: "/" },
    },
    logger: { disabled: true },
    // better-call otherwise writes unknown errors directly to console even
    // when the Better Auth logger is disabled. Let the app redact them instead.
    onAPIError: { throw: true },
    databaseHooks: { session: { create: { before: async (session) => {
      const client = authTransaction.getStore()
      if (!client) throw new APIError("UNAUTHORIZED", { code: "INVALID_USERNAME_OR_PASSWORD", message: "用户名或密码不正确。" })
      const { rows: [user] } = await client.query<{
        banned: boolean; mustChangePassword: boolean; temporaryPasswordExpiresAt: Date | null; temporaryPasswordUsedAt: Date | null
      }>('SELECT banned, "mustChangePassword", "temporaryPasswordExpiresAt", "temporaryPasswordUsedAt" FROM app."user" WHERE id=$1 FOR UPDATE', [session.userId])
      if (!user || user.banned || (user.mustChangePassword && (!user.temporaryPasswordExpiresAt || user.temporaryPasswordUsedAt || user.temporaryPasswordExpiresAt <= new Date()))) {
        throw new APIError("UNAUTHORIZED", { code: "INVALID_USERNAME_OR_PASSWORD", message: "用户名或密码不正确。" })
      }
      if (user.mustChangePassword) {
        await client.query('UPDATE app."user" SET "temporaryPasswordUsedAt"=now(), "updatedAt"=now() WHERE id=$1', [session.userId])
      }
      await client.query('INSERT INTO app.account_audit ("actorId", "subjectId", action) VALUES ($1,$1,$2)', [session.userId, "sign-in"])
      return { data: { ...session, ...(user.mustChangePassword ? { expiresAt: user.temporaryPasswordExpiresAt! } : {}) } }
    } } } },
  })
}

let instance: ReturnType<typeof createAuth> | undefined
export function getAuth() {
  return instance ??= createAuth().catch((error) => { instance = undefined; throw error })
}
