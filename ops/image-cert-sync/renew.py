#!/usr/bin/env python3
"""Renew free image-domain certificates and deploy only their CDN certificate binding."""
import argparse
import datetime as dt
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import socket
import ssl
import sys
import time
import urllib.request
from urllib.parse import urlencode, urlsplit

DOMAIN = 'image.qintopia.cn'
# Provisioner must confirm this against the created CDN resource before deployment.
EDGE = 'image.qintopia.cn.cdn.dnsv1.com'
PROBE_PATH = '/image-playground/health/certificate-check.txt'
PROBE_BYTES = b'qintopia-image-storage-ready\n'
URL_AUTH_EXPIRY_SECONDS = 900
CST = dt.timezone(dt.timedelta(hours=8))
DAY = 86400
RENEW_BEFORE = 30 * DAY
CRITICAL_BEFORE = 7 * DAY
PENDING_LIMIT = 2 * DAY


def epoch(value):
    return dt.datetime.strptime(value, '%Y-%m-%d %H:%M:%S').replace(tzinfo=CST).timestamp()


def covers(cert):
    names = [cert.get('Domain') or ''] + (cert.get('SubjectAltName') or [])
    # This service deliberately adopts only certificates for this exact host.
    return any(name.lower().rstrip('.') == DOMAIN for name in names)


def eligible(cert, current_expiry, now):
    try:
        return (cert.get('Status') == 1 and covers(cert)
                and epoch(cert['CertBeginTime']) <= now
                and epoch(cert['CertEndTime']) > max(now, current_expiry))
    except (KeyError, TypeError, ValueError):
        return False


class CloudError(RuntimeError):
    pass


class API:
    def __init__(self, path):
        if Path(path).stat().st_mode & 0o077:
            raise RuntimeError('Credentials must not be accessible to group/others')
        self.creds = json.loads(Path(path).read_text())
        for field in ('SecretId', 'SecretKey', 'CdnAuthKey'):
            value = self.creds.get(field)
            if not isinstance(value, str) or not value or any(c in value for c in '\r\n'):
                raise RuntimeError('Required credentials are missing or invalid')
        self.cdn_auth_key = self.creds['CdnAuthKey']

    def call(self, service, action, payload):
        allowed = {
            'ssl': {'DescribeCertificates', 'DescribeCertificate', 'ApplyCertificate'},
            'cdn': {'DescribeDomainsConfig', 'ModifyDomainConfig'},
        }
        if action not in allowed.get(service, set()):
            raise RuntimeError('API action outside the image-domain certificate contract')
        if action == 'ModifyDomainConfig':
            if (set(payload) != {'Domain', 'Route', 'Value'} or payload['Domain'] != DOMAIN
                    or payload['Route'] != 'Https.CertInfo.CertId'):
                raise RuntimeError('Refusing a write outside the image-domain certificate binding')
            value = json.loads(payload['Value'])
            if set(value) != {'update'} or not isinstance(value['update'], str) or not value['update']:
                raise RuntimeError('Invalid certificate binding value')
        if action == 'ApplyCertificate':
            expected = renewal_payload(payload.get('OldCertificateId'))
            if payload != expected:
                raise RuntimeError('Refusing a non-free or non-image-domain certificate application')
        version = {'ssl': '2019-12-05', 'cdn': '2018-06-06'}[service]
        host = service + '.tencentcloudapi.com'
        timestamp = int(time.time())
        date = dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).strftime('%Y-%m-%d')
        body = json.dumps(payload, separators=(',', ':')).encode()
        digest = hashlib.sha256(body).hexdigest()
        canonical = ('POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:'
                     + host + '\n\ncontent-type;host\n' + digest)
        scope = date + '/' + service + '/tc3_request'
        to_sign = ('TC3-HMAC-SHA256\n' + str(timestamp) + '\n' + scope + '\n'
                   + hashlib.sha256(canonical.encode()).hexdigest())
        sign = lambda key, msg: hmac.new(key, msg.encode(), hashlib.sha256).digest()
        key = sign(('TC3' + self.creds['SecretKey']).encode(), date)
        key = sign(sign(key, service), 'tc3_request')
        signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
        headers = {
            'Content-Type': 'application/json; charset=utf-8', 'Host': host,
            'Authorization': 'TC3-HMAC-SHA256 Credential=' + self.creds['SecretId'] + '/' + scope
                             + ', SignedHeaders=content-type;host, Signature=' + signature,
            'X-TC-Action': action, 'X-TC-Version': version, 'X-TC-Timestamp': str(timestamp),
        }
        request = urllib.request.Request('https://' + host, data=body, headers=headers)
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)['Response']
        if 'Error' in result:
            # Do not log response bodies, signed requests, credentials or CA contact data.
            raise CloudError(action + ': ' + result['Error']['Code'])
        return result


