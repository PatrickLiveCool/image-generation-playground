"""Offline safety and reconciliation tests for disposable network probes."""
import contextlib
import hashlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import probe_network
from common import ReleaseError


SECRET_MESSAGE = "synthetic-sensitive-response-do-not-log"
OWN_UPLOAD_ID = "synthetic-owned-upload-id-do-not-log"
FOREIGN_UPLOAD_ID = "synthetic-foreign-upload-id-do-not-log"
RELEASE_KEY = "qintopia-image/releases/v0.2.5/" + "a" * 40 + "/app.tar.gz"


class FakeControl:
    def __init__(self, *, init_unknown=False, cleanup_mode=None, inject_foreign=False,
                 preexisting_object=False):
        self.init_unknown = init_unknown
        self.cleanup_mode = cleanup_mode
        self.inject_foreign = inject_foreign
        self.preexisting_object = preexisting_object
        self.objects = {RELEASE_KEY: b"preserve real release"}
        self.tasks = {}
        self.upload_calls = []
        self.abort_calls = []
        self.create_calls = []
        self.complete_calls = []
        self.key = None
        self.foreign_key = None

    def list_multipart_uploads(self, *, Bucket, Prefix):
        self.key = self.key or Prefix
        return {"Upload": [{"Key": task["key"], "UploadId": upload_id}
                           for upload_id, task in self.tasks.items()
                           if task["key"].startswith(Prefix)], "IsTruncated": "false"}

    def list_objects(self, *, Bucket, Prefix):
        if self.preexisting_object:
            return {"Contents": [{"Key": Prefix, "Size": 1}]}
        return {"Contents": [{"Key": key, "Size": len(body)}
                             for key, body in self.objects.items() if key.startswith(Prefix)]}

    def create_multipart_upload(self, *, Bucket, Key, ACL, Metadata):
        self.create_calls.append({"key": Key, "acl": ACL, "metadata": dict(Metadata)})
        self.tasks[OWN_UPLOAD_ID] = {"key": Key, "parts": {}}
        if self.inject_foreign:
            # COS prefix listings can include a longer, different key. It is not ours.
            self.foreign_key = Key + ".unrelated"
            self.tasks[FOREIGN_UPLOAD_ID] = {"key": self.foreign_key, "parts": {}}
        if self.init_unknown:
            raise TimeoutError(SECRET_MESSAGE)
        return {"UploadId": OWN_UPLOAD_ID}

    def list_parts(self, *, Bucket, Key, UploadId, PartNumberMarker):
        task = self.tasks[UploadId]
        if task["key"] != Key:
            raise AssertionError("Attempted to inspect another multipart task")
        return {"Part": [{"PartNumber": str(number), "Size": str(len(body)),
                          "ETag": '"' + hashlib.md5(body).hexdigest() + '"'}
                         for number, body in sorted(task["parts"].items())
                         if number > PartNumberMarker], "IsTruncated": "false"}

    def abort_multipart_upload(self, *, Bucket, Key, UploadId):
        self.abort_calls.append((Key, UploadId))
        task = self.tasks[UploadId]
        if task["key"] != Key:
            raise AssertionError("Attempted to abort another multipart task")
        if self.cleanup_mode == "timeout":
            raise TimeoutError(SECRET_MESSAGE)
        if self.cleanup_mode != "ignored":
            del self.tasks[UploadId]
        return {}

    def complete_multipart_upload(self, **kwargs):
        self.complete_calls.append(kwargs)
        raise AssertionError("A network probe must never create a completed object")


class FakeEndpoint:
    def __init__(self, control, label, failures=None):
        self.control = control
        self.label = label
        self.failures = failures or {}

    def upload_part(self, *, Bucket, Key, Body, PartNumber, UploadId, EnableMD5):
        self.control.upload_calls.append({"endpoint": self.label, "key": Key,
                                          "part": PartNumber, "body": Body,
                                          "upload_id": UploadId, "md5_enabled": EnableMD5})
        task = self.control.tasks[UploadId]
        if task["key"] != Key:
            raise AssertionError("Attempted to write a part to another multipart task")
        failure = self.failures.get(PartNumber)
        if failure != "timeout_lost":
            task["parts"][PartNumber] = Body
        if failure:
            raise TimeoutError(SECRET_MESSAGE)
        return {"ETag": '"' + hashlib.md5(Body).hexdigest() + '"'}


