# 仓库协作与检查

继续使用 `PatrickLiveCool/image-generation-playground`，默认分支为 `master`。业务功能与基础设施都通过功能分支和 PR 交付。

PR 标题采用 `feat(scope): 说明` 等 Conventional Commit 格式；正文包含“改动说明、验证结果、风险与回退”。格式检查会拒绝空模板、占位文本和缺失段落，但不能证明正文中的验收结果真实。

需要通过 `PR format` 与 `Node and release checks`。前者在 PR 描述编辑时单独运行；后者只在代码事件或明确请求时执行，包含冻结依赖安装、类型检查、应用测试、发布工具测试、生产构建及 Linux standalone 冒烟测试。PR 检查不使用生产 Secrets，也不连接 COS 或收费模型。

## 当前仓库能力

2026-10-26 实测 GitHub API 对本个人私有仓库的分支保护返回 403，要求 GitHub Pro 或公开仓库。按用户决定保持当前仓库和私有可见性，不升级套餐或迁移。

`.github/default-branch-protection.json` 记录期望的保护规则，并不表示规则已在 GitHub 生效。因此目前必须由维护者遵守 PR 与检查约定；CI 可运行，但不能声称 GitHub 已强制禁止直接推送或绕过失败检查。以后套餐支持时，再核对并应用该配置。

`production` Environment 已建立，不设置额外 reviewer 或等待时间。生产凭据在该环境加密保存，日常批准点是人工 Publish 正式 Release。工作流仍会验证 tag、源码提交和 `master` 祖先关系。

## 版本 PR 的自动检查

Release Please 使用当前仓库临时 `GITHUB_TOKEN`，不复制维护者本机的宽权限 PAT。由于机器人产生的普通事件不会递归触发检查，版本流程明确向固定的 CI 和 PR 格式工作流发送 `workflow_dispatch`。

派发前后均复核同一仓库、`master` 目标、固定版本分支、PR 编号及完整 head SHA；分支变化会使旧请求失败，而非给新提交沿用旧结果。日志中的 `checksRequested` 只代表检查已请求，合并前仍要查看两个检查的实际结果。

本地使用：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm release:check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:pr
corepack pnpm test:release
corepack pnpm build
actionlint
```

运行时按 `.node-version` 固定 Node 22.22.1。其他 Node 版本上的本地通过不能替代 CI 的 Linux / Node 22 验证。
