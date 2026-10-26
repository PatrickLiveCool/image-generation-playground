"""Point only image.qintopia.cn at its verified application origin."""
import pathlib,sys,json,os
ROOT=pathlib.Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'ops/image-storage'))
import cloud
p=ROOT/'.local-ops/image-app'
records=cloud.call('dnspod','DescribeRecordList',{'Domain':'qintopia.cn','Subdomain':'image','Limit':100}).get('RecordList',[])
assert len(records)==1 and records[0]['RecordId']==2436857080,'Unexpected DNS record'
record=records[0]
if record['Type']=='A' and record['Value']=='122.51.77.220':print('Application DNS record already active')
else:
 assert record['Type']=='CNAME' and record['Value'].rstrip('.')=='image.qintopia.cn.cdn.dnsv1.com','Refusing to replace unrelated DNS'
 if not (p/'dns-before.json').exists():(p/'dns-before.json').write_text(json.dumps(record,indent=2)+'\n')
 result=cloud.call('dnspod','ModifyRecord',{'Domain':'qintopia.cn','RecordId':record['RecordId'],'SubDomain':'image','RecordType':'A','RecordLine':'默认','Value':'122.51.77.220','TTL':600,'Status':'ENABLE'})
 (p/'dns-cutover.json').write_text(json.dumps({'record_id':record['RecordId'],'type':'A','value':'122.51.77.220','request_id':result.get('RequestId')},indent=2)+'\n')
 print(json.dumps({'domain':'image.qintopia.cn','record_type':'A','application_origin_configured':True}))
