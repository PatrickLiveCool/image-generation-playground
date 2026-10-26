import sys,pathlib,json
ROOT=pathlib.Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'ops/image-storage'))
from remote import dispatch
p=ROOT/'.local-ops/image-app';r=json.loads((p/'package.json').read_text());unit=(p/'build-unit.txt').read_text().strip()
script="""#!/bin/bash
python3 - <<'CHECK'
import pathlib,json,subprocess
unit=UNIT
path=pathlib.Path(ROOT)/'build-result.json'
status=subprocess.run(['systemctl','show',unit,'--property=ActiveState,SubState,Result,ExecMainStatus'],capture_output=True,text=True).stdout
logs=subprocess.run(['journalctl','-u',unit,'-n','15','--no-pager'],capture_output=True,text=True).stdout
print(json.dumps({'unit':status,'build_result':json.loads(path.read_text()) if path.exists() else None,'logs':logs}))
CHECK
""".replace('UNIT',repr(unit)).replace('ROOT',repr('/opt/qintopia-image-app/releases/'+r['release']))
dispatch('qintopia-image-build-status',script)
