import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import ARCHIVE, ReleaseError, safe_extract_runtime, sha256_file, validate_bundle
from package import package_bundle, validate_source

REV = "a" * 40
BUILT = "2026-10-26T00:00:00Z"


def make_source(root, version="v0.1.0"):
    root = Path(root)
    for name in (".next/standalone/node_modules/tiny", ".next/static", "public", "deploy"):
        (root / name).mkdir(parents=True, exist_ok=True)
    (root / ".next/standalone/server.js").write_text("console.log('runtime')\n")
    (root / ".next/standalone/package.json").write_text(json.dumps({"name": "qintopia-image", "version": version[1:]}))
    (root / ".next/standalone/node_modules/tiny/package.json").write_text(json.dumps({"name": "tiny", "version": "1.0.0", "license": "MIT"}))
    (root / ".next/static/test.css").write_text("body{color:white}")
    (root / "public/logo.png").write_bytes(b"static-logo")
    (root / "package.json").write_text(json.dumps({"version": version[1:]}))
    (root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n")
    policy = {"application": "qintopia-image", "version": version[1:], "databaseMode": "none", "browserWorkspaceSchema": 1,
              "assetCapabilityVersion": 1, "rollbackCompatibility": {"mode": "compatible", "reason": "Same browser and asset contracts."}}
    (root / "deploy/release-policy.json").write_text(json.dumps(policy))
    return root


def fixture_bundle(root, version="v0.1.0", revision=REV):
    source = make_source(Path(root) / ("source-" + version), version)
    output = Path(root) / ("bundle-" + version)
    result = package_bundle(source, output, version, revision, built_at=BUILT, verify_source=False)
    return output, json.loads((output / "manifest.json").read_text()), result["manifestSha256"]


class PackageTests(unittest.TestCase):
    def test_standalone_assets_metadata_and_real_dependency_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = make_source(Path(temporary) / "source")
            (source / ".next/standalone/node_modules/alias").symlink_to("tiny")
            cache = source / ".next/standalone/.next/cache"
            cache.mkdir(parents=True)
            (cache / "private").write_text("transient")
            output = Path(temporary) / "bundle"
            result = package_bundle(source, output, "v0.1.0", REV, built_at=BUILT, verify_source=False)
            manifest = validate_bundle(output, result["manifestSha256"], "v0.1.0", REV)
            self.assertEqual(manifest["databaseMode"], "none")
            with tarfile.open(output / ARCHIVE) as archive:
                names = archive.getnames()
                self.assertIn("public/logo.png", names)
                self.assertIn(".next/static/test.css", names)
                self.assertIn("node_modules/alias", names)
                self.assertNotIn(".next/cache/private", names)
                self.assertTrue(archive.getmember("node_modules/alias").issym())
                self.assertFalse(any(member.islnk() for member in archive))
            sbom = json.loads((output / "sbom.spdx.json").read_text())
            self.assertEqual({item["name"] for item in sbom["packages"]}, {"qintopia-image", "tiny"})
            destination = Path(temporary) / "runtime"
            safe_extract_runtime(output / ARCHIVE, destination, manifest)
            self.assertEqual(json.loads((destination / "release.json").read_text())["revision"], REV)
            self.assertTrue((destination / "node_modules/alias").is_symlink())

    @unittest.skipUnless(shutil.which("node"), "Node is not installed")
    def test_pnpm_alias_keeps_realpath_dependency_resolution_after_pack_and_extract(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = make_source(root / "source")
            traced = source / ".next/standalone"
            package = traced / "node_modules/.pnpm/next@1.0.0/node_modules/next"
            sibling = package.parent / "styled-jsx"
            package.mkdir(parents=True)
            sibling.mkdir()
            (package / "package.json").write_text(json.dumps({"name": "next", "version": "1.0.0", "main": "index.js"}))
            (package / "index.js").write_text("module.exports = require('styled-jsx');\n")
            (sibling / "package.json").write_text(json.dumps({"name": "styled-jsx", "version": "1.0.0", "main": "index.js"}))
            (sibling / "index.js").write_text("module.exports = 'sibling dependency found';\n")
            (traced / "node_modules/next").symlink_to(".pnpm/next@1.0.0/node_modules/next")
            command = ["node", "-e", "console.log(require('next'))"]
            before = subprocess.run(command, cwd=traced, capture_output=True, text=True, timeout=10)
            self.assertEqual(before.returncode, 0, before.stderr)
            result = package_bundle(source, root / "bundle", "v0.1.0", REV, built_at=BUILT, verify_source=False)
            manifest = validate_bundle(root / "bundle", result["manifestSha256"], "v0.1.0", REV)
            runtime = root / "runtime"
            safe_extract_runtime(root / "bundle" / ARCHIVE, runtime, manifest)
            after = subprocess.run(command, cwd=runtime, capture_output=True, text=True, timeout=10)
            self.assertEqual(after.returncode, 0, after.stderr)
            self.assertEqual(after.stdout, before.stdout)
            self.assertTrue((runtime / "node_modules/next").is_symlink())

    def test_external_symlink_and_private_runtime_file_fail_closed(self):
        for dangerous in ("outside-link", ".env.local", ".generated-images"):
            with self.subTest(dangerous=dangerous), tempfile.TemporaryDirectory() as temporary:
                source = make_source(Path(temporary) / "source")
                target = source / ".next/standalone" / dangerous
                if dangerous == "outside-link":
                    external = source / "external"
                    external.write_text("outside")
                    target.symlink_to(external)
                elif dangerous == ".generated-images":
                    target.mkdir()
                    (target / "output.png").write_bytes(b"private image")
                else:
                    target.write_text("SECRET=do-not-ship")
                with self.assertRaises(ReleaseError):
                    package_bundle(source, Path(temporary) / "bundle", "v0.1.0", REV, verify_source=False)

    def test_wrong_policy_and_nonempty_output_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = make_source(Path(temporary) / "source", "v0.2.0")
            with self.assertRaises(ReleaseError):
                package_bundle(source, Path(temporary) / "bundle", "v0.1.0", REV, verify_source=False)
            output = Path(temporary) / "occupied"
            output.mkdir()
            (output / "keep.txt").write_text("existing")
            with self.assertRaises(ReleaseError):
                package_bundle(source, output, "v0.2.0", REV, verify_source=False)
            self.assertEqual((output / "keep.txt").read_text(), "existing")

    def test_source_requires_exact_clean_tag_and_linux_amd64(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = make_source(temporary)
            with patch("package.git", side_effect=[REV, REV, " M package.json"]):
                with self.assertRaisesRegex(ReleaseError, "clean"):
                    validate_source(source, "v0.1.0", REV)
            with patch("package.git", side_effect=[REV, REV, ""]), patch("package.platform.system", return_value="Darwin"):
                with self.assertRaisesRegex(ReleaseError, "Linux"):
                    validate_source(source, "v0.1.0", REV)


if __name__ == "__main__":
    unittest.main()
