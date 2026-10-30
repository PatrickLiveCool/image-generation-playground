---
title: 图片区域批注与统一提交
type: feature
created: 2026-10-30
status: done
route: dispatch
review_loop_iteration: 1
baseline_commit: 1c39609b3a4b8820fb70c8b67eb24af0b5c67ff8
stories: [4.1, 4.2, 4.3, 4.4]
context:
  - AGENTS.md
  - docs/implementation/spec-05-annotation-contract.md
---

<frozen-after-approval reason="沿用已确认Goal、Epic4与架构AD-13/14，连续实施并自行阶段验收">

## Intent

在现有私有创作中标记矩形、自由圈选和涂抹区域，选区上方写说明，主对话框实时共享编号与文字。统一提交得到以选中成功版本为父版本的新图，并能跨设备回看已提交快照。

## Boundaries & Constraints

按账号、创作、基础版本隔离草稿；原图像素坐标和EXIF方向可逆转换，浮框与主输入不保存第二份说明。原始基准始终第一张，辅助标注图与原图分离；失败保留，补保存不重发模型。私有COS与内存边界、归属和既有生成体验保持。

模型能力绑定真实连接、接口、模型、配置版本及证据；换绑失效，仅改名称/排序保留。未知能力、输入超限、无效几何在模型调用前失败。模拟请求证明传递，不证明真实模型效果。不得调用收费模型、操作生产/其他项目数据库、合并或发布。

## I/O & Edge-Case Matrix

| 输入或状态 | 预期行为 |
| --- | --- |
| V1多区域说明、可选整体要求 | 一次受理，原图+编号辅助图，得到V2并保留来源 |
| 切换V1/V2、创作、账号或刷新 | 恢复对应草稿，迟到读取不串数据 |
| 浮框输入/主输入编辑/删除/撤销 | 同一稳定编号同步；局部操作不调用模型 |
| 缩放、非方图、镜像/旋转方向 | 原图坐标不变，显示与提交区域一致 |
| 模型未知或换绑、含图材料占位 | 可调整原因；模型调用0，不丢弃材料 |
| 空说明、越界、过量、损坏草稿 | 拒绝或阻止覆盖，保留可恢复输入 |
| 失败、断线、保存未完成 | 保留原图草稿；只读核对/补保存，不自动重发 |

</frozen-after-approval>

## Code Map

- UI工作包：[spec-05-annotation-ui.md](spec-05-annotation-ui.md)，复用creation hooks与output/input/history。
- 后端工作包：[spec-05-annotation-data.md](spec-05-annotation-data.md)，复用唯一私有生成与修复入口。
- 能力工作包：[spec-05-annotation-provider.md](spec-05-annotation-provider.md)，扩展现有单套配置，不新增供应商目录。
- 主代理：共享几何/渲染契约、文档图像检查、0005迁移/备份/制品边界和集成验收。

## Tasks & Acceptance

- [x] 共享载荷、8方向坐标、内存标注图与必要边界测试。
- [x] 后台记录能力证据、配置换绑失效与公共目录安全投影。
- [x] 图片三种标记、共享浮框/主输入、键盘定位与窄屏布局。
- [x] schema2本地草稿恢复、冻结提交、失败保留、跨会话历史。
- [x] 任务快照/输入绑定持久化，幂等、私有素材和修复核对。
- [x] 扩展迁移与恢复契约，模拟HTTP/PG/ego lite完整走通。

验收覆盖上表，并逐项对应epics.md的4.1–4.4。最终明确本地、GitHub/Linux、浏览器、生产和真实模型状态。阶段4 PR #24 CI继续单独跟进，不能把其提交当作整Goal完成。

## Implementation Notes

采用overlay-v1：原图+编号标注图占满现有2张输入，因此额外参考图和含图/无法确认的文档明确拒绝；确认纯文字的文档继续可用。几何20条、每路径256点、总4096点、每说明500字、快照128KiB；整体/逐条说明/文档组合仍不超过既有5000字。仅单帧图片可批注。

## Spec Change Log

- 审阅迭代1：按已确认连续实施与保留工作区授权，修订非冻结实现约束并增量重做已证实的缺口；不整体回滚已验证功能。KEEP：原图第一输入、私有COS/内存边界、冻结幂等、不重复调用模型、账号隔离、所有既有迁移hash及成功测试。补充可见性恢复只读核对、元数据重试、浏览器/服务端填充一致、文档全流程预算、原图/辅助图分别限额、冻结状态约束、完整能力证据冻结与独立停用。业务目标和生产/收费授权边界保持。

## Review Triage Log

