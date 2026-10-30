---
title: 批注文档图像预检与预览
status: done
updated: 2026-10-30
context:
  - AGENTS.md
  - docs/implementation/spec-05-image-annotations.md
  - docs/implementation/spec-05-annotation-contract.md
---

## Intent

让批注提交可靠区分纯文字、含图和无法确认的文档，不把提取失败或小图过滤当作无图；保留现有普通生成文档能力。

## Code Map

独占lib/document-parser.ts、必要纯检查模块、新POST app/api/documents/preview/route.ts、相关离线行为测试。父规格已有消费者等imageInspection，UI保存预览状态但服务端提交重新解析。若必要可将已锁定的传递依赖提升为精确直接依赖（同版本，不升级），并更新standalone external配置；改package.json前告诉root以避免冲突。

## Tasks & Acceptance

- [x] ParsedDocument.imageInspection为none/present/unknown，只有完整成功检测无图才none。纯文字PDF/DOCX应可得到可靠none；小图/未支持格式/页眉等图不能因未被提取而被误判。异常/超界/检测不完整为unknown，普通文档提取继续原行为。
- [x] 检查已安装pdf-parse/mammoth实际能力，避免直接依赖其私有实现。确需低层PDF/ZIP依赖则复用已锁定版本；有界、仅内存、禁止联网加载文档外部资源。HTML/MD/XML的图引用或不能确认内容也不可假称none。
- [x] POST /api/documents/preview：FormData只允许document File；same-origin、已启用账户、上传边界/文件名校验、解析后重新鉴权；返回{document:{name,text,imageInspection}}、no-store，不写COS/DB/磁盘或暴露文件字节。
- [x] TXT、纯文本与含小图PDF/DOCX、图像提取失败/不完整、拒绝旁路的必要离线测试。不要只测images.length。若fixture需生成，在测试内存构造。
- [x] 跑Node22离线测试；不操作DB/浏览器/真实服务，不读取.env.local，不commit。真实HTTP验收交root。

Node22 PATH前缀：.local-ops/tooling/node22/node-v22.22.1-darwin-arm64/bin。

## Verification & Archive

2026-10-30：本工作包实现、审阅修复和本地验收已完成。主代理已在 Node 22 下完成文档检查/预览回归与全仓构建；构建 HTTP 实际验证纯文字及含小图/页眉图片的 PDF/DOCX 预检，以及普通 PDF 的可用图片继续转发。HTML 属性名大小写、DOCX 图片域和不能完整判断的内容均保守处理；PDF 使用同一有界任务完成检查与提取，资源预算不安全时明确拒绝，不继续无界提取。

最终测试、构建运行证据与审阅处置归档在 [阶段 5 主规格](spec-05-image-annotations.md)；整体状态和验收边界见 [集成交接台账](spec-06-integration-handoff.md)。文档夹具在内存构造，预览不写 COS/数据库/图片文件；构建 HTTP 使用模拟模型与内存 COS，未验收真实收费模型或生产。
