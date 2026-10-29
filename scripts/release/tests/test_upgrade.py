"""Upgrade transactions use only temporary files and simulated system commands."""
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('image_tool_upgrade', ROOT / 'deploy/upgrade.py')
UPGRADE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPGRADE)


class UpgradeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.temporary.name)
        self.source = self.base / 'source'
        self.source.mkdir()
        self.state = self.base / 'state'
        self.state.mkdir(mode=0o700)
        self.files = []
        for index in range(3):
            name = str(index) + '.py'
            (self.source / name).write_text('new_' + str(index))
            destination = self.base / ('installed_' + name)
            destination.write_text('old_' + str(index))
            destination.chmod(0o644)
            self.files.append((name, destination, 0o644))
        self.upgrade = UPGRADE.Upgrade(self.source, self.state, self.files)
        # Root ownership is unavailable in local tests. Keep real regular-file,
        # link, and permission checks within the temporary filesystem.
        def local_secure(path, private=False):
            path = pathlib.Path(path)
            UPGRADE.require(path.is_file() and not path.is_symlink() and path.stat().st_nlink == 1
                            and not path.stat().st_mode & (0o077 if private else 0o022), 'unsafe test file')
        self.patches = [patch.object(UPGRADE, 'ROOT_UID', os.geteuid()), patch.object(UPGRADE, 'secure', side_effect=local_secure), patch.object(UPGRADE, 'run'),
                        patch.object(UPGRADE, 'maintenance_identity'), patch.object(self.upgrade, 'validate_source')]
        for item in self.patches:
            item.start()
        self.expected = self.upgrade.plan()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temporary.cleanup()

    def test_success_preserves_old_files_and_supports_explicit_recovery(self):
        result = self.upgrade.apply(self.expected)
        self.assertEqual(result['status'], 'complete')
        for index, (_, path, _) in enumerate(self.files):
            self.assertEqual(path.read_text(), 'new_' + str(index))
            self.assertEqual((self.upgrade.directory / result['upgradeId'] / (str(index) + '.old')).read_text(), 'old_' + str(index))
        self.assertEqual(self.upgrade.recover()['status'], 'restored')
        self.assertEqual([path.read_text() for _, path, _ in self.files], ['old_0', 'old_1', 'old_2'])

    def test_old_or_candidate_digest_changes_reject_before_any_replacement(self):
        self.files[1][1].write_text('operator-change')
        with self.assertRaisesRegex(UPGRADE.UpgradeError, 'changed after review'):
            self.upgrade.apply(self.expected)
        self.assertEqual(self.files[0][1].read_text(), 'old_0')
        self.assertFalse(self.upgrade.active.exists())
        self.files[1][1].write_text('old_1')
        (self.source / '2.py').write_text('unreviewed-candidate')
        with self.assertRaises(UPGRADE.UpgradeError):
            self.upgrade.apply(self.expected)

    def test_partial_install_failure_restores_every_previous_file(self):
        original = UPGRADE.atomic
        failed = False
        def interrupted(path, body, mode=0o600):
            nonlocal failed
            if path == self.files[1][1] and body == b'new_1' and not failed:
                failed = True
                raise OSError('synthetic replacement failure')
            return original(path, body, mode)
        with patch.object(UPGRADE, 'atomic', side_effect=interrupted):
            with self.assertRaisesRegex(UPGRADE.UpgradeError, 'previous tools restored'):
                self.upgrade.apply(self.expected)
        self.assertEqual([path.read_text() for _, path, _ in self.files], ['old_0', 'old_1', 'old_2'])
        self.assertEqual(json.loads(self.upgrade.active.read_text())['phase'], 'restored')

    def test_unknown_tool_change_is_never_overwritten_during_recovery(self):
        self.upgrade.apply(self.expected)
        self.files[1][1].write_text('operator-change')
        with self.assertRaisesRegex(UPGRADE.UpgradeError, 'outside this upgrade'):
            self.upgrade.recover()
        self.assertEqual([path.read_text() for _, path, _ in self.files], ['new_0', 'operator-change', 'new_2'])

    def test_interrupted_recovery_can_be_repeated_but_corrupt_backup_cannot(self):
        result = self.upgrade.apply(self.expected)
        journal = json.loads(self.upgrade.active.read_text())
        journal['phase'] = 'restoring'
        self.upgrade.save(journal)
        self.files[2][1].write_text('old_2')
        self.upgrade.recover()
        backup = self.upgrade.directory / result['upgradeId'] / '0.old'
        backup.write_text('corruption')
        with self.assertRaisesRegex(UPGRADE.UpgradeError, 'backup failed checksum'):
            self.upgrade.recover()

    def test_manifest_cannot_add_arbitrary_destinations(self):
        self.expected['files']['/etc/shadow'] = next(iter(self.expected['files'].values()))
        with self.assertRaisesRegex(UPGRADE.UpgradeError, 'unexpected upgrade manifest'):
            self.upgrade.apply(self.expected)
        self.assertFalse(self.upgrade.active.exists())

    def test_account_floor_forbids_restoring_legacy_control_plane_after_activation(self):
        self.upgrade.apply(self.expected)
        (self.state / 'access-floor.json').write_text('{}')
        with self.assertRaisesRegex(UPGRADE.UpgradeError, 'access floor forbids'):
            self.upgrade.recover()
        self.assertEqual([path.read_text() for _, path, _ in self.files], ['new_0', 'new_1', 'new_2'])

    def test_invalid_candidate_systemd_unit_fails_before_any_tool_replacement(self):
        requirements = self.source / 'scripts/release/requirements.txt'
        requirements.parent.mkdir(parents=True)
        requirements.write_text('cos-python-sdk-v5==1.9.38\n')
        deployment = self.source / 'deploy'
        deployment.mkdir()
        service = deployment / 'qintopia-image-release-recovery.service'
        timer = deployment / 'qintopia-image-release-recovery.timer'
        service.write_text('this is not a valid service unit\n')
        timer.write_text('[Timer]\nOnBootSec=30\n')
        commands = []
        def validate(arguments):
            commands.append(arguments)
            if arguments[:2] == ['systemd-analyze', 'verify']:
                self.assertEqual(arguments[2:], [str(service), str(timer)])
                raise UPGRADE.UpgradeError('invalid candidate systemd unit')
        with patch.object(self.upgrade, 'validate_source', wraps=lambda: UPGRADE.Upgrade.validate_source(self.upgrade)), patch.object(UPGRADE, 'run', side_effect=validate):
            with self.assertRaisesRegex(UPGRADE.UpgradeError, 'invalid candidate systemd unit'):
                self.upgrade.apply(self.expected)
        self.assertTrue(any(command[:2] == ['systemd-analyze', 'verify'] for command in commands))
        self.assertEqual([path.read_text() for _, path, _ in self.files], ['old_0', 'old_1', 'old_2'])
        self.assertFalse(self.upgrade.active.exists())


if __name__ == '__main__':
    unittest.main()
