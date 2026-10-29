---
title: 阶段3账号私有创作、成功版本与保存恢复
status: done
baseline_commit: c4dcdcc4207160db2e8d05525eb8ca7ade7a84a1
stories: [3.1, 3.2, 3.3, 3.4, 3.5]
context:
  - docs/product/prd-account-persistence.md
  - docs/architecture/account-persistence/ARCHITECTURE-SPINE.md
  - docs/planning/epics.md
  - docs/implementation/spec-02-model-settings.md
---

## 行为与边界

延续现有创作布局、文件与文档输入、历史版本选择。账号的创作与已提交任务以服务端为准，同设备未提交草稿仍按账号/创作保存在 IndexedDB；不导入旧匿名记录，不将客户端历史版本当作服务器事实。新账号服务端空列表；可在页面保留一个未提交的空白编辑草稿，只有明确新建或提交时创建服务端创作。跨设备恢复创作、成功图片、版本关系和提交参数；不同设备草稿不自动合并。

仅 app schema 增加 creations、generation_runs、private_assets 等项目表。使用 ownerId 与实体 ID 的复合键及外键约束，服务端会话确定 owner；管理员不获得别人的作品权限。UUID 形 creationId/clientRequestId 由客户端提供，客户端版本号、用户、上游模型、Token、对象键均拒绝。服务端在同一短事务复核会话、锁定创作、分配版本号、固定配置快照、登记任务和受理槽；模型/COS 网络期间不持有事务。相同账号+请求键+指纹只返回已有状态；指纹包含 creation、parent、原始提示、映射/配置版本、参数、文件内容和引用标识，不重新收费。

对象仅写 `image-playground/private/v1/<sha256(ownerId)>/<creationId>/<runId>/...`，旧 key 校验不得接受。模型输入包括真实父版本原图；父版本必须同账号/创作且成功。返回 `/api/images/<opaqueAssetId>`，文档 `/api/documents/<opaqueAssetId>`，均重新认证+归属并以内存响应，private/no-store、nosniff，不重定向到 COS/CDN。不签发新 bearer；旧资产入口维持410，ASSET_ACCESS_SECRET不变。拒绝将本应用绝对URL、旧能力URL、私有桶或CDN URL当外部参考读取绕过授权；外部公网URL仍走既有 HTTPS/DNS/连接固定/禁止重定向规则。

收费前任务已登记、输入与任务清单已成功写私有 COS。原始文档只解析一次、提示只拼接一次；总字数及图片数量在调用前拒绝，不丢弃必需输入。输出先写固定 outputs/final 键，再写完成清单，再事务提交成功版本与资产元数据；三者完成才返回成功。未知请求、取消、失联不能宣称未收费；有限轮询 GET 状态，禁止自动重新生成。若输出已写而最终元数据未提交，保留 save_pending/unknown；显式修复只读固定输出和清单、验证长度/hash/归属后幂等补记数据库，不调用模型。即使完成清单写失败也可结合固定输出键重建记录；若无输出，只能报告未知/失败，不能造成功或重新生成。

## 固定协议

公用 DTO 见 lib/private-workspace-types.ts，内部记录见 lib/private-workspace-records.ts。所有 JSON 成功响应 no-store。

- GET /api/creations -> {creations: PrivateCreation[]}；POST同路径 body {id,title?} -> {creation}，创建幂等，重复不覆盖标题。
- GET /api/creations/:id -> {creation}；PATCH body {revision,title} -> {creation}，冲突409保留草稿。
- POST /api/generate-image multipart 使用现有 mappingId/configRevision/prompt/aspectRatio/quality/mode/creationId/clientRequestId/parentVersionId/image1,image2,image1Url,image2Url/document；新增 documentName/documentText 仅在无原文件时传设备文本恢复草稿，服务端把它存为合成 TXT 文档。严格单值白名单、总请求上限32MiB。prompt传原始文字；server compose一次。
- 生成 -> {run: PrivateRun}，complete200，其余已受理202；首次受理但未完成保留 runId，重复请求返回当前状态；无受理错误用已有安全错误协议。
- GET /api/runs/:id -> {run}；POST /api/runs/:id/repair -> {run}。修复仅元数据，不允许客户端提供任何对象键。
- GET /api/images/:assetId 和 /api/documents/:assetId；不存在、跨账号或类型不符统一404；文档强制attachment，图片禁止缓存。

