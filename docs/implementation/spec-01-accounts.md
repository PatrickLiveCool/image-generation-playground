---
title: 阶段1：管理员开户与受限账号登录
status: verified-locally
baseline_commit: ac5547771bbcce2ce9dfe1a2c74b18f3b5cac13c
context:
  - AGENTS.md
  - docs/implementation/epic-1-context.md
  - docs/planning/epics.md
  - docs/architecture/account-persistence/ARCHITECTURE-SPINE.md
---

## Intent

交付 Epic 1 的完整闭环：首位管理员通过维护命令初始化，登录后台开户，普通用户以一次性临时密码登录并改密，管理员禁用、恢复或重置账号，旧会话立即失效。用户已授权连续实现、自行阶段验收、commit 和依赖 PR，常规步骤不再逐项访谈。

## Boundaries

只写本仓库、隔离本地数据库；绝不连接其他应用数据库试写，不修改生产实例、账号、ACL 或服务。仅新建本 Epic 的认证、审计、限流与迁移账本对象。Better Auth 1.7.14、pg 8.23.1；不升级 Next/React。用成熟库进行密码哈希、凭证校验与会话管理；原子业务操作可在同一 PostgreSQL 事务中维护认证表，并写明字段契约及版本。所有接口服务端鉴权，未改密会话只可改密/退出。公开注册、impersonation、任意角色修改及删除账号接口不可访问。

## Shared contracts

- `lib/database.ts`: `getDatabase(): Promise<Pool>` 返回已校验运行池；`withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>`。连接每进程 max=4；迁移单连接。只接固定 qintopia_image/app/预期身份和部署目标清单。
- `lib/auth/server.ts`: `getAuth()` 延迟创建 Better Auth；`lib/auth/guards.ts`: `requireAccount(headers: Headers, options?: {admin?: boolean; allowPasswordChange?: boolean})` 返回安全用户 `{id,username,name,role,mustChangePassword}`；错误由 `accountErrorResponse(error)` 转成 `{error:{code,message}}`，不含内部原因。`assertSameOrigin(request)` 保护所有应用写入口。
- `GET /api/account/session` -> `{user: AccountUser|null}`；无 session 返回 null；临时会话返回 mustChangePassword=true。
- `POST /api/auth/sign-in/username` -> Better Auth 正常响应，失败统一消息；`POST /api/auth/sign-out`；其余公开认证路径默认拒绝。
- `POST /api/account/password` body `{currentPassword,newPassword}` -> `{ok:true}`，成功撤销旧会话，用户回登录页重新登录。
- `GET /api/admin/users` -> `{users:[{id,username,name,role,banned,mustChangePassword,createdAt}]}`（上限/分页可采用明确 limit）；`POST` body `{username,name}` -> `{user,temporaryPassword,expiresAt}`。
- `POST /api/admin/users/[id]` body `{action:'disable'|'restore'|'reset-password'}` -> `{ok:true}` 或重置返回 `{ok:true,temporaryPassword,expiresAt}`。
- 临时密码由服务端随机产生，24小时到期，只成功兑换一次；丢失响应/退出未改密需管理员明确重置。密码12–128字符；登录错误不枚举账号。
- 前端中文页面 `/login`、`/change-password`、`/admin/users`；账号框可显示后台入口与退出。管理员创建仅普通用户，首位管理员由维护命令输入；最后一个可用管理员禁止禁用或重置为未激活状态。

## Tasks & Acceptance

- [x] DB：错误配置在网络连接前拒绝；连接后只读核实 database/current_user/session_user/schema/角色标志/有效权限，然后才能写。迁移固定仓库目录、检查历史哈希、事务与 advisory lock，拒绝改写已执行迁移。运行角色无 DDL/提权。
- [x] 认证：懒加载无凭据也能构建；关闭会话cookie缓存、持久化限流、安全cookie/Origin验证。临时兑换、改密、禁用、重置并发安全；登录与重置竞态不能留下可用旧会话。
- [x] 管理：初始化只一次；操作原子化、管理员身份在事务内复查、保护最后管理员；创建重复不重置；审计不记录密码/cookie/token。
- [x] UI：表单、加载、错误、空态、键盘可用；临时密码只在创建/重置响应显示；全页退出/身份切换清空旧画面。
- [x] 接线：首页/API保护；旧匿名素材入口拒绝；草稿按身份命名空间，旧匿名草稿不导入。健康检查不接数据库/模型/COS。
- [ ] 验证：本地隔离PostgreSQL生命周期、负面权限及并发测试；typecheck/test/release检查/build；独立审阅修复，commit、依赖 PR及CI回读。ego lite验收如仍受工具门禁阻碍，准确记录未执行，不假称完成。

## I/O matrix

| Given | When | Then |
| --- | --- | --- |
| 错误端点/库/schema/身份/迁移来源 | 初始化或迁移 | 拒绝，未发送变更 |
| 正常空库与受限角色 | 两次迁移/初始化管理员 | 迁移幂等，管理员不被覆盖 |
| 有效/过期/已用临时密码 | 登录 | 有效仅一次改密会话，其余失败 |
| 临时会话或普通用户 | 保护API/管理操作 | 403，无业务变更 |
| 有效管理员 | 创建/禁用/重置/恢复 | 正确结果，旧会话不可恢复 |
| 最后一位可用管理员 | 禁用/重置 | 拒绝，管理入口保留 |
| 跨站写入/未知认证端点 | 请求 | 拒绝，无副作用 |
| 退出/换号/迟到响应 | 页面更新 | 不显示旧身份内容 |