| 编号 | 判定与处理 | 核对证据 |
| --- | --- | --- |
| B1 | high / bad_spec | 账号焦点复核会暂时隐藏；generation hook 中止请求后保留 observed，同实例恢复不重新查询。补同账号恢复与旧请求清理竞态。 |
| B2 | high / bad_spec | relay/冻结执行允许20MiB原图，备份两输入均限10MiB，11MiB合法记录无法备份。区分原图20MiB与辅助图10MiB。 |
| B3 | medium / patch | HTML background 属性确有图片语义，现有标签白名单仍返回none。补该属性及保守的属性检查。 |
| B4 | medium / patch | DOCX INCLUDEPICTURE简单/复杂域未进入drawing/media检查，正文可保留而图片遗漏。识别域或返回unknown。 |
| B5 | high / bad_spec | PDF结构解压预算失败仅返回unknown，parsePdf仍继续第二次完整提取。资源预算失败必须在提取前停止，提取过程也受统一预算约束。 |
| B6 | medium / patch | 浏览器polygon默认nonzero，服务端evenodd；有效重复环绕路径显示不同区域。统一evenodd并测试。 |
| B7 | medium / bad_spec | 元数据effect只依赖版本/URL/可见性；刷新相同创作不会重试失败元数据。补明确重试且保留账号/版本归属。 |
| B8 | medium / patch | generating/saving/save_pending必须先冻结execution；当前归档允许缺失。preparing/failed允许缺失，normalizedRestoreTables把preparing转为unknown，故unknown/null确实可达。收紧可证明的状态组合。 |
| B9 | medium / bad_spec | 重录/换绑移除当前证据，历史任务只留摘要，无法回查原来源和记录者。新增任务冻结完整证据，维护已有仅摘要数据的兼容与私密投影。 |
| B10 | medium / bad_spec | 已记录能力无法独立停用；只能改普通生成配置来失效。补带revision和管理员校验的停用，保留已受理任务证据及普通生成。 |
| E1 | high / bad_spec | 与B1同根因；独立happy-dom同实例true→false→true复现一次请求、一次abort、未恢复查询。 |
| E2 | high / bad_spec | 与B2同根因；独立11MiB夹具通过执行验证而归档报BACKUP_ANNOTATION_INVALID。 |
| G1 | medium / patch | 已验证缺口：像素测试仅覆盖矩形，三种HTTP几何仅比较哈希；删除套索/笔刷图形仍可通过。新增内外像素与方向断言。 |
| G2 | medium / patch | 已验证缺口：真实ImageCombiner测试未覆盖仅批注、空整体要求；Probe/HTTP绕过canGenerate。补真实页面FormData断言。 |
| G3 | high / bad_spec | 与B1同根因；独立内存探针及AccountGate/useCreativeWorkspace调用链证实无补偿刷新。 |
| R1 | medium / patch | B3复核发现HTML大写BACKGROUND/STYLE仍可漏检；已将属性名归一化并补混合大小写用例。 |
| R2 | high / patch | B1首轮修复仍中止已提交POST，可能影响模型响应；临时checking现在保留submitted请求与槽位，仅真正卸载/停止才中止，回归确认单次POST完整返回。 |

## Verification

适用的单元/组件、真实专用PG、构建HTTP和ego lite模拟验收；typecheck、test、test:release、release:check、build、actionlint。新增0005只在已授权的专用合成库执行，不改0001–0004。最终三层独立审阅与必要修复。

2026-10-30 本地实现和阶段验收完成；提交、PR 与精确 head 的 Linux CI 状态集中记录在 [集成交接](spec-06-integration-handoff.md)，不由本文件的 `done` 推断发布。

| 验证层 | 结果 |
| --- | --- |
| 应用/静态/构建 | Node 22.22.1、pnpm 10.28.2；应用 327/327，typecheck、release:check、build、actionlint 通过。 |
| 发布工具 | 155 项中 147 pass、8 skip；本机缺固定 COS Python SDK，8 项不计为通过，Linux CI 安装后另核对。 |
| 实际专用 PostgreSQL | provider 13/13、annotation 6/6、backup 1/1；完整证据冻结、独立停用、换绑后旧任务修复及批注归档恢复通过。 |
| 构建 HTTP | annotation/private 两套通过，分别 4/3 次模拟调用；覆盖 PDF/DOCX 预检、正常 PDF 图像转发、原图和辅助图、跨会话历史、补保存及读取期间撤销。 |
| 实际打包维护 CLI | Darwin arm64 打包、校验、解包后执行 5 个迁移与初始化/备份/恢复通过，未上传或发布制品。 |
| 独立审阅 | 三层审阅 15 项发现逐条处置；edge/gap 修复复核通过。最后 HTML 属性大小写和临时账号复核保留 POST 两项由独立 followup 复核，10/10 通过。 |

### ego lite 浏览器验收

使用获准替代空间 20、同一页面 p1、本机 `http://localhost:3108` 开发服务、隔离 PG、合成账号/图片、模拟模型和内存 COS。高层填充接口误报后台输入不可见，按 ego 文档改用同一页面的 CDP 原生键盘/指针；未用 DOM value 赋值替代编辑。浏览器开发服务与上述 production build/HTTP 证据分开：生产认证在 HTTP localhost 上拒绝安全来源，未放宽其 HTTPS 要求。

- 后台记录、停用、重新记录双图能力；配置 revision 2→3→4，普通映射保留，没有模型调用。
- 普通账号第一次进入浏览器前已由独立会话保存 V1/V2；浏览器读取远端版本与 V2 的 V1 冻结批注，普通界面不显示实际模型标识。
- 原生指针绘制矩形、自由圈选、涂抹；浮框和主输入双向同步；删除编号 2 后保留 1/3，撤销恢复 1/2/3；键盘加中心区域、移动、调整尺寸和删除通过。
- V1/V2 草稿隔离、刷新恢复通过；390px 窄屏文档宽度仍为 390px，浮框可见可输入；桌面/窄屏截图已实际查看。
- 整体要求为空、只有三条区域说明时提交；注入一次清单保存失败后显示“等待补记保存”，点击“仅补记保存”得到 V3。父版本为 V1，三个几何类型及编号冻结，第一输入 hash 等于 V1 原字节，第二输入为独立辅助图；调用数从 2 到 3，修复后仍为 3。
- 退出后管理员不见普通账号草稿或版本，读取该创作返回 404；普通账号重新登录恢复自己的草稿，V3 历史回看包含编号 1/2/3。临时验收文字已清空，已有版本保留。

本轮浏览器合计 3 次模拟调用，真实模型和真实云写入均为 0；跨物理设备、真实网关区域编辑效果与生产部署仍未验收。安全摘要写入本规格，临时截图/合成用户快照不加入 Git。
