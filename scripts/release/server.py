"""Root-owned, recoverable standalone releases. This module never writes user images."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import pathlib
import pwd
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import urllib.request

from common import ARCHIVE, ReleaseError, json_bytes, release_prefix, sha256_file, utcnow, validate_identity, validate_manifest

CONFIG_PATH = pathlib.Path('/etc/qintopia-image-release/config.json')
APPLICATION = 'qintopia-image'
UNIT_PREFIX = 'qintopia-image-app-'


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_bytes())
    except (OSError, ValueError, UnicodeError):
        raise ReleaseError('invalid or missing release state/configuration') from None


def atomic_write(path, data, mode=0o600):
    path = pathlib.Path(path)
    require(not path.is_symlink(), 'refusing to replace a symlink')
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def secure_file(path, *, secret=False):
    path = pathlib.Path(path)
    require(path.is_file() and not path.is_symlink(), 'configuration must be a regular file')
    stat = path.stat()
    require(stat.st_uid == 0 and not stat.st_mode & 0o022, 'configuration must be root-owned and not writable by other users')
    if secret:
        require(not stat.st_mode & 0o077, 'credential configuration must be private')


def load_config(path=CONFIG_PATH):
    secure_file(path)
    config = read_json(path)
    require(isinstance(config, dict) and config.get('application') == APPLICATION, 'invalid application configuration')
    required = {'stateDir', 'appRoot', 'nodeBinary', 'environmentFile', 'nginxSite', 'staticDir', 'publicBaseUrl', 'ports', 'cosCredentialsFile', 'cos'}
    require(required.issubset(config), 'incomplete release configuration')
    require(config['ports'] == [4400, 4401], 'unsupported release ports')
    require(config['publicBaseUrl'] == 'https://image.qintopia.cn', 'unexpected public application origin')
    for key in ['stateDir', 'appRoot', 'nodeBinary', 'environmentFile', 'nginxSite', 'staticDir', 'cosCredentialsFile']:
        value = config[key]
        require(isinstance(value, str) and value.startswith('/') and '\n' not in value and '\r' not in value and '..' not in pathlib.PurePosixPath(value).parts, 'invalid managed path')
    require(config['cos'].get('prefix') == 'qintopia-image/releases/', 'invalid release COS prefix')
    for key in ['healthTimeoutSeconds', 'drainTimeoutSeconds']:
        require(isinstance(config.get(key, 30), int) and 1 <= config.get(key, 30) <= 180, 'invalid release timeout')
    secure_file(config['environmentFile'], secret=True)
    return config


def identity_args(arguments, *, root=False):
    """Validated twice: before sudo and by the installed isolated interpreter."""
    if arguments in (['status'], ['recover'], ['maintenance'], ['maintenance', 'dry-run'], ['maintenance', 'apply']):
        if arguments == ['recover'] and not root:
            raise ReleaseError('recovery is an administrator operation')
        return arguments
    if arguments == ['bootstrap'] and root:
        return arguments
    require(len(arguments) == 5 and arguments[0] in ['deploy', 'rollback'], 'restricted release command required')
    operation, version, revision, prefix, checksum = arguments
    validate_identity(version, revision)
    require(prefix == release_prefix(version, revision), 'release prefix does not match identity')
    require(re.fullmatch('[0-9a-f]{64}', checksum) is not None, 'invalid manifest checksum')
    return [operation, version, revision, prefix, checksum]


class System:
    def run(self, args, *, timeout=30, allow_missing_unit=False):
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                                    env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
        except (OSError, subprocess.TimeoutExpired):
            raise ReleaseError('system operation unavailable or outcome unknown; inspect release status') from None
        if result.returncode and not (allow_missing_unit and 'LoadState=not-found' in result.stdout.splitlines()):
            raise ReleaseError('system operation failed; inspect release status')
        return result.stdout.strip()

    def properties(self, unit):
        text = self.run(['systemctl', 'show', unit, '--property=LoadState,ActiveState,MainPID,ControlGroup'], allow_missing_unit=True)
        return dict(line.split('=', 1) for line in text.splitlines() if '=' in line)

    def fingerprint(self, pid):
        try:
            data = pathlib.Path('/proc', str(pid), 'stat').read_text()
            return {'pid': int(pid), 'start': data[data.rfind(')') + 2:].split()[19]}
        except (FileNotFoundError, ProcessLookupError):
            return None

    def process_matches(self, reference):
        props = self.properties(reference['unit'])
        if props.get('ActiveState') != 'active' or props.get('MainPID') in [None, '0']:
            return False
        try:
            expected = pathlib.Path(reference['path']) / ('.next/standalone' if reference.get('legacy') else '')
            return pathlib.Path('/proc', props['MainPID'], 'cwd').resolve(strict=True) == expected.resolve(strict=True)
        except OSError:
            return False

    def unit_process(self, reference):
        return self.fingerprint(self.properties(reference['unit']).get('MainPID', '0'))

    def workers(self):
        master = self.properties('nginx.service').get('MainPID', '0')
        try:
            children = pathlib.Path('/proc', master, 'task', master, 'children').read_text().split()
            result = []
            for pid in children:
                try:
                    if b'nginx: worker process' in pathlib.Path('/proc', pid, 'cmdline').read_bytes():
                        mark = self.fingerprint(pid)
                        if mark:
                            result.append(mark)
                except FileNotFoundError:
                    pass
            require(result, 'cannot identify Nginx workers')
            return result
        except OSError:
            raise ReleaseError('cannot identify Nginx workers') from None

    def remaining_workers(self, workers):
        return sum(self.fingerprint(item['pid']) == item for item in workers)

    def connections(self, port):
        return len(self.run(['ss', '-Htn', 'state', 'established', f'( sport = :{port} )']).splitlines())

    def listening(self, port):
        return bool(self.run(['ss', '-Hltn', f'( sport = :{port} )']))

    def get(self, url):
        try:
            with urllib.request.urlopen(url, timeout=4) as response:
                require(response.status == 200, 'health endpoint did not succeed')
                data = response.read(64 * 1024 + 1)
                require(len(data) <= 64 * 1024, 'health response too large')
                return data
        except (OSError, ValueError):
            raise ReleaseError('health endpoint unavailable') from None

    def public_get(self, origin, path):
        return self.run(['curl', '--noproxy', '*', '--fail', '--silent', '--show-error', '--max-time', '4',
                         '--resolve', 'image.qintopia.cn:443:127.0.0.1', origin + path]).encode()

    def start(self, reference, config):
        require(not self.listening(reference['port']), 'candidate port is occupied')
        directory = pathlib.Path(reference['path'])
        cache = directory / '.next/cache'
        cache.mkdir(parents=True, exist_ok=True)
        owner = pwd.getpwnam('qintopia-image-app')
        os.chown(cache, owner.pw_uid, owner.pw_gid)
        os.chmod(cache, 0o700)
        unit = f'''[Unit]
Description=QinTopia image application on port {reference['port']}
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=qintopia-image-app
Group=qintopia-image-app
WorkingDirectory={directory}
EnvironmentFile={config['environmentFile']}
ExecStart=/usr/bin/env PORT={reference['port']} APP_RELEASE={reference['releaseId']} {config['nodeBinary']} server.js
Restart=on-failure
RestartSec=5
SuccessExitStatus=143
TimeoutStopSec=90
MemoryHigh=768M
MemoryMax=1024M
CPUQuota=200%
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={cache}
UMask=0077

[Install]
WantedBy=multi-user.target
'''
        path = pathlib.Path('/etc/systemd/system') / reference['unit']
        props = self.properties(reference['unit'])
        require(props.get('ActiveState') not in ['active', 'activating', 'deactivating'] and props.get('MainPID', '0') == '0', 'candidate unit is still running')
        atomic_write(path, unit.encode(), 0o644)
        self.run(['systemctl', 'daemon-reload'])
        self.run(['systemctl', 'enable', '--now', reference['unit']])

    def stop(self, reference, expected_process):
        props = self.properties(reference['unit'])
        already_stopped = props.get('ActiveState') in ['inactive', 'failed'] and props.get('MainPID') == '0' and not props.get('ControlGroup')
        if not already_stopped:
            require(self.unit_process(reference) == expected_process and self.process_matches(reference), 'old service identity changed; refusing to stop it')
            self.run(['systemctl', 'stop', reference['unit']], timeout=100)
        props = self.properties(reference['unit'])
        require(props.get('ActiveState') in ['inactive', 'failed'] and props.get('MainPID') == '0' and not props.get('ControlGroup'), 'old service stop outcome unknown')
        if props.get('ActiveState') == 'failed':
            self.run(['systemctl', 'reset-failed', reference['unit']])
        self.run(['systemctl', 'disable', reference['unit']])

    def reload_nginx(self):
        self.run(['nginx', '-t'])
        self.run(['systemctl', 'reload', 'nginx'])

    def validate_shutdown(self):
        for value in re.findall(r'^\s*worker_shutdown_timeout\s+([^;]+);', self.run(['nginx', '-T']), re.M):
            require(value.strip() in ['0', '0s', '0ms'], 'Nginx forced worker timeout could terminate active image requests')


class Runtime:
    def __init__(self, config, system=None, fetcher=None):
        self.config = config
        self.system = system or System()
        self.fetcher = fetcher
        self.root = pathlib.Path(config['appRoot'])
        self.state_dir = pathlib.Path(config['stateDir'])
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_path = self.state_dir / 'state.json'
        self.journal_path = self.state_dir / 'journal.json'
        self.maintenance_path = self.state_dir / 'maintenance.json'
        self.pending_cleanup = None
        self.state = read_json(self.state_path) if self.state_path.exists() else {'schema': 1, 'current': None, 'previous': None, 'history': []}
        self.journal = read_json(self.journal_path) if self.journal_path.exists() else None
        self.validate_state()

    def validate_reference(self, reference):
        if reference is None:
            return
        require(isinstance(reference, dict), 'invalid release reference')
        require(reference.get('port') in self.config['ports'], 'invalid reference port')
        require(reference.get('unit') == UNIT_PREFIX + str(reference['port']) + '.service', 'invalid reference unit')
        if reference.get('legacy'):
            require(reference.get('releaseId') == '20261026T031554Z-5b6ede50e6', 'unreviewed legacy reference')
            require(reference.get('browserWorkspaceSchema') == 1 and reference.get('assetCapabilityVersion') == 1, 'unreviewed legacy formats')
            require(isinstance(reference.get('sourceSha256'), str) and re.fullmatch('[0-9a-f]{64}', reference['sourceSha256']), 'invalid legacy source digest')
        else:
            manifest = validate_manifest(reference.get('manifest'))
            require(reference.get('version') == manifest['version'] and reference.get('revision') == manifest['revision'], 'reference identity mismatch')
            require(reference.get('prefix') == release_prefix(manifest['version'], manifest['revision']), 'reference prefix mismatch')
            require(reference.get('releaseId') == manifest['version'] + '-' + manifest['revision'][:12], 'reference directory identity mismatch')
            require(isinstance(reference.get('manifestSha256'), str) and re.fullmatch('[0-9a-f]{64}', reference['manifestSha256']), 'invalid reference manifest digest')
        require(reference.get('path') == str(self.root / 'releases' / reference['releaseId']), 'reference path escapes managed releases')

    def validate_state(self):
        require(isinstance(self.state, dict) and self.state.get('schema') == 1 and isinstance(self.state.get('history'), list), 'unsupported release state')
        for reference in [self.state.get('current'), self.state.get('previous')]:
            self.validate_reference(reference)
        for item in self.state['history']:
            require(isinstance(item, dict) and isinstance(item.get('deployedAt'), str), 'invalid release history')
            self.validate_reference(item.get('reference'))
        if self.journal:
            require(isinstance(self.journal, dict) and self.journal.get('schema') == 1, 'unsupported release journal')
            require(self.journal.get('phase') in ['preparing', 'staged', 'switching', 'restoring', 'rollback_draining', 'draining', 'old_stopped', 'healthy', 'rolled_back', 'aborted'], 'unknown release phase needs operator review')
            require(isinstance(self.journal.get('id'), str) and re.fullmatch('[0-9a-f-]{36}', self.journal['id']), 'invalid transaction identity')
            self.validate_reference(self.journal.get('source'))
            self.validate_reference(self.journal.get('target'))

    @contextlib.contextmanager
    def lock(self):
        path = self.state_dir / 'release.lock'
        require(not path.is_symlink(), 'release lock is a symlink')
        with path.open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ReleaseError('another release operation owns the lock') from None
            self.state = read_json(self.state_path) if self.state_path.exists() else self.state
            self.journal = read_json(self.journal_path) if self.journal_path.exists() else None
            self.validate_state()
            yield

    def save_state(self):
        atomic_write(self.state_path, json_bytes(self.state))

    def phase(self, phase):
        self.journal['phase'] = phase
        self.journal['updatedAt'] = utcnow()
        atomic_write(self.journal_path, json_bytes(self.journal))

    def healthy(self, reference, *, public=False):
        if not reference or not self.system.process_matches(reference):
            return False
        try:
            if reference.get('legacy'):
                self.system.get(f"http://127.0.0.1:{reference['port']}/")
                return not public
            base = f"http://127.0.0.1:{reference['port']}"
            getter = (lambda path: self.system.public_get(self.config['publicBaseUrl'], path)) if public else (lambda path: self.system.get(base + path))
            health = json.loads(getter('/api/health'))
            metadata = json.loads(getter('/api/version'))
            require(health.get('status') in ['ok', 'ready', 'healthy'], 'application is not healthy')
            manifest = reference['manifest']
            require(metadata.get('managed') is True, 'running release is not managed')
            for key in ['application', 'version', 'revision', 'platform', 'builtAt', 'browserWorkspaceSchema', 'assetCapabilityVersion']:
                require(metadata.get(key) == manifest.get(key), 'running release identity mismatch')
            return True
        except (ReleaseError, ValueError, KeyError, TypeError):
            return False

    def wait_healthy(self, reference, *, public=False):
        deadline = time.monotonic() + self.config.get('healthTimeoutSeconds', 30)
        while time.monotonic() < deadline:
            if self.healthy(reference, public=public):
                return
            time.sleep(0.25)
        raise ReleaseError('candidate health or release identity did not become ready')

    def protected(self):
        refs = [self.state.get('current'), self.state.get('previous')]
        if self.journal:
            refs += [self.journal.get('source'), self.journal.get('target')]
        refs += [item['reference'] for item in self.state['history'] if self.system.process_matches(item['reference'])]
        return [ref for ref in refs if ref]

    def receipt(self, plan=None):
        current = self.state.get('current')
        phase = self.journal.get('phase') if self.journal else None
        status = 'uninitialized' if not current else 'in-progress' if phase in ['preparing', 'staged', 'switching', 'restoring', 'old_stopped'] else 'healthy-draining' if phase in ['draining', 'rollback_draining'] and self.healthy(current) else 'healthy' if self.healthy(current) else 'needs-attention'
        result = {'application': APPLICATION, 'status': status, 'current': current, 'previous': self.state.get('previous'),
                  'transaction': ({key: self.journal.get(key) for key in ['id', 'phase', 'delivery']} if self.journal else None),
                  'protectedPrefixes': sorted({ref['prefix'] for ref in self.protected() if 'prefix' in ref})}
        if plan is not None:
            result['localReleasePlan'] = plan
        if self.maintenance_path.exists():
            maintenance = read_json(self.maintenance_path)
            result['maintenance'] = {'phase': maintenance.get('phase'), 'remaining': len(maintenance.get('remaining', []))}
        return result

    def bootstrap(self):
        require(not self.state.get('current') and not self.journal, 'release state is already initialized')
        legacy = self.config.get('legacy')
        require(isinstance(legacy, dict), 'reviewed legacy baseline is required')
        require(legacy.get('releaseId') == '20261026T031554Z-5b6ede50e6' and legacy.get('port') == 4401 and legacy.get('unit') == 'qintopia-image-app-4401.service', 'unreviewed legacy baseline')
        reference = {**legacy, 'legacy': True, 'path': str(self.root / 'releases' / legacy['releaseId'])}
        require(reference.get('browserWorkspaceSchema') == 1 and reference.get('assetCapabilityVersion') == 1, 'legacy storage schema is unreviewed')
        require((self.root / 'current').is_symlink() and (self.root / 'current').resolve() == pathlib.Path(reference['path']).resolve(), 'legacy symlink differs from reviewed baseline')
        build = read_json(pathlib.Path(reference['path']) / 'build-result.json')
        require(build.get('source_sha256') == reference.get('sourceSha256') and build.get('release') == reference['releaseId'], 'legacy build identity differs from reviewed baseline')
        require(self.healthy(reference), 'legacy application is not healthy')
        require(self.nginx_port() == reference['port'], 'legacy Nginx target differs')
        self.state.update(current=reference, previous=None, adoptedAt=utcnow())
        self.save_state()
        return self.receipt()

    def nginx_port(self):
        text = pathlib.Path(self.config['nginxSite']).read_text()
        matches = re.findall(r'(?m)^\s*proxy_pass\s+http://127\.0\.0\.1:(4400|4401)\s*;', text)
        require(len(matches) == 1, 'expected exactly one managed image upstream')
        return int(matches[0])

    def fetch(self, version, revision, prefix, manifest_sha, destination):
        if self.fetcher:
            return self.fetcher(version, revision, prefix, manifest_sha, destination)
        from cos import CosStore, fetch_bundle
        secure_file(self.config['cosCredentialsFile'], secret=True)
        credentials = read_json(self.config['cosCredentialsFile'])
        store = CosStore(self.config['cos']['bucket'], self.config['cos']['region'], credentials=credentials, role='reader')
        return fetch_bundle(store, version, revision, destination, manifest_sha)['manifest']

    def prepare(self, version, revision, prefix, checksum, port):
        from common import safe_extract_runtime
        release_id = version + '-' + revision[:12]
        target = self.root / 'releases' / release_id
        require(target.parent.is_dir() and not target.parent.is_symlink() and not target.is_symlink(), 'unsafe release directory')
        download = pathlib.Path(tempfile.mkdtemp(prefix='candidate-', dir=self.state_dir))
        try:
            manifest = self.fetch(version, revision, prefix, checksum, download)
            validate_manifest(manifest, version, revision)
            require(sha256_file(download / 'manifest.json') == checksum, 'manifest checksum mismatch')
            reference = {'version': version, 'revision': revision, 'prefix': prefix, 'manifestSha256': checksum, 'manifest': manifest, 'releaseId': release_id,
                         'path': str(target), 'port': port, 'unit': UNIT_PREFIX + str(port) + '.service'}
            if target.exists():
                require(read_json(target / '.release-receipt.json') == {'manifestSha256': checksum, 'manifest': manifest}, 'existing release conflicts with immutable candidate')
            else:
                temporary = target.with_name('.' + release_id + '-' + self.journal['id'])
                require(not temporary.exists(), 'candidate extraction outcome requires inspection')
                safe_extract_runtime(download / ARCHIVE, temporary, expected_manifest=manifest)
                atomic_write(temporary / '.release-receipt.json', json_bytes({'manifestSha256': checksum, 'manifest': manifest}), 0o644)
                os.replace(temporary, target)
            metadata = read_json(target / 'release.json')
            require(metadata.get('schema') == 1, 'runtime release metadata schema mismatch')
            for key in ['application', 'version', 'revision', 'platform', 'builtAt', 'browserWorkspaceSchema', 'assetCapabilityVersion']:
                require(metadata.get(key) == manifest.get(key), 'runtime metadata differs from manifest')
            policy = read_json(target / 'release-policy.json')
            require(policy.get('databaseMode') == 'none' and policy.get('rollbackCompatibility', {}).get('mode') == 'compatible', 'unsupported release compatibility policy')
            require(policy.get('browserWorkspaceSchema') == 1 and policy.get('assetCapabilityVersion') == 1, 'unsupported browser or asset schema')
            self.share_static(target / '.next/static')
            return reference
        finally:
            shutil.rmtree(download)

    def share_static(self, source):
        destination = pathlib.Path(self.config['staticDir'])
        require(source.is_dir() and not source.is_symlink(), 'candidate static assets are missing')
        destination.mkdir(parents=True, exist_ok=True, mode=0o755)
        require(not destination.is_symlink(), 'static destination must not be a symlink')
        for item in sorted(source.rglob('*')):
            require(not item.is_symlink(), 'static asset links are forbidden')
            target = destination / item.relative_to(source)
            if item.is_dir():
                require(not target.is_symlink(), 'static directory conflicts with a link')
                target.mkdir(parents=True, exist_ok=True)
            elif item.is_file():
                require(not target.is_symlink(), 'static asset conflicts with a link')
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    require(target.is_file() and sha256_file(target) == sha256_file(item), 'immutable static asset conflict')
                else:
                    atomic_write(target, item.read_bytes(), 0o644)
            else:
                raise ReleaseError('unsupported static asset type')

    def switch(self):
        target, source = self.journal['target'], self.journal['source']
        site = pathlib.Path(self.config['nginxSite'])
        self.system.validate_shutdown()
        original = site.read_bytes()
        require(self.nginx_port() == source['port'], 'Nginx upstream changed before cutover')
        require(self.healthy(source), 'previous service is not available for recovery')
        text = original.decode()
        for required in ['/etc/letsencrypt/live/image.qintopia.cn/fullchain.pem', '/etc/letsencrypt/live/image.qintopia.cn/privkey.pem', '/var/lib/qintopia-image-acme']:
            require(required in text, 'existing certificate and ACME configuration must be preserved')
        # Keep old lazy-loaded JS reachable after cutover. This is application code, never generated images.
        self.share_static(pathlib.Path(source['path']) / ('.next/standalone/.next/static' if source.get('legacy') else '.next/static'))
        static_location = f'    location ^~ /_next/static/ {{\n        alias {self.config["staticDir"]}/;\n        add_header Cache-Control "public, max-age=31536000, immutable";\n    }}\n'
        existing = re.findall(r'location\s+\^~\s+/_next/static/\s*\{[^}]*\}', text, re.S)
        if existing:
            require(len(existing) == 1 and f'alias {self.config["staticDir"]}/;' in existing[0], 'existing static routing differs from managed location')
        else:
            require('/_next/static/' not in text, 'unrecognized static routing')
            index = text.rfind('    location / {')
            require(index >= 0, 'cannot find HTTPS application location')
            text = text[:index] + static_location + text[index:]
        changed, count = re.subn(rf'(?m)^(\s*proxy_pass\s+http://127\.0\.0\.1:){source["port"]}(\s*;)', rf'\g<1>{target["port"]}\2', text)
        require(count == 1, 'expected one image upstream to change')
        self.journal.update(nginxBefore=original.decode(), nginxBeforeSha=hashlib.sha256(original).hexdigest(),
                            nginxAfterSha=hashlib.sha256(changed.encode()).hexdigest(), nginxMode=site.stat().st_mode & 0o777,
                            oldWorkers=self.system.workers(), oldProcess=self.system.unit_process(source))
        self.phase('switching')
        try:
            atomic_write(site, changed.encode(), self.journal['nginxMode'])
            self.system.reload_nginx()
            self.wait_healthy(target, public=True)
        except BaseException:
            self.restore_source()
            raise
        self.commit_live()

    def restore_source(self):
        site = pathlib.Path(self.config['nginxSite'])
        current_sha = sha256_file(site)
        require(current_sha in [self.journal['nginxBeforeSha'], self.journal['nginxAfterSha']], 'Nginx changed concurrently; recovery needs review')
        require(self.healthy(self.journal['source']), 'previous service unavailable; recovery needs review')
        self.journal['rollbackWorkers'] = self.system.workers()
        self.journal['candidateProcess'] = self.system.unit_process(self.journal['target'])
        self.phase('restoring')
        atomic_write(site, self.journal['nginxBefore'].encode(), self.journal['nginxMode'])
        self.system.reload_nginx()
        self.state['current'] = self.journal['source']
        self.save_state()
        self.phase('rollback_draining')
        self.drain_rollback()

    def drain_rollback(self):
        require(self.journal and self.journal['phase'] == 'rollback_draining', 'no rollback drain transaction')
        source, target = self.journal['source'], self.journal['target']
        require(self.healthy(source) and self.nginx_port() == source['port'], 'restored source is not healthy')
        require(sha256_file(self.config['nginxSite']) == self.journal['nginxBeforeSha'], 'restored Nginx configuration changed')
        if self.system.remaining_workers(self.journal['rollbackWorkers']) or self.system.connections(target['port']):
            return False
        self.system.stop(target, self.journal['candidateProcess'])
        self.phase('rolled_back')
        return True

    def commit_live(self):
        target = self.journal['target']
        self.state.update(current=target, previous=self.journal['source'])
        self.state['history'] = [item for item in self.state['history'] if item['reference'].get('prefix') != target.get('prefix')]
        self.state['history'].append({'reference': target, 'deployedAt': utcnow()})
        self.save_state()
        self.phase('draining')

    def drain(self):
        require(self.journal and self.journal['phase'] in ['draining', 'old_stopped'], 'no drain transaction')
        target, source = self.journal['target'], self.journal['source']
        require(self.healthy(target) and self.nginx_port() == target['port'], 'new service health must be restored before draining')
        require(sha256_file(self.config['nginxSite']) == self.journal['nginxAfterSha'], 'Nginx configuration changed after cutover')
        if self.system.remaining_workers(self.journal['oldWorkers']) or self.system.connections(source['port']):
            return False
        self.system.stop(source, self.journal['oldProcess'])
        self.phase('old_stopped')
        for name, destination in [('previous', source['path']), ('current', target['path'])]:
            link = self.root / name
            require(not link.exists() or link.is_symlink(), 'release pointer is not a symlink')
            temp = self.root / ('.' + name + '-' + self.journal['id'])
            if temp.is_symlink():
                temp.unlink()
            require(not temp.exists(), 'unexpected temporary release pointer')
            temp.symlink_to(destination)
            os.replace(temp, link)
        self.phase('healthy')
        return True

    def recover(self):
        if self.maintenance_path.exists():
            maintenance = read_json(self.maintenance_path)
            if maintenance.get('phase') == 'applying':
                self.apply_cleanup(maintenance)
        if not self.journal:
            return self.receipt()
        phase = self.journal['phase']
        if phase in ['draining', 'old_stopped']:
            self.drain()
        elif phase == 'rollback_draining':
            self.drain_rollback()
        elif phase in ['switching', 'restoring']:
            require('nginxAfterSha' in self.journal, 'cutover journal is incomplete')
            current_sha = sha256_file(self.config['nginxSite'])
            require(current_sha in [self.journal['nginxBeforeSha'], self.journal['nginxAfterSha']], 'Nginx changed outside recorded transaction')
            if phase == 'switching' and current_sha == self.journal['nginxAfterSha'] and self.healthy(self.journal['target'], public=True):
                self.commit_live()
                self.drain()
            else:
                self.restore_source()
        elif phase in ['preparing', 'staged']:
            # No unrecorded cutover is attempted. Preserve artifacts and the running old app.
            require(self.nginx_port() == self.journal['source']['port'], 'pre-cutover recovery has unexpected live upstream')
            candidate = self.journal.get('target')
            if candidate and self.system.process_matches(candidate):
                require(not self.system.connections(candidate['port']), 'unrouted candidate still has connections; inspect before stopping')
                self.system.stop(candidate, self.system.unit_process(candidate))
            self.phase('aborted')
        return self.receipt()

    def deploy(self, operation, version, revision, prefix, checksum):
        identity_args([operation, version, revision, prefix, checksum], root=True)
        current = self.state.get('current')
        require(current, 'adopt the existing service before deploying')
        if self.journal and self.journal['phase'] in ['draining', 'old_stopped', 'switching', 'restoring', 'rollback_draining']:
            self.recover()
        current = self.state['current']
        if current.get('prefix') == prefix:
            require(current.get('manifestSha256') == checksum, 'same release identity has different content')
            require(self.healthy(current, public=True), 'current release did not pass identity check')
            return self.receipt()
        if self.journal:
            require(self.journal['phase'] in ['healthy', 'rolled_back', 'aborted'], 'earlier release needs recovery')
            require(self.journal['phase'] != 'healthy' or self.journal.get('delivery') == 'complete', 'previous delivery outcome requires confirmation')
        current = self.state['current']
        port = next(value for value in self.config['ports'] if value != current['port'])
        require(not self.system.listening(port), 'standby port is occupied; resolve previous candidate first')
        self.journal = {'schema': 1, 'id': str(uuid.uuid4()), 'operation': operation, 'source': current,
                        'target': None, 'identity': {'version': version, 'revision': revision, 'prefix': prefix, 'manifestSha256': checksum},
                        'delivery': 'pending', 'createdAt': utcnow()}
        self.phase('preparing')
        target = self.prepare(version, revision, prefix, checksum, port)
        self.journal['target'] = target
        self.phase('preparing')
        if operation == 'rollback':
            require(any(item['reference'].get('prefix') == prefix for item in self.state['history']), 'rollback target was never a successful release')
        source_schema = current.get('manifest', current)
        for field in ['browserWorkspaceSchema', 'assetCapabilityVersion']:
            require(source_schema.get(field) == target['manifest'].get(field), 'browser or asset formats are not rollback compatible')
        if not self.system.process_matches(target):
            self.system.start(target, self.config)
        self.wait_healthy(target)
        self.phase('staged')
        self.switch()
        self.drain()
        return self.receipt()

    def maintenance(self, apply=False):
        require(not self.journal or self.journal['phase'] in ['healthy', 'rolled_back', 'aborted'], 'release still needs recovery or draining')
        require(not self.journal or self.journal.get('delivery') in ['complete', 'dry-run', None] or self.journal['phase'] != 'healthy', 'delivery outcome is not confirmed')
        protected = {ref['path'] for ref in self.protected()}
        recent = self.state['history'][-5:]
        protected.update(item['reference']['path'] for item in recent)
        known = {item['reference']['path']: item['reference'] for item in self.state['history']}
        plan = []
        delete_refs = []
        if self.maintenance_path.exists():
            require(read_json(self.maintenance_path).get('phase') != 'applying', 'earlier maintenance requires recovery')
        for path in sorted((self.root / 'releases').iterdir()):
            if not path.is_dir() or path.is_symlink():
                continue
            ref = known.get(str(path))
            reason = 'protected-reference' if str(path) in protected else 'unknown-or-legacy' if not ref else 'running-service' if self.system.process_matches(ref) else None
            action = 'keep' if reason else 'delete'
            plan.append({'releaseId': path.name, 'action': action, 'reason': reason})
            if apply and action == 'delete':
                delete_refs.append(ref)
        self.pending_cleanup = delete_refs if apply else None
        receipt = self.receipt(plan)
        # COS success markers retain first-publication time. A recent rollback
        # changes local use order, so communicate these retained identities while
        # holding the same lock instead of letting COS independently evict them.
        receipt['protectedPrefixes'] = sorted(set(receipt['protectedPrefixes']) | {
            item['reference']['prefix'] for item in recent if 'prefix' in item['reference']
        })
        return receipt

    def apply_cleanup(self, maintenance):
        require(maintenance.get('phase') == 'applying' and isinstance(maintenance.get('remaining'), list), 'invalid maintenance journal')
        while maintenance['remaining']:
            ref = maintenance['remaining'][0]
            self.validate_reference(ref)
            require(not ref.get('legacy'), 'legacy release is not a cleanup target')
            path = pathlib.Path(ref['path'])
            protected = {item['path'] for item in self.protected()}
            protected.update(item['reference']['path'] for item in self.state['history'][-5:])
            if str(path) not in protected and not self.system.process_matches(ref):
                require(path.parent == self.root / 'releases' and not path.is_symlink(), 'unsafe local cleanup target')
                if path.exists():
                    require(read_json(path / '.release-receipt.json').get('manifestSha256') == ref['manifestSha256'], 'local cleanup identity mismatch')
                    shutil.rmtree(path)
            maintenance['remaining'].pop(0)
            atomic_write(self.maintenance_path, json_bytes(maintenance))
        maintenance['phase'] = 'complete'
        atomic_write(self.maintenance_path, json_bytes(maintenance))

    def finish_maintenance(self, acknowledgement):
        if acknowledgement != 'complete' or self.pending_cleanup is None:
            return
        maintenance = {'schema': 1, 'id': str(uuid.uuid4()), 'phase': 'applying', 'remaining': self.pending_cleanup, 'approvedAt': utcnow()}
        atomic_write(self.maintenance_path, json_bytes(maintenance))
        self.apply_cleanup(maintenance)

    def acknowledge(self, value):
        require(value in ['complete', 'failed', 'dry-run', 'unconfirmed'], 'invalid delivery acknowledgement')
        if self.journal and self.journal['phase'] in ['healthy', 'draining']:
            self.journal['delivery'] = value
            self.phase(self.journal['phase'])


def read_ack(stream, timeout=None):
    # Do not expire this lock while a connected client is mutating COS. The SSH
    # session and outer workflow timeout bound the operation; EOF is unconfirmed.
    try:
        ready, _, _ = select.select([stream], [], [], timeout)
        if not ready:
            return 'unconfirmed'
        value = stream.readline(64).strip()
    except (OSError, ValueError):
        return 'unconfirmed'
    return {'ACK complete': 'complete', 'ACK failed': 'failed', 'ACK dry-run': 'dry-run'}.get(value, 'unconfirmed')


def serve(arguments=None, config=None, system=None, fetcher=None, *, input_stream=None, output_stream=None):
    arguments = identity_args(list(sys.argv[1:] if arguments is None else arguments), root=os.geteuid() == 0)
    runtime = Runtime(config or load_config(), system=system, fetcher=fetcher)
    input_stream, output_stream = input_stream or sys.stdin, output_stream or sys.stdout
    operation = arguments[0]
    if operation == 'status':
        print(json.dumps(runtime.receipt()), file=output_stream, flush=True)
        return
    with runtime.lock():
        if operation == 'bootstrap':
            receipt = runtime.bootstrap()
        elif operation == 'recover':
            receipt = runtime.recover()
        elif operation == 'maintenance':
            receipt = runtime.maintenance(apply=arguments[1:] == ['apply'])
        else:
            receipt = runtime.deploy(*arguments)
        print(json.dumps(receipt), file=output_stream, flush=True)
        if operation == 'maintenance':
            runtime.finish_maintenance(read_ack(input_stream))
        elif operation in ['deploy', 'rollback']:
            runtime.acknowledge(read_ack(input_stream))


if __name__ == '__main__':
    try:
        serve()
    except ReleaseError as error:
        print('QinTopia image: ' + str(error), file=sys.stderr)
        sys.exit(1)
