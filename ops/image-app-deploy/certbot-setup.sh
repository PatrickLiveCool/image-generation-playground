#!/bin/bash
set -euo pipefail
python3 - <<'PREPARE'
import pathlib
hook=pathlib.Path('/usr/local/sbin/qintopia-image-cert-deploy')
hook.write_text('''#!/bin/sh
set -eu
case " ${RENEWED_DOMAINS:-} " in
  *" image.qintopia.cn "*)
    /usr/sbin/nginx -t
    /bin/systemctl reload nginx
    /bin/date -u +%FT%TZ > /var/lib/qintopia-image-acme/last-nginx-reload
    ;;
esac
''')
hook.chmod(0o755)
root=pathlib.Path('/var/lib/qintopia-image-acme/.well-known/acme-challenge')
root.mkdir(parents=True,exist_ok=True)
(root/'image-app-check').write_text('qintopia-image-http01-ready\n')
PREPARE
python3 - <<'DNS_CHECK'
import urllib.request,time
for attempt in range(40):
 try:
  with urllib.request.urlopen('http://image.qintopia.cn/.well-known/acme-challenge/image-app-check',timeout=15) as r:
   if r.read()==b'qintopia-image-http01-ready\n':
    print('Public HTTP-01 path verified',flush=True)
    break
 except Exception:pass
 time.sleep(15)
else:raise SystemExit('Public DNS/HTTP-01 path not ready; bootstrap HTTPS remains valid')
DNS_CHECK
python3 - <<'ISSUE'
import pathlib,re,subprocess
text=pathlib.Path('/etc/letsencrypt/renewal/qintopia.cn.conf').read_text()
account=re.search(r'^account\s*=\s*(\S+)',text,re.M)
command=['certbot','certonly','--webroot','-w','/var/lib/qintopia-image-acme','--cert-name','image.qintopia.cn','-d','image.qintopia.cn','--non-interactive','--agree-tos','--keep-until-expiring','--deploy-hook','/usr/local/sbin/qintopia-image-cert-deploy']
if account:command+=['--account',account.group(1)]
subprocess.run(command,check=True)
ISSUE
python3 - <<'SWITCH'
import pathlib,subprocess
cert='/etc/letsencrypt/live/image.qintopia.cn/fullchain.pem'
subprocess.run(['openssl','x509','-in',cert,'-noout','-checkhost','image.qintopia.cn','-checkend','2592000'],check=True)
p=pathlib.Path('/etc/nginx/sites-available/image.qintopia.cn')
s=p.read_text().replace('/etc/qintopia-image-app/bootstrap/fullchain.pem',cert).replace('/etc/qintopia-image-app/bootstrap/privkey.pem','/etc/letsencrypt/live/image.qintopia.cn/privkey.pem')
p.write_text(s)
pathlib.Path('/var/lib/qintopia-image-acme/last-nginx-reload').unlink(missing_ok=True)
SWITCH
nginx -t
systemctl reload nginx
systemctl enable --now certbot.timer
certbot renew --cert-name image.qintopia.cn --dry-run --run-deploy-hooks --non-interactive
test -s /var/lib/qintopia-image-acme/last-nginx-reload
systemctl disable --now qintopia-image-cert.timer
systemctl stop qintopia-image-cert.service
python3 - <<'VERIFY'
import json,pathlib,ssl,subprocess,datetime
pathlib.Path('/var/lib/qintopia-image-acme/.well-known/acme-challenge/image-app-check').unlink(missing_ok=True)
cert=ssl._ssl._test_decode_cert('/etc/letsencrypt/live/image.qintopia.cn/cert.pem')
record={'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'certificate':{'notAfter':cert['notAfter'],'subjectAltName':cert.get('subjectAltName')},'certbot_timer':subprocess.run(['systemctl','is-active','certbot.timer'],capture_output=True,text=True).stdout.strip(),'old_cdn_timer':subprocess.run(['systemctl','is-enabled','qintopia-image-cert.timer'],capture_output=True,text=True).stdout.strip(),'dry_run_passed':True,'deploy_hook_executed':pathlib.Path('/var/lib/qintopia-image-acme/last-nginx-reload').read_text().strip()}
pathlib.Path('/var/lib/qintopia-image-acme/renewal-verification.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record))
VERIFY
