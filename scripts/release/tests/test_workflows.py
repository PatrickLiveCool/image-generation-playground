from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]


def read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


class ReleaseMetadataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="image-release-metadata-")
        self.addCleanup(self.temporary.cleanup)
        self.source = Path(self.temporary.name)
        for name in ("package.json", "pnpm-lock.yaml", ".node-version", "CHANGELOG.md", ".release-please-manifest.json", "deploy/release-policy.json"):
            destination = self.source / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, destination)
        self.version = json.loads((self.source / "package.json").read_text())["version"]
        self.tag = "v" + self.version

    def run_check(self, *arguments: str, **environment: str) -> subprocess.CompletedProcess[str]:
        child_env = os.environ.copy()
        child_env.pop("GITHUB_REF", None)
        child_env.update(environment)
        return subprocess.run(
            ["node", str(ROOT / "scripts/check-release.mjs"), "--root", str(self.source), *arguments],
            env=child_env, capture_output=True, text=True, timeout=15, check=False,
        )

    def change_json(self, name: str, **values: object) -> None:
        path = self.source / name
        data = json.loads(path.read_text())
        data.update(values)
        path.write_text(json.dumps(data))

    def test_current_metadata_and_tag_are_accepted(self) -> None:
        result = self.run_check("--tag", self.tag)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Release " + self.tag, result.stdout)
        result = self.run_check(GITHUB_REF="refs/tags/" + self.tag)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_different_release_or_conflicting_event_cannot_pass(self) -> None:
        mismatch = "v" + str(int(self.version.split(".")[0]) + 1) + ".0.0"
        for arguments, environment in [(("--tag", mismatch), {}), (("--tag", self.tag), {"GITHUB_REF": "refs/tags/" + mismatch})]:
            result = self.run_check(*arguments, **environment)
            self.assertNotEqual(result.returncode, 0)

    def test_tag_validation_rejects_prereleases_and_shell_fragments(self) -> None:
        for tag in ("0.1.0", "v0.1", "v01.2.3", "v0.1.0-rc.1", "v0.1.0; touch sentinel", "../v0.1.0"):
            result = self.run_check("--tag", tag)
            self.assertNotEqual(result.returncode, 0, tag)
            self.assertIn("vX.Y.Z", result.stderr)

    def test_version_drift_between_manifest_and_policy_is_rejected(self) -> None:
        self.change_json(".release-please-manifest.json", **{".": "999.0.0"})
        self.assertNotEqual(self.run_check().returncode, 0)
        self.change_json(".release-please-manifest.json", **{".": self.version})
        self.change_json("deploy/release-policy.json", version="999.0.0")
        self.assertNotEqual(self.run_check().returncode, 0)

    def test_missing_release_notes_are_rejected(self) -> None:
        (self.source / "CHANGELOG.md").write_text("# Changelog\n\n## " + self.version + "\n\n## 0.0.0\nOlder entry\n")
        self.assertNotEqual(self.run_check().returncode, 0)

    def test_package_manager_runtime_and_single_lock_are_enforced(self) -> None:
        self.change_json("package.json", packageManager="pnpm@latest")
        self.assertNotEqual(self.run_check().returncode, 0)
        self.change_json("package.json", packageManager="pnpm@10.28.2")
        (self.source / ".node-version").write_text("24\n")
        self.assertNotEqual(self.run_check().returncode, 0)
        (self.source / ".node-version").write_text("22.22.1\n")
        (self.source / "package-lock.json").write_text("{}")
        self.assertNotEqual(self.run_check().returncode, 0)

    def test_compatibility_changes_require_contract_updates(self) -> None:
        for values in ({"databaseMode": "postgres"}, {"browserWorkspaceSchema": 2}, {"assetCapabilityVersion": 2}, {"rollbackCompatibility": {"mode": "compatible", "reason": ""}}):
            original = (self.source / "deploy/release-policy.json").read_text()
            self.change_json("deploy/release-policy.json", **values)
            self.assertNotEqual(self.run_check().returncode, 0, values)
            (self.source / "deploy/release-policy.json").write_text(original)

    def test_unknown_and_repeated_cli_arguments_are_rejected(self) -> None:
        for arguments in (("--skip-checks",), ("--tag",), ("--tag", self.tag, "--tag", self.tag)):
            self.assertNotEqual(self.run_check(*arguments).returncode, 0)


class WorkflowSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflows = {path.stem: path.read_text() for path in (ROOT / ".github/workflows").glob("*.yml")}

    def test_actions_are_immutable_and_checkouts_do_not_keep_credentials(self) -> None:
        for name, workflow in self.workflows.items():
            for action in re.findall(r"^\s*-?\s*uses:\s*(\S+)", workflow, re.M):
                self.assertRegex(action, r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$", name)
            for step in re.split(r"\n\s{6}- ", workflow):
                if "uses: actions/checkout@" in step:
                    self.assertIn("persist-credentials: false", step, name)

    def test_pr_code_and_metadata_checks_are_separate_and_read_only(self) -> None:
        ci = self.workflows["ci"]
        metadata = self.workflows["pr-format"]
        self.assertIn("types: [opened, synchronize, reopened, ready_for_review]", ci)
        self.assertNotIn("edited", ci)
        self.assertIn("name: Node and release checks", ci)
        self.assertIn("cancel-in-progress: true", ci)
        self.assertIn("edited", metadata)
        self.assertIn("cancel-in-progress: false", metadata)
        self.assertIn('gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}"', metadata)
        for workflow in (ci, metadata):
            self.assertIn("branches: [master]", workflow)
            for forbidden in ("pull_request_target", "environment: production", "secrets.", ": write"):
                self.assertNotIn(forbidden, workflow)
        protection = json.loads(read(".github/master-protection.json"))
        self.assertEqual({item["context"] for item in protection["required_status_checks"]["checks"]}, {"PR format", "Node and release checks"})
        self.assertTrue(all(item["app_id"] == 15368 for item in protection["required_status_checks"]["checks"]))

    def test_ci_executes_existing_checks_on_the_locked_runtime(self) -> None:
        ci = self.workflows["ci"]
        for command in ("corepack prepare pnpm@10.28.2 --activate", "pnpm install --frozen-lockfile", "pnpm release:check", "pnpm test:pr", "pnpm typecheck", "pnpm test", "pnpm test:release", "pnpm build"):
            self.assertIn(command, ci)
        self.assertIn("python3 scripts/release/smoke.py --source-root .", ci)
        self.assertEqual(read(".node-version").strip(), "22.22.1")
        self.assertNotIn("ignoreBuildErrors", read("next.config.mjs"))
        package = json.loads(read("package.json"))
        self.assertNotIn("lint", package["scripts"])
        self.assertIn("next typegen", package["scripts"]["typecheck"])

    def test_real_sdk_tests_are_installed_and_upload_only_skips_deployment(self) -> None:
        for name in ("ci", "release"):
            workflow = self.workflows[name]
            self.assertIn("python3 -m pip install --disable-pip-version-check --no-input -r", workflow)
            self.assertIn("scripts/release/requirements.txt", workflow)
        release = self.workflows["release"]
        self.assertRegex(release, r"upload_only:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: false")
        deployment = release.split("\n  deploy:", 1)[1]
        self.assertIn("needs: [validate, package-upload]", deployment)
        self.assertIn("if: (github.event_name == 'release' || inputs.upload_only != true) && inputs.network_probe != true", deployment)

    def test_network_probe_is_isolated_from_release_objects_and_deployment(self) -> None:
        workflow = self.workflows["release"]
        probe = workflow.split("\n  network-probe:", 1)[1].split("\n  validate:", 1)[0]
        self.assertIn("inputs.network_probe == true && inputs.upload_only == true", probe)
        self.assertIn("github.event_name == 'workflow_dispatch'", probe)
        self.assertIn("github.ref == 'refs/heads/codex/probe-cos-network-path'", probe)
        self.assertIn("scripts/release/probe_network.py", probe)
        self.assertNotIn("DEPLOY_SSH_KEY", probe)
        self.assertNotIn("orchestrate.py", probe)
        self.assertNotIn("cos.py upload", probe)
        self.assertIn("needs: validate\n    if: inputs.network_probe != true", workflow)

    def test_release_please_matches_standard_token_based_flow(self) -> None:
        workflow = self.workflows["release-please"]
        self.assertIn("github.ref == 'refs/heads/master'", workflow)
        self.assertIn("token: ${{ secrets.RELEASE_PLEASE_TOKEN }}", workflow)
        self.assertNotIn("github.token", workflow)
        self.assertNotIn("actions: write", workflow)
        self.assertIn("issues: write", workflow)
        self.assertNotIn("release-pr-checks.mjs", workflow)
        self.assertNotIn("RELEASE_PRS_JSON", workflow)
        self.assertNotIn("RELEASE_PR_JSON", workflow)
        self.assertIn("release-please-action@5c625bfb5d1ff62eadeeb3772007f7f66fdcf071", workflow)
        self.assertNotIn("environment: production", workflow)
        self.assertNotIn("orchestrate.py", workflow)
        config = json.loads(read(".release-please-config.json"))
        package = config["packages"]["."]
        self.assertTrue(package["draft"])
        self.assertTrue(package["force-tag-creation"])
        self.assertTrue(package["include-v-in-tag"])
        self.assertEqual(config["bootstrap-sha"], "75b10d69e4ff4bbe7e4b9542df349f0223a44aac")
        self.assertIn({"type": "json", "path": "deploy/release-policy.json", "jsonpath": "$.version"}, package["extra-files"])

    def test_standard_pr_events_run_checks_without_release_dispatch_inputs(self) -> None:
        for name in ("ci", "pr-format"):
            workflow = self.workflows[name]
            self.assertNotIn("workflow_dispatch:", workflow)
            self.assertNotIn("pull_request_number:", workflow)
            self.assertNotIn("expected_head_sha:", workflow)
            self.assertNotIn("release-pr-checks.mjs", workflow)
        self.assertNotIn("release-pr-checks.test.mjs", json.loads(read("package.json"))["scripts"]["test:pr"])

    def test_releases_are_published_master_reachable_and_frozen(self) -> None:
        workflow = self.workflows["release"]
        for contract in ("release:\n    types: [published]", "github.event.release.prerelease == false", "github.ref == 'refs/heads/master'", "select(.draft == false and .prerelease == false)", 'git -C source merge-base --is-ancestor "$release_sha" origin/master', "ref: ${{ needs.validate.outputs.harness_sha }}", "ref: ${{ needs.validate.outputs.release_sha }}", "node harness/scripts/check-release.mjs --root source --tag", "qintopia-image/releases/"):
            self.assertIn(contract, workflow)
        self.assertNotIn("ref: ${{ github.sha }}", workflow)
        self.assertNotIn("prepare-database", workflow)
        self.assertNotIn("docker ", workflow)
        self.assertNotIn("workflow_run:", workflow)

    def test_bundle_retries_fail_closed_and_build_steps_have_no_secrets(self) -> None:
        workflow = self.workflows["release"]
        self.assertIn("cos.py fetch", workflow)
        self.assertIn('if [ "$fetch_status" != 0 ] && [ "$fetch_status" != 3 ]; then', workflow)
        self.assertIn('exit "$fetch_status"', workflow)
        build_step = workflow.split("      - name: Build and package without cloud or deployment credentials", 1)[1].split("      - name:", 1)[0]
        self.assertIn("if: steps.bundle.outputs.fetch_status == '3'", build_step)
        self.assertIn("package.py --version", build_step)
        for forbidden in ("secrets.", "SECRET_KEY", "SSH_KEY", "known-hosts"):
            self.assertNotIn(forbidden, build_step)
        self.assertIn('sha256sum "$RELEASE_DIRECTORY/manifest.json"', workflow)
        self.assertIn('orchestrate.py deploy --version "$RELEASE_VERSION" --revision "$RELEASE_REVISION" --key "$RELEASE_KEY" --manifest-sha "$RELEASE_MANIFEST_SHA"', workflow)

    def test_production_actions_share_a_non_cancelling_queue(self) -> None:
        for name in ("release", "rollback", "retention"):
            workflow = self.workflows[name]
            self.assertIn("group: qintopia-image-production", workflow)
            self.assertIn("cancel-in-progress: false", workflow)
            self.assertIn("environment: production", workflow)
            self.assertIn("DEPLOY_KNOWN_HOSTS_FILE", workflow)
            self.assertIn("if: always()", workflow)
        for name in ("rollback", "retention"):
            self.assertIn("github.ref == 'refs/heads/master'", self.workflows[name])

    def test_rollback_reuses_an_existing_bundle_and_retention_is_explicit(self) -> None:
        rollback = self.workflows["rollback"]
        self.assertIn("cos.py fetch", rollback)
        self.assertIn("orchestrate.py rollback", rollback)
        self.assertNotIn("pnpm build", rollback)
        self.assertNotIn("package.py", rollback)
        retention = self.workflows["retention"]
        self.assertIn("workflow_dispatch:", retention)
        self.assertIn("default: true", retention)
        self.assertNotIn("schedule:", retention)
        self.assertIn("maintenance --dry-run", retention)
        self.assertIn("maintenance --apply", retention)
        self.assertIn("RETENTION_COS_SECRET_KEY", retention)
        self.assertNotIn("UPLOAD_COS_SECRET_KEY", retention)


if __name__ == "__main__":
    unittest.main()
