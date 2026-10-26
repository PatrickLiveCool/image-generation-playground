> **已停用（2026-10-26）**：域名已切换为应用入口，由服务器 Certbot 自动续签。此处 CDN 专用 timer 已 disabled、专用密钥已撤销。以下为历史方案，当前运维请看 [应用部署](../image-app-deploy/README.md)。

# image.qintopia.cn 证书续期与 CDN 绑定

此目录是图片对象存储域名的独立证书服务。已于2026-10-25完成首次配置、服务器安装和实机读回验证，部署证据见文末及 `identity.json`。程序不依赖个人电脑或 Codex 保持运行，也不改动主站、OPC 或 media 的服务。

## 首次配置是前置条件

本程序维护已有证书绑定，不负责新建 CDN、DNS 或首次无证书域名的完整引导。部署人员需先：

1. 建立 `image.qintopia.cn` 的 CDN 与 DNS CNAME，读取实际 CNAME。`renew.py` 中 `EDGE` 已与实际返回的 `image.qintopia.cn.cdn.dnsv1.com` 核对；恢复或迁移时仍需重新检查，不匹配时程序拒绝继续。
2. 配置私有 COS 回源及 CDN TypeD URL 鉴权：MD5、十进制时间戳、签名参数 `sign`、时间参数 `t`、有效期 900 秒。鉴权密钥与应用的签名配置一致，放入服务器凭据文件的 `CdnAuthKey`。
3. 在对象存储放置 `/image-playground/health/certificate-check.txt` 对应的对象，内容必须严格为 UTF-8 `qintopia-image-storage-ready` 加一个换行。此对象和生成图片一样只保存在对象存储，不落到应用服务器。
4. 申请并签发域名的首张证书，绑定到 CDN；开启 HTTPS 内容服务，确认正常 DNS 下的 TLS、带签名探针字节，以及未签名请求被拒绝。程序不会自动打开 CDN 内容服务或改变鉴权规则。
5. 建立独立 CAM 身份、安装服务器服务，随后执行下述首次检查。不要复用或扩大其他站点的身份权限。

`identity.json` 已记录实际资源编号、服务器及脚本哈希。迁移时应先读回云端状态，不能直接复用旧部署状态。

## 自动续期行为

`qintopia-image-cert.timer` 每小时触发一次，随机延迟最多 60 秒；`Persistent=true` 在服务器恢复后补执行错过的检查。

- 先查当前 CDN 绑定及域名对应的证书。仅采用已签发、可部署、已生效且到期时间更晚的证书。
- 没有可用新证书且有效期剩余不超过 30 天时，调用 `ApplyCertificate`：`PackageType=83`、`ValidityPeriod=3`、`DvAuthMethod=DNS_AUTO`。这是本次首次签发已使用的免费证书申请参数；程序不调用付费购买接口。未过期证书传 `OldCertificateId` 建立续期关系，过期后走新申请恢复路径。
- DNS_AUTO 依赖域名同账号 DNSPod 托管、服务关联角色 `SSL_QCSLinkedRoleInCertificateDependence` 和可用免费证书额度。申请失败会明确记录失败，不自动购买产品。
- 申请前先保存申请意图；响应不明时先查已有订单。发现待签发申请后继续等待，不重复创建。签发后仅修改 `Https.CertInfo.CertId`。
- 通过正常公共 DNS 连接域名，使用系统信任验证证书，检查实际到期时间与目标一致（允许五分钟误差）；然后请求固定私有探针，验证 HTTP 200、目标域名、路径和完整字节。根路径是否返回首页不影响验证。
- 探针签名为 `md5(CdnAuthKey + pathname + decimalTimestamp)`，不跟随重定向。程序不把密钥或带签名访问 URL 写到日志和状态文件。它不下载或保存图片文件。
- 签发超过 48 小时、订单被拒绝/取消、证书不足七天且无已验证替代证书、TLS 或探针验证失败，服务返回非零，写入状态文件与 journal。

成功状态是 `healthy_no_change`、`renewal_pending` 或 `deployed_and_verified`。`renewal_pending` 表示已有申请尚待签发，不等于新证书已部署。定时器运行成功也不能当作一次完整生产续签已经发生；真正续签须留下申请、签发、绑定和 TLS/探针验证的运行证据。

