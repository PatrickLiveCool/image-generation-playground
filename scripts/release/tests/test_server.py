import hashlib
import io
import json
import os
import pathlib
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from common import ARCHIVE, METADATA_FIELDS, ReleaseError, json_bytes, release_prefix, sha256_file
from server import Runtime, System, atomic_write, identity_args, read_ack


class FakeSystem:
    def __init__(self, config):
        self.config = config
        self.running = {}
        self.pids = {}
        self.next_pid = 100
        self.old_workers = 0
        self.active_connections = {}
        self.public_wrong = False
        self.reload_failures = 0
        self.reloads = 0
        self.stops = []

    def add(self, ref):
        self.next_pid += 1
        self.running[ref['unit']] = dict(ref)
        self.pids[ref['unit']] = {'pid': self.next_pid, 'start': str(self.next_pid)}

    def process_matches(self, ref):
        return self.running.get(ref['unit'], {}).get('path') == ref['path']

    def unit_process(self, ref):
        return self.pids.get(ref['unit'])

    def listening(self, port):
        return any(ref['port'] == port for ref in self.running.values())

    def get(self, url):
        from urllib.parse import urlparse
        parsed = urlparse(url)
        ref = next((r for r in self.running.values() if r['port'] == parsed.port), None)
        if not ref:
            raise ReleaseError('unavailable')
        if parsed.path == '/':
            return b'old application'
        if parsed.path == '/api/health':
            return b'{"status":"ready"}'
        metadata = {key: ref['manifest'][key] for key in METADATA_FIELDS}
        metadata['managed'] = True
        return json_bytes(metadata)

    def public_get(self, origin, path):
        if self.public_wrong:
            return b'{"version":"wrong"}'
        import re
        port = re.search(r'proxy_pass http://127.0.0.1:(\d+)', pathlib.Path(self.config['nginxSite']).read_text()).group(1)
        return self.get('http://127.0.0.1:' + port + path)

    def workers(self):
        return [{'pid': 3, 'start': '3'}]

    def remaining_workers(self, workers):
        return self.old_workers

    def connections(self, port):
        return self.active_connections.get(port, 0)

    def start(self, ref, config):
        if self.listening(ref['port']):
            raise ReleaseError('occupied')
        self.add(ref)

    def stop(self, ref, expected):
        if ref['unit'] in self.running:
            if not self.process_matches(ref) or self.unit_process(ref) != expected:
                raise ReleaseError('identity changed')
            del self.running[ref['unit']]
            self.pids.pop(ref['unit'], None)
        self.stops.append(ref['releaseId'])

    def reload_nginx(self):
        self.reloads += 1
        if self.reload_failures:
            self.reload_failures -= 1
            raise ReleaseError('test nginx failure')

    def validate_shutdown(self):
        pass


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.temp.name)
        self.root = self.base / 'app'
        (self.root / 'releases').mkdir(parents=True)
        self.config = {'application': 'qintopia-image', 'appRoot': str(self.root), 'stateDir': str(self.base / 'state'),
                       'nginxSite': str(self.base / 'image.conf'), 'staticDir': str(self.root / 'shared-static'),
                       'publicBaseUrl': 'https://image.qintopia.cn', 'ports': [4400, 4401], 'healthTimeoutSeconds': .01}
        self.original = '''server {
 ssl_certificate /etc/letsencrypt/live/image.qintopia.cn/fullchain.pem;
 ssl_certificate_key /etc/letsencrypt/live/image.qintopia.cn/privkey.pem;
 location ^~ /.well-known/acme-challenge/ { root /var/lib/qintopia-image-acme; }
    location / {
        proxy_pass http://127.0.0.1:4401;
        proxy_buffering off;
    }
}
'''
        pathlib.Path(self.config['nginxSite']).write_text(self.original)
        self.legacy = {'legacy': True, 'releaseId': '20261026T031554Z-5b6ede50e6',
                       'path': str(self.root / 'releases/20261026T031554Z-5b6ede50e6'), 'port': 4401,
                       'unit': 'qintopia-image-app-4401.service', 'sourceSha256': 'e' * 64,
                       'browserWorkspaceSchema': 1, 'assetCapabilityVersion': 1}
        old = pathlib.Path(self.legacy['path'])
        (old / '.next/standalone/.next/static').mkdir(parents=True)
        (old / '.next/standalone/.next/static/old-chunk.js').write_text('old')
        (old / 'build-result.json').write_bytes(json_bytes({'release': self.legacy['releaseId'], 'source_sha256': 'e' * 64}))
        (self.root / 'current').symlink_to(old)
        self.config['legacy'] = {key: value for key, value in self.legacy.items() if key not in ['legacy', 'path']}
        self.system = FakeSystem(self.config)
        self.system.add(self.legacy)
        self.bundles = {}
        self.runtime = Runtime(self.config, self.system, self.fetch)
        self.runtime.bootstrap()

    def tearDown(self):
        self.temp.cleanup()

    def bundle(self, version='v0.1.0', revision='a' * 40):
        folder = self.base / ('bundle-' + revision)
        folder.mkdir()
        metadata = {'schema': 1, 'application': 'qintopia-image', 'version': version, 'revision': revision,
                    'platform': 'linux/amd64', 'builtAt': '2026-10-26T00:00:00Z', 'browserWorkspaceSchema': 1, 'assetCapabilityVersion': 1}
        policy = {'application': 'qintopia-image', 'version': version[1:], 'databaseMode': 'none',
                  'browserWorkspaceSchema': 1, 'assetCapabilityVersion': 1, 'rollbackCompatibility': {'mode': 'compatible', 'reason': 'test'}}
        entries = {'server.js': b'console.log("test")', 'package.json': b'{"name":"test"}',
                   'release.json': json_bytes(metadata), 'release-policy.json': json_bytes(policy),
                   '.next/static/chunk-' + revision[:6] + '.js': b'chunk-' + revision.encode()}
        with tarfile.open(folder / ARCHIVE, 'w:gz') as archive:
            for name, content in entries.items():
                item = tarfile.TarInfo(name)
                item.size = len(content)
                item.mode = 0o644
                archive.addfile(item, io.BytesIO(content))
        manifest = {**metadata, 'databaseMode': 'none', 'rollbackCompatibility': policy['rollbackCompatibility'],
                    'archiveSha256': sha256_file(folder / ARCHIVE), 'sbomSha256': 'd' * 64,
                    'releasePolicySha256': hashlib.sha256(entries['release-policy.json']).hexdigest()}
        (folder / 'manifest.json').write_bytes(json_bytes(manifest))
        checksum = sha256_file(folder / 'manifest.json')
        prefix = release_prefix(version, revision)
        self.bundles[prefix] = folder
        return ['deploy', version, revision, prefix, checksum]

    def fetch(self, version, revision, prefix, checksum, destination):
        source = self.bundles[prefix]
        for name in ['manifest.json', ARCHIVE]:
            shutil.copyfile(source / name, destination / name)
        return json.loads((source / 'manifest.json').read_text())

    def test_bootstrap_adopts_legacy_without_restarting_or_changing_nginx(self):
        self.assertTrue(self.runtime.receipt()['current']['legacy'])
        self.assertEqual(self.system.reloads, 0)
        self.assertEqual(self.system.stops, [])
        self.assertEqual(pathlib.Path(self.config['nginxSite']).read_text(), self.original)
        with self.assertRaises(ReleaseError):
            self.runtime.bootstrap()

    def test_release_switches_identity_and_preserves_old_static_chunks(self):
        args = self.bundle()
        result = self.runtime.deploy(*args)
        self.assertEqual(result['status'], 'healthy')
        self.assertEqual(result['current']['port'], 4400)
        self.assertEqual(result['current']['manifest']['revision'], 'a' * 40)
        self.assertEqual(self.runtime.journal['phase'], 'healthy')
        self.assertEqual((self.root / 'shared-static/old-chunk.js').read_text(), 'old')
        self.assertTrue((self.root / 'shared-static/chunk-aaaaaa.js').exists())
        self.assertEqual((self.root / 'current').resolve(), pathlib.Path(result['current']['path']).resolve())
        self.assertEqual(result['previous'], self.legacy)
        self.assertIn('proxy_buffering off', pathlib.Path(self.config['nginxSite']).read_text())

    def test_nginx_validation_failure_restores_original_and_retains_running_source(self):
        self.system.reload_failures = 1
        with self.assertRaises(ReleaseError):
            self.runtime.deploy(*self.bundle())
        self.assertEqual(self.runtime.journal['phase'], 'rolled_back')
        self.assertEqual(pathlib.Path(self.config['nginxSite']).read_text(), self.original)
        self.assertTrue(self.system.process_matches(self.legacy))
        self.assertNotIn(self.legacy['releaseId'], self.system.stops)

    def test_public_identity_failure_never_marks_candidate_live(self):
        self.system.public_wrong = True
        with self.assertRaises(ReleaseError):
            self.runtime.deploy(*self.bundle())
        self.assertEqual(self.runtime.state['current'], self.legacy)
        self.assertEqual(self.runtime.journal['phase'], 'rolled_back')
        self.assertEqual(pathlib.Path(self.config['nginxSite']).read_text(), self.original)

    def test_rollback_preserves_candidate_requests_until_they_drain(self):
        self.system.public_wrong = True
        self.system.old_workers = 1
        with self.assertRaises(ReleaseError):
            self.runtime.deploy(*self.bundle())
        self.assertEqual(self.runtime.journal['phase'], 'rollback_draining')
        self.assertEqual(self.runtime.state['current'], self.legacy)
        self.assertEqual(self.system.stops, [])
        self.system.old_workers = 0
        self.system.active_connections[4400] = 1
        self.runtime.recover()
        self.assertEqual(self.system.stops, [])
        self.system.active_connections[4400] = 0
        self.runtime.recover()
        self.assertEqual(self.runtime.journal['phase'], 'rolled_back')
        self.assertNotIn(self.legacy['releaseId'], self.system.stops)
        self.assertFalse(self.system.listening(4400))

    def test_retry_after_failed_cutover_reuses_immutable_artifact_without_stuck_port(self):
        args = self.bundle()
        self.system.reload_failures = 1
        with self.assertRaises(ReleaseError):
            self.runtime.deploy(*args)
        self.assertFalse(self.system.listening(4400))
        receipt = self.runtime.deploy(*args)
        self.assertEqual(receipt['status'], 'healthy')

    def test_old_workers_and_connections_each_prevent_forced_stop(self):
        self.system.old_workers = 1
        result = self.runtime.deploy(*self.bundle())
        self.assertEqual(result['status'], 'healthy-draining')
        self.assertEqual(self.system.stops, [])
        self.assertEqual((self.root / 'current').resolve(), pathlib.Path(self.legacy['path']).resolve())
        self.runtime.acknowledge('complete')
        self.system.old_workers = 0
        self.system.active_connections[4401] = 1
        self.assertFalse(self.runtime.drain())
        self.assertEqual(self.system.stops, [])
        self.system.active_connections[4401] = 0
        self.runtime.recover()
        self.assertEqual(self.runtime.journal['phase'], 'healthy')
        self.assertEqual(self.system.stops, [self.legacy['releaseId']])

    def test_changed_old_process_cannot_be_terminated(self):
        self.system.old_workers = 1
        self.runtime.deploy(*self.bundle())
        self.system.old_workers = 0
        self.system.pids[self.legacy['unit']] = {'pid': 888, 'start': '888'}
        with self.assertRaises(ReleaseError):
            self.runtime.drain()
        self.assertTrue(self.system.process_matches(self.legacy))

    def test_unknown_delivery_can_retry_exact_identity_but_blocks_new_release(self):
        first = self.bundle()
        self.runtime.deploy(*first)
        self.runtime.acknowledge('unconfirmed')
        self.assertEqual(self.runtime.deploy(*first)['status'], 'healthy')
        with self.assertRaises(ReleaseError):
            self.runtime.deploy(*self.bundle('v0.2.0', 'b' * 40))
        self.runtime.acknowledge('complete')
        second = self.runtime.deploy('deploy', 'v0.2.0', 'b' * 40, release_prefix('v0.2.0', 'b' * 40), sha256_file(self.bundles[release_prefix('v0.2.0', 'b' * 40)] / 'manifest.json'))
        self.assertEqual(second['current']['port'], 4401)

    def test_same_release_checksum_change_is_rejected(self):
        args = self.bundle()
        self.runtime.deploy(*args)
        with self.assertRaises(ReleaseError):
            self.runtime.deploy(*args[:-1], 'f' * 64)

    def test_interrupted_switch_rolls_forward_only_when_exact_target_is_public(self):
        self.system.old_workers = 1
        self.runtime.deploy(*self.bundle())
        self.runtime.journal['phase'] = 'switching'
        self.runtime.state['current'] = self.legacy
        self.runtime.save_state()
        self.runtime.phase('switching')
        resumed = Runtime(self.config, self.system, self.fetch)
        resumed.recover()
        self.assertEqual(resumed.state['current']['manifest']['version'], 'v0.1.0')
        self.assertEqual(resumed.journal['phase'], 'draining')

    def test_external_nginx_change_blocks_automatic_recovery(self):
        self.system.old_workers = 1
        self.runtime.deploy(*self.bundle())
        self.runtime.phase('switching')
        pathlib.Path(self.config['nginxSite']).write_text('operator changed this')
        with self.assertRaises(ReleaseError):
            self.runtime.recover()
        self.assertEqual(pathlib.Path(self.config['nginxSite']).read_text(), 'operator changed this')

    def test_shared_static_same_name_different_bytes_rejected(self):
        source = self.base / 'static-test'
        source.mkdir()
        (source / 'one.js').write_text('one')
        self.runtime.share_static(source)
        (source / 'one.js').write_text('different')
        with self.assertRaises(ReleaseError):
            self.runtime.share_static(source)
        self.assertEqual((self.root / 'shared-static/one.js').read_text(), 'one')

    def test_failed_ack_does_not_remove_candidate_from_maintenance_plan(self):
        refs = []
        for index in range(7):
            args = self.bundle(f'v0.{index+1}.0', format(index+1, 'x') * 40)
            self.runtime.deploy(*args)
            self.runtime.acknowledge('complete')
            refs.append(self.runtime.state['current'])
        result = self.runtime.maintenance(apply=True)
        candidate = next(item for item in result['localReleasePlan'] if item['action'] == 'delete')
        target = self.root / 'releases' / candidate['releaseId']
        self.runtime.finish_maintenance('failed')
        self.assertTrue(target.exists())
        self.runtime.maintenance(apply=True)
        self.runtime.finish_maintenance('complete')
        self.assertFalse(target.exists())
        self.assertTrue(pathlib.Path(self.legacy['path']).exists())
        self.assertTrue((self.root / 'shared-static/old-chunk.js').exists())
        self.assertTrue(pathlib.Path(refs[-1]['path']).exists())
        self.assertTrue(pathlib.Path(refs[-2]['path']).exists())

    def test_recently_used_rollback_target_is_protected_from_cos_retention(self):
        from test_package import fixture_bundle
        from test_cos import FakeSDK, fake_store, add_bundle
        from cos import fetch_bundle, MARKER
        from orchestrate import retention_plan, success_marker
        sdk = FakeSDK()
        identities = {}
        self.runtime.fetcher = lambda version, revision, prefix, checksum, target: fetch_bundle(fake_store(sdk), version, revision, target, checksum)['manifest']
        for number in range(1, 10):
            version, revision = f'v0.{number}.0', format(number, 'x') * 40
            directory, manifest, checksum = fixture_bundle(self.base / 'cos-fixtures', version, revision)
            prefix = add_bundle(sdk, directory, version, revision)
            identities[number] = [version, revision, prefix, checksum]
            if number <= 7:
                self.runtime.deploy('deploy', *identities[number])
                self.runtime.acknowledge('complete')
                sdk.objects[prefix + MARKER] = json_bytes(success_marker(manifest, checksum, f'2026-10-{number:02d}T00:00:00Z'))
        self.runtime.deploy('rollback', *identities[1])
        self.runtime.acknowledge('complete')
        for number in [8, 9]:
            self.runtime.deploy('deploy', *identities[number])
            self.runtime.acknowledge('complete')
            reference = self.runtime.state['current']
            sdk.objects[reference['prefix'] + MARKER] = json_bytes(success_marker(reference['manifest'], reference['manifestSha256'], f'2026-10-{number:02d}T00:00:00Z'))
        receipt = self.runtime.maintenance()
        old_prefix = identities[1][2]
        plan = retention_plan(fake_store(sdk, 'retention'), receipt['protectedPrefixes'])
        self.assertIn(old_prefix, receipt['protectedPrefixes'])
        self.assertFalse(any(item['prefix'] == old_prefix for item in plan['deletions']))
        self.assertEqual(next(item['action'] for item in receipt['localReleasePlan'] if item['releaseId'].startswith('v0.1.0-')), 'keep')

    def test_recovery_does_not_publish_a_prepared_unrouted_candidate(self):
        self.runtime.journal = {'schema': 1, 'id': '00000000-0000-4000-8000-000000000001', 'phase': 'preparing', 'source': self.legacy, 'target': None, 'delivery': 'pending'}
        self.runtime.phase('preparing')
        self.runtime.recover()
        self.assertEqual(self.runtime.journal['phase'], 'aborted')
        self.assertEqual(self.runtime.state['current'], self.legacy)
        self.assertEqual(self.system.reloads, 0)

    def test_lock_excludes_second_mutator(self):
        other = Runtime(self.config, self.system, self.fetch)
        with self.runtime.lock():
            with self.assertRaises(ReleaseError):
                with other.lock():
                    pass

    def test_corrupt_state_paths_or_unknown_phases_block_mutation(self):
        self.runtime.state['current']['path'] = '/unmanaged/application'
        self.runtime.save_state()
        with self.assertRaises(ReleaseError):
            Runtime(self.config, self.system, self.fetch)
        self.runtime.state['current']['path'] = str(self.root / 'releases' / self.legacy['releaseId'])
        self.runtime.save_state()
        self.runtime.journal = {'schema': 1, 'id': '00000000-0000-4000-8000-000000000001', 'source': self.runtime.state['current'], 'target': None}
        self.runtime.phase('unexpected')
        with self.assertRaises(ReleaseError):
            Runtime(self.config, self.system, self.fetch)

    def test_symlink_state_target_cannot_be_overwritten(self):
        outsider = self.base / 'do-not-touch'
        outsider.write_text('important')
        link = self.base / 'link'
        link.symlink_to(outsider)
        with self.assertRaises(ReleaseError):
            atomic_write(link, b'replaced')
        self.assertEqual(outsider.read_text(), 'important')


