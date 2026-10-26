"""Update this app from 4400 to 4401 without stopping requests on the old release.

Run stage, then promote, then drain. drain reports pending instead of force-stopping.
status is read-only. No credentials, DNS, certificate files or other vhosts are changed.
"""
import argparse
import inspect
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]


def remote_update(command, release, source_hash):
    import fcntl
    import hashlib
    import json
    import os
    import pathlib
    import pwd
    import re
    import subprocess
    import tempfile
    import time
    import urllib.request

    base = pathlib.Path('/opt/qintopia-image-app')
    target = base / 'releases' / release
    workdir = target / '.next/standalone'
    state_dir = pathlib.Path('/var/lib/qintopia-image-app-deploy')
    state_path = state_dir / (release + '.json')
    backup = state_dir / (release + '.nginx-before.conf')
    vhost = pathlib.Path('/etc/nginx/sites-available/image.qintopia.cn')
    old_unit = 'qintopia-image-app.service'
    new_unit = 'qintopia-image-app-4401.service'
    unit_path = pathlib.Path('/etc/systemd/system') / new_unit

    def run(args):
        return subprocess.run(args, capture_output=True, text=True, timeout=30)

    def require(args):
        result = run(args)
        if result.returncode:
            raise RuntimeError('Command failed: ' + ' '.join(args[:3]))
        return result.stdout.strip()

    def prop(unit, name):
        return require(['systemctl', 'show', unit, '--property=' + name, '--value'])

    def fingerprint(pid):
        try:
            data = pathlib.Path('/proc', str(pid), 'stat').read_text()
            return {'pid': int(pid), 'start': data[data.rfind(')') + 2:].split()[19]}
        except FileNotFoundError:
            return None

    def worker_pids():
        master = prop('nginx.service', 'MainPID')
        children = pathlib.Path('/proc', master, 'task', master, 'children').read_text().split()
        result = []
        for pid in children:
            try:
                if b'nginx: worker process' in pathlib.Path('/proc', pid, 'cmdline').read_bytes():
                    item = fingerprint(pid)
                    if item:
                        result.append(item)
            except FileNotFoundError:
                pass
        if not result:
            raise RuntimeError('Cannot identify existing Nginx workers; refusing cutover')
        return result

    def connections():
        return len(require(['ss', '-Htn', 'state', 'established', '( sport = :4400 )']).splitlines())

    def digest(data):
        return hashlib.sha256(data).hexdigest()

    def atomic_write(path, data, mode=0o600):
        descriptor, temp = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temp, mode)
            os.replace(temp, path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)

    state = json.loads(state_path.read_text()) if state_path.exists() else {}

    def save(phase):
        state.update(release=release, source_sha256=source_hash, phase=phase)
        atomic_write(state_path, (json.dumps(state, indent=2) + '\n').encode())

    def healthy():
        if prop(new_unit, 'ActiveState') != 'active':
            return False
        pid = prop(new_unit, 'MainPID')
        try:
            if pathlib.Path('/proc', pid, 'cwd').resolve(strict=True) != workdir.resolve():
                return False
            for path in ['/', '/llms.txt']:
                with urllib.request.urlopen('http://127.0.0.1:4401' + path, timeout=5) as response:
                    if response.status != 200:
                        return False
                    response.read()
            return True
        except (OSError, ValueError):
            return False

    def report(**extra):
        print(json.dumps({'release': release, 'phase': state.get('phase', 'not_staged'), **extra}))

    if command == 'status':
        report(new_service=prop(new_unit, 'ActiveState'), old_service=prop(old_unit, 'ActiveState'),
               new_healthy=healthy(), old_connections=connections(),
               old_workers_remaining=sum(fingerprint(item['pid']) == item for item in state.get('old_workers', [])),
               current=str((base / 'current').resolve()),
               certbot_timer=prop('certbot.timer', 'ActiveState'))
        return

    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = open(state_dir / 'update.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if state and (state['release'] != release or state['source_sha256'] != source_hash):
        raise RuntimeError('Saved deployment does not match the requested source')
    built = json.loads((target / 'build-result.json').read_text())
    if built.get('status') != 'built' or built.get('release') != release or built.get('source_sha256') != source_hash:
        raise RuntimeError('Linux build result does not match this release and source hash')

    if command == 'stage':
        if state.get('phase') in ['promoted', 'drained']:
            report(new_healthy=healthy())
            return
        if state and state.get('phase') not in ['staged', 'rolled_back']:
            raise RuntimeError('An earlier cutover needs inspection; staging will not overwrite its recovery state')
        if not (workdir / 'server.js').is_file():
            raise RuntimeError('Standalone server is missing')
        current = base / 'current'
        if not current.is_symlink() or current.resolve().parent != base / 'releases':
            raise RuntimeError('Unexpected current release path')
        cache = workdir / '.next/cache'
        cache.mkdir(parents=True, exist_ok=True)
        user = pwd.getpwnam('qintopia-image-app')
        os.chown(cache, user.pw_uid, user.pw_gid)
        os.chmod(cache, 0o700)
        unit = f'''[Unit]
Description=QinTopia image application on port 4401
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=qintopia-image-app
Group=qintopia-image-app
WorkingDirectory={workdir}
EnvironmentFile=/etc/qintopia-image-app/environment
ExecStart=/usr/bin/env PORT=4401 APP_RELEASE={release} /opt/qintopia-image-runtime/bin/node server.js
Restart=on-failure
RestartSec=5
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
'''.encode()
        if unit_path.exists() and unit_path.read_bytes() != unit:
            raise RuntimeError('Port 4401 unit belongs to another release; refusing to overwrite it')
        if not unit_path.exists():
            if require(['ss', '-Hltn', '( sport = :4401 )']):
                raise RuntimeError('Port 4401 is already occupied')
            atomic_write(unit_path, unit, 0o644)
        require(['systemctl', 'daemon-reload'])
        require(['systemctl', 'enable', '--now', new_unit])
        for attempt in range(20):
            if healthy():
                state['old_release'] = str(current.resolve())
                save('staged')
                report(new_healthy=True, port=4401)
                return
            time.sleep(0.5)
        raise RuntimeError('New release failed health checks; old service and Nginx are unchanged')

    if command == 'promote':
        if state.get('phase') in ['promoted', 'drained']:
            if digest(vhost.read_bytes()) != state['nginx_after_sha256'] or not healthy():
                raise RuntimeError('Saved promotion no longer matches the live configuration')
            report(new_healthy=True)
            return
        if state.get('phase') not in ['staged', 'rolled_back', 'promoting'] or not healthy():
            raise RuntimeError('Stage and verify this release before promotion')
        resuming = state.get('phase') == 'promoting'
        if resuming and digest(vhost.read_bytes()) not in [state['nginx_before_sha256'], state['nginx_after_sha256']]:
            raise RuntimeError('Interrupted promotion has an unexpected state; both services are preserved')
        if str((base / 'current').resolve()) != state['old_release']:
            raise RuntimeError('Current symlink changed since staging')
        nginx_dump = require(['nginx', '-T'])
        for value in re.findall(r'^\s*worker_shutdown_timeout\s+([^;]+);', nginx_dump, re.M):
            if value.strip() not in ['0', '0s', '0ms']:
                raise RuntimeError('Nonzero worker_shutdown_timeout may terminate active requests; cutover refused')
        original = backup.read_bytes() if resuming else vhost.read_bytes()
        if resuming and digest(original) != state['nginx_before_sha256']:
            raise RuntimeError('Rollback snapshot changed; both services are preserved')
        text = original.decode()
        for expected in ['/etc/letsencrypt/live/image.qintopia.cn/fullchain.pem', '/etc/letsencrypt/live/image.qintopia.cn/privkey.pem', '/var/lib/qintopia-image-acme']:
            if expected not in text:
                raise RuntimeError('Existing Certbot site configuration differs from the expected deployment')
        changed, count = re.subn(r'(?m)^(\s*proxy_pass\s+http://127\.0\.0\.1:)4400(\s*;)', r'\g<1>4401\2', text)
        if count != 1:
            raise RuntimeError('Expected exactly one image vhost upstream on port 4400')
        if backup.exists() and backup.read_bytes() != original:
            raise RuntimeError('Existing rollback snapshot differs; refusing to replace recovery evidence')
        atomic_write(backup, original)
        if not resuming:
            state.update(old_workers=worker_pids(), old_process=fingerprint(prop(old_unit, 'MainPID')),
                         nginx_before_sha256=digest(original), nginx_after_sha256=digest(changed.encode()),
                         nginx_mode=vhost.stat().st_mode & 0o777)
        if not state['old_process']:
            raise RuntimeError('Old application process is not available for safe rollback')
        save('promoting')
        atomic_write(vhost, changed.encode(), state['nginx_mode'])
        try:
            require(['nginx', '-t'])
            require(['systemctl', 'reload', 'nginx'])
            # Reload signals Nginx asynchronously. A request accepted just after it
            # may still be served by an old worker; wait for new workers to take over.
            verified = False
            for attempt in range(20):
                response = run(['curl', '--noproxy', '*', '--fail', '--silent', '--show-error', '--max-time', '2',
                                '--resolve', 'image.qintopia.cn:443:127.0.0.1', 'https://image.qintopia.cn/llms.txt'])
                if response.returncode == 0 and 'IndexedDB' in response.stdout and healthy():
                    verified = True
                    break
                time.sleep(0.5)
            if not verified:
                raise RuntimeError('New application was not verified through the HTTPS vhost')
        except Exception:
            if digest(vhost.read_bytes()) != state['nginx_after_sha256']:
                save('rollback_requires_review')
                raise RuntimeError('Vhost changed concurrently; both services preserved for review')
            atomic_write(vhost, original, state['nginx_mode'])
            save('rollback_requires_review')
            require(['nginx', '-t'])
            require(['systemctl', 'reload', 'nginx'])
            save('rolled_back')
            raise RuntimeError('Promotion failed; original Nginx configuration restored, both services retained')
        save('promoted')
        report(new_healthy=True, old_service_preserved=True)
        return

    if command == 'drain':
        if state.get('phase') == 'drained':
            report(drained=True)
            return
        if state.get('phase') not in ['promoted', 'old_stopped'] or not healthy():
            raise RuntimeError('Only a healthy promoted deployment may drain the old service')
        allowed_current = [state['old_release']]
        if state.get('phase') == 'old_stopped':
            allowed_current.append(str(target))
        if digest(vhost.read_bytes()) != state['nginx_after_sha256'] or str((base / 'current').resolve()) not in allowed_current:
            raise RuntimeError('Live configuration changed; old service will remain running')
        workers = sum(fingerprint(item['pid']) == item for item in state['old_workers'])
        active = connections()
        if workers or active:
            report(drained=False, old_workers_remaining=workers, old_connections=active)
            return
        previous = base / 'previous'
        if previous.exists() and not previous.is_symlink():
            raise RuntimeError('Previous release path is not a symlink')
        def old_stopped():
            return (prop(old_unit, 'ActiveState') in ['inactive', 'failed']
                    and prop(old_unit, 'MainPID') == '0'
                    and not prop(old_unit, 'ControlGroup'))

        if not old_stopped():
            if state.get('phase') == 'old_stopped' or fingerprint(prop(old_unit, 'MainPID')) != state['old_process']:
                raise RuntimeError('Old process changed; inspect it before stopping anything')
            require(['systemctl', 'stop', old_unit])
        if not old_stopped():
            raise RuntimeError('Old service did not stop; current symlink remains unchanged')
        # Next may exit with code 143 after the intentional SIGTERM. Only clear
        # that terminal status after proving no process, cgroup or connection remains.
        if prop(old_unit, 'ActiveState') == 'failed':
            require(['systemctl', 'reset-failed', old_unit])
        save('old_stopped')
        require(['systemctl', 'disable', old_unit])
        for path, destination in [(previous, state['old_release']), (base / 'current', str(target))]:
            temp = path.with_name('.' + path.name + '-' + release)
            if temp.is_symlink():
                temp.unlink()
            temp.symlink_to(destination)
            os.replace(temp, path)
        save('drained')
        report(drained=True, active_port=4401, previous_release=state['old_release'])


def build_script(command, report):
    release, source_hash = report['release'], report['source_sha256']
    if not re.fullmatch(r'\d{8}T\d{6}Z-[0-9a-f]{10}', release) or not re.fullmatch(r'[0-9a-f]{64}', source_hash):
        raise ValueError('Invalid deployment report')
    if release.rsplit('-', 1)[1] != source_hash[:10]:
        raise ValueError('Release ID does not match source hash')
    return '#!/bin/bash\nset -euo pipefail\npython3 - <<\'UPDATE\'\n' + inspect.getsource(remote_update) + '\nremote_update(' + repr(command) + ', ' + repr(release) + ', ' + repr(source_hash) + ')\nUPDATE\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['stage', 'promote', 'drain', 'status'])
    args = parser.parse_args()
    report = json.loads((ROOT / '.local-ops/image-app/package.json').read_text())
    script = build_script(args.command, report)
    sys.path.insert(0, str(ROOT / 'ops/image-storage'))
    from remote import dispatch
    dispatch('qintopia-image-app-update-' + args.command, script, timeout=180)


if __name__ == '__main__':
    main()
