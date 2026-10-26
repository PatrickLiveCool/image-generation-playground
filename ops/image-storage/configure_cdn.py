"""Bind the private COS origin to the requested authenticated image domain."""
import json,secrets,sys
from cloud import *

POLICY={'version':'2.0','statement':[{'effect':'allow','principal':{'qcs':['qcs::cam::uin/100017996889:service/cdn']},'action':['name/cos:GetObject','name/cos:HeadObject','name/cos:OptionsObject'],'resource':['qcs::cos:ap-shanghai:uid/1305166808:'+BUCKET+'/image-playground/'+suffix for suffix in ['runs/*/inputs/*','runs/*/outputs/*','health/certificate-check.txt']]}]}

def origin():
 # This bucket was created in this task. Never overwrite a foreign bucket policy.
 if load('bucket.json').get('phase')!='verified':raise RuntimeError('Missing owned private bucket record')
 cos.put_bucket_policy(Bucket=BUCKET,Policy=POLICY)
 save('cdn-origin-policy.json',POLICY)
 print(json.dumps({'cdn_private_origin_granted':True,'scope':BUCKET+'/image-playground/*'}))

def configure():
 rows=cdn()
 if rows:
  print(json.dumps({'existing_domain':rows[0]['Domain'],'status':rows[0]['Status'],'cname':rows[0]['Cname']}));return
 cert_id=load('initial-certificate.json')['certificate_id']
 cert=call('ssl','DescribeCertificate',{'CertificateId':cert_id})
 if cert['Status']!=1:
  print(json.dumps({'certificate_id':cert_id,'status':cert['Status'],'waiting_for_issuance':True}));return
 signing=load('signing.json')
 if not signing:
  signing={'CDN_AUTH_KEY':secrets.token_hex(16),'ASSET_ACCESS_SECRET':secrets.token_hex(32)};save('signing.json',signing)
 headers=[{'HeaderMode':'set','HeaderName':name,'HeaderValue':value,'RuleType':'all','RulePaths':['*']} for name,value in [('Access-Control-Allow-Origin','*'),('Access-Control-Allow-Methods','GET, HEAD, OPTIONS'),('Access-Control-Expose-Headers','Content-Length, ETag'),('Referrer-Policy','no-referrer'),('X-Content-Type-Options','nosniff')]]
 payload={'Domain':DOMAIN,'ServiceType':'web','Area':'global',
  'Origin':{'Origins':[ORIGIN],'OriginType':'cos','ServerName':ORIGIN,'CosPrivateAccess':'on','OriginPullProtocol':'https'},
  'Https':{'Switch':'on','Http2':'on','OcspStapling':'on','CertInfo':{'CertId':cert_id}},
  'HttpsBilling':{'Switch':'on'},
  'ForceRedirect':{'Switch':'on','RedirectType':'https','RedirectStatusCode':301},
  'Authentication':{'Switch':'on','AuthAlgorithm':'md5','TypeD':{'SecretKey':signing['CDN_AUTH_KEY'],'ExpireTime':900,'FileExtensions':['*'],'FilterType':'blacklist','SignParam':'sign','TimeParam':'t','TimeFormat':'dec'}},
  'ResponseHeader':{'Switch':'on','HeaderRules':headers}}
 intent('cdn-created.json','create private authenticated '+DOMAIN)
 response=call('cdn','AddCdnDomain',payload)
 save('cdn-created.json',{'phase':'created','domain':DOMAIN,'certificate_id':cert_id,'request_id':response.get('RequestId')})
 print(json.dumps({'cdn_created':DOMAIN,'certificate_id':cert_id}))

if __name__=='__main__':
 try:{'origin':origin,'cdn':configure}[sys.argv[1]]()
 except Exception as e:
  print(json.dumps({'error_type':type(e).__name__,'code':getattr(e,'code',None),'cos_code':e.get_error_code() if hasattr(e,'get_error_code') else None,'status':e.get_status_code() if hasattr(e,'get_status_code') else None,'message':str(e) if isinstance(e,RuntimeError) else None}));sys.exit(1)
