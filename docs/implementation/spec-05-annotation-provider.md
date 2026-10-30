---
title: 批注能力记录与模型绑定工作包
status: done
updated: 2026-10-30
context:
  - AGENTS.md
  - docs/implementation/spec-05-image-annotations.md
  - docs/implementation/spec-05-annotation-contract.md
---

## Intent

在现有单套API设置及映射后台记录并绑定批注输入能力，未知时安全拒绝。

## Code Map

独占lib/provider-configuration、provider-configuration-types、provider-configuration-client与新增annotation-capability纯类型/校验模块；现有后台provider设置组件和对应admin API；相关离线测试/集成测试源。先核对实际组件路径。不要改普通生成UI、共享几何、private-generation、SQL/备份/发布。

## Tasks & Acceptance

- [x] 独立管理员核验记录动作：认证/角色/CSRF/并发revision、绑定实际连接/模型/Token，证据来源+说明+确认，不调用模型。
- [x] 存annotationCapabilities数组；名称/顺序更新继承证据到新revision，换绑或Token变更失效。
- [x] 内部ResolvedAnnotationCapability与public安全projection合同完整；公共响应不泄露真实模型/地址/Token/证据正文。
- [x] 后台简明显示状态、需保存后记录证据，不能用未保存配置标记已核验。
- [x] 离线边界/行为测试，编写PG核验用例交主代理串行跑；更新相关现有测试。

0005由主代理统一增加列。pure模块必须不引入数据库/network，使维护bundle可复用形状校验。能力记录仅证明管理员依据资料核对过输入契约，不虚称真实编辑效果。不要操作网络/数据库/服务/浏览器、不读取.env.local、不commit。完成报告证据及限制。

## Implementation Notes

独立 `POST /api/admin/provider/annotation-capabilities` 只接受当前 revision、mappingId、HTTPS 证据来源、说明和明确确认。事务复核管理员身份并复用配置锁，记录动作推进 revision；既有 audit action 保持 `save`，证据内独立保存 UUID、actor、时间、来源及说明。绑定摘要包含实际地址、接口、模型和 Token 身份摘要。纯模块固定内部/公共形状与证据序列化，供维护包复用。

后台能力表单独立于设置草稿，设置弹窗打开、配置读取或写入、结果未知时禁止记录。结果未知保留输入并要求只读刷新核对；配置变更后重置确认。只显示“已记录双图输入契约”，不标记真实模型效果已验收。

## Initial Verification

2026-10-30：Node v24.21.0 下离线 `annotation-capability`、`provider-configuration`、`provider-configuration-client`、`provider-settings-ui`、`public-model-catalog-ui` 共 35/35 通过；本工作包 `git diff --check` 通过。全仓 tsc 本工作包无报错，但当时仍被既有 `.next/types/routes.d 2.ts` 重复类型及其他工作包在途定义阻断；不能据此宣称全仓类型检查通过。

专用 PG 用例已写入 `tests/provider-configuration-integration.test.ts`，包括认证/CSRF、并发 revision、证据继承与逐项换绑失效、公开投影、等待事务期间撤权/撤会话及零网络调用断言。由主代理在 0005 后串行运行；本工作包未操作数据库、网络、服务、浏览器或真实模型，未读取 `.env.local`、未提交。

## Final Verification & Archive

2026-10-30：上述初验记录之后，主代理已在规定的 Node 22 环境完成相关回归、全仓类型检查与构建，并串行通过 provider PostgreSQL 集成 13/13；本工作包实现、审阅修复和本地验收已完成。新增任务冻结完整能力证据，历史仅摘要记录保留兼容；能力可用带 revision 校验的独立 DELETE 动作停用，不改普通生成映射，也不改已受理任务。ego lite 空间 20 已实际验证后台记录、停用、重新记录能力，以及普通用户只见安全目录。

最终验证与审阅处置归档在 [阶段 5 主规格](spec-05-image-annotations.md)；全流程证据和边界见 [集成交接台账](spec-06-integration-handoff.md)。能力记录与停用不调用模型；这些结果不证明真实网关编辑效果或生产已经验收。
