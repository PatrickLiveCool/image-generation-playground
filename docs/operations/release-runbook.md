# 图像应用发布与恢复

## 日常流程

1. 合并通过检查的功能 PR。
2. Release Please 创建版本 PR，更新 `package.json`、CHANGELOG 和兼容策略；检查通过后由维护者合并。
3. 合并版本 PR 只准备 tag 和 Draft Release。核对版本说明后，人工 Publish 正式 Release。
4. 发布工作流验证版本、完整 Git SHA、`master` 祖先关系和已发布状态，在 Linux 构建 standalone，并上传可校验的私有 COS 制品。
5. 受限 SSH 入口在备用端口启动固定 release，核对本地及 HTTPS 版本，切换流量后等待旧请求排空。服务器不运行源码构建。

重试发布时，从默认分支运行 Release 工作流并指定已经正式发布的 tag。相同版本只复用经过校验的完整制品；部分上传、哈希变化或未知对象会停止，不覆盖猜测修复。

排查上传时，可从 `master` 手动运行并设置 `upload_only=true`：构建、上传和回读校验成功后停止，不运行部署 job。它仍会写入该版本的发布制品，不能作为只读检查。确认制品验证成功并获准上线后，使用相同 tag、`upload_only=false` 再运行，即复用已存制品完成部署。无需为了重试上传而新建版本或 Publish 新 Release。

上传日志中的 `cos_transfer` 记录对象、阶段、分片号、字节数、耗时、HTTP 状态和异常类别。`upload_part` 的 `failed` 事件来自 SDK 汇总异常之前，可用于区别 403、连接异常和超时；没有完整分片或最终对象时，不能称上传成功。当前使用 2 MiB 分片、2 路并发、最多一次 SDK 重试，上传角色的发送/连接与读取超时均为 60 秒。SDK 只复用逐片校验匹配的未完成上传；相同源码重新构建的制品不保证字节一致，因此不能保证旧分片一定被复用，也不自动删除未知上传任务。

## 生产配置

GitHub `production` Environment 保存下列项目专用 Secrets：

- `UPLOAD_COS_SECRET_ID` / `UPLOAD_COS_SECRET_KEY`：仅发布前缀的读写与禁止覆盖上传。
- `RETENTION_COS_SECRET_ID` / `RETENTION_COS_SECRET_KEY`：仅发布前缀的读取与受控删除。
- `DEPLOY_SSH_KEY`：专用 forced-command SSH 身份。
- `DEPLOY_KNOWN_HOSTS`：通过腾讯云管理通道核验的主机公钥。

Variables 为 `COS_BUCKET`、`COS_REGION`、`DEPLOY_HOST`、`DEPLOY_USER`。`COS_ENDPOINT` 可选，默认使用区域端点。这里不保存用户中转 Token、应用 COS 密钥或 `ASSET_ACCESS_SECRET`。

服务器配置为 `/etc/qintopia-image-release/config.json`，只读 COS 凭据为同目录的 `cos-readonly.json`；目录 0700，凭据 0600，均为 root 所有。工具位于 `/opt/qintopia-image-release/`。应用继续读取原 `/etc/qintopia-image-app/environment`，不因工具安装而替换密钥。

发布制品位于 `qintopia-image/releases/vX.Y.Z/<完整提交>/`，包括 `app.tar.gz`、`manifest.json`、`SHA256SUMS` 和 `sbom.spdx.json`。只有服务器与公网验证成功后才写入 `deployed.json`。用户图片仍在 `image-playground/`，与发布身份和清理范围隔离。

## 首次安装与现有版本

安装前核对当前服务 PID、启动时间、Nginx、应用配置及版本路径，并保留摘要。`deploy/install.sh --dry-run --deploy-public-key <已核验公钥文件>` 通过后再安装；安装器不会启动、重启或切换应用。

写入配置与只读凭据后，由管理员执行：

```sh
sudo /usr/local/sbin/qintopia-image-deploy bootstrap
sudo /usr/local/sbin/qintopia-image-deploy status
sudo systemctl enable --now qintopia-image-release-recovery.timer
```

bootstrap 只收编经过审核的时间戳版本 `20261026T031554Z-5b6ede50e6`，明确标为 legacy，不编造语义版本或 Git 身份。新 `/api/health`、`/api/version` 随首次正式管理版本发布生效；安装工具本身不意味着这些应用端点已经上线。

安装后必须验证真实的 `SSH → forced command → sudo → root wrapper → 隔离 Python` 链、非法命令拒绝、已安装文件哈希，以及应用 PID、启动时间、配置哈希、当前路径和 Certbot 均未改变。

## 未知结果与恢复

发布、回退和清理共用 GitHub 队列及服务器锁。SSH 返回回执后仍持锁，直到客户端完成公网验证、COS 标记或清理，并发送 ACK；不能在客户端仍可能修改 COS 时因固定业务超时释放锁。

连接中断后先运行 `status`，不要直接重发部署。正常发布成功但交付确认未知时，仅允许核实并重试同一身份；不能猜测换用另一个版本。恢复 timer 只处理已经记录的事务，不发起新版本。

旧 Nginx worker 或旧端口还有连接时，旧进程继续运行并保护其 release。日志中的 `healthy-draining` 表示新版可用但旧请求尚未排空，不能称旧版本已清理，也不能强杀来让状态变绿。

## 回退

从默认分支运行 Rollback，指定之前成功的版本；有多个 revision 时必须指定完整提交。工具重新核验成功标记、制品身份及浏览器 workspace / 图片能力链接兼容性，使用同一备用端口、健康检查和排空流程。

不能直接把早期时间戳目录当作正式可回退版本。发布失败时可恢复已记录的原入口；显式回退则只允许验证过的兼容成功版本。禁止轮换 `ASSET_ACCESS_SECRET`，也不删除 COS 图片或浏览器数据。

## 保留清理

Retention 仅手动运行，默认 `dry_run=true`。检查计划后显式选择 apply 才删除；本项目未配置定时删除。

永远保护当前、前一版本、在途事务、仍运行的服务和恢复引用，并保留最近五个成功使用的版本。未成功候选至少保留七天。未知、损坏或 legacy 对象不推测删除；本地和 COS 使用同一保护集合，回退过的版本也必须受到保护。

共享 `_next/static` 只增加、不覆盖，用于仍打开旧版本的标签页；这轮不自动清理其 chunk。它只保存应用 JS、CSS、字体等静态资源，不保存生成图片。

## 验收证据

分别查看 PR CI、不可变制品、服务器工具安装、应用 release 状态、公网 health/version 和人工功能验收。Linux CI 的 standalone smoke 使用合成配置，仅在本机请求健康、版本和静态资源，不连接 COS 或模型，也不上传或发布制品。

当前安装与仓库配置结果保存在本机忽略目录 `.local-ops/release-infra/status.json`。早期 `ops/image-app-deploy/` 脚本只作为恢复记录，不能直接重跑覆盖正式工具管理的状态。
