import json,sys
from cloud import *
try:
 rows=cdn()
 if len(rows)!=1 or rows[0]['Domain']!=DOMAIN:raise RuntimeError('Unexpected CDN domain')
 cname=rows[0]['Cname']
 try:records=call('dnspod','DescribeRecordList',{'Domain':'qintopia.cn','Subdomain':'image','Limit':100}).get('RecordList',[])
 except Exception as e:
  if getattr(e,'code',None)=='ResourceNotFound.NoDataOfRecord':records=[]
  else:raise
 if records:
  if len(records)!=1 or records[0]['Type']!='CNAME' or records[0]['Value'].rstrip('.')!=cname.rstrip('.'):raise RuntimeError('Conflicting DNS record; refusing overwrite')
  record_id=records[0]['RecordId']
 else:
  intent('dns.json','create image CNAME')
  response=call('dnspod','CreateRecord',{'Domain':'qintopia.cn','SubDomain':'image','RecordType':'CNAME','RecordLine':'默认','Value':cname,'TTL':600,'Status':'ENABLE'})
  record_id=response['RecordId']
 save('dns.json',{'phase':'created','domain':DOMAIN,'cname':cname,'record_id':record_id})
 print(json.dumps({'domain':DOMAIN,'cname':cname,'record_id':record_id,'cdn_status':rows[0]['Status']}))
except Exception as e:
 print(json.dumps({'error_type':type(e).__name__,'code':getattr(e,'code',None),'message':str(e) if isinstance(e,RuntimeError) else None}));sys.exit(1)
