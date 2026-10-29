---
title: 阶段2后台设置界面工作包
status: done
context:
  - AGENTS.md
  - docs/implementation/spec-02-model-settings.md
  - docs/planning/REVIEW.md
---

只编辑 app/admin/models/page.tsx、components/account/admin-models.tsx（及对应小型页面guard文件）、components/image-combiner/api-settings-modal.tsx、lib/provider-configuration-client.ts、tests/provider-settings-ui.test.tsx，以及components/account/account-gate.tsx加入管理员菜单模型入口、components/account/admin-users.tsx加入后台导航。不要改index/input/model-selector/hooks/creation-request（主代理负责普通前台），不要改后端/package/types。

保留现有API设置对话框/映射编辑器视觉和操作，不做新供应商界面。从主规格类型GET读取服务端数据、PUT显式保存，revision乐观控制；新apiKey初始空，secretConfigured提示已配置；空token只在baseURL未变可复用，改base需新token。表单onSave改为Promise等待，失败保持输入不关闭；点击取消不保存，同步永不保存。同步加入revision/apiMode，新草稿同步结果仅属于本轮；地址/token/apiMode改变或关闭/重开/新同步时abort并防迟到返回覆盖。保存网络结果不明不自动重发，提示重新载入核对；重新读取前保留草稿。可复用account-client的有界请求模式或导出request共用（若需修改请先告知主代理避免别的文件冲突）。禁用保存时重复动作，但失败可继续编辑；`AccountGate admin`+服务端requireAccount放Suspense；不把Token写入任何浏览器storage，不回显已存secret，关闭清空新输入。

使用现有happy-dom/ReactDOM node:test验证取消/保存失败/空token保留/新地址要求token/同步未保存与迟到响应/名称映射顺序仍在。tests用真实组件事件，不写源码字符串断言。无需独立浏览器（ego仍受权限/空间限制），准确注明未视觉验收。完成报告，别commit。

主代理已整合验证；当前证据和剩余外部执行状态见 spec-02-model-settings.md。
