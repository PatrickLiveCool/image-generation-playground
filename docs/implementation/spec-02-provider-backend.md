---
title: 阶段2配置服务工作包
status: done
context:
  - AGENTS.md
  - docs/implementation/spec-02-model-settings.md
  - docs/operations/database-development.md
---

仅编辑lib/provider-configuration.ts、lib/provider-secret.ts、app/api/admin/provider/、app/api/provider/models/route.ts、app/api/models/、migrations/0002-provider-settings.sql、tests/provider-configuration*.test.ts。可扩展lib/auth/validation.ts的readJson为可选maxBytes参数（认证默认16KiB不变），用于设置最大2MiB；不得改package/CI/前端/types/迁移catalog/共享fixture，主代理登记审核哈希并迁移。先完成服务+SQL，告知主代理执行迁移后再真实测试，别与其他代理并发清理PG。

读主规格实现API与加密。AES256GCM随机nonce、version envelope与AAD绑定singleton固定职责；严格base64 key，不可从其他secret派生，解密验证缺失/破坏失败。管理员read也需验证密文可解密，不回显明文；新保存新地址需新token，空token保留，拒绝纯掩码当token。保存先校验公网HTTPS URL语法/IP，不DNS/不出网；同步现有publicFetch验证DNS固定连接、重定向拒绝，限制响应size候选数，不放宽原边界。

数据库写事务复核管理员/会话及当前revision；singleton并发初始化不能双成功。配置审计可独立表provider_config_audit（仅操作者、revision、动作），不要改已执行0001中账号审计check约束。最小范围、不多provider。不强制必须至少一个映射，空目录合法但普通用户不能生成。

本地集成需明确IMAGE_PROVIDER_TEST_DATABASE_URL、精确fixture assert与合成账号；请把需要的用户名报给主代理补允许清单，不随意接受任意用户名。没有付费调用；同步测试mock已有publicFetch，不网络去真实供应商。纯crypto、形状、stale revision、role、URL旧token保护均测试。短时生成并发另外代理负责，不改其模块。完成报告，别commit。

主代理已整合验证；当前证据和剩余外部执行状态见 spec-02-model-settings.md。
