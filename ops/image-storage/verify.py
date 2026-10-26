"""Read back configured resources and check private authenticated delivery."""
import hashlib,json,socket,ssl,time,urllib.request,urllib.error
from cloud import *

def http(url):
 try:
  with urllib.request.urlopen(urllib.request.Request(url,headers={'Origin':'http://127.0.0.1:3000'}),timeout=30) as r:
   body=r.read();return {'status':r.status,'sha256':hashlib.sha256(body).hexdigest(),'bytes':len(body),'allow_origin':r.headers.get('Access-Control-Allow-Origin')}
 except urllib.error.HTTPError as e:return {'status':e.code}
 except Exception as e:return {'error_type':type(e).__name__}

row=cdn()[0]
print(json.dumps({'cdn_status':row['Status'],'cname':row['Cname'],'private_origin':row['Origin'].get('CosPrivateAccess'),'https':row['Https']['Switch'],'auth':row['Authentication']['Switch'],'cert_id':row['Https']['CertInfo']['CertId']}))
path='/image-playground/health/certificate-check.txt';stamp=str(int(time.time()))
signing=load('signing.json');signature=hashlib.md5((signing['CDN_AUTH_KEY']+path+stamp).encode()).hexdigest()
expected=hashlib.sha256(b'qintopia-image-storage-ready\n').hexdigest()
checks={'unsigned_cdn':http('https://'+DOMAIN+path),'unsigned_cos':http('https://'+ORIGIN+path),'signed_cdn':http('https://'+DOMAIN+path+'?sign='+signature+'&t='+stamp),'expected_sha256':expected}
try:
 with socket.create_connection((DOMAIN,443),timeout=20) as raw_socket:
  with ssl.create_default_context().wrap_socket(raw_socket,server_hostname=DOMAIN) as tls:
   cert=tls.getpeercert();checks['tls']={'notAfter':cert['notAfter'],'subjectAltName':cert.get('subjectAltName')}
except Exception as e:checks['tls']={'error_type':type(e).__name__}
save('delivery-verification.json',checks)
print(json.dumps(checks,ensure_ascii=False))
