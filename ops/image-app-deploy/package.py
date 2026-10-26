"""Package current application source, excluding secrets and generated artifacts."""
import hashlib,json,pathlib,tarfile,datetime,os
ROOT=pathlib.Path(__file__).resolve().parents[2]
PRIVATE=ROOT/'.local-ops/image-app';PRIVATE.mkdir(mode=0o700,parents=True,exist_ok=True)
paths=[]
for name in ['app','components','hooks','lib','public','styles']:
 base=ROOT/name
 if base.exists():
  paths.extend(p for p in base.rglob('*') if p.is_file() and '.well-known/workflow' not in p.as_posix() and '__pycache__' not in p.parts)
for name in ['package.json','pnpm-lock.yaml','.npmrc','next.config.mjs','postcss.config.mjs','tailwind.config.ts','tsconfig.json','components.json']:
 if (ROOT/name).exists():paths.append(ROOT/name)
manifest={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}
digest=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()
release=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+digest[:10]
target=PRIVATE/(release+'.tar.gz')
with tarfile.open(target,'w:gz') as archive:
 for p in sorted(paths):archive.add(p,arcname=p.relative_to(ROOT),recursive=False)
report={'release':release,'source_sha256':digest,'archive_sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'archive_path':str(target),'file_count':len(paths),'bytes':target.stat().st_size}
(PRIVATE/'package.json').write_text(json.dumps(report,indent=2)+'\n');os.chmod(PRIVATE/'package.json',0o600)
print(json.dumps({k:v for k,v in report.items() if k!='archive_path'}))
