"""Build the exact packaged source on Linux, with bounded shared-server resources."""
import pathlib,sys,json,base64
ROOT=pathlib.Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'ops/image-storage'))
from remote import dispatch
PRIVATE=ROOT/'.local-ops/image-app';report=json.loads((PRIVATE/'package.json').read_text())
release=report['release'];digest=report['archive_sha256'];source_digest=report['source_sha256']
build_unit='qintopia-image-build-'+source_digest[:10]
(PRIVATE/'build-unit.txt').write_text(build_unit+'\n')
build='''#!/bin/bash
set -euo pipefail
export PATH=/opt/qintopia-image-runtime/bin:$PATH
export NEXT_TELEMETRY_DISABLED=1
export NEXT_PUBLIC_APP_URL=https://image.qintopia.cn
export NODE_OPTIONS=--max-old-space-size=1024
export npm_config_cache=/var/cache/qintopia-image-build/npm
export npm_config_registry=https://registry.npmmirror.com
npx --yes pnpm@10.28.2 install --frozen-lockfile --ignore-scripts
npx --yes pnpm@10.28.2 exec tsc --noEmit --incremental false
npx --yes pnpm@10.28.2 run build
cp -a public .next/standalone/public
mkdir -p .next/standalone/.next
cp -a .next/static .next/standalone/.next/static
test ! -f .next/standalone/.env.local
python3 - <<'FINISH'
import json,datetime,pathlib
pathlib.Path('build-result.json').write_text(json.dumps({'release':RELEASE,'source_sha256':SOURCE_SHA,'status':'built','finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat()})+'\\n')
FINISH
'''.replace('RELEASE',repr(release)).replace('SOURCE_SHA',repr(source_digest))
script='''#!/bin/bash
set -euo pipefail
python3 - <<'PREPARE'
import pathlib,urllib.request,hashlib,tarfile,io,base64,os,json
base=pathlib.Path('/opt/qintopia-image-app');root=base/'releases'/RELEASE
root.mkdir(parents=True,exist_ok=True,mode=0o755)
url='{{tat-hidden:source_url}}'
with urllib.request.urlopen(url,timeout=90) as response:data=response.read()
assert hashlib.sha256(data).hexdigest()==ARCHIVE_SHA
with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
 for member in archive.getmembers():
  assert not member.name.startswith('/') and '..' not in pathlib.PurePosixPath(member.name).parts
  assert not member.issym() and not member.islnk()
 archive.extractall(root,filter='data')
p=root/'build.sh';p.write_bytes(base64.b64decode(BUILD_CODE));p.chmod(0o750)
print(json.dumps({'source_verified':True,'release':RELEASE}))
PREPARE
systemd-run --unit=BUILD_UNIT --property=WorkingDirectory=RELEASE_DIR --property=CPUQuota=100% --property=MemoryMax=1536M --property=Nice=15 /bin/bash RELEASE_DIR/build.sh
'''.replace('RELEASE_DIR','/opt/qintopia-image-app/releases/'+release).replace('BUILD_UNIT',build_unit).replace('ARCHIVE_SHA',repr(digest)).replace('BUILD_CODE',repr(base64.b64encode(build.encode()).decode())).replace('RELEASE',repr(release))
dispatch('qintopia-image-app-build',script,{'source_url':(PRIVATE/'source-url.txt').read_text()},timeout=180)
