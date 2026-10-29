export class AccountError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message)
    this.name = "AccountError"
  }
}

export function accountErrorResponse(error: unknown): Response {
  const safe = error instanceof AccountError
    ? error
    : new AccountError("INTERNAL_ERROR", 500, "暂时无法完成操作，请稍后重试。")
  return Response.json({ error: { code: safe.code, message: safe.message } }, {
    status: safe.status,
    headers: { "Cache-Control": "no-store", ...(safe.status === 429 ? { "Retry-After": "60", "X-Retry-After": "60" } : {}) },
  })
}

export function invalidInput(message = "请检查填写的信息。") {
  return new AccountError("INVALID_INPUT", 400, message)
}
