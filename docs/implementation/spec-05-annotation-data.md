---
title: 批注受理与私有任务追溯工作包
status: done
updated: 2026-10-30
context:
  - AGENTS.md
  - docs/implementation/spec-05-image-annotations.md
  - docs/implementation/spec-05-annotation-contract.md
---

## Intent

扩展现有唯一生成/保存/修复通道，使批注在模型前被严格验证并持久化来源。

## Code Map

独占lib/private-generation-input、private-generation、private-workspace-service、private-workspace-records、private-workspace-types；新增lib/annotation-execution.ts纯验证和app/api/images/[id]/metadata/route.ts；对应后端离线测试与专用批注集成测试源。其他API只在必要时沟通。不要改0005/备份/release、共享几何渲染、provider配置、UI或文档parser。

## Tasks & Acceptance

- [x] snapshot进入command/指纹/DB/public DTO，旧无批注指纹与旧manifest修复仍兼容。
- [x] 新任务固定已核验能力；重复受理先看原任务，不被配置变更打断。
- [x] 确认所有输入可传及真实基准metadata；先保存原图/辅助图、冻结execution，再模型一次调用。
- [x] 修复完整比对DB请求/快照/execution与COS字节角色，不重渲染/调用模型。
- [x] 私有metadata接口真实解码、身份复核/no-store。
- [x] 模拟调用、幂等/输入拒绝/篡改修复的离线测试；写真实PG/HTTP用例但由主代理串行运行。

共享parser/render函数由主代理、能力解析由provider代理提供；任何合同变更先沟通。只处理自己的文件，不启动DB/服务器/浏览器、不读取.env.local、不commit。完成报告证据与剩余项。

## Verification & Archive

2026-10-30：本工作包实现、审阅修复和本地验收已完成。主代理已完成相关离线回归、专用 PostgreSQL 批注集成 6/6，以及构建后的批注 HTTP 验收；覆盖私有归属、冻结原图与辅助图、幂等、无效输入与篡改拒绝、元数据读取期间撤权，以及配置变化后沿用受理快照补保存。ego lite 空间 20 已验证仅批注提交生成 V3、父版本与历史追溯、故障补记不增加模拟调用，以及换号隔离。

最终请求/恢复证据与审阅处置归档在 [阶段 5 主规格](spec-05-image-annotations.md)；各层验证边界见 [集成交接台账](spec-06-integration-handoff.md)。数据库为本项目专用本机夹具，图片使用内存 COS 与合成模型；未执行真实收费模型或生产验收。
