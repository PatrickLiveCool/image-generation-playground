import { withTransaction } from "../database"
import { AccountError, accountErrorResponse } from "./errors"
import { accountIdentity, assertSameOrigin, recheckAccount, safeUser, type AccountIdentity } from "./guards"
import type { AccountUser } from "../account-types"
import { getAuth } from "./server"
import { authTransaction } from "./transaction"
import { normalizeUsername, readJson } from "./validation"
import { consumeAccountRateLimit } from "./rate-limit"

export async function handleAuthRequest(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname
  if (request.method !== "POST" || !["/api/auth/sign-in/username", "/api/auth/sign-out"].includes(pathname)) {
    return Response.json({ error: { code: "NOT_FOUND", message: "接口不存在。" } }, { status: 404, headers: { "Cache-Control": "no-store" } })
  }
  try {
    assertSameOrigin(request)
    const auth = await getAuth()
    await auth.$context // Initialize the library before binding a transaction.
    if (pathname === "/api/auth/sign-out") {
      let identity: AccountIdentity | undefined
      try { identity = await accountIdentity(request.headers, { allowPasswordChange: true }) } catch (error) {
        if (!(error instanceof AccountError) || error.code !== "UNAUTHENTICATED") throw error
      }
      return await withTransaction((client) => authTransaction.run(client, async () => {
        if (identity) {
          await recheckAccount(client, identity, { allowPasswordChange: true })
          await client.query('DELETE FROM app.session WHERE id=$1', [identity.sessionId])
          await client.query('INSERT INTO app.account_audit ("actorId","subjectId",action) VALUES ($1,$1,$2)', [identity.user.id, "sign-out"])
        }
        const response = await auth.handler(new Request(request.url, { method: "POST", headers: request.headers, body: "{}" }))
        response.headers.set("Cache-Control", "no-store")
        return response
      }))
    }
    const input = await readJson(request)
    let username = ""
    try { username = normalizeUsername(input.username) } catch { /* Invalid names use a bounded, shared invalid-input bucket. */ }
    const password = typeof input.password === "string" && input.password.length >= 12 && input.password.length <= 128 ? input.password : ""
    await consumeAccountRateLimit("sign-in", username)
    const body = JSON.stringify({ username, password, rememberMe: input.rememberMe !== false })
    return await withTransaction((client) => authTransaction.run(client, async () => {
      // The lock spans the library's password check and INSERT session. Reset,
      // disable and password change must wait, then revoke anything it created.
      await client.query('SELECT id FROM app."user" WHERE username=$1 FOR UPDATE', [username])
      const response = await auth.handler(new Request(request.url, { method: "POST", headers: request.headers, body }))
      if (response.status >= 500) throw new Error("Authentication operation failed")
      if (!response.ok && response.status !== 429) {
        return accountErrorResponse(new AccountError("INVALID_CREDENTIALS", 401, "用户名或密码不正确，或账号暂不可用。请联系管理员。"))
      }
      response.headers.set("Cache-Control", "no-store")
      if (response.ok) {
        const body = await response.json() as { user: AccountUser }
        // Authentication stays in the HttpOnly cookie. The UI never needs the
        // library's raw token, internal email, ban metadata or credential state.
        return Response.json({ redirect: false, user: safeUser(body.user) }, { headers: response.headers })
      }
      return response
    }))
  } catch (error) { return accountErrorResponse(error) }
}
