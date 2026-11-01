---
title: 四个 Epic 集成交接与验收证据
status: done
updated: 2026-10-30
storyCount: 20
stage5_baseline: 1c39609b3a4b8820fb70c8b67eb24af0b5c67ff8
stage5_implementation_commit: 17e710b2a0e8dc8747aa8fe6fb6298a42e04fedf
pull_request: https://github.com/PatrickLiveCool/image-generation-playground/pull/25
context:
  - docs/planning/epics.md
  - docs/architecture/account-persistence/ARCHITECTURE-SPINE.md
  - docs/implementation/spec-01-accounts.md
  - docs/implementation/spec-02-model-settings.md
  - docs/implementation/spec-03-private-workspace.md
  - docs/implementation/spec-04-account-release-recovery.md
  - docs/implementation/spec-05-image-annotations.md
---

# 四个 Epic 集成交接与验收证据

本文件将已确认的 4 个 Epic、20 条故事映射到当前实现与验证证据。六个检查点中的实现、独立审阅和本地集成验收已经完成，包含阶段 5 的 327 项应用测试、两套构建 HTTP、ego lite 浏览器和实际打包维护 CLI。交付为依赖阶段 4 的 [Draft PR #25](https://github.com/PatrickLiveCool/image-generation-playground/pull/25)，其精确 head 的 Linux 状态以 [PR 检查](https://github.com/PatrickLiveCool/image-generation-playground/pull/25/checks) 为准。本文不代表正式发布、生产验证或真实模型效果验收。

依据为当前源码、测试、阶段规格与分层运行记录。规划文件中的 `backlog`、架构骨架中的“待实现”，以及早期规格中的历史状态，保留了规划或分工时点；当前实施状态以阶段证据与本文件的分层状态为准，不据此改写原验收条件。

## 交付与权限状态

| 交付层 | 当前状态及证据边界 |
| --- | --- |
| 阶段 0：执行与 PR 基础 | `ac55477`；Draft PR #20。 |
| 阶段 1：账号 | `2232e8f`；Draft PR #21，依赖 #20；实现及本地验证记录见 [spec-01](spec-01-accounts.md)。 |
| 阶段 2：模型后台 | `c4dcdcc`；Draft PR #22，依赖 #21；实现及本地验证记录见 [spec-02](spec-02-model-settings.md)。 |
| 阶段 3：私有创作 | `b6b32a5`；Draft PR #23，依赖 #22；实现及本地验证记录见 [spec-03](spec-03-private-workspace.md)。 |
| 阶段 4：发布与恢复 | `1c39609b3a4b8820fb70c8b67eb24af0b5c67ff8`；Draft PR #24，依赖 #23。主实施者已回读该精确 head 的两项 CI 均通过；本地制品恢复链见 [spec-04](spec-04-account-release-recovery.md)。该状态不覆盖阶段 5 工作区。 |
| 阶段 5：图片批注 | 功能提交 `17e710b`，分支 `codex/image-annotations`，[Draft PR #25](https://github.com/PatrickLiveCool/image-generation-playground/pull/25) 依赖 #24。三层审阅的 15 项发现及 2 项复核修复见 [spec-05](spec-05-image-annotations.md)。应用全量 327/327、构建、两套构建 HTTP、浏览器和 Darwin 打包维护 CLI 均通过；本 PR 的精确 head/CI 由检查页记录。 |
| 阶段 6：集成交接 | 本文件逐项覆盖 20 条故事、分层验证、真实模型人工场景与生产回退边界；独立范围检查未发现遗漏故事或无关文件混入。 |
| 合并与正式发布 | 依赖链为 #20 → #21 → #22 → #23 → #24 → #25；均按 Draft 交付，无合并、Publish 或生产切换结果。 |
| 生产与真实模型 | 未执行本轮生产工具升级、数据库迁移、应用切换或收费模型验收；生产已有版本与公开服务状态不由本地代码推断。 |

本轮已授权连续实现、自行阶段验收、有意义 commit 与 stacked Draft PR。验证只使用本项目专用本机 PostgreSQL、合成账号/文档/图片、模拟模型和内存 COS；没有其他项目数据库写入、真实云对象写入或收费调用授权。旧 COS 对象、匿名浏览器记录和 `ASSET_ACCESS_SECRET` 保留。正式合并、生产维护、Publish、收费模型和删除旧数据分别需要相应授权。

## 20 条故事逐项映射

下列“已实现”指对应代码存在且接入主流程；测试文件表示可复核的行为覆盖，实际通过范围以本文件后面的阶段证据为准。测试源存在本身不构成运行证据；浏览器、构建 HTTP、制品与 Linux CI 分别记录。普通角色和管理员均受作品归属约束。

### Epic 1：账号与用户管理（5 条）

| 故事 | 已实现入口与关键约束 | 验证依据与剩余边界 |
| --- | --- | --- |
| 1.1 收敛账号与数据库契约 | `lib/auth/config.ts`、`lib/auth/server.ts`、`lib/auth/accounts.ts`；Better Auth 1.7.14 与 pg 8.23.1 固定接线，成熟密码哈希/会话；`lib/database-target.ts`、`scripts/database/migrate.ts` 与固定迁移账本。临时密码 24 小时、一次兑换、强制改密、无公开注册。 | `tests/auth-integration.test.ts` 验证初始化、临时兑换、改密、撤销与并发；`tests/database-integration.test.ts` 验证实际迁移和最小权限。阶段 1 auth 18/18、database 2/2；本机 PG18.6 与生产准备记录 PG18.4 的版本差异仍明确保留。 |
| 1.2 拒绝错误数据库 | `lib/database-target.ts`、`lib/database.ts`、`deploy/database-targets.json`、`scripts/database/migration-catalog.ts`；连接前校验目标，写入前只读核对库/schema/身份/有效权限；固定 SQL/hash、迁移锁、运行池每进程 4、维护池 1。 | `tests/database-boundary.test.ts`、`tests/database-integration.test.ts`、`tests/database-maintenance.test.ts`、`tests/database-schema-contract.test.ts`；错误目标无写入、重复迁移、漂移、DDL/跨 schema 序列权限拒绝。双应用加维护最多 9，低于 20 连接预算。生产目标未执行本轮迁移。 |
| 1.3 首位管理员初始化及登录 | `lib/auth/bootstrap-administrator.ts`、`scripts/database/bootstrap-admin.ts`、`scripts/database/administrator.ts`、`scripts/database/cli.ts`；`app/login/page.tsx`、`app/admin/users/page.tsx`、认证/API guards。初始化有事务锁且拒绝覆盖；standalone FD3 初始化和未知回执只读核对已接入受限服务器入口。 | `tests/auth-integration.test.ts`、`tests/account-http-integration.test.mjs`、`tests/database-administrator.test.ts`、`tests/database-maintenance-bundle.test.ts`、`tests/account-ui.test.tsx`；安全 cookie/Origin、统一登录错误、禁注册、初始化幂等、空态/焦点路径。阶段 4 实际打包 CLI 初始化通过；真实服务器 wrapper 链待授权验收。 |
| 1.4 管理员开户与首次改密 | `app/api/admin/users/route.ts`、`app/api/account/password/route.ts`、`lib/auth/account-writes.ts`、`components/account/admin-users.tsx`、`components/account/change-password-form.tsx`；临时密码只在创建/重置响应出现，受限会话不能创作；重复用户名不重置密码。 | `tests/auth-integration.test.ts` 覆盖一次兑换并发、临时权限、NFKC 等价密码拒绝、事务失败回滚、非管理员拒绝；`tests/account-ui.test.tsx` 覆盖焦点/断网后保留输入和只重查 session。阶段 2 ego lite 记录包含普通用户首次改密；不是公开注册或邮件交付系统。 |
| 1.5 禁用、恢复、重置和退出 | `app/api/admin/users/[id]/route.ts`、`lib/auth/accounts.ts`、`lib/auth/guards.ts`、`components/account/account-gate.tsx`、`components/account/account-shell.tsx`；事务内重查角色/会话、最后管理员保护、旧会话永久撤销，页面换号卸载旧内容。 | `tests/auth-integration.test.ts` 验证多会话、重置/登录竞态和最后管理员；`tests/account-ui.test.tsx`、`tests/private-workspace-ui.test.tsx` 验证旧响应/换号/退出隔离。阶段 3/5 实际 HTTP 验证 COS/元数据读取期间禁用后不交付字节；阶段 5 同账号暂时复核时保留已提交 POST 的修复已通过组件回归、独立复核与最终全量。 |

### Epic 2：沿用现有 API 设置与模型映射（4 条）

| 故事 | 已实现入口与关键约束 | 验证依据与剩余边界 |
| --- | --- | --- |
| 2.1 安全保存单套设置 | `app/admin/models/page.tsx`、`components/account/admin-models.tsx`、`app/api/admin/provider/route.ts`、`lib/provider-configuration.ts`、`lib/provider-secret.ts`、`migrations/0002-provider-settings.sql`；AES-256-GCM、独立密钥、revision 冲突、GET 不回显秘密、换地址必须新 Token。 | `tests/provider-configuration.test.ts`、`tests/provider-configuration-integration.test.ts`、`tests/provider-settings-ui.test.tsx`；缺密钥/损坏/恢复、并发保存、临时/普通/跨站拒绝、取消/失败保留、库中无明文。阶段 2 PG 10/10；扩展批注能力后的阶段 5 PG 13/13。生产主密钥配置与恢复仍待生产门禁。 |
| 2.2 同步、手填、增删改排序 | `components/image-combiner/api-settings-modal.tsx`、`components/image-combiner/model-mapping-editor.tsx`、`app/api/provider/models/route.ts`、`lib/provider-configuration-client.ts`；草稿同步不保存、不生图；保留映射稳定 ID、名称与顺序；迟到同步不能覆盖新草稿。 | `tests/provider-settings-ui.test.tsx`、`tests/model-mappings.test.ts`、`tests/provider-configuration-integration.test.ts`；失败/空列表/手填、100 条上限、换连接/关闭时失效、保存冲突和映射删除。阶段 2 浏览器记录已覆盖后台保存、重开 Token 空白、换地址拒绝和取消；同步成功不证明真实模型可用。 |
| 2.3 服务端基本调用保护 | `lib/generation-admission.ts`、`migrations/0003-provider-admission.sql`、`lib/provider-network.ts`、`lib/private-generation-input.ts`；默认全局 2/用户 1 并发、每用户每分钟 6 次；原子幂等、unknown 不立即释放/重发；拒绝浏览器供应商覆盖及内网/重定向。 | `tests/generation-admission.test.ts`、`tests/generation-admission-integration.test.ts`、`tests/provider-network.test.ts`、`tests/private-generation-input.test.ts`；阶段 2 实际 PG 13/13，含 16 并发、上下限、锁等待后撤销、事务回滚和 unknown。限流不是计费预算；没有新增额度页面。 |
| 2.4 普通用户仅选显示名称 | `app/api/models/route.ts`、`components/image-combiner/hooks/use-model-catalog.ts`、`components/image-combiner/model-selector.tsx`、`lib/creation-request.ts`；公共目录只投影名称/比例/必要能力状态，提交 mappingId/configRevision；不读取、上传或删除旧本地 Token。 | `tests/public-model-catalog-ui.test.tsx`、`tests/account-storage.test.ts`、`tests/creation-request.test.ts`、provider PG 公共投影断言；目录失败和映射删除保留草稿且要求明确重选。阶段 2 ego lite 已验证普通目录与管理 API 403。 |

### Epic 3：私有创作、发布与恢复（7 条）

| 故事 | 已实现入口与关键约束 | 验证依据与剩余边界 |
| --- | --- | --- |
| 3.1 私有创作清单 | `app/api/creations/route.ts`、`app/api/creations/[id]/route.ts`、`lib/private-workspace-service.ts`、`components/image-combiner/hooks/use-creative-workspace.ts`、`migrations/0004-private-workspace.sql`；新账号空服务端列表、幂等新建、1–60 字名称、revision 改名、所有者复合约束。 | `tests/private-workspace-data-integration.test.ts`、`tests/private-workspace-ui.test.tsx`；创建/改名冲突、管理员越权、生成后立即改名、旧清单迟到不删除新创作。阶段 3 PG 12/12、ego lite 新建/切换/改名通过。 |
| 3.2 同设备草稿隔离恢复 | `lib/creative-workspace.ts`、`lib/creation-types.ts`、`components/image-combiner/hooks/use-creative-workspace.ts`、`components/account-workspace.tsx`；账号/创作命名空间、服务端历史为准、本地草稿和应急副本保留，不导入旧匿名记录。 | `tests/account-storage.test.ts` 使用真实 IndexedDB 适配器与 hook；`tests/private-workspace-ui.test.tsx` 验证迟到、损坏/保存失败、新输入不被旧完成清理；阶段 3 ego lite 刷新/双创作/换号通过。阶段 5 `tests/annotation-draft.test.ts` 补 schema1→2 原件保留；未提交草稿不承诺跨设备同步。 |
| 3.3 图片与文档归属检查 | `app/api/images/[id]/route.ts`、`app/api/documents/[id]/route.ts`、`app/api/assets/[...key]/route.ts`、`lib/private-cos.ts`、`lib/private-generation-input.ts`、图片操作 hooks；旧能力入口 410，新对象位于 `image-playground/private/v1/`，应用授权读取、no-store、无 COS 重定向。 | `tests/private-cos.test.ts`、`tests/private-generation-input.test.ts`、`tests/private-workspace-ui-media.test.tsx`、`tests/private-workspace-http-integration.test.mjs`；跨账号/类型/自有 URL 绕回拒绝、复制下载 response.ok 与会话复核、对象 URL 清理、读取中禁用无字节。无新本地图片/优化缓存路径；旧对象和密钥未清理。 |
| 3.4 生成与续改持久化 | `app/api/generate-image/route.ts`、`lib/private-generation.ts`、`lib/private-workspace-service.ts`、`lib/private-generation-input.ts`、`components/image-combiner/hooks/use-creation-generation.ts`；受理快照、同键同内容只一次调用、原始父图第一输入、COS 完整后事务确认版本。 | `tests/private-generation.test.ts`、`tests/private-workspace-data-integration.test.ts`、`tests/private-workspace-http-integration.test.mjs`；原图 hash、无效基准零调用、并发唯一版本、文档只拼一次、跨会话恢复。阶段 3 ego lite V1→V2、旧 V1→V3 均使用 V1 原图；均为模拟模型。 |
| 3.5 失败与部分保存恢复 | `lib/private-generation.ts` 的修复编排、`app/api/runs/[id]/route.ts`、`app/api/runs/[id]/repair/route.ts`、`lib/pending-generation.ts`、生成 hook；save_pending/unknown/failed 分开，固定输出和清单核对，只补元数据，无自动收费重试。 | private-generation、workspace PG/UI/HTTP 测试覆盖清单失败、双修复、篡改、断线、停止等待、有限 GET 轮询和旧响应。阶段 3 ego lite V4 补记后模拟调用数仍为 4；阶段 5 PG 验证换绑/停用后旧批注任务沿用冻结证据修复。 |
| 3.6 迁移与私有访问发布边界 | `deploy/release-policy.json`、`scripts/release/{common,package,server,orchestrate,smoke}.py`、`scripts/database/{cli,maintenance,schema-contract,migration-catalog}.ts`、`deploy/{entry,upgrade}.py`；制品绑定迁移摘要、隔离维护身份、未知回执只读核账本、持久账号访问底线和真实维护响应。 | `scripts/release/tests/`、`tests/database-maintenance*.test.ts`、`tests/database-schema-contract.test.ts`、`tests/release-identity.test.ts`；错误目标/漂移/中断/不兼容回退/安装升级/固定入口覆盖。阶段 4 本地打包解包通过，#24 两项 CI 已通过；阶段 5 的 0005/schema2 制品仍需本阶段 CI。真实 root wrapper/专用 UID/生产切换未执行。 |
| 3.7 账号版全流程及单项目恢复 | `lib/project-backup.ts`、`scripts/database/recovery-io.ts`、固定维护 CLI、[release-runbook](../operations/release-runbook.md)；固定表/列、项目身份、认证加密与秘密恢复、空目标事务恢复，不执行备份 SQL、不清目标、不恢复会话。 | `tests/project-backup.test.ts`、`tests/project-backup-integration.test.ts`、`tests/database-recovery-io.test.ts`，加阶段 1–3 HTTP/UI 场景。阶段 4 实际打包 CLI/FD、205 创作跨批恢复、提交回执丢失、恢复临时密码失效通过；阶段 5 含批注 PG 恢复 1/1。真实 COS 引用读取、生产秘密恢复、正式人工验收尚待相应环境与授权。 |

### Epic 4：图片批注式对话编辑（4 条）

| 故事 | 已实现入口与关键约束 | 验证依据与剩余边界 |
| --- | --- | --- |
| 4.1 批注数据与模型输入契约 | `lib/image-annotations.ts`、`lib/annotation-capability.ts`、`lib/annotation-execution.ts`、`lib/annotation-renderer.ts`、`app/api/admin/provider/annotation-capabilities/route.ts`、`components/account/annotation-capability-panel.tsx`；encoded-pixels-v1、8 个 EXIF 方向、overlay-v1，能力绑定连接/接口/模型/Token/revision 和完整证据。 | `tests/image-annotations.test.ts`、`tests/annotation-capability.test.ts`、`tests/annotation-execution.test.ts`、provider PG 13/13；验证几何边界、原字节不变、三种图形像素、换绑失效/名称排序继承、独立停用、公共投影。接口资料来源见 [共享契约](spec-05-annotation-contract.md)；实际用户网关能力及编辑效果仍未验证。 |
| 4.2 画框、圈选、涂抹和逐条说明 | `components/image-combiner/annotation-editor.tsx`、`output-section.tsx`、`input-section.tsx`、`hooks/use-annotation-metadata.ts`、`app/api/images/[id]/metadata/route.ts`；原图与 SVG 分离，浮框/主输入共享草稿、稳定编号、删除/撤销、键盘加框移动调尺寸、窄屏定位、加载失败明确重试。 | `tests/annotation-ui.test.tsx`、`tests/annotation-draft.test.ts`、`tests/image-annotations.test.ts`；组件覆盖三工具/非方图/8 方向、even-odd 区域、输入焦点及窄屏浮框。ego lite 空间 20 原生指针三工具、双向输入、删除/撤销、键盘操作及 390px 窄屏均通过，截图已实际查看。 |
| 4.3 按基准保存草稿与统一预览 | `lib/annotation-draft.ts`、`lib/creative-workspace.ts`、`lib/creation-request.ts`、创作 hooks、`input-section.tsx`；账号/创作/baseVersionId 隔离、schema2、统一发送冻结深拷贝，局部浮框无单独发送；成功只清对应未再编辑的草稿。 | `tests/annotation-draft.test.ts`、`tests/annotation-ui.test.tsx`、`tests/private-workspace-ui.test.tsx`；原件保留、坏记录拒绝覆盖、无整体文字仅批注提交、元数据重试与迟到隔离。浏览器刷新/换基准/删除撤销/仅批注统一发送/换号隔离及草稿恢复均通过。 |
| 4.4 批注提交、新版本与逐轮追溯 | `lib/private-generation-input.ts`、`lib/private-generation.ts`、`lib/private-workspace-service.ts`、`migrations/0005-image-annotations.sql`、`components/image-combiner/creation-history.tsx`、`lib/project-backup.ts`；快照/能力/双输入执行记录冻结，原图与辅助图均私有，指纹含批注，父版本与历史保持。 | `tests/annotation-data-integration.test.ts` 6/6、`tests/project-backup-integration.test.ts` 1/1；构建 HTTP 验证 PDF/DOCX、三种几何、跨会话历史、修复不增调用及读取中禁用，4 次模拟调用。浏览器另完成 V1→V3、三条冻结批注、原图第一输入和补保存，修复前后模拟调用数均为 3；真实模型/云写入均 0。Linux CI 与真实模型效果另列。 |

## 当前验证台账

阶段 1–4 的详细命令、审阅处置、浏览器操作限制在各阶段主规格中保留；不把早期通过数字相加成当前工作树总数。

| 验证 | 已取得结果 | 当前覆盖边界 |
| --- | --- | --- |
| 阶段 1 本地 | 应用 126/126、auth 18/18、database 2/2、构建 HTTP 20 断言；typecheck/build/release:check/actionlint 通过；release 88 + 固定 SDK 补跑 8 通过。 | 账号检查点；当时浏览器受门禁阻碍。后续阶段的浏览器/HTTP证据补充相关账号流程，不伪称当时已有视觉验收。 |
| 阶段 2 本地 | 最终应用 164/164、provider PG 10/10、构建 HTTP 24 断言、typecheck/build；同阶段 database/auth/admission/release/actionlint 已通过。 | 现有 API 设置后台化；ego lite 空间 14 验收及指针/填充限制见 spec-02。 |
| 阶段 3 本地 | 应用 234/234、workspace PG 12/12、构建 HTTP、typecheck/build/release:check/actionlint。 | 私有版本、权限、原图与保存恢复；ego lite 空间 15 合成场景通过，未验真实设备与模型。 |
| 阶段 4 本地及 PR | 应用 258/258；release 152 项中 144 pass/8 skip；实际 PG/打包 CLI 恢复；typecheck/build/release:check/actionlint；#24 精确 head 两项 CI 通过。 | 本地 8 skip 是固定 COS Python SDK 缺失；CI 安装该依赖。CI/制品通过不等于生产工具已安装。 |
| 阶段 5 provider PG | 13/13，`/private/tmp/image-stage5-provider-pg-reviewed.log`。 | 含能力绑定、撤销竞态、独立停用与公开投影。 |
| 阶段 5 annotation PG | 6/6，`/private/tmp/image-stage5-annotation-pg-reviewed.log`。 | 原图/辅助图冻结、幂等、越权/未知能力拒绝、篡改修复、换绑/停用后旧任务修复。 |
| 阶段 5 backup PG | 1/1，`/private/tmp/image-stage5-backup-pg-reviewed.log`。 | 真实专用 PG 往返含批注、完整证据与恢复负面条件；图片仍为内存 COS 合成对象。 |
| 阶段 5 release | 155 项中 147 pass/8 skip，`/private/tmp/image-stage5-release-tests-reviewed.log`。 | 本机缺固定 COS Python SDK 的 8 项仍是 skip，不能记为 pass；最终本阶段 CI 安装依赖后需核对。 |
| 阶段 5 静态门禁 | release:check、typecheck 通过，日志分别为 `/private/tmp/image-stage5-release-check-reviewed.log`、`/private/tmp/image-stage5-typecheck-reviewed.log`；actionlint 已由主实施者完成。 | release:check 只证明版本、兼容元数据与清单一致，不代表发布已发生。 |
| 阶段 5 应用全量/构建 | 最新全量 327/327、build 通过；日志 `/private/tmp/image-stage5-app-tests-reviewed.log`、`/private/tmp/image-stage5-build-reviewed.log`。 | 含三种几何像素、PDF 全程预算、HTML 大小写和同账号复核保留 POST 等修复。edge/gap 复核通过，末两项 followup 10/10 通过；不沿用较早 325 项数字。 |
| 阶段 5 构建 HTTP | 最新 annotation/private 两套通过；日志 `/private/tmp/image-stage5-annotation-http-reviewed.log`、`/private/tmp/image-stage5-private-http-reviewed.log`。 | annotation 为 4 次模拟调用，含正常 PDF 图像转发、预览、批注、补保存和读取中禁用；private 为 3 次模拟调用、19 次内存 COS 写入。真实模型与真实云写入均 0；浏览器仍独立验收。 |
| 阶段 5 打包维护 CLI | Darwin arm64 实际打包、校验、解包并执行通过；`/private/tmp/image-stage5-packaged-maintenance-reviewed.log`。 | 5 个固定迁移和初始化/备份/恢复；未上传、发布制品，Linux 仍由对应 CI 单独证明。 |
| 阶段 5 浏览器 | ego lite 空间 20 验收通过，详细操作与工具限制见 spec-05。 | 开发服务上的原生键盘/指针交互；3 次模拟调用，补保存不增加调用。首次浏览器载入独立会话创建的版本；没有跨物理设备或真实模型效果验收。 |
| 阶段 5 PR/CI | [Draft PR #25 检查页](https://github.com/PatrickLiveCool/image-generation-playground/pull/25/checks) 记录最新 head 的 `PR format` 与 `Node and release checks`，后者包含 Linux 构建 HTTP 和打包维护 CLI。 | 发布工具的 8 项本地 skip 由安装固定 SDK 的 Linux 作业覆盖；必须核对同一 head 的最终结果，不得用 #24 或本地结果替代。 |

以上 `/private/tmp/` 路径为本机临时证据定位，不包含凭据且不加入 Git；交付 PR 应保留其安全汇总。截图、用户快照、签名 URL 和 `.local-ops/` 不作为 Git 附件。

## 审计结论与待关闭事项

20 条故事均找到主流程实现及相应测试，没有发现整条功能被遗漏或用空占位替代。AD-1–12 的服务端规则、账号与创作归属、数据库/COS职责、冻结版本、设备草稿、私有入口、单套秘密配置、发布回退、审计、账号恢复、幂等和公网请求边界，分别由 Epic 1–3 的上述实现承担；AD-13/14 由原图像素草稿、能力证据、冻结双输入及批注任务追溯承担。独立审阅、实际浏览器与本地集成验证已完成；这些证据不能替代 Linux CI、生产或真实模型验证。

本地实现/验收已关闭，交付与外部执行边界如下：

1. 阶段 5 应用全量、build、两套构建 HTTP、实际打包维护 CLI 和 ego lite 均通过。15 项审阅发现与 2 项复核修复已处置，edge/gap 及末两项 followup 复核通过；独立提交范围检查未发现凭据、签名链接、用户快照、本地图片或生成目录混入。
2. 阶段 5 已形成有意义提交与依赖 #24 的 Draft PR #25；合并前核对本 PR 最新精确 head 的 CI、Linux 制品及维护 CLI。已有 #24 或 #25 较早提交的绿色结果不能继承给新提交。
3. 生产服务器受限入口、专用维护 OS 身份、真实秘密与私有 COS、真实数据库迁移/初始管理员和公网访问尚未验收。仅在相应授权后按运行手册执行，不能连接其他项目库证明本项目隔离。
4. 当前只实现 `overlay-v1`：原图和编号辅助图占用 2 张输入；有额外参考图、含图或无法确认的文档时，批注提交明确拒绝，确认纯文字的 PDF/DOCX/TXT 可用。支持的三种画法均转为编号辅助图，没有省略批注或静默退回纯文字生成；不承诺蒙版、像素精确编辑或任意网关兼容。
5. 真实模型的区域理解、非目标区域保真度、多个标记的对应关系尚未进行收费验收。代码与合成请求通过仅证明提交正确、权限和恢复逻辑，不能把效果判为通过。

## 最短真实模型人工验收（尚未执行）

先取得针对所选网关/映射、测试素材和最多调用次数或费用上限的明确授权；沿用独立验收账号与私有存储配置。管理员在已保存配置上依据该连接的接口资料记录双图输入能力，记录行为本身不调用模型。

1. 准备一张有清晰左/右区域的非方形图片，作为唯一参考生成一个已保存 V1；记录这次请求的实际映射/配置版本与结果。该次生成计入预算。所有素材只经应用授权入口进入私有 COS。
2. 在 V1 分别画矩形、圈选和涂抹，给出三个可辨别的局部要求，整体要求写明保留其他区域；从主对话框统一发送一次，得到 V2。核对请求原图未被辅助图替换、每条说明只出现一次、父版本为 V1，再由人判断三处修改是否对应、未要求区域是否保真。
3. 重新登录后回看 V2 的 V1 基准、编号和说明，切回 V1 确认坐标不会自动套用到 V2。若授权预算允许第三次调用，从 V2 添加一处新批注得到 V3，验证新基准原图及逐轮关系。记录“通过/未通过及具体差异”，不以“返回图片”替代效果结论。

发现供应商不接受双图或区域理解不合格时停止后续收费重试，保留任务、原图和证据；可在后台独立停用该映射的批注能力，普通生成设置保留。保存未完成仅核对/补保存，不重新生成。账号撤销、故障注入、篡改和幂等压力继续使用既有模拟测试，无需为这些负面场景付费。

## 生产门禁与安全回退（尚未执行）

操作入口以 [release-runbook](../operations/release-runbook.md) 为准；下面是交接顺序，不是本轮已执行记录。

1. 完成阶段 5 最终本地/浏览器/精确 head CI 与 Linux 制品验证后，审阅完整依赖链；只有合并授权覆盖时才合并。版本 PR 合并只准备 Draft Release，必须在 Publish 授权后由人正式发布，才触发部署。
2. 核对当前服务器/应用/工具摘要、Nginx、证书、账户访问底线及恢复记录；先确认受限工具升级计划和备份，再在工具安装/升级授权下操作。单独验证 SSH forced command、sudo/root wrapper、专用维护用户、非法命令拒绝和原配置保持；不重跑早期一次性脚本。
3. 核对 `deploy/release-policy.json` 与不可变制品：当前候选为 PostgreSQL、`qintopia_image/app`、迁移 `0001–0005` 固定摘要、`account-private-v1`、browser workspace schema 2、asset capability 1。独立 runtime/migration/recovery 配置只注入对应进程；保留 `ASSET_ACCESS_SECRET`，核对加密主密钥和私有 COS 引用恢复方案。错误目标或身份、缺密钥、未知 schema 必须停止。
4. 获得生产迁移/切换授权后，使用受限发布入口执行 preflight → migrate → verify → 候选健康/版本核验 → 双端口切换/排空。迁移或初始化回执不明先用固定只读核对命令确认，不直接重放。首位管理员经 FD3 维护入口只初始化一次，再开户/改密；不用默认密码或公开初始化端点。
5. 发布后分别核对无副作用的公网 health/version、应用 release 身份、账号访问与私有下载/旧入口拒绝，以及已有成功版本/批注历史。健康检查不调用模型、不写 COS；模型效果使用另行批准的人工场景。只有服务器和公网都核验成功，才能将该版本记为已部署。

当前 0005/schema2 候选不能仅因 #24 通过就回退到 #24 的 0004/schema1 制品；必须同时满足数据库账本、私有访问、浏览器草稿及图片能力版本兼容性。没有已验证兼容账号版本时保持真实 503 维护状态，不能恢复匿名旧 demo。恢复只接受本项目认证归档、正确密钥和空的受控目标，不清空生产业务表、不执行共享实例整体恢复、不修改其他项目账号/ACL。旧数据或发布版本清理不在上述门禁的隐含授权内。
