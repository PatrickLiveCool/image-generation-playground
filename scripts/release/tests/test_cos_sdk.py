"""Exercise the pinned SDK through real request preparation, without network I/O."""
import base64
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse
from xml.etree import ElementTree

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cos as release_cos
from common import ARCHIVE, ReleaseError, release_prefix

try:
    import requests
    from requests.adapters import BaseAdapter
    from requests.exceptions import ConnectionError
    from urllib3.exceptions import ProtocolError
    from qcloud_cos import CosConfig
except ImportError:
    CosConfig = None
    BaseAdapter = object


REVISION = "a" * 40
BUCKET = "offline-release-1234567890"
KEY = release_prefix("v0.2.5", REVISION) + ARCHIVE
UPLOAD_ID = "synthetic-upload-id-do-not-log"
SECRET_ID = "synthetic-credential-id-do-not-log"
SECRET_KEY = "synthetic-credential-key-do-not-log"
SECRET_TOKEN = "synthetic-session-token-do-not-log"
ERROR_MESSAGE = "synthetic-secret-message-do-not-log"
ERROR_URL = "https://synthetic-sensitive.example/?token=do-not-log"


def text(value):
    return value.decode("utf-8") if isinstance(value, bytes) else value


class OfflineCosAdapter(BaseAdapter):
    """Only synthetic responses; even a mistaken endpoint cannot reach a socket."""

    def __init__(self, failure=None, coordinate_parts=False):
        self.failure = failure
        self.objects = {}
        self.parts = {}
        self.calls = []
        self.active_parts = 0
        self.max_active_parts = 0
        self.lock = threading.Lock()
        self.barrier = threading.Barrier(2, timeout=5) if coordinate_parts else None

    def close(self):
        pass

    def response(self, request, body=b"", status=200, headers=None):
        response = requests.Response()
        response.request = request
        response.url = request.url
        response.status_code = status
        response._content = body
        response.raw = io.BytesIO(body)
        response.headers.update({"Content-Length": str(len(body)), **(headers or {})})
        return response

    def error_response(self, request, status):
        body = (f"<Error><Code>AccessDenied</Code><Message>{ERROR_MESSAGE}</Message>"
                f"<Resource>{ERROR_URL}</Resource><RequestId>{UPLOAD_ID}</RequestId></Error>").encode()
        return self.response(request, body, status)

    def send(self, request, **kwargs):
        parsed = urlparse(request.url)
        query = parse_qs(parsed.query, keep_blank_values=True)
        key = parsed.path.lstrip("/")
        if request.method == "HEAD":
            operation = "head"
        elif "versioning" in query:
            operation = "versioning"
        elif "uploads" in query:
            operation = "list_multipart" if request.method == "GET" else "create"
        elif "partNumber" in query:
            operation = "part"
        elif "uploadId" in query:
            operation = "abort" if request.method == "DELETE" else "complete"
        elif request.method == "GET" and "prefix" in query:
            operation = "list"
        elif request.method == "DELETE":
            operation = "delete"
        else:
            operation = "put" if request.method == "PUT" else "get"
        call = {"operation": operation, "key": key, "host": parsed.hostname,
                "contentLength": text(request.headers.get("Content-Length")),
                "contentLengthType": type(request.headers.get("Content-Length")).__name__,
                "contentMD5": text(request.headers.get("Content-MD5")),
                "transferEncoding": text(request.headers.get("Transfer-Encoding")),
                "forbidOverwrite": text(request.headers.get("x-cos-forbid-overwrite")),
                "acl": text(request.headers.get("x-cos-acl")),
                "bodyIsNone": request.body is None}
        with self.lock:
            self.calls.append(call)

        if operation == "head":
            if key not in self.objects:
                return self.response(request, status=404)
            return self.response(request, headers={"Content-Length": str(len(self.objects[key]))})
        if operation == "versioning":
            return self.response(request, b"<VersioningConfiguration/>")
        if operation == "list":
            contents = "".join(f'<Contents><Key>{name}</Key><Size>{len(body)}</Size><ETag>"offline"</ETag></Contents>'
                               for name, body in sorted(self.objects.items()) if name.startswith(query["prefix"][0]))
            return self.response(request, ("<ListBucketResult>" + contents + "<IsTruncated>false</IsTruncated></ListBucketResult>").encode())
        if operation == "delete":
            self.objects.pop(key, None)
            return self.response(request)
        if operation == "list_multipart":
            return self.response(request, b"<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>")
        if operation == "create":
            return self.response(request, f"<InitiateMultipartUploadResult><UploadId>{UPLOAD_ID}</UploadId></InitiateMultipartUploadResult>".encode())
        if operation == "part":
            part = int(query["partNumber"][0])
            body = request.body
            if not isinstance(body, bytes):
                raise AssertionError("SDK multipart bodies must be bounded bytes")
            call.update(part=part, size=len(body))
            with self.lock:
                self.active_parts += 1
                self.max_active_parts = max(self.max_active_parts, self.active_parts)
            try:
                if self.barrier is not None and part in (1, 2):
                    self.barrier.wait()
                if self.failure == "403":
                    return self.error_response(request, 403)
                if self.failure == "timeout":
                    raise ConnectionError(ProtocolError(ERROR_URL, TimeoutError(ERROR_MESSAGE)))
                with self.lock:
                    self.parts[part] = body
                return self.response(request, headers={"ETag": f'"part-{part}"'})
            finally:
                with self.lock:
                    self.active_parts -= 1
        if operation == "complete":
            root = ElementTree.fromstring(request.body)
            ordered_parts = [int(part.findtext("PartNumber")) for part in root.findall("Part")]
            self.objects[key] = b"".join(self.parts[part] for part in ordered_parts)
            return self.response(request, b'<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>')
        if operation == "abort":
            raise AssertionError("Failed transfers must not silently abort remote multipart evidence")
        if operation == "put":
            body = request.body.read() if hasattr(request.body, "read") else request.body
            self.objects[key] = body
            return self.response(request, headers={"ETag": '"single"'})
        if operation == "get" and key in self.objects:
            return self.response(request, self.objects[key])
        raise AssertionError(f"Unexpected offline operation: {operation}")