def renewal_payload(old_id=None):
    payload = {
        'DomainName': DOMAIN, 'DvAuthMethod': 'DNS_AUTO', 'PackageType': '83',
        'ValidityPeriod': '3', 'Alias': 'qintopia-image-auto-renew', 'DeleteDnsAutoRecord': False,
    }
    if old_id:
        payload['OldCertificateId'] = old_id
    return payload


def save(path, value):
    temp = path.with_suffix('.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    os.replace(temp, path)


def read_state(path):
    return json.loads(path.read_text()) if path.exists() else {}


def domain_config(api):
    response = api.call('cdn', 'DescribeDomainsConfig', {
        'Filters': [{'Name': 'domain', 'Value': [DOMAIN], 'Fuzzy': False}]})
    domains = response.get('Domains') or []
    if len(domains) != 1 or domains[0].get('Domain') != DOMAIN or domains[0].get('Cname') != EDGE:
        raise RuntimeError('Unexpected image-domain CDN domain or CNAME')
    return domains[0]


def certificates(api):
    result, offset = [], 0
    while True:
        response = api.call('ssl', 'DescribeCertificates', {
            'SearchKey': DOMAIN, 'Offset': offset, 'Limit': 100})
        batch = response.get('Certificates') or []
        result.extend(cert for cert in batch if covers(cert))
        offset += len(batch)
        if not batch or offset >= response.get('TotalCount', offset):
            return result
        if offset >= 10000:
            raise RuntimeError('Unexpected certificate pagination size')


def candidate(api, rows, expiry, now):
    valid = [cert for cert in rows if eligible(cert, expiry, now)]
    for cert in sorted(valid, key=lambda c: epoch(c['CertEndTime']), reverse=True):
        detail = api.call('ssl', 'DescribeCertificate', {'CertificateId': cert['CertificateId']})
        if (detail.get('CertificateId') == cert['CertificateId']
                and detail.get('Deployable') is True and eligible(detail, expiry, now)):
            return detail
    return None


class RejectProbeRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # Signed URLs must never be sent to another host, nor count a redirect as health.
        raise RuntimeError('Unexpected private probe redirect')


def probe_url(cdn_auth_key, timestamp=None):
    if not isinstance(cdn_auth_key, str) or not cdn_auth_key or any(c in cdn_auth_key for c in '\r\n'):
        raise RuntimeError('CDN authentication key is missing or invalid')
    timestamp = int(time.time()) if timestamp is None else timestamp
    if not isinstance(timestamp, int) or timestamp < 0:
        raise RuntimeError('Invalid probe timestamp')
    stamp = str(timestamp)
    # Tencent CDN TypeD: md5(secret + pathname + decimal timestamp).
    # CDN authentication configuration must use sign/t and an expiry of 900 seconds.
    digest = hashlib.md5((cdn_auth_key + PROBE_PATH + stamp).encode()).hexdigest()
    return 'https://' + DOMAIN + PROBE_PATH + '?' + urlencode({'sign': digest, 't': stamp})


def verify(config, expected_expiry, cdn_auth_key):
    if config.get('HttpsBilling', {}).get('Switch') != 'on':
        raise RuntimeError('Image CDN HTTPS content service is not enabled; finish bootstrap first')
    context = ssl.create_default_context()
    with socket.create_connection((DOMAIN, 443), timeout=20) as raw:
        with context.wrap_socket(raw, server_hostname=DOMAIN) as tls:
            actual = ssl.cert_time_to_seconds(tls.getpeercert()['notAfter'])
    if abs(actual - expected_expiry) > 300:
        raise RuntimeError('CDN edge has not served the expected certificate expiry')
    signed_url = probe_url(cdn_auth_key)
    request = urllib.request.Request(signed_url, headers={
        'User-Agent': 'QinTopia-Image-Cert-Check/1.0',
    })
    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), RejectProbeRedirects())
    try:
        with opener.open(request, timeout=30) as response:
            served = urlsplit(response.url)
            if (response.status != 200 or served.scheme != 'https' or served.hostname != DOMAIN
                    or served.path != PROBE_PATH or response.read(len(PROBE_BYTES) + 1) != PROBE_BYTES):
                raise RuntimeError('Unexpected private probe response')
    except RuntimeError:
        raise
    except Exception:
        # HTTPError/URLError can include the signed URL; expose only a fixed diagnostic.
        raise RuntimeError('Private probe request failed') from None
    return {
        'verification_mode': 'public_tls_and_signed_private_probe',
        'served_expiry': dt.datetime.fromtimestamp(actual, CST).isoformat(),
        'probe_path': PROBE_PATH,
    }


