import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from common import ARCHIVE, METADATA_FIELDS, ReleaseError, json_bytes, metadata_fields, release_prefix, sha256_file
from server import FD_LAUNCHER, Runtime, System, atomic_write, database_receipt, identity_args, maintenance_environment, maintenance_failure, read_ack


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
        self.database_calls = []
        self.database_version = '0003'
        self.migration_failure = False
        self.preflight_failure = False
        self.migration_lost_receipt = False
        self.start_failure = False
        self.restore_lost_receipt = False
        self.restore_before_commit_failure = False
        self.restore_content_digest = 'd' * 64
        self.maintenance_probe_failure = False
        self.shutdown_failure = False
        self.shutdown_checks = 0
        self.restored = False
        self.restore_preflight_failure = False
        self.verify_fail_versions = set()
        self.bootstrap_lost_receipt = False
        self.bootstrap_before_commit_failure = False
        self.administrator_id = None
        self.restored_secrets = {name: 'restored-' + name for name in ['BETTER_AUTH_SECRET', 'PROVIDER_CONFIG_KEY', 'ASSET_ACCESS_SECRET']}

    def database(self, ref, config, command, *, input_fd=None, output_fd=None):
        self.database_calls.append((command, pathlib.Path(config['nginxSite']).read_text()))
        if command == 'preflight' and self.preflight_failure:
            raise ReleaseError('synthetic wrong target or missing secret')
        if command == 'verify' and ref['manifest']['version'] in self.verify_fail_versions:
            raise ReleaseError('synthetic incompatible candidate database')
        if command in ['bootstrap-admin', 'verify-bootstrap-admin']:
            if command == 'bootstrap-admin':
                if self.bootstrap_before_commit_failure:
                    raise ReleaseError('synthetic administrator commit never reached database')
                if self.administrator_id:
                    raise ReleaseError('synthetic administrator already exists')
                self.administrator_id = '00000000-0000-4000-8000-000000000007'
                if self.bootstrap_lost_receipt:
                    raise ReleaseError('synthetic lost administrator commit acknowledgement')
            if not self.administrator_id:
                return {'uninitialized': True}
            return {'administratorId': self.administrator_id, 'verified' if command == 'verify-bootstrap-admin' else 'initialized': True}
        if command == 'restore-preflight':
            if self.restore_preflight_failure:
                raise ReleaseError('synthetic invalid archive or nonempty target')
            return {'contentSha256': self.restore_content_digest, 'rowCount': 3, 'ready': True}
        if command == 'backup':
            archive = b'synthetic authenticated-encrypted archive'
            os.write(input_fd, archive)
            return {'archiveSha256': hashlib.sha256(archive).hexdigest(), 'byteLength': len(archive)}
        if command in ['restore', 'verify-restore']:
            if command == 'restore':
                if self.restore_before_commit_failure:
                    raise ReleaseError('synthetic restore commit never reached database')
                self.restored = True
                if self.restore_lost_receipt:
                    raise ReleaseError('synthetic lost restore acknowledgement')
            if not self.restored:
                return {'contentSha256': self.restore_content_digest, 'rowCount': 0, 'secretsPrepared': False, 'notRestored': True}
            os.write(output_fd, json_bytes(self.restored_secrets))
            return {'contentSha256': self.restore_content_digest, 'rowCount': 3, 'secretsPrepared': True}
        if command == 'migrate':
            if self.migration_failure:
                raise ReleaseError('synthetic migration failure')
            self.database_version = ref['manifest']['database']['maxVersion']
            if self.migration_lost_receipt:
                raise ReleaseError('synthetic lost commit acknowledgement')
        compatible = self.database_version == ref['manifest']['database']['maxVersion']
        if command == 'verify' and not compatible:
            raise ReleaseError('synthetic incompatible database')
        return {'command': command, 'ledgerSha256': '4' * 64, 'version': self.database_version,
                'pending': [] if compatible else ['0005-image-annotations.sql'], 'compatible': compatible, 'connectionBudget': 9}

    def maintenance_ready(self, origin):
        if self.maintenance_probe_failure:
            raise ReleaseError('synthetic Nginx is no longer serving maintenance')
        text = pathlib.Path(self.config['nginxSite']).read_text()
        return 'return 503 "Image service maintenance' in text and 'proxy_pass' not in text

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
        metadata = {key: ref['manifest'][key] for key in metadata_fields(ref['manifest']['schema'])}
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
        if self.start_failure:
            raise ReleaseError('synthetic failed process startup')
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
        self.shutdown_checks += 1
        if self.shutdown_failure:
            raise ReleaseError('nonzero worker_shutdown_timeout')


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

    def bundle(self, version='v0.1.0', revision='a' * 40, account=False, rollback='compatible', workspace=1, database_version=None):
        folder = self.base / ('bundle-' + revision)
        folder.mkdir()
        metadata = {'schema': 1, 'application': 'qintopia-image', 'version': version, 'revision': revision,
                    'platform': 'linux/amd64', 'builtAt': '2026-10-26T00:00:00Z', 'browserWorkspaceSchema': 1, 'assetCapabilityVersion': 1}
        policy = {'application': 'qintopia-image', 'version': version[1:], 'databaseMode': 'none',
                  'browserWorkspaceSchema': 1, 'assetCapabilityVersion': 1, 'rollbackCompatibility': {'mode': rollback, 'reason': 'test'}}
        if account:
            source = pathlib.Path(__file__).resolve().parents[3]
            database = json.loads((source / 'deploy/release-policy.json').read_text())['database']
            if database_version:
                database.update(minVersion=database_version, maxVersion=database_version,
                                migrations=[entry for entry in database['migrations'] if entry['name'][:4] <= database_version])
            metadata.update(schema=2, browserWorkspaceSchema=workspace, databaseMode='postgresql', assetAccessProtocol='account-private-v1', database=database)
            policy.update(browserWorkspaceSchema=workspace, databaseMode='postgresql', assetAccessProtocol='account-private-v1', database=database)
        entries = {'server.js': b'console.log("test")', 'package.json': b'{"name":"test"}',
                   'release.json': json_bytes(metadata), 'release-policy.json': json_bytes(policy),
                   '.next/static/chunk-' + revision[:6] + '.js': b'chunk-' + revision.encode()}
        if account:
            entries['maintenance/cli.mjs'] = b'console.log("synthetic maintenance runner")'
            for migration in database['migrations']:
                entries['maintenance/migrations/' + migration['name']] = (source / 'migrations' / migration['name']).read_bytes()
        with tarfile.open(folder / ARCHIVE, 'w:gz') as archive:
            for name, content in entries.items():
                item = tarfile.TarInfo(name)
                item.size = len(content)
                item.mode = 0o644
                archive.addfile(item, io.BytesIO(content))
        manifest = {**metadata, 'databaseMode': policy['databaseMode'], 'rollbackCompatibility': policy['rollbackCompatibility'],
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


    def test_first_account_release_closes_legacy_before_migration_and_records_ledger(self):
        phases = []
        original_phase = self.runtime.phase
        def phase(value):
            phases.append(value)
            return original_phase(value)
        self.runtime.phase = phase
        result = self.runtime.deploy(*self.bundle(account=True))
        self.assertEqual(result['status'], 'healthy')
        self.assertEqual(result['assetAccessProtocol'], 'account-private-v1')
        self.assertTrue(self.runtime.access_floor_path.exists())
        self.assertNotIn('serviceMaintenance', self.runtime.state)
        migration = next(text for command, text in self.system.database_calls if command == 'migrate')
        self.assertIn('return 503', migration)
        self.assertNotIn('proxy_pass', migration)
        self.assertIn('/var/lib/qintopia-image-acme', migration)
        self.assertLess(phases.index('database_preflight'), phases.index('migrating'))
        self.assertLess(phases.index('database_verified'), phases.index('staged'))
        self.assertEqual(result['database']['after']['version'], '0005')

    def test_annotation_upgrade_is_explicit_forward_only_and_keeps_rollback_closed(self):
        source = self.bundle(account=True, workspace=1, database_version='0004')
        self.runtime.deploy(*source)
        self.runtime.acknowledge('complete')
        result = self.runtime.deploy(*self.bundle('v0.2.0', 'b' * 40, account=True, workspace=2))
        self.assertEqual(result['status'], 'healthy')
        self.assertEqual(self.runtime.state['current']['manifest']['browserWorkspaceSchema'], 2)
        self.assertEqual(result['database']['after']['version'], '0005')
        self.runtime.acknowledge('complete')
        current = dict(self.runtime.state['current'])
        site = pathlib.Path(self.config['nginxSite']).read_bytes()
        calls = list(self.system.database_calls)
        with self.assertRaisesRegex(ReleaseError, 'formats are not rollback compatible'):
            self.runtime.deploy('rollback', *source[1:])
        self.assertEqual(self.runtime.state['current'], current)
        self.assertEqual(pathlib.Path(self.config['nginxSite']).read_bytes(), site)
        self.assertEqual(self.system.database_calls, calls)
        self.runtime.recover()
        self.assertEqual(self.runtime.state['current'], current)
        self.assertNotIn('serviceMaintenance', self.runtime.state)

    def test_annotation_failed_upgrade_cannot_restore_schema1_even_when_database_is_compatible(self):
        self.runtime.deploy(*self.bundle(account=True, workspace=1))
        self.runtime.acknowledge('complete')
        source = dict(self.runtime.state['current'])
        self.system.start_failure = True
        with self.assertRaises(ReleaseError):
            self.runtime.deploy(*self.bundle('v0.2.0', 'b' * 40, account=True, workspace=2))
        self.assertEqual(self.runtime.receipt()['status'], 'service-maintenance')
        self.assertEqual(self.runtime.state['current'], source)
        self.assertEqual(self.system.database_version, source['manifest']['database']['maxVersion'])
        self.assertFalse(self.runtime.compatible_source())
        self.assertNotIn('proxy_pass', pathlib.Path(self.config['nginxSite']).read_text())
        restarted = Runtime(self.config, self.system, self.fetch)
        restarted.recover()
        self.assertEqual(restarted.receipt()['status'], 'service-maintenance')
        self.assertFalse(restarted.compatible_source())

    def test_annotation_upgrade_requires_an_existing_account_release(self):
        site = pathlib.Path(self.config['nginxSite']).read_bytes()
        with self.assertRaisesRegex(ReleaseError, 'formats are not rollback compatible'):
            self.runtime.deploy(*self.bundle(account=True, workspace=2))
        self.assertEqual(self.system.database_calls, [])
        self.assertEqual(pathlib.Path(self.config['nginxSite']).read_bytes(), site)

    def test_migration_lost_ack_uses_read_only_verify_without_repeating_ddl(self):
        self.system.migration_lost_receipt = True
        self.runtime.deploy(*self.bundle(account=True))
        commands = [command for command, _ in self.system.database_calls]
        self.assertEqual(commands, ['preflight', 'migrate', 'verify'])
        self.assertEqual(self.runtime.journal['database']['migrationReceipt'], 'unconfirmed')
        self.assertEqual(self.runtime.receipt()['status'], 'healthy')

    def test_failed_first_migration_and_timer_keep_maintenance_instead_of_legacy(self):
        self.system.migration_failure = True
        with self.assertRaises(ReleaseError):
            self.runtime.deploy(*self.bundle(account=True))
        self.assertEqual(self.runtime.receipt()['status'], 'service-maintenance')
        self.assertEqual(self.runtime.state['current'], self.legacy)
        self.assertNotIn('proxy_pass', pathlib.Path(self.config['nginxSite']).read_text())
        restarted = Runtime(self.config, self.system, self.fetch)
        restarted.recover()
        self.assertEqual(restarted.receipt()['status'], 'service-maintenance')
        self.assertEqual(sum(command == 'migrate' for command, _ in self.system.database_calls), 1)

    def test_candidate_start_and_cutover_failure_never_restore_legacy_access(self):
        self.system.start_failure = True
        with self.assertRaises(ReleaseError):
            self.runtime.deploy(*self.bundle(account=True))
        self.assertEqual(self.runtime.receipt()['status'], 'service-maintenance')
        self.system.start_failure = False
        self.system.public_wrong = True
        with self.assertRaises(ReleaseError):
            self.runtime.deploy(*self.bundle('v0.2.0', 'b' * 40, account=True))
        self.assertEqual(self.runtime.receipt()['status'], 'service-maintenance')
        self.assertNotIn('proxy_pass', pathlib.Path(self.config['nginxSite']).read_text())

    def test_account_floor_rejects_old_release_and_incompatible_database_rollback(self):
        old_args = self.bundle()
        self.runtime.deploy(*old_args)
        self.runtime.acknowledge('complete')
        self.runtime.deploy(*self.bundle('v0.2.0', 'b' * 40, account=True))
        self.runtime.acknowledge('complete')
        with self.assertRaisesRegex(ReleaseError, 'access floor'):
            self.runtime.deploy('rollback', *old_args[1:])
        self.runtime.recover()
        self.runtime.acknowledge('complete')
        self.assertEqual(self.runtime.state['current']['version'], 'v0.2.0')
        self.assertEqual(self.runtime.nginx_port(), self.runtime.state['current']['port'])

    def test_forward_only_current_account_release_rejects_compatible_rollback_without_cutover(self):
        first = self.bundle(account=True)
        self.runtime.deploy(*first)
        self.runtime.acknowledge('complete')
        self.runtime.deploy(*self.bundle('v0.2.0', 'b' * 40, account=True, rollback='forward-only'))
        self.runtime.acknowledge('complete')
        current = dict(self.runtime.state['current'])
        site = pathlib.Path(self.config['nginxSite']).read_bytes()
        calls = list(self.system.database_calls)
        with self.assertRaisesRegex(ReleaseError, 'policy forbids rollback'):
            self.runtime.deploy('rollback', *first[1:])
        self.assertEqual(self.runtime.state['current'], current)
        self.assertEqual(pathlib.Path(self.config['nginxSite']).read_bytes(), site)
        self.assertEqual(self.system.database_calls, calls)

    def test_failed_account_candidate_restores_only_verified_account_source(self):
        self.runtime.deploy(*self.bundle(account=True))
        self.runtime.acknowledge('complete')
        source = self.runtime.state['current']
        self.system.public_wrong = True
        with self.assertRaises(ReleaseError):
            self.runtime.deploy(*self.bundle('v0.2.0', 'b' * 40, account=True))
        self.assertEqual(self.runtime.state['current'], source)
        self.assertEqual(self.runtime.nginx_port(), source['port'])
        self.assertEqual(self.runtime.journal['phase'], 'rolled_back')
        self.assertGreaterEqual(sum(command == 'verify' for command, _ in self.system.database_calls), 3)

    def test_migrating_recovery_reads_ledger_but_does_not_activate_candidate(self):
        args = self.bundle(account=True)
        self.runtime.journal = {'schema': 1, 'id': '00000000-0000-4000-8000-000000000001', 'phase': 'preparing', 'source': self.legacy, 'target': None, 'delivery': 'pending'}
        target = self.runtime.prepare(*args[1:], 4400)
        self.runtime.journal['target'] = target
        self.runtime.set_access_floor()
        self.runtime.enter_service_maintenance()
        self.runtime.phase('migrating')
        self.system.database_version = '0005'
        restarted = Runtime(self.config, self.system, self.fetch)
        restarted.recover()
        self.assertEqual([command for command, _ in self.system.database_calls], ['verify'])
        self.assertEqual(restarted.receipt()['status'], 'service-maintenance')
        self.assertFalse(self.system.process_matches(target))

    def test_first_account_preflight_failure_closes_legacy_without_migration(self):
        self.system.preflight_failure = True
        with self.assertRaises(ReleaseError):
            self.runtime.deploy(*self.bundle(account=True))
        self.assertEqual(self.runtime.receipt()['status'], 'service-maintenance')
        self.assertEqual([command for command, _ in self.system.database_calls], ['preflight'])
        self.assertTrue(self.runtime.access_floor_path.exists())

    def test_recovered_first_account_cutover_closes_live_target_when_database_verify_fails(self):
        with patch.object(self.runtime, 'commit_live', side_effect=InterruptedError('synthetic process interruption')):
            with self.assertRaises(InterruptedError):
                self.runtime.deploy(*self.bundle(account=True))
        candidate = self.runtime.journal['target']
        self.assertEqual(self.runtime.nginx_port(), candidate['port'])
        self.assertTrue(self.runtime.healthy(candidate, public=True))
        self.system.verify_fail_versions.add(candidate['version'])
        resumed = Runtime(self.config, self.system, self.fetch)
        result = resumed.recover()
        self.assertEqual(result['status'], 'service-maintenance')
        self.assertEqual(resumed.state['current'], self.legacy)
        self.assertNotIn('proxy_pass', pathlib.Path(self.config['nginxSite']).read_text())
        self.assertFalse(self.system.process_matches(candidate))

    def test_recovered_account_cutover_restores_only_verified_compatible_source(self):
        self.runtime.deploy(*self.bundle(account=True))
        self.runtime.acknowledge('complete')
        source = self.runtime.state['current']
        with patch.object(self.runtime, 'commit_live', side_effect=InterruptedError('synthetic process interruption')):
            with self.assertRaises(InterruptedError):
                self.runtime.deploy(*self.bundle('v0.2.0', 'b' * 40, account=True))
        candidate = self.runtime.journal['target']
        self.assertTrue(self.runtime.healthy(candidate, public=True))
        self.system.verify_fail_versions.add(candidate['version'])
        resumed = Runtime(self.config, self.system, self.fetch)
        resumed.recover()
        self.assertEqual(resumed.journal['phase'], 'rolled_back')
        self.assertEqual(resumed.state['current'], source)
        self.assertEqual(resumed.nginx_port(), source['port'])
        self.assertFalse(self.system.process_matches(candidate))

    def test_recovered_account_cutover_closes_both_incompatible_versions(self):
        self.runtime.deploy(*self.bundle(account=True))
        self.runtime.acknowledge('complete')
        with patch.object(self.runtime, 'commit_live', side_effect=InterruptedError('synthetic process interruption')):
            with self.assertRaises(InterruptedError):
                self.runtime.deploy(*self.bundle('v0.2.0', 'b' * 40, account=True))
        self.system.verify_fail_versions.update(['v0.1.0', 'v0.2.0'])
        resumed = Runtime(self.config, self.system, self.fetch)
        self.assertEqual(resumed.recover()['status'], 'service-maintenance')
        self.assertNotIn('proxy_pass', pathlib.Path(self.config['nginxSite']).read_text())

    def test_maintenance_preserves_existing_http_redirect_and_tls_acme_routes(self):
        redirect = 'server {\n listen 80;\n location / { return 301 https://$host$request_uri; }\n}\n'
        original = redirect + self.original
        pathlib.Path(self.config['nginxSite']).write_text(original)
        self.system.preflight_failure = True
        with self.assertRaises(ReleaseError):
            self.runtime.deploy(*self.bundle(account=True))
        content = pathlib.Path(self.config['nginxSite']).read_text()
        self.assertIn(redirect, content)
        self.assertIn('/etc/letsencrypt/live/image.qintopia.cn/fullchain.pem', content)
        self.assertIn('location ^~ /.well-known/acme-challenge/', content)
        self.assertNotIn('proxy_pass', content)
        self.assertEqual(self.runtime.receipt()['status'], 'service-maintenance')

    def account_recovery(self):
        args = self.bundle(account=True)
        self.runtime.deploy(*args)
        self.runtime.acknowledge('complete')
        archive = self.runtime.state_dir / 'database-restore.enc'
        archive.write_bytes(b'synthetic authenticated-encrypted archive')
        archive.chmod(0o600)
        environment = self.base / 'application.env'
        environment.write_text('ASSET_ACCESS_SECRET=existing-asset-secret\n')
        environment.chmod(0o600)
        self.config['environmentFile'] = str(environment)
        original_stat = os.fstat
        def root_stat(descriptor):
            values = list(original_stat(descriptor))
            values[4] = 0
            return os.stat_result(values)
        # Simulated root descriptors only; no local users or DB are changed.
        ownership = patch('server.os.fstat', side_effect=root_stat)
        secure = patch('server.secure_file')
        ownership.start()
        secure.start()
        self.addCleanup(ownership.stop)
        self.addCleanup(secure.stop)
        return args, environment

    def test_encrypted_backup_slots_are_unique_private_and_receipt_verified(self):
        self.account_recovery()
        first = self.runtime.database_backup()['databaseBackup']
        second = self.runtime.database_backup()['databaseBackup']
        self.assertNotEqual(first['id'], second['id'])
        files = list((self.runtime.state_dir / 'database-backups').glob('*.enc'))
        self.assertEqual(len(files), 2)
        self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in files))
        self.assertEqual(first['archiveSha256'], sha256_file(files[0]))

    def test_restore_unknown_commit_requires_read_only_verify_and_separate_secret_install(self):
        args, environment = self.account_recovery()
        self.system.restore_lost_receipt = True
        with self.assertRaises(ReleaseError):
            self.runtime.database_restore()
        self.assertEqual(self.runtime.receipt()['status'], 'service-maintenance')
        self.assertFalse(self.system.running)
        with self.assertRaisesRegex(ReleaseError, 'earlier restore is unconfirmed'):
            self.runtime.database_restore()
        with self.assertRaisesRegex(ReleaseError, 'outcome is unconfirmed'):
            self.runtime.deploy(*args)
        self.runtime.database_restore(verify=True)
        self.assertEqual([command for command, _ in self.system.database_calls].count('restore'), 1)
        self.assertEqual([command for command, _ in self.system.database_calls].count('verify-restore'), 1)
        self.assertEqual(environment.read_text(), 'ASSET_ACCESS_SECRET=existing-asset-secret\n')
        recovery = json.loads(self.runtime.database_recovery_path.read_text())
        self.assertEqual(json.loads(self.runtime.recovery_secret_path(recovery).read_text()), self.system.restored_secrets)
        self.assertNotIn('restored-ASSET_ACCESS_SECRET', json.dumps(self.runtime.receipt()))
        with self.assertRaisesRegex(ReleaseError, 'installed separately'):
            self.runtime.deploy(*args)
        environment.write_text(''.join(key + '=' + value + '\n' for key, value in self.system.restored_secrets.items()))
        self.runtime.deploy(*args)
        self.assertEqual(self.runtime.receipt()['status'], 'healthy')
        self.assertEqual(self.runtime.receipt()['databaseRecovery']['phase'], 'resumed')

    def test_rejected_restore_preflight_can_be_corrected_without_unknown_write_latch(self):
        self.account_recovery()
        self.system.restore_preflight_failure = True
        with self.assertRaisesRegex(ReleaseError, 'invalid archive or nonempty target'):
            self.runtime.database_restore()
        self.assertEqual(self.runtime.receipt()['status'], 'service-maintenance')
        self.assertFalse(self.runtime.database_recovery_path.exists())
        self.assertNotIn('restore', [command for command, _ in self.system.database_calls])
        self.assertTrue((self.runtime.state_dir / 'database-restore.enc').exists())
        self.system.restore_preflight_failure = False
        self.runtime.database_restore()
        self.assertEqual(self.runtime.receipt()['databaseRecovery']['phase'], 'verified')

    def test_empty_target_verification_allows_only_new_explicit_restore_and_preserves_attempt(self):
        self.account_recovery()
        self.system.restore_before_commit_failure = True
        with self.assertRaises(ReleaseError):
            self.runtime.database_restore()
        original = json.loads(self.runtime.database_recovery_path.read_text())
        with self.assertRaisesRegex(ReleaseError, 'earlier restore is unconfirmed'):
            self.runtime.database_restore()
        self.system.restore_before_commit_failure = False
        result = self.runtime.database_restore(verify=True)
        self.assertEqual(result['databaseRecovery']['phase'], 'not-restored')
        self.assertFalse(result['databaseRecovery']['secretsPrepared'])
        self.assertEqual(result['databaseRecovery']['rowCount'], 0)
        self.assertEqual([command for command, _ in self.system.database_calls].count('restore'), 1)
        self.assertFalse(self.runtime.recovery_secret_path(original).exists())
        self.assertFalse(self.system.restored)
        with self.assertRaisesRegex(ReleaseError, 'restore was confirmed absent'):
            self.runtime.recovery_secrets_installed()
        self.runtime.database_restore()
        latest = json.loads(self.runtime.database_recovery_path.read_text())
        self.assertNotEqual(latest['id'], original['id'])
        self.assertEqual(latest['phase'], 'verified')
        self.assertEqual([command for command, _ in self.system.database_calls].count('restore'), 2)
        evidence = self.runtime.state_dir / ('database-recovery-attempt-' + original['id'] + '.json')
        saved = json.loads(evidence.read_text())
        self.assertEqual(saved['phase'], 'not-restored')
        self.assertEqual(saved['restoreOutcome'], 'unconfirmed')

    def test_separate_restore_transactions_keep_distinct_secrets_and_receipts(self):
        _, environment = self.account_recovery()
        self.runtime.database_restore()
        previous = json.loads(self.runtime.database_recovery_path.read_text())
        previous_file = self.runtime.recovery_secret_path(previous)
        previous_bytes = previous_file.read_bytes()
        # Model an operator-provided empty disaster target, not any server-side
        # clearing. Both attempts still use the fixed project target contract.
        self.system.restored = False
        self.system.restore_content_digest = 'e' * 64
        self.system.restored_secrets = {key: 'second-' + value for key, value in self.system.restored_secrets.items()}
        (self.runtime.state_dir / 'database-restore.enc').write_bytes(b'synthetic second authenticated-encrypted archive')
        self.runtime.database_restore()
        latest = json.loads(self.runtime.database_recovery_path.read_text())
        self.assertNotEqual(self.runtime.recovery_secret_path(latest), previous_file)
        self.assertEqual(previous_file.read_bytes(), previous_bytes)
        self.assertEqual(json.loads(self.runtime.recovery_secret_path(latest).read_text()), self.system.restored_secrets)
        self.assertEqual(json.loads((self.runtime.state_dir / ('database-recovery-attempt-' + previous['id'] + '.json')).read_text()), previous)
        first_secrets = json.loads(previous_bytes)
        environment.write_text(''.join(key + '=' + value + '\n' for key, value in first_secrets.items()))
        with self.assertRaisesRegex(ReleaseError, 'installed separately'):
            self.runtime.recovery_secrets_installed()
        environment.write_text(''.join(key + '=' + value + '\n' for key, value in self.system.restored_secrets.items()))
        self.runtime.recovery_secrets_installed()
        with self.assertRaisesRegex(ReleaseError, 'transaction UUID'):
            self.runtime.recovery_secret_path({'id': '../outside'})

    def test_unicode_recovery_secrets_larger_than_16k_fit_the_64k_private_slot(self):
        self.account_recovery()
        self.system.restored_secrets.update(BETTER_AUTH_SECRET='密' * 4096, ASSET_ACCESS_SECRET='钥' * 4096)
        self.assertGreater(len(json_bytes(self.system.restored_secrets)), 16384)
        self.runtime.database_restore()
        recovery = json.loads(self.runtime.database_recovery_path.read_text())
        self.assertEqual(json.loads(self.runtime.recovery_secret_path(recovery).read_text()), self.system.restored_secrets)

    def bootstrap_input(self):
        _, environment = self.account_recovery()
        with environment.open('a') as stream:
            stream.write('BETTER_AUTH_SECRET=synthetic-auth-secret-for-bootstrap-fingerprint\n')
        path = self.runtime.state_dir / 'bootstrap-admin.json'
        path.write_bytes(json_bytes({'username': 'initial-admin', 'name': 'Initial Admin', 'password': 'synthetic-password-123'}))
        path.chmod(0o600)
        return path

    def test_administrator_initialization_is_verified_first_and_never_switches_application(self):
        self.bootstrap_input()
        before_site = pathlib.Path(self.config['nginxSite']).read_bytes()
        before_current = dict(self.runtime.state['current'])
        self.system.database_calls.clear()
        result = self.runtime.database_bootstrap_admin()
        self.assertEqual([command for command, _ in self.system.database_calls], ['verify', 'bootstrap-admin'])
        self.assertEqual(result['databaseBootstrap']['phase'], 'verified')
        self.assertEqual(pathlib.Path(self.config['nginxSite']).read_bytes(), before_site)
        self.assertEqual(self.runtime.state['current'], before_current)
        output = json.dumps([result, self.runtime.receipt()])
        self.assertNotIn('synthetic-password', output)
        self.assertNotIn('inputSha256', output)
        self.assertNotIn('inputFingerprint', output)
        with self.assertRaisesRegex(ReleaseError, 'already attempted'):
            self.runtime.database_bootstrap_admin()

    def test_unknown_administrator_commit_only_allows_read_only_same_input_verification(self):
        path = self.bootstrap_input()
        original = path.read_bytes()
        self.system.bootstrap_lost_receipt = True
        with self.assertRaisesRegex(ReleaseError, 'read-only database-verify-bootstrap-admin'):
            self.runtime.database_bootstrap_admin()
        self.assertEqual(self.runtime.receipt()['databaseBootstrap']['phase'], 'unconfirmed')
        with self.assertRaises(ReleaseError):
            self.runtime.database_bootstrap_admin()
        path.write_bytes(original.replace(b'synthetic-password-123', b'different-password-123'))
        with self.assertRaisesRegex(ReleaseError, 'same private input'):
            self.runtime.database_bootstrap_admin(verify=True)
        path.write_bytes(original)
        self.runtime.database_bootstrap_admin(verify=True)
        commands = [command for command, _ in self.system.database_calls]
        self.assertEqual(commands.count('bootstrap-admin'), 1)
        self.assertEqual(commands.count('verify-bootstrap-admin'), 1)
        self.assertEqual(self.runtime.receipt()['databaseBootstrap']['phase'], 'verified')

    def test_invalid_administrator_input_is_rejected_before_database_or_journal(self):
        path = self.bootstrap_input()
        self.system.database_calls.clear()
        for body in [b'{"username":"admin","name":"Admin","password":"short"}',
                     b'{"username":"admin","name":"Admin","password":"synthetic-password","role":"admin"}',
                     b'{"username":"admin","name":"Admin","password":"synthetic-password","password":"duplicate-secret"}']:
            path.write_bytes(body)
            with self.assertRaises(ReleaseError):
                self.runtime.database_bootstrap_admin()
            self.assertFalse(self.runtime.database_bootstrap_path.exists())
        self.assertEqual(self.system.database_calls, [])

    def test_absent_admin_confirmation_allows_only_a_new_explicit_initialization_attempt(self):
        self.bootstrap_input()
        self.system.bootstrap_before_commit_failure = True
        with self.assertRaises(ReleaseError):
            self.runtime.database_bootstrap_admin()
        original = json.loads(self.runtime.database_bootstrap_path.read_text())
        with self.assertRaisesRegex(ReleaseError, 'already attempted'):
            self.runtime.database_bootstrap_admin()
        self.system.bootstrap_before_commit_failure = False
        receipt = self.runtime.database_bootstrap_admin(verify=True)
        self.assertEqual(receipt['databaseBootstrap']['phase'], 'not-initialized')
        self.assertNotIn('administratorId', receipt['databaseBootstrap'])
        self.assertIsNone(self.system.administrator_id)
        self.assertEqual([command for command, _ in self.system.database_calls].count('bootstrap-admin'), 1)
        self.runtime.database_bootstrap_admin()
        self.assertEqual([command for command, _ in self.system.database_calls].count('bootstrap-admin'), 2)
        current = json.loads(self.runtime.database_bootstrap_path.read_text())
        self.assertEqual(current['phase'], 'verified')
        self.assertNotEqual(current['id'], original['id'])
        saved = self.runtime.state_dir / ('database-bootstrap-attempt-' + original['id'] + '.json')
        preserved = json.loads(saved.read_text())
        self.assertEqual(preserved['phase'], 'not-initialized')
        self.assertEqual(preserved['initializationOutcome'], 'unconfirmed')
        self.assertEqual(preserved['inputFingerprint'], original['inputFingerprint'])
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)

    def test_bootstrap_input_fingerprint_is_keyed_and_never_exposes_a_plain_password_digest(self):
        path = self.bootstrap_input()
        self.system.bootstrap_before_commit_failure = True
        with self.assertRaises(ReleaseError):
            self.runtime.database_bootstrap_admin()
        record = json.loads(self.runtime.database_bootstrap_path.read_text())
        self.assertIn('inputFingerprint', record)
        self.assertNotIn('inputSha256', record)
        self.assertNotEqual(record['inputFingerprint'], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertNotIn('synthetic-password-123', self.runtime.database_bootstrap_path.read_text())
        environment = pathlib.Path(self.config['environmentFile'])
        original = environment.read_text()
        environment.write_text(original.replace('synthetic-auth-secret-for-bootstrap-fingerprint', 'changed-auth-secret-for-bootstrap-fingerprint'))
        with self.assertRaisesRegex(ReleaseError, 'same private input and Auth secret'):
            self.runtime.database_bootstrap_admin(verify=True)
        environment.write_text(original)
        self.assertEqual(self.runtime.database_bootstrap_admin(verify=True)['databaseBootstrap']['phase'], 'not-initialized')

    def test_restore_waits_for_active_requests_without_stopping_them(self):
        self.account_recovery()
        current = self.runtime.state['current']
        self.system.active_connections[current['port']] = 1
        with self.assertRaisesRegex(ReleaseError, 'wait for existing application requests'):
            self.runtime.database_restore()
        self.assertTrue(self.system.process_matches(current))
        self.assertNotIn('restore', [command for command, _ in self.system.database_calls])
        self.assertEqual(self.runtime.receipt()['status'], 'service-maintenance')

    def test_restore_preserves_conflicting_prepared_secret_file(self):
        self.account_recovery()
        self.runtime.database_restore()
        recovery = json.loads(self.runtime.database_recovery_path.read_text())
        prepared = self.runtime.recovery_secret_path(recovery)
        prepared.write_bytes(b'previous private evidence')
        prepared.chmod(0o600)
        with self.assertRaisesRegex(ReleaseError, 'previous prepared secrets differ'):
            self.runtime.database_restore(verify=True)
        self.assertEqual(prepared.read_bytes(), b'previous private evidence')
        self.assertEqual(self.runtime.receipt()['databaseRecovery']['phase'], 'unconfirmed')
        self.assertTrue(list(self.runtime.state_dir.glob('.database-secrets-*')))

    def test_status_does_not_claim_maintenance_after_unrecorded_nginx_edit(self):
        self.account_recovery()
        self.runtime.service_maintenance()
        pathlib.Path(self.config['nginxSite']).write_text(self.original)
        self.assertEqual(self.runtime.receipt()['status'], 'needs-attention')

    def test_maintenance_status_rechecks_the_running_response(self):
        self.account_recovery()
        self.runtime.service_maintenance()
        self.assertEqual(self.runtime.receipt()['status'], 'service-maintenance')
        self.system.maintenance_probe_failure = True
        self.assertEqual(self.runtime.receipt()['status'], 'needs-attention')

    def test_first_maintenance_rejects_forced_worker_shutdown_before_any_nginx_write(self):
        self.system.shutdown_failure = True
        original = pathlib.Path(self.config['nginxSite']).read_bytes()
        with self.assertRaisesRegex(ReleaseError, 'worker_shutdown_timeout'):
            self.runtime.deploy(*self.bundle(account=True))
        self.assertGreater(self.system.shutdown_checks, 0)
        self.assertEqual(pathlib.Path(self.config['nginxSite']).read_bytes(), original)
        self.assertEqual(self.system.reloads, 0)
        self.assertNotIn('migrate', [command for command, _ in self.system.database_calls])


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


class DatabaseBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.config = {'maintenanceUser': 'qintopia-image-maintenance', 'publicBaseUrl': 'https://image.qintopia.cn',
                       'nodeBinary': '/opt/qintopia-image-runtime/bin/node'}
        values = {'environmentFile': 'IMAGE_DATABASE_TARGET=production\nIMAGE_DATABASE_URL=postgresql://runtime@example/qintopia_image\nBETTER_AUTH_URL=https://image.qintopia.cn\nBETTER_AUTH_SECRET=app-secret\nPROVIDER_CONFIG_KEY=provider-key\nASSET_ACCESS_SECRET=asset-key\nCOS_BUCKET=private-bucket\nCOS_REGION=ap-shanghai\nCOS_SECRET_KEY=never-forwarded\n',
                  'migrationEnvironmentFile': 'IMAGE_MIGRATION_DATABASE_URL=postgresql://migration@example/qintopia_image\n',
                  'recoveryEnvironmentFile': 'IMAGE_RECOVERY_KEY=independent-recovery-key\n'}
        for key, body in values.items():
            path = self.base / key
            path.write_text(body)
            path.chmod(0o600)
            self.config[key] = str(path)
        self.secure = patch('server.secure_file')
        self.secure.start()
        self.addCleanup(self.secure.stop)

    def test_environment_is_fresh_and_never_inherits_shell_postgres_or_cos_credentials(self):
        with patch.dict(os.environ, {'NODE_OPTIONS': '--require=/evil.js', 'PGPASSWORD': 'parent-secret', 'IMAGE_MIGRATION_DATABASE_URL': 'wrong-parent'}):
            environment = maintenance_environment(self.config)
        self.assertNotIn('NODE_OPTIONS', environment)
        self.assertNotIn('PGPASSWORD', environment)
        self.assertNotIn('COS_SECRET_KEY', environment)
        self.assertNotIn('ASSET_ACCESS_SECRET', environment)
        self.assertNotIn('IMAGE_RECOVERY_KEY', environment)
        self.assertIn('migration@example', environment['IMAGE_MIGRATION_DATABASE_URL'])
        recovery = maintenance_environment(self.config, recovery=True)
        self.assertEqual(recovery['IMAGE_RECOVERY_KEY'], 'independent-recovery-key')
        self.assertNotIn('COS_SECRET_KEY', recovery)

    def test_only_allowlisted_maintenance_error_codes_cross_the_boundary(self):
        for code in ['BACKUP_KEY_INVALID', 'BACKUP_AUTHENTICATION_FAILED', 'BACKUP_TARGET_NOT_EMPTY', 'DATABASE_IDENTITY', 'DATABASE_BOUNDARY']:
            message = str(maintenance_failure(json.dumps({'error': {'code': code, 'message': 'postgresql://password@private', 'stack': 'secret stack'}})))
            self.assertIn(code + ':', message)
            self.assertNotIn('password', message)
            self.assertNotIn('secret stack', message)
        for raw in ['secret traceback', json.dumps({'error': {'code': 'UNKNOWN_password', 'message': 'private'}}), 'x' * 65537]:
            message = str(maintenance_failure(raw))
            self.assertNotIn('password', message)
            self.assertNotIn('private', message)
            self.assertIn('outcome is unknown', message)

    def test_injection_or_migration_credentials_in_application_file_fail_closed(self):
        path = pathlib.Path(self.config['environmentFile'])
        original = path.read_text()
        for setting in ['NODE_OPTIONS=--require=/evil.js', 'PGHOST=evil', 'IMAGE_MIGRATION_DATABASE_URL=secret', 'IMAGE_RECOVERY_KEY=secret']:
            path.write_text(original + setting + '\n')
            with self.assertRaisesRegex(ReleaseError, 'forbidden'):
                maintenance_environment(self.config)

    def test_restore_can_recover_keys_without_requiring_the_lost_application_secrets(self):
        path = pathlib.Path(self.config['environmentFile'])
        names = {'BETTER_AUTH_SECRET', 'PROVIDER_CONFIG_KEY', 'ASSET_ACCESS_SECRET'}
        path.write_text('\n'.join(line for line in path.read_text().splitlines() if line.partition('=')[0] not in names) + '\n')
        environment = maintenance_environment(self.config, recovery=True, restoring=True)
        self.assertTrue(names.isdisjoint(environment))
        self.assertIn('IMAGE_RECOVERY_KEY', environment)
        with self.assertRaises(ReleaseError):
            maintenance_environment(self.config, recovery=True)

    def test_bootstrap_environment_contains_only_runtime_identity_and_base_environment(self):
        self.config.pop('migrationEnvironmentFile')
        self.config.pop('recoveryEnvironmentFile')
        with patch.dict(os.environ, {'PGPASSWORD': 'parent-secret', 'IMAGE_MIGRATION_DATABASE_URL': 'parent-migration'}):
            environment = maintenance_environment(self.config, bootstrap=True)
        self.assertEqual(set(environment), {'PATH', 'LANG', 'NODE_ENV', 'IMAGE_DATABASE_TARGET', 'IMAGE_DATABASE_URL'})
        self.assertEqual(environment['IMAGE_DATABASE_TARGET'], 'production')
        self.assertIn('runtime@example', environment['IMAGE_DATABASE_URL'])

    def test_fd_only_commands_never_receive_fd4_or_unrelated_credentials(self):
        reference = {'path': str(self.base), 'manifest': {'version': 'v0.2.0', 'revision': 'a' * 40}}
        owner = type('Owner', (), {'pw_uid': 901, 'pw_gid': 901, 'pw_dir': '/nonexistent', 'pw_shell': '/usr/sbin/nologin'})()
        app = type('Owner', (), {'pw_uid': 900})()
        group = type('Group', (), {'gr_name': 'qintopia-image-maintenance'})()
        descriptor = os.open(self.base / 'command-input', os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            for command in ['bootstrap-admin', 'verify-bootstrap-admin', 'restore-preflight']:
                value = {'application': 'qintopia-image', 'command': command, 'release': {'version': 'v0.2.0', 'revision': 'a' * 40}}
                if command == 'restore-preflight':
                    value.update(ready=True, contentSha256='e' * 64, rowCount=4)
                else:
                    value.update(administratorId='00000000-0000-4000-8000-000000000007', **{'initialized' if command == 'bootstrap-admin' else 'verified': True})
                value['password'] = 'must-not-escape-safe-receipt'
                result = subprocess.CompletedProcess([], 0, json.dumps(value), '')
                with patch('server.pwd.getpwnam', side_effect=lambda name: owner if name == 'qintopia-image-maintenance' else app), patch('server.grp.getgrgid', return_value=group), patch('server.os.getgrouplist', return_value=[901]), patch('server.subprocess.run', return_value=result) as run:
                    receipt = System().database(reference, self.config, command, input_fd=descriptor)
                    self.assertEqual(run.call_args.kwargs['pass_fds'], (descriptor,))
                    self.assertEqual(run.call_args.args[0][-4], '-1')
                    if command != 'restore-preflight':
                        self.assertEqual(set(run.call_args.kwargs['env']), {'PATH', 'LANG', 'NODE_ENV', 'IMAGE_DATABASE_TARGET', 'IMAGE_DATABASE_URL'})
                    self.assertNotIn('must-not-escape', json.dumps(receipt))
                    with self.assertRaisesRegex(ReleaseError, 'unexpected maintenance output descriptor'):
                        System().database(reference, self.config, command, input_fd=descriptor, output_fd=descriptor)
        finally:
            os.close(descriptor)

    def test_absence_receipt_is_only_valid_for_explicit_read_only_admin_verification(self):
        reference = {'manifest': {'version': 'v0.2.0', 'revision': 'a' * 40}}
        value = {'application': 'qintopia-image', 'command': 'verify-bootstrap-admin',
                 'release': {'version': 'v0.2.0', 'revision': 'a' * 40}, 'uninitialized': True}
        self.assertEqual(database_receipt(value, reference, 'verify-bootstrap-admin'), {'uninitialized': True})
        value['administratorId'] = '00000000-0000-4000-8000-000000000007'
        with self.assertRaisesRegex(ReleaseError, 'ambiguous'):
            database_receipt(value, reference, 'verify-bootstrap-admin')
        value.pop('administratorId')
        value['command'] = 'bootstrap-admin'
        with self.assertRaises(ReleaseError):
            database_receipt(value, reference, 'bootstrap-admin')

    def test_empty_restore_receipt_requires_read_only_command_and_no_prepared_secrets(self):
        reference = {'manifest': {'version': 'v0.2.0', 'revision': 'a' * 40}}
        value = {'application': 'qintopia-image', 'command': 'verify-restore', 'release': {'version': 'v0.2.0', 'revision': 'a' * 40},
                 'notRestored': True, 'contentSha256': 'e' * 64, 'rowCount': 0, 'secretsPrepared': False}
        self.assertTrue(database_receipt(value, reference, 'verify-restore')['notRestored'])
        value['secretsPrepared'] = True
        with self.assertRaises(ReleaseError):
            database_receipt(value, reference, 'verify-restore')
        value['secretsPrepared'] = False
        value['command'] = 'restore'
        with self.assertRaises(ReleaseError):
            database_receipt(value, reference, 'restore')

    def test_database_run_uses_fixed_low_privilege_identity_and_safe_receipt(self):
        root = pathlib.Path(__file__).resolve().parents[3]
        database = json.loads((root / 'deploy/release-policy.json').read_text())['database']
        reference = {'path': str(self.base), 'manifest': {'version': 'v0.2.0', 'revision': 'a' * 40, 'database': database}}
        value = {'application': 'qintopia-image', 'command': 'verify', 'release': {'version': 'v0.2.0', 'revision': 'a' * 40},
                 'target': 'production', 'database': 'qintopia_image', 'schema': 'app', 'secretsVerified': True,
                 'ledger': [{'version': item['name'][:4], **item} for item in database['migrations']], 'pending': [], 'compatible': True,
                 'connectionBudget': {'applicationProcesses': 2, 'perApplication': 4, 'maintenance': 1, 'total': 9}, 'unexpectedSecret': 'never-log'}
        owner = type('Owner', (), {'pw_uid': 901, 'pw_gid': 901, 'pw_dir': '/nonexistent', 'pw_shell': '/usr/sbin/nologin'})()
        app = type('Owner', (), {'pw_uid': 900})()
        group = type('Group', (), {'gr_name': 'qintopia-image-maintenance'})()
        result = subprocess.CompletedProcess([], 0, json.dumps(value), 'never-log-stderr')
        with patch('server.pwd.getpwnam', side_effect=lambda name: owner if name == 'qintopia-image-maintenance' else app), patch('server.grp.getgrgid', return_value=group), patch('server.os.getgrouplist', return_value=[901]), patch('server.subprocess.run', return_value=result) as run:
            receipt = System().database(reference, self.config, 'verify')
            result.returncode = 1
            result.stdout = ''
            result.stderr = json.dumps({'error': {'code': 'DATABASE_IDENTITY', 'message': 'never-log-credential'}})
            with self.assertRaisesRegex(ReleaseError, 'DATABASE_IDENTITY') as error:
                System().database(reference, self.config, 'verify')
            self.assertNotIn('never-log', str(error.exception))
        self.assertNotIn('never-log', json.dumps(receipt))
        self.assertEqual(run.call_args.kwargs['user'], 901)
        self.assertEqual(run.call_args.kwargs['extra_groups'], [])
        self.assertEqual(run.call_args.args[0][-2:], [str(self.base / 'maintenance/cli.mjs'), 'verify'])
        value['connectionBudget']['total'] = 10
        with self.assertRaises(ReleaseError):
            database_receipt(value, reference, 'verify')

    def test_fixed_descriptor_launcher_maps_only_private_slots_without_root_actions(self):
        archive = os.open(self.base / 'archive', os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        prepared = os.open(self.base / 'prepared', os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(archive, b'synthetic-archive')
            os.lseek(archive, 0, os.SEEK_SET)
            # Replace privilege changes/exec only inside this isolated test child.
            prefix = '''import os
os.setgroups=lambda groups: None
os.setgid=lambda gid: None
os.setuid=lambda uid: None
def checked_exec(binary, arguments, environment):
 assert os.read(3,1024)==b'synthetic-archive'
 assert arguments==['fixed-node','--max-old-space-size=256','fixed-cli','restore']
 os.write(4,b'synthetic-prepared-secrets')
 print('mapped')
os.execve=checked_exec
'''
            result = subprocess.run([sys.executable, '-I', '-c', prefix + FD_LAUNCHER, '901', '901', str(archive), str(prepared), 'fixed-node', 'fixed-cli', 'restore'],
                                    pass_fds=(archive, prepared), capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, 'mapped\n')
            self.assertEqual((self.base / 'prepared').read_bytes(), b'synthetic-prepared-secrets')
        finally:
            os.close(archive)
            os.close(prepared)


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