class AckTest(unittest.TestCase):
    def test_lock_wait_has_no_timeout_while_client_may_still_change_cos(self):
        with patch('server.select.select', return_value=([object()], [], [])) as waiting:
            stream = io.StringIO('ACK complete\n')
            self.assertEqual(read_ack(stream), 'complete')
            self.assertIsNone(waiting.call_args.args[3])

    def test_eof_and_unknown_ack_never_confirm_delivery(self):
        for text in ['', 'ACK yes\n', 'complete\n']:
            with patch('server.select.select', return_value=([object()], [], [])):
                self.assertEqual(read_ack(io.StringIO(text)), 'unconfirmed')


class SystemStopTest(unittest.TestCase):
    def test_new_standby_unit_may_be_absent_but_other_systemctl_errors_stay_errors(self):
        system = System()
        result = type('Result', (), {'returncode': 1, 'stdout': 'LoadState=not-found\nActiveState=inactive\nMainPID=0\nControlGroup=\n'})()
        with patch('server.subprocess.run', return_value=result):
            self.assertEqual(system.properties('qintopia-image-app-4400.service')['LoadState'], 'not-found')
        result.stdout = ''
        with patch('server.subprocess.run', return_value=result):
            with self.assertRaises(ReleaseError):
                system.properties('qintopia-image-app-4400.service')

    def test_sigterm_143_terminal_state_counts_as_stopped_only_without_pid_and_cgroup(self):
        system = System()
        values = {'ActiveState': 'failed', 'MainPID': '0', 'ControlGroup': ''}
        system.properties = lambda unit: values
        commands = []
        system.run = lambda args, **kwargs: commands.append(args) or ''
        system.stop({'unit': 'qintopia-image-app-4401.service'}, {'pid': 1, 'start': '1'})
        self.assertIn(['systemctl', 'reset-failed', 'qintopia-image-app-4401.service'], commands)
        self.assertFalse(any('stop' in item for item in commands))


if __name__ == '__main__':
    unittest.main()
