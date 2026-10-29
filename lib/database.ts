import { Pool, type PoolClient, type PoolConfig } from "pg"
import {
  DatabaseBoundaryError, readDatabaseConfiguration, verifyDatabaseIdentity,
  type DatabasePurpose,
} from "./database-target"

// pg 及 Node 网络模块仅在服务端使用；不导入会阻断 tsx 离线维护命令的 server-only 占位包。
if (typeof window !== "undefined") throw new Error("数据库模块只能在服务端使用。")

type VerifiedPoolConfig = PoolConfig & { onConnect: (client: PoolClient) => Promise<void> }
type PoolFactory = (configuration: VerifiedPoolConfig) => Pool

/** 工厂可注入；错误配置在构造池（也就是任何网络连接）之前拒绝。 */
export function createDatabasePool(
  purpose: DatabasePurpose,
  environment: NodeJS.ProcessEnv = process.env,
  factory: PoolFactory = (configuration) => new Pool(configuration),
): Pool {
  const configuration = readDatabaseConfiguration(purpose, environment)
  const pool = factory({
    host: configuration.host,
    port: configuration.port,
    database: configuration.database,
    user: configuration.user,
    password: configuration.password,
    ssl: false,
    max: purpose === "runtime" ? 4 : 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
    idleTimeoutMillis: 30_000,
    application_name: `qintopia-image-${purpose}`,
    options: "-c search_path=app,pg_catalog",
    // pg-pool 的 onConnect Promise 在连接交给调用者之前完成，失败会销毁该连接。
    onConnect: async (client) => verifyDatabaseIdentity(client, configuration),
  })
  // 空闲连接异常交给下次请求恢复；不输出可能含凭据/SQL 的原始服务端消息。
  pool.on("error", () => {})
  return pool
}

const runtimeState = globalThis as typeof globalThis & { imageDatabasePool?: Promise<Pool> }

/** 构建、导入和健康检查均不创建池。每进程共享一个已经通过核验的池。 */
export async function getDatabase(): Promise<Pool> {
  if (!runtimeState.imageDatabasePool) {
    const pending = (async () => {
      const pool = createDatabasePool("runtime")
      try {
        const client = await pool.connect()
        client.release()
        return pool
      } catch (error) {
        await pool.end().catch(() => {})
        if (error instanceof DatabaseBoundaryError) throw error
        throw new DatabaseBoundaryError("DATABASE_UNAVAILABLE", "数据库暂时不可用。")
      }
    })()
    runtimeState.imageDatabasePool = pending
    void pending.catch(() => {
      if (runtimeState.imageDatabasePool === pending) delete runtimeState.imageDatabasePool
    })
  }
  return runtimeState.imageDatabasePool
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = await getDatabase()
  const client = await pool.connect()
  let discard = false
  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    try { await client.query("ROLLBACK") } catch { discard = true }
    throw error
  } finally {
    client.release(discard)
  }
}

export async function closeDatabase(): Promise<void> {
  const pending = runtimeState.imageDatabasePool
  delete runtimeState.imageDatabasePool
  if (pending) await (await pending).end()
}
