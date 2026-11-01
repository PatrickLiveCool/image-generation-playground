import type { Pool } from "pg"
import {
  inspectLocalFixture, LOCAL_FIXTURE_IDENTITY_SQL, localFixtureMarker, readLocalFixtureIdentity,
} from "./bootstrap-local.mjs"

// 只有本套测试实际创建的账号可被清理；accounts.invalid 是应用通用内部地址，单独不足以证明合成数据。
const ACCOUNT_TEST_USERNAMES = new Set([
  "test_admin", "other_admin", "new_user", "rollback_user", "expired_user", "second_admin",
  "norm_user", "rate_user", "admin_rate_user",
  "http_acceptance_admin", "http_acceptance_user",
  "provider-admin-a", "provider-admin-b", "provider-user", "provider-temp", "provider-evidence-admin",
  "admission_test_user_a", "admission_test_user_b",
])

type FixtureIdentity = {
  database?: unknown
  databaseOid?: unknown
  serverStartedAt?: unknown
  serverVersion?: unknown
  marker?: unknown
}

export function assertMatchingFixtureIdentity(containerId: string, actual: FixtureIdentity, expected: FixtureIdentity): void {
  const marker = localFixtureMarker(containerId)
  if (actual.database !== "qintopia_image" || expected.database !== "qintopia_image" ||
      actual.marker !== marker || expected.marker !== marker ||
      !["databaseOid", "serverStartedAt", "serverVersion"].every((key) => {
        const value = actual[key as keyof FixtureIdentity]
        return typeof value === "string" && value.length > 0 && value === expected[key as keyof FixtureIdentity]
      })) throw new Error("连接未绑定已核验的专用合成数据库夹具，禁止清理。")
}

export function assertSyntheticAccountRows(rows: Record<string, unknown>[]): void {
  if (rows.some((row) => typeof row.id !== "string" || typeof row.username !== "string" ||
      !ACCOUNT_TEST_USERNAMES.has(row.username) || row.email !== `${row.id}@accounts.invalid`)) {
    throw new Error("数据库包含不在合成测试清单内的账号，禁止清理。")
  }
}

/** 每次清理前调用；只读取容器、服务器标记与账号，不修改 ACL 或数据库。 */
export async function assertAccountTestFixture(pool: Pool): Promise<void> {
  const container = inspectLocalFixture()
  const client = await pool.connect()
  try {
    const { rows } = await client.query(LOCAL_FIXTURE_IDENTITY_SQL)
    if (rows.length !== 1 || !rows[0]?.fixture) throw new Error("专用数据库夹具标记缺失，禁止清理。")
    assertMatchingFixtureIdentity(container.Id, rows[0].fixture, readLocalFixtureIdentity(container.Id))
    const accounts = await client.query('SELECT id, username, email FROM app."user"')
    assertSyntheticAccountRows(accounts.rows)
  } finally { client.release() }
}
