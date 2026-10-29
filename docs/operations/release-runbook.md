# 图像应用发布与恢复

## 日常流程

1. 合并通过检查的功能 PR。
2. Release Please 创建版本 PR，更新 `package.json`、CHANGELOG 和兼容策略；检查通过后由维护者合并。
3. 合并版本 PR 只准备 tag 和 Draft Release。核对版本说明后，人工 Publish 正式 Release。
4. 发布工作流验证版本、完整 Git SHA、`master` 祖先关系和已发布状态，在 Linux 构建 standalone，并上传可校验的私有 COS 制品。
5. 受限 SSH 入口校验账号制品的固定维护包和数据库身份，执行审核迁移并只读核对，再在备用端口启动固定 release，核对本地及 HTTPS 版本，切换流量后等待旧请求排空。服务器不运行源码构建。

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

`COS_UPLOAD_ENDPOINT` 可单独设为 `cos.accelerate.myqcloud.com`，只影响发布上传及其字节回读。列举对象和查询桶版本状态仍使用区域端点；服务器读取、清理和用户图片链路不使用该变量。启用前须获得全球加速流量费用授权并为桶开启该功能；不应把所有请求共用的 `COS_ENDPOINT` 直接改成加速域名。清空 `COS_UPLOAD_ENDPOINT` 可恢复区域传输路径。

服务器配置为 `/etc/qintopia-image-release/config.json`，只读 COS 凭据为同目录的 `cos-readonly.json`；目录 0700，凭据 0600，均为 root 所有。工具位于 `/opt/qintopia-image-release/`。应用继续读取原 `/etc/qintopia-image-app/environment`，不因工具安装而替换密钥。

发布制品位于 `qintopia-image/releases/vX.Y.Z/<完整提交>/`，包括 `app.tar.gz`、`manifest.json`、`SHA256SUMS` 和 `sbom.spdx.json`。只有服务器与公网验证成功后才写入 `deployed.json`。用户图片仍在 `image-playground/`，与发布身份和清理范围隔离。

账号版使用 schema=2 的发布身份，携带 `databaseMode=postgresql`、`assetAccessProtocol=account-private-v1` 和审核迁移清单。归档包括 `maintenance/cli.mjs` 与固定SQL目录；完整归档摘要同时保护应用和维护代码。只读健康端点不连接数据库；独立维护预检才证明数据库身份、权限、账本、物理表/列及必要秘密匹配。

应用环境需配置 `IMAGE_DATABASE_TARGET=production`、本项目运行身份的 `IMAGE_DATABASE_URL`、`BETTER_AUTH_URL=https://image.qintopia.cn`、`BETTER_AUTH_SECRET`、32字节base64的 `PROVIDER_CONFIG_KEY`，并保留原 `ASSET_ACCESS_SECRET` 和私有COS配置。`config.json` 新增 `migrationEnvironmentFile`、`recoveryEnvironmentFile`、`maintenanceUser=qintopia-image-maintenance`，准确结构见 `deploy/server-config.example.json`。两个独立root所有、0600文件分别只含 `IMAGE_MIGRATION_DATABASE_URL` 和独立32字节base64的 `IMAGE_RECOVERY_KEY`；不得将迁移或恢复密钥写进应用环境、GitHub发布环境或日志。

运行/迁移身份均固定到 `qintopia_image` / `app`，实际目标与最小权限由维护程序核验。维护进程以不可登录的专用OS用户运行，root只传递固定环境和必要文件描述符；不继承NODE_OPTIONS、PG*等注入参数。应用双进程连接池4+4，维护串行最多1连接，预算合计9。数据库创建、角色/ACL配置与生产维护是独立操作，不由发布程序自动建立或修改。

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

## 首位管理员初始化

