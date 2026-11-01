"""Package an already-built Linux Next standalone runtime; never build with cloud credentials."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

from common import (APPLICATION, ARCHIVE, ReleaseError, inspect_archive,
                    json_bytes, require, safe_extract_runtime, safe_runtime_path, safe_relative_link,
                    sha256_file, utcnow, validate_bundle, validate_identity, validate_policy)


def git(source, *arguments):
    result = subprocess.run(["git", "-C", str(source), *arguments], capture_output=True, text=True)
    require(result.returncode == 0, "cannot verify release Git identity")
    return result.stdout.strip()


def validate_source(source, version, revision):
    validate_identity(version, revision)
    require(git(source, "rev-parse", "HEAD") == revision, "release checkout differs from revision")
    require(git(source, "rev-parse", f"refs/tags/{version}^{{commit}}") == revision, "release tag differs from revision")
    require(not git(source, "status", "--porcelain", "--untracked-files=all"), "release checkout must be clean")
    require(platform.system() == "Linux" and platform.machine() in {"x86_64", "amd64"}, "runtime must be built on Linux amd64")
    try:
        package = json.loads((source / "package.json").read_bytes())
    except (OSError, ValueError):
        raise ReleaseError("cannot read application package metadata") from None
    require(package.get("version") == version[1:], "package version differs from release")
    require((source / "pnpm-lock.yaml").is_file(), "locked pnpm dependencies are required")


def materialize(source, target, allowed_root, ancestry=()):
    """Copy traced files while preserving relocatable, internal pnpm aliases."""
    try:
        resolved = source.resolve(strict=True)
    except (RuntimeError, OSError):
        raise ReleaseError("runtime symlink is cyclic or has a missing target") from None
    require(resolved.is_relative_to(allowed_root), "runtime symlink escapes its traced root")
    relative = target.relative_to(materialize.runtime_root).as_posix()
    safe_runtime_path(relative)
    for parent in target.parents:
        if parent == materialize.runtime_root:
            break
        require(not parent.is_symlink(), "runtime copy cannot descend through a symlink")
    if source.is_symlink():
        link = safe_relative_link(os.readlink(source))
        resolved_relative = resolved.relative_to(allowed_root).as_posix()
        require(resolved_relative != ".", "runtime symlink creates a directory cycle")
        safe_runtime_path(resolved_relative)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        if target.exists() or target.is_symlink():
            require(target.is_symlink() and os.readlink(target) == link, "runtime overlay has conflicting links")
        else:
            target.symlink_to(link)
        return
    require(resolved not in ancestry, "runtime directory cycle")
    require(not target.is_symlink(), "runtime overlay cannot replace a symlink with payload")
    if resolved.is_dir():
        target.mkdir(parents=True, exist_ok=True, mode=0o755)
        for child in sorted(source.iterdir()):
            # Next's mutable cache is never part of an immutable runtime.
            child_relative = (target / child.name).relative_to(materialize.runtime_root).as_posix()
            if child_relative == ".next/cache" or child_relative.startswith(".next/cache/"):
                continue
            materialize(child, target / child.name, allowed_root, (*ancestry, resolved))
    else:
        require(resolved.is_file(), "runtime contains a special file")
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        if target.exists():
            require(target.is_file() and sha256_file(target) == sha256_file(resolved), "runtime overlay has conflicting files")
            return
        shutil.copyfile(resolved, target)
        target.chmod(0o755 if resolved.stat().st_mode & 0o111 else 0o644)


def make_sbom(runtime, metadata):
    packages = []
    seen = set()
    for file in sorted(runtime.rglob("package.json")):
        try:
            value = json.loads(file.read_bytes())
        except (ValueError, OSError):
            raise ReleaseError("runtime dependency metadata is invalid") from None
        name, version = value.get("name"), value.get("version")
        if not isinstance(name, str) or not isinstance(version, str) or (name, version) in seen:
            continue
        seen.add((name, version))
        identity = hashlib.sha256((name + "\0" + version).encode()).hexdigest()[:20]
        license_value = value.get("license")
        # package.json also permits free-form text such as "SEE LICENSE IN ...",
        # which is not an SPDX license expression. Preserve only recognized IDs.
        known_license = isinstance(license_value, str) and re.fullmatch(r"MIT|Apache-2\.0|ISC|BSD-[23]-Clause|0BSD|CC0-1\.0|Unlicense|MPL-2\.0|(?:A?GPL|LGPL)-(?:2\.0|2\.1|3\.0)-(?:only|or-later)", license_value)
        packages.append({"SPDXID": "SPDXRef-Package-" + identity, "name": name,
                         "versionInfo": version, "downloadLocation": "NOASSERTION",
                         "filesAnalyzed": False, "licenseDeclared": license_value if known_license else "NOASSERTION"})
    return {"spdxVersion": "SPDX-2.3", "dataLicense": "CC0-1.0", "SPDXID": "SPDXRef-DOCUMENT",
            "name": APPLICATION + "-" + metadata["version"],
            "documentNamespace": "https://image.qintopia.cn/release-sbom/" + metadata["revision"],
            "creationInfo": {"created": metadata["builtAt"], "creators": ["Tool: qintopia-image-release-package"]},
            "packages": packages,
            "relationships": [{"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": package["SPDXID"]} for package in packages]}


def validate_maintenance_source(source, database):
    """Approval stays in reviewed source; generated output cannot approve new SQL."""
    maintenance = source / ".next/maintenance"
    require(maintenance.is_dir() and not maintenance.is_symlink(), "build the fixed database maintenance runtime before packaging")
    require({item.name for item in maintenance.iterdir()} == {"cli.mjs", "migrations"}, "unexpected maintenance build output")
    entry, migrations = maintenance / "cli.mjs", maintenance / "migrations"
    require(entry.is_file() and not entry.is_symlink() and 0 < entry.stat().st_size <= 10 * 1024 * 1024, "maintenance entrypoint is missing or linked")
    require(migrations.is_dir() and not migrations.is_symlink(), "maintenance migration directory is missing or linked")
    try:
        catalog_file = source / "scripts/database/migration-catalog.ts"
        require(catalog_file.is_file() and not catalog_file.is_symlink(), "migration approval catalog is missing or linked")
        entries = re.findall(r'^\s*"([0-9]{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.sql)": "([0-9a-f]{64})",?\s*$', catalog_file.read_text(), re.MULTILINE)
        expected = [(entry["name"], entry["sha256"]) for entry in database["migrations"]]
        require(entries == expected, "database contract differs from reviewed migration catalog")
        require(database["minVersion"] == database["maxVersion"] == expected[-1][0][:4], "maintenance runtime requires the current reviewed database version")
        source_migrations = source / "migrations"
        require(source_migrations.is_dir() and not source_migrations.is_symlink(), "migration source directory is missing or linked")
        for directory in (source_migrations, migrations):
            require({file.name for file in directory.iterdir()} == {name for name, _ in expected}, "migration file set differs from reviewed catalog")
            for name, digest in expected:
                file = directory / name
                require(file.is_file() and not file.is_symlink() and file.stat().st_nlink == 1 and 0 < file.stat().st_size <= 1024 * 1024, "migration source file is missing, linked or oversized")
                require(sha256_file(file) == digest, "migration source or build differs from reviewed digest")
    except (OSError, UnicodeError):
        raise ReleaseError("cannot verify reviewed maintenance source") from None
    return maintenance


def package_bundle(source_root, output, version, revision, *, built_at=None, verify_source=True):
    source, output = Path(source_root).resolve(), Path(output)
    validate_identity(version, revision)
    if verify_source:
        validate_source(source, version, revision)
    require(not output.is_symlink() and (not output.exists() or (output.is_dir() and not any(output.iterdir()))), "bundle output must be empty")
    try:
        policy = validate_policy(json.loads((source / "deploy/release-policy.json").read_bytes()), version)
    except (OSError, ValueError):
        raise ReleaseError("release policy is missing or invalid") from None
    traced = source / ".next/standalone"
    require(traced.is_dir() and not traced.is_symlink() and (traced / "server.js").is_file(), "build Next standalone before packaging")
    require((source / ".next/static").is_dir(), "Next static assets are missing")
    account = policy["databaseMode"] == "postgresql"
    maintenance = validate_maintenance_source(source, policy["database"]) if account else None
    metadata = {"schema": 2 if account else 1, "application": APPLICATION, "version": version, "revision": revision,
                "platform": "linux/amd64", "builtAt": built_at or utcnow(),
                "browserWorkspaceSchema": policy["browserWorkspaceSchema"], "assetCapabilityVersion": policy["assetCapabilityVersion"]}
    if account:
        metadata.update({key: policy[key] for key in ("databaseMode", "assetAccessProtocol", "database")})
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="qintopia-image-package-") as scratch:
        runtime = Path(scratch) / "runtime"
        runtime.mkdir()
        materialize.runtime_root = runtime
        for child in sorted(traced.iterdir()):
            materialize(child, runtime / child.name, traced.resolve())
        for source_path, destination in [(source / "public", runtime / "public"), (source / ".next/static", runtime / ".next/static")]:
            if source_path.exists():
                materialize(source_path, destination, source_path.resolve())
        if maintenance is not None:
            require(not (runtime / "maintenance").exists(), "standalone contains an unmanaged maintenance directory")
            materialize(maintenance, runtime / "maintenance", maintenance.resolve())
        require(not (runtime / "release.json").exists() and not (runtime / "release-policy.json").exists(), "build already contains unmanaged release metadata")
        policy_bytes = json_bytes(policy)
        (runtime / "release.json").write_bytes(json_bytes(metadata))
        (runtime / "release-policy.json").write_bytes(policy_bytes)
        sbom = make_sbom(runtime, metadata)
        (output / "sbom.spdx.json").write_bytes(json_bytes(sbom))
        with tarfile.open(output / ARCHIVE, "w:gz", format=tarfile.PAX_FORMAT) as archive:
            for file in sorted(runtime.rglob("*")):
                name = file.relative_to(runtime).as_posix()
                safe_runtime_path(name)
                entry = archive.gettarinfo(str(file), arcname=name)
                entry.uid = entry.gid = 0
                entry.uname = entry.gname = ""
                entry.mtime = 0
                if entry.isfile():
                    with file.open("rb") as body:
                        archive.addfile(entry, body)
                else:
                    archive.addfile(entry)
        manifest = {**metadata, "databaseMode": policy["databaseMode"], "rollbackCompatibility": policy["rollbackCompatibility"],
                    "archiveSha256": sha256_file(output / ARCHIVE), "sbomSha256": sha256_file(output / "sbom.spdx.json"),
                    "releasePolicySha256": hashlib.sha256(policy_bytes).hexdigest()}
        (output / "manifest.json").write_bytes(json_bytes(manifest))
        (output / "SHA256SUMS").write_text("".join(f"{sha256_file(output / name)}  {name}\n" for name in (ARCHIVE, "manifest.json", "sbom.spdx.json")))
        manifest_sha = sha256_file(output / "manifest.json")
        validate_bundle(output, manifest_sha, version, revision)
        return {"application": APPLICATION, "version": version, "revision": revision, "manifestSha256": manifest_sha, "directory": str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(package_bundle(args.source_root, args.output, args.version, args.revision)))
        return 0
    except ReleaseError as error:
        print("QinTopia image: " + str(error), file=sys.stderr)
        return 1
    except Exception:
        print("QinTopia image: packaging failed; inspect the clean build", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
