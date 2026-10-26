"""Upload immutable source and prepare a private bootstrap TLS bundle."""
import sys,json,base64,zipfile,io,os,pathlib,argparse
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-only',action='store_true',help='Upload source without downloading the obsolete bootstrap certificate.')
args=parser.parse_args()
ROOT=pathlib.Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'ops/image-storage'))
import cloud
PRIVATE=ROOT/'.local-ops/image-app'
report=json.loads((PRIVATE/'package.json').read_text());key='image-playground/deployments/'+report['release']+'/source.tar.gz'
with open(report['archive_path'],'rb') as stream:cloud.cos.put_object(Bucket=cloud.BUCKET,Key=key,Body=stream,ContentType='application/gzip',ACL='private')
check=cloud.cos.get_object(Bucket=cloud.BUCKET,Key=key)['Body'].get_raw_stream().read()
import hashlib
assert hashlib.sha256(check).hexdigest()==report['archive_sha256']
app=cloud.load('app-credentials.json')
client=cloud.CosS3Client(cloud.CosConfig(Region=cloud.REGION,SecretId=app['SecretId'],SecretKey=app['SecretKey'],Scheme='https'))
url=client.get_presigned_download_url(Bucket=cloud.BUCKET,Key=key,Expired=1800)
fd=os.open(PRIVATE/'source-url.txt',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as stream:stream.write(url)
if not args.source_only:
 result=cloud.call('ssl','DownloadCertificate',{'CertificateId':'br4TJiPv'})
 archive=zipfile.ZipFile(io.BytesIO(base64.b64decode(result['Content'])))
 nginx=[name for name in archive.namelist() if 'nginx' in name.lower()]
 certs=[name for name in nginx if name.endswith(('.crt','.pem'))]
 keys=[name for name in nginx if name.endswith('.key')]
 assert len(certs)==1 and len(keys)==1,'Unexpected certificate bundle layout'
 value={'certificate':archive.read(certs[0]).decode(),'private_key':archive.read(keys[0]).decode()}
 fd=os.open(PRIVATE/'bootstrap-tls.json',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 with os.fdopen(fd,'w') as stream:json.dump(value,stream)
report['cos_key']=key
(PRIVATE/'package.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'release':report['release'],'source_uploaded_and_sha256_verified':True,'bootstrap_tls_prepared':not args.source_only}))
