"""Retire only the temporary image-only CDN configuration after app cutover."""
import pathlib,sys,json,hashlib
ROOT=pathlib.Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'ops/image-storage'))
import cloud
records=cloud.call('dnspod','DescribeRecordList',{'Domain':'qintopia.cn','Subdomain':'image','Limit':100})['RecordList']
assert len(records)==1 and records[0]['Type']=='A' and records[0]['Value']=='122.51.77.220'
rows=cloud.cdn()
if rows and rows[0]['Status']=='online':cloud.call('cdn','StopCdnDomain',{'Domain':cloud.DOMAIN})
identity=cloud.load('cert-identity.json');assert identity['name']=='qintopia-image-cert'
keys=cloud.call('cam','ListAccessKeys',{'TargetUin':identity['uin']}).get('AccessKeys',[])
assert len(keys)<=1,'Unexpected keys; manual reconciliation required'
for key in keys:cloud.call('cam','DeleteAccessKey',{'TargetUin':identity['uin'],'AccessKeyId':key['AccessKeyId']})
identity['phase']='retired_after_application_cutover';cloud.save('cert-identity.json',identity)
cloud.save('cdn-retirement.json',{'status':'retirement_requested','reason':'image.qintopia.cn now serves application through Nginx; Certbot owns renewal','certificate_identity_keys_revoked':len(keys)})
print(json.dumps({'old_image_cdn_stop_requested':True,'old_certificate_identity_keys_revoked':len(keys),'application_identity_unchanged':True}))
