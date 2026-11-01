export function authConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const secret = env.BETTER_AUTH_SECRET
  if (!secret || secret.length < 32) throw new Error("Authentication configuration is unavailable")
  let url: URL
  try { url = new URL(env.BETTER_AUTH_URL ?? "") } catch { throw new Error("Authentication origin is invalid") }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      env.BETTER_AUTH_URL !== url.origin || (env.NODE_ENV === "production" && url.protocol !== "https:")) {
    throw new Error("Authentication origin is invalid")
  }
  return { secret, origin: url.origin, secure: url.protocol === "https:" }
}
