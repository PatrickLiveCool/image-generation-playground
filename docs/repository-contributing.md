# 仓库协作与检查

继续使用 `PatrickLiveCool/image-generation-playground`，默认分支为 `master`。业务功能与基础设施都通过功能分支和 PR 交付。

PR 标题采用 `feat(scope): 说明` 等 Conventional Commit 格式；正文包含“改动说明、验证结果、风险与回退”。格式检查会拒绝空模板、占位文本和缺失段落，但不能证明正文中的验收结果真实。

需要通过独立的 `PR format` 与 `Node and release checks`。PR 创建、编辑、提交更新、重新打开或转为可评审时都会运行完整代码检查，包含冻结依赖安装、类型检查、应用测试、发布工具测试、生产构建及 Linux standalone 冒烟测试。仅标题/正文等元数据变化的编辑使用独立并发队列，避免取消正在运行的代码检查；修改目标分支的编辑继续使用代码检查队列。PR 检查不使用生产 Secrets，也不连接 COS 或收费模型。

分阶段开发可将后续 PR 的目标设为前一阶段的 `codex/**` 功能分支，使评审只展示本阶段增量。目标为 `master` 或 `codex/**` 的 PR 使用相同的只读 CI 与格式检查，CI 还会验证 BMad runtime 来源哈希及离线行为；push 事件仅覆盖 `master`，功能分支通过 PR 事件触发检查。前一阶段或目标基线更新后，应同步依赖分支并针对新的基线重跑检查，不能沿用旧基线的通过结果。提交和创建 PR 不代表获得合并或发布授权，这两个动作仍由用户决定。

## 当前仓库能力

2026-10-26 实测 GitHub API 对本个人私有仓库的分支保护返回 403，要求 GitHub Pro 或公开仓库。按用户决定保持当前仓库和私有可见性，不升级套餐或迁移。

`.github/master-protection.json` 记录期望的保护规则，并不表示规则已在 GitHub 生效。因此目前必须由维护者遵守 PR 与检查约定；CI 可运行，但不能声称 GitHub 已强制禁止直接推送或绕过失败检查。以后套餐支持时，再核对并应用该配置。

`production` Environment 已建立，不设置额外 reviewer 或等待时间。生产凭据在该环境加密保存，日常批准点是人工 Publish 正式 Release。工作流仍会验证 tag、源码提交和 `master` 祖先关系。

## 版本 PR 的自动检查

当前 Release Please 工作流读取 `RELEASE_PLEASE_TOKEN`，只在 master 上准备版本 PR 和 Draft Release。PR 检查由 opened/synchronize/reopened 等 PR 事件触发；CI 不使用生产 Secrets，也没有手工派发任意 PR 源码的入口。

合并前核对同一仓库、目标分支、PR 编号与完整 head SHA，并确认 `PR format`、`Node and release checks` 对该次提交的实际结果。创建 PR 或旧提交检查成功不代表最新提交已通过。

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
