import hashlib
import io
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import FILES, ROOT_PREFIX, ReleaseError, release_prefix
from cos import BundleAbsent, CosStore, fetch_bundle, upload_bundle
from test_package import REV, fixture_bundle


class SDKError(Exception):
    def __init__(self, status):
        self.status_code = status
        super().__init__("sensitive-sdk-response-must-not-escape")


class FakeSDK:
    def __init__(self):
        self.objects = {}
        self.versioning = "Disabled"
        self.puts = []
        self.content_lengths = []
        self.upload_files = []
        self.deletes = []
        self.gets = []
        self.fail_delete = None
        self.stamp = "2026-10-01T00:00:00Z"

    def get_bucket_versioning(self, **kwargs):
        return {"Status": self.versioning} if self.versioning else {}

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise SDKError(404)
        body = self.objects[Key]
        return {"ETag": hashlib.md5(body).hexdigest(), "Content-Length": len(body), "Last-Modified": self.stamp}

    def get_object(self, Bucket, Key):
        self.gets.append(Key)
        if Key not in self.objects:
            raise SDKError(404)
        return {"Body": io.BytesIO(self.objects[Key])}

    def put_object(self, Bucket, Key, Body, ACL, Metadata, ContentLength=None):
        self.puts.append((Key, ACL, Metadata))
        self.content_lengths.append(ContentLength)
        if Key in self.objects:
            raise SDKError(409)
        self.objects[Key] = Body.read()
        return {}

    def upload_file(self, Bucket, Key, LocalFilePath, PartSize, MAXThread, ACL, Metadata, EnableMD5=False):
        self.upload_files.append((Key, PartSize, MAXThread, ACL, Metadata))
        with open(LocalFilePath, "rb") as body:
            return self.put_object(Bucket, Key, body, ACL, Metadata, ContentLength=str(Path(LocalFilePath).stat().st_size))

    def list_objects(self, Bucket, Prefix, Marker, MaxKeys):
        return {"Contents": [{"Key": key, "Size": len(value), "ETag": hashlib.md5(value).hexdigest(), "LastModified": self.stamp}
                             for key, value in sorted(self.objects.items()) if key.startswith(Prefix)], "IsTruncated": "false"}

    def delete_object(self, Bucket, Key):
        if Key == self.fail_delete:
            raise SDKError(503)
        self.deletes.append(Key)
        self.objects.pop(Key, None)


def fake_store(sdk, role="reader"):
    return CosStore("test-release-123", "ap-shanghai", role=role, client=sdk)


def add_bundle(sdk, directory, version, revision=REV):
    prefix = release_prefix(version, revision)
    for name in FILES:
        sdk.objects[prefix + name] = (directory / name).read_bytes()
    return prefix


class CosTests(unittest.TestCase):
    def test_upload_is_private_nonoverwriting_and_verified_by_readback(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory, manifest, anchor = fixture_bundle(temporary)
            sdk = FakeSDK()
            result = upload_bundle(fake_store(sdk, "upload"), directory)
            self.assertEqual(result["manifestSha256"], anchor)
            self.assertEqual(len(sdk.puts), 4)
            self.assertEqual(len(sdk.upload_files), 4)
            self.assertTrue(all(part_size == 2 and threads == 2 for _, part_size, threads, _, _ in sdk.upload_files))
            self.assertEqual(sdk.content_lengths, [str((directory / name).stat().st_size) for name in FILES])
            self.assertTrue(all(acl == "private" and metadata["x-cos-forbid-overwrite"] == "true" for _, acl, metadata in sdk.puts))
            upload_bundle(fake_store(sdk, "upload"), directory)
            self.assertEqual(len(sdk.puts), 4)
            sdk.objects[result["prefix"] + "manifest.json"] = b"different"
            with self.assertRaisesRegex(ReleaseError, "different bytes"):
                upload_bundle(fake_store(sdk, "upload"), directory)

    def test_absent_complete_partial_and_unknown_prefixes_have_distinct_outcomes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory, manifest, anchor = fixture_bundle(root)
            sdk = FakeSDK()
            with self.assertRaises(BundleAbsent):
                fetch_bundle(fake_store(sdk), "v0.1.0", REV, root / "absent")
            prefix = add_bundle(sdk, directory, "v0.1.0")
            result = fetch_bundle(fake_store(sdk), "v0.1.0", REV, root / "complete", anchor)
            self.assertEqual(result["manifest"], manifest)
            sdk.objects.pop(prefix + "SHA256SUMS")
            with self.assertRaisesRegex(ReleaseError, "partial"):
                fetch_bundle(fake_store(sdk), "v0.1.0", REV, root / "partial")
            with self.assertRaisesRegex(ReleaseError, "partial"):
                upload_bundle(fake_store(sdk, "upload"), directory)
            add_bundle(sdk, directory, "v0.1.0")
            sdk.objects[prefix + "unexpected/nested.txt"] = b"keep"
            with self.assertRaisesRegex(ReleaseError, "unexpected"):
                fetch_bundle(fake_store(sdk), "v0.1.0", REV, root / "unknown")

    def test_versioning_and_role_boundaries_prevent_unsafe_mutations(self):
        key = release_prefix("v0.1.0", REV) + "manifest.json"
        for status in ("Enabled", "Suspended", "unexpected"):
            sdk = FakeSDK()
            sdk.versioning = status
            with self.assertRaises(ReleaseError):
                fake_store(sdk, "upload").put_immutable(key, b"content")
            self.assertFalse(sdk.puts)
        sdk = FakeSDK()
        with self.assertRaises(ReleaseError):
            fake_store(sdk).put_immutable(key, b"content")
        with self.assertRaises(ReleaseError):
            fake_store(sdk, "upload").delete(key)
        with self.assertRaises(ReleaseError):
            fake_store(sdk, "retention").delete("image-playground/runs/private.png")
        with self.assertRaises(ReleaseError):
            fake_store(sdk, "upload").put_immutable(key.replace("manifest.json", "deployed.json"), b"marker")
        self.assertFalse(sdk.puts or sdk.deletes)

    def test_readback_corruption_fails_without_exposing_sdk_error(self):
        sdk = FakeSDK()
        key = release_prefix("v0.1.0", REV) + "manifest.json"
        def corrupt(**kwargs):
            sdk.objects[kwargs["Key"]] = b"corrupt"
            return {}
        sdk.put_object = corrupt
        with self.assertRaisesRegex(ReleaseError, "readback"):
            fake_store(sdk, "upload").put_immutable(key, b"expected")
        with self.assertRaises(ReleaseError) as caught:
            fake_store(sdk).read_json(key.replace("manifest.json", "deployed.json"))
        self.assertNotIn("sensitive-sdk-response", str(caught.exception))

    def test_unknown_upload_reports_safe_diagnostics_without_sdk_message(self):
        sdk = FakeSDK()
        key = release_prefix("v0.1.0", REV) + "manifest.json"

        def fail(**kwargs):
            raise SDKError(None)

        sdk.put_object = fail
        with self.assertRaisesRegex(ReleaseError, r"object=.*manifest\.json bytes=8 elapsed=.*error=SDKError status=unknown") as caught:
            fake_store(sdk, "upload").put_immutable(key, b"expected")
        self.assertNotIn("sensitive-sdk-response", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
