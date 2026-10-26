"""Release identities and archive validation shared by CI and the restricted server."""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import tarfile
from collections import deque
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
MAX_ARCHIVE_MEMBERS = 100_000
MAX_LINK_HOPS = 40


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
    require(isinstance(name, str) and 0 < len(name) <= 4096 and not any(character in name for character in ("\x00", "\\", "\n", "\r")), "invalid archive path")
    path = PurePosixPath(name)
    require(path.parts and not path.is_absolute() and ".." not in path.parts and path.as_posix() == name.rstrip("/"), "archive path escapes runtime")
    forbidden = {".git", ".local-ops", ".generated-images", ".aws", ".codex", ".agents", "image-playground", "uploads", "user-data"}
    require(not any(part in forbidden or part.startswith(".env") for part in path.parts), "runtime contains private or generated data")
    require(path.suffix.lower() not in {".pem", ".key", ".p12", ".pfx", ".dump", ".bak"}, "runtime contains a private file")
    require(not (len(path.parts) >= 2 and path.parts[:2] == (".next", "cache")), "runtime contains a writable cache")
    return path


def safe_relative_link(target):
    require(isinstance(target, str) and 0 < len(target) <= 4096 and not any(character in target for character in ("\x00", "\\", "\n", "\r")), "invalid runtime symlink target")
    require(not PurePosixPath(target).is_absolute() and not re.match(r"^[A-Za-z]:", target), "runtime symlink target must be relative")
    return target


def validate_member_graph(members):
    """Resolve links using the archive's own tree, never the host filesystem."""
    nodes = {".": "dir"}
    links = {}
    for name, member in members.items():
        nodes[name] = "link" if member.issym() else "dir" if member.isdir() else "file"
        if member.issym():
            links[name] = safe_relative_link(member.linkname)
    for name in members:
        for parent in PurePosixPath(name).parents:
            key = parent.as_posix()
            require(nodes.get(key, "dir") == "dir", "archive member has a link or file ancestor")
            nodes.setdefault(key, "dir")

    def resolve_link(name):
        current = list(PurePosixPath(name).parent.parts)
        pending = deque(links[name].split("/"))
        hops = 1
        while pending:
            require(nodes.get("/".join(current) or ".") == "dir", "runtime symlink traverses a file")
            part = pending.popleft()
            if part in {"", "."}:
                continue
            if part == "..":
                require(current, "runtime symlink escapes the runtime")
                current.pop()
                continue
            candidate = "/".join([*current, part])
            safe_runtime_path(candidate)
            require(candidate in nodes, "runtime symlink target is missing")
            if nodes[candidate] == "link":
                hops += 1
                require(hops <= MAX_LINK_HOPS, "runtime symlink cycle or excessive link chain")
                # Resolve '..' after any intervening link, matching filesystem
                # semantics instead of prematurely normalizing the raw string.
                pending.extendleft(reversed(links[candidate].split("/")))
            else:
                current.append(part)
        return "/".join(current) or "."

    resolved = {name: resolve_link(name) for name in links}
    # Also reject directory cycles such as a/link -> ../b and b/link -> ../a.
    # Link-chain resolution alone does not see those containment cycles.
    edges = {name: set() for name, kind in nodes.items() if kind == "dir"}
    for name, kind in nodes.items():
        if name == ".":
            continue
        parent = PurePosixPath(name).parent.as_posix()
        if kind == "dir":
            edges[parent].add(name)
        elif kind == "link" and nodes[resolved[name]] == "dir":
            edges[parent].add(resolved[name])
    incoming = dict.fromkeys(edges, 0)
    for children in edges.values():
        for child in children:
            incoming[child] += 1
    ready = deque(name for name, count in incoming.items() if count == 0)
    visited = 0
    while ready:
        name = ready.popleft()
        visited += 1
        for child in edges[name]:
            incoming[child] -= 1
            if incoming[child] == 0:
                ready.append(child)
    require(visited == len(edges), "runtime symlink creates a directory cycle")
    return resolved


def _inspect_archive(archive, expected_manifest=None):
    if expected_manifest is not None:
        validate_manifest(expected_manifest)
        require(sha256_file(archive) == expected_manifest["archiveSha256"], "archive digest mismatch")
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            members, metadata_bytes, total = {}, {}, 0
            # Enforce limits as headers arrive. getmembers() would allocate the
            # whole untrusted member list before the count could be checked.
            for member in bundle:
                require(len(members) < MAX_ARCHIVE_MEMBERS, "invalid runtime file count")
                path = safe_runtime_path(member.name)
                name = path.as_posix()
                require(name not in members, "duplicate archive path")
                require(member.type in {tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.SYMTYPE} and not member.sparse, "runtime hard links and special files are prohibited")
                require(member.size >= 0 and (member.isfile() or member.size == 0), "invalid runtime member size")
                total += member.size
                require(total <= MAX_EXPANDED_BYTES, "runtime archive is too large")
                members[name] = member
                if name in {"release.json", "release-policy.json"}:
                    require(member.isfile() and member.size <= 64 * 1024, "runtime metadata is too large or is a link")
                    metadata_bytes[name] = bundle.extractfile(member).read(64 * 1024 + 1)
            require(members, "runtime archive is empty")
            required = {"server.js", "package.json", "release.json", "release-policy.json"}
            require(required <= members.keys() and all(members[name].isfile() for name in required), "runtime entry files are missing or linked")
            validate_member_graph(members)
            def read_json(name):
                data = metadata_bytes[name]
                return json.loads(data), data
            metadata, _ = read_json("release.json")
            policy, policy_bytes = read_json("release-policy.json")
            require(isinstance(metadata, dict) and set(metadata) == METADATA_FIELDS, "invalid runtime release metadata")
            if expected_manifest is not None:
                require(metadata == {key: expected_manifest[key] for key in METADATA_FIELDS}, "runtime identity differs from manifest")
                require(hashlib.sha256(policy_bytes).hexdigest() == expected_manifest["releasePolicySha256"], "runtime policy digest mismatch")
                require(policy["rollbackCompatibility"] == expected_manifest["rollbackCompatibility"], "runtime rollback policy mismatch")
            validate_policy(policy, metadata["version"])
            return metadata, list(members.values())
    except (tarfile.TarError, OSError, KeyError, ValueError, UnicodeError):
        raise ReleaseError("invalid runtime archive") from None


def inspect_archive(archive, expected_manifest=None):
    return _inspect_archive(archive, expected_manifest)[0]


def safe_extract_runtime(archive, target, expected_manifest=None):
    _metadata, members = _inspect_archive(archive, expected_manifest)
    destination = Path(target)
    require(not destination.is_symlink(), "runtime destination is a symlink")
    require(not destination.exists() or (destination.is_dir() and not any(destination.iterdir())), "runtime destination must be empty")
    destination.mkdir(parents=True, exist_ok=True, mode=0o755)
    with tarfile.open(archive, "r:gz") as bundle:
        # No filesystem link exists during payload extraction. Every path and
        # link ancestor was validated together, independently of tar order.
        for member in members:
            path = destination.joinpath(*safe_runtime_path(member.name).parts)
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True, mode=0o755)
            elif member.isfile():
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                with bundle.extractfile(member) as source, path.open("xb") as output:
                    shutil.copyfileobj(source, output)
                path.chmod(0o755 if member.mode & 0o111 else 0o644)
        # Preserve pnpm realpaths: Node resolves a package's dependencies from
        # its real directory, so materializing aliases changes runtime behavior.
        for member in members:
            if member.issym():
                path = destination.joinpath(*safe_runtime_path(member.name).parts)
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                path.symlink_to(member.linkname)
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
