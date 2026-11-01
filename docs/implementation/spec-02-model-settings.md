---
title: 阶段2：现有模型设置后台化
status: done
baseline_commit: 2232e8fb3ea7f932d4be616f57f972c7199c9599
context:
  - AGENTS.md
  - docs/planning/epics.md
  - docs/planning/REVIEW.md
  - docs/architecture/account-persistence/ARCHITECTURE-SPINE.md
---

## Intent

完成Epic2：管理员在后台继续使用现有单套Base URL、Token、Images/Chat和名称映射操作；普通已启用用户只选择名称。没有多供应商、用户×模型权限、模型启停或额度页面。阶段1已提交2232e8fb3ea7f932d4be616f57f972c7199c9599、Draft PR #21依赖#20，两项远端CI均已通过（精确head已核对）。本阶段后仍连续完成私有创作与批注。

## Shared contracts

`lib/provider-configuration-types.ts`定义安全接口：AdminProviderConfiguration `{revision,settings:{baseUrl,apiKey:'',apiMode},secretConfigured,models,mappings,modelsSynced}`；PublicModelCatalog `{revision,configured,apiMode,mappings:[{id,name,aspectRatios:string[]}]}`。

- `GET /api/admin/provider` 返回AdminProviderConfiguration。`PUT` body `{revision,settings:{baseUrl,apiKey,apiMode},models,mappings,modelsSynced}`，仅保存成功返回新安全视图。首次revision=0；乐观版本不符409，不能覆盖别人的配置。
- `POST /api/provider/models`仅管理员，用草稿 `{revision,baseUrl,apiKey,apiMode}`同步；空apiKey仅在Base URL与已存值完全一致、revision当前时取旧秘密。新地址必须有新Token。返回 `{models:[{id}]}`，从不保存配置、不生成图片。
- `GET /api/models`给完成改密的启用用户返回PublicModelCatalog；没有Token/Base URL/actual modelId。当前已选映射消失则提示重新选择，不默认切换。
- `lib/provider-configuration.ts`提供 `readAdminProvider(headers)`, `saveAdminProvider(headers,body)`, `syncAdminProvider(headers,body,signal?)`, `readPublicModelCatalog(headers)`, `resolveGenerationProvider(headers,mappingId)`；最后一个仅服务端返回 `{settings:ProviderSettings,mapping:ModelMapping,revision}`。
- 单例schema `app.provider_settings`：Base URL、AES-256-GCM密文、apiMode、models/mappings JSON、modelsSynced、revision、updatedBy/updatedAt。密钥`PROVIDER_CONFIG_KEY`为严格32字节base64，仅环境注入，缺失/损坏拒绝，不降级明文，不轮换图片密钥。
- 保留原始映射稳定ID、名称唯一校验、排序、手填、缺席提醒。服务端严格校验输入形状/大小，映射最多100条，候选模型最多5000条，整体JSON不超过2MiB。
- `lib/generation-admission.ts`提供 `acquireGenerationSlot({userId,requestId,fingerprint}) -> {acquired:boolean,status:'active'|'finished'|'unknown'}`，重复同id同指纹不再调用；异指纹409。`finishGenerationSlot(userId,requestId, outcome:'finished'|'unknown')`，只有真实终态才能finished；unknown占位保留到固定deadline。默认全局2并发、用户1并发、用户每分钟6次；环境可下调/有限上调，配置有界校验。模块不调用provider，后续私有run直接复用。`app.provider_request_slots`只记录短时受理/幂等，非计费账本。

## Tasks & Acceptance

- [x] 后端：新迁移0002-provider-settings.sql及0003-provider-admission.sql（先审阅后登记哈希），本地受限身份执行。配置权限/审计/版本检查在同事务复核，Token只加密；库中无明文，GET永不回显。保存不出网，同步走现有公网SSRF保护与20s超时，旧秘密不能发往新地址。
- [x] 后台：`/admin/models`复用ApiSettingsModal、ModelMappingEditor，保存有明确加载/失败保留/409反馈，取消不保存；同步用未保存草稿，旧响应不覆盖新草稿。只已输入的新Token可切换显示，存储的Token仅显示已配置。
- [x] 前台：移除API设置入口与localStorage配置读取，使用服务器目录；仅映射id进入生成表单，不发送Base URL/Token/apiMode/实际modelId/baseImageUrl。旧本地秘密不上传、不删除。保留选择名称、比例/质量、文档和参考图行为。
- [x] 保护：并发/额度/幂等在PostgreSQL原子处理；过期/unknown不自动重试上游。模拟并发覆盖上下限与相同/不同请求指纹，不付费调用。
- [x] 验证：加密/恢复/缺密钥/损坏、管理员/普通/临时角色、草稿同步不保存、保存失败、取消、迟到同步、映射删除和请求负载无秘密的行为测试；完整类型/测试/构建、独立审阅、阶段commit/依赖PR。ego浏览器门禁独立记录，不伪造视觉验收。

## Matrix

