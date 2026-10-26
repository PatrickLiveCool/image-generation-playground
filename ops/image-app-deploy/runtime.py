"""Copy the existing Node runtime into an app-specific location, then resume build."""
import pathlib,sys,json,datetime
ROOT=pathlib.Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'ops/image-storage'))
from remote import dispatch
private=ROOT/'.local-ops/image-app';report=json.loads((private/'package.json').read_text());release=report['release']
unit='qintopia-image-build-'+report['source_sha256'][:10]+'-runtime'
(private/'build-unit.txt').write_text(unit)
script='''#!/bin/bash
set -euo pipefail
python3 - <<'RUNTIME'
import pathlib,shutil,subprocess,hashlib,json,os
node=pathlib.Path(shutil.which('node')).resolve()
version=subprocess.check_output([str(node),'--version'],text=True).strip()
assert version.startswith('v22.'), 'Unexpected existing Node version'
modules=pathlib.Path(subprocess.check_output(['npm','root','-g'],text=True).strip())
source=modules/'npm'
assert (source/'bin/npm-cli.js').is_file()
target=pathlib.Path('/opt/qintopia-image-runtime')
(target/'bin').mkdir(parents=True,exist_ok=True)
(target/'lib/node_modules').mkdir(parents=True,exist_ok=True)
shutil.copy2(node,target/'bin/node');os.chmod(target/'bin/node',0o755)
shutil.copytree(source,target/'lib/node_modules/npm',symlinks=True,dirs_exist_ok=True)
for name,file in [('npm','npm-cli.js'),('npx','npx-cli.js')]:
 p=target/'bin'/name
 if p.is_symlink() or p.exists():p.unlink()
 p.symlink_to('../lib/node_modules/npm/bin/'+file)
assert hashlib.sha256(node.read_bytes()).digest()==hashlib.sha256((target/'bin/node').read_bytes()).digest()
p=pathlib.Path(RELEASE_DIR)/'build.sh';s=p.read_text()
if 'export PATH=/opt/qintopia-image-runtime/bin:$PATH' not in s:s=s.replace('set -euo pipefail','set -euo pipefail\\nexport PATH=/opt/qintopia-image-runtime/bin:$PATH',1);p.write_text(s)
print(json.dumps({'dedicated_runtime':str(target),'version':version,'binary_sha256':hashlib.sha256(node.read_bytes()).hexdigest()}))
RUNTIME
systemd-run --unit=UNIT --property=WorkingDirectory=RELEASE_DIR_RAW --property=CPUQuota=100% --property=MemoryMax=1536M --property=Nice=15 /bin/bash RELEASE_DIR_RAW/build.sh
'''.replace('RELEASE_DIR_RAW','/opt/qintopia-image-app/releases/'+release).replace('RELEASE_DIR',repr('/opt/qintopia-image-app/releases/'+release)).replace('UNIT',unit)
dispatch('qintopia-image-runtime-build',script,timeout=180)
