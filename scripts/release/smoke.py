"""Exercise the real Linux standalone bundle locally, without cloud access or publication."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from common import ARCHIVE, ReleaseError, require, safe_extract_runtime, sha256_file, validate_bundle
from package import git, package_bundle


def smoke(source_root):
    source = Path(source_root).resolve()
    require(platform.system() == "Linux" and platform.machine() in {"x86_64", "amd64"}, "standalone smoke requires Linux amd64")
    revision = git(source, "rev-parse", "HEAD")
    version = "v" + json.loads((source / "package.json").read_text())["version"]
    # This disposable CI bundle has no release tag, is never uploaded, and is
    # destroyed below. The production package command still enforces the tag.
    with tempfile.TemporaryDirectory(prefix="image-release-smoke-") as scratch:
        root = Path(scratch)
        bundle = root / "bundle"
        package_bundle(source, bundle, version, revision, verify_source=False)
        anchor = sha256_file(bundle / "manifest.json")
        manifest = validate_bundle(bundle, anchor, version, revision)
        runtime = root / "runtime"
        safe_extract_runtime(bundle / ARCHIVE, runtime, manifest)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        environment = {**os.environ, "NODE_ENV": "production", "HOSTNAME": "127.0.0.1", "PORT": str(port),
                       "NEXT_TELEMETRY_DISABLED": "1", "APP_RELEASE": "untrusted-environment-label",
                       "COS_BUCKET": "image-release-smoke-1234567890", "COS_REGION": "ap-shanghai",
                       "COS_SECRET_ID": "synthetic-smoke-id", "COS_SECRET_KEY": "synthetic-smoke-key",
                       "COS_DOMAIN": "https://example.com", "CDN_AUTH_KEY": "synthetic-cdn-key-for-smoke",
                       "ASSET_ACCESS_SECRET": "synthetic-asset-secret-only-for-smoke"}
        logs = (root / "server.log").open("w+")
        process = subprocess.Popen(["node", "server.js"], cwd=runtime, env=environment, stdout=logs, stderr=subprocess.STDOUT)
        def request(path):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}" + path, timeout=3) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as error:
                return error.code, error.read()
        def failure(message):
            logs.flush()
            logs.seek(0)
            diagnostic = logs.read()[-4000:]
            for name, value in environment.items():
                if any(part in name for part in ("SECRET", "TOKEN", "PASSWORD", "CREDENTIAL", "KEY")) and len(value) >= 8:
                    diagnostic = diagnostic.replace(value, "[redacted]")
            return ReleaseError(message + "\n" + diagnostic)
        try:
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise failure("standalone exited before becoming healthy")
                try:
                    status, body = request("/api/health")
                    if status == 200:
                        break
                except OSError:
                    pass
                time.sleep(0.2)
            else:
                raise failure("standalone did not become healthy")
            health = json.loads(body)
            require(health.get("status") == "ready" and health.get("revision") == revision, "standalone readiness identity mismatch")
            status, body = request("/api/version")
            identity = json.loads(body)
            require(status == 200 and identity.get("managed") is True and identity.get("version") == version and identity.get("revision") == revision, "standalone version differs from the bundle")
            status, body = request("/")
            require(status == 200 and b"/_next/static/" in body, "standalone homepage or static references are missing")
            static_file = next((runtime / ".next/static").rglob("*.css"), None)
            require(static_file is not None, "standalone stylesheet is missing")
            status, body = request("/_next/static/" + static_file.relative_to(runtime / ".next/static").as_posix())
            require(status == 200 and body == static_file.read_bytes(), "standalone static asset differs from the bundle")
            (runtime / "release.json").unlink()
            status, _ = request("/api/version")
            require(status == 503, "production accepted missing release metadata")
            print(json.dumps({"standaloneSmoke": "passed", "version": version, "revision": revision,
                              "platform": "linux/amd64", "cloudCalls": 0, "modelCalls": 0}))
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            logs.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    args = parser.parse_args()
    try:
        smoke(args.source_root)
    except ReleaseError as error:
        parser.exit(1, "Image release smoke: " + str(error) + "\n")
