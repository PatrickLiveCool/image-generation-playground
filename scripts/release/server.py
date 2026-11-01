"""Root-owned, recoverable standalone releases. This module never writes user images."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import grp
import hashlib
import hmac
import json
import os
import pathlib
import pwd
import re
import select
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
import urllib.request

from common import ARCHIVE, ReleaseError, is_account_release, json_bytes, metadata_fields, release_prefix, sha256_file, utcnow, validate_identity, validate_manifest

CONFIG_PATH = pathlib.Path('/etc/qintopia-image-release/config.json')
APPLICATION = 'qintopia-image'
UNIT_PREFIX = 'qintopia-image-app-'
MAINTENANCE_USER = 'qintopia-image-maintenance'
ACCOUNT_PROTOCOL = 'account-private-v1'
DATABASE_PHASES = ['database_preflight', 'migrating', 'database_verified']
SERVICE_PHASES = ['entering_maintenance', 'service_maintenance']
ROOT_DATABASE_COMMANDS = ['service-maintenance', 'database-status', 'database-backup', 'database-restore', 'database-verify-restore', 'database-bootstrap-admin', 'database-verify-bootstrap-admin']
MAX_BACKUP_BYTES = int(64 * 1024 * 1024 * 1.4)
MAX_RECOVERY_SECRETS_BYTES = 64 * 1024
MAINTENANCE_ERRORS = {
    'DATABASE_CONFIGURATION': 'database configuration is missing or does not match the fixed target',
    'DATABASE_IDENTITY': 'database identity or privileges do not match the fixed contract',
    'DATABASE_BOUNDARY': 'database target or permissions cross the project boundary',
    'DATABASE_UNAVAILABLE': 'database connection is unavailable; inspect the outcome before retrying writes',
    'MAINTENANCE_ENVIRONMENT': 'maintenance environment contains forbidden settings',
    'MAINTENANCE_SECRETS': 'application authentication or provider secrets could not be verified',
    'MAINTENANCE_RELEASE': 'maintenance runner does not match its release contract',
    'MAINTENANCE_IO': 'private maintenance file descriptor is missing, unsafe or incomplete',
    'MIGRATION_DRIFT': 'database migration ledger differs from the reviewed migrations',
    'MIGRATION_SOURCE': 'packaged migration sources do not match the reviewed contract',
    'MIGRATION_REQUIRED': 'database has not reached the release migration version',
    'BACKUP_KEY_INVALID': 'independent recovery key is missing or invalid',
    'BACKUP_AUTHENTICATION_FAILED': 'archive authentication failed; verify the recovery key and archive',
    'BACKUP_TARGET_NOT_EMPTY': 'restore target contains business data; no target clearing is allowed',
    'BACKUP_STORAGE_MISMATCH': 'archive private COS identity differs from the configured target',
    'BACKUP_IDENTITY_REQUIRED': 'recovery requires the fixed project migration identity',
    'BACKUP_MIGRATION_MISMATCH': 'archive operation found an incompatible migration ledger',
    'BACKUP_SCHEMA_MISMATCH': 'project database structure differs from the fixed recovery contract',
    'BACKUP_SECRET_INVALID': 'archive application secrets are invalid',
    'BACKUP_PROVIDER_INVALID': 'archive provider configuration cannot be authenticated',
    'BACKUP_TOO_LARGE': 'project archive exceeds the fixed size limit',
    'BACKUP_PREFLIGHT_FAILED': 'restore preflight failed before data writes started',
    'BACKUP_RESTORE_MISMATCH': 'restored data does not match the authenticated archive',
    'BACKUP_RESTORE_UNCONFIRMED': 'restore commit is unconfirmed; use read-only restore verification',
    'BACKUP_SECRET_OUTPUT_UNCONFIRMED': 'restored data was checked but private secrets output is unconfirmed; verify restore',
    'ADMIN_EXISTS': 'an administrator already exists; initialization cannot overwrite it',
    'INVALID_INPUT': 'private administrator input does not meet the fixed contract',
}
FD_LAUNCHER = '''import os,sys
uid,gid,source,result=map(int,sys.argv[1:5])
first=os.dup(source)
second=os.dup(result) if result >= 0 else -1
os.dup2(first,3,inheritable=True)
if second >= 0: os.dup2(second,4,inheritable=True)
os.closerange(5,256)
if second < 0:
 try: os.close(4)
 except OSError: pass
os.setgroups([])
os.setgid(gid)
os.setuid(uid)
os.umask(0o077)
os.execve(sys.argv[5],[sys.argv[5],'--max-old-space-size=256',sys.argv[6],sys.argv[7]],dict(os.environ))
'''


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def maintenance_failure(stderr):
    # Only a fixed code may cross the subprocess boundary. Never relay the
    # runtime's message, stack, raw database error, or arbitrary stderr.
    try:
        value = json.loads(stderr) if isinstance(stderr, str) and len(stderr) <= 65536 else None
        code = value.get('error', {}).get('code') if isinstance(value, dict) and isinstance(value.get('error'), dict) else None
        if isinstance(code, str) and code in MAINTENANCE_ERRORS:
            return ReleaseError(code + ': ' + MAINTENANCE_ERRORS[code])
    except (ValueError, UnicodeError):
        pass
    return ReleaseError('database maintenance failed or outcome is unknown; use the corresponding read-only verification')


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


def read_environment(path):
    """A deliberately small EnvironmentFile subset; never source a shell file."""
    secure_file(path, secret=True)
    try:
        body = pathlib.Path(path).read_text()
        require(len(body) <= 65536, 'environment configuration is too large')
        result = {}
        for line in body.splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            name, separator, raw = line.partition('=')
            require(separator and re.fullmatch('[A-Z][A-Z0-9_]*', name) and name not in result, 'environment configuration has invalid or duplicate keys')
            words = shlex.split(raw, comments=False, posix=True)
            require(len(words) == 1 and '\x00' not in words[0], 'environment values require one literal value')
            result[name] = words[0]
        return result
    except (OSError, UnicodeError, ValueError):
        raise ReleaseError('environment configuration is invalid') from None


def maintenance_environment(config, recovery=False, restoring=False, bootstrap=False):
    require(config.get('maintenanceUser') == MAINTENANCE_USER, 'fixed maintenance identity is required')
    application = read_environment(config['environmentFile'])
    forbidden = {'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'IMAGE_MIGRATION_DATABASE_URL', 'IMAGE_RECOVERY_KEY'}
    require(not (set(application) & forbidden) and not any(key.startswith('PG') for key in application), 'application environment contains a forbidden maintenance or injection setting')
    migration = {}
    names = {'IMAGE_DATABASE_TARGET', 'IMAGE_DATABASE_URL'}
    if not bootstrap:
        migration = read_environment(config['migrationEnvironmentFile'])
        require(set(migration) == {'IMAGE_MIGRATION_DATABASE_URL'}, 'migration environment must contain only its fixed database credential')
        names.add('BETTER_AUTH_URL')
        if not restoring:
            names.update({'BETTER_AUTH_SECRET', 'PROVIDER_CONFIG_KEY'})
    require(names.issubset(application) and application['IMAGE_DATABASE_TARGET'] == 'production'
            and (bootstrap or application['BETTER_AUTH_URL'] == config['publicBaseUrl']), 'account application environment is incomplete or targets another application')
    environment = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'NODE_ENV': 'production',
                   **{name: application[name] for name in names}, **migration}
    if recovery:
        recovery_values = read_environment(config['recoveryEnvironmentFile'])
        require(set(recovery_values) == {'IMAGE_RECOVERY_KEY'}, 'recovery environment must contain only its independent key')
        extra = {'COS_BUCKET', 'COS_REGION'}
        if not restoring:
            extra.add('ASSET_ACCESS_SECRET')
        require(extra.issubset(application), 'project recovery requires the existing asset secret and COS identity')
        environment.update({name: application[name] for name in extra})
        environment.update(recovery_values)
    return environment


def database_receipt(value, reference, command):
    """Validate and project only non-secret state from the fixed maintenance CLI."""
    require(isinstance(value, dict) and value.get('command') == command and value.get('application') == APPLICATION, 'database maintenance receipt is invalid')
    manifest = reference['manifest']
    if command in ['bootstrap-admin', 'verify-bootstrap-admin']:
        require(value.get('release') == {'version': manifest['version'], 'revision': manifest['revision']}, 'administrator release identity mismatch')
        if command == 'verify-bootstrap-admin' and value.get('uninitialized') is True:
            require(all(key not in value for key in ['administratorId', 'initialized', 'verified']), 'ambiguous uninitialized administrator receipt')
            return {'uninitialized': True}
        flag = 'initialized' if command == 'bootstrap-admin' else 'verified'
        require(value.get('uninitialized') is not True
                and isinstance(value.get('administratorId'), str) and re.fullmatch('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', value['administratorId'])
                and value.get(flag) is True, 'invalid administrator initialization receipt')
        return {'administratorId': value['administratorId'], flag: True}
    if command in ['backup', 'restore', 'verify-restore', 'restore-preflight']:
        require(value.get('release') == {'version': manifest['version'], 'revision': manifest['revision']}, 'recovery release identity mismatch')
        digest_key = 'archiveSha256' if command == 'backup' else 'contentSha256'
        require(isinstance(value.get(digest_key), str) and re.fullmatch('[0-9a-f]{64}', value[digest_key]), 'invalid recovery receipt digest')
        if command == 'backup':
            require(type(value.get('byteLength')) is int and 0 < value['byteLength'] <= MAX_BACKUP_BYTES, 'invalid backup byte count')
            return {digest_key: value[digest_key], 'byteLength': value['byteLength']}
        if command == 'restore-preflight':
            require(value.get('ready') is True and type(value.get('rowCount')) is int and 0 <= value['rowCount'] <= 900000, 'restore preflight did not establish readiness')
            return {digest_key: value[digest_key], 'rowCount': value['rowCount'], 'ready': True}
        if command == 'verify-restore' and value.get('notRestored') is True:
            require(value.get('secretsPrepared') is False and type(value.get('rowCount')) is int and value['rowCount'] == 0
                    and 'verified' not in value and 'restored' not in value, 'ambiguous empty restore target receipt')
            return {digest_key: value[digest_key], 'rowCount': 0, 'secretsPrepared': False, 'notRestored': True}
        require(value.get('notRestored') is not True, 'invalid absence receipt for a restore write')
        require(value.get('secretsPrepared') is True and value.get('restored' if command == 'restore' else 'verified') is True
                and type(value.get('rowCount')) is int and 0 <= value['rowCount'] <= 900000, 'invalid restore verification receipt')
        return {digest_key: value[digest_key], 'rowCount': value['rowCount'], 'secretsPrepared': True}
    require(value.get('release') == {'version': manifest['version'], 'revision': manifest['revision']}
            and value.get('target') == 'production' and value.get('database') == 'qintopia_image'
            and value.get('schema') == 'app' and value.get('secretsVerified') is True, 'database maintenance identity did not match the release')
    expected = manifest['database']['migrations']
    ledger, pending = value.get('ledger'), value.get('pending')
    require(isinstance(ledger, list) and len(ledger) <= len(expected) and isinstance(pending, list), 'invalid database ledger receipt')
    for actual, migration in zip(ledger, expected):
        require(actual == {'version': migration['name'][:4], **migration}, 'database ledger does not match approved migrations')
    require(pending == [item['name'] for item in expected[len(ledger):]], 'database pending migrations are not an approved suffix')
    budget = {'applicationProcesses': 2, 'perApplication': 4, 'maintenance': 1, 'total': 9}
    require(value.get('connectionBudget') == budget and type(value.get('compatible')) is bool, 'database connection or compatibility receipt is invalid')
    require(command == 'preflight' or (not pending and value['compatible']), 'database is not compatible with this release')
    return {'command': command, 'ledgerSha256': hashlib.sha256(json_bytes(ledger)).hexdigest(),
            'version': ledger[-1]['version'] if ledger else None, 'pending': pending,
            'compatible': value['compatible'], 'connectionBudget': 9}


def load_config(path=CONFIG_PATH):
    secure_file(path)
    config = read_json(path)
    require(isinstance(config, dict) and config.get('application') == APPLICATION, 'invalid application configuration')
    required = {'stateDir', 'appRoot', 'nodeBinary', 'environmentFile', 'nginxSite', 'staticDir', 'publicBaseUrl', 'ports', 'cosCredentialsFile', 'cos'}
    require(required.issubset(config), 'incomplete release configuration')
    require(config['ports'] == [4400, 4401], 'unsupported release ports')
    require(config['publicBaseUrl'] == 'https://image.qintopia.cn', 'unexpected public application origin')
    for key in ['stateDir', 'appRoot', 'nodeBinary', 'environmentFile', 'nginxSite', 'staticDir', 'cosCredentialsFile', *[key for key in ['migrationEnvironmentFile', 'recoveryEnvironmentFile'] if key in config]]:
        value = config[key]
        require(isinstance(value, str) and value.startswith('/') and '\n' not in value and '\r' not in value and '..' not in pathlib.PurePosixPath(value).parts, 'invalid managed path')
    require(config['cos'].get('prefix') == 'qintopia-image/releases/', 'invalid release COS prefix')
    for key in ['healthTimeoutSeconds', 'drainTimeoutSeconds']:
        require(isinstance(config.get(key, 30), int) and 1 <= config.get(key, 30) <= 180, 'invalid release timeout')
    secure_file(config['environmentFile'], secret=True)
    if 'migrationEnvironmentFile' in config:
        require(config.get('maintenanceUser') == MAINTENANCE_USER, 'unexpected maintenance OS identity')
        secure_file(config['migrationEnvironmentFile'], secret=True)
    if 'recoveryEnvironmentFile' in config:
        secure_file(config['recoveryEnvironmentFile'], secret=True)
    return config


def identity_args(arguments, *, root=False):
    """Validated twice: before sudo and by the installed isolated interpreter."""
    if arguments in (['status'], ['recover'], ['maintenance'], ['maintenance', 'dry-run'], ['maintenance', 'apply']):
        if arguments == ['recover'] and not root:
            raise ReleaseError('recovery is an administrator operation')
        return arguments
    if arguments == ['bootstrap'] and root:
        return arguments
    if root and len(arguments) == 1 and arguments[0] in ROOT_DATABASE_COMMANDS:
        return arguments
    require(len(arguments) == 5 and arguments[0] in ['deploy', 'rollback'], 'restricted release command required')
    operation, version, revision, prefix, checksum = arguments
    validate_identity(version, revision)
    require(prefix == release_prefix(version, revision), 'release prefix does not match identity')
    require(re.fullmatch('[0-9a-f]{64}', checksum) is not None, 'invalid manifest checksum')
    return [operation, version, revision, prefix, checksum]


class System:
    def database(self, reference, config, command, *, input_fd=None, output_fd=None):
        recovery = command in ['backup', 'restore', 'verify-restore', 'restore-preflight']
        bootstrap = command in ['bootstrap-admin', 'verify-bootstrap-admin']
        require(command in ['preflight', 'migrate', 'verify'] or recovery or bootstrap, 'unsupported database maintenance command')
        environment = maintenance_environment(config, recovery=recovery, restoring=command in ['restore', 'verify-restore', 'restore-preflight'], bootstrap=bootstrap)
        directory = pathlib.Path(reference['path'])
        entry = directory / 'maintenance/cli.mjs'
        secure_file(entry)
        owner = pwd.getpwnam(MAINTENANCE_USER)
        require(owner.pw_uid not in [0, pwd.getpwnam('qintopia-image-app').pw_uid]
                and owner.pw_dir == '/nonexistent' and owner.pw_shell in ['/usr/sbin/nologin', '/sbin/nologin']
                and grp.getgrgid(owner.pw_gid).gr_name == MAINTENANCE_USER
                and set(os.getgrouplist(MAINTENANCE_USER, owner.pw_gid)) == {owner.pw_gid}, 'maintenance OS identity is not restricted')
        try:
            options = {'cwd': directory, 'env': environment, 'umask': 0o077, 'start_new_session': True,
                       'capture_output': True, 'text': True, 'timeout': 180}
            if recovery or bootstrap:
                require(type(input_fd) is int and 3 <= input_fd < 256
                        and (command not in ['restore', 'verify-restore'] or (type(output_fd) is int and 3 <= output_fd < 256)), 'maintenance command requires server-opened file descriptors')
                require(command in ['restore', 'verify-restore'] or output_fd is None, 'unexpected maintenance output descriptor')
                descriptors = (input_fd,) if output_fd is None else (input_fd, output_fd)
                result = subprocess.run([sys.executable, '-I', '-c', FD_LAUNCHER, str(owner.pw_uid), str(owner.pw_gid), str(input_fd),
                                         str(output_fd if output_fd is not None else -1), config['nodeBinary'], str(entry), command],
                                        pass_fds=descriptors, **options)
            else:
                result = subprocess.run([config['nodeBinary'], '--max-old-space-size=256', str(entry), command],
                                        user=owner.pw_uid, group=owner.pw_gid, extra_groups=[], **options)
            if result.returncode != 0:
                raise maintenance_failure(result.stderr)
            require(len(result.stdout) <= 65536, 'database maintenance receipt exceeds the size limit')
            value = json.loads(result.stdout)
        except (OSError, subprocess.TimeoutExpired, ValueError):
            raise ReleaseError('database maintenance unavailable or outcome unknown; inspect the ledger') from None
        return database_receipt(value, reference, command)

    def maintenance_ready(self, origin):
        response = self.run(['curl', '--noproxy', '*', '--silent', '--show-error', '--max-time', '4',
                             '--resolve', 'image.qintopia.cn:443:127.0.0.1', '--write-out', '\n%{http_code}', origin + '/'])
        return response == 'Image service maintenance\n\n503'

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
ExecStart=/usr/bin/env HOSTNAME=127.0.0.1 PORT={reference['port']} APP_RELEASE={reference['releaseId']} {config['nodeBinary']} server.js
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
        self.access_floor_path = self.state_dir / 'access-floor.json'
        self.database_recovery_path = self.state_dir / 'database-recovery.json'
        self.database_bootstrap_path = self.state_dir / 'database-bootstrap.json'
        self.access_floor = read_json(self.access_floor_path) if self.access_floor_path.exists() else None
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
        if self.access_floor is not None:
            require(isinstance(self.access_floor, dict) and set(self.access_floor) == {'schema', 'application', 'assetAccessProtocol', 'database', 'recordedAt'}
                    and self.access_floor['schema'] == 1 and self.access_floor['application'] == APPLICATION
                    and self.access_floor['assetAccessProtocol'] == ACCOUNT_PROTOCOL
                    and self.access_floor['database'] == {'name': 'qintopia_image', 'schema': 'app'}
                    and isinstance(self.access_floor['recordedAt'], str), 'invalid account access floor')
        elif any(is_account_release(reference.get('manifest', {})) for reference in [self.state.get('current'), self.state.get('previous')] if reference):
            raise ReleaseError('account release is missing its persistent access floor')
        if self.state.get('serviceMaintenance'):
            maintenance = self.state['serviceMaintenance']
            require(self.access_floor and isinstance(maintenance, dict)
                    and isinstance(maintenance.get('template'), str) and len(maintenance['template']) <= 131072
                    and maintenance.get('templateSha256') == hashlib.sha256(maintenance['template'].encode()).hexdigest()
                    and isinstance(maintenance.get('siteSha256'), str) and re.fullmatch('[0-9a-f]{64}', maintenance['siteSha256'])
                    and maintenance.get('ready') in [True, False], 'invalid account maintenance state')
        if self.journal:
            require(isinstance(self.journal, dict) and self.journal.get('schema') == 1, 'unsupported release journal')
            require(self.journal.get('phase') in ['preparing', 'staged', 'switching', 'restoring', 'rollback_draining', 'draining', 'old_stopped', 'healthy', 'rolled_back', 'aborted', *DATABASE_PHASES, *SERVICE_PHASES], 'unknown release phase needs operator review')
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
            self.access_floor = read_json(self.access_floor_path) if self.access_floor_path.exists() else None
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
            for key in metadata_fields(manifest['schema']) - {'schema'}:
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
        maintenance = self.state.get('serviceMaintenance')
        try:
            maintenance_ready = maintenance and maintenance.get('ready') and sha256_file(self.config['nginxSite']) == maintenance.get('siteSha256') and self.system.maintenance_ready(self.config['publicBaseUrl'])
        except Exception:
            maintenance_ready = False
        status = 'service-maintenance' if maintenance_ready else 'needs-attention' if maintenance else 'uninitialized' if not current else 'in-progress' if phase in ['preparing', 'staged', 'switching', 'restoring', 'old_stopped', *DATABASE_PHASES, *SERVICE_PHASES] else 'healthy-draining' if phase in ['draining', 'rollback_draining'] and self.healthy(current) else 'healthy' if self.healthy(current) else 'needs-attention'
        if self.access_floor and not maintenance_ready and not is_account_release((current or {}).get('manifest', {})):
            status = 'needs-attention'
        result = {'application': APPLICATION, 'status': status, 'current': current, 'previous': self.state.get('previous'),
                  'transaction': ({key: self.journal.get(key) for key in ['id', 'phase', 'delivery']} if self.journal else None),
                  'protectedPrefixes': sorted({ref['prefix'] for ref in self.protected() if 'prefix' in ref})}
        if self.access_floor:
            result['assetAccessProtocol'] = ACCOUNT_PROTOCOL
        if self.journal and self.journal.get('database'):
            result['database'] = self.journal['database']
        if self.database_recovery_path.exists():
            recovery = read_json(self.database_recovery_path)
            result['databaseRecovery'] = {key: recovery.get(key) for key in ['id', 'phase', 'archiveSha256', 'contentSha256', 'rowCount', 'secretsPrepared'] if key in recovery}
        if self.database_bootstrap_path.exists():
            bootstrap = read_json(self.database_bootstrap_path)
            result['databaseBootstrap'] = {key: bootstrap[key] for key in ['id', 'phase', 'administratorId'] if key in bootstrap}
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
            require(metadata.get('schema') == manifest['schema'], 'runtime release metadata schema mismatch')
            for key in metadata_fields(manifest['schema']):
                require(metadata.get(key) == manifest.get(key), 'runtime metadata differs from manifest')
            policy = read_json(target / 'release-policy.json')
            require(policy.get('databaseMode') == manifest['databaseMode'] and policy.get('rollbackCompatibility', {}).get('mode') in ['compatible', 'forward-only'], 'unsupported release compatibility policy')
            require(policy.get('browserWorkspaceSchema') in ({1, 2} if is_account_release(manifest) else {1}) and policy.get('assetCapabilityVersion') == 1, 'unsupported browser or asset schema')
            require(not self.access_floor or is_account_release(manifest), 'account access floor forbids legacy activation or rollback')
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

    def set_access_floor(self):
        if self.access_floor is None:
            value = {'schema': 1, 'application': APPLICATION, 'assetAccessProtocol': ACCOUNT_PROTOCOL,
                     'database': {'name': 'qintopia_image', 'schema': 'app'}, 'recordedAt': utcnow()}
            atomic_write(self.access_floor_path, json_bytes(value))
            self.access_floor = value

    def compatible_source(self):
        source = self.journal.get('source') if self.journal else self.state.get('current')
        if not source:
            return False
        target = (self.journal or {}).get('target')
        if target:
            source_format, target_format = source.get('manifest', source), target['manifest']
            if source_format.get('browserWorkspaceSchema', 0) < target_format['browserWorkspaceSchema'] or source_format.get('assetCapabilityVersion') != target_format['assetCapabilityVersion']:
                return False
        if not self.access_floor:
            return self.healthy(source)
        if not is_account_release(source.get('manifest', {})):
            return False
        try:
            if not self.healthy(source):
                return False
            self.system.database(source, self.config, 'verify')
            return True
        except Exception:
            return False

    def maintenance_text(self, template):
        for required in ['/etc/letsencrypt/live/image.qintopia.cn/fullchain.pem', '/etc/letsencrypt/live/image.qintopia.cn/privkey.pem', '/var/lib/qintopia-image-acme']:
            require(required in template, 'maintenance must preserve certificate and ACME configuration')
        require('error_page' not in template, 'custom error routing requires operator review before maintenance')
        # Additional proxy/regex locations could continue serving private data.
        locations = re.findall(r'\blocation\s+([^\{]+)\{', template)
        require(all(value.strip() in ['/', '^~ /.well-known/acme-challenge/', '^~ /_next/static/'] for value in locations), 'unreviewed application route prevents safe maintenance')
        roots = re.findall(r'\blocation\s+/\s*\{([^{}]*)\}', template, re.S)
        require(len(roots) == sum(value.strip() == '/' for value in locations)
                and sum('proxy_pass' in body for body in roots) == 1
                and all('proxy_pass' in body or re.fullmatch(r'\s*return\s+301\s+https://\$host\$request_uri\s*;\s*', body) for body in roots),
                'maintenance needs one application location and only the existing HTTPS redirect')
        replacement = '        # qintopia-image-account-maintenance\n        add_header Cache-Control "no-store" always;\n        add_header Retry-After "60" always;\n        return 503 "Image service maintenance\\n";'
        text, count = re.subn(r'(?m)^\s*proxy_pass\s+http://127\.0\.0\.1:(?:4400|4401)\s*;', lambda _: replacement, template)
        require(count == 1 and 'proxy_pass' not in text, 'maintenance must close every image upstream')
        return text

    def enter_service_maintenance(self):
        require(self.access_floor, 'account maintenance requires its access floor')
        self.system.validate_shutdown()
        site = pathlib.Path(self.config['nginxSite'])
        current_sha = sha256_file(site)
        previous = self.state.get('serviceMaintenance')
        if previous:
            template = previous['template']
            require(current_sha in [previous['siteSha256'], previous['templateSha256'], self.journal.get('nginxAfterSha')], 'Nginx changed outside maintenance recovery')
            if previous['ready'] and current_sha == previous['siteSha256'] and self.system.maintenance_ready(self.config['publicBaseUrl']):
                self.phase('service_maintenance')
                return
        else:
            template = self.journal.get('nginxBefore') or site.read_text()
            allowed = [hashlib.sha256(template.encode()).hexdigest(), self.journal.get('nginxAfterSha')]
            require(current_sha in allowed, 'Nginx changed before account maintenance')
        content = self.maintenance_text(template)
        maintenance = {'template': template, 'templateSha256': hashlib.sha256(template.encode()).hexdigest(),
                       'siteSha256': hashlib.sha256(content.encode()).hexdigest(), 'ready': False,
                       'mode': site.stat().st_mode & 0o777, 'recordedAt': utcnow()}
        self.state['serviceMaintenance'] = maintenance
        self.save_state()
        self.journal.setdefault('maintenanceWorkers', self.system.workers())
        self.phase('entering_maintenance')
        atomic_write(site, content.encode(), maintenance['mode'])
        self.system.reload_nginx()
        require(self.system.maintenance_ready(self.config['publicBaseUrl']), 'maintenance response has not been verified')
        maintenance['ready'] = True
        self.save_state()
        self.phase('service_maintenance')

    def stop_unrouted_candidate(self):
        candidate = self.journal.get('target')
        if candidate and self.system.process_matches(candidate):
            workers = self.journal.get('rollbackWorkers') or self.journal.get('maintenanceWorkers') or []
            if (workers and self.system.remaining_workers(workers)) or self.system.connections(candidate['port']):
                return False
            self.system.stop(candidate, self.system.unit_process(candidate))
        return True

    def abort_before_cutover(self):
        if not self.compatible_source():
            self.enter_service_maintenance()
            self.stop_unrouted_candidate()
            return
        if self.state.get('serviceMaintenance'):
            self.restore_source()
            return
        require(self.nginx_port() == self.journal['source']['port'], 'pre-cutover recovery has unexpected live upstream')
        require(self.stop_unrouted_candidate(), 'unrouted candidate still has connections; inspect before stopping')
        self.phase('aborted')

    def prepare_database(self, target):
        if not is_account_release(target['manifest']):
            require(not self.access_floor, 'account access floor forbids legacy activation')
            return
        self.set_access_floor()
        self.journal['database'] = {'preflight': 'pending'}
        self.phase('database_preflight')
        before = self.system.database(target, self.config, 'preflight')
        self.journal['database'] = {'before': before}
        self.phase('database_preflight')
        source = self.journal['source'].get('manifest', {})
        target_database = target['manifest']['database']
        if not is_account_release(source) or source['database']['maxVersion'] < target_database['maxVersion'] or source.get('browserWorkspaceSchema') != target['manifest']['browserWorkspaceSchema'] or self.state.get('serviceMaintenance'):
            self.enter_service_maintenance()
        self.phase('migrating')
        try:
            self.system.database(target, self.config, 'migrate')
        except ReleaseError:
            # A lost COMMIT acknowledgement is resolved by a read-only ledger
            # check. Never blindly issue a second migration command.
            self.journal['database']['migrationReceipt'] = 'unconfirmed'
            self.phase('migrating')
            try:
                after = self.system.database(target, self.config, 'verify')
            except ReleaseError:
                self.abort_before_cutover()
                raise ReleaseError('database migration outcome needs inspection; no migration retry was sent') from None
        else:
            self.journal['database']['migrationReceipt'] = 'confirmed'
            after = self.system.database(target, self.config, 'verify')
        self.journal['database']['after'] = after
        self.phase('database_verified')

    def service_maintenance(self):
        current = self.state.get('current')
        require(current, 'managed release state is required')
        if not self.journal or self.journal['phase'] not in SERVICE_PHASES:
            require(not self.journal or self.journal['phase'] in ['healthy', 'rolled_back', 'aborted'], 'release transaction must be recovered before requesting maintenance')
            self.journal = {'schema': 1, 'id': str(uuid.uuid4()), 'operation': 'service-maintenance',
                            'source': current, 'target': None, 'delivery': 'pending', 'createdAt': utcnow()}
        self.set_access_floor()
        self.enter_service_maintenance()
        workers = self.journal.get('maintenanceWorkers', [])
        require(not workers or not self.system.remaining_workers(workers), 'maintenance is active; wait for existing Nginx requests to drain')
        references = {ref['unit']: ref for ref in self.protected() if self.system.process_matches(ref)}
        for port in self.config['ports']:
            require(not self.system.connections(port), 'maintenance is active; wait for existing application requests to drain')
            if self.system.listening(port):
                require(any(ref['port'] == port for ref in references.values()), 'unmanaged application process prevents safe recovery')
        for reference in references.values():
            self.system.stop(reference, self.system.unit_process(reference))
        self.state['serviceMaintenance']['quiesced'] = True
        self.save_state()
        return self.receipt()

    def recovery_reference(self):
        references = [self.state.get('current'), self.journal and self.journal.get('target')]
        reference = next((ref for ref in references if ref and is_account_release(ref.get('manifest', {}))), None)
        require(reference is not None and self.access_floor, 'a verified account artifact and access floor are required')
        self.validate_reference(reference)
        require(read_json(pathlib.Path(reference['path']) / '.release-receipt.json').get('manifestSha256') == reference['manifestSha256'], 'recovery artifact differs from its installed receipt')
        return reference

    def recovery_secrets_installed(self):
        if not self.database_recovery_path.exists():
            return
        recovery = read_json(self.database_recovery_path)
        if recovery.get('phase') == 'resumed':
            return
        require(recovery.get('phase') != 'not-restored', 'restore was confirmed absent; run database-restore explicitly before deployment')
        require(recovery.get('phase') == 'verified', 'database restore outcome is unconfirmed; use database-verify-restore before any deployment')
        prepared = self.recovery_secret_path(recovery)
        secure_file(prepared, secret=True)
        secrets = read_json(prepared)
        application = read_environment(self.config['environmentFile'])
        require(set(secrets) == {'BETTER_AUTH_SECRET', 'PROVIDER_CONFIG_KEY', 'ASSET_ACCESS_SECRET'} and all(application.get(key) == value for key, value in secrets.items()), 'verified recovery secrets must be installed separately before deployment')

    def recovery_secret_path(self, recovery):
        identifier = recovery.get('id')
        try:
            valid = isinstance(identifier, str) and str(uuid.UUID(identifier)) == identifier
        except (ValueError, AttributeError):
            valid = False
        require(valid, 'invalid recovery transaction UUID')
        return self.state_dir / ('database-secrets-' + identifier + '.json')

    def preserve_recovery_attempt(self, recovery):
        # Validate the UUID through the same fixed derived-path contract.
        self.recovery_secret_path(recovery)
        saved = self.state_dir / ('database-recovery-attempt-' + recovery['id'] + '.json')
        if saved.exists() or saved.is_symlink():
            secure_file(saved, secret=True)
            require(read_json(saved) == recovery, 'previous recovery attempt evidence differs')
        else:
            atomic_write(saved, json_bytes(recovery))

    @staticmethod
    def descriptor_digest(descriptor):
        os.lseek(descriptor, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        while block := os.read(descriptor, 1024 * 1024):
            digest.update(block)
        os.lseek(descriptor, 0, os.SEEK_SET)
        return digest.hexdigest()

    def database_bootstrap_admin(self, verify=False):
        reference = self.recovery_reference()
        self.recovery_secrets_installed()
        source = self.state_dir / 'bootstrap-admin.json'
        secure_file(source, secret=True)
        descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(descriptor)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o777 == 0o600
                    and info.st_nlink == 1 and 0 < info.st_size <= 16384, 'administrator input must be one private regular file')
            def strict_object(pairs):
                value = {}
                for key, item in pairs:
                    require(key not in value, 'administrator input contains duplicate fields')
                    value[key] = item
                return value
            try:
                body = os.read(descriptor, 16385)
                values = json.loads(body.decode('utf-8'), object_pairs_hook=strict_object)
                require(isinstance(values, dict) and set(values) == {'username', 'name', 'password'}
                        and all(isinstance(value, str) for value in values.values()), 'administrator input has invalid fields')
                require(re.fullmatch('[a-z0-9_-]{3,32}', values['username'].strip().lower())
                        and 1 <= len(values['name'].strip().encode('utf-16-le')) // 2 <= 80
                        and 12 <= len(values['password'].encode('utf-16-le')) // 2 <= 128
                        and all('\x00' not in value for value in values.values()), 'administrator input values are invalid')
            except (ValueError, UnicodeError):
                raise ReleaseError('administrator input is invalid JSON') from None
            checksum = hashlib.sha256(body).hexdigest()
            fingerprint_key = read_environment(self.config['environmentFile']).get('BETTER_AUTH_SECRET')
            require(isinstance(fingerprint_key, str) and fingerprint_key, 'administrator input fingerprint requires the existing private Auth secret')
            fingerprint = hmac.new(fingerprint_key.encode(), b'qintopia-image/bootstrap-admin/v1\x00' + body, hashlib.sha256).hexdigest()
            os.lseek(descriptor, 0, os.SEEK_SET)
            previous = read_json(self.database_bootstrap_path) if self.database_bootstrap_path.exists() else None
            if previous:
                if verify:
                    require(previous.get('inputFingerprint') == fingerprint and previous.get('phase') in ['initializing', 'unconfirmed', 'verified', 'not-initialized'],
                            'administrator verification requires the same private input and Auth secret')
                else:
                    require(previous.get('phase') == 'not-initialized', 'administrator initialization was already attempted; use database-verify-bootstrap-admin')
            self.system.database(reference, self.config, 'verify')
            record = previous if verify and previous else {'id': str(uuid.uuid4()), 'phase': 'initializing', 'inputFingerprint': fingerprint,
                                                           'releaseManifestSha256': reference['manifestSha256'], 'createdAt': utcnow()}
            if not verify:
                if previous:
                    require(isinstance(previous.get('id'), str) and re.fullmatch('[0-9a-f-]{36}', previous['id']), 'invalid previous administrator attempt identity')
                    saved = self.state_dir / ('database-bootstrap-attempt-' + previous['id'] + '.json')
                    if saved.exists() or saved.is_symlink():
                        secure_file(saved, secret=True)
                        require(read_json(saved) == previous, 'previous administrator attempt evidence differs')
                    else:
                        atomic_write(saved, json_bytes(previous))
                record['initializationOutcome'] = 'started'
                atomic_write(self.database_bootstrap_path, json_bytes(record))
            command = 'verify-bootstrap-admin' if verify else 'bootstrap-admin'
            try:
                result = self.system.database(reference, self.config, command, input_fd=descriptor)
                require(self.descriptor_digest(descriptor) == checksum and source.stat().st_ino == info.st_ino, 'administrator input changed during initialization')
            except BaseException:
                if not verify:
                    record.update(phase='unconfirmed', initializationOutcome='unconfirmed')
                    atomic_write(self.database_bootstrap_path, json_bytes(record))
                raise ReleaseError('administrator initialization outcome needs read-only database-verify-bootstrap-admin with the same private input') from None
            if result.get('uninitialized') is True:
                for key in ['administratorId', 'initialized', 'verified']:
                    record.pop(key, None)
                record.update(phase='not-initialized', verifiedAt=utcnow())
            else:
                record.update(result, phase='verified', verifiedAt=utcnow())
                if not verify:
                    record['initializationOutcome'] = 'confirmed'
            atomic_write(self.database_bootstrap_path, json_bytes(record))
            return {'application': APPLICATION, 'databaseBootstrap': {key: record[key] for key in ['id', 'phase', 'administratorId'] if key in record}}
        finally:
            os.close(descriptor)

    def database_backup(self):
        reference = self.recovery_reference()
        self.system.database(reference, self.config, 'verify')
        directory = self.state_dir / 'database-backups'
        directory.mkdir(mode=0o700, exist_ok=True)
        require(not directory.is_symlink() and directory.stat().st_uid == os.geteuid() and directory.stat().st_mode & 0o077 == 0, 'backup directory is not private')
        backup_id = str(uuid.uuid4())
        path = directory / (backup_id + '.enc')
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            result = self.system.database(reference, self.config, 'backup', input_fd=descriptor)
            os.fsync(descriptor)
            require(os.fstat(descriptor).st_size == result['byteLength'] and self.descriptor_digest(descriptor) == result['archiveSha256'], 'backup output differs from its receipt')
        except BaseException:
            # Keep an uncertain/partial artifact as private evidence, never
            # report it as a completed backup or overwrite another backup.
            atomic_write(directory / (backup_id + '.json'), json_bytes({'id': backup_id, 'phase': 'unconfirmed'}))
            raise
        finally:
            os.close(descriptor)
        receipt = {'id': backup_id, 'phase': 'complete', **result, 'createdAt': utcnow()}
        atomic_write(directory / (backup_id + '.json'), json_bytes(receipt))
        return {'application': APPLICATION, 'databaseBackup': receipt}

    def database_restore(self, verify=False):
        reference = self.recovery_reference()
        self.service_maintenance()
        source = self.state_dir / 'database-restore.enc'
        secure_file(source, secret=True)
        archive = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        secret_descriptor = None
        try:
            info = os.fstat(archive)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o777 == 0o600
                    and info.st_nlink == 1 and 0 < info.st_size <= MAX_BACKUP_BYTES, 'restore archive is invalid')
            checksum = self.descriptor_digest(archive)
            previous = read_json(self.database_recovery_path) if self.database_recovery_path.exists() else None
            if verify:
                require(previous and previous.get('archiveSha256') == checksum and previous.get('releaseManifestSha256') == reference['manifestSha256']
                        and previous.get('phase') in ['restoring', 'unconfirmed', 'verified', 'not-restored'], 'no matching restore transaction to verify')
                recovery = previous
            else:
                require(not previous or previous.get('phase') in ['verified', 'resumed', 'not-restored'], 'earlier restore is unconfirmed; use database-verify-restore')
                readiness = self.system.database(reference, self.config, 'restore-preflight', input_fd=archive)
                require(self.descriptor_digest(archive) == checksum and source.stat().st_ino == info.st_ino, 'restore input changed during preflight')
                if previous:
                    self.preserve_recovery_attempt(previous)
                recovery = {'id': str(uuid.uuid4()), 'phase': 'restoring', 'archiveSha256': checksum,
                            'releaseManifestSha256': reference['manifestSha256'], 'contentSha256': readiness['contentSha256'],
                            'rowCount': readiness['rowCount'], 'expectedRowCount': readiness['rowCount'],
                            'restoreOutcome': 'started', 'createdAt': utcnow()}
                atomic_write(self.database_recovery_path, json_bytes(recovery))
            prepared = self.recovery_secret_path(recovery)
            secret_descriptor, secret_name = tempfile.mkstemp(prefix='.database-secrets-', dir=self.state_dir)
            os.fchmod(secret_descriptor, 0o600)
            command = 'verify-restore' if verify else 'restore'
            try:
                result = self.system.database(reference, self.config, command, input_fd=archive, output_fd=secret_descriptor)
                require(result['contentSha256'] == recovery['contentSha256'], 'restored content differs from the preflight')
                require(self.descriptor_digest(archive) == checksum and source.stat().st_ino == info.st_ino, 'restore input changed during recovery; preserve evidence and verify before resuming')
                if result.get('notRestored') is True:
                    require(verify and result.get('rowCount') == 0 and result.get('secretsPrepared') is False
                            and os.fstat(secret_descriptor).st_size == 0, 'invalid empty restore confirmation')
                    pathlib.Path(secret_name).unlink()
                    recovery.update(result, phase='not-restored', verifiedAt=utcnow())
                else:
                    require(result['rowCount'] == recovery.get('expectedRowCount', recovery['rowCount']), 'restored row count differs from the preflight')
                    require(0 < os.fstat(secret_descriptor).st_size <= MAX_RECOVERY_SECRETS_BYTES, 'prepared recovery secrets are missing or too large')
                    os.lseek(secret_descriptor, 0, os.SEEK_SET)
                    secrets = json.loads(os.read(secret_descriptor, MAX_RECOVERY_SECRETS_BYTES))
                    require(isinstance(secrets, dict) and set(secrets) == {'BETTER_AUTH_SECRET', 'PROVIDER_CONFIG_KEY', 'ASSET_ACCESS_SECRET'}
                            and all(isinstance(value, str) and 1 <= len(value) <= 4096 and not re.search('[\x00\r\n]', value) for value in secrets.values()), 'prepared recovery secrets are invalid')
                    os.fsync(secret_descriptor)
                    if prepared.exists() or prepared.is_symlink():
                        secure_file(prepared, secret=True)
                        require(sha256_file(prepared) == self.descriptor_digest(secret_descriptor), 'previous prepared secrets differ; preserve both for operator review')
                        pathlib.Path(secret_name).unlink()
                    else:
                        os.replace(secret_name, prepared)
                    recovery.pop('notRestored', None)
                    recovery.update(result, phase='verified', verifiedAt=utcnow())
                    if not verify:
                        recovery['restoreOutcome'] = 'confirmed'
                atomic_write(self.database_recovery_path, json_bytes(recovery))
            except BaseException:
                recovery['phase'] = 'unconfirmed'
                if not verify:
                    recovery['restoreOutcome'] = 'unconfirmed'
                atomic_write(self.database_recovery_path, json_bytes(recovery))
                raise
            return {'application': APPLICATION, 'status': self.receipt()['status'], 'databaseRecovery': recovery,
                    'nextAction': 'run database-restore explicitly after confirming the target is ready' if recovery['phase'] == 'not-restored'
                    else 'review this transaction\'s prepared secrets and install them separately before resuming the application'}
        finally:
            os.close(archive)
            if secret_descriptor is not None:
                os.close(secret_descriptor)

    def switch(self):
        target, source = self.journal['target'], self.journal['source']
        site = pathlib.Path(self.config['nginxSite'])
        self.system.validate_shutdown()
        original = site.read_bytes()
        maintenance = self.state.get('serviceMaintenance')
        if maintenance:
            require(maintenance['ready'] and hashlib.sha256(original).hexdigest() == maintenance['siteSha256'], 'maintenance routing changed before cutover')
            text = maintenance['template']
        else:
            require(self.nginx_port() == source['port'], 'Nginx upstream changed before cutover')
            require(self.compatible_source(), 'previous service is not available for compatible recovery')
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
        if not self.compatible_source():
            self.enter_service_maintenance()
            self.stop_unrouted_candidate()
            return
        site = pathlib.Path(self.config['nginxSite'])
        current_sha = sha256_file(site)
        maintenance = self.state.get('serviceMaintenance')
        before = maintenance['template'] if maintenance else self.journal['nginxBefore']
        require(current_sha in [self.journal.get('nginxBeforeSha'), self.journal.get('nginxAfterSha'), maintenance and maintenance['siteSha256']], 'Nginx changed concurrently; recovery needs review')
        self.journal.update(nginxBefore=before, nginxBeforeSha=hashlib.sha256(before.encode()).hexdigest(), nginxMode=site.stat().st_mode & 0o777)
        self.journal['rollbackWorkers'] = self.system.workers()
        self.journal['candidateProcess'] = self.system.unit_process(self.journal['target'])
        self.phase('restoring')
        atomic_write(site, self.journal['nginxBefore'].encode(), self.journal['nginxMode'])
        self.system.reload_nginx()
        self.state['current'] = self.journal['source']
        self.state.pop('serviceMaintenance', None)
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
        self.state.pop('serviceMaintenance', None)
        self.state['history'] = [item for item in self.state['history'] if item['reference'].get('prefix') != target.get('prefix')]
        self.state['history'].append({'reference': target, 'deployedAt': utcnow()})
        self.save_state()
        if self.database_recovery_path.exists():
            recovery = read_json(self.database_recovery_path)
            if recovery.get('phase') == 'verified':
                recovery.update(phase='resumed', resumedAt=utcnow())
                atomic_write(self.database_recovery_path, json_bytes(recovery))
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
                if is_account_release(self.journal['target']['manifest']):
                    try:
                        after = self.system.database(self.journal['target'], self.config, 'verify')
                        self.journal.setdefault('database', {})['after'] = after
                    except Exception:
                        self.journal.setdefault('database', {})['recoveryVerification'] = 'failed'
                        self.phase('switching')
                        self.restore_source()
                        return self.receipt()
                self.commit_live()
                self.drain()
            else:
                self.restore_source()
        elif phase in ['preparing', 'staged', *DATABASE_PHASES]:
            if phase == 'migrating':
                try:
                    after = self.system.database(self.journal['target'], self.config, 'verify')
                    self.journal.setdefault('database', {})['after'] = after
                    self.journal['database']['migrationReceipt'] = 'recovered-by-read-only-verification'
                    self.phase('database_verified')
                except ReleaseError:
                    self.journal.setdefault('database', {})['migrationReceipt'] = 'still-unconfirmed'
                    self.phase('migrating')
            # Recovery does not reissue migration or publish an unrouted candidate.
            self.abort_before_cutover()
        elif phase in SERVICE_PHASES:
            self.enter_service_maintenance()
            self.stop_unrouted_candidate()
        return self.receipt()

    def deploy(self, operation, version, revision, prefix, checksum):
        identity_args([operation, version, revision, prefix, checksum], root=True)
        self.recovery_secrets_installed()
        current = self.state.get('current')
        require(current, 'adopt the existing service before deploying')
        if self.journal and self.journal['phase'] in ['draining', 'old_stopped', 'switching', 'restoring', 'rollback_draining', *DATABASE_PHASES, *SERVICE_PHASES]:
            self.recover()
        current = self.state['current']
        if current.get('prefix') == prefix and not self.state.get('serviceMaintenance'):
            require(current.get('manifestSha256') == checksum, 'same release identity has different content')
            require(self.healthy(current, public=True), 'current release did not pass identity check')
            return self.receipt()
        if self.journal:
            require(self.journal['phase'] in ['healthy', 'rolled_back', 'aborted', 'service_maintenance'], 'earlier release needs recovery')
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
            require(current.get('manifest', {}).get('rollbackCompatibility', {}).get('mode', 'compatible') == 'compatible'
                    and target['manifest']['rollbackCompatibility']['mode'] == 'compatible', 'release policy forbids rollback')
        source_schema = current.get('manifest', current)
        target_schema = target['manifest']
        annotation_upgrade = operation == 'deploy' and is_account_release(source_schema) and is_account_release(target_schema) \
            and source_schema.get('browserWorkspaceSchema') == 1 and target_schema['browserWorkspaceSchema'] == 2
        require(source_schema.get('assetCapabilityVersion') == target_schema.get('assetCapabilityVersion')
                and (source_schema.get('browserWorkspaceSchema') == target_schema.get('browserWorkspaceSchema') or annotation_upgrade),
                'browser or asset formats are not rollback compatible')
        try:
            self.prepare_database(target)
            if not self.system.process_matches(target):
                self.system.start(target, self.config)
            self.wait_healthy(target)
        except BaseException:
            if self.access_floor:
                self.abort_before_cutover()
            raise
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
        elif operation == 'service-maintenance':
            receipt = runtime.service_maintenance()
        elif operation == 'database-status':
            receipt = {'application': APPLICATION, 'database': runtime.system.database(runtime.recovery_reference(), runtime.config, 'preflight')}
        elif operation == 'database-backup':
            receipt = runtime.database_backup()
        elif operation in ['database-restore', 'database-verify-restore']:
            receipt = runtime.database_restore(verify=operation == 'database-verify-restore')
        elif operation in ['database-bootstrap-admin', 'database-verify-bootstrap-admin']:
            receipt = runtime.database_bootstrap_admin(verify=operation == 'database-verify-bootstrap-admin')
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
