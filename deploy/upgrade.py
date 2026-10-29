#!/usr/bin/env python3
"""Explicit root-only control-plane upgrade; no app, Nginx, credentials or DB writes."""
from __future__ import annotations

import argparse
import ast
import fcntl
import grp
import hashlib
import json
import os
import pathlib
import pwd
import re
import subprocess
import tempfile
import uuid

ROOT_UID = 0
SOURCE = pathlib.Path(__file__).resolve().parent.parent
STATE = pathlib.Path('/var/lib/qintopia-image-release')
INSTALL = pathlib.Path('/opt/qintopia-image-release')
USER = 'qintopia-image-maintenance'
# Destination paths are compiled in. Neither a manifest nor CLI can add a path.
FILES = [
    ('scripts/release/common.py', INSTALL / 'lib/common.py', 0o644),
    ('scripts/release/cos.py', INSTALL / 'lib/cos.py', 0o644),
    ('scripts/release/server.py', INSTALL / 'lib/server.py', 0o644),
    ('deploy/entry.py', INSTALL / 'entry.py', 0o644),
    ('deploy/ssh-entry.py', pathlib.Path('/usr/local/libexec/qintopia-image-ssh-entry'), 0o755),
    ('deploy/qintopia-image-deploy', pathlib.Path('/usr/local/sbin/qintopia-image-deploy'), 0o755),
    ('deploy/qintopia-image-deploy.sudoers', pathlib.Path('/etc/sudoers.d/qintopia-image-deploy'), 0o440),
    ('deploy/qintopia-image-release-recovery.service', pathlib.Path('/etc/systemd/system/qintopia-image-release-recovery.service'), 0o644),
    ('deploy/qintopia-image-release-recovery.timer', pathlib.Path('/etc/systemd/system/qintopia-image-release-recovery.timer'), 0o644),
]


class UpgradeError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise UpgradeError(message)


def secure(path, private=False):
    path = pathlib.Path(path)
    require(path.is_file() and not path.is_symlink(), 'expected a managed regular file')
    info = path.stat()
    require(info.st_uid == ROOT_UID and info.st_nlink == 1 and not info.st_mode & (0o077 if private else 0o022), 'unsafe managed file ownership or permissions')
    for parent in path.parents:
        require(not parent.is_symlink() and parent.stat().st_uid == ROOT_UID and not parent.stat().st_mode & 0o022, 'unsafe managed parent directory')


