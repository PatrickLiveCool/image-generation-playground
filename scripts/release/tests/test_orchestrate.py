import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import ARCHIVE, ReleaseError, json_bytes, release_prefix
from cos import MARKER
from orchestrate import (apply_retention, deliver, maintenance, read_release, resolve_rollback,
                         retention_plan, success_marker, validate_receipt, verify_public, SSHSession, quoted_ssh_config_path)
from test_package import REV, fixture_bundle
from test_cos import FakeSDK, add_bundle, fake_store


def reference(manifest, anchor):
    return {"prefix": release_prefix(manifest["version"], manifest["revision"]), "manifestSha256": anchor,
            "manifest": manifest, "releaseId": "test", "path": "/fixed/runtime", "port": 4401, "unit": "fixed.service"}


def receipt(manifest, anchor):
    current = reference(manifest, anchor)
    return {"application": "qintopia-image", "status": "healthy", "current": current, "previous": None,
            "protectedPrefixes": [current["prefix"]], "transaction": None}


class FakeSession:
    def __init__(self, value, events=None):
        self.value = value
        self.events = events if events is not None else []
        self.closed = False
        self.connected = True
        self.acks = []

    def receipt(self):
        self.events.append("receipt")
        if isinstance(self.value, Exception):
            raise self.value
        return self.value

    def ack(self, value):
        self.events.append("ack-" + value)
        self.acks.append(value)

    def alive(self):
        return self.connected

    def finish(self):
        self.events.append("finish")

    def close(self):
        self.closed = True


