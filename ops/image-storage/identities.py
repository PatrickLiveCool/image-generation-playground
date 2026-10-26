"""Provision distinct, minimally scoped application and certificate identities."""
import json,secrets,sys
from cloud import *

APP_POLICY={'version':'2.0','statement':[{'effect':'allow','action':['name/cos:GetObject','name/cos:PutObject'],'resource':['qcs::cos:ap-shanghai:uid/1305166808:'+BUCKET+'/image-playground/*']}]}
CERT_POLICY=json.loads((ROOT/'ops/image-cert-sync/policy.json').read_text())

def create(kind):
 name='qintopia-image-'+('app' if kind=='app' else 'cert')
 state=load(kind+'-identity.json')
 if not state.get('uin'):
  try:
   user=call('cam','GetUser',{'Name':name})
   raise RuntimeError('Identity name already exists; reconcile before attaching policy')
  except Exception as e:
   if getattr(e,'code',None) not in ['ResourceNotFound.UserNotExist','InvalidParameter.UserNotExist','ResourceNotFound.UserNotExists']:
    raise
  intent(kind+'-identity.json','create '+name)
  user=call('cam','AddUser',{'Name':name,'ConsoleLogin':0,'UseApi':0,'Remark':'Image playground '+kind+' dedicated identity'})
  state={'phase':'user_created','name':name,'uin':user['Uin']};save(kind+'-identity.json',state)
 if not state.get('policy_id'):
  policy=APP_POLICY if kind=='app' else CERT_POLICY
  result=call('cam','CreatePolicy',{'PolicyName':name+'-restricted','PolicyDocument':json.dumps(policy),'Description':'Restricted image.qintopia.cn '+kind+' access'})
  state['policy_id']=result['PolicyId'];save(kind+'-identity.json',state)
 call('cam','AttachUserPolicy',{'PolicyId':state['policy_id'],'AttachUin':state['uin']})
 credential_file=kind+'-credentials.json'
 if not load(credential_file):
  intent(kind+'-key-intent.json','create scoped key for '+name)
  result=call('cam','CreateAccessKey',{'TargetUin':state['uin'],'Description':'image.qintopia.cn.'+kind})
  key=result['AccessKey']
  save(credential_file,{'SecretId':key['AccessKeyId'],'SecretKey':key['SecretAccessKey']})
  save(kind+'-key-intent.json',{'phase':'saved'})
 state['phase']='ready';save(kind+'-identity.json',state)
 print(json.dumps({'identity':name,'uin':state['uin'],'policy_id':state['policy_id'],'credentials_saved':True}))

if __name__=='__main__':
 try:
  create(sys.argv[1])
 except Exception as e:
  print(json.dumps({'error_type':type(e).__name__,'code':getattr(e,'code',None),'message':str(e) if isinstance(e,RuntimeError) else None}));sys.exit(1)
