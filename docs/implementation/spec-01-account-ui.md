---
title: 阶段1账号页面实施工作包
status: in-progress
context:
  - AGENTS.md
  - docs/implementation/spec-01-accounts.md
  - docs/planning/REVIEW.md
---

实现主规格的中文账号页面与独立AccountGate组件。负责且只编辑 `app/login/page.tsx`、`app/change-password/page.tsx`、`app/admin/page.tsx`、`app/admin/users/page.tsx`、`components/account/`、`lib/account-client.ts`、`lib/account-types.ts`。不要修改现有app/page或layout/image-combiner/hooks（主代理接线），不要改后台API/package/CI，不提交。

复用既有深色主题、按钮/输入/对话框样式，不做全站重新设计，不增加营销内容。公开API契约在主规格。登录成功必须GET session再决定/change-password或/；退出POST后全页跳转，失败不假称已撤销；请求cache:no-store，禁止浏览器缓存用户敏感信息。管理页面用服务端guard(导入`requireAccount`使用`await headers()`)和Suspense适配cacheComponents，普通角色无权限。AccountGate可用客户端session检查包裹主应用，返回只读已登录用户、退出和后台入口；props设计要让主代理可将user.id传到workspace隔离。不调用未定义API；如契约冲突主动报告。

改密成功撤销旧会话，回登录页输入新密码。临时密码只在新增/重置响应中显示、复制，并提示24小时内首次登录后改密；从不保存在storage或列表。创建失败/结果不明提示刷新列表核对，重试不得隐式重置。禁用/重置需明确确认并解释旧会话撤销，最后管理员错误反馈。对当前自己禁用/重置默认不提供危险快捷动作；后端仍保护。表单包含label、autocomplete、错误aria-live、焦点、提交禁用；后台空态、loading和失败可重试。用户名/name可在创建时输入。

可做纯状态/渲染辅助验证，不擅用其他浏览器替代ego lite（它目前门禁受阻），不声称视觉验收。完成报告文件、验证、未完成点。
