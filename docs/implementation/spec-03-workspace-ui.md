---
title: 阶段3远端私有空间界面工作包
status: done
context: [AGENTS.md, docs/implementation/spec-03-private-workspace.md]
---

只编辑 components/image-combiner/ 下相关文件、lib/creative-workspace.ts、lib/creation-types.ts、lib/creation-request.ts、新增lib/private-workspace-client.ts、tests/private-workspace-ui*.test.tsx、tests/creation-request.test.ts、tests/account-storage.test.ts、tests/public-model-catalog-ui.test.tsx。不要改后端/数据库/共享private类型/package/CI。如需其他已有测试更新报告主代理处理。

按主规格固定HTTP协议接线。服务器创作/版本权威，IDB只合并当前账号对应创作的草稿/选择/未知任务ID；决不把本地历史上传为成功版本。保留已有纯workspace函数对外兼容，新增合并辅助函数测试。新账号允许一个未提交空白本地编辑草稿；提交先幂等POST创建，显式新建也POST，网络未知不自动重复但能显式刷新核对。标题修改需要server revision，冲突保留本地草稿、提醒刷新；跨设备恢复列表/图片/父关系/参数。运行中切创作不得串输入。生成返回{run}；断网/取消要标记未知而非普通失败，给查看状态和仅补记保存入口，GET有限轮询且卸载中止。API会话失败dispatch ACCOUNT_SESSION_RECHECK_EVENT。

buildCreationRequest传原始prompt；有documentFile仅发文件，无文件但恢复文档文本才发documentName/documentText，避免重复compose；总文字仍在前端预检。privateRun映射Generation可新增runStatus。未知任务不应自动清草稿/切基准；complete只对同请求提交时draftRevision清稿，新输入保留。从旧成功版本续改必传parentVersionId、使用server原图。

私有下载/复制用同源fetch no-store检查status/type，有会话可见性/lifetime防迟到在退出后写剪贴板或弹下载，释放objectURLs。沿用原有UI，不新建复杂画布（批注后续）。主代理独占ego空间14，不运行浏览器。写真实组件/合并行为测试，不写源码包含断言；离线fetch mock完整匹配新协议。只跑自身离线测试，主代理统一全套。完成不commit。
