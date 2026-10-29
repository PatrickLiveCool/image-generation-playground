# Epic 1 Context: 管理员开通账号，用户安全登录

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

交付管理员直接开户、用户首次改密与登录、禁用/恢复及辅助重置，建立后续功能共用的身份边界。独立数据库与账号已准备，功能仍待实施；本 Epic 在隔离环境独立验收，不自动授权生产迁移或发布。

## Stories

- Story 1.1: 收敛账号实现与数据库接入契约
- Story 1.2: 让本项目迁移和连接拒绝错误数据库
- Story 1.3: 首位管理员可以初始化并登录后台
- Story 1.4: 管理员创建用户，用户首次登录改密
- Story 1.5: 管理员禁用和重置账号，用户安全退出

## Requirements & Constraints

- 只有管理员、普通用户两种角色。管理员维护账号与配置，不默认获得他人创作读取权；不做公开注册、邮件邀请、自助邮件找回或模拟用户登录。
- 临时密码限时、单次使用，仅创建/重置时显示；未改密用户只能改密或退出，所有受保护 API 执行同一限制。禁用/重置立即撤销旧会话，恢复账号不复活会话；保护最后一位可用管理员，首次初始化不得公开或覆盖已有密码。
- 其他应用的库表、数据、账号、ACL及实例参数绝不可修改。不借用 Green PMS 凭据，也不为消除 PUBLIC CONNECT 改旧库权限；共享实例不等于物理隔离。
- 变更前核对实例/端点清单、目标库、schema、当前身份与迁移来源，不符即停。错误目标与权限测试仅使用隔离夹具，禁止向其他生产库试写。
- 秘密不进入日志、Git 或制品；应用拿不到迁移或云管理凭据。自动化/浏览器验收使用本地隔离库和合成账号，生产操作仍遵守各自授权边界。

## Technical Decisions

- 实现选择为 **Better Auth 1.7.14＋username/admin 插件＋pg 8.23.1**。官方接口与 npm 元数据已核对，实际集成尚待验证。React 19 在声明范围，Node 22.22.1 满足已检查引擎要求；项目 Next.js canary 不在稳定版 peer 范围，必须实测 typecheck/build/route，不擅自升级框架。
- 直接 PG Pool，不增 ORM；认证与业务可共用受限池。固定 `qintopia_image` / `app`，运行使用 `qintopia_image_app`，迁移使用 `qintopia_image_migrator`。不重建或重置既有资源；按故事增表，应用启动不执行 DDL，双端口重叠的连接总量不得超出本库 20 个预算。
- 关闭注册，公开认证路由采用白名单；管理员动作经应用 API 校验角色。禁止 impersonation、任意 set-role/remove-user。库必需的 email 可由服务端生成唯一内部地址，用户仍只用用户名。
- 用客户端不可写的业务字段保存首次改密与临时密码过期状态；统一 guard 每次检查账号。关闭 session cookie cache。`setUserPassword` 不自动撤销会话，重置必须另行 revokeUserSessions，并恢复首次改密状态后才报告完成。
- 密码哈希与会话交给成熟库；保留安全 cookie、请求防伪、登录限流与脱敏错误。限流由应用入口用 PostgreSQL 原子额度实现，按规范化用户名/账号分桶，失败仍计数，不信任客户端转发IP。认证秘密独立于图片访问密钥，不轮换 `ASSET_ACCESS_SECRET`。迁移 SQL 经审核后由专用身份执行，不能把装包当作兼容或撤销验收。
- 官方依据：[1.7.14](https://github.com/better-auth/better-auth/releases/tag/v1.7.14)、[username](https://www.better-auth.com/docs/plugins/username)、[admin](https://www.better-auth.com/docs/plugins/admin)。

## UX & Interaction Patterns

沿用当前视觉与组件，补齐登录、首次改密和后台账号管理。保留键盘、空态、加载及错误恢复；登录失败不暴露账号存在性。退出/换号清除页面旧身份内容，迟到响应不能串账号。尚无独立 UX 规格，新增页面在实现中完成最小交互与 ego lite 验收。

## Cross-Story Dependencies

依次推进 1.1 → 1.2 → 1.3 → 1.4 → 1.5；技术选型或目标库门禁未过，后续不能标为 ready-for-dev。Epic 2–4 复用统一会话/角色/启用检查，本 Epic 不提前创建模型、图片或批注表。
