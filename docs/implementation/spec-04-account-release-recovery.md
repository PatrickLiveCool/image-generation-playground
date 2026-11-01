---
title: 阶段4账号版发布边界与单项目恢复
status: done
review_loop_iteration: 1
baseline_commit: b6b32a57690cac1394485ebe70877fbcbbfa4f5c
stories: [3.6, 3.7]
context:
  - docs/planning/epics.md
  - docs/architecture/account-persistence/ARCHITECTURE-SPINE.md
  - docs/operations/release-runbook.md
  - docs/implementation/spec-03-private-workspace.md
---

## Intent

让账号版制品、数据库受限维护入口、部署状态机、失败恢复与访问协议形成同一份契约；在本地合成环境验证本项目备份恢复。沿用既有生产库/账号与隔离测试库，不执行生产安装、迁移、发布、切换、清理或收费模型调用。本阶段代码和演练完成后仍继续图片批注。

## 固定跨工作包契约

新账号策略使用 `databaseMode: postgresql`、`assetAccessProtocol: account-private-v1`；保留真实的 browserWorkspaceSchema=1、assetCapabilityVersion=1，不以虚增本地schema表达权限边界。新增 `database` 对象仅含 `name: qintopia_image`、`schema: app`、`minVersion: 0004`、`maxVersion: 0004`、`migrations`；migrations为按name排序的 `{name,sha256}` 数组，与已人工审核的0001–0004清单逐字节一致。

新 release.json / manifest 使用 schema=2 并带同一 databaseMode、assetAccessProtocol、database。manifest继续绑定完整archive/SBOM/policy摘要；归档内新增固定 `maintenance/cli.mjs` 与 `maintenance/migrations/*.sql`，均受归档摘要保护。旧schema=1清单仍能用于只读识别、保留和清理，但不能跨越持久的账号访问底线被激活或回退。

维护包构建输出 `.next/maintenance/`，入口由本仓库TS代码打包为Node22可直接执行的ESM，无tsx或服务器源码构建要求；只外置已经追踪的运行依赖。源迁移入口继续可用，bundled入口仅解析固定相对目录，不接受任意SQL/目录参数。固定命令为 `describe`（离线契约）、`preflight`（只读目标/权限/账本与秘密配置核验，允许已知待迁移）、`migrate`、`verify`（只读且必须达到制品契约）、`backup`、`restore-preflight`、`restore`、`verify-restore`、`bootstrap-admin`、`verify-bootstrap-admin`。输出仅安全JSON状态，不输出凭据或密文正文。

归档使用FD3，恢复秘密仅写预开的FD4；文件必须是root/当前维护身份所有的0600普通单链接文件。管理员初始化使用固定FD3的 `{username,name,password}` JSON，最多16KiB。源入口和制品入口复用同一校验、管理员事务锁、插入及审计逻辑；已有管理员绝不覆盖，提交回执未知只读核对同一凭据。初始化进程仅持有runtime身份，不传入migration/recovery/应用秘密。root入口先独立verify完整数据库契约。此项补齐Story1.3在standalone部署中的实际交付入口。

服务器先验证制品和root配置，隔离维护进程环境（拒绝NODE_OPTIONS、PG*等继承注入），迁移秘密不传入应用进程。维护进程以专用受限OS身份执行固定CLI；仅使用本项目runtime/migration身份，顺序探测与单维护连接，双应用池4+4加维护1不超过9。阶段至少记录database_preflight、migrating、database_verified、staged；迁移回执丢失先只读核账本，不能假定未执行。

在任何可能扩展数据库或激活账号版前持久记录账号访问底线。失败只能恢复数据库与账号访问兼容的成功版本；首次账号版无兼容目标则进入真正的维护响应，不能恢复旧demo的Nginx配置。维护响应须保留证书/ACME边界，不与现有maintenance保留版本清理命令混用。已安装工具的升级采用核对旧摘要、备份、原子替换及失败恢复，禁止放宽为无条件覆盖。

## 单项目备份恢复

采用固定表/列白名单的结构化归档，不执行备份内SQL。整份归档使用独立恢复密钥认证加密，绑定项目、数据库/schema、发布身份、审核迁移摘要与内容摘要；必要应用秘密在受保护归档内恢复验证，不能进入普通日志、Git或制品。全部归档身份、认证、结构、字段、对象引用和配置解密在任何恢复写入前校验；只向固定隔离目标的空业务表事务恢复，不清空目标、不建角色/改ACL、不做共享实例整体恢复。会话不因恢复复活，在途任务不自动重发。图片本体仍只在私有COS，归档仅含引用与元数据。

