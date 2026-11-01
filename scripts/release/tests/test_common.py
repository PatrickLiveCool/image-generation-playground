import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import ARCHIVE, ReleaseError, inspect_archive, is_account_release, metadata_fields, release_prefix, safe_extract_runtime, safe_runtime_path, validate_bundle, validate_identity, validate_manifest
from test_package import REV, fixture_bundle


class CommonTests(unittest.TestCase):
    def test_account_manifest_and_legacy_metadata_fields_remain_distinct(self):
        with tempfile.TemporaryDirectory() as temporary:
            _bundle, manifest, _anchor = fixture_bundle(temporary, account=True)
            self.assertTrue(is_account_release(validate_manifest(manifest)))
            self.assertEqual(manifest["browserWorkspaceSchema"], 2)
            self.assertEqual(validate_manifest({**manifest, "browserWorkspaceSchema": 1})["browserWorkspaceSchema"], 1)
            self.assertNotIn("database", metadata_fields(1))
            self.assertIn("database", metadata_fields(2))
            for changes in ({"schema": 1}, {"databaseMode": "none"}, {"assetAccessProtocol": "public-bearer"},
                            {"builtAt": "2026-02-30T00:00:00Z"}, {"builtAt": "2026-10-26T00:00:00+08:00"}, {"browserWorkspaceSchema": 3}):
                with self.assertRaises(ReleaseError): validate_manifest({**manifest, **changes})
            for field, value in (("name", "another_project"), ("schema", "public"), ("maxVersion", "9999"), ("minVersion", "0000")):
                with self.assertRaises(ReleaseError): validate_manifest({**manifest, "database": {**manifest["database"], field: value}})
            for entries in (list(reversed(manifest["database"]["migrations"])), manifest["database"]["migrations"][:-1]):
                with self.assertRaises(ReleaseError): validate_manifest({**manifest, "database": {**manifest["database"], "migrations": entries}})

    def test_archive_rechecks_embedded_account_contract_and_migration_bytes_before_extracting(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle, manifest, _anchor = fixture_bundle(root, account=True)
            for index, (name, payload) in enumerate([
                ("maintenance/migrations/0001-accounts.sql", b"SELECT 'unreviewed';"),
                ("release.json", json.dumps({key: value for key, value in manifest.items() if key in metadata_fields(1)} | {"schema": 1}).encode()),
            ]):
                archive = root / f"changed-{index}.tar.gz"
                replace_archive_file(bundle / ARCHIVE, archive, name, payload)
                destination = root / f"rejected-{index}"
                with self.assertRaises(ReleaseError): safe_extract_runtime(archive, destination)
                self.assertFalse(destination.exists())
            extra = root / "extra.tar.gz"
            rewrite_archive(bundle / ARCHIVE, extra, [("maintenance/unreviewed.mjs", tarfile.REGTYPE, b"unexpected")])
            with self.assertRaises(ReleaseError): inspect_archive(extra)

    def test_identity_and_prefix_are_closed_to_other_projects(self):
        self.assertEqual(release_prefix("v1.2.3", REV), "qintopia-image/releases/v1.2.3/" + REV + "/")
        for version, revision in [("1.2.3", REV), ("v01.2.3", REV), ("v1.2.3;id", REV), ("v1.2.3", "a" * 39)]:
            with self.assertRaises(ReleaseError):
                validate_identity(version, revision)
        for path in ("../server.js", "/etc/passwd", "node_modules/pkg/.env", "image-playground/runs/a.png", "x//y", ".", "cert.key"):
            with self.assertRaises(ReleaseError):
                safe_runtime_path(path)

    def test_manifest_digest_and_schema_cannot_be_substituted(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle, manifest, anchor = fixture_bundle(temporary)
            for patch in ({"application": "greenpms"}, {"schema": True}, {"platform": "darwin/arm64"}, {"browserWorkspaceSchema": 2}, {"unexpected": "value"}):
                with self.assertRaises(ReleaseError):
                    validate_manifest({**manifest, **patch})
            with self.assertRaises(ReleaseError):
                validate_bundle(bundle, "0" * 64, "v0.1.0", REV)
            with (bundle / ARCHIVE).open("ab") as output:
                output.write(b"tampered")
            with self.assertRaises(ReleaseError):
                validate_bundle(bundle, anchor, "v0.1.0", REV)

    def test_extraction_rejects_traversal_links_and_keeps_existing_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for kind, name in [(tarfile.REGTYPE, "../escape"), (tarfile.SYMTYPE, "server.js"), (tarfile.LNKTYPE, "server.js")]:
                archive = root / "bad.tar.gz"
                with tarfile.open(archive, "w:gz") as output:
                    info = tarfile.TarInfo(name)
                    info.type = kind
                    info.linkname = "/etc/passwd"
                    output.addfile(info)
                with self.assertRaises(ReleaseError):
                    safe_extract_runtime(archive, root / "extract")
                self.assertFalse((root / "escape").exists())
            bundle, manifest, _ = fixture_bundle(root)
            destination = root / "occupied"
            destination.mkdir()
            (destination / "server.js").write_text("do not replace")
            with self.assertRaises(ReleaseError):
                safe_extract_runtime(bundle / ARCHIVE, destination, manifest)
            self.assertEqual((destination / "server.js").read_text(), "do not replace")

    def test_archive_graph_rejects_escape_cycles_missing_targets_and_link_ancestors(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle, _manifest, _anchor = fixture_bundle(root)
            cases = [
                [("alias", tarfile.SYMTYPE, "../outside")],
                [("alias", tarfile.SYMTYPE, "/etc/passwd")],
                [("alias", tarfile.SYMTYPE, "node_modules/missing")],
                [("alias", tarfile.SYMTYPE, ".env.local")],
                [("a", tarfile.SYMTYPE, "b"), ("b", tarfile.SYMTYPE, "a")],
                [("alias", tarfile.SYMTYPE, "node_modules/tiny"), ("alias/child.js", tarfile.REGTYPE, b"do not write")],
                [("a", tarfile.DIRTYPE, None), ("b", tarfile.DIRTYPE, None), ("a/link", tarfile.SYMTYPE, "../b"), ("b/link", tarfile.SYMTYPE, "../a")],
                [("alias", tarfile.LNKTYPE, "server.js")],
                [("alias", tarfile.SYMTYPE, "node_modules/tiny"), ("chain", tarfile.SYMTYPE, "alias/../../../outside")],
                # Lexical normpath yields node_modules/outside (apparently
                # internal), but following alias first reaches public and the
                # second '..' escapes the runtime. Resolve component by component.
                [("node_modules/tiny/alias", tarfile.SYMTYPE, "../../public"),
                 ("chain", tarfile.SYMTYPE, "node_modules/tiny/alias/../../outside")],
            ]
            for index, additions in enumerate(cases):
                with self.subTest(index=index):
                    archive = root / ("invalid-" + str(index) + ".tar.gz")
                    rewrite_archive(bundle / ARCHIVE, archive, additions)
                    destination = root / ("reject-" + str(index))
                    with self.assertRaises(ReleaseError):
                        safe_extract_runtime(archive, destination)
                    self.assertFalse(destination.exists())

    def test_chain_targets_are_resolved_before_dotdot_and_links_are_created_last(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle, _manifest, _anchor = fixture_bundle(root)
            archive = root / "linked.tar.gz"
            # Node-like aliases precede their targets in tar order. The second
            # target uses '..' after following a link into a different directory.
            additions = [("alias", tarfile.SYMTYPE, "node_modules/tiny"),
                         ("chain", tarfile.SYMTYPE, "alias/../tiny/package.json")]
            rewrite_archive(bundle / ARCHIVE, archive, additions, prepend=True)
            destination = root / "runtime"
            safe_extract_runtime(archive, destination)
            self.assertTrue((destination / "alias").is_symlink())
            self.assertEqual((destination / "chain").read_bytes(), (destination / "node_modules/tiny/package.json").read_bytes())

    def test_header_count_and_expanded_size_are_limited_during_iteration(self):
        class Headers:
            def __init__(self, size=0):
                self.seen = []
                self.size = size
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def __iter__(self):
                for index in range(10):
                    self.seen.append(index)
                    if index > 2:
                        raise AssertionError("read past the member limit")
                    member = tarfile.TarInfo("file-" + str(index))
                    member.size = self.size
                    yield member
        headers = Headers()
        with patch("common.tarfile.open", return_value=headers), patch("common.MAX_ARCHIVE_MEMBERS", 2):
            with self.assertRaisesRegex(ReleaseError, "file count"):
                inspect_archive("unused")
        self.assertEqual(headers.seen, [0, 1, 2])
        headers = Headers(size=11)
        with patch("common.tarfile.open", return_value=headers), patch("common.MAX_EXPANDED_BYTES", 10):
            with self.assertRaisesRegex(ReleaseError, "too large"):
                inspect_archive("unused")
        self.assertEqual(headers.seen, [0])


def replace_archive_file(source, destination, name, payload):
    with tarfile.open(source, "r:gz") as original, tarfile.open(destination, "w:gz") as output:
        for member in original:
            if member.name == name:
                member.size = len(payload)
                output.addfile(member, io.BytesIO(payload))
            else:
                output.addfile(member, original.extractfile(member) if member.isfile() else None)


def rewrite_archive(source, destination, additions, prepend=False):
    with tarfile.open(source, "r:gz") as original, tarfile.open(destination, "w:gz") as output:
        def extra():
            for name, kind, value in additions:
                member = tarfile.TarInfo(name)
                member.type = kind
                if kind in {tarfile.SYMTYPE, tarfile.LNKTYPE}:
                    member.linkname = value
                if kind == tarfile.REGTYPE:
                    member.size = len(value)
                    output.addfile(member, io.BytesIO(value))
                else:
                    output.addfile(member)
        if prepend:
            extra()
        for member in original:
            output.addfile(member, original.extractfile(member) if member.isfile() else None)
        if not prepend:
            extra()


if __name__ == "__main__":
    unittest.main()
