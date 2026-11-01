---
title: 批注画布与草稿工作包
status: done
updated: 2026-10-30
context:
  - AGENTS.md
  - docs/implementation/spec-05-image-annotations.md
  - docs/implementation/spec-05-annotation-contract.md
---

## Intent

实现父规格全部UI与本地草稿边界；不要重做用户已有的创作体验。

## Code Map

独占components/image-combiner中的index/output/input/history/types及新annotation组件；lib/creation-types、creative-workspace、creation-request、creation-workspace-persistence、creation-emergency-draft等草稿序列化模块；创作hooks/use-creation-generation、use-creative-workspace；对应UI/草稿测试。先核对实际路径。provider后台由另一代理负责。不要修改共享image-annotations、后端生成、数据库/发布或文档parser。

## Tasks & Acceptance

- [x] 三种绘制、实际图像框与8方向、选区上方浮框及主输入共享编辑/删除/撤销。
- [x] 稳定编号、键盘中心区域与移动/调整、可访问反馈及窄屏不遮挡。
- [x] schema2按基础版本草稿迁移/恢复/失败保留；提交只冻结当前base并保留后续编辑。
- [x] 加载metadata、能力与文档输入限制，空整体prompt可提交有效批注。
- [x] 服务器批注快照历史、旧版续改及跨账号异步安全。
- [x] 有行为意义的离线组件/草稿回归；不做浏览器/真实DB/全构建，主代理统一验收。

共享几何模块由主代理按合同提供。可先写消费代码，新增导出需求先沟通。完成后报告文件、通过的测试及仍未验证项，不commit。

## Verification & Archive

2026-10-30：本工作包实现、审阅修复和本地验收已完成。主代理已在 Node 22 下完成相关组件/草稿回归、全仓类型检查与构建；ego lite 空间 20 实际验证矩形、自由圈选、涂抹，浮框与主输入双向同步，稳定编号、删除撤销、键盘操作和 390px 窄屏布局。刷新、切换基准和换号后草稿保持隔离；空整体要求仅提交批注生成 V3，历史可回看原图与批注，保存故障补记未增加模拟调用。

最终行为覆盖、审阅处置和浏览器证据归档在 [阶段 5 主规格](spec-05-image-annotations.md)；跨工作包验证与交付边界见 [集成交接台账](spec-06-integration-handoff.md)。上述验收使用合成图片和模拟模型，不代表真实模型编辑效果或生产已验收。