本地演练优先复用当前专用fixture，以明确合成账号为源，定向清理后恢复到该隔离fixture的空业务表。不得为了演练扩大生产目标、自动清表或重建已创建的项目数据库。若实际需要独立恢复靶场，先记录具体隔离方法及必要性，由主代理核对授权和工具门禁后执行。

## Tasks & Acceptance

- 制品工作包：common/package/check-release/release-identity/policy/smoke及相应测试。
- 服务器工作包：server/orchestrate/deploy入口、安装升级、配置和相应测试。
- 数据库运行包：固定CLI/bundle构建、迁移loader、只读preflight/verify及相应测试。
- 主代理：结构化备份恢复、各接口整合、CI、运行手册、实际本地演练与三路审阅。

必须覆盖错误目标和身份在变更前拒绝、迁移漂移与重复执行、回执丢失、启动/切换/恢复timer失败、旧协议回退拒绝、归档篡改与跨项目拒绝、秘密缺失拒绝、实际Linux制品CLI运行。公共health保持无DB/COS/模型副作用，独立维护预检证明数据库状态。分别记录本地、CI、Linux、服务器执行、公网与人工/真实模型验收，不把其中一层当全部完成。

## 独立审阅与当前验证（2026-10-30）

三路独立只读审阅分别检查结构化恢复、服务器状态机/升级、制品/维护运行契约。以下发现均由主实施者核对，不把建议直接当作已证实漏洞。

- **合法UUID阻断备份（确认、已修复）：** 原备份验证要求RFC版本/variant，但PostgreSQL及已实现的创建接口允许全部128位UUID。现在接受数据库规范化UUID，仍严格验证归属与固定对象键；实际API创建全零UUID空创作已完成PG备份/恢复往返。
- **账本版本漏检（确认、已修复）：** 恢复路径原只比较name/hash，现同时比较version/name/hash；注入version=9999的实际查询结果在BEGIN/锁/INSERT前被拒绝。
- **恢复负面验证缺口（已补并验证）：** 从真实包含账号、provider、版本、文档、资产的完整归档修改COS归属、资产所属run或配置主密钥，重新计算内容摘要并合法GCM认证；恢复与预检仍在目标零查询时拒绝。第5条INSERT注入失败后9业务表全部为空；COMMIT尚未执行就失回执时只读明确确认not-restored，COMMIT已执行后失回执时只读确认成功，不自动重放。
- **无效归档造成不可恢复的未知状态（确认、已修复）：** 增加独立只读restore-preflight；完整认证、秘密、目标schema和空业务表先核对，再记录开始写入。预检失败保留归档与维护响应，允许更正后重新预检；实际写入开始后的未知结果继续强制核对。
- **切换中断后的数据库核验失败仍公开候选（确认、已修复）：** switching恢复路径的verify异常进入兼容源恢复；首次账号版无兼容源则真实maintenance，两种分支故障测试通过。
- **实际制品恢复链验证缺口（本地制品已通过，Linux待CI）：** 源TS恢复演练和Python模拟权限FD测试不足以证明打包运行。Linux smoke现接入同一串行合成夹具，实际调用解包CLI及FD完成首次管理员、备份/恢复/只读核对；同一路径已在Darwin实际打包/解包通过，不称Linux结果。专用维护UID和root wrapper的真实服务器链仍需单独授权执行，不宣称已生产验证。
- **初始化未提交后的死锁（整合核对发现、已修复）：** verify-bootstrap-admin在同管理员锁后的单条READ COMMITTED快照核对全库；完全没有管理员返回uninitialized，server记录not-initialized后才允许下一次明确初始化。已提交则只读核同一凭据和审计；有不同管理员或密码不匹配继续拒绝。原尝试独立保存，输入指纹使用root的Auth secret做域分隔HMAC，避免产生可被低成本猜测的密码摘要；子进程与公开状态不接收该秘密或指纹。

最终本地整合验证：应用测试258/258；发布工具152项中144通过、8项因本机未安装固定COS Python SDK跳过（CI安装该依赖）；typecheck、release:check、actionlint、生产build及差异格式检查通过。实际PG演练及实际打包/解包CLI演练通过，均为3个合成账号、3次模拟模型、0次真实模型、0次云端写入；包括FD3初始化、只读凭据核对、FD3加密备份、恢复预检、FD3/FD4恢复与只读核对、后续登录和私有原图/文档读取。恢复205个额外合成创作验证跨批次插入；归档内尚未使用且未到期的临时密码在恢复后登录返回401。保留ASSET_ACCESS_SECRET，未恢复会话，未清空任何非合成账号或其他项目数据。

