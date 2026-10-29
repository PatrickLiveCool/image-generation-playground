---
title: 阶段1数据库实施工作包
status: in-progress
context:
  - AGENTS.md
  - docs/implementation/spec-01-accounts.md
  - docs/operations/account-database-setup.md
---

实现主规格的数据库边界。负责且只编辑 `lib/database.ts`、`lib/database-target.ts`、`scripts/database/`（除bootstrap-admin.ts）、`deploy/database-targets.json`、`tests/database-*.test.ts`、`docs/operations/database-development.md`。不改package/CI/认证迁移SQL/UI。可读取其他文件，不提交。

契约为主规格指定的getDatabase与withTransaction。使用pg同一受限Pool；lazy；server-only不导致tsx离线测试失败。配置使用`IMAGE_DATABASE_URL`（仅runtime）、`IMAGE_MIGRATION_DATABASE_URL`（仅CLI迁移）、`IMAGE_DATABASE_TARGET=local|production`。固定库qintopia_image/schema app，固定两个role。清单production端点10.80.0.15:5432；local端点127.0.0.1:32768，禁止通过自由环境变量覆盖为别的host/db/schema/role。当前本地容器 image-playground-acceptance-pg 独立存在，可用docker exec检查但不修改其他容器。不使用生产凭据。

迁移文件固定`migrations/NNNN-name.sql`，根目录从脚本位置解析，不接受任意迁移目录；ledger `app.schema_migrations`保留版本/哈希，重跑跳过，漂移拒绝，advisory lock防竞态；检查身份和目标后才能创建ledger。执行SQL事务且限制语句不能越出app/schema/role边界，迁移不建数据库/角色、不GRANT/REVOKE其他ACL、不执行外部文件/程序。若需要可信文件检查，根据现有release固定根模式实现简单足够机制，不用脆弱正则假装完整SQL安全解析。

同时提供只用于本地夹具的bootstrap SQL/script，必须先核验容器名字和labels、仅127.0.0.1测试目标；模拟runtime与migrator、库/schema/default privileges。合成密码只用于本地，输出不含连接串。主代理执行bootstrap；可提供运行方法。单进程runtime最多4连接，迁移1连接；statement/lock/connect超时；错误脱敏。测试错误目标在连接前拒绝以及数据库身份/权限只读核实，调用者可注入假的query证明没有变更被发送。支持后续真实集成测试，导出关闭池函数供清理。

完成后报告文件、验证、未完成点。不访问真实云端/其他应用，不新建Goal。