账号版制品已受信安装且数据库verify通过后，管理员可将仅含 `username`、`name`、`password` 的JSON放到固定 `stateDir/bootstrap-admin.json`，root所有、0600、普通单链接文件，最多16KiB。使用安全文件编辑或秘密注入准备密码，避免进入命令行历史、Git或普通日志。执行 `sudo /usr/local/sbin/qintopia-image-deploy database-bootstrap-admin`；这与收编旧版本的 `bootstrap` 是两个独立命令。

入口复用应用的用户名/姓名/密码校验、成熟密码哈希、管理员事务锁及审计；已有管理员时拒绝覆盖。初始化进程仅收到本项目运行数据库凭据，最多1连接，不接收迁移、恢复或应用主密钥。回执仅包含安全状态与账号ID。发生中断时，保留同一私有输入，先执行 `sudo /usr/local/sbin/qintopia-image-deploy database-verify-bootstrap-admin`，只读核对管理员、凭据与初始化审计，不能直接重发初始化。若核对确认完全没有管理员，记录为not-initialized后，才可明确再次执行初始化；不会自动重放。成功后用该账号登录，再通过后台直接开通普通用户。

## 已安装工具的审核升级

已有工具内容不同，`install.sh` 会拒绝覆盖。将已审阅源码保存在root所有、父目录不可被其他身份写入的位置，先用该源码中的 `python3 -I deploy/upgrade.py plan` 生成固定9文件的old/new SHA-256清单。把核对过的清单保存成root所有0600文件，再执行 `python3 -I deploy/upgrade.py apply --expected <审核清单绝对路径>`。清单或实际文件发生变化即拒绝；升级与发布共用 `release.lock`。

升级保留 `/var/lib/qintopia-image-release/tool-upgrades/<事务ID>/` 的旧/新副本和逐步回执，逐文件原子替换并验证导入与systemd配置。已知失败会恢复旧文件；中断后先查保留记录，再使用同一受信源码的 `python3 -I deploy/upgrade.py recover`。当前文件只允许匹配已记录旧/新摘要，外部修改会停止恢复。已有账号访问底线时，不得恢复不识别该底线的旧工具。升级不发布应用，不切换Nginx，不改变数据库或现有应用秘密。

## 未知结果与恢复

发布、回退和清理共用 GitHub 队列及服务器锁。SSH 返回回执后仍持锁，直到客户端完成公网验证、COS 标记或清理，并发送 ACK；不能在客户端仍可能修改 COS 时因固定业务超时释放锁。

连接中断后先运行 `status`，不要直接重发部署。正常发布成功但交付确认未知时，仅允许核实并重试同一身份；不能猜测换用另一个版本。恢复 timer 只处理已经记录的事务，不发起新版本。

账号版迁移回执不明时，恢复只读取账本与物理schema，确认达到同一制品契约后才能继续；不会自动重放DDL。`sudo /usr/local/sbin/qintopia-image-deploy database-status` 是固定只读数据库核对入口。进入账号版迁移或激活前，持久记录 `access-floor.json`；首次账号版失败且无兼容成功版本时返回真实503维护响应，不能重新开放旧匿名应用。维护响应保留TLS与ACME路径。

旧 Nginx worker 或旧端口还有连接时，旧进程继续运行并保护其 release。日志中的 `healthy-draining` 表示新版可用但旧请求尚未排空，不能称旧版本已清理，也不能强杀来让状态变绿。

## 回退

从默认分支运行 Rollback，指定之前成功的版本；有多个 revision 时必须指定完整提交。工具重新核验成功标记、制品身份、账号访问协议、数据库迁移版本/摘要及浏览器 workspace / 图片能力链接兼容性，使用同一备用端口、健康检查和排空流程。

不能直接把早期时间戳目录当作正式可回退版本。访问底线建立后，失败恢复和显式回退均只允许验证过的兼容账号版本；数据库或访问协议不兼容时保持维护状态。禁止轮换 `ASSET_ACCESS_SECRET`，也不删除 COS 图片或浏览器数据。

## 单项目备份与恢复

以下命令仅供已获生产维护授权的管理员在服务器执行，部署SSH账号不可调用。源码测试和本地演练通过不表示服务器已经安装新版工具。

