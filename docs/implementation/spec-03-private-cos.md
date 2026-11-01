---
title: 阶段3私有COS字节存储工作包
status: done
context: [AGENTS.md, docs/implementation/spec-03-private-workspace.md]
---

只编辑新增lib/private-cos.ts和tests/private-cos.test.ts。按主规格接口实现ownerHash/UUID固定路径校验，仅允许manifest.json、outputs/final、inputs/reference-1/2、inputs/document-image-1/2、inputs/document；不要改旧cos-assets或生成编排/routes/package。可以导入现有类型/错误但不读取CDN_AUTH_KEY/ASSET_ACCESS_SECRET作为访问方式。COS配置只需要COS_BUCKET/REGION/SECRET_ID/SECRET_KEY，并保留现有格式核验；私有ACL、no-store、HTTPS、内存put/get，禁止任何磁盘/预签名/重定向。get使用Range maxBytes+1方式判超限，检查ContentLength/Body，ContentType不能被当作可信图片有效性（调用方还会sniff/hash）。manifest上限256KiB、图片20MiB、document10MiB。不得允许调用方用巨大maxBytes绕过上限，严格限制合法正整数。

用可注入COS client写单元测试覆盖拒绝旧namespace、错误owner/key、过大/空字节、GET不匹配size、错误映射不泄露SDK数据；相同key允许幂等重试存储但不偷偷重试付费模型。不运行真实COS/网络，不commit。
