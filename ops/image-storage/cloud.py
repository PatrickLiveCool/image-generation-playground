"""Operator helper; uses the current Tencent CLI session without printing credentials."""
import json, os, pathlib, time, subprocess
from tencentcloud.common import credential
from tencentcloud.common.common_client import CommonClient
from qcloud_cos import CosConfig, CosS3Client
ROOT=pathlib.Path(__file__).resolve().parents[2]
PRIVATE=ROOT/'.local-ops/image-storage'
PRIVATE.mkdir(parents=True,exist_ok=True,mode=0o700)
BUCKET='qintopia-image-1305166808'
REGION='ap-shanghai'
DOMAIN='image.qintopia.cn'
ORIGIN=BUCKET+'.cos.'+REGION+'.myqcloud.com'
VERSIONS={'cdn':'2018-06-06','dnspod':'2021-03-23','ssl':'2019-12-05','cam':'2019-01-16'}
credential_path=pathlib.Path.home()/'.tccli/default.credential'
raw=json.loads(credential_path.read_text())
if raw.get('type')=='oauth' and int(raw.get('expiresAt') or 0) < time.time()+120:
 refreshed=subprocess.run(['tccli','ssl','DescribeCertificates','--Limit','1','--output','json'],capture_output=True,text=True)
 if refreshed.returncode:raise RuntimeError('Tencent CLI session refresh failed; login required')
 raw=json.loads(credential_path.read_text())
cred=credential.Credential(raw['secretId'],raw['secretKey'],raw.get('token') or None)
cos=CosS3Client(CosConfig(Region=REGION,SecretId=raw['secretId'],SecretKey=raw['secretKey'],Token=raw.get('token') or None,Scheme='https',Timeout=(10,45)))
def call(service,action,params):
 return CommonClient(service,VERSIONS[service],cred,REGION).call_json(action,params)['Response']
def save(name,value):
 p=PRIVATE/name; tmp=p.with_suffix('.tmp')
 fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 with os.fdopen(fd,'w') as f:json.dump(value,f,indent=2);f.write('\n')
 os.replace(tmp,p)
def load(name):
 p=PRIVATE/name
 return json.loads(p.read_text()) if p.exists() else {}
def intent(name,operation):
 if load(name).get('phase')=='requesting':raise RuntimeError('Prior operation outcome unresolved: '+name)
 save(name,{'phase':'requesting','operation':operation,'time':time.time()})
def certificates():
 return [r for r in call('ssl','DescribeCertificates',{'SearchKey':DOMAIN,'Limit':100}).get('Certificates',[]) if r.get('Domain')==DOMAIN]
def cdn():
 return call('cdn','DescribeDomainsConfig',{'Filters':[{'Name':'domain','Value':[DOMAIN],'Fuzzy':False}]}).get('Domains',[])