## 独立权限与文件位置

CAM 与系统用户名均为 `qintopia-image-cert`。CAM 禁止控制台登录，仅使用 `policy.json` 中的权限：证书查询、免费证书申请、CDN 配置查询，以及 `image.qintopia.cn` 的证书绑定更新。程序进一步限制 API 动作和请求字段；没有 COS、DNS 写入、计费、证书删除或其他域名的写权限。

| 内容 | 服务器位置 |
|---|---|
| 程序 | `/opt/qintopia-image-cert/renew.py` |
| 凭据 | `/etc/qintopia-image-cert/credentials.json` |
| 状态与锁 | `/var/lib/qintopia-image-cert/` |
| systemd | `qintopia-image-cert.service`、`qintopia-image-cert.timer` |

凭据包含 `SecretId`、`SecretKey` 和 `CdnAuthKey` 三个字段，模式必须为 `0600`，由专用无登录系统用户持有；父目录为 root 所有且运行用户不可写。不得将实际凭据放入 Git、工单、聊天或日志。

代码和 unit 文件由 root 所有。unit 使用 `NoNewPrivileges`、只读系统、home 隔离、私有临时目录等限制，仅状态目录可写。`PrivateTmp` 是运行时隔离，不存放图片。

## 安装与核对

在完成首次云端配置后，用独立服务名安装；先确认是否已经存在相同服务，避免覆盖未核对的部署。

```sh
sudo install -d -o root -g root -m 0755 /opt/qintopia-image-cert
sudo install -o root -g root -m 0644 renew.py /opt/qintopia-image-cert/renew.py
sudo install -o root -g root -m 0644 qintopia-image-cert.service /etc/systemd/system/
sudo install -o root -g root -m 0644 qintopia-image-cert.timer /etc/systemd/system/
```

系统用户、受限 CAM 凭据与状态目录必须先按上面的属主和权限准备。凭据通过受控通道直接落盘，不使用会把其内容打印出来的命令。启用前检查 Python 脚本哈希、unit 内容和配置的域名/CNAME。

```sh
sudo -u qintopia-image-cert /usr/bin/python3 /opt/qintopia-image-cert/renew.py
sudo systemctl daemon-reload
sudo systemctl enable --now qintopia-image-cert.timer
sudo systemctl start qintopia-image-cert.service
sudo systemctl status qintopia-image-cert.timer
sudo systemctl list-timers qintopia-image-cert.timer
sudo cat /var/lib/qintopia-image-cert/status.json
sudo journalctl -u qintopia-image-cert.service -n 50 --no-pager
```

无 `--apply` 的检查不申请证书、不修改 CDN 绑定；它仍读取云端、访问探针并写入本地运维状态。systemd 服务使用 `--apply`。

## 不明确结果与恢复

申请意图位于 `renewal.json`。出现 `Previous application outcome unknown` 时，先查腾讯云证书订单。只有确认没有对应申请后，才由运维人员备份并解除意图，不能直接反复清空文件。CDN 绑定更改前会写入不含密钥的 `before-*.json`；下次执行先读取实际绑定再决策。

暂停服务不影响当前证书：

```sh
sudo systemctl disable --now qintopia-image-cert.timer
```

## 本地验证

测试只用模拟 API、TLS 与 HTTP 响应，不连接云端、不读取实际凭据、不写生产：

```sh
python3 -m unittest discover -s ops/image-cert-sync -p 'test_*.py' -v
```

## 2026-10-25 部署记录

已通过现有腾讯云自动化助手部署到既有秦托邦服务器。`qintopia-image-cert.timer` 为 enabled/active，首次服务执行 `Result=success` / `ExecMainStatus=0`。状态为 `healthy_no_change`、`renewal=not_due`，验证模式 `public_tls_and_signed_private_probe`。

实际绑定证书 `br4TJiPv`，有效至北京时间 **2027-01-23 21:59:59**。CDN CNAME 已确认是 `image.qintopia.cn.cdn.dnsv1.com`。专用 CAM 身份只挂载此目录 policy.json 对应的策略，凭据文件0600；脚本 SHA-256 与本地一致。

30天续期窗口从北京时间 **2026-12-24 21:59:59** 开始。当前没有强制重签有效证书，因此不能把首轮检查与模拟测试表述为已经完成一次到期续签。