本地日志：`/private/tmp/image-stage4-app-tests-reviewed.log`、`image-stage4-release-tests-reviewed.log`、`image-stage4-typecheck-reviewed.log`、`image-stage4-build-reviewed.log`、`image-stage4-packaged-maintenance-reviewed.log`。Linux制品及完整GitHub CI等待本阶段Draft PR验证；未安装/升级生产工具，未生产迁移或切换，未合并/Publish，未调用收费模型。后续仍需实现Epic4批注并完成全Goal集成验收。

## Review Triage Log

最终BMad三层使用同一完整差异（含未跟踪文件）独立审阅，全部返回后逐项核实。此前三个领域审阅用于提前修复；本节记录最终三层新发现。以下均在现有授权和Goal范围内，保留已验证实现并定向补齐，不重置共享工作区。

| ID | 来源与发现 | Verdict | Route | 处理与证据 |
| --- | --- | --- | --- | --- |
| B1 | blind：恢复回滚/未提交后无法解除unconfirmed | medium | bad_spec | 确认代码只接受完整恢复；新增只读not-restored，只有全业务表空才允许下一次明确恢复，绝不自动重发。 |
| B2 | blind：安装已有同内容文件未核预期mode | low | patch | 确认check_file不检查执行位；同内容不同mode拒绝并补测试。 |
| B3 | blind：允许的Unicode秘密超过FD4预算 | medium | bad_spec | 4096中文字符各2键共24696字节可通过原校验；统一64KiB序列化预算，在任何DB写前验证，并统一换行拒绝。 |
| B4 | blind：物理schema只验9业务表列名 | medium | bad_spec | 确认3认证辅助表只有存在性门禁；补13表列集合、类型/非空/identity及关键PK/UNIQUE/FK契约，保持SQL/catalog不变。 |
| B5 | blind：第二次恢复不同秘密提交后才撞旧文件 | medium | bad_spec | 确认全局prepared槽无法完成后续核对；秘密改为固定派生事务UUID文件，部署只读取当前事务。 |
| B6 | blind：第二次恢复覆盖前次恢复回执 | medium | patch | 新尝试先归档前次回执，保留其秘密和输入摘要证据。 |
| B7 | blind：逐行INSERT与固定180秒预算冲突 | medium | bad_spec | 可允许10万级记录，但逐请求往返成本无界累加；改每批最多100行，使用205个实际合成创作验证跨批次恢复与中断回滚。不宣称已测生产延迟或最大容量。 |
| B8 | blind：脱敏维护错误被丢弃，无法定位修正项 | low | patch | 仅白名单错误码映射固定消息，未知内容继续丢弃，秘密/原stderr不输出。 |
| B9 | blind：daemon-reload不足以验证unit配置 | low | patch | 候选固定service/timer加入systemd-analyze verify，保留原升级事务与失败恢复。 |
| B10 | blind：status仅按历史ready报告maintenance | medium | patch | 复查当前本机503响应，失败标needs-attention；不改流量。 |
| E1 | edge：进入维护reload前漏worker shutdown校验 | medium | patch | 在维护配置写入/reload前复用现有validate_shutdown门禁，防止切断未排空请求。 |
| V1 | verification：恢复临时密码失效缺少登录层断言 | medium | patch | 已有用例把普通用户全改成正式密码；先确认临时登录有效，再第二次重置而不兑换，断言归档中usedAt为空且未过期；恢复后使用第二次密码断言401且无会话，再由管理员重新开临时密码。 |
| V2 | verification：当前forward-only的rollback未测试 | medium | patch | 增加当前账号版forward-only、目标compatible的拒绝测试，核对current及Nginx未变。 |

## Spec Change Log

- review iteration 1：明确未恢复的只读证明、每事务秘密/回执保留、统一UTF-8秘密预算、完整身份相关schema门禁与有界批量写入；保留此前所有账号访问底线、已执行SQL/hash、固定路径、角色隔离、原图仅COS、会话不恢复和无自动模型重发契约。三层审阅中的13项均已确认、修复并完成定向独立复核。复核发现V1首次登录会先兑换凭据，已改为归档第二次未使用的临时凭据并完成制品PG验证；最终检查数字见上文。Linux CI、真实服务器执行与生产状态继续分开记录。