def digest(path):
    secure(path)
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def atomic(path, data, mode=0o600):
    require(not pathlib.Path(path).is_symlink(), 'refusing to replace a symlink')
    descriptor, temporary = tempfile.mkstemp(prefix='.upgrade-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
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


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def read(path):
    secure(path, private=True)
    try:
        return json.loads(path.read_bytes())
    except (ValueError, UnicodeError):
        raise UpgradeError('invalid upgrade state') from None


def run(arguments):
    try:
        result = subprocess.run(arguments, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'},
                                capture_output=True, timeout=60)
        require(result.returncode == 0, 'control-plane validation failed')
    except (OSError, subprocess.TimeoutExpired):
        raise UpgradeError('control-plane validation outcome unknown') from None


def maintenance_identity(create=False):
    try:
        account = pwd.getpwnam(USER)
    except KeyError:
        if not create:
            return
        run(['useradd', '--system', '--user-group', '--home-dir', '/nonexistent', '--no-create-home', '--shell', '/usr/sbin/nologin', USER])
        account = pwd.getpwnam(USER)
    require(account.pw_uid != 0 and account.pw_dir == '/nonexistent' and account.pw_shell == '/usr/sbin/nologin'
            and grp.getgrgid(account.pw_gid).gr_name == USER and os.getgrouplist(USER, account.pw_gid) == [account.pw_gid], 'maintenance OS identity differs from the reviewed contract')
    if create:
        run(['usermod', '--password', '*', USER])


class Upgrade:
    def __init__(self, source=SOURCE, state=STATE, files=FILES):
        self.source, self.state, self.files = source, state, files
        self.directory = state / 'tool-upgrades'
        self.active = self.directory / 'active.json'

    def plan(self):
        entries = {}
        for relative, destination, _ in self.files:
            entries[str(destination)] = {'oldSha256': digest(destination), 'newSha256': digest(self.source / relative)}
        return {'schema': 1, 'application': 'qintopia-image', 'files': entries}

    def validate_plan(self, value):
        require(isinstance(value, dict) and set(value) == {'schema', 'application', 'files'} and value['schema'] == 1
                and value['application'] == 'qintopia-image' and set(value['files']) == {str(path) for _, path, _ in self.files}, 'unexpected upgrade manifest')
        for item in value['files'].values():
            require(isinstance(item, dict) and set(item) == {'oldSha256', 'newSha256'}
                    and all(isinstance(part, str) and re.fullmatch('[0-9a-f]{64}', part) for part in item.values()), 'invalid reviewed upgrade digest')

    def save(self, journal):
        body = encoded(journal)
        atomic(self.directory / journal['id'] / 'transaction.json', body)
        atomic(self.active, body)

    def validate_source(self):
        requirements = self.source / 'scripts/release/requirements.txt'
        secure(requirements)
        require(requirements.read_text().strip() == 'cos-python-sdk-v5==1.9.38', 'dependency upgrades require a separate reviewed procedure')
        for relative, _, _ in self.files:
            if relative.endswith('.py') or relative == 'deploy/qintopia-image-deploy':
                compile((self.source / relative).read_bytes(), relative, 'exec')
        run(['visudo', '-cf', str(self.source / 'deploy/qintopia-image-deploy.sudoers')])
        units = [self.source / 'deploy' / name for name in ['qintopia-image-release-recovery.service', 'qintopia-image-release-recovery.timer']]
        for unit in units:
            secure(unit)
        run(['systemd-analyze', 'verify', *map(str, units)])
        maintenance_identity()
        run([str(INSTALL / 'venv/bin/python3'), '-I', '-c', "import importlib.metadata; assert importlib.metadata.version('cos-python-sdk-v5') == '1.9.38'"])

    def apply(self, expected):
        self.validate_plan(expected)
        require(self.plan() == expected, 'installed or candidate tools changed after review')
        self.validate_source()
        self.directory.mkdir(mode=0o700, exist_ok=True)
        require(not self.directory.is_symlink() and self.directory.stat().st_uid == ROOT_UID
                and not self.directory.stat().st_mode & 0o077, 'upgrade backup directory must be private')
        if self.active.exists():
            require(read(self.active).get('phase') in ['complete', 'restored'], 'an earlier tool upgrade requires recovery')
        identifier = str(uuid.uuid4())
        backup = self.directory / identifier
        backup.mkdir(mode=0o700)
        modes = []
        for index, (relative, destination, _) in enumerate(self.files):
            atomic(backup / (str(index) + '.old'), destination.read_bytes())
            atomic(backup / (str(index) + '.new'), (self.source / relative).read_bytes())
            modes.append(destination.stat().st_mode & 0o777)
        journal = {'id': identifier, 'phase': 'prepared', 'manifest': expected, 'oldModes': modes}
        self.save(journal)
        try:
            maintenance_identity(create=True)
            require(self.plan() == expected, 'tool files changed while preparing the upgrade')
            journal['phase'] = 'applying'
            self.save(journal)
            for index, (_, destination, mode) in enumerate(self.files):
                require(digest(destination) == expected['files'][str(destination)]['oldSha256'], 'installed tool changed during upgrade')
                candidate = backup / (str(index) + '.new')
                require(digest(candidate) == expected['files'][str(destination)]['newSha256'], 'staged tool checksum changed')
                atomic(destination, candidate.read_bytes(), mode)
            run([str(INSTALL / 'venv/bin/python3'), '-I', '-c', "import sys; sys.path.insert(0,'/opt/qintopia-image-release/lib'); import common,server; assert server.identity_args(['database-status'],root=True) == ['database-status']"])
            run(['systemctl', 'daemon-reload'])
            require(all(digest(path) == expected['files'][str(path)]['newSha256'] for _, path, _ in self.files), 'installed tools failed checksum verification')
            journal['phase'] = 'complete'
            self.save(journal)
        except BaseException as error:
            self.recover()
            raise UpgradeError('tool upgrade failed; previous tools restored and backups retained') from error
        return {'status': 'complete', 'upgradeId': identifier}

    def recover(self):
        journal = read(self.active)
        require(isinstance(journal, dict) and set(journal) == {'id', 'phase', 'manifest', 'oldModes'}
                and isinstance(journal['id'], str) and re.fullmatch('[a-f0-9-]{36}', journal['id'])
                and journal['phase'] in ['prepared', 'applying', 'restoring', 'complete', 'restored'], 'invalid tool upgrade journal')
        self.validate_plan(journal['manifest'])
        require(isinstance(journal['oldModes'], list) and len(journal['oldModes']) == len(self.files)
                and all(type(mode) is int and 0 <= mode <= 0o777 and not mode & 0o022 for mode in journal['oldModes']), 'invalid saved tool modes')
        backup = self.directory / journal['id']
        for index, (_, destination, _) in enumerate(self.files):
            hashes = journal['manifest']['files'][str(destination)]
            require(digest(destination) in hashes.values(), 'tool changed outside this upgrade; retain it and inspect the backups')
            require(digest(backup / (str(index) + '.old')) == hashes['oldSha256'], 'old tool backup failed checksum verification')
        if (self.state / 'access-floor.json').exists():
            compatible = False
            for index, (relative, _, _) in enumerate(self.files):
                if relative == 'scripts/release/server.py':
                    tree = ast.parse((backup / (str(index) + '.old')).read_bytes())
                    compatible = any(isinstance(node, ast.Assign) and any(isinstance(name, ast.Name) and name.id == 'ACCOUNT_PROTOCOL' for name in node.targets)
                                     and isinstance(node.value, ast.Constant) and node.value.value == 'account-private-v1' for node in tree.body)
            require(compatible, 'account access floor forbids recovery to legacy release tools')
        journal['phase'] = 'restoring'
        self.save(journal)
        for index, (_, destination, _) in reversed(list(enumerate(self.files))):
            hashes = journal['manifest']['files'][str(destination)]
            require(digest(destination) in hashes.values(), 'tool changed while restoring; retain backups for operator review')
            atomic(destination, (backup / (str(index) + '.old')).read_bytes(), journal['oldModes'][index])
        run(['systemctl', 'daemon-reload'])
        journal['phase'] = 'restored'
        self.save(journal)
        return {'status': 'restored', 'upgradeId': journal['id']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['plan', 'apply', 'recover'])
    parser.add_argument('--expected', type=pathlib.Path)
    args = parser.parse_args()
    require(os.geteuid() == 0, 'run this reviewed tool as root')
    require((args.operation == 'apply') == (args.expected is not None), '--expected is required only for apply')
    lock_path = STATE / 'release.lock'
    secure(lock_path, private=True)
    with lock_path.open('r+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise UpgradeError('another release or upgrade holds the lock') from None
        upgrade = Upgrade()
        result = upgrade.plan() if args.operation == 'plan' else upgrade.apply(read(args.expected)) if args.operation == 'apply' else upgrade.recover()
        print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (UpgradeError, OSError, ValueError, SyntaxError) as error:
        raise SystemExit('Image release upgrade: ' + (str(error) if isinstance(error, UpgradeError) else 'validation failed; inspect retained upgrade evidence')) from None