def wait_config(api, deadline):
    config = domain_config(api)
    while config['Status'] == 'processing' and time.monotonic() < deadline:
        time.sleep(min(20, max(0, deadline - time.monotonic())))
        config = domain_config(api)
    if config['Status'] != 'online' or config.get('Https', {}).get('Switch') != 'on':
        raise RuntimeError('image-domain CDN must be online with HTTPS configured; no enable/disable writes allowed')
    return config


def ensure_renewal(api, rows, binding, state_dir, now, apply):
    expiry = epoch(binding['ExpireTime'])
    pending = [cert for cert in rows if cert.get('Status') in (0, 4)]
    intent_path = state_dir / 'renewal.json'
    intent = read_state(intent_path)
    if intent.get('certificate_id'):
        detail = api.call('ssl', 'DescribeCertificate', {'CertificateId': intent['certificate_id']})
        if not covers(detail):
            raise RuntimeError('Renewal certificate domain mismatch')
        if detail.get('Status') in (0, 4):
            pending = [detail]
        elif detail.get('Status') != 1:
            raise RuntimeError('Previous renewal was rejected/cancelled; inspect the SSL order before retrying')
    if pending:
        current = pending[0]
        if intent.get('certificate_id') != current['CertificateId']:
            intent = {'domain': DOMAIN, 'old_certificate': binding['CertId'],
                      'certificate_id': current['CertificateId'], 'requested_at': now, 'phase': 'pending'}
            if apply:
                save(intent_path, intent)
        if now - intent.get('requested_at', now) > PENDING_LIMIT:
            raise RuntimeError('image-domain certificate issuance has been pending for over 48 hours')
        return {'renewal': 'pending', 'renewal_certificate': current['CertificateId']}
    if intent.get('old_certificate') == binding['CertId'] and intent.get('phase') == 'requesting':
        raise RuntimeError('Previous application outcome unknown; reconcile SSL orders before retrying')
    if intent.get('old_certificate') == binding['CertId'] and intent.get('certificate_id'):
        raise RuntimeError('Previous renewal is not a newer deployable certificate; inspect the SSL order')
    if not apply:
        return {'renewal': 'would_request'}
    intent = {'domain': DOMAIN, 'old_certificate': binding['CertId'],
              'requested_at': now, 'phase': 'requesting'}
    # Persist intent BEFORE a non-idempotent order request. An ambiguous response is never retried blindly.
    save(intent_path, intent)
    payload = renewal_payload(binding['CertId'] if expiry > now else None)
    response = api.call('ssl', 'ApplyCertificate', payload)
    new_id = response.get('CertificateId')
    if not isinstance(new_id, str) or not new_id or new_id == binding['CertId']:
        raise RuntimeError('Certificate application returned no new order ID; reconcile before retrying')
    intent.update(certificate_id=new_id, phase='pending')
    save(intent_path, intent)
    return {'renewal': 'requested', 'renewal_certificate': new_id}


