# 图像生成实验室项目约定

## 工作基线

- 默认分支为 `master`。日常修改使用功能分支和 PR；保留当前工作区及其他任务的改动，不重置已有工作。
- 本项目使用 pnpm 和 `pnpm-lock.yaml`。Node 版本见 `.node-version`；不要混入 npm 锁文件或顺手升级模型、框架和依赖。
- 先读取相关规格与运行证据。基础设施规格见 `docs/implementation/spec-project-infrastructure.md`，操作入口见 `docs/operations/release-runbook.md`。

## 图片与模型

- 所有已提交参考图、过程图、最终图和任务清单只写私有 COS；应用服务器仅以内存处理图片。不得增加本地图片文件、Next 图片优化磁盘缓存或 Nginx 图片临时文件。
- Base URL、Token 和模型映射由用户配置。不要硬编码服务商、Token 或具体模型档位；普通生成界面只显示映射名称。
- 当前展示的成功版本是下一次修改的基准。修改必须提交该原始图片；无效基准必须失败，不能静默退回文生图。
- 创作之间隔离草稿、参考图、版本和在途请求。刷新恢复、失败保留和旧版续改是必要行为。
- 不擅自调用收费模型验收。优先模拟模型和合成图片；明确区分请求正确性与真实模型编辑效果。

## 验证

- 使用 `pnpm release:check`、`pnpm typecheck`、`pnpm test`、`pnpm test:release`、`pnpm build`，按改动风险运行适用检查。工作流修改还需 `actionlint`。
- CI 中的应用测试不依赖云端凭据，不写真实业务数据。生产健康检查不调用模型、不写 COS。
- 本地、GitHub CI、Linux 制品、服务器工具、应用版本、公网和人工验收分别记录，不把某一层成功当作全部完成。

## 交付与权限

- PR 标题使用 Conventional Commit，正文包含“改动说明、验证结果、风险与回退”；规范见 `docs/repository-contributing.md`。
- 版本 PR 合并只准备 Draft Release；人工 Publish 正式 Release 才触发部署。不得自动发布草稿或通过放宽检查绕过失败。
- 正式发布使用 `scripts/release/` 和 root 所有的受限服务器入口。`ops/image-app-deploy/` 保留的是早期部署记录，不能不核对当前状态就重跑一次性脚本。
- 发布制品前缀为 `qintopia-image/releases/`；用户图片前缀为 `image-playground/`。两类凭据与清理范围分离，任何发布清理都不能触碰图片、证书和应用配置。
- 不把凭据、签名图片地址、用户快照、SSH 私钥或 `.local-ops/` 加入 Git。保留 `ASSET_ACCESS_SECRET`，更换会破坏已有图片链接。
- 账号版使用项目专属 PostgreSQL `qintopia_image` / `app`；数据库迁移契约、账号私有访问协议、浏览器 workspace schema 与图片能力链接版本共同约束回退。执行前核对 `deploy/release-policy.json`；跨越账号访问底线后，不得回退到匿名版本。
- 安装工具、合并 PR、Publish Release、切换应用和清理旧版本是不同动作。只有在当前授权覆盖相应动作时执行，并保留明确的恢复证据。
