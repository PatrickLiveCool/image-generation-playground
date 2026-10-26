"""Upgrade only committed common.py under the release lock; never deploy the application."""
from __future__ import annotations

import argparse
import base64
import hashlib
import inspect
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PRIVATE = ROOT / '.local-ops/release-infra'
COMMON = 'scripts/release/common.py'
FILES = [
    COMMON, 'scripts/release/cos.py', 'scripts/release/server.py', 'scripts/release/requirements.txt',
    'deploy/entry.py', 'deploy/ssh-entry.py', 'deploy/qintopia-image-deploy', 'deploy/qintopia-image-deploy.sudoers',
    'deploy/qintopia-image-release-recovery.service', 'deploy/qintopia-image-release-recovery.timer', 'deploy/install.sh',
]


def git_bytes(*args):
    result = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError('Cannot verify the committed upgrade baseline; fetch or reconcile the repository first')
    return result.stdout


def payload(expected_install_revision):
    if not re.fullmatch('[0-9a-f]{40}', expected_install_revision):
        raise RuntimeError('Expected installation revision must be a full commit SHA')
    revision = git_bytes('rev-parse', 'HEAD').decode().strip()
    if not re.fullmatch('[0-9a-f]{40}', revision):
        raise RuntimeError('Current commit identity is invalid')
    result = subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', COMMON], cwd=ROOT, capture_output=True)
    if result.returncode:
        raise RuntimeError('Commit the reviewed common.py before preparing an upgrade')
    old_hashes, new_hashes = {}, {}
    for name in FILES:
        old = git_bytes('show', expected_install_revision + ':' + name)
        new = git_bytes('show', revision + ':' + name)
        old_hashes[name] = hashlib.sha256(old).hexdigest()
        new_hashes[name] = hashlib.sha256(new).hexdigest()
        if name != COMMON and old_hashes[name] != new_hashes[name]:
            raise RuntimeError('This updater permits only common.py changes among installed sources')
    data = git_bytes('show', revision + ':' + COMMON)
    if (ROOT / COMMON).read_bytes() != data:
        raise RuntimeError('Working common.py differs from its committed contents')
    if old_hashes[COMMON] == new_hashes[COMMON]:
        raise RuntimeError('The committed common.py has no change from the installation baseline')
    return {'revision': revision, 'expected_install_revision': expected_install_revision,
            'old_hashes': old_hashes, 'new_hashes': new_hashes,
            'common_base64': base64.b64encode(data).decode()}


