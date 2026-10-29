# 账号数据库：本地开发与迁移

数据库边界来自 `docs/implementation/spec-01-accounts.md` 和 `deploy/database-targets.json`。
本阶段仅在隔离本地夹具验证，未迁移生产，也未修改其他应用数据库。`deploy/release-policy.json`
当前仍为 `databaseMode: none`，表示发布工具尚未接线数据库准备、迁移和恢复流程，并不表示它会自动拦截包含数据库功能的制品。
本阶段不可发布；账号功能上线前必须完成后续发布工作包和对应验收。

## 固定配置与权限

| 用途 | 环境变量 | 身份 | 每进程连接上限 |
| --- | --- | --- | --- |
| 应用运行 | `IMAGE_DATABASE_URL` | `qintopia_image_app` | 4 |
| CLI 迁移 | `IMAGE_MIGRATION_DATABASE_URL` | `qintopia_image_migrator` | 1 |

两者都必须设置 `IMAGE_DATABASE_TARGET=local` 或 `production`。数据库固定 `qintopia_image`，schema 固定 `app`。
本地固定 `127.0.0.1:32768`，生产清单固定 `10.80.0.15:5432`；连接串必须显式匹配身份、目标库和端点。
不接受 URL 参数、额外 schema、任意迁移目录或 SQL 参数。`PGHOST`、`PGOPTIONS` 等不覆盖固定配置。
应用部署只注入运行连接串；迁移连接串仅交给单独维护进程。不要将任何生产凭据写入 Git、命令参数或日志。

`getDatabase()` 懒加载，同进程共用池；构建和健康检查不连接数据库。每个新连接交给调用者之前，
先只读核验 current/session user、database、schema、search_path、库/schema/object owner、角色标志和有效权限。
运行角色不允许 CREATE/TEMP、其他角色成员关系、其他 schema 写权限、迁移账本访问，或超出约定的表/序列权限。
连接超时 5 秒，statement/空闲事务超时 15 秒，锁等待 5 秒。`withTransaction()` 使用同一池，
异常回滚；`closeDatabase()` 可供测试或进程退出时清理连接。单次发布双进程重叠仍须合计连接预算。

当前固定目标清单沿用生产尚未启用数据库 TLS 的既有边界，池显式不启用 TLS；这不是端到端数据库加密声明。
改变端点或 TLS 边界需要独立更新受审阅清单与连接契约，不能通过自由 URL 参数绕过。

## 本地隔离夹具

只操作名为 `image-playground-acceptance-pg` 的专用容器。脚本要求其运行中，且标签为：

```text
codex.project=image-generation-playground
codex.task=01a17dff-bdc4-7712-9e0a-e553ae2240d6
```

只允许将容器 `5432/tcp` 绑定到 `127.0.0.1:32768`。先核验全部信息，再以容器 ID 执行 SQL，避免检查后名称替换。
此夹具的 root 用户是 `image_test_root`，只允许本地合成数据。现有容器为 PostgreSQL 18.6，
生产记录为 18.4；本地通过不等于生产版本验收。初始化执行：

```sh
node scripts/database/bootstrap-local.mjs
```

脚本创建缺失的库和两个普通身份，配置 app/default privileges；既有密码与业务数据不重置。
public schema 归夹具 root，避免默认 `pg_database_owner` 隐式赋予 migrator 在 public 建对象的权限。
幂等重跑仅收敛本项目库/schema/default privileges，不能作为生产建库脚本。
初始化还会写入专用数据库 COMMENT，包含固定合成夹具 ID 和本次核验的完整容器 ID；已有未知标记会拒绝初始化。
运行身份只读 `pg_database` 的描述，不需要新增表或放宽表/迁移账本权限。

认证集成测试每次删除前必须调用 `assertAccountTestFixture(pool)`。它重新核验容器名、完整 ID、标签和唯一回环绑定，
通过该 ID 在容器内执行只读查询，并比较应用连接返回的数据库 OID、服务器启动时间、版本和 COMMENT。
仅验证连接 URL 或检查同名容器存在不足以排除端口转发。检查还要求所有账号属于固定合成用户名集合，
且邮箱精确等于 `<账号ID>@accounts.invalid`；仅有内部邮箱后缀不足以允许清理。发现未知账号时先停止测试，不能自动删除或扩展白名单。

本地合成连接（仅用于上述夹具，不是可用于任何真实环境的秘密）：