`sudo /usr/local/sbin/qintopia-image-deploy database-backup` 将本项目固定9张业务表、审核迁移/发布身份、私有COS引用和3个必要应用秘密认证加密，写到 `stateDir/database-backups/<ID>.enc`；旁边JSON回执记录摘要和完成状态。目录0700、文件0600，独立恢复密钥须另行保护。图片本体留在原私有COS；COS桶、区域及私有前缀均绑定到归档，备份不包含会话、图片二进制、其他应用或可执行SQL。未确认完成的文件只作为证据保留。

恢复前核对归档、独立恢复密钥、同一私有COS目标及已审核数据库身份。目标须已具备同一审核schema且业务表为空；程序不清空目标、不创建角色、不改变ACL或共享实例。将归档放到固定root所有0600的 `stateDir/database-restore.enc` 后执行：

```sh
sudo /usr/local/sbin/qintopia-image-deploy service-maintenance
sudo /usr/local/sbin/qintopia-image-deploy database-restore
```

`service-maintenance` 建立真实503，等待既有连接排空后停止本项目已管理进程；如果尚未排空，保留维护状态并在后续核对。恢复入口再次确认隔离，认证和结构验证在任何数据写入前完成，固定表/列在单事务内按有界批次恢复。中途失败回滚；提交回执不明时，先执行 `sudo /usr/local/sbin/qintopia-image-deploy database-verify-restore` 核对同一归档，禁止清空目标或自动重放。只读核对仅区分完整恢复、所有业务表为空的not-restored、非空但不匹配三种结果；只有not-restored才允许下一次明确恢复操作，其他不匹配继续保持未确认。

恢复秘密通过受保护FD写入 `stateDir/database-secrets-<当前恢复事务ID>.json`，不会出现在命令参数或状态输出。每次新恢复先保留前次 `database-recovery-attempt-<ID>.json` 和秘密文件，不覆盖旧证据。核对完成后仍保持维护响应；管理员须另行审核并安全安装当前恢复事务的3个秘密到原应用环境，其他配置保持原值。发布入口会逐值确认当前恢复秘密已安装，再允许使用受信制品恢复服务。旧会话不恢复；临时凭证失效，在途生成变为结果未知，不重发模型请求。重新登录后核验账号隔离、创作/旧版本、原图与文档可读、provider配置解密和禁用账号撤销访问。

## 保留清理

Retention 仅手动运行，默认 `dry_run=true`。检查计划后显式选择 apply 才删除；本项目未配置定时删除。

永远保护当前、前一版本、在途事务、仍运行的服务和恢复引用，并保留最近五个成功使用的版本。未成功候选至少保留七天。未知、损坏或 legacy 对象不推测删除；本地和 COS 使用同一保护集合，回退过的版本也必须受到保护。

共享 `_next/static` 只增加、不覆盖，用于仍打开旧版本的标签页；这轮不自动清理其 chunk。它只保存应用 JS、CSS、字体等静态资源，不保存生成图片。

## 验收证据

分别查看 PR CI、不可变制品、服务器工具安装、应用 release 状态、公网 health/version 和人工功能验收。Linux CI 的 standalone smoke 使用合成配置，在本机请求健康、版本和静态资源，并在显式启用时用专用PG夹具执行制品维护CLI的preflight/verify、首次管理员和备份恢复FD链；不连接COS或模型，不上传或发布制品。CI在当前非root用户下运行，专用维护UID和root wrapper真实服务器链路仍需单独核验。账号版源码及本地恢复演练记录见 `docs/implementation/spec-04-account-release-recovery.md`，生产工具升级、迁移、应用发布及真实模型效果分别验收。

当前安装与仓库配置结果保存在本机忽略目录 `.local-ops/release-infra/status.json`。早期 `ops/image-app-deploy/` 脚本只作为恢复记录，不能直接重跑覆盖正式工具管理的状态。