class ProbeNetworkTests(unittest.TestCase):
    def setUp(self):
        for target in ("socket.create_connection", "socket.socket.connect", "socket.socket.connect_ex"):
            guard = patch(target, side_effect=AssertionError("Network probe tests cannot open real sockets"))
            guard.start()
            self.addCleanup(guard.stop)

    def run_probe(self, control, failures=None):
        clients = {label: FakeEndpoint(control, label, failures)
                   for label in probe_network.ENDPOINTS}
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            report = probe_network.probe(control, clients)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[-1]["event"], "probe_complete")
        self.assertEqual(events[-1]["cleanup"], report["cleanup"])
        for value in (SECRET_MESSAGE, OWN_UPLOAD_ID, FOREIGN_UPLOAD_ID):
            self.assertNotIn(value, output.getvalue())
            self.assertNotIn(value, json.dumps(report))
        self.assertEqual(control.objects, {RELEASE_KEY: b"preserve real release"})
        self.assertFalse(control.complete_calls)
        self.assertEqual(report["completedObjectsCreated"], 0)
        self.assertRegex(report["key"], r"^qintopia-image/releases/v0\.0\.0/[0-9a-f]{40}/app\.tar\.gz$")
        return report

    def test_success_compares_identical_payloads_in_both_orders_then_verifies_cleanup(self):
        control = FakeControl()
        report = self.run_probe(control)
        self.assertEqual(report["cleanup"], "verified")
        self.assertEqual(len(report["results"]), 8)
        self.assertEqual(len(control.upload_calls), 8)
        expected_order = [(1, "regional", 65536), (1, "regional_new_domain", 65536),
                          (1, "regional", 2097152), (1, "regional_new_domain", 2097152),
                          (2, "regional_new_domain", 65536), (2, "regional", 65536),
                          (2, "regional_new_domain", 2097152), (2, "regional", 2097152)]
        self.assertEqual([(row["round"], row["endpoint"], row["bytes"]) for row in report["results"]], expected_order)
        self.assertEqual([row["part"] for row in report["results"]], list(range(1, 9)))
        for row in report["results"]:
            self.assertEqual(row["outcome"], "verified")
            self.assertTrue(row["storedAndVerified"])
            self.assertGreaterEqual(row["seconds"], 0)
        for size in (65536, 2097152):
            bodies = [call["body"] for call in control.upload_calls if len(call["body"]) == size]
            self.assertEqual(len(bodies), 4)
            self.assertTrue(all(body == bodies[0] for body in bodies))
        self.assertTrue(all(call["md5_enabled"] for call in control.upload_calls))
        self.assertEqual(control.create_calls, [{"key": report["key"], "acl": "private",
                                                "metadata": {"x-cos-forbid-overwrite": "true"}}])
        self.assertEqual(control.abort_calls, [(report["key"], OWN_UPLOAD_ID)])
        self.assertFalse(control.tasks)

    def test_timeout_acknowledgements_are_resolved_against_the_exact_remote_part(self):
        control = FakeControl()
        report = self.run_probe(control, failures={1: "timeout_stored", 4: "timeout_lost"})
        self.assertEqual(report["cleanup"], "verified")
        self.assertEqual(len(control.upload_calls), 8)
        stored, lost = report["results"][0], report["results"][3]
        self.assertEqual(stored["outcome"], "failed")
        self.assertEqual(stored["category"], "timeout")
        self.assertTrue(stored["storedAndVerified"])
        self.assertEqual(lost["outcome"], "failed")
        self.assertFalse(lost["storedAndVerified"])
        self.assertEqual([row["part"] for row in report["results"] if row["outcome"] == "failed"], [1, 4])
        self.assertFalse(control.tasks)

    def test_unknown_initiation_is_reconciled_and_only_its_unique_key_is_aborted(self):
        control = FakeControl(init_unknown=True, inject_foreign=True)
        report = self.run_probe(control)
        self.assertEqual(report["failure"]["category"], "timeout")
        self.assertEqual(report["results"], [])
        self.assertEqual(report["cleanup"], "verified")
        self.assertEqual(control.abort_calls, [(report["key"], OWN_UPLOAD_ID)])
        self.assertEqual(set(control.tasks), {FOREIGN_UPLOAD_ID})
        self.assertEqual(control.tasks[FOREIGN_UPLOAD_ID]["key"], control.foreign_key)

    def test_cleanup_failure_or_remaining_owned_task_is_reported_as_unconfirmed(self):
        for mode in ("timeout", "ignored"):
            with self.subTest(mode=mode):
                control = FakeControl(cleanup_mode=mode, inject_foreign=True)
                report = self.run_probe(control)
                self.assertEqual(report["cleanup"], "unconfirmed")
                self.assertIn("cleanupError", report)
                self.assertIn(OWN_UPLOAD_ID, control.tasks)
                self.assertIn(FOREIGN_UPLOAD_ID, control.tasks)
                self.assertEqual(control.abort_calls, [(report["key"], OWN_UPLOAD_ID)])

    def test_existing_object_at_candidate_key_stops_before_any_mutation(self):
        control = FakeControl(preexisting_object=True)
        clients = {label: FakeEndpoint(control, label) for label in probe_network.ENDPOINTS}
        with self.assertRaisesRegex(ReleaseError, "already has an object"):
            probe_network.probe(control, clients)
        self.assertFalse(control.create_calls)
        self.assertFalse(control.upload_calls)
        self.assertFalse(control.abort_calls)
        self.assertEqual(control.objects, {RELEASE_KEY: b"preserve real release"})


if __name__ == "__main__":
    unittest.main()
