---
title: 创作整理与工作区操作改进
type: feature
created: '2026-11-08'
status: done
route: dispatch
review_loop_iteration: 0
baseline_commit: 0119b551b2384fdf4bd4ba93334eb78b4d5e3c9f
context: [AGENTS.md, docs/implementation/spec-03-private-workspace.md, docs/operations/release-runbook.md]
---

<frozen-after-approval reason="用户已同意评估中的第一批三项改进；沿用既有授权自主实施和验证，不合并或发布">

## Intent

**Problem:** 创作列表不能删除，工作区与图片宽度固定，清空和切换输入方式容易误删本轮内容。

**Approach:** 增加可撤销删除、桌面可调分隔和必要的清空确认；复用既有私有空间、面板和对话框组件。

## Boundaries & Constraints

**Always:** 所有者校验、revision 冲突、生成幂等、未知结果先核对、草稿隔离、原图基准和私有 COS 契约保持；删除在刷新和其他设备上有效，服务端为准。已有授权覆盖三个工作包，按文件边界并行实现，统一集成验证。

**Never:** 不永久删除 COS/数据库业务记录，不新增回收站页面或批量管理，不改变模型/依赖；不做真实模型调用、云写入、生产迁移、合并或发布。

## I/O & Edge-Case Matrix

| 场景 | 输入/状态 | 结果 | 异常处理 |
| --- | --- | --- | --- |
| 删除与撤销 | 自己的无在途创作、确认名称和影响 | 列表移除并提示本会话可撤销；撤销恢复原版本和本机草稿 | 失败保留；回执不明先刷新核对，不自动重发 |
| 当前/最后一项 | 删除当前创作 | 选相邻项；无其他项则显示空白编辑器 | 新建空白不调用模型 |
| 并发与未完成任务 | 版本冲突，或生成中/结果未知/待补保存 | 保留创作，提示刷新或先处理任务 | 服务端与客户端共同阻止，迟到响应不能复活已删记录 |
| 私有读取 | 已删创作或其他账号 | 图片、文档、元数据、版本、基准和生成请求均拒绝访问 | COS 读取后再次确认归属与未删状态 |
| 调整布局 | 桌面拖拽/键盘、双击恢复、刷新 | 两栏在最小宽度内调整，本机记忆；恢复默认 | 窄屏上下布局；存储失败或损坏用默认比例 |
| 清空/输入方式 | 有文字、文件、批注，或已有参考图 | 确认前不修改；取消完整保留；确认仅清声明范围 | 生成中拒绝确认，切换创作取消旧弹窗 |

</frozen-after-approval>

## Code Map

- `lib/private-workspace-service.ts`、`app/api/creations/`：复用账号短事务、创作行锁和 revision；增加软删除及恢复。`lib/private-generation.ts` 与资源 HTTP 路径保持读后授权屏障。
- `migrations/`、`scripts/database/`、`deploy/release-policy.json`、`scripts/release/`、`lib/project-backup.ts`：追加 0006 和固定摘要，更新精确表结构、备份、制品与回退契约，不改旧 SQL。
- `lib/private-workspace-client.ts`、`lib/creative-workspace.ts`、`components/image-combiner/hooks/use-creative-workspace.ts`：消费服务端删除标记，清理同创作本地及应急草稿，保护迟到响应。
- `components/image-combiner/creation-list.tsx`、`index.tsx` 父层：每项“⋯”收纳重命名和删除；确认与撤销反馈。复用 Dialog/DropdownMenu。
- `components/image-combiner/editor-layout.tsx`、`index.tsx` 的 CreationEditor、`input-section.tsx`：复用 resizable 和 AlertDialog；保留唯一生成操作区及批注坐标变换。

## Tasks & Acceptance

**Execution:**
- [x] 服务端工作包：软删除/恢复协议、锁/权限/任务检查、资源读屏障和数据库行为测试。
- [x] 发布工作包：迁移目录、精确结构、备份恢复及发布兼容策略和测试。
- [x] 客户端工作包：删除确认、撤销与未知回执核对，跨设备和本地草稿收敛及组件测试。
- [x] 编辑区工作包：拖拽/键盘/记忆、窄屏、清空确认及行为测试。
- [x] README、需求/架构增量引用和操作手册同步；针对测试、全量检查、隔离浏览器和独立审阅。

