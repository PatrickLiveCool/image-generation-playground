"""Activate the isolated app and domain vhost after the Linux build succeeds."""
import pathlib,sys,json,base64
ROOT=pathlib.Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'ops/image-storage'))
from remote import dispatch
private=ROOT/'.local-ops/image-app';report=json.loads((private/'package.json').read_text());release=report['release']
values={}
allowed={'COS_BUCKET','COS_REGION','COS_SECRET_ID','COS_SECRET_KEY','COS_DOMAIN','CDN_AUTH_KEY','ASSET_ACCESS_SECRET'}
for line in (ROOT/'.env.local').read_text().splitlines():
 key,sep,value=line.partition('=')
 if sep and key in allowed:values[key]=value
values.update(NODE_ENV='production',NEXT_TELEMETRY_DISABLED='1',NEXT_PUBLIC_APP_URL='https://image.qintopia.cn',HOSTNAME='127.0.0.1',PORT='4400',APP_RELEASE=release,NODE_OPTIONS='--max-old-space-size=768')
unit='''[Unit]
Description=QinTopia image generation application
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=qintopia-image-app
Group=qintopia-image-app
WorkingDirectory=/opt/qintopia-image-app/current/.next/standalone
EnvironmentFile=/etc/qintopia-image-app/environment
ExecStart=/opt/qintopia-image-runtime/bin/node server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=90
MemoryHigh=768M
MemoryMax=1024M
CPUQuota=200%
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/qintopia-image-app/current/.next/standalone/.next/cache
UMask=0077

[Install]
WantedBy=multi-user.target
'''
nginx='''log_format qintopia_image_no_args '$remote_addr [$time_local] "$request_method $uri" $status $body_bytes_sent';
server {
    listen 80;
    listen [::]:80;
    server_name image.qintopia.cn;
    access_log /var/log/nginx/qintopia-image-access.log qintopia_image_no_args;
    error_log /var/log/nginx/qintopia-image-error.log crit;
    location ^~ /.well-known/acme-challenge/ {
        root /var/lib/qintopia-image-acme;
        default_type text/plain;
    }
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name image.qintopia.cn;
    ssl_certificate /etc/qintopia-image-app/bootstrap/fullchain.pem;
    ssl_certificate_key /etc/qintopia-image-app/bootstrap/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:QINTOPIA_IMAGE_SSL:10m;
    ssl_session_timeout 1d;
    client_max_body_size 24m;
    client_body_buffer_size 24m;
    access_log /var/log/nginx/qintopia-image-access.log qintopia_image_no_args;
    error_log /var/log/nginx/qintopia-image-error.log crit;
    add_header X-Qintopia-App image-playground always;
    add_header Referrer-Policy no-referrer always;
    location / {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_max_temp_file_size 0;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
'''
script='''#!/bin/bash
set -euo pipefail
test -f /opt/qintopia-image-app/releases/RELEASE/build-result.json
getent passwd qintopia-image-app >/dev/null || useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin qintopia-image-app
install -d -o root -g root -m 0700 /etc/qintopia-image-app/bootstrap
install -d -o root -g root -m 0755 /var/lib/qintopia-image-acme
python3 - <<'INSTALL'
import base64,json,os,pathlib,pwd,subprocess
base=pathlib.Path('/opt/qintopia-image-app');target=base/'releases'/RELEASE_LITERAL
assert json.loads((target/'build-result.json').read_text())['status']=='built'
values=json.loads(base64.b64decode('{{tat-hidden:environment}}'))
p=pathlib.Path('/etc/qintopia-image-app/environment')
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as stream:stream.write('\\n'.join(k+'='+json.dumps(v) for k,v in values.items())+'\\n')
os.chmod(p,0o600)
tls=json.loads(base64.b64decode('{{tat-hidden:certificate}}'))
for name,field in [('fullchain.pem','certificate'),('privkey.pem','private_key')]:
 p=pathlib.Path('/etc/qintopia-image-app/bootstrap')/name
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 with os.fdopen(fd,'w') as stream:stream.write(tls[field])
subprocess.run(['openssl','x509','-in','/etc/qintopia-image-app/bootstrap/fullchain.pem','-noout','-checkhost','image.qintopia.cn'],check=True,capture_output=True)
a=subprocess.check_output(['openssl','x509','-in','/etc/qintopia-image-app/bootstrap/fullchain.pem','-pubkey','-noout'])
b=subprocess.check_output(['openssl','pkey','-in','/etc/qintopia-image-app/bootstrap/privkey.pem','-pubout'])
assert a==b,'Certificate key mismatch'
current=base/'current'
if current.exists() or current.is_symlink():
 assert current.is_symlink() and str(current.resolve()).startswith(str(base/'releases')+'/')
 previous=base/'previous'
 if previous.is_symlink():previous.unlink()
 previous.symlink_to(current.resolve())
 current.unlink()
current.symlink_to(target)
cache=target/'.next/standalone/.next/cache';cache.mkdir(parents=True,exist_ok=True)
user=pwd.getpwnam('qintopia-image-app');os.chown(cache,user.pw_uid,user.pw_gid);os.chmod(cache,0o700)
pathlib.Path('/etc/systemd/system/qintopia-image-app.service').write_bytes(base64.b64decode(UNIT_CODE))
p=pathlib.Path('/etc/nginx/sites-available/image.qintopia.cn')
nginx_text=base64.b64decode(NGINX_CODE).decode()
if pathlib.Path('/etc/letsencrypt/live/image.qintopia.cn/fullchain.pem').exists():
 nginx_text=nginx_text.replace('/etc/qintopia-image-app/bootstrap/fullchain.pem','/etc/letsencrypt/live/image.qintopia.cn/fullchain.pem').replace('/etc/qintopia-image-app/bootstrap/privkey.pem','/etc/letsencrypt/live/image.qintopia.cn/privkey.pem')
p.write_text(nginx_text)
link=pathlib.Path('/etc/nginx/sites-enabled/image.qintopia.cn')
if not link.exists():link.symlink_to(p)
print(json.dumps({'release':RELEASE_LITERAL,'bootstrap_certificate_verified':True}))
INSTALL
systemctl daemon-reload
systemctl enable --now qintopia-image-app.service
if ! nginx -t; then
  rm -f /etc/nginx/sites-enabled/image.qintopia.cn
  exit 1
fi
systemctl reload nginx
'''.replace('RELEASE_LITERAL',repr(release)).replace('RELEASE',release).replace('UNIT_CODE',repr(base64.b64encode(unit.encode()).decode())).replace('NGINX_CODE',repr(base64.b64encode(nginx.encode()).decode()))
dispatch('qintopia-image-app-activate',script,{'environment':base64.b64encode(json.dumps(values).encode()).decode(),'certificate':base64.b64encode((private/'bootstrap-tls.json').read_bytes()).decode()},timeout=120)