@unittest.skipIf(CosConfig is None, "install scripts/release/requirements.txt to exercise the pinned COS SDK")
class CosSDKTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict("os.environ", {"COS_ENDPOINT": "", "COS_UPLOAD_ENDPOINT": ""})
        environment.start()
        self.addCleanup(environment.stop)
        # An adapter bug or unexpected SDK path must fail, never make a real request.
        for target in ("socket.create_connection", "socket.socket.connect", "socket.socket.connect_ex"):
            guard = patch(target, side_effect=AssertionError("Real sockets are forbidden in COS SDK tests"))
            guard.start()
            self.addCleanup(guard.stop)

    def store(self, adapter, role="upload"):
        session = requests.Session()
        session.trust_env = False
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        self.addCleanup(session.close)
        config = CosConfig(Region="ap-shanghai", SecretId=SECRET_ID, SecretKey=SECRET_KEY,
                           Token=SECRET_TOKEN, Scheme="https", Timeout=(10, 60))
        client = release_cos.make_cos_client(config, session=session)
        return release_cos.CosStore(BUCKET, "ap-shanghai", role=role, client=client)

    def transport_factory(self, adapter):
        original_factory = release_cos.make_cos_client

        def make(config, *, session=None, retry=release_cos.UPLOAD_RETRIES):
            self.assertIsNone(session)
            transport_session = requests.Session()
            transport_session.trust_env = False
            transport_session.mount("https://", adapter)
            transport_session.mount("http://", adapter)
            self.addCleanup(transport_session.close)
            return original_factory(config, session=transport_session, retry=retry)

        return make

    def test_explicit_acceleration_separates_control_and_transfer_requests_for_files_and_markers(self):
        for role in ("upload", "marker"):
            with self.subTest(role=role):
                control = OfflineCosAdapter()
                transfer = OfflineCosAdapter()
                transfer.objects = control.objects
                store = self.store(control, role)
                key = KEY if role == "upload" else release_prefix("v0.2.5", REVISION) + "deployed.json"
                with patch.dict("os.environ", {"COS_UPLOAD_ENDPOINT": "cos.accelerate.myqcloud.com"}), \
                     patch.object(release_cos, "make_cos_client", side_effect=self.transport_factory(transfer)) as factory, \
                     contextlib.redirect_stderr(io.StringIO()), \
                     tempfile.TemporaryDirectory(prefix="cos-sdk-routing-") as directory:
                    self.assertEqual(store.list(release_prefix("v0.2.5", REVISION)), [])
                    if role == "upload":
                        artifact = Path(directory) / ARCHIVE
                        with artifact.open("wb") as output:
                            output.truncate(2 * 1024 * 1024 + 1)
                        result = store.put_immutable(key, artifact)
                        # The same transfer client must also handle small metadata PUTs.
                        store.put_immutable(release_prefix("v0.2.5", REVISION) + "manifest.json", b'{"offline":true}')
                    else:
                        result = store.put_immutable(key, b'{"deployment":"offline"}')
                    self.assertIsNotNone(store.head(key))
                    self.assertEqual(store.object_sha(key), result["sha256"])
                    self.assertEqual(factory.call_count, 1)
                self.assertEqual(result["status"], "uploaded")
                self.assertEqual({call["host"] for call in control.calls}, {f"{BUCKET}.cos.ap-shanghai.myqcloud.com"})
                self.assertEqual({call["host"] for call in transfer.calls}, {f"{BUCKET}.cos.accelerate.myqcloud.com"})
                self.assertEqual({call["operation"] for call in control.calls}, {"list", "head", "versioning"})
                self.assertTrue({"put", "get"} <= {call["operation"] for call in transfer.calls})
                self.assertFalse({"list", "head", "versioning", "delete"} & {call["operation"] for call in transfer.calls})
                if role == "upload":
                    self.assertTrue({"list_multipart", "create", "part", "complete"} <= {call["operation"] for call in transfer.calls})
                self.assertEqual(hashlib.sha256(control.objects[key]).hexdigest(), result["sha256"])

    def test_unconfigured_upload_endpoint_keeps_the_original_regional_client(self):
        for configured in (False, True):
            with self.subTest(empty_variable=configured), patch.dict("os.environ", {}):
                if configured:
                    os.environ["COS_UPLOAD_ENDPOINT"] = ""
                else:
                    os.environ.pop("COS_UPLOAD_ENDPOINT", None)
                regional = OfflineCosAdapter()
                store = self.store(regional)
                with patch.object(release_cos, "make_cos_client", side_effect=AssertionError("No transfer client should be created")) as factory, \
                     contextlib.redirect_stderr(io.StringIO()):
                    store.list(release_prefix("v0.2.5", REVISION))
                    result = store.put_immutable(KEY, b"offline release")
                    self.assertEqual(store.object_sha(KEY), result["sha256"])
                    factory.assert_not_called()
                self.assertEqual({call["host"] for call in regional.calls}, {f"{BUCKET}.cos.ap-shanghai.myqcloud.com"})
                self.assertTrue({"list", "head", "versioning", "put", "get"} <= {call["operation"] for call in regional.calls})
                self.assertIsNone(store.transfer_client)

    def test_reader_and_retention_ignore_upload_acceleration_and_stay_regional(self):
        for role in ("reader", "retention"):
            with self.subTest(role=role):
                regional = OfflineCosAdapter()
                regional.objects[KEY] = b"existing immutable release"
                store = self.store(regional, role)
                with patch.dict("os.environ", {"COS_UPLOAD_ENDPOINT": "cos.accelerate.myqcloud.com"}), \
                     patch.object(release_cos, "make_cos_client", side_effect=AssertionError("Read roles must not construct an accelerated client")) as factory:
                    self.assertEqual(len(store.list(release_prefix("v0.2.5", REVISION))), 1)
                    self.assertIsNotNone(store.head(KEY))
                    self.assertEqual(store.read_bytes(KEY), b"existing immutable release")
                    if role == "retention":
                        store.delete(KEY)
                        self.assertNotIn(KEY, regional.objects)
                    factory.assert_not_called()
                self.assertEqual({call["host"] for call in regional.calls}, {f"{BUCKET}.cos.ap-shanghai.myqcloud.com"})
                self.assertFalse({"put", "create", "part", "complete"} & {call["operation"] for call in regional.calls})
                self.assertIsNone(store.transfer_client)

    def test_invalid_upload_endpoint_cannot_construct_a_transport_or_send_payloads(self):
        for endpoint in ("untrusted.example", "https://cos.accelerate.myqcloud.com", "cos.ap-shanghai.tencentcos.cn"):
            with self.subTest(endpoint=endpoint):
                regional = OfflineCosAdapter()
                store = self.store(regional)
                with patch.dict("os.environ", {"COS_UPLOAD_ENDPOINT": endpoint}), \
                     patch.object(release_cos, "make_cos_client", side_effect=AssertionError("Invalid endpoint must be rejected before constructing a client")) as factory, \
                     contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaisesRegex(ReleaseError, "unsupported release upload endpoint"):
                        store._data_client()
                    self.assertEqual(regional.calls, [])
                    with self.assertRaisesRegex(ReleaseError, "unsupported release upload endpoint"):
                        store.put_immutable(KEY, b"must never be uploaded")
                    factory.assert_not_called()
                self.assertTrue(all(call["operation"] in {"head", "versioning"} for call in regional.calls))
                self.assertEqual(regional.objects, {})

    def test_upload_factory_sets_send_timeout_and_retry_budget_without_changing_reader_defaults(self):
        credentials = {"SecretId": SECRET_ID, "SecretKey": SECRET_KEY, "Token": SECRET_TOKEN}
        with patch.dict("os.environ", {"COS_ENDPOINT": ""}):
            upload = release_cos.CosStore(BUCKET, "ap-shanghai", credentials=credentials, role="upload")._client()
            reader = release_cos.CosStore(BUCKET, "ap-shanghai", credentials=credentials)._client()
        self.assertEqual(upload.get_conf()._timeout, (60, 60))
        self.assertEqual(upload._retry, 1)
        self.assertEqual(reader.get_conf()._timeout, (10, 60))
        self.assertEqual(reader._retry, 3)

    def events(self, output):
        events = [json.loads(line) for line in output.splitlines() if line.strip()]
        for event in events:
            self.assertEqual(event["event"], "cos_transfer")
        return events

    def assert_no_sensitive_diagnostics(self, output):
        for sensitive in (UPLOAD_ID, SECRET_ID, SECRET_KEY, SECRET_TOKEN, ERROR_MESSAGE, ERROR_URL,
                          "Authorization", "x-cos-security-token", "uploadId=", "https://"):
            self.assertNotIn(sensitive, output)

    def test_real_sdk_splits_release_size_with_bounded_concurrency_and_verifies_readback(self):
        size = 41_639_205
        adapter = OfflineCosAdapter(coordinate_parts=True)
        store = self.store(adapter)
        with tempfile.TemporaryDirectory(prefix="cos-sdk-contract-") as directory:
            artifact = Path(directory) / ARCHIVE
            with artifact.open("wb") as output:
                output.truncate(size)
            logs = io.StringIO()
            with contextlib.redirect_stderr(logs):
                result = store.put_immutable(KEY, artifact)
        self.assertEqual(result["status"], "uploaded")
        self.assertEqual(result["sha256"], hashlib.sha256(adapter.objects[KEY]).hexdigest())
        parts = sorted((call for call in adapter.calls if call["operation"] == "part"), key=lambda call: call["part"])
        self.assertEqual([call["part"] for call in parts], list(range(1, 21)))
        self.assertEqual([call["size"] for call in parts], [2 * 1024 * 1024] * 19 + [1_793_317])
        self.assertEqual(adapter.max_active_parts, 2)
        for call in parts:
            self.assertEqual(call["contentLength"], str(call["size"]))
            self.assertIsNone(call["transferEncoding"])
            expected_md5 = base64.b64encode(hashlib.md5(adapter.parts[call["part"]]).digest()).decode()
            self.assertEqual(call["contentMD5"], expected_md5)
        create = next(call for call in adapter.calls if call["operation"] == "create")
        self.assertTrue(create["bodyIsNone"])
        self.assertIn(create["contentLength"], (None, "0"))
        self.assertEqual(create["forbidOverwrite"], "true")
        self.assertEqual(create["acl"], "private")
        self.assertEqual(Counter(call["operation"] for call in adapter.calls)["complete"], 1)
        complete = next(call for call in adapter.calls if call["operation"] == "complete")
        self.assertEqual(complete["forbidOverwrite"], "true")
        self.assertEqual(adapter.calls[-1]["operation"], "get")
        events = [event for event in self.events(logs.getvalue()) if event["operation"] == "upload_part"]
        self.assertEqual(Counter(event["phase"] for event in events), {"start": 20, "complete": 20})
        for event in events:
            self.assertEqual(event["key"], KEY)
            self.assertGreater(event["bytes"], 0)
            if event["phase"] == "complete":
                self.assertGreaterEqual(event["elapsedSeconds"], 0)
        self.assert_no_sensitive_diagnostics(logs.getvalue())

    def test_bytes_put_has_valid_string_content_length_and_no_multipart_initialization(self):
        adapter = OfflineCosAdapter()
        store = self.store(adapter)
        key = release_prefix("v0.2.5", REVISION) + "manifest.json"
        body = b'{"offline":true}'
        with contextlib.redirect_stderr(io.StringIO()):
            store.put_immutable(key, body)
        call = next(call for call in adapter.calls if call["operation"] == "put")
        self.assertEqual(call["contentLengthType"], "str")
        self.assertEqual(call["contentLength"], str(len(body)))
        self.assertIsNone(call["transferEncoding"])
        self.assertEqual(call["forbidOverwrite"], "true")
        self.assertEqual(call["acl"], "private")
        self.assertNotIn("create", [call["operation"] for call in adapter.calls])
        self.assertEqual(adapter.objects[key], body)

    def test_part_failures_keep_safe_http_or_timeout_cause_and_never_complete_or_abort(self):
        for failure in ("403", "timeout"):
            with self.subTest(failure=failure):
                adapter = OfflineCosAdapter(failure=failure, coordinate_parts=True)
                store = self.store(adapter)
                with tempfile.TemporaryDirectory(prefix="cos-sdk-failure-") as directory:
                    artifact = Path(directory) / ARCHIVE
                    with artifact.open("wb") as output:
                        # Five parts leave queued work after both in-flight parts fail.
                        output.truncate(8 * 1024 * 1024 + 1)
                    logs = io.StringIO()
                    with contextlib.redirect_stderr(logs), self.assertRaises(ReleaseError) as caught:
                        store.put_immutable(KEY, artifact)
                operations = [call["operation"] for call in adapter.calls]
                self.assertNotIn("complete", operations)
                self.assertNotIn("abort", operations)
                self.assertNotIn(KEY, adapter.objects)
                attempts = Counter(call["part"] for call in adapter.calls if call["operation"] == "part")
                self.assertLessEqual(len(attempts), 2)
                self.assertEqual(attempts, {1: 1 if failure == "403" else 2, 2: 1 if failure == "403" else 2})
                events = [event for event in self.events(logs.getvalue())
                          if event["operation"] == "upload_part" and event["phase"] == "failed"]
                self.assertEqual({event["part"] for event in events}, {1, 2})
                for event in events:
                    self.assertEqual(event["key"], KEY)
                    self.assertGreater(event["bytes"], 0)
                    self.assertGreaterEqual(event["elapsedSeconds"], 0)
                    if failure == "403":
                        self.assertEqual(event["httpStatus"], 403)
                        self.assertEqual(event["errorType"], "CosServiceError")
                    else:
                        self.assertEqual(event["category"], "timeout")
                        self.assertIn("TimeoutError", event["causes"])
                self.assert_no_sensitive_diagnostics(logs.getvalue() + str(caught.exception))


if __name__ == "__main__":
    unittest.main()