**Acceptance Criteria:**
- Given 两个账号和两个设备状态，when 所有者删除并刷新，then 列表不复活、其他账号无权限，未删除创作及原图片对象不变。
- Given 删除成功或回执丢失，when 本会话撤销或刷新核对，then 恢复正确版本与本机草稿，且不触发模型。
- Given 不同窗口宽度与已有批注，when 调整面板，then 基准/批注不漂移、输入不丢失、只有一个生成按钮。
- Given 本轮输入，when 取消清空或切换方式确认，then 全部内容保持；确认清空时历史版本和模型参数保持。

## Design Notes

`creations.deletedAt` 是可空时间戳；删除和恢复均在创作锁内提升 revision。GET `/api/creations` 仅返回活动 `creations`，另带 `deletedCreations: {id,revision,deletedAt}[]`。DELETE `/api/creations/:id` 接受 `{revision}` 返回 `{deletion}`；POST `/api/creations/:id/restore` 接受 `{revision}` 返回 `{creation}`。已删单项 GET 及内容读取保持 404。未知结果以列表中的活动项/删除标记核对。纯本地草稿先确保服务端身份，再删除，避免旧缓存复活。撤销提示保留至本会话关闭或用户收起；明确告知图片暂不永久清理，不承诺刷新后仍有撤销入口。

0006 是新增访问契约；旧版不识别 deletedAt，不能作为兼容回退目标。浏览器 workspace schema 保持 2，删除标记从服务端读取；备份保留删除状态，恢复不能重新开放已删内容。

桌面默认约35/65，两栏建议最小360/320像素，空间不足使用上下布局。比例仅本机存储；双击恢复默认，键盘可调。清空确认覆盖文字、文档、参考图和未提交批注；切换文件/链接只清参考图。已保存版本和基准不变。

## Implementation Notes

- 复用现有短事务、账号锁、revision、AlertDialog、DropdownMenu 和 react-resizable-panels；未新增依赖。按奥卡姆剃刀保留闭环所需状态，不扩展回收站、批量管理或永久清理。
- 后端删除/恢复可安全识别同一 revision 的重复请求，删除阻止新任务、读取及旧请求复活；COS/解码后再核对创作访问状态。内部任务更新统一创作→任务的锁顺序。
- 客户端以服务端删除标记清除本机与应急草稿；本会话保留撤销快照，未知操作仅通过读取核对。补充迟到列表、重命名及任务返回的回归测试。
- 新增0006迁移并同步备份、精确数据库契约和回退检查。旧0005归档按原字段与摘要验证后才补新列；旧应用不能成为0006的回退目标。
- 本轮未修改工作流 YAML，无需新增 actionlint 检查；PR继续使用既有 Linux CI 和发布流程。

## Spec Change Log

- 2026-11-09 审阅澄清：区分服务端确有的 `unknown` 任务与仅本机存在、未被受理的未知请求。前者仍由删除事务原子拒绝；后者允许提交删除，由同一事务确认没有未完成任务并写删除标记，迟到生成也无法复活。保留“不重发模型、结果不明先核对”的约束，避免本机孤立状态永久阻止整理创作。针对性修正现有实现，未回退或重建无关工作。

## Review Triage Log

