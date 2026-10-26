"""Create only the image storage resources explicitly requested by the user."""
import json,sys
from cloud import *

def bucket():
 existing=[r['Name'] for r in cos.list_buckets().get('Buckets',{}).get('Bucket',[])]
 if BUCKET not in existing:
  intent('bucket.json','create private '+BUCKET)
  cos.create_bucket(Bucket=BUCKET,ACL='private')
 acl=cos.get_bucket_acl(Bucket=BUCKET)
 grants=acl.get('AccessControlList',{}).get('Grant',[])
 if isinstance(grants,dict):grants=[grants]
 if any('AllUsers' in json.dumps(g) or 'AllAuthenticatedUsers' in json.dumps(g) for g in grants):raise RuntimeError('Bucket is not private')
 cos.put_object(Bucket=BUCKET,Key='image-playground/health/certificate-check.txt',Body=b'qintopia-image-storage-ready\n',ContentType='text/plain',CacheControl='no-store')
 save('bucket.json',{'phase':'verified','bucket':BUCKET,'region':REGION,'acl':acl})
 print(json.dumps({'bucket':BUCKET,'region':REGION,'private':True,'health_object_written':True}))

def certificate():
 rows=certificates()
 if rows:
  print(json.dumps({'existing_certificates':[{'id':c['CertificateId'],'status':c['Status']} for c in rows]}));return
 intent('initial-certificate.json','apply free DNS_AUTO certificate '+DOMAIN)
 result=call('ssl','ApplyCertificate',{'DomainName':DOMAIN,'DvAuthMethod':'DNS_AUTO','PackageType':'83','ValidityPeriod':'3','Alias':'qintopia-image-auto-renew','DeleteDnsAutoRecord':False})
 save('initial-certificate.json',{'phase':'requested','certificate_id':result['CertificateId']})
 print(json.dumps({'certificate_requested':result['CertificateId'],'domain':DOMAIN}))

if __name__=='__main__':
 try:
  {'bucket':bucket,'certificate':certificate}[sys.argv[1]]()
 except Exception as e:
  print(json.dumps({'error_type':type(e).__name__,'code':getattr(e,'code',None),'message':str(e) if isinstance(e,RuntimeError) else None}));sys.exit(1)
