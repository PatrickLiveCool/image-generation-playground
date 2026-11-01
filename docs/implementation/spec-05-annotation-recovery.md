---
title: 批注迁移与恢复制品适配
status: done
updated: 2026-10-30
context:
  - AGENTS.md
  - docs/implementation/spec-05-image-annotations.md
  - docs/implementation/spec-05-annotation-contract.md
---

## Intent

将当前批注实现接入既有迁移、备份和制品契约，保留阶段4全部恢复边界。

## Code Map

独占新增0005 SQL、migration-catalog.ts、schema-contract.ts、lib/project-backup.ts及其测试、deploy/release-policy.json、scripts/check-release.mjs、必要release/maintenance/identity测试与fixture兼容数字更新。不要改0001–0004、UI、能力模块或私有生成代码。文档主规格由root整合。

## Tasks & Acceptance

- [x] 0005添加generation_runs的annotationSnapshot、annotationExecution、providerAnnotationCapability三个nullable jsonb列，以及provider_settings.annotationCapabilities NOT NULL DEFAULT []；有适当json类型CHECK，不破坏旧记录。保持旧SQL/hash。
- [x] 更新catalog、physical schema和policy min/max0005/browserWorkspaceSchema2，必要fixture与断言同步。维护bundle仍只外置pg。
- [x] 备份白名单增加四列，复用image-annotations、annotation-capability、annotation-execution纯验证器；验证snapshot父版本/原始assetId、execution冻结快照摘要/能力/原图hash与归属/两个固定input引用。完整版本批注必须有execution；未完成/failed允许尚未冻结；旧无批注记录为null。
- [x] 能力记录的revision/mapping/actor/证据摘要与绑定实际配置摘要均须核验；账户禁用不破坏已记录证据。新增failureCode ANNOTATION_INPUT_INVALID等按实际源码安全码纳入。
- [x] 加入真实备份恢复夹具中的批注版本（使用同3个合成账号），覆盖快照恢复、篡改拒绝，无额外真实调用；只写测试源，真实PG由root串行运行。
- [x] 跑相关离线检查；不启动DB/服务、不联网、不commit、不读.env.local。

Node22: .local-ops/tooling/node22/node-v22.22.1-darwin-arm64/bin（加入PATH）。现有.NET重复Next生成类型留root处理，不删除用户文件。辅助图允许PNG或JPEG（合同已更新，renderer有受限回退），execution字节hash固定实际输入，不将重编码图替换原图。如纯验证器契约需调整先告诉root。

## Verification & Archive

2026-10-30：本工作包实现、审阅修复和本地验收已完成。主代理已通过相关离线检查、专用 PostgreSQL 备份恢复 1/1，并实际打包、解包运行 Darwin arm64 维护 CLI 的初始化、备份与恢复流程；0001–0004 SQL/hash 保持原样，0005 和 schema2 已纳入制品契约。

归档中的批注 execution 仅在 preparing、failed、unknown 状态允许为空；generating、saving、save_pending、complete 必须已有冻结记录。恢复会把在途准备状态规范化为 unknown，因此保留该可达状态；原图与辅助图分别按 20 MiB、10 MiB 核验。能力证据核对记录者与摘要，但不要求历史记录者当前仍为管理员。

最终命令结果、审阅处置与回退边界归档在 [阶段 5 主规格](spec-05-image-annotations.md) 和 [集成交接台账](spec-06-integration-handoff.md)。以上仅为本项目隔离本地数据库及合成对象的验证；生产工具安装、迁移、恢复与真实 COS 尚未验收。
