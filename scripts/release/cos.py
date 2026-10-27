"""Private, prefix-scoped and immutable release storage. Application images are out of scope."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import os
import re
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

from common import (APPLICATION, ARCHIVE, FILES, ROOT_PREFIX, SHA256, ReleaseError,
                    json_bytes, release_prefix, require, sha256_file, validate_bundle,
                    validate_identity, validate_manifest)

MARKER = "deployed.json"
OBJECTS = set(FILES) | {MARKER}
KEY = re.compile(r"qintopia-image/releases/(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))/([0-9a-f]{40})/([^/]+)\Z")
UPLOAD_PART_SIZE_MB = 2
UPLOAD_MAX_THREADS = 2
UPLOAD_RETRIES = 1
UPLOAD_TIMEOUT = (60, 60)
_DIAGNOSTIC_LOCK = threading.Lock()


class BundleAbsent(ReleaseError):
    pass


def _status(error):
    try:
        value = error.get_status_code() if hasattr(error, "get_status_code") else getattr(error, "status_code", None)
        code = int(value)
        return code if 100 <= code <= 599 else None
    except (AttributeError, TypeError, ValueError):
        return None


def _error_fields(error):
    # SDK exceptions preserve the requests exception as __context__, even when
    # their public message is flattened. Never print that message or request URL.
    allowed = {"CosClientError", "CosServiceError", "ReleaseError", "TimeoutError", "Timeout",
               "ReadTimeout", "ConnectTimeout", "ReadTimeoutError", "ConnectTimeoutError",
               "ConnectionError", "ProtocolError", "SSLError", "ProxyError", "InvalidHeader",
               "OSError", "BrokenPipeError", "ConnectionResetError", "MaxRetryError"}
    pending, seen, causes = [error], set(), []
    while pending and len(seen) < 16:
        item = pending.pop(0)
        if not isinstance(item, BaseException) or id(item) in seen:
            continue
        seen.add(id(item))
        name = type(item).__name__
        if name in allowed and name not in causes:
            causes.append(name)
        pending.extend([item.__cause__, item.__context__, *item.args])
    status = _status(error)
    if status is not None:
        category = "http_error"
    elif any("Timeout" in name for name in causes):
        category = "timeout"
    elif any(name in causes for name in ("ConnectionError", "ProtocolError", "SSLError", "ProxyError")):
        category = "connection_error"
    else:
        category = "client_error"
    return {"errorType": type(error).__name__ if type(error).__name__ in allowed else "Exception",
            "httpStatus": status, "causes": causes, "category": category}


def _transfer_event(operation, phase, key, **fields):
    object_identity(key)
    with _DIAGNOSTIC_LOCK:
        print(json.dumps({"event": "cos_transfer", "operation": operation, "phase": phase,
                          "key": key, **fields}, sort_keys=True), file=sys.stderr, flush=True)


def make_cos_client(config, *, session=None, retry=UPLOAD_RETRIES):
    """Observe real SDK stages before its thread pool discards part failures."""
    from qcloud_cos import CosS3Client
    # The pinned SDK logs str(error), which can contain signed URLs and response
    # bodies. This dedicated release process emits only the structured events below.
    logger = logging.getLogger("qcloud_cos")
    logger.handlers = [logging.NullHandler()]
    logger.propagate = False

    class ReleaseCosClient(CosS3Client):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._failed_part = threading.Event()

        def upload_file(self, *args, **kwargs):
            self._failed_part.clear()
            return super().upload_file(*args, **kwargs)

        def _observed(self, operation, key, invoke, **fields):
            started = time.monotonic()
            _transfer_event(operation, "start", key, elapsedSeconds=0, **fields)
            try:
                response = invoke()
            except Exception as error:
                _transfer_event(operation, "failed", key, elapsedSeconds=round(time.monotonic() - started, 3), **fields, **_error_fields(error))
                raise
            _transfer_event(operation, "complete", key, elapsedSeconds=round(time.monotonic() - started, 3), **fields)
            return response

        def put_object(self, Bucket, Body, Key, EnableMD5=False, **kwargs):
            call = super().put_object
            return self._observed("put_object", Key, lambda: call(Bucket=Bucket, Body=Body, Key=Key, EnableMD5=EnableMD5, **kwargs))

        def create_multipart_upload(self, Bucket, Key, **kwargs):
            call = super().create_multipart_upload
            return self._observed("create_multipart_upload", Key, lambda: call(Bucket=Bucket, Key=Key, **kwargs))

        def upload_part(self, Bucket, Key, Body, PartNumber, UploadId, EnableMD5=False, **kwargs):
            # Let the in-flight part finish, but do not spend another timeout on
            # every queued part once the SDK has exhausted one part's retries.
            if self._failed_part.is_set():
                raise ReleaseError("remaining parts stopped after an earlier part failed")
            call = super().upload_part
            try:
                return self._observed("upload_part", Key, lambda: call(Bucket=Bucket, Key=Key, Body=Body, PartNumber=PartNumber, UploadId=UploadId, EnableMD5=EnableMD5, **kwargs), part=PartNumber, bytes=len(Body))
            except Exception:
                self._failed_part.set()
                raise

        def complete_multipart_upload(self, Bucket, Key, UploadId, MultipartUpload=None, **kwargs):
            call = super().complete_multipart_upload
            # upload_file does not forward its kwargs to completion. Keep the
            # non-overwrite guard explicit at the final write as well as initiation.
            kwargs["Metadata"] = {**kwargs.get("Metadata", {}), "x-cos-forbid-overwrite": "true"}
            return self._observed("complete_multipart_upload", Key, lambda: call(Bucket=Bucket, Key=Key, UploadId=UploadId, MultipartUpload=MultipartUpload or {}, **kwargs))

    return ReleaseCosClient(config, retry=retry, session=session)


def _upload_diagnostic(error, key, size, started):
    status = _status(error)
    status_text = str(status) if status is not None else "unknown"
    return f"object={key} bytes={size} elapsed={time.monotonic() - started:.1f}s error={type(error).__name__} status={status_text}"


def object_identity(key):
    match = KEY.fullmatch(key) if isinstance(key, str) else None
    require(match is not None and match[3] in OBJECTS, "object key is outside the release allowlist")
    return match[1], match[2], match[3]


class CosStore:
    def __init__(self, bucket=None, region=None, credentials=None, role="reader", client=None):
        require(role in {"reader", "upload", "marker", "retention"}, "invalid COS role")
        self.bucket = bucket or os.environ.get("COS_BUCKET")
        self.region = region or os.environ.get("COS_REGION")
        require(isinstance(self.bucket, str) and re.fullmatch(r"[a-z0-9-]+-\d+", self.bucket), "COS bucket is missing or invalid")
        require(isinstance(self.region, str) and re.fullmatch(r"[a-z0-9-]+", self.region), "COS region is missing or invalid")
        self.role, self.credentials, self.client = role, credentials, client
        self.transfer_client = None
        self.prefix = ROOT_PREFIX
        self._mutation_checked = False

    def _client(self):
        if self.client is not None:
            return self.client
        try:
            from qcloud_cos import CosConfig
        except ImportError:
            raise ReleaseError("install the pinned release COS dependency") from None
        prefix = {"reader": "READ", "upload": "UPLOAD", "marker": "UPLOAD", "retention": "RETENTION"}[self.role] + "_COS_"
        credentials = self.credentials or {}
        secret_id = credentials.get("secretId") or credentials.get("SecretId") or credentials.get("COS_SECRET_ID") or os.environ.get(prefix + "SECRET_ID")
        secret_key = credentials.get("secretKey") or credentials.get("SecretKey") or credentials.get("COS_SECRET_KEY") or os.environ.get(prefix + "SECRET_KEY")
        token = credentials.get("token") or credentials.get("Token") or credentials.get("COS_TOKEN") or os.environ.get(prefix + "TOKEN")
        require(secret_id and secret_key, "COS credentials are not configured for this role")
        endpoint = os.environ.get("COS_ENDPOINT")
        require(not endpoint or endpoint in {"cos.accelerate.myqcloud.com", f"cos.{self.region}.myqcloud.com"}, "unsupported COS endpoint")
        # requests uses the connect timeout while sending the request body too.
        # A 10-second value also limits request-body writes to ten seconds.
        timeout = UPLOAD_TIMEOUT if self.role in {"upload", "marker"} else (10, 60)
        config = dict(Region=self.region, SecretId=secret_id, SecretKey=secret_key, Token=token, Scheme="https", Timeout=timeout)
        if endpoint:
            config["Endpoint"] = endpoint
        self.client = make_cos_client(CosConfig(**config), retry=UPLOAD_RETRIES if self.role in {"upload", "marker"} else 3)
        return self.client

    def _data_client(self):
        """Route only release payload traffic through an explicitly chosen endpoint.

        Bucket listing/versioning remain on the regional API; acceleration does
        not support all of those control operations. Readers/retention stay regional.
        """
        endpoint = os.environ.get("COS_UPLOAD_ENDPOINT", "")
        if self.role not in {"upload", "marker"} or not endpoint:
            return self._client()
        require(endpoint == "cos.accelerate.myqcloud.com", "unsupported release upload endpoint")
        if self.transfer_client is None:
            from qcloud_cos import CosConfig
            original = self._client().get_conf()
            config = CosConfig(Region=self.region, Endpoint=endpoint, SecretId=original._secret_id,
                               SecretKey=original._secret_key, Token=original._token,
                               Scheme="https", Timeout=UPLOAD_TIMEOUT)
            self.transfer_client = make_cos_client(config)
        return self.transfer_client

    def _mutating(self):
        require(self.role in {"upload", "marker", "retention"}, "read-only COS role cannot mutate objects")
        if self._mutation_checked:
            return
        try:
            result = self._client().get_bucket_versioning(Bucket=self.bucket)
        except Exception:
            raise ReleaseError("cannot verify COS bucket versioning; refusing mutation") from None
        # The COS API omits Status when versioning has never been enabled.
        require(isinstance(result, dict) and result.get("Status", "Disabled") == "Disabled", "release storage requires versioning never enabled or Disabled")
        self._mutation_checked = True

    def head(self, key):
        object_identity(key)
        try:
            result = self._client().head_object(Bucket=self.bucket, Key=key)
        except Exception as error:
            if _status(error) == 404:
                return None
            raise ReleaseError("COS metadata request failed") from None
        return {"key": key, "etag": result.get("ETag", ""), "size": int(result.get("Content-Length", 0)),
                "lastModified": result.get("Last-Modified", ""), "sha256": result.get("x-cos-meta-sha256")}

    def _stream(self, key):
        object_identity(key)
        try:
            response = self._data_client().get_object(Bucket=self.bucket, Key=key)
            body = response["Body"]
            return body.get_raw_stream() if hasattr(body, "get_raw_stream") else io.BytesIO(body) if isinstance(body, bytes) else body
        except Exception:
            raise ReleaseError("COS object download failed") from None

    def read_bytes(self, key, limit=8 * 1024 * 1024):
        stream = self._stream(key)
        try:
            value = stream.read(limit + 1)
            require(isinstance(value, bytes) and len(value) <= limit, "COS metadata exceeds the allowed size")
            return value
        except ReleaseError:
            raise
        except Exception:
            raise ReleaseError("COS response could not be read") from None
        finally:
            if hasattr(stream, "close"):
                stream.close()

    def read_json(self, key):
        try:
            result = json.loads(self.read_bytes(key))
            require(isinstance(result, dict), "COS JSON object must be a mapping")
            return result
        except (ValueError, UnicodeError):
            raise ReleaseError("COS object is not valid JSON") from None

    def download(self, key, path, version_id=None):
        require(version_id is None, "unversioned release storage does not accept VersionId overrides")
        output = Path(path)
        require(not output.exists() and not output.is_symlink(), "download destination already exists")
        stream = self._stream(key)
        total = 0
        try:
            with output.open("xb") as destination:
                while True:
                    block = stream.read(1024 * 1024)
                    if not block:
                        break
                    total += len(block)
                    require(total <= 1024 * 1024 * 1024, "release download is too large")
                    destination.write(block)
        except ReleaseError:
            raise
        except Exception:
            raise ReleaseError("COS object download failed") from None
        finally:
            if hasattr(stream, "close"):
                stream.close()

    def object_sha(self, key):
        stream = self._stream(key)
        digest = hashlib.sha256()
        total = 0
        try:
            while True:
                block = stream.read(1024 * 1024)
                if not block:
                    break
                total += len(block)
                require(total <= 1024 * 1024 * 1024, "COS object is too large")
                digest.update(block)
            return digest.hexdigest()
        finally:
            if hasattr(stream, "close"):
                stream.close()

    def put_immutable(self, key, body):
        _, _, name = object_identity(key)
        require(self.role == "marker" if name == MARKER else self.role == "upload", "COS role cannot write this object type")
        if isinstance(body, (str, Path)):
            path = Path(body)
            expected = sha256_file(path)
            size = path.stat().st_size
            factory = None
        else:
            require(isinstance(body, bytes), "invalid COS upload body")
            expected = hashlib.sha256(body).hexdigest()
            size = len(body)
            factory = lambda: io.BytesIO(body)
        if self.head(key) is not None:
            require(self.object_sha(key) == expected, "immutable object already has different bytes")
            return {"status": "existing", "sha256": expected}
        self._mutating()
        started = time.monotonic()
        _transfer_event("upload", "start", key, bytes=size, partSizeMiB=UPLOAD_PART_SIZE_MB, concurrency=UPLOAD_MAX_THREADS, retries=UPLOAD_RETRIES)
        try:
            metadata = {"x-cos-forbid-overwrite": "true", "x-cos-meta-sha256": expected}
            if factory is None:
                # The SDK switches files larger than PartSize to resumable multipart upload.
                response = self._data_client().upload_file(
                    Bucket=self.bucket, Key=key, LocalFilePath=str(path),
                    PartSize=UPLOAD_PART_SIZE_MB, MAXThread=UPLOAD_MAX_THREADS,
                    ACL="private", Metadata=metadata, EnableMD5=True,
                )
            else:
                with factory() as stream:
                    response = self._data_client().put_object(
                        Bucket=self.bucket, Key=key, Body=stream, ACL="private",
                        ContentLength=str(size), Metadata=metadata,
                    )
            require(response.get("x-cos-version-id") in {None, "", "null"}, "bucket versioning changed during upload")
        except ReleaseError:
            raise
        except Exception as error:
            if _status(error) not in {409, 412}:
                detail = _upload_diagnostic(error, key, size, started)
                raise ReleaseError(f"COS upload outcome is unknown ({detail}); inspect the immutable prefix before retrying") from None
        _transfer_event("readback_sha256", "start", key, bytes=size)
        require(self.object_sha(key) == expected, "uploaded object readback checksum mismatch")
        _transfer_event("upload", "verified", key, bytes=size, elapsedSeconds=round(time.monotonic() - started, 3))
        return {"status": "uploaded", "sha256": expected}

    def list(self, prefix=ROOT_PREFIX):
        if prefix != ROOT_PREFIX:
            parts = prefix.removeprefix(ROOT_PREFIX).strip("/").split("/") if prefix.startswith(ROOT_PREFIX) else []
            require(len(parts) == 2 and prefix == release_prefix(*parts), "invalid release listing prefix")
        result, marker = [], ""
        while True:
            try:
                page = self._client().list_objects(Bucket=self.bucket, Prefix=prefix, Marker=marker, MaxKeys=1000)
            except Exception:
                raise ReleaseError("COS release listing failed") from None
            for item in page.get("Contents", []):
                key = item.get("Key")
                require(isinstance(key, str) and key.startswith(prefix), "COS returned an object outside the requested prefix")
                result.append({"key": key, "lastModified": item.get("LastModified"), "etag": item.get("ETag", ""), "size": int(item.get("Size", 0))})
            if str(page.get("IsTruncated", "false")).lower() != "true":
                return result
            next_marker = page.get("NextMarker")
            require(isinstance(next_marker, str) and next_marker and next_marker != marker, "COS pagination did not advance")
            marker = next_marker

    def delete(self, key):
        object_identity(key)
        require(self.role == "retention", "only the retention identity may delete release objects")
        self._mutating()
        try:
            self._client().delete_object(Bucket=self.bucket, Key=key)
        except Exception:
            raise ReleaseError("COS deletion outcome is unknown; inspect the prefix before retrying") from None
        require(self.head(key) is None, "COS object still exists after deletion")


def upload_bundle(store, directory, prefix=ROOT_PREFIX):
    require(prefix == ROOT_PREFIX, "invalid release root")
    root = Path(directory)
    try:
        manifest = json.loads((root / "manifest.json").read_bytes())
    except (OSError, ValueError):
        raise ReleaseError("bundle manifest is unavailable") from None
    validate_manifest(manifest)
    anchor = sha256_file(root / "manifest.json")
    validate_bundle(root, anchor, manifest["version"], manifest["revision"])
    key = release_prefix(manifest["version"], manifest["revision"])
    # Only absent or already complete identities are reusable. Partial uploads
    # require operator inspection or a new version, never a silently rebuilt bundle.
    existing = store.list(key)
    existing_names = {item["key"].removeprefix(key) for item in existing}
    require(not existing_names or existing_names in (set(FILES), set(FILES) | {MARKER}), "release prefix is partial or contains unknown objects")
    for name in FILES:
        store.put_immutable(key + name, root / name)
    return {"application": APPLICATION, "version": manifest["version"], "revision": manifest["revision"],
            "prefix": key, "key": key, "manifestSha256": anchor}


def fetch_bundle(store, version, revision, directory, manifest_sha=None):
    key = release_prefix(version, revision)
    items = store.list(key)
    names = {item["key"].removeprefix(key) for item in items}
    if not names:
        raise BundleAbsent("release bundle does not exist")
    require(names in (set(FILES), set(FILES) | {MARKER}), "release prefix is partial or has unexpected objects; refusing rebuild")
    target = Path(directory)
    require(not target.is_symlink() and (not target.exists() or (target.is_dir() and not any(target.iterdir()))), "fetch destination must be empty")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="qintopia-image-fetch-", dir=target.parent) as scratch:
        staging = Path(scratch)
        for name in FILES:
            store.download(key + name, staging / name)
        anchor = manifest_sha or sha256_file(staging / "manifest.json")
        manifest = validate_bundle(staging, anchor, version, revision)
        require(not target.exists() or not any(target.iterdir()), "fetch destination changed during download")
        target.mkdir(exist_ok=True)
        for name in FILES:
            os.replace(staging / name, target / name)
    return {"application": APPLICATION, "version": version, "revision": revision, "key": key,
            "prefix": key, "manifestSha256": anchor, "manifest": manifest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    upload = commands.add_parser("upload")
    upload.add_argument("--directory", required=True)
    upload.add_argument("--prefix", default=ROOT_PREFIX)
    for name in ("fetch", "validate"):
        command = commands.add_parser(name)
        command.add_argument("--version", required=True)
        command.add_argument("--revision", required=True)
        command.add_argument("--directory", required=True)
        command.add_argument("--manifest-sha")
    args = parser.parse_args()
    try:
        if args.command == "upload":
            result = upload_bundle(CosStore(role="upload"), args.directory, args.prefix)
        elif args.command == "fetch":
            result = fetch_bundle(CosStore(), args.version, args.revision, args.directory, args.manifest_sha)
        else:
            anchor = args.manifest_sha or sha256_file(Path(args.directory) / "manifest.json")
            result = validate_bundle(args.directory, anchor, args.version, args.revision)
        print(json.dumps(result))
        return 0
    except BundleAbsent:
        print(json.dumps({"status": "absent"}))
        return 3
    except ReleaseError as error:
        print("QinTopia image: " + str(error), file=sys.stderr)
        return 1
    except Exception:
        print("QinTopia image: COS operation failed; inspect release state", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