## Implementation notes

本阶段是连续开发中的安全基础。模型设置和服务端创作属于后续检查点；仍使用旧API的代码会逐阶段替换，未通过最终集成验收前不发布。生产PG18.4；本地独立夹具PG18.6，差异需记录。

## Review Triage Log

2026-10-29 三个独立视角完成审阅，逐项核实如下。原有数据库/账号实现保留；只修复证实的调用边界和补充行为覆盖，不重做已确认产品规划。

| 来源 | 判断/处置 | 核实与行动 |
| --- | --- | --- |
| Blind 1 焦点清空表单 | medium / patch | focus将checking/加载状态切换并重挂载form，改为同身份后台复核，增加真实组件测试。 |
| Blind 2 网络失败卸载Gate | high / patch | error条件确实卸载children并触发请求abort；保留原组件但隐藏/禁止操作，确认身份失效后再卸载。 |
| Blind 3 所有人共用10次登录额度 | medium / patch | ipAddressHeaders为空时使用共享桶；改为服务端规范化用户名的原子持久化额度，不信任客户端IP头，验证其他账号仍可登录。可信代理级保护留到发布接线。 |
| Blind 4 改密无额度 | medium / patch | 业务函数绕过库端点限流，在哈希之前消耗独立账号额度，失败也计数。 |
| Blind 5 完整读取后才限长 | medium / patch | request.text先分配，改为按字节有界流读取及读取超时。 |
| Blind 6 测试夹具身份 | high / patch | URL只验回环不能排除端口转发；删除前核验精确Docker容器/标签/映射及专用测试标记，不接受真实账号数据。 |
| Blind 7 跨schema序列写权限 | medium / patch | relkind缺S，补充USAGE/UPDATE有效权限负面检查。 |
| Blind 8 登录已成功但session查询失败 | medium / patch | 一次性密码已经消费，增加只重查会话的恢复状态，不自动再POST。 |
| Blind 9 生成错误格式不匹配 | medium / patch | 客户端只读字符串error，适配结构化认证错误并触发会话复核，保留草稿。 |
| Blind 10 请求无超时 | medium / patch | 保持连接可永久pending，增加有界等待和结果不明反馈，不自动重发写请求。 |
| Verification 1 实际存储隔离缺测 | medium / patch | helper字符串测试不执行IndexedDB/Hook；补真实适配器及A/B账号恢复覆盖。 |
| Verification 2 Gate缺少执行测试 | high / patch | 客户端请求测试不观察children状态；补受控异步/换号/退出/迟到结果的React组件测试。 |
| Verification 3 模型路由缺权限矩阵 | medium / patch | 函数级角色测试不足；补实际route的管理员、普通、临时、跨站与无会话矩阵，无上游调用。 |
| Edge 1 NFKC等价密码 | high / patch | 成熟库会规范化密码，仅原文比较可继续使用旧临时密码；使用相同规范化规则比较并加回归。 |
| Edge 2 action数组被强转 | medium / patch | String(action)准入后严格相等分支会走错误操作；强制字符串枚举且验证无写入。 |
| Edge 3 JSON流超限 | medium / patch | 与Blind5同根因，保留独立记录并由同一修复覆盖。 |
| Edge 4 焦点清空密码 | medium / patch | 与Blind1同根因，实际组件焦点测试覆盖。 |
| Edge 5 新生成返回已退役链接 | high / patch | 私有输出路由尚未就绪会先收费再返回410；在账号私有持久化完成前，生成入口明确503并在任何读取/模型调用前停止。后续阶段以私有完整链路替换保护。 |


## Verification

2026-10-29，固定 Node22.22.1 / pnpm10.28.2：常规 `pnpm test` 126/126（含真实 ReactDOM 组件及 fake-indexeddb Hook 恢复），账号真实 PostgreSQL 集成18/18，数据库边界集成2/2，`pnpm typecheck` 与 `pnpm build` 通过。隔离夹具为 PostgreSQL18.6，生产记录为18.4。

构建后的 Next standalone 通过20项 HTTP 断言，覆盖管理员/普通/临时账号、Secure/HttpOnly cookie、受限路由、旧链接410和撤销；已固化为 `IMAGE_ACCOUNT_HTTP_INTEGRATION=1 pnpm test:account-http` 并加入CI。它不是浏览器交互或真实模型验收。

发布工具测试96项中的88项通过、8项因本机Python未装固定COS SDK首次跳过；随后使用 `uv run --no-project --python 3.12 --with-requirements scripts/release/requirements.txt python -m unittest discover -s scripts/release/tests -p test_cos_sdk.py -v` 运行8/8通过。`release:check`、`actionlint`、diff检查通过。

三层审阅共18条实际发现已逐条修正/补测，处置见上表。原始匿名生成解析留在 `lib/legacy-generation.ts` 作为下一阶段的回归参考，无公开路由调用；公开生成入口在账号私有保存完成前先返回503，避免收费后返回不可读图片。本阶段不可单独发布，现有线上应用未切换。

ego lite空间清单仍为空，原生Computer Use返回未授权；没有另建空间或绕过权限。浏览器视觉/真实键鼠验收未执行。远端CI在PR建立后回读；不得把本地通过写成生产上线或全部20故事完成。
