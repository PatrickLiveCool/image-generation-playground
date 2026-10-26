"""Deploy the tested certificate service via TAT hidden parameters."""
import base64,hashlib,json,sys
from cloud import *
from remote import dispatch

try:
 dns=load('dns.json')
 if dns.get('cname')!='image.qintopia.cn.cdn.dnsv1.com':raise RuntimeError('Review certificate EDGE before deployment')
 files={}
 for local,target in [('renew.py','/opt/qintopia-image-cert/renew.py'),('qintopia-image-cert.service','/etc/systemd/system/qintopia-image-cert.service'),('qintopia-image-cert.timer','/etc/systemd/system/qintopia-image-cert.timer')]:
  files[target]=base64.b64encode((ROOT/'ops/image-cert-sync'/local).read_bytes()).decode()
 bundle=base64.b64encode(json.dumps(files).encode()).decode()
 script='''#!/bin/bash
set -euo pipefail
getent passwd qintopia-image-cert >/dev/null || useradd --system --user-group --home-dir /var/lib/qintopia-image-cert --shell /usr/sbin/nologin qintopia-image-cert
install -d -o root -g root -m 0755 /opt/qintopia-image-cert
install -d -o root -g qintopia-image-cert -m 0750 /etc/qintopia-image-cert
install -d -o qintopia-image-cert -g qintopia-image-cert -m 0700 /var/lib/qintopia-image-cert
python3 - <<'INSTALL'
import base64,json,os,pathlib,pwd
files=json.loads(base64.b64decode('''+repr(bundle)+'''))
for name,content in files.items():
 p=pathlib.Path(name);p.write_bytes(base64.b64decode(content));os.chown(p,0,0);os.chmod(p,0o644)
credentials=base64.b64decode('{{tat-hidden:credentials}}')
parsed=json.loads(credentials)
assert set(parsed)=={'SecretId','SecretKey','CdnAuthKey'}
p=pathlib.Path('/etc/qintopia-image-cert/credentials.json')
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'wb') as stream:stream.write(credentials)
user=pwd.getpwnam('qintopia-image-cert');os.chown(p,user.pw_uid,user.pw_gid);os.chmod(p,0o600)
INSTALL
systemctl daemon-reload
systemctl enable --now qintopia-image-cert.timer
systemctl start --no-block qintopia-image-cert.service
python3 - <<'VERIFY'
import json,pathlib,hashlib,subprocess,stat
p=pathlib.Path('/etc/qintopia-image-cert/credentials.json')
print(json.dumps({'installed':True,'credentials_mode':oct(stat.S_IMODE(p.stat().st_mode)),'script_sha256':hashlib.sha256(pathlib.Path('/opt/qintopia-image-cert/renew.py').read_bytes()).hexdigest(),'timer_enabled':subprocess.run(['systemctl','is-enabled','qintopia-image-cert.timer'],capture_output=True,text=True).stdout.strip(),'timer_active':subprocess.run(['systemctl','is-active','qintopia-image-cert.timer'],capture_output=True,text=True).stdout.strip()}))
VERIFY
'''
 secret=base64.b64encode((PRIVATE/'cert-credentials.json').read_bytes()).decode()
 dispatch('qintopia-image-cert-install',script,{'credentials':secret},timeout=120)
except Exception as e:
 print(json.dumps({'error_type':type(e).__name__,'code':getattr(e,'code',None),'message':str(e) if isinstance(e,RuntimeError) else None}));sys.exit(1)