## 服务端模块契约

数据工作包实现 lib/private-workspace-service.ts：listPrivateCreations(headers)、createPrivateCreation(headers,body)、readPrivateCreation(headers,id)、renamePrivateCreation(headers,id,body)、acceptPrivateRun(identity,command)、readPrivateRun(identity,id)、readPrivateAsset(identity,id,kind?)、readPrivateBase(identity,creationId,parentVersionId)、setPrivateRunStatus(ownerId,runId,status,failureCode?)、completePrivateRun(ownerId,runId,assets)。readPrivateRun返回内部PrivateRunRecord，HTTP只取public；readPrivateBase返回PrivateAssetRecord或null；complete返回PrivateRun，验证所有asset归属和固定输出键且事务幂等。accept返回AcceptedPrivateRun；settings只在首次acquired=true返回，Token不持久化。终态complete不得被迟到失败覆盖。

COS工作包实现 lib/private-cos.ts：PrivateCosStore {put(key,bytes,mediaType), get(key,maxBytes):Promise<{bytes,mediaType}>}、createPrivateCosStore(env?,client?)、privateRunPrefix(ownerId,creationId,runId)、assertPrivateKey(key)、MAX_PRIVATE_MANIFEST_BYTES=256KiB。不读取旧签名配置作为授权；client注入便于离线验证。

主代理实现输入解析、执行/修复编排、HTTP routes、迁移catalog审核和主集成。前端工作包消费以上HTTP协议，不导入server模块。

## 实施与验证

- [x] 数据模型/原子受理/所有者约束/成功版本与幂等落库。
- [x] 私有 COS 字节读写及统一授权图片/文档入口。
- [x] 原图、文档、模型与完整存储编排；未知和保存修复不重复调用。
- [x] 前端远端恢复、本地草稿、在途状态查询、旧版续改与账号切换隔离。
- [x] 专用 PostgreSQL 的双账号、并发、变更与故障集成；合成图片、内存 COS、模拟模型；无真实云写入。
- [x] 本次实现工作树 typecheck/test/build、ego lite 合成场景、三路独立审阅和修复；浏览器操作限制见下。

本阶段不改发布策略为可部署；下一阶段3.6/3.7负责发布迁移及恢复演练。图片批注为后续检查点，不以本阶段完成替代整体Goal。禁止操作生产或其他应用数据库。

## Verification

2026-10-30 最终工作树验证：Node 22.22.1 / pnpm 10.28.2；`pnpm typecheck`、`pnpm test` 234/234、`pnpm build`、`pnpm release:check`、`actionlint`、`git diff --check` 通过。专用 PostgreSQL `pnpm test:workspace` 12/12 通过，包含真实数据服务、内存 COS、模拟 PNG 模型、并发版本、保存修复和生成后立即改名。

新增 `pnpm test:private-http` 在实际 standalone 构建运行：会话与数据库真实，COS 和模型在进程 preload 中以严格合成身份替换。验证重复请求只调用一次、旧版原图摘要、文档提示只出现一次、跨会话恢复、跨账号/类型访问拒绝、私有响应头、一次清单失败后的幂等补记，以及 COS 读取期间禁用账号后返回401且不交付图片字节。总计3次模拟模型调用、19次内存对象写入，真实模型和云写入均为0；CI已接线，GitHub/Linux本次检查在PR创建后另行核对。清理仅命中两个固定合成账号及关联记录。

新增完整像素解码：`sharp@0.34.5` 从既有锁定的间接依赖提升为同版本直接依赖，不升级版本。PNG/JPEG/WebP/GIF、原始字节和EXIF方向保留、头部伪图、截断像素、累计像素上限（16,777,216）、调用前身份再核对及上游安全失败代码的18项针对测试通过，均已纳入上述234项。没有重编码编辑基准或本地图片落盘。

