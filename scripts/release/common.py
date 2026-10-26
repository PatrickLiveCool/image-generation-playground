"""Release identities and archive validation shared by CI and the restricted server."""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import tarfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

APPLICATION = "qintopia-image"
ROOT_PREFIX = "qintopia-image/releases/"
ARCHIVE = "app.tar.gz"
FILES = (ARCHIVE, "manifest.json", "SHA256SUMS", "sbom.spdx.json")
VERSION = re.compile(r"v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\Z")
REVISION = re.compile(r"[0-9a-f]{40}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
METADATA_FIELDS = {"schema", "application", "version", "revision", "platform", "builtAt", "browserWorkspaceSchema", "assetCapabilityVersion"}
MANIFEST_FIELDS = METADATA_FIELDS | {"databaseMode", "rollbackCompatibility", "archiveSha256", "sbomSha256", "releasePolicySha256"}
MAX_EXPANDED_BYTES = 1024 * 1024 * 1024


class ReleaseError(RuntimeError):
    """Safe operator-facing message. Do not include SDK errors, credentials or URLs."""


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def utcnow():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_identity(version, revision):
    require(isinstance(version, str) and VERSION.fullmatch(version), "invalid release version")
    require(isinstance(revision, str) and REVISION.fullmatch(revision), "invalid release revision")
    return version, revision


def release_prefix(version, revision):
    validate_identity(version, revision)
    return f"{ROOT_PREFIX}{version}/{revision}/"


def validate_policy(value, version):
    require(isinstance(value, dict), "release policy must be an object")
    require(set(value) == {"application", "version", "databaseMode", "browserWorkspaceSchema", "assetCapabilityVersion", "rollbackCompatibility"}, "unexpected release policy fields")
    require(value["application"] == APPLICATION and value["version"] == version.removeprefix("v"), "release policy identity mismatch")
    require(value["databaseMode"] == "none", "this application has no database migration adapter")
    require(type(value["browserWorkspaceSchema"]) is int and value["browserWorkspaceSchema"] == 1, "unsupported browser workspace schema")
    require(type(value["assetCapabilityVersion"]) is int and value["assetCapabilityVersion"] == 1, "unsupported asset capability version")
    compatibility = value["rollbackCompatibility"]
    require(isinstance(compatibility, dict) and set(compatibility) == {"mode", "reason"}, "invalid rollback policy")
    require(compatibility["mode"] in {"compatible", "forward-only"}, "unsupported rollback mode")
    require(isinstance(compatibility["reason"], str) and 0 < len(compatibility["reason"].strip()) <= 1000, "rollback reason is required")
    return value


def validate_manifest(value, version=None, revision=None):
    require(isinstance(value, dict) and set(value) == MANIFEST_FIELDS, "invalid manifest fields")
    require(type(value["schema"]) is int and value["schema"] == 1, "unsupported manifest schema")
    require(value["application"] == APPLICATION and value["platform"] == "linux/amd64", "manifest application or platform mismatch")
    actual_version, actual_revision = validate_identity(value["version"], value["revision"])
    require(version is None or version == actual_version, "manifest version mismatch")
    require(revision is None or revision == actual_revision, "manifest revision mismatch")
    try:
        stamp = datetime.fromisoformat(value["builtAt"].replace("Z", "+00:00"))
        require(stamp.tzinfo is not None and stamp.utcoffset().total_seconds() == 0, "build timestamp must be UTC")
    except (ValueError, TypeError, AttributeError):
        raise ReleaseError("invalid build timestamp") from None
    for key in ("archiveSha256", "sbomSha256", "releasePolicySha256"):
        require(isinstance(value[key], str) and SHA256.fullmatch(value[key]), "invalid manifest digest")
    validate_policy({key: value[key] for key in ("application", "databaseMode", "browserWorkspaceSchema", "assetCapabilityVersion", "rollbackCompatibility")} | {"version": actual_version[1:]}, actual_version)
    return value


def safe_runtime_path(name):
    require(isinstance(name, str) and name and "\x00" not in name and "\\" not in name, "invalid archive path")
    path = PurePosixPath(name)
    require(path.parts and not path.is_absolute() and ".." not in path.parts and path.as_posix() == name.rstrip("/"), "archive path escapes runtime")
    forbidden = {".git", ".local-ops", ".generated-images", ".aws", ".codex", ".agents", "image-playground", "uploads", "user-data"}
    require(not any(part in forbidden or part.startswith(".env") for part in path.parts), "runtime contains private or generated data")
    require(path.suffix.lower() not in {".pem", ".key", ".p12", ".pfx", ".dump", ".bak"}, "runtime contains a private file")
    require(not (len(path.parts) >= 2 and path.parts[:2] == (".next", "cache")), "runtime contains a writable cache")
    return path


def inspect_archive(archive, expected_manifest=None):
    if expected_manifest is not None:
        validate_manifest(expected_manifest)
        require(sha256_file(archive) == expected_manifest["archiveSha256"], "archive digest mismatch")
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            members = bundle.getmembers()
            require(0 < len(members) <= 100_000, "invalid runtime file count")
            seen, total = set(), 0
            for member in members:
                path = safe_runtime_path(member.name)
                require(str(path) not in seen, "duplicate archive path")
                seen.add(str(path))
                require(member.isfile() or member.isdir(), "runtime links and special files are prohibited")
                total += member.size
                require(total <= MAX_EXPANDED_BYTES, "runtime archive is too large")
            require({"server.js", "package.json", "release.json", "release-policy.json"} <= seen, "runtime entry files are missing")
            def read_json(name):
                member = bundle.getmember(name)
                require(member.isfile() and member.size <= 64 * 1024, "runtime metadata is too large")
                data = bundle.extractfile(member).read()
                return json.loads(data), data
            metadata, _ = read_json("release.json")
            policy, policy_bytes = read_json("release-policy.json")
            require(isinstance(metadata, dict) and set(metadata) == METADATA_FIELDS, "invalid runtime release metadata")
            if expected_manifest is not None:
                require(metadata == {key: expected_manifest[key] for key in METADATA_FIELDS}, "runtime identity differs from manifest")
                require(hashlib.sha256(policy_bytes).hexdigest() == expected_manifest["releasePolicySha256"], "runtime policy digest mismatch")
                require(policy["rollbackCompatibility"] == expected_manifest["rollbackCompatibility"], "runtime rollback policy mismatch")
            validate_policy(policy, metadata["version"])
            return metadata
    except (tarfile.TarError, OSError, KeyError, ValueError, UnicodeError):
        raise ReleaseError("invalid runtime archive") from None


def safe_extract_runtime(archive, target, expected_manifest=None):
    inspect_archive(archive, expected_manifest)
    destination = Path(target)
    require(not destination.is_symlink(), "runtime destination is a symlink")
    require(not destination.exists() or (destination.is_dir() and not any(destination.iterdir())), "runtime destination must be empty")
    destination.mkdir(parents=True, exist_ok=True, mode=0o755)
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            path = destination.joinpath(*safe_runtime_path(member.name).parts)
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True, mode=0o755)
            else:
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                with bundle.extractfile(member) as source, path.open("xb") as output:
                    shutil.copyfileobj(source, output)
                path.chmod(0o755 if member.mode & 0o111 else 0o644)
    return destination