class OrchestrateTests(unittest.TestCase):
    def test_account_delivery_requires_persistent_access_floor_and_verified_database_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            _, manifest, anchor = fixture_bundle(temporary, account=True)
            value = receipt(manifest, anchor)
            prefix = value['current']['prefix']
            with self.assertRaisesRegex(ReleaseError, 'access floor and database ledger'):
                validate_receipt(value, prefix, anchor, manifest)
            value.update(assetAccessProtocol='account-private-v1', database={'after': {'compatible': True, 'version': '0005', 'pending': [], 'connectionBudget': 9, 'ledgerSha256': 'f' * 64}})
            self.assertIn(prefix, validate_receipt(value, prefix, anchor, manifest))
            value['database']['after']['pending'] = ['0005-image-annotations.sql']
            with self.assertRaises(ReleaseError):
                validate_receipt(value, prefix, anchor, manifest)

    def test_public_account_metadata_must_match_the_database_and_private_access_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            _, manifest, _ = fixture_bundle(temporary, account=True)
            class Response:
                status = 200
                def __init__(self, value): self.value = value
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def read(self, limit): return json_bytes(self.value)
            health = {'application': 'qintopia-image', 'version': manifest['version'], 'revision': manifest['revision'], 'status': 'ready'}
            version = {**health, 'managed': True, **{key: manifest[key] for key in ['browserWorkspaceSchema', 'assetCapabilityVersion', 'databaseMode', 'assetAccessProtocol', 'database']}}
            with patch('orchestrate.urllib.request.urlopen', side_effect=[Response(health), Response(version)]):
                verify_public(manifest)
            version['assetAccessProtocol'] = 'legacy-demo'
            with patch('orchestrate.urllib.request.urlopen', side_effect=[Response(health), Response(version)]):
                with self.assertRaisesRegex(ReleaseError, 'account access metadata'):
                    verify_public(manifest)

    def test_ssh_uses_one_config_quoted_known_hosts_path_without_relaxing_trust(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'Codex project with "quotes" and \\ slash'
            directory.mkdir()
            key = directory / "deploy key"
            hosts = directory / "known hosts"
            key.write_text("test key")
            hosts.write_text("test known host")
            arguments = []
            def factory(argv, **kwargs):
                arguments.append((argv, kwargs))
                return object()
            environment = {"DEPLOY_HOST": "example.invalid", "DEPLOY_USER": "image-deploy",
                           "DEPLOY_SSH_KEY_FILE": str(key), "DEPLOY_KNOWN_HOSTS_FILE": str(hosts)}
            with patch.dict(os.environ, environment):
                SSHSession("status", process_factory=factory)
            argv, options = arguments[0]
            self.assertIn("StrictHostKeyChecking=yes", argv)
            self.assertIn("IdentitiesOnly=yes", argv)
            self.assertIs(options["shell"], False)
            self.assertEqual(argv[argv.index("-i") + 1], str(key))
            self.assertIn("UserKnownHostsFile=" + quoted_ssh_config_path(str(hosts)), argv)

    @unittest.skipUnless(shutil.which("ssh"), "OpenSSH parser is not installed")
    def test_real_openssh_parser_preserves_spaces_quotes_and_backslashes(self):
        # -G emits configuration and exits; -F /dev/null avoids user config and
        # Match exec hooks. This regression neither opens a socket nor uses a key.
        for path in ('/tmp/Codex project/known_hosts', '/tmp/a"b/known_hosts', '/tmp/a\\b/known hosts', '/tmp/project\'s "quoted" \\ path/known_hosts'):
            with self.subTest(path=path):
                result = subprocess.run(["ssh", "-F", "/dev/null", "-G", "-T", "-o", "StrictHostKeyChecking=yes", "-o",
                                         "UserKnownHostsFile=" + quoted_ssh_config_path(path), "example.invalid"],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("userknownhostsfile " + path, result.stdout.splitlines())
                self.assertIn("stricthostkeychecking true", result.stdout.splitlines())

    def test_ssh_config_paths_reject_control_characters_before_process_creation(self):
        for path in ("/tmp/a\nb", "/tmp/a\rb", "/tmp/a\x00b"):
            with self.subTest(path=path), self.assertRaisesRegex(ReleaseError, "file path"):
                quoted_ssh_config_path(path)

    def test_delivery_verifies_server_and_public_before_success_marker_and_ack(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory, manifest, anchor = fixture_bundle(temporary)
            sdk = FakeSDK()
            prefix = add_bundle(sdk, directory, "v0.1.0")
            events = []
            session = FakeSession(receipt(manifest, anchor), events)
            def public(value):
                self.assertNotIn(prefix + MARKER, sdk.objects)
                events.append("public")
            result = deliver("deploy", "v0.1.0", REV, prefix, anchor, store=fake_store(sdk, "marker"),
                             session_factory=lambda *args: session, public_check=public)
            self.assertEqual(result["status"], "verified")
            self.assertEqual(events, ["receipt", "public", "ack-complete", "finish"])
            self.assertIn(prefix + MARKER, sdk.objects)
            self.assertTrue(session.closed)

    def test_mismatched_receipt_or_failed_public_probe_never_marks_success(self):
        for problem in ("wrong-receipt", "public-failure", "unknown-ssh"):
            with self.subTest(problem=problem), tempfile.TemporaryDirectory() as temporary:
                directory, manifest, anchor = fixture_bundle(temporary)
                sdk = FakeSDK()
                prefix = add_bundle(sdk, directory, "v0.1.0")
                response = receipt(manifest, anchor)
                if problem == "wrong-receipt":
                    response["current"]["manifestSha256"] = "0" * 64
                if problem == "unknown-ssh":
                    response = ReleaseError("unknown outcome")
                session = FakeSession(response)
                calls = []
                def factory(*args):
                    calls.append(args)
                    return session
                def public(_value):
                    if problem == "public-failure":
                        raise ReleaseError("public failure")
                with self.assertRaises(ReleaseError):
                    deliver("deploy", "v0.1.0", REV, prefix, anchor, store=fake_store(sdk, "marker"), session_factory=factory, public_check=public)
                self.assertNotIn(prefix + MARKER, sdk.objects)
                self.assertEqual(session.acks, ["failed"])
                self.assertEqual(len(calls), 1)

    def test_rollback_requires_a_successful_unambiguous_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory, manifest, anchor = fixture_bundle(temporary)
            sdk = FakeSDK()
            prefix = add_bundle(sdk, directory, "v0.1.0")
            with self.assertRaises(ReleaseError):
                resolve_rollback(fake_store(sdk), "v0.1.0")
            sdk.objects[prefix + MARKER] = json_bytes(success_marker(manifest, anchor, "2026-10-20T00:00:00Z"))
            resolved = resolve_rollback(fake_store(sdk), "v0.1.0")
            self.assertEqual(resolved[1:], (anchor, prefix))
            session = FakeSession(receipt(manifest, anchor))
            original = sdk.objects[prefix + MARKER]
            deliver("rollback", "v0.1.0", store=fake_store(sdk, "marker"), session_factory=lambda *args: session, public_check=lambda value: None)
            self.assertEqual(sdk.objects[prefix + MARKER], original)
            self.assertFalse(sdk.puts)

    def test_retention_keeps_latest_five_plus_protected_and_ignores_unknown_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            sdk = FakeSDK()
            prefixes = []
            for index in range(6):
                version = "v0.1." + str(index)
                directory, manifest, anchor = fixture_bundle(temporary, version)
                prefix = add_bundle(sdk, directory, version)
                sdk.objects[prefix + MARKER] = json_bytes(success_marker(manifest, anchor, f"2026-10-{20+index}T00:00:00Z"))
                prefixes.append(prefix)
            sdk.objects["image-playground/runs/private.png"] = b"never delete"
            store = fake_store(sdk, "retention")
            plan = retention_plan(store, {prefixes[-1], prefixes[-2]}, now=datetime(2026, 10, 26, tzinfo=timezone.utc))
            self.assertEqual([item["prefix"] for item in plan["deletions"]], [prefixes[0]])
            sdk.objects[prefixes[0] + "unknown/nested.txt"] = b"unrelated"
            with self.assertRaisesRegex(ReleaseError, "inventory changed"):
                apply_retention(store, plan)
            self.assertFalse(sdk.deletes)
            plan = retention_plan(store, {prefixes[-1], prefixes[-2]})
            self.assertFalse(plan["deletions"])
            self.assertTrue(any(item.get("prefix") == prefixes[0] for item in plan["skipped"]))

    def test_expired_candidates_delete_only_inside_lock_with_marker_last(self):
        with tempfile.TemporaryDirectory() as temporary:
            sdk = FakeSDK()
            directory, manifest, anchor = fixture_bundle(temporary)
            prefix = add_bundle(sdk, directory, "v0.1.0")
            plan = retention_plan(fake_store(sdk, "retention"), set(), now=datetime(2026, 10, 26, tzinfo=timezone.utc))
            self.assertEqual(len(plan["deletions"]), 1)
            with self.assertRaisesRegex(ReleaseError, "connection ended"):
                apply_retention(fake_store(sdk, "retention"), plan, connection_alive=lambda: False)
            self.assertFalse(sdk.deletes)
            result = apply_retention(fake_store(sdk, "retention"), plan)
            self.assertEqual(result["status"], "complete")
            self.assertEqual(len(sdk.deletes), 4)

            add_bundle(sdk, directory, "v0.1.0")
            sdk.objects[prefix + MARKER] = json_bytes(success_marker(manifest, anchor, "2026-10-20T00:00:00Z"))
            plan = retention_plan(fake_store(sdk, "retention"), set(), keep=0)
            sdk.deletes.clear()
            apply_retention(fake_store(sdk, "retention"), plan)
            self.assertEqual(sdk.deletes[-1], prefix + MARKER)

    def test_new_candidates_corrupt_archives_and_failed_deletes_are_not_reported_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory, manifest, anchor = fixture_bundle(temporary)
            sdk = FakeSDK()
            prefix = add_bundle(sdk, directory, "v0.1.0")
            sdk.stamp = "2026-10-25T00:00:00Z"
            plan = retention_plan(fake_store(sdk, "retention"), set(), now=datetime(2026, 10, 26, tzinfo=timezone.utc))
            self.assertFalse(plan["deletions"])
            sdk.stamp = "2026-10-01T00:00:00Z"
            plan = retention_plan(fake_store(sdk, "retention"), set(), now=datetime(2026, 10, 26, tzinfo=timezone.utc))
            sdk.fail_delete = prefix + ARCHIVE
            with self.assertRaises(ReleaseError):
                apply_retention(fake_store(sdk, "retention"), plan)
            self.assertIn(prefix + "manifest.json", sdk.objects)
            sdk.fail_delete = None
            add_bundle(sdk, directory, "v0.1.0")
            sdk.objects[prefix + ARCHIVE] = b"corrupt"
            plan = retention_plan(fake_store(sdk, "retention"), set(), now=datetime(2026, 10, 26, tzinfo=timezone.utc))
            with self.assertRaisesRegex(ReleaseError, "corrupt archive"):
                apply_retention(fake_store(sdk, "retention"), plan)

    def test_maintenance_requires_explicit_apply_and_ack_order(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory, manifest, anchor = fixture_bundle(temporary)
            sdk = FakeSDK()
            prefix = add_bundle(sdk, directory, "v0.1.0")
            response = {"application": "qintopia-image", "status": "healthy", "current": {"legacy": True}, "previous": None, "protectedPrefixes": []}
            preview = FakeSession(response)
            result = maintenance(store=fake_store(sdk, "retention"), session_factory=lambda *args: preview)
            self.assertEqual(result["retention"]["status"], "planned")
            self.assertFalse(sdk.deletes)
            self.assertEqual(preview.acks, ["dry-run"])
            session = FakeSession(response)
            result = maintenance(apply=True, store=fake_store(sdk, "retention"), session_factory=lambda *args: session)
            self.assertEqual(result["retention"]["status"], "complete")
            self.assertEqual(session.acks, ["complete"])
            self.assertEqual(len(sdk.deletes), 4)


if __name__ == "__main__":
    unittest.main()
