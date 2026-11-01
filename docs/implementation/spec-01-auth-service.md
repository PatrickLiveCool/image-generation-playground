---
title: 阶段1认证与管理员服务实施工作包
status: in-progress
context:
  - AGENTS.md
  - docs/implementation/spec-01-accounts.md
  - docs/implementation/epic-1-context.md
---

实现主规格的认证/账号生命周期。负责且只编辑 `lib/auth/`、`app/api/auth/`、`app/api/account/`、`app/api/admin/users/`、`migrations/0001-accounts.sql`、`scripts/database/bootstrap-admin.ts`、`tests/auth-*.test.ts`。不改package/CI/数据库连接模块/UI。不提交。可以委派自己范围内独立工作但本任务共享并发紧张。

数据库模块由另一个工作包实现，接口见主规格。真实Better Auth 1.7.14已安装，可直接读node_modules官方源核对表结构/插件；不要凭记忆猜API。SQL迁移需对应精确配置（app schema/search_path），库用于哈希/验证/会话，不手写密码算法。业务原子操作可用库crypto及已验证认证表字段。角色只admin/user。用户名最小3最大32、小写规范化，允许字母数字下划线短横线；内部唯一不投递email。随机临时密码24h，首次登录只能改密/退出且单次兑换；必须考虑并发登录、重置、禁用、改密/校验后写入竞态。全局管理员修改锁可简化最后管理员保护；事务内复查调用者与账号状态。设置密码/删除session/状态字段/审计原子提交。仅认证日志不得含密码或session。创建重复用户名不覆盖。分页查询限制100行且返回总数/游标可选，前端可按实际契约协调。

`getAuth`延迟初始化，配置使用`BETTER_AUTH_SECRET`（至少32字符）和`BETTER_AUTH_URL`（严格origin，生产https）。公开路由只准sign-in/username和sign-out；get-session使用应用脱敏包装。公开端点拒绝其余BetterAuth管理、注册、role、impersonation路径；禁用cookie cache。登录账户存在性不泄漏；密码12–128；应用入口采用 PostgreSQL 原子额度并在密码运算前执行，不使用所有账号共用的库默认额度，也不只存单进程内存。会话安全cookie、origin校验（应用写入必须有严格匹配Origin）。不要从不可信请求决定baseURL/host。

维护初始化由CLI使用migration身份还是runtime需最小权限判断；只允许本项目已校验池，以事务/advisory lock确保同时启动也只有一个管理员。密码从隐藏输入或受限环境注入，不命令行参数、不输出默认密码。第二次明确拒绝，不覆盖。

提供真正行为测试，优先用tsx跑node:test，可依赖主代理准备的本地隔离PG；将测试文件标为需要专用env而非触碰任何默认连接。不要skip后声称验收。可将纯测试与集成测试分开，报告具体运行命令。官方材料与源码可核对，禁止付费模型/生产数据库操作。
