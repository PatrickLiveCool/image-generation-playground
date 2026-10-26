"""Run bounded operations on the already-managed QinTopia Lighthouse instance."""
import base64,json,sys
from cloud import *
VERSIONS['tat']='2020-10-28'
INSTANCE='lhins-iztqd1tw'

def dispatch(name,script,parameters=None,timeout=120):
 prior=load(name+'-invocation.json')
 if prior.get('phase')=='requesting':raise RuntimeError('Unresolved prior server operation')
 intent(name+'-invocation.json',name)
 payload={'InstanceIds':[INSTANCE],'CommandName':name,'CommandType':'SHELL','Content':base64.b64encode(script.encode()).decode(),'Timeout':timeout,'SaveCommand':False,'Username':'root'}
 if parameters:payload.update(EnableParameter=True,Parameters=json.dumps(parameters))
 result=call('tat','RunCommand',payload)
 save(name+'-invocation.json',{'phase':'dispatched','invocation_id':result['InvocationId']})
 print(json.dumps({'command':name,'invocation_id':result['InvocationId']}))

def status(name):
 state=load(name+'-invocation.json')
 result=call('tat','DescribeInvocationTasks',{'Filters':[{'Name':'invocation-id','Values':[state['invocation_id']]}],'HideOutput':False})
 for task in result.get('InvocationTaskSet',[]):
  output=base64.b64decode(task.get('TaskResult',{}).get('Output','')).decode(errors='replace')
  print(json.dumps({'status':task.get('TaskStatus'),'exit_code':task.get('TaskResult',{}).get('ExitCode'),'output':output},ensure_ascii=False))

if __name__=='__main__':
 try:
  if sys.argv[1]=='audit':
   script="""#!/bin/bash
set -euo pipefail
python3 - <<'CHECK'
import json,pathlib,subprocess,hashlib
items={}
for name in ['qintopia-cdn-cert','qintopia-media-cert','qintopia-opc-cert']:
 p=pathlib.Path('/opt')/name/('sync.py' if name=='qintopia-cdn-cert' else 'media_cert.py' if name=='qintopia-media-cert' else 'renew.py')
 items[name]={'timer':subprocess.run(['systemctl','is-active',name+'.timer'],capture_output=True,text=True).stdout.strip(),'script_sha256':hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None}
print(json.dumps({'existing_services':items,'image_service_exists':pathlib.Path('/opt/qintopia-image-cert').exists()}))
CHECK
"""
   dispatch('qintopia-image-audit',script)
  else:status(sys.argv[2])
 except Exception as e:
  print(json.dumps({'error_type':type(e).__name__,'code':getattr(e,'code',None),'message':str(e) if isinstance(e,RuntimeError) else None}));sys.exit(1)