| 来源 | 结论 | 证据与处理 |
| --- | --- | --- |
| Blind 1：被动夹紧覆写比例 | medium / patch | 真实组件复现40%→容器800px夹紧45.7%→放宽仍45.7%。仅主动拖拽/键盘保存偏好，补缩窄再放宽回归。 |
| Blind 2：粘贴/拖放绕过方式确认 | medium / patch | `uploadPasted/drop → upload → onUpload` 会直接将链接模式切为文件并清链接。复用输入确认后才读取文件，取消保持原链接。 |
| Blind 3：本地孤立unknown阻止删除 | medium / patch | 列表刷新保留未受理请求，客户端原先永久阻止。删除交服务端事务检查真实任务，服务端unknown仍拒绝；新增本机孤立任务删除且迟到响应不能复活测试。 |
| Blind 4：弹窗关闭丢失焦点 | medium / patch | 无Trigger的受控弹窗关闭回BODY，清空前focus被关闭流程覆盖。显式恢复触发按钮/清空后输入框；删除后回当前创作控件。 |
| Blind 5：未知撤销核对留空白 | medium / patch | 仅插回快照未执行正常恢复的占位清理与激活。两个路径复用同一恢复函数，断言恢复后仅一项且已选回。 |
| Blind 6：分隔条缺方向声明 | low / patch | 组件库未提供aria-orientation，实际左右布局使用竖分隔。直接补vertical并验证。 |
| Blind 7：弹窗中背景快捷键生效 | medium / patch | document捕获监听未避开确认层，F能打开背景全屏。对已打开Dialog/AlertDialog暂停背景快捷键，补F/C/D用例。 |
| Blind 8：无关编辑使刷新作废 | low / 保留现有保护 | 原有全局mutationEpoch旨在阻止旧列表覆盖刷新期间的新输入，明确提示重新刷新；未发生内容丢失或错误确认。为此新增逐创作刷新状态机的成本大于此可重试影响，本轮不扩展同步机制。 |
| Blind 9：删除标记全量增长 | low / 不扩展 | 返回完整标记承担阻止旧缓存复活的责任，与现有全量工作区读取一致。没有实测规模瓶颈，不为推测负载新增游标协议或分页状态；也不截断标记。 |
| Blind 10：真实拖动/坐标证据不足 | low / 已补验证 | happy-dom无法证明真实CSS几何；ego浏览器实拖535.5→683.91px、批注显示误差小于0.004px，375px无溢出且节点未重建。此反馈由真实浏览器证据补齐。 |
| Edge 1：自动最小宽度保存 | medium / patch | 独立复现与Blind 1同根因，合并修正主动保存逻辑；本行保留独立结论。 |
| Verification 1：缺完整页面撤销测试 | medium / patch | 原测试仅直接调用hook和HTTP，不能证明按钮接线。新增 `creation-lifecycle-page.test.tsx` 点击真实页面菜单、确认、撤销，验证同一创作/成功版本/文字及文件草稿恢复。 |
| 浏览器：菜单转确认框后锁页 | high / patch | 取消删除后body.pointerEvents持续none、零删除请求。菜单使用non-modal，由确认框承担模态；无手动重置body。浏览器复测取消删除/重命名恢复交互，组件断言覆盖。 |
| 定向复核：恢复时丢失正在转换的上传 | medium / patch | 空占位虽无已写入草稿，但HEIC等转换仍在进行。恢复清理现在同时查询现有uploadTokens，保留正在处理输入的创作；正常和未知撤销路径测试均能收下后续文件。独立复核确认无保护空窗。 |

## Verification

- 固定 Node 22.22.1：针对组件/数据/备份测试，`pnpm release:check`、`pnpm typecheck`、`pnpm test`、`pnpm test:pr`、`pnpm test:release`、`pnpm build`；工作流有改动才运行 actionlint。
- 本机专用 PostgreSQL、内存 COS、合成图片与模拟模型；浏览器验证拖拽、窄屏与确认/撤销，不使用真实业务数据。
- GitHub CI、Linux 制品、生产和人工验收分别记录；本轮不执行生产动作。

审阅前基线：Node 22.22.1下 `pnpm test` 349/349、`pnpm test:pr` 8/8、`pnpm release:check`、`pnpm typecheck`、`pnpm build` 已通过。发布工具测试160项中152通过、8项因本机未安装固定COS SDK而跳过；Linux CI仍需验证。PG创作数据15/15、迁移2/2、真实PG备份恢复1/1通过；构建后HTTP整链1/1，模拟模型3次、内存COS21次、真实模型/云写均为0。临时实际打包→校验→解包后的维护CLI初始化及FD备份/恢复通过，明确为Darwin/arm64本机证据。审阅修正后的最终检查在下方记录。

- 审阅修正后：`pnpm test` **355/355**、`pnpm typecheck`、`pnpm build`、`git diff --check`通过；新增完整页面撤销、孤立unknown、撤销期间上传保护、焦点、粘贴/拖放与被动夹紧回归。服务端/发布代码未在最终界面修正中变化，沿用上述PG、HTTP及发布验证。
- ego真实浏览器：被动夹紧后仍记忆40%，主动拖拽与刷新恢复、键盘及默认重置、375px窄屏、唯一输入与生成按钮、原图批注几何、清空/切换/粘贴/拖放确认、背景快捷键隔离、菜单取消不锁页、删除与撤销、焦点返回均通过。使用本机mock API与内存合成图片，浏览器会话和夹具已关闭。
- 三层独立审阅全部归类并完成必要修正；不扩展逐创作增量刷新或删除标记分页，没有未处理的阻塞问题。
- GitHub CI及Linux制品验证由本PR的同一head SHA检查提供；本地验证不替代它们。`done`表示本轮实现、修正及本地验证完成，不表示已合并、生产迁移/发布或人工体验验收。
