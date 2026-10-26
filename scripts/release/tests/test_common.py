import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import ARCHIVE, ReleaseError, inspect_archive, release_prefix, safe_extract_runtime, safe_runtime_path, validate_bundle, validate_identity, validate_manifest
from test_package import REV, fixture_bundle


class CommonTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
