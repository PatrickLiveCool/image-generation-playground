---
title: 阶段2调用受理保护工作包
status: done
context:
  - AGENTS.md
  - docs/implementation/spec-02-model-settings.md
---

只编辑lib/generation-admission.ts、migrations/0003-provider-admission.sql、tests/generation-admission*.test.ts。主代理审核SQL/登记hash/迁移，别改catalog/package或其他文件。不建立新goal，不访问真实上游/生产。读取主规格中函数契约，实现PostgreSQL原子并发/短时额度/幂等；函数输入仅已由入口校验的userId，模块内仍数据库检查用户启用+已改密。不信任客户请求覆盖阈值，环境有界IMAGE_GENERATION_MAX_CONCURRENT(默认2，上限8)、IMAGE_GENERATION_PER_USER_CONCURRENT(默认1，不超过global)、IMAGE_GENERATION_RATE_PER_MINUTE(默认6，上限60)。同requestId同fingerprint既存则acquired=false，异fingerprint409；生成requestId必须UUID，fingerprint64位hex，userId已有。错误用AccountError或统一可转JSON错误而不泄露SQL。

全局advisory事务锁简化小规模count+insert；配合账号行锁避免禁用竞态。session在上层受理事务复核，暴露可接受PoolClient的底层函数以便下一阶段同事务创建run，不开长期连接。额度只在首次受理消耗；重复不再次消耗。active/unknown占位deadline固定为受理后300秒，unknown直到deadline才不计并发；超过deadline同id不允许再次acquired，避免第二次收费。finish只能从active进入finished或unknown，不允许外部unknown迟到结果释放其他请求；terminal幂等。记录仅为短时保护/幂等，不建设计费产品。

真实集成测试须专用IMAGE_ADMISSION_TEST_DATABASE_URL+assertAccountTestFixture，synthetic用户名需要报主代理加明确allowlist；保持自己的行cleanup不删其他测试数据，联系其他代理避开权限注入/清库窗口。证明16并发仅限值成功、同id只一次、不同payload拒绝、不同用户global限制、unknown不立即释放、deadline与账号禁用/临时拒绝。完成报告，不提交。

主代理已整合验证；当前证据和剩余外部执行状态见 spec-02-model-settings.md。