def validate_bundle(directory, expected_manifest_sha, version, revision):
    validate_identity(version, revision)
    require(isinstance(expected_manifest_sha, str) and SHA256.fullmatch(expected_manifest_sha), "invalid manifest checksum anchor")
    root = Path(directory)
    require(root.is_dir() and not root.is_symlink(), "invalid bundle directory")
    require({p.name for p in root.iterdir()} == set(FILES), "bundle must contain exactly the four release files")
    require(all((root / name).is_file() and not (root / name).is_symlink() for name in FILES), "bundle contains invalid files")
    require(sha256_file(root / "manifest.json") == expected_manifest_sha, "manifest checksum anchor mismatch")
    try:
        manifest = validate_manifest(json.loads((root / "manifest.json").read_bytes()), version, revision)
        checksums = {}
        for line in (root / "SHA256SUMS").read_text().splitlines():
            parts = line.split("  ")
            require(len(parts) == 2 and SHA256.fullmatch(parts[0]) and parts[1] not in checksums, "invalid checksum file")
            checksums[parts[1]] = parts[0]
        require(set(checksums) == {ARCHIVE, "manifest.json", "sbom.spdx.json"}, "incomplete checksum file")
        for name, digest in checksums.items():
            require(sha256_file(root / name) == digest, "release file checksum mismatch")
        require(checksums[ARCHIVE] == manifest["archiveSha256"] and checksums["sbom.spdx.json"] == manifest["sbomSha256"], "manifest payload digest mismatch")
        sbom = json.loads((root / "sbom.spdx.json").read_bytes())
        require(sbom.get("spdxVersion") == "SPDX-2.3" and isinstance(sbom.get("packages"), list), "invalid SPDX SBOM")
        inspect_archive(root / ARCHIVE, manifest)
        return manifest
    except (OSError, ValueError, UnicodeError, AttributeError):
        raise ReleaseError("invalid release bundle metadata") from None
