import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import ARCHIVE, ReleaseError, json_bytes, release_prefix
from cos import MARKER
from orchestrate import (apply_retention, deliver, maintenance, read_release, resolve_rollback,
                         retention_plan, success_marker, validate_receipt)
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
