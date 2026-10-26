> **当前架构更新（2026-10-26）**：`image.qintopia.cn` 已改为应用入口，DNS A → Nginx → 独立 Next 服务；图片由 `/api/assets` 验证后从私有 COS 内存读取，不再走 CDN 跳转。证书改由 Certbot 维护，原 CDN 及其续签身份已停用。下文是初始图片资源域名方案的历史记录，当前运维见 [应用部署](../image-app-deploy/README.md)。

# 图像对象存储

2026-10-25 已按用户授权建立并实测。当前应用仍在本地运行；本次没有发布应用到生产服务器。

## 已部署资源

- COS：`qintopia-image-1305166808`，`ap-shanghai`，私有桶。
- 图片访问域名：`image.qintopia.cn`，DNS CNAME 指向 `image.qintopia.cn.cdn.dnsv1.com`。
- CDN：全球区域、HTTPS、私有 COS 回源、Type D 时间戳鉴权，签名有效窗口 900 秒。
- 应用专用身份：仅允许本桶 `image-playground/*` 的 `PutObject/GetObject`。
- CDN 服务身份：仅允许参考图、最终图、证书探针的读取，不允许读取 manifest 或列桶。
- 证书身份：仅查询/申请免费证书，并更新 image 域名的证书绑定。
- 所有身份均无控制台登录；各自仅一个当前使用的密钥。实际编号与验证记录在 `infrastructure.json`，不含密钥或访问链接。

## 存储及访问

每次任务使用 `image-playground/runs/<UUID>/`，参考图位于 `inputs/`，最终图位于 `outputs/`，过程状态、对象键、字节数和 SHA-256 位于私有 `manifest.json`。提示词只记录长度及哈希；API Token 不写入 COS。

应用在收费模型调用前必须成功写入过程记录及参考图。存储失败没有本地或 Vercel Blob 回退，也不会重新调用模型。图片只在请求内存中处理。旧本地文件路由和持久化 Workflow 已移除，Next 图片优化关闭，避免 `.next/cache/images` 写盘。

前端历史保存稳定的受限访问链接；应用校验对象专属 HMAC 后重定向到 `image.qintopia.cn` 的短期签名地址。访问链接本身属于持有者凭据，不能公开日志；应用路由设 `no-store/no-referrer`。CDN 已配置 GET/HEAD 的跨域读取，支持下载、复制和重新用作参考图。

不要更换 `ASSET_ACCESS_SECRET` 或 `CDN_AUTH_KEY` 而不规划已有链接/当前 CDN 规则的迁移。应用环境配置保存在本地 `.env.local`（0600）；独立运维凭据在被 Git 忽略的 `.local-ops/`（目录0700、文件0600），不得提交。旧 CLI OAuth 凭据没有复制进应用。

生产部署若增加 Nginx 等代理，应对生成/资产路由关闭请求临时文件和响应磁盘缓存，例如 `proxy_request_buffering off; proxy_buffering off; proxy_max_temp_file_size 0;`，日志使用不含查询串的 `$uri`。当前本地服务没有该代理，因此不能把本次验证说成某个尚未部署的生产代理已经完成配置。

## 实际验证

- 新域名 TLS 信任链、域名和证书有效期通过；CDN 配置已为 `online`。
- 带签名探针 200 且 SHA-256 一致；无签名 CDN、无签名 COS 均 403。
- 应用实际写入一个无商业内容的模拟参考图/最终图/manifest，读回全部字节哈希一致；没有调用真实生图模型。
- 稳定资产路由正常 302 到图片域名；错误访问凭据403；即使使用有效 CDN 签名，manifest 仍403。
- 迁移前 `.generated-images` 为空，无旧图待迁移。当前没有生成图的应用磁盘缓存。
- 31项应用测试、21项证书测试及 TypeScript 检查通过。

## 证书续签

独立服务 `qintopia-image-cert.timer` 已在现有秦托邦云服务器启用，每小时检查，剩余30天时申请免费的 DNS_AUTO 证书并部署到 CDN。首次实机执行 `healthy_no_change`、退出码0。当前证书至北京时间2027-01-23 21:59:59。

此次已完成初始签发、发布、首轮检查及续签失败恢复测试；未来到期续签尚未实际发生。主站、media、OPC的原有证书脚本哈希和运行状态与变更前一致。运维、停用/恢复方法见 [证书服务](../image-cert-sync/README.md)。

## 脚本

`cloud.py` 使用已登录腾讯 CLI 的当前会话；必要时先用 `tccli` 刷新会话。`bootstrap.py`、`identities.py`、`configure_cdn.py`、`dns.py` 是本次受限资源的建置工具；写操作结果不明确时必须先查状态，不清空 intent 强行重试。

`remote.py` 和 `deploy_certificate.py` 通过既有腾讯云自动化助手管理固定服务器，敏感凭据使用 TAT 隐藏参数。`verify.py` 检查 CDN/TLS 与权限。`probe.cjs` 用模拟内存图片写真实 COS，属于小规模存储写操作，需要相应授权；不会调用模型，也不会输出访问签名。
