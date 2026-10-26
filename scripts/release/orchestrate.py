"""Verify release delivery through a restricted SSH session and finalize it in COS."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from common import APPLICATION, ARCHIVE, FILES, ROOT_PREFIX, SHA256, ReleaseError, json_bytes, release_prefix, require, utcnow, validate_identity, validate_manifest
from cos import CosStore, KEY, MARKER, object_identity


def timestamp(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(result.tzinfo is not None, "release time requires a timezone")
        return result
    except (ValueError, AttributeError, TypeError):
        raise ReleaseError("invalid release timestamp") from None


def validate_prefix(prefix):
    parts = prefix.removeprefix(ROOT_PREFIX).strip("/").split("/") if isinstance(prefix, str) and prefix.startswith(ROOT_PREFIX) else []
    require(len(parts) == 2 and prefix == release_prefix(*parts), "invalid protected release prefix")
    return prefix


def read_release(store, prefix):
    validate_prefix(prefix)
    version, revision = prefix.removeprefix(ROOT_PREFIX).strip("/").split("/")
    data = store.read_bytes(prefix + "manifest.json")
    try:
        manifest = validate_manifest(json.loads(data), version, revision)
        sums = {}
        for line in store.read_bytes(prefix + "SHA256SUMS", 4096).decode().splitlines():
            parts = line.split("  ")
            require(len(parts) == 2 and SHA256.fullmatch(parts[0]) and parts[1] not in sums, "invalid release checksums")
            sums[parts[1]] = parts[0]
        anchor = hashlib.sha256(data).hexdigest()
        require(sums == {ARCHIVE: manifest["archiveSha256"], "manifest.json": anchor, "sbom.spdx.json": manifest["sbomSha256"]}, "release checksum identity mismatch")
        require(hashlib.sha256(store.read_bytes(prefix + "sbom.spdx.json")).hexdigest() == manifest["sbomSha256"], "release SBOM checksum mismatch")
        return manifest, anchor
    except (ValueError, UnicodeError):
        raise ReleaseError("invalid release metadata") from None


def success_marker(manifest, anchor, deployed_at):
    timestamp(deployed_at)
    return {"schema": 1, "application": APPLICATION, "version": manifest["version"], "revision": manifest["revision"], "manifestSha256": anchor, "deployedAt": deployed_at}


def validate_success(store, prefix, manifest=None, anchor=None):
    if manifest is None:
        manifest, anchor = read_release(store, prefix)
    marker = store.read_json(prefix + MARKER)
    require(marker == success_marker(manifest, anchor, marker.get("deployedAt")), "successful release marker differs from manifest")
    return marker


def validate_receipt(receipt, expected_prefix=None, expected_manifest_sha=None, expected_manifest=None):
    require(isinstance(receipt, dict) and receipt.get("application") == APPLICATION, "server returned an invalid application receipt")
    require(receipt.get("status") in {"healthy", "healthy-draining"}, "server did not verify a healthy release")
    protected = set()
    for prefix in receipt.get("protectedPrefixes", []):
        protected.add(validate_prefix(prefix))
    for field in ("current", "previous"):
        reference = receipt.get(field)
        if reference is None:
            continue
        require(isinstance(reference, dict), "invalid server release reference")
        if reference.get("legacy"):
            require(field != "current" or expected_prefix is None, "new release unexpectedly remains legacy")
            continue
        manifest = validate_manifest(reference.get("manifest"))
        prefix = release_prefix(manifest["version"], manifest["revision"])
        require(reference.get("prefix") == prefix and isinstance(reference.get("manifestSha256"), str) and SHA256.fullmatch(reference["manifestSha256"]), "invalid server release identity")
        protected.add(prefix)
    if expected_prefix is not None:
        current = receipt.get("current") or {}
        require(current.get("prefix") == expected_prefix and current.get("manifestSha256") == expected_manifest_sha and current.get("manifest") == expected_manifest, "server receipt does not match the requested release")
    return protected


def verify_public(manifest):
    from urllib.parse import urlsplit
    base = os.environ.get("APP_PUBLIC_URL", "https://image.qintopia.cn").rstrip("/")
    parsed = urlsplit(base)
    require(parsed.scheme == "https" and parsed.netloc and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment, "invalid public application URL")
    try:
        for path in ("/api/health", "/api/version"):
            with urllib.request.urlopen(base + path, timeout=20) as response:
                require(response.status == 200, "public health check failed")
                data = response.read(16_385)
            require(len(data) <= 16_384, "public health response is too large")
            value = json.loads(data)
            require(value.get("application") == APPLICATION and value.get("version") == manifest["version"] and value.get("revision") == manifest["revision"], "public application version differs from release")
            if path == "/api/health":
                require(value.get("status") == "ready", "public application is not ready")
            else:
                require(value.get("managed") is True and value.get("browserWorkspaceSchema") == manifest["browserWorkspaceSchema"] and value.get("assetCapabilityVersion") == manifest["assetCapabilityVersion"], "public compatibility metadata differs from release")
    except ReleaseError:
        raise
    except Exception:
        raise ReleaseError("public verification failed; inspect status before retrying delivery") from None


class SSHSession:
    def __init__(self, operation, arguments=(), *, process_factory=None):
        require(operation in {"deploy", "rollback", "status", "maintenance"}, "invalid remote operation")
        host, user = os.environ.get("DEPLOY_HOST", ""), os.environ.get("DEPLOY_USER", "")
        key_file, hosts_file = os.environ.get("DEPLOY_SSH_KEY_FILE", ""), os.environ.get("DEPLOY_KNOWN_HOSTS_FILE", "")
        require(re.fullmatch(r"[A-Za-z0-9.-]+", host) and re.fullmatch(r"[A-Za-z0-9_-]+", user), "invalid deployment SSH identity")
        require(Path(key_file).is_file() and Path(hosts_file).is_file(), "deployment SSH key and pinned known_hosts are required")
        if operation in {"deploy", "rollback"}:
            require(len(arguments) == 4, "release operation requires four identity arguments")
            version, revision, prefix, anchor = arguments
            validate_identity(version, revision)
            require(prefix == release_prefix(version, revision) and SHA256.fullmatch(anchor), "invalid remote release request")
        elif operation == "maintenance":
            require(tuple(arguments) in {("dry-run",), ("apply",)}, "invalid maintenance mode")
        else:
            require(not arguments, "status takes no parameters")
        argv = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "RequestTTY=no", "-o", "StrictHostKeyChecking=yes",
                "-o", "IdentitiesOnly=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=15",
                "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "UserKnownHostsFile=" + hosts_file,
                "-i", key_file, user + "@" + host, operation, *arguments]
        factory = process_factory or subprocess.Popen
        self.process = factory(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, shell=False)
        self.operation = operation

    def receipt(self):
        line = self.process.stdout.readline(262_145)
        require(line.endswith("\n") and len(line) <= 262_144, "remote outcome is unknown; run status before any deployment retry")
        try:
            value = json.loads(line)
            require(isinstance(value, dict), "server receipt must be an object")
            return value
        except ValueError:
            raise ReleaseError("remote outcome is unknown; run status before any deployment retry") from None

    def ack(self, result):
        require(result in {"complete", "failed", "dry-run"}, "invalid delivery acknowledgement")
        self.process.stdin.write("ACK " + result + "\n")
        self.process.stdin.flush()

    def alive(self):
        return self.process.poll() is None

    def finish(self):
        try:
            code = self.process.wait(timeout=600)
        except subprocess.TimeoutExpired:
            self.close()
            raise ReleaseError("remote finalization is unknown; run status before retrying") from None
        require(code == 0, "remote finalization failed; run status before retrying")

    def close(self):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


def resolve_rollback(store, version, revision=None):
    if revision is not None:
        validate_identity(version, revision)
    else:
        validate_identity(version, "0" * 40)
    matches = []
    for item in store.list():
        match = KEY.fullmatch(item["key"])
        if not match or match[1] != version or match[3] != MARKER or (revision and match[2] != revision):
            continue
        prefix = release_prefix(match[1], match[2])
        manifest, anchor = read_release(store, prefix)
        validate_success(store, prefix, manifest, anchor)
        matches.append((manifest, anchor, prefix))
    require(len(matches) == 1, "rollback needs exactly one verified successful revision; specify the full revision if ambiguous")
    return matches[0]


def deliver(operation, version, revision=None, key=None, manifest_sha=None, *, store=None, session_factory=SSHSession, public_check=verify_public):
    store = store or CosStore(role="marker")
    if operation == "rollback" and key is None and manifest_sha is None:
        manifest, manifest_sha, key = resolve_rollback(store, version, revision)
        revision = manifest["revision"]
    else:
        validate_identity(version, revision)
        require(key == release_prefix(version, revision) and isinstance(manifest_sha, str) and SHA256.fullmatch(manifest_sha), "release identity is incomplete")
        manifest, anchor = read_release(store, key)
        require(anchor == manifest_sha, "requested manifest checksum differs from COS")
    if operation == "rollback":
        require(manifest["rollbackCompatibility"]["mode"] == "compatible", "target release is not declared rollback compatible")
        validate_success(store, key, manifest, manifest_sha)
    session = session_factory(operation, (version, revision, key, manifest_sha))
    try:
        receipt = session.receipt()
        validate_receipt(receipt, key, manifest_sha, manifest)
        public_check(manifest)
        if store.head(key + MARKER):
            marker = validate_success(store, key, manifest, manifest_sha)
        else:
            require(operation == "deploy", "rollback target lost its success marker")
            marker = success_marker(manifest, manifest_sha, utcnow())
            store.put_immutable(key + MARKER, json_bytes(marker))
        session.ack("complete")
        session.finish()
        return {"application": APPLICATION, "status": "verified", "receipt": receipt, "marker": marker}
    except BaseException:
        try:
            session.ack("failed")
        except Exception:
            pass
        raise
    finally:
        session.close()


def inventory_signature(items):
    return sorted((item["key"], str(item.get("etag", "")), str(item.get("lastModified", "")), int(item.get("size", 0))) for item in items)


def retention_plan(store, protected_prefixes, *, now=None, keep=5, candidate_days=7):
    protected = {validate_prefix(prefix) for prefix in protected_prefixes}
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=candidate_days)
    groups, skipped = {}, []
    for item in store.list():
        match = KEY.fullmatch(item["key"])
        if not match:
            parts = item["key"].removeprefix(ROOT_PREFIX).split("/")
            try:
                if len(parts) >= 3:
                    prefix = release_prefix(parts[0], parts[1])
                    groups.setdefault(prefix, []).append(item)
                    continue
            except ReleaseError:
                pass
            skipped.append({"key": item["key"], "reason": "unknown-object"})
            continue
        prefix = release_prefix(match[1], match[2])
        groups.setdefault(prefix, []).append(item)
    kept, successes, candidates = [], [], []
    for prefix, items in sorted(groups.items()):
        if prefix in protected:
            kept.append({"prefix": prefix, "reason": "server-protected"})
        names = {item["key"].removeprefix(prefix) for item in items}
        if names not in (set(FILES), set(FILES) | {MARKER}):
            skipped.append({"prefix": prefix, "reason": "unknown-or-incomplete-release"})
            continue
        try:
            manifest, anchor = read_release(store, prefix)
            item = {"prefix": prefix, "inventory": inventory_signature(items), "keys": sorted(entry["key"] for entry in items), "manifest": manifest, "manifestSha256": anchor}
            if MARKER in names:
                marker = validate_success(store, prefix, manifest, anchor)
                item["deployedAt"] = marker["deployedAt"]
                successes.append(item)
            elif prefix not in protected and all(timestamp(entry["lastModified"]) <= cutoff for entry in items):
                item["reason"] = "expired-candidate"
                candidates.append(item)
            else:
                kept.append({"prefix": prefix, "reason": "candidate-under-seven-days"})
        except ReleaseError:
            skipped.append({"prefix": prefix, "reason": "invalid-release-metadata"})
    successes.sort(key=lambda item: (timestamp(item["deployedAt"]), item["prefix"]), reverse=True)
    for item in successes[:keep]:
        if item["prefix"] not in protected:
            kept.append({"prefix": item["prefix"], "reason": "recent-success"})
    deletions = candidates + [{**item, "reason": "older-success"} for item in successes[keep:] if item["prefix"] not in protected]
    return {"status": "planned", "protectedPrefixes": sorted(protected), "kept": kept, "skipped": skipped, "deletions": deletions}


def apply_retention(store, plan, *, connection_alive=lambda: True):
    protected = {validate_prefix(prefix) for prefix in plan["protectedPrefixes"]}
    removed = []
    for item in plan["deletions"]:
        prefix = validate_prefix(item["prefix"])
        require(prefix not in protected, "retention attempted to delete a protected release")
        require(inventory_signature(store.list(prefix)) == item["inventory"], "retention inventory changed; replan before deleting")
        manifest, anchor = read_release(store, prefix)
        require(manifest == item["manifest"] and anchor == item["manifestSha256"], "retention release identity changed")
        # Read the archive bytes before deleting; corrupt payloads are retained for investigation.
        require(store.object_sha(prefix + ARCHIVE) == item["manifest"]["archiveSha256"], "retention found a corrupt archive; no deletion performed")
        keys = sorted(item["keys"], key=lambda key: key.endswith(MARKER))
        require(set(keys) in ({prefix + name for name in FILES}, {prefix + name for name in FILES} | {prefix + MARKER}), "invalid retention key set")
        for key in keys:
            require(connection_alive(), "deployment lock connection ended; no further COS deletion is allowed")
            object_identity(key)
            store.delete(key)
            removed.append(key)
    return {"status": "complete", "deletedKeys": removed, "kept": plan["kept"], "skipped": plan["skipped"]}


def maintenance(*, apply=False, store=None, session_factory=SSHSession):
    store = store or CosStore(role="retention")
    session = session_factory("maintenance", ("apply" if apply else "dry-run",))
    try:
        receipt = session.receipt()
        protected = validate_receipt(receipt)
        plan = retention_plan(store, protected)
        result = apply_retention(store, plan, connection_alive=session.alive) if apply else plan
        session.ack("complete" if apply else "dry-run")
        session.finish()
        return {"application": APPLICATION, "mode": "apply" if apply else "dry-run", "receipt": receipt, "retention": result}
    except BaseException:
        try:
            session.ack("failed")
        except Exception:
            pass
        raise
    finally:
        session.close()


def status(*, session_factory=SSHSession):
    session = session_factory("status")
    try:
        receipt = session.receipt()
        require(receipt.get("application") == APPLICATION, "invalid server status")
        session.finish()
        return receipt
    finally:
        session.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    for name in ("deploy", "rollback"):
        command = commands.add_parser(name)
        command.add_argument("--version", required=True)
        command.add_argument("--revision", required=name == "deploy")
        command.add_argument("--key", required=name == "deploy")
        command.add_argument("--manifest-sha", required=name == "deploy")
    commands.add_parser("status")
    command = commands.add_parser("maintenance")
    mode = command.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        if args.operation in {"deploy", "rollback"}:
            result = deliver(args.operation, args.version, args.revision, args.key, args.manifest_sha)
        elif args.operation == "maintenance":
            result = maintenance(apply=args.apply)
        else:
            result = status()
        print(json.dumps(result, sort_keys=True))
        return 0
    except ReleaseError as error:
        print("QinTopia image: " + str(error), file=sys.stderr)
        return 1
    except Exception:
        print("QinTopia image: delivery outcome is unknown; run status before retrying", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