def remote_upgrade(mode, request):
    import ast
    import base64
    import fcntl
    import hashlib
    import json
    import os
    import pathlib
    import re
    import subprocess
    import tempfile
    import time

    common_name = 'scripts/release/common.py'
    target = pathlib.Path('/opt/qintopia-image-release/lib/common.py')
    state_dir = pathlib.Path('/var/lib/qintopia-image-release')
    receipt_path = state_dir / 'installation.json'
    timer = 'qintopia-image-release-recovery.timer'
    recovery = 'qintopia-image-release-recovery.service'
    targets = {
        common_name: str(target),
        'scripts/release/cos.py': '/opt/qintopia-image-release/lib/cos.py',
        'scripts/release/server.py': '/opt/qintopia-image-release/lib/server.py',
        'deploy/entry.py': '/opt/qintopia-image-release/entry.py',
        'deploy/ssh-entry.py': '/usr/local/libexec/qintopia-image-ssh-entry',
        'deploy/qintopia-image-deploy': '/usr/local/sbin/qintopia-image-deploy',
        'deploy/qintopia-image-deploy.sudoers': '/etc/sudoers.d/qintopia-image-deploy',
        'deploy/qintopia-image-release-recovery.service': '/etc/systemd/system/qintopia-image-release-recovery.service',
        'deploy/qintopia-image-release-recovery.timer': '/etc/systemd/system/qintopia-image-release-recovery.timer',
    }
    source_names = set(targets) | {'scripts/release/requirements.txt', 'deploy/install.sh'}
    require_hash = re.compile('[0-9a-f]{64}\\Z')
    require_revision = re.compile('[0-9a-f]{40}\\Z')
    stage = 'validate-request'
    replaced = False
    receipt_replaced = False
    rolled_back = False
    lock = None
    timer_before = None
    before = None
    old_common = None
    old_receipt = None
    new_receipt_bytes = None
    outcome = None
    failure = None

    def check(condition, message):
        if not condition:
            raise RuntimeError(message)

    def digest(data):
        return hashlib.sha256(data).hexdigest()

    def safe_file(path, private=False):
        path = pathlib.Path(path)
        check(path.is_file() and not path.is_symlink(), 'Expected a regular root-owned control-plane file')
        stat = path.stat()
        check(stat.st_uid == 0 and not stat.st_mode & 0o022, 'Control-plane file ownership or mode changed')
        if private:
            check(not stat.st_mode & 0o077, 'Private control-plane state permissions changed')
        return path

    def safe_directory(path):
        path = pathlib.Path(path)
        check(path.is_dir() and not path.is_symlink(), 'Expected a real control-plane directory')
        stat = path.stat()
        check(stat.st_uid == 0 and not stat.st_mode & 0o022, 'Control-plane directory permissions changed')
        return path

    def command(args, *, allowed=(0,)):
        result = subprocess.run(args, capture_output=True, text=True, timeout=30,
                                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
        check(result.returncode in allowed, 'Control-plane verification command failed')
        return result.stdout.strip()

    def properties(unit, names):
        output = command(['systemctl', 'show', unit, '--property=' + ','.join(names)])
        return dict(line.split('=', 1) for line in output.splitlines() if '=' in line)

    def timer_state(unit):
        enabled = command(['systemctl', 'is-enabled', unit], allowed=(0, 1))
        props = properties(unit, ['ActiveState', 'SubState'])
        check(enabled in ['enabled', 'disabled', 'static', 'indirect'], 'Unexpected timer enablement state')
        check(props.get('ActiveState') in ['active', 'inactive'], 'Timer has a transitional or failed state')
        return {'enabled': enabled, 'active': props['ActiveState'], 'substate': props.get('SubState')}

    def assert_quiescent():
        props = properties(recovery, ['ActiveState', 'MainPID', 'ControlGroup'])
        check(props.get('ActiveState') in ['inactive', 'failed'] and props.get('MainPID') == '0' and not props.get('ControlGroup'), 'Recovery service is running; upgrade will not interrupt it')
        journal_path = state_dir / 'journal.json'
        if journal_path.exists():
            journal = json.loads(safe_file(journal_path, private=True).read_bytes())
            check(journal.get('schema') == 1 and journal.get('phase') in ['healthy', 'rolled_back', 'aborted'], 'A release transaction is still in flight')
            check(journal.get('phase') != 'healthy' or journal.get('delivery') == 'complete', 'Release delivery still requires confirmation')
        maintenance_path = state_dir / 'maintenance.json'
        if maintenance_path.exists():
            maintenance = json.loads(safe_file(maintenance_path, private=True).read_bytes())
            check(maintenance.get('schema') == 1 and maintenance.get('phase') == 'complete', 'Maintenance is still in flight')

    def snapshot():
        state_bytes = safe_file(state_dir / 'state.json', private=True).read_bytes()
        state = json.loads(state_bytes)
        current = state.get('current') or {}
        unit = current.get('unit')
        check(unit in ['qintopia-image-app-4400.service', 'qintopia-image-app-4401.service'], 'Unexpected application service identity')
        paths = {
            'environment': '/etc/qintopia-image-app/environment',
            'nginx': '/etc/nginx/sites-available/image.qintopia.cn',
            'application_unit': '/etc/systemd/system/' + unit,
            'release_config': '/etc/qintopia-image-release/config.json',
        }
        hashes = {name: digest(safe_file(path, private=name in ['environment', 'release_config']).read_bytes()) for name, path in paths.items()}
        service = properties(unit, ['MainPID', 'ActiveState', 'ActiveEnterTimestampMonotonic', 'ExecMainStartTimestampMonotonic'])
        check(service.get('ActiveState') == 'active' and service.get('MainPID') not in [None, '0'], 'Application is not running')
        pointer = pathlib.Path('/opt/qintopia-image-app/current')
        check(pointer.is_symlink(), 'Current application pointer is not a symlink')
        return {'hashes': hashes, 'service': service, 'current': str(pointer.resolve(strict=True)),
                'current_link': os.readlink(pointer), 'state_sha256': digest(state_bytes), 'certbot': timer_state('certbot.timer')}

    def verify_sources(receipt, expected_hashes, expected_revision):
        check(receipt.get('source_revision') == expected_revision, 'Installed revision differs from the explicitly approved baseline')
        check(receipt.get('source_hashes') == expected_hashes and set(expected_hashes) == source_names, 'Installation source hash manifest differs from the approved baseline')
        bootstrap_revision = receipt.get('bootstrap_source_revision', receipt['source_revision'])
        check(isinstance(bootstrap_revision, str) and require_revision.fullmatch(bootstrap_revision), 'Invalid bootstrap source revision')
        for name, expected in expected_hashes.items():
            destination = targets.get(name) or '/opt/qintopia-image-release-bootstrap/' + bootstrap_revision + '/' + name
            path = safe_file(destination)
            check(digest(path.read_bytes()) == expected, 'Installed source content drifted; no automatic overwrite is allowed')

    def atomic_write(path, data, mode=0o600):
        check(not path.is_symlink(), 'Refusing to replace a symlink')
        descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
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

    def backup(path, data):
        if path.exists() or path.is_symlink():
            check(safe_file(path, private=True).read_bytes() == data, 'Existing backup differs; recovery evidence will not be overwritten')
            return
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())

    def status():
        value = json.loads(command(['/usr/local/sbin/qintopia-image-deploy', 'status']))
        check(value.get('application') == 'qintopia-image' and value.get('status') == 'healthy', 'Root release status did not verify a healthy application')
        return value

    def restore_timer():
        if timer_before is None:
            return
        now = timer_state(timer)
        check(now['enabled'] == timer_before['enabled'], 'Timer enablement changed outside this operation')
        if now['active'] != timer_before['active']:
            check(mode == 'upgrade', 'Recovery timer state changed during the read-only dry-run')
            command(['systemctl', 'start' if timer_before['active'] == 'active' else 'stop', timer])
        check(timer_state(timer) == timer_before, 'Recovery timer state could not be restored exactly')

    try:
        check(os.geteuid() == 0 and mode in ['dry-run', 'upgrade'], 'Run this reviewed operation as root')
        for field in ['revision', 'expected_install_revision']:
            check(isinstance(request.get(field), str) and require_revision.fullmatch(request[field]), 'Invalid source revision')
        check(set(request['old_hashes']) == source_names and set(request['new_hashes']) == source_names, 'Invalid upgrade source set')
        check(all(require_hash.fullmatch(value) for value in [*request['old_hashes'].values(), *request['new_hashes'].values()]), 'Invalid source digest')
        check(all(request['old_hashes'][name] == request['new_hashes'][name] for name in source_names - {common_name}), 'Only common.py may change')
        data = base64.b64decode(request['common_base64'], validate=True)
        check(0 < len(data) < 1024 * 1024 and digest(data) == request['new_hashes'][common_name], 'Upgrade payload digest mismatch')
        check(request['old_hashes'][common_name] != request['new_hashes'][common_name], 'Upgrade contains no change')
        ast.parse(data, filename='common.py')
        safe_directory(state_dir)
        safe_directory(target.parent)
        receipt = json.loads(safe_file(receipt_path, private=True).read_bytes())
        verify_sources(receipt, request['old_hashes'], request['expected_install_revision'])
        timer_before = timer_state(timer)
        if mode == 'upgrade' and timer_before['active'] == 'active':
            stage = 'pause-recovery-timer'
            command(['systemctl', 'stop', timer])
        stage = 'acquire-release-lock'
        lock_path = safe_file(state_dir / 'release.lock')
        lock = os.fdopen(os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW), 'a')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert_quiescent()
        receipt = json.loads(safe_file(receipt_path, private=True).read_bytes())
        verify_sources(receipt, request['old_hashes'], request['expected_install_revision'])
        before = snapshot()
        status()
        if mode == 'dry-run':
            check(before == snapshot(), 'Application changed during dry-run')
            outcome = {'upgrade': 'dry-run-passed', 'source_revision': request['revision'], 'baseline_revision': request['expected_install_revision'], 'application_unchanged': True}
        else:
            stage = 'backup'
            old_common = safe_file(target).read_bytes()
            old_mode = target.stat().st_mode & 0o777
            old_mtime = target.stat().st_mtime
            old_receipt = safe_file(receipt_path, private=True).read_bytes()
            backup_root = state_dir / 'tool-backups'
            if not backup_root.exists():
                backup_root.mkdir(mode=0o700)
            safe_directory(backup_root)
            check(not backup_root.stat().st_mode & 0o077, 'Backup root must be private')
            backup_dir = backup_root / (request['revision'] + '-' + request['new_hashes'][common_name][:12])
            if not backup_dir.exists():
                backup_dir.mkdir(mode=0o700)
            safe_directory(backup_dir)
            check(not backup_dir.stat().st_mode & 0o077, 'Backup directory must be private')
            backup(backup_dir / 'common.py', old_common)
            backup(backup_dir / 'installation.json', old_receipt)
            stage = 'replace-common'
            replaced = True
            atomic_write(target, data, old_mode)
            # Avoid timestamp/size bytecode cache aliasing when two tool installs
            # occur within the same clock second; all other sources are untouched.
            stamp = max(time.time(), old_mtime + 2)
            os.utime(target, (stamp, stamp))
            stage = 'verify-upgraded-status'
            status()
            check(before == snapshot(), 'Application identity/configuration or Certbot changed during the tool upgrade')
            for name, destination in targets.items():
                check(digest(safe_file(destination).read_bytes()) == request['new_hashes'][name], 'Installed tool verification failed')
            stage = 'update-receipt'
            updated = dict(receipt)
            updated.update(source_revision=request['revision'], source_hashes=request['new_hashes'],
                           bootstrap_source_revision=receipt.get('bootstrap_source_revision', receipt['source_revision']),
                           previous_tool_revision=request['expected_install_revision'], tool_upgrade='common.py only',
                           tool_upgrade_backup=str(backup_dir), application_unchanged=True)
            new_receipt_bytes = (json.dumps(updated, sort_keys=True, indent=2) + '\n').encode()
            receipt_replaced = True
            atomic_write(receipt_path, new_receipt_bytes)
            verify_sources(updated, request['new_hashes'], request['revision'])
            check(before == snapshot(), 'Application changed before completing the tool upgrade')
            outcome = {'upgrade': 'verified', 'source_revision': request['revision'], 'previous_tool_revision': request['expected_install_revision'],
                       'changed_files': [common_name], 'installed_files_verified': len(targets), 'application_unchanged': True,
                       'backup': str(backup_dir), 'common_sha256': request['new_hashes'][common_name]}
    except BaseException as error:
        failure = error
        if replaced:
            try:
                actual = digest(safe_file(target).read_bytes())
                check(actual in [request['old_hashes'][common_name], request['new_hashes'][common_name]], 'common.py changed concurrently; automatic rollback refused')
                if actual == request['new_hashes'][common_name]:
                    atomic_write(target, old_common, old_mode)
                if receipt_replaced:
                    actual_receipt = safe_file(receipt_path, private=True).read_bytes()
                    check(actual_receipt in [old_receipt, new_receipt_bytes], 'Installation receipt changed concurrently; rollback requires review')
                    if actual_receipt == new_receipt_bytes:
                        atomic_write(receipt_path, old_receipt)
                rolled_back = True
                status()
                if before is not None:
                    check(before == snapshot(), 'Application changed while restoring the old tool')
            except BaseException:
                failure = RuntimeError('Upgrade failed and recovery needs operator review; backups were retained')
    finally:
        # Restore scheduling while the same lock still excludes application/COS
        # mutations; an immediate timer wake may report busy and retry next minute.
        try:
            restore_timer()
        except BaseException:
            failure = RuntimeError('Recovery timer restoration needs operator review')
            if replaced and not rolled_back:
                try:
                    check(digest(safe_file(target).read_bytes()) == request['new_hashes'][common_name], 'common.py changed concurrently; automatic rollback refused')
                    atomic_write(target, old_common, old_mode)
                    if receipt_replaced:
                        check(safe_file(receipt_path, private=True).read_bytes() == new_receipt_bytes, 'Installation receipt changed concurrently')
                        atomic_write(receipt_path, old_receipt)
                    rolled_back = True
                    status()
                    check(before == snapshot(), 'Application changed while restoring the old tool')
                except BaseException:
                    failure = RuntimeError('Upgrade or timer recovery needs operator review; backups were retained')
            try:
                restore_timer()
            except BaseException:
                pass
        if lock is not None:
            lock.close()
    if failure is not None:
        print(json.dumps({'upgrade': 'failed', 'stage': stage, 'rolled_back': rolled_back,
                          'message': str(failure) if isinstance(failure, RuntimeError) else 'Operation stopped; inspect the saved invocation and backups'}))
        raise SystemExit(1)
    outcome['recovery_timer_restored'] = timer_before
    print(json.dumps(outcome))


def build_script(mode, request):
    return ("#!/bin/bash\nset -euo pipefail\npython3 - <<'UPGRADE'\n" + inspect.getsource(remote_upgrade)
            + '\nremote_upgrade(' + repr(mode) + ', ' + repr(request) + ")\nUPGRADE\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['dry-run', 'upgrade'])
    parser.add_argument('--expected-install-revision', required=True)
    args = parser.parse_args()
    request = payload(args.expected_install_revision)
    source = build_script(args.mode, request)
    if len(source.encode()) >= 60_000:
        raise RuntimeError('TAT upgrade payload is too large')
    PRIVATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    summary = {key: value for key, value in request.items() if key != 'common_base64'}
    plan = PRIVATE / 'common-upgrade-plan.json'
    plan.write_text(json.dumps(summary, indent=2) + '\n')
    plan.chmod(0o600)
    sys.path.insert(0, str(ROOT / 'ops/image-storage'))
    from remote import dispatch
    dispatch('qintopia-image-release-upgrade-common-' + args.mode, source, timeout=240)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error_type': type(error).__name__, 'message': str(error) if isinstance(error, RuntimeError) else 'Upgrade stopped; inspect the saved operation before retrying'}))
        raise SystemExit(1)