def run(api, state_dir, apply=False, wait_seconds=600):
    deadline = time.monotonic() + wait_seconds
    config = wait_config(api, deadline)
    binding = config.get('Https', {}).get('CertInfo') or {}
    if not binding.get('CertId') or not binding.get('ExpireTime'):
        raise RuntimeError('Bootstrap incomplete: image CDN needs an issued certificate binding')
    now = time.time()
    expiry = epoch(binding['ExpireTime'])
    record = {'checked_at': dt.datetime.now(CST).isoformat(), 'domain': DOMAIN,
              'certificate_id': binding['CertId'], 'expires_at': binding['ExpireTime'],
              'renew_before_days': RENEW_BEFORE // DAY, 'renewal': 'not_due'}
    rows = certificates(api)
    newer = candidate(api, rows, expiry, now)
    if newer:
        target = newer['CertificateId']
        record.update(target_certificate=target, target_expiry=newer['CertEndTime'])
        if not apply:
            record['result'] = 'would_deploy'
            return record
        save(state_dir / ('before-' + str(time.time_ns()) + '.json'), record)
        save(state_dir / 'status.json', dict(record, result='deployment_requested'))
        api.call('cdn', 'ModifyDomainConfig', {
            'Domain': DOMAIN, 'Route': 'Https.CertInfo.CertId', 'Value': json.dumps({'update': target})})
        expiry = epoch(newer['CertEndTime'])
    else:
        target = binding['CertId']
        if expiry - now <= RENEW_BEFORE:
            current = api.call('ssl', 'DescribeCertificate', {'CertificateId': target})
            if current.get('CertificateId') != target or not covers(current):
                raise RuntimeError('Current certificate does not belong to image-domain')
            record.update(ensure_renewal(api, rows, binding, state_dir, now, apply))
    while True:
        try:
            live = wait_config(api, deadline)
            if live['Https']['CertInfo']['CertId'] != target:
                raise RuntimeError('CDN has not bound the expected image-domain certificate')
            record.update(verify(live, expiry, api.cdn_auth_key))
            break
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(min(20, max(0, deadline - time.monotonic())))
    if expiry - now <= CRITICAL_BEFORE:
        raise RuntimeError('image-domain certificate expires within 7 days without a verified replacement')
    record['certificate_id'] = target
    record['expires_at'] = dt.datetime.fromtimestamp(expiry, CST).strftime('%Y-%m-%d %H:%M:%S')
    record['result'] = 'deployed_and_verified' if newer else (
        'renewal_pending' if record['renewal'] in ('pending', 'requested') else 'healthy_no_change')
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--credentials', default='/etc/qintopia-image-cert/credentials.json')
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/qintopia-image-cert'))
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--wait-seconds', type=int, default=600)
    args = parser.parse_args()
    args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (args.state_dir / 'run.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another image-domain certificate renewal is running')
            return 0
        try:
            result = run(API(args.credentials), args.state_dir, args.apply, args.wait_seconds)
            save(args.state_dir / 'status.json', result)
            print(json.dumps(result, ensure_ascii=False))
            return 0
        except Exception as exc:
            # SDK/network exception bodies may contain authentication or request data.
            error = str(exc) if isinstance(exc, (RuntimeError, CloudError)) else type(exc).__name__
            result = {'checked_at': dt.datetime.now(CST).isoformat(), 'domain': DOMAIN,
                      'result': 'failed', 'error': error}
            save(args.state_dir / 'status.json', result)
            print(json.dumps(result, ensure_ascii=False), file=sys.stderr)
            return 1


if __name__ == '__main__':
    sys.exit(main())
