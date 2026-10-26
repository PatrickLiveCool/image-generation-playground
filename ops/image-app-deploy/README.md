# 图像应用生产入口

`image.qintopia.cn` 已于北京时间2026-10-26切换为图像生成应用入口。DNS 是指向既有秦托邦服务器的 A 记录；以前的图片专用 CDN 已停用，不能再用旧 CDN bootstrap 脚本覆盖此记录。

## 当前部署

- Linux standalone 制品：`20261026T031554Z-5b6ede50e6`（ID 时间为 UTC）。
- 源码 SHA-256：`5b6ede50e6dfe081aa89e61b5b6254eb4d9543be2858612c913e34a5a94a1705`。
- 服务：`qintopia-image-app-4401.service`，独立无登录用户，监听 `127.0.0.1:4401`。旧服务已在连接排空后停止并禁用。
- 独立 Node 22.22.1：`/opt/qintopia-image-runtime/bin/node`，未升级全局 Node。
- 代码：`/opt/qintopia-image-app/releases/<release>/`；服务固定到本次 release 路径，`current` 指向当前版本，`previous` 保留 `20261025T160542Z-5ddb380232`。
- 服务配置：`/etc/qintopia-image-app/environment`，0600，systemd 读取后传给独立进程。没有中转 API Token；用户在浏览器填写自己的配置。
- Nginx：`/etc/nginx/sites-available/image.qintopia.cn`。仅新增该站点，不修改其他站点配置。

浏览器的 API 配置/映射和历史按来源隔离。本地 `127.0.0.1` 的配置不会自动迁移到正式域名。

## 图片保持 COS-only

参考图、最终图及过程记录仍在私有 COS `qintopia-image-1305166808`。稳定 `/api/assets/...` 链接验证对象专属 HMAC 后，直接从 COS 读入内存并返回图片字节，不再302跳转到旧 CDN。

Next 图片优化关闭。Nginx 为该站点关闭 `proxy_request_buffering`、`proxy_buffering` 和临时响应文件；上传上限24m，body缓冲24m，接口超时600秒。日志只记录不含查询串的 `$uri`。运行服务限制为1GB内存；构建限制为1.5GB、一个CPU并降低优先级。

源代码、依赖、静态字体和编译制品正常存放在服务器，它们不是用户生成的图片。原 `.generated-images` 为空；不存在图片优化缓存。

## HTTPS 和续签

应用证书由已有 Certbot 维护，独立 lineage：`/etc/letsencrypt/live/image.qintopia.cn/`。`certbot.timer` 已 active；webroot 为 `/var/lib/qintopia-image-acme`；部署 hook `/usr/local/sbin/qintopia-image-cert-deploy` 校验 Nginx 配置并 reload。

真实 HTTP-01 签发及 `certbot renew --cert-name image.qintopia.cn --dry-run --run-deploy-hooks` 已成功。当前线上证书有效至北京时间 **2027-01-23 23:28:13**。此演练不是一次到期续签。

此前仅维护 CDN 绑定的 `qintopia-image-cert.timer` 已 disabled，它的专用腾讯云密钥已撤销；其他站点的证书服务保留。`ops/image-cert-sync/` 仅作历史恢复参考，不应重新启用来维护当前应用域名。

## 部署和检查

本目录脚本是本次部署的可审阅记录：打包不含 `.env`/凭据/本机依赖的源码，在 Linux 上校验 SHA-256 后安装锁定依赖、做 TypeScript/生产构建。`output: standalone` 与单构建worker避免直接复制Mac原生模块。旧 `app/.well-known/workflow` 生成目录已清除。

`prepare.py`/`build_remote.py`/`runtime.py`/`activate.py` 通过固定服务器的腾讯云自动化助手执行，敏感参数使用 TAT 隐藏参数。首次 TLS bootstrap 使用过腾讯 SSL 证书；当前 Nginx 已使用 Certbot lineage，重新激活时会保留该配置。不要直接运行旧 `ops/image-storage/dns.py` 将 A 记录改回 CDN。

```sh
sudo systemctl status qintopia-image-app-4401.service certbot.timer
sudo nginx -t
sudo certbot certificates --cert-name image.qintopia.cn
sudo journalctl -u qintopia-image-app-4401.service -n 30 --no-pager
```

已验证公网首页200、实际浏览器界面、CSS/字体、私有COS图片同域200且哈希一致、错误凭据403、TLS信任链及自动续签演练。没有调用收费模型。

本次版本已包含持续创作和新的使用说明。66 项自动化测试、TypeScript 检查、Linux 生产构建通过。浏览器验证连续修改、旧版续改、切换创作时接收后台结果、失败保留、重命名、参考图恢复、即时刷新草稿恢复和旧历史增量迁移。真实 COS 使用内存合成 PNG 验证 V1→V2、原始提示词、lineage、基准图与公网字节一致；没有调用收费模型，实际模型的编辑保真度尚待用户验收。

## 本次平滑更新

`prepare.py --source-only` 只上传源码，不下载旧证书。`build_remote.py` 记录本次 build unit，并在独立 release 内构建。`update.py stage` 使用现有环境文件启动 4401 的固定 release；`promote` 只替换本站点回源端口，等待 Nginx 新工作进程接管并验证 HTTPS 内容，失败恢复原站点配置。

`drain` 同时检查旧 Nginx worker 身份及 4400 活动连接；都清空才停止旧服务。Next 在 SIGTERM 后可能返回 143，脚本确认 PID、cgroup 均消失后清理该退出状态，再禁用旧服务并原子更新版本链接。旧 release 和本站点配置备份保留。

`update.py` 是这次 4400→4401 更新的记录，不应直接用于覆盖未来的 4401 release；后续更新应先读当前状态，再选择空闲端口与固定 release。DNS、Certbot、COS 凭据和其他站点没有调整。

`node ops/image-storage/probe.cjs` 会创建两轮合成图片并验证真实 COS 与公网只读访问。若 COS 验证已成功、只有公网连接失败，可使用 `--public-only` 重试已有探针图片的读取，避免重复创建对象。探针内置真实模型调用阻断，报告不记录访问凭据。