ego lite 原空间14已不存在，用户已明确允许替代空间，使用唯一空间15/p1。页面验证首次生成自动命名、生成后改名、V1→V2与旧V1→V3（两次编辑输入摘要均等于V1）、清单失败后仅补记V4（模型调用仍为4）、两项创作草稿隔离、刷新恢复4版本和未提交草稿、退出后管理员工作区不继承普通账号内容。合成UI截图已人工目视检查，保存在临时验收路径，不纳入Git。部分ego指针点击/填充受页面会话可见性重查影响，使用已文档化的键盘和DOM事件回退；不据此宣称全指针交互、独立真实设备或真实模型效果已验收。

所有运行ID等于小写clientRequestId，prefix无尾斜杠。0004 SQL 已逐行审阅并以固定hash迁移仅本地专用合成库，未接触生产或其他应用。

## Review Triage Log

三路独立审阅全部收到后逐项判定；以下均按实际调用与现有测试核对，重复问题保留独立记录。用户已授权持续实现并自行验收，采用局部修正保留已通过实现，不重置整个工作区。

| 来源 | 发现 | 判定与证据 | 处置 |
| --- | --- | --- | --- |
| blind-1 | 生成后revision过期 | medium：accept/complete更新creation，run原协议未带revision，UI未同步 | 增加run.creationRevision并同步，补立即改名测试 |
| blind-2 | 迟到刷新覆盖完成版本 | medium：merge无远端快照时序保护，已完成版本可能被旧列表剔除 | 刷新与已确认本地更新加时序保护 |
| blind-3 | 换基准后旧任务清稿 | medium：相同比例切版本不增draftRevision，完成不校验提交父版本 | 基准选择参与草稿版本/清稿条件 |
| blind-4 | 查询错误降级save_pending | medium：markUnknown覆盖所有非complete状态 | 保留已确认终态/保存待补记，仅显示查询错误 |
| blind-5 | 自动命名失效 | medium：ensureRemote先设置revision使原命名分支不可达 | 首次创建时从提交提示命名 |
| blind-6 | 异步新标签被阻止 | medium：实际fullscreen调用openImageInNewTab，异步后window.open可能被阻止且无反馈 | 点击时建立窗口，失败/失效时关闭并提示 |
| blind-7 | 补记15秒超时 | medium：修复顺序读写且端点120秒，客户端仅15秒 | 修复等待对齐120秒并维持不自动重发 |
| blind-8 | 历史文档无入口 | medium：持久化assetId仅渲染名称，跨设备原文无法通过界面取得 | 增加同源授权下载 |
| blind-9 | 截断图片可标成功 | high：imageBytes仅魔数检查，8字节PNG可通过 | 成功前完整解码、资源上限及失败回归 |
| blind-10 | 失败分类丢失 | medium：统一catch将可修正输入/存储/上游归为粗粒度代码 | 有界安全失败代码，保留未知收费语义、不存原始异常 |
| edge-1 | multipart读取无截止 | medium：超时信号在读完form之后才建，reader.cancel也可卡住 | 有界读取时限与不阻塞取消 |
| edge-2 | 旧刷新降级complete | medium：与blind-2同根因，merge确实覆盖状态 | 合并到刷新时序修正 |
| edge-3 | 旧列表删除新创作草稿 | medium：merge只留一个localOnly，刚确认的远端新创作可被旧列表移除 | 同一时序修正并补新建交错测试 |
| edge-4 | 写清单期间撤销后仍调用 | medium：reauthorize后仍等待COS/DB，存在可收窄窗口 | 必需写入完成后、调用前再次核对身份 |
| edge-5 | 应急备份提前清空 | high：hydrate清空entries，flush写IDB前先删session备份 | IDB确认提交后才清除恢复备份，补失败/退出覆盖 |
| verification-1 | 资产HTTP撤销屏障未测 | medium：既有PG/字节测试不经过实际GET响应 | 新构建HTTP测试暂停COS读、撤销账号、断言401无字节及文档响应头 |
| verification-2 | 生成后改名revision过期 | medium：独立确认与blind-1相同路径，现有409测试不覆盖正常改名 | 合并revision修正并补正常流程 |

以上17项发现均已修正并纳入对应单元、组件、PostgreSQL或实际HTTP验证。整体Goal仍需阶段4发布/恢复与阶段5图片批注；本阶段未合并、发布、迁移生产或调用收费模型。
