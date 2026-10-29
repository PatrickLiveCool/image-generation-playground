import importlib.machinery
import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts/release'))
from common import ReleaseError
from server import identity_args


def module(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    value = importlib.util.module_from_spec(spec)
    loader.exec_module(value)
    return value


SSH = module('image_ssh_entry', ROOT / 'deploy/ssh-entry.py')
WRAPPER = module('image_root_wrapper', ROOT / 'deploy/qintopia-image-deploy')


class EntryTest(unittest.TestCase):
    def test_identity_accepted_by_all_three_boundaries(self):
        arguments = ['deploy', 'v1.2.3', 'a' * 40, 'qintopia-image/releases/v1.2.3/' + 'a' * 40 + '/', 'b' * 64]
        self.assertEqual(SSH.parse_command(' '.join(arguments)), arguments)
        self.assertEqual(WRAPPER.validated(arguments, 'qintopia-image-deploy'), arguments)
        self.assertEqual(identity_args(arguments), arguments)

    def test_shell_paths_env_newlines_and_identity_mismatch_are_rejected(self):
        base = 'deploy v1.2.3 ' + 'a' * 40 + ' qintopia-image/releases/v1.2.3/' + 'a' * 40 + '/ ' + 'b' * 64
        for command in [base + '; id', base + '\nid', 'ENV=bad ' + base, base.replace('qintopia-image/', '../'), base.replace('v1.2.3/', 'v9.9.9/'), base.replace('a' * 40 + '/', 'c' * 40 + '/'), 'bash', 'recover', 'bootstrap', 'maintenance apply; id', 'status ']:
            with self.subTest(command=command):
                with self.assertRaises(ValueError):
                    SSH.parse_command(command)
        for argument in [base.split() + ['extra'], ['deploy'], ['maintenance', 'apply', 'extra'], ['status', '/etc/shadow']]:
            with self.assertRaises(ValueError):
                WRAPPER.validated(argument, 'qintopia-image-deploy')

    def test_recovery_and_bootstrap_are_root_only(self):
        for operation in ['recover', 'bootstrap', 'service-maintenance', 'database-status', 'database-backup', 'database-restore', 'database-verify-restore', 'database-bootstrap-admin', 'database-verify-bootstrap-admin']:
            self.assertEqual(WRAPPER.validated([operation], None), [operation])
            with self.assertRaises(ValueError):
                SSH.parse_command(operation)
            with self.assertRaises(ValueError):
                WRAPPER.validated([operation], 'qintopia-image-deploy')
            with self.assertRaises(ReleaseError):
                identity_args([operation], root=False)

    def test_maintenance_is_explicit_and_status_requires_no_arguments(self):
        for command in ['status', 'maintenance', 'maintenance dry-run', 'maintenance apply']:
            args = command.split()
            self.assertEqual(SSH.parse_command(command), args)
            self.assertEqual(WRAPPER.validated(args, 'qintopia-image-deploy'), args)
            self.assertEqual(identity_args(args), args)


if __name__ == '__main__':
    unittest.main()
