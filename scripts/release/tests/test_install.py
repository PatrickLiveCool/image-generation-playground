"""Run the installer preflight in a remapped temporary filesystem with fake system tools."""
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name).resolve()
        self.fs = self.root / 'machine'
        self.source = self.root / 'source'
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.source / 'deploy').mkdir(parents=True)
        (self.source / 'scripts/release').mkdir(parents=True)
        for name in ['entry.py', 'ssh-entry.py', 'qintopia-image-deploy', 'qintopia-image-deploy.sudoers', 'qintopia-image-release-recovery.service', 'qintopia-image-release-recovery.timer']:
            shutil.copyfile(ROOT / 'deploy' / name, self.source / 'deploy' / name)
        for name in ['common.py', 'cos.py', 'server.py', 'requirements.txt']:
            (self.source / 'scripts/release' / name).write_text('# reviewed test input\n')
        script = (ROOT / 'deploy/install.sh').read_text()
        # One pass: Linux's temporary root itself contains /tmp/. Repeated
        # replacements would rewrite the /tmp/ inserted for an earlier /opt/.
        script = re.sub(r'/(?:opt|etc|home|usr/local|tmp)/',
                        lambda match: str(self.fs) + match.group(0), script)
        self.installer = self.source / 'deploy/install.sh'
        self.installer.write_text(script)
        (self.fs / 'opt/qintopia-image-runtime/bin').mkdir(parents=True)
        node = self.fs / 'opt/qintopia-image-runtime/bin/node'
        node.write_text('#!/bin/sh\nif [ "$1" = --version ]; then echo v22.22.1; else echo linux/x64; fi\n')
        node.chmod(0o755)
        (self.fs / 'etc/qintopia-image-app').mkdir(parents=True)
        self.environment = self.fs / 'etc/qintopia-image-app/environment'
        self.environment.write_text('preserve-this-file\n')
        self.environment.chmod(0o600)
        (self.fs / 'tmp').mkdir(parents=True)
        (self.fs / 'etc/ssh/sshd_config.d').mkdir(parents=True)
        self.ssh_config = self.fs / 'etc/ssh/sshd_config'
        self.ssh_config.write_text('Include ' + str(self.fs / 'etc/ssh/sshd_config.d/*.conf') + '\n')
        self.key = self.root / 'deploy.pub'
        self.key.write_text('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey material\n')
        self.log = self.root / 'mutations'
        self.env = {**os.environ, 'PATH': str(self.bin) + ':' + os.environ['PATH'], 'INSTALL_TEST_LOG': str(self.log)}
        self.stub('python3', 'if [ "$1" = -c ]; then exit 0; fi\nexec ' + str(sys.executable) + ' -B "$@"')
        self.stub('visudo', 'exit 0')
        self.stub('sshd', '''if [ "$1" = -t ]; then exit 0; fi
case "$*" in *'user=qintopia-image-deploy,'*) case "$*" in *'-f '*) interval=15;; *) interval=0;; esac;; *) interval=0;; esac
printf 'authorizedkeysfile .ssh/authorized_keys\nforcecommand none\nclientaliveinterval %s\nclientalivecountmax 3\n' "$interval"''')
        self.stub('getent', '''if [ "$2" = qintopia-image-app ]; then printf 'qintopia-image-app:x:900:900::/nonexistent:/usr/sbin/nologin\n'; else exit 2; fi''')
        self.stub('stat', '''if [ "$2" = '%u:%g' ]; then echo 0:0; else echo 755; fi''')
        for command in ['systemctl', 'useradd', 'usermod', 'flock', 'install']:
            self.stub(command, 'echo unexpected-mutation >> "$INSTALL_TEST_LOG"; exit 90')

    def tearDown(self):
        self.temp.cleanup()

    def stub(self, name, body):
        target = self.bin / name
        target.write_text('#!/bin/sh\n' + body + '\n')
        target.chmod(0o755)

    def run_installer(self, extra=()):
        return subprocess.run(['bash', str(self.installer), '--dry-run', '--deploy-public-key', str(self.key), *extra],
                              env=self.env, capture_output=True, text=True)

    def test_dry_run_validates_without_mutating_application_or_accounts(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('dry-run passed', result.stdout)
        self.assertEqual(self.environment.read_text(), 'preserve-this-file\n')
        self.assertFalse(self.log.exists())
        self.assertFalse((self.fs / 'opt/qintopia-image-release').exists())

    def test_existing_different_root_tool_fails_before_any_install(self):
        target = self.fs / 'usr/local/sbin/qintopia-image-deploy'
        target.parent.mkdir(parents=True)
        target.write_text('existing operator tool\n')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('existing tool differs', result.stderr)
        self.assertEqual(target.read_text(), 'existing operator tool\n')
        self.assertFalse(self.log.exists())

    def test_identical_wrapper_with_nonexecutable_mode_is_rejected_without_repair(self):
        target = self.fs / 'usr/local/sbin/qintopia-image-deploy'
        target.parent.mkdir(parents=True)
        shutil.copyfile(self.source / 'deploy/qintopia-image-deploy', target)
        target.chmod(0o644)
        self.stub('stat', '''if [ "$2" = '%u:%g' ]; then echo 0:0; else
case "$4" in */usr/local/sbin/qintopia-image-deploy) echo 644;; *) echo 755;; esac
fi''')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('existing tool mode differs', result.stderr)
        self.assertEqual(target.stat().st_mode & 0o777, 0o644)
        self.assertFalse(self.log.exists())

    def test_forced_command_or_key_options_cannot_expand_access(self):
        self.stub('sshd', 'printf "authorizedkeysfile .ssh/authorized_keys\nforcecommand /bin/bash\n"')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ForceCommand conflict', result.stderr)
        self.key.write_text('command="bash" ssh-ed25519 AAAATest\n')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ed25519 public key', result.stderr)
        self.assertFalse(self.log.exists())

    def test_existing_ssh_dropin_is_never_overwritten_and_other_policy_is_preserved(self):
        existing = self.fs / 'etc/ssh/sshd_config.d/99-qintopia-image-release.conf'
        existing.write_text('operator-owned different policy\n')
        original = self.ssh_config.read_text()
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('existing tool differs', result.stderr)
        self.assertEqual(existing.read_text(), 'operator-owned different policy\n')
        self.assertEqual(self.ssh_config.read_text(), original)
        self.assertFalse(self.log.exists())

    def test_dry_run_rejects_keepalive_that_does_not_take_effect(self):
        self.stub('sshd', "printf 'authorizedkeysfile .ssh/authorized_keys\\nforcecommand none\\nclientaliveinterval 0\\nclientalivecountmax 3\\n'")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('keepalive preview is not 15/3', result.stderr)
        self.assertFalse((self.fs / 'etc/ssh/sshd_config.d/99-qintopia-image-release.conf').exists())
        self.assertFalse(self.log.exists())

    def test_missing_runtime_does_not_install_or_replace_global_node(self):
        (self.fs / 'opt/qintopia-image-runtime/bin/node').unlink()
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('isolated Node runtime is missing', result.stderr)
        self.assertFalse(self.log.exists())


if __name__ == '__main__':
    unittest.main()
