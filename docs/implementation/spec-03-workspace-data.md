---
title: 阶段3私有空间数据工作包
status: done
context: [AGENTS.md, docs/implementation/spec-03-private-workspace.md]
---

只编辑 migrations/0004-private-workspace.sql、lib/private-workspace-service.ts、lib/provider-configuration.ts（新增事务内解析固定revision函数）、tests/private-workspace-data*.test.ts。不得修改共享类型、catalog、fixture、package/CI、COS、routes、前端。主代理维护这些集成点。先写SQL并告知主代理审核；未经主代理本地迁移完成确认不得跑PG集成，不接触真实云。

实现主规格固定函数签名，返回声明类型。创作/任务复合owner键和关系、唯一版本、revision锁；同请求返回已有时不要受后来的模型配置变化影响；同id异指纹拒绝。provider快照用事务内固定revision和映射解析，保存baseURL/apiMode/实际模型/显示名/revision但不保存明文或密文Token复制。若父版本无效立即失败。输出和manifest键固定，outputAssetId预分配randomUUID。read列表返回所有任务状态，deadline过期未完成映射unknown，不能自动重发。成功提交时assets数组包含已存输入和输出；校验合法key归属、hash、大小、固定outputAssetId，事务插入并标记complete/释放slot；失败状态有界白名单。complete若并发修复重复应返回原记录。

新增真实PG有意义测试，与现有auth/provider测试建立相同synthetic测试fixture；用户名使用provider-admin-a、provider-user、provider-temp等现有白名单即可，所有测试必须串行运行。可以先写测试等待主代理统一执行。完成后不要commit，报告文件/断言/未验收状态。
