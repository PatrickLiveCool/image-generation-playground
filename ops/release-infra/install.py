"""Install the reviewed release control plane through TAT without deploying the application."""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]
PRIVATE = ROOT / ".local-ops/release-infra"
FILES = [
    "scripts/release/common.py", "scripts/release/cos.py", "scripts/release/server.py", "scripts/release/requirements.txt",
    "deploy/entry.py", "deploy/ssh-entry.py", "deploy/qintopia-image-deploy", "deploy/qintopia-image-deploy.sudoers",
    "deploy/qintopia-image-release-recovery.service", "deploy/qintopia-image-release-recovery.timer", "deploy/install.sh",
]


def payload():
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    subprocess.run(["git", "diff", "--exit-code", "HEAD", "--", *FILES], cwd=ROOT, check=True, capture_output=True)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name in FILES:
            archive.add(ROOT / name, arcname=name, recursive=False)
    data = buffer.getvalue()
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}
    return data, hashes, revision


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["dry-run", "install"])
    args = parser.parse_args()
    archive, hashes, revision = payload()
    config = json.loads((ROOT / "deploy/server-config.example.json").read_text())
    source = r'''#!/bin/bash
set -euo pipefail
python3 - <<'INSTALL'
import base64,hashlib,io,json,os,pathlib,subprocess,tarfile
mode=MODE
source_revision=REVISION
expected_hashes=HASHES
data=base64.b64decode(ARCHIVE)
assert hashlib.sha256(data).hexdigest()==ARCHIVE_SHA
work=pathlib.Path('/opt/qintopia-image-release-bootstrap')/source_revision
work.mkdir(parents=True,exist_ok=True,mode=0o700)
with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as bundle:
 for member in bundle.getmembers():
  assert member.name in expected_hashes and member.isfile() and not member.issym() and not member.islnk()
  path=work/member.name
  path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  contents=bundle.extractfile(member).read()
  assert hashlib.sha256(contents).hexdigest()==expected_hashes[member.name]
  if path.exists():assert path.read_bytes()==contents
  else:path.write_bytes(contents)
public_key=base64.b64decode('{{tat-hidden:public_key}}')
public_file=work/'deploy.pub'
if public_file.exists():assert public_file.read_bytes()==public_key
else:public_file.write_bytes(public_key)
public_file.chmod(0o600)
def command(argv):
 r=subprocess.run(argv,capture_output=True,text=True,timeout=240)
 if r.returncode:
  # Installer and root entry messages are sanitized and never include configuration values.
  print(json.dumps({'failed_command':argv[0],'exit_code':r.returncode,'diagnostic':(r.stdout+r.stderr)[-1800:]}))
  raise RuntimeError('Control-plane setup stopped; application was not redeployed')
 return r.stdout.strip()
before_paths={'environment':'/etc/qintopia-image-app/environment','nginx':'/etc/nginx/sites-available/image.qintopia.cn','unit':'/etc/systemd/system/qintopia-image-app-4401.service'}
def snapshot():
 return {'hashes':{key:hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() for key,path in before_paths.items()},'service':command(['systemctl','show','qintopia-image-app-4401.service','--property=MainPID,ActiveEnterTimestampMonotonic,ActiveState']),'current':str(pathlib.Path('/opt/qintopia-image-app/current').resolve())}
before=snapshot()
command(['bash',str(work/'deploy/install.sh'),'--dry-run','--deploy-public-key',str(public_file)])
if mode=='dry-run':
 print(json.dumps({'dry_run':'passed','source_revision':source_revision,'application_unchanged':before==snapshot()}))
 raise SystemExit(0)
command(['bash',str(work/'deploy/install.sh'),'--deploy-public-key',str(public_file)])
configuration=CONFIGURATION
credentials=json.loads(base64.b64decode('{{tat-hidden:reader_credentials}}'))
config_dir=pathlib.Path('/etc/qintopia-image-release')
for name,value in [('config.json',configuration),('cos-readonly.json',credentials)]:
 path=config_dir/name
 assert not path.is_symlink()
 if path.exists():assert json.loads(path.read_text())==value,'Existing configuration differs; not replaced'
 else:
  descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(descriptor,'w') as stream:json.dump(value,stream);stream.write('\n')
 path.chmod(0o600)
state=pathlib.Path(configuration['stateDir'])/'state.json'
if not state.exists():command(['/usr/local/sbin/qintopia-image-deploy','bootstrap'])
status=json.loads(command(['/usr/local/sbin/qintopia-image-deploy','status']))
assert status['status']=='healthy' and status['current'].get('legacy') is True
command(['systemctl','enable','--now','qintopia-image-release-recovery.timer'])
targets={
 'scripts/release/common.py':'/opt/qintopia-image-release/lib/common.py',
 'scripts/release/cos.py':'/opt/qintopia-image-release/lib/cos.py',
 'scripts/release/server.py':'/opt/qintopia-image-release/lib/server.py',
 'deploy/entry.py':'/opt/qintopia-image-release/entry.py',
 'deploy/ssh-entry.py':'/usr/local/libexec/qintopia-image-ssh-entry',
 'deploy/qintopia-image-deploy':'/usr/local/sbin/qintopia-image-deploy',
 'deploy/qintopia-image-deploy.sudoers':'/etc/sudoers.d/qintopia-image-deploy',
 'deploy/qintopia-image-release-recovery.service':'/etc/systemd/system/qintopia-image-release-recovery.service',
 'deploy/qintopia-image-release-recovery.timer':'/etc/systemd/system/qintopia-image-release-recovery.timer',
}
for name,destination in targets.items():
 path=pathlib.Path(destination)
 assert path.stat().st_uid==0 and not path.stat().st_mode&0o022
 assert hashlib.sha256(path.read_bytes()).hexdigest()==expected_hashes[name]
assert before==snapshot(),'Application identity or configuration changed during tool installation'
report={'source_revision':source_revision,'installed_files_verified':len(targets),'root_owned':True,'application_unchanged':True,'legacy_adopted':True,'current_release':status['current']['releaseId'],'recovery_timer':command(['systemctl','is-active','qintopia-image-release-recovery.timer']),'certbot_timer':command(['systemctl','is-active','certbot.timer'])}
receipt=pathlib.Path('/var/lib/qintopia-image-release/installation.json')
receipt.write_text(json.dumps({**report,'source_hashes':expected_hashes},indent=2)+'\n');receipt.chmod(0o600)
print(json.dumps(report))
INSTALL
'''
    replacements = {
        "MODE": repr(args.mode), "REVISION": repr(revision), "HASHES": repr(hashes),
        "ARCHIVE_SHA": repr(hashlib.sha256(archive).hexdigest()), "ARCHIVE": repr(base64.b64encode(archive).decode()),
        "CONFIGURATION": repr(config),
    }
    for name in ["ARCHIVE_SHA", "CONFIGURATION", "REVISION", "HASHES", "MODE", "ARCHIVE"]:
        source = source.replace(name, replacements[name])
    assert len(source.encode()) < 60_000, "TAT payload too large"
    (PRIVATE / "installer-source-hashes.json").write_text(json.dumps({"revision": revision, "files": hashes}, indent=2) + "\n")
    sys.path.insert(0, str(ROOT / "ops/image-storage"))
    from remote import dispatch
    dispatch("qintopia-image-release-install-" + args.mode, source, {
        "public_key": base64.b64encode((PRIVATE / "deploy_ed25519.pub").read_bytes()).decode(),
        "reader_credentials": base64.b64encode((PRIVATE / "reader-credentials.json").read_bytes()).decode(),
    }, timeout=600)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error_type": type(error).__name__, "code": getattr(error, "code", None), "message": str(error) if isinstance(error, (RuntimeError, AssertionError)) else "Setup stopped; inspect the saved operation before retrying."}))
        raise SystemExit(1)