| Given | When | Then |
| --- | --- | --- |
| 空配置 | 管理员首次保存 | 新Token必填，原子生成revision1 |
| 已配置Token | 空Token保存/同地址同步 | 服务端保留/取用原秘密，不回显 |
| 地址变化 | 空Token同步/保存 | 调用前拒绝，不传旧秘密 |
| 两管理员同revision | 并发保存 | 仅一个成功，另一个409 |
| 普通/临时/跨站 | 配置/同步接口 | 拒绝，不读写上游 |
| 同步在途 | 修改连接/关闭/新同步 | 旧响应不能覆盖草稿 |
| 旧浏览器Token | 普通界面加载与生成 | 不读取上传，不覆盖后台 |
| 选中映射被删 | 目录刷新/提交 | 拒绝并要求明确重新选择 |
| 并发/幂等重复 | 原子受理 | 不超过限制，不重复外呼 |

## Boundaries

绝不碰其他应用/生产数据库、服务或ACL；用既有精确Docker测试夹具和合成账号/供应商。不得实际调用收费模型。生成公开入口在私有链路完成前继续安全503，阶段3接通。本地仅Node22.22.1与pnpm10.28.2；不升级Next/React。

## Verification

2026-10-29 继续原 Goal：固定 Node22.22.1/pnpm10.28.2 下 release:check、typecheck、应用测试149项、数据库2项、账号18项、配置10项、受理13项通过。actionlint与diff检查通过。release测试88项通过/8项因SDK依赖缺失跳过，单独补跑中。Base URL原样匹配补丁针对测试18项通过，新增配置集成断言待复验。浏览器空间14及构建验收进行中，尚未提交PR，不代表生产上线。

## Review Triage Log

| 来源 | 判断/处理 | 证据 |
| --- | --- | --- |
| Blind 1 后台权限失效 | medium / patch | 客户端配置读取/保存/同步仅返回错误，未触发账号复核；统一复用会话事件，使Gate隐藏已失效内容。 |
| Blind 2 同步版本冲突 | medium / patch | 同步409仍提示手填但revision未变；接入已有重新载入流程，保留草稿。 |
| Blind 3 目录读取内存上限 | medium / patch | 原publicFetch在32MiB后才终止；新增更小的受限读取参数，目录在2MiB终止。 |
| Blind 4 请求比例 | medium / patch | 构造器只校验全局枚举；补当前映射能力检查，拒绝旧草稿中的不支持比例。 |
| Blind 5 目录反序列化 | low / patch | 正常服务端输入严格，但损坏响应会进入目录；有限枚举/重复ID/数量直接校验，无额外产品功能。 |
| Blind 6 映射UI上限 | low / patch | 第101条仅在服务端保存时拒绝；编辑器在100条禁用新增，保留后端限额。 |
| Blind 7 夹具并行清理 | low / reject | 共享夹具本来要求串行，CI及本次均串行且浏览器不并发清理；不存在承诺并行的入口。不为未授权并行使用新增锁体系，操作手册明确约束。 |
| Blind 8 JSON分块 | medium / patch | 自定义2MiB正文仍受旧16384分块数限制；改按本次maxBytes限制并验证单字节分块。 |
| Blind 9 密钥恢复指引 | medium / patch | 加解密及恢复原值已有真实隔离测试，缺运维说明；新增配对备份与失钥处置边界，正式恢复工具仍属已计划发布工作包。 |
| Blind 10 分享文案 | medium / patch | 旧帮助承诺能力链接分享，与账号私有冲突；修正文案，不恢复旧入口。 |
| Edge 1 原型模型ID | medium / patch | ASPECT_RATIO_SUPPORT[id]可读取继承属性，服务端展开时报错；使用own-property查询并覆盖constructor/toString/__proto__。 |
| Edge 2 JSON分块 | medium / patch | 与Blind8同根因，保留独立记录，应用同一修正。 |
| Verification 1 比例传递覆盖 | medium / patch | 新服务端目录到真实创作界面的比例传递未有行为测试；补集成列表值与UI比例切换测试。 |
| Verification 2 删除映射覆盖 | medium / patch | 原测试仅函数与静态目录；补真实界面刷新后删除选中项、保留草稿和显式重选行为。 |

## Implementation Notes

恢复原Goal后仅继续阶段2，基线2232e8f保持。浏览器原空间11不存在，用户授权新建替代空间14。ego lite本地验收覆盖管理员登录/配置保存/重开Token空白/换地址缺Token拒绝/取消不保存/普通用户首次改密及目录/普通用户管理接口403。部分指针与fill操作受焦点切换影响，使用键盘及已观察DOM事件完成表单；未宣称所有指针路径均验收。截图保存在系统临时目录，不入Git。未执行收费模型、真实COS、生产迁移或发布。

构建首次受默认沙箱的Turbopack临时端口限制，批准后同命令构建成功。发布测试原8项SDK缺依赖已在固定依赖临时环境补跑8/8；本地88+8项均通过。审阅修正后将只重跑受影响测试、类型、构建与配置集成/HTTP，不重复无关发布测试。

最终本地验证：审阅修正后应用测试164/164、typecheck、pnpm build、配置PostgreSQL10/10（含新增断言）及构建HTTP测试24项断言通过。此前同阶段database2/2、auth18/18、admission13/13、release工具88项加固定SDK8项、actionlint均通过；相关实现未再变更。三路审阅14条逐项处置，全部阶段2必要修复和有意义覆盖已完成。远端CI和Linux制品仍待本阶段PR回读，未合并/部署。