```sh
export IMAGE_DATABASE_TARGET=local
export IMAGE_DATABASE_URL='postgresql://qintopia_image_app:synthetic-local-runtime-only@127.0.0.1:32768/qintopia_image'
export IMAGE_MIGRATION_DATABASE_URL='postgresql://qintopia_image_migrator:synthetic-local-migrator-only@127.0.0.1:32768/qintopia_image'
node --import tsx scripts/database/migrate.ts
```

初始化与迁移输出不包含连接串。若连接失败，不靠错误日志回显密码诊断；先核验指定夹具和迁移账本。
`tsx` 也支持通过 `pnpm exec tsx` 运行，但某些沙箱限制其 IPC，`node --import tsx` 无此额外 IPC 要求。

## 迁移可信来源与账本

迁移固定从脚本位置解析仓库根的 `migrations/NNNN-name.sql`，不读取当前工作目录或环境变量提供的目录。
目录与文件不可为符号链接，不可供组/其他用户写入，所有者须为执行用户或 root；SQL 文件不得为硬链接。
所有文件必须与 `scripts/database/migration-catalog.ts` 的固定 SHA-256 完全一致。

SQL 是受审阅的项目代码，审核清单是允许执行的精确字节集合；这不是通用 SQL 安全解析器。
新增迁移必须完整审阅并人工更新清单：只操作 app 的本项目对象，不建库/角色，不改其他 schema 或 ACL，
不执行文件、程序、动态 SQL。当前 `0001` 只创建认证/审计/限流表与索引，默认授权来自夹具或已准备的生产 schema。
不得把“自动重算所有哈希”当作迁移准入检查。迁移维护者本来有代码执行权限；文件可信检查不防御拥有同一系统身份的攻击者。

身份校验通过后才获取本项目 advisory lock，并在一个事务中维护 `app.schema_migrations` 和执行未执行的迁移。
账本保存版本、文件名、SHA-256 和执行时间；运行角色不能读取或改写账本。重复运行跳过相同版本，
历史哈希/文件名变更或未知版本立即拒绝并回滚。数据库报错不输出原始 SQL/连接串；提交结果未知时先只读核对账本。
追加迁移遵循先扩展后收缩，不通过修改已执行 SQL 或清空账本修复失败；数据库恢复与发布接线另行验收。

## 验证命令

```sh
node --import tsx --test tests/database-boundary.test.ts
IMAGE_DATABASE_INTEGRATION=1 node --import tsx --test tests/database-integration.test.ts
```

离线测试不需要数据库，覆盖错误目标在建池前拒绝、只读身份拒绝、文件/哈希拒绝、事务失败回滚、账本漂移与锁释放。
集成测试必须显式启用，内部只采用固定本地合成连接，不继承生产 URL。它验证并发迁移幂等、默认 CRUD/序列授权、
事务提交/回滚以及运行身份无法建/改表、建角色、建 schema、CREATE TEMP、SET ROLE 或访问账本。
数据库集成测试另在本库创建独立合成 schema/序列，分别赋予运行身份 USAGE 与 UPDATE，验证实际可写但连接边界拒绝，
并在 finally 删除该 schema。其合成表和序列均在 finally 清理，不删除认证表或账号数据。
认证集成测试会清理通过专用标记和账号白名单核验的合成认证数据。CI 可在同名同标签的可丢弃容器初始化后运行相同检查。

## 账号维护与验收

首次管理员使用 `pnpm db:bootstrap-admin`，交互输入用户名、名称及不回显密码；自动化只通过受限进程环境注入 `BOOTSTRAP_ADMIN_USERNAME`、`BOOTSTRAP_ADMIN_NAME`、`BOOTSTRAP_ADMIN_PASSWORD`。命令不接受密码参数，不重置既有管理员，只持有runtime身份。

账号真实集成：为固定本地夹具设置 `IMAGE_AUTH_TEST_DATABASE_URL` 后执行 `pnpm test:auth`。每次删除前核验容器/标记及合成账号清单；未知账号立即拒绝。`pnpm build` 后可运行 `IMAGE_ACCOUNT_HTTP_INTEGRATION=1 pnpm test:account-http`，它只启动127.0.0.1:3107上的临时standalone，验证20项账号HTTP断言并清理两个专用合成账号，不调用模型或COS。

登录按规范化用户名10次/分钟、改密按账号5次/分钟、管理员开户与重置按管理员10次/分钟；额度持久化并原子计算，失败/回滚仍消耗。真实部署的可信代理来源级请求保护在发布接线阶段核验，不能把未校验的X-Forwarded-For当成可信身份。
