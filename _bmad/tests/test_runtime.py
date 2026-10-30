"""Offline checks for the vendored BMad execution boundary (Python 3.11+)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
PROJECT = RUNTIME.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(RUNTIME / "scripts"))

import config_utils
import render_skill


class RuntimeContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="image-bmad-runtime-")
        self.addCleanup(self.temp.cleanup)
        self.root = (Path(self.temp.name) / "项目 with spaces").resolve()
        (self.root / "_bmad").mkdir(parents=True)
        (self.root / "_bmad" / "config.toml").write_bytes((RUNTIME / "config.toml").read_bytes())
        self.skill = Path(self.temp.name) / "fixture-skill"
        self.skill.mkdir()
        (self.skill / "SKILL.md").write_text("Fixture only; not an activation entry.\n", encoding="utf-8")
        (self.skill / "workflow.md").write_text(
            "# Fixture workflow\n{{.communication_language}}\n"
            "{{.implementation_artifacts}}\n[[bmad-snapshot:step.md]]\n",
            encoding="utf-8",
        )
        (self.skill / "step.md").write_text("# Fixture step\n", encoding="utf-8")

    def test_upstream_integrity_and_project_scope(self):
        manifest = json.loads((RUNTIME / "runtime-installation.json").read_text())
        for name, expected in manifest["files"].items():
            self.assertEqual(hashlib.sha256((RUNTIME / "scripts" / name).read_bytes()).hexdigest(), expected)
        self.assertEqual(hashlib.sha256((RUNTIME / "LICENSE").read_bytes()).hexdigest(), manifest["licenseSha256"])
        config = config_utils.load_central_config(PROJECT)
        self.assertEqual(config["core"]["communication_language"], "简体中文")
        self.assertEqual(config["core"]["document_output_language"], "简体中文")
        self.assertEqual(config["modules"]["bmm"]["planning_artifacts"], "{project-root}/docs/planning")
        self.assertEqual(config["modules"]["bmm"]["implementation_artifacts"], "{project-root}/docs/implementation")

    def test_snapshot_is_bound_to_project_and_refuses_tampering(self):
        entry = render_skill.render(self.root, self.skill)
        self.assertTrue(entry.is_relative_to(self.root / "_bmad" / "render"))
        content = entry.read_text()
        self.assertIn("简体中文", content)
        self.assertIn(str(self.root / "docs" / "implementation"), content)
        self.assertIn(str(entry.parent / "step.md"), content)
        self.assertEqual(render_skill.render(self.root, self.skill), entry)
        entry.write_text(content + "tampered\n", encoding="utf-8")
        with self.assertRaisesRegex(render_skill.RenderError, "output hash mismatch"):
            render_skill.render(self.root, self.skill)

    def test_unresolved_config_fails_without_publishing_workflow(self):
        (self.skill / "workflow.md").write_text("{{.nonexistent_field}}\n", encoding="utf-8")
        with self.assertRaisesRegex(render_skill.RenderError, "missing config value"):
            render_skill.render(self.root, self.skill)
        self.assertFalse((self.root / "_bmad" / "render").exists())

    def test_synthetic_review_layers_bind_instructions_to_snapshot(self):
        review = self.skill / "review-prompts" / "fixture-review.md"
        review.parent.mkdir()
        review.write_text("# 合成审阅\n核验合成输入。\n", encoding="utf-8")
        (self.skill / "customize.toml").write_text(
            '[[workflow.review_layers]]\n'
            'id = "fixture-review"\n'
            'name = "合成审阅"\n'
            'instruction = "读取 `{skill-root}/review-prompts/fixture-review.md` 并核验合成输入。"\n',
            encoding="utf-8",
        )
        workflow = self.skill / "workflow.md"
        workflow.write_text(workflow.read_text() + "\n{workflow.review_layers}\n", encoding="utf-8")
        entry = render_skill.render(self.root, self.skill)
        content = entry.read_text()
        target = entry.parent / "review-prompts" / "fixture-review.md"
        self.assertIn("#### 合成审阅 (`fixture-review`)", content)
        self.assertIn(f"读取 `{target}` 并核验合成输入。", content)
        self.assertNotIn("{workflow.review_layers}", content)
        self.assertNotIn("{skill-root}", content)
        self.assertTrue(target.is_absolute())
        self.assertTrue(target.is_file())
        self.assertEqual(target.read_text(), review.read_text())

    def test_installed_build_inputs_resolve_without_activating_it(self):
        skill = Path.home() / ".agents" / "skills" / "bmad-build"
        if not skill.is_dir():
            self.skipTest("Global bmad-build skill is not installed on this host")
        skill = skill.resolve(strict=True)
        sources = render_skill._load_sources(skill)
        defaults = config_utils.load_toml(skill / "customize.toml", required=True)
        custom = config_utils.load_customization(PROJECT, skill)
        replacements, inputs = render_skill._resolve_replacements(
            sources, config_utils.load_central_config(PROJECT), custom, defaults, PROJECT
        )
        self.assertTrue(replacements)
        self.assertEqual(inputs["config.core.communication_language"], "简体中文")
        self.assertTrue(any(k.endswith("implementation_artifacts") for k in inputs))
        layers = custom["workflow"]["review_layers"]
        self.assertTrue(any(layer.get("instruction", "").strip() for layer in layers))
        # Deliberately no render() or CLI activation for the real bmad-build skill.

    def test_memlog_appends_and_refuses_reinitialization(self):
        workspace = self.root / "scratch"
        script = RUNTIME / "scripts" / "memlog.py"
        def run(*args):
            return subprocess.run([sys.executable, str(script), *args], capture_output=True, text=True)
        self.assertEqual(run("init", "--workspace", str(workspace), "--field", "topic=执行器验证").returncode, 0)
        self.assertEqual(run("append", "--workspace", str(workspace), "--type", "event", "--text", "第一条").returncode, 0)
        self.assertEqual(run("append", "--workspace", str(workspace), "--type", "event", "--text", "第二条").returncode, 0)
        log = (workspace / ".memlog.md").read_text()
        self.assertLess(log.index("第一条"), log.index("第二条"))
        self.assertNotEqual(run("init", "--workspace", str(workspace)).returncode, 0)
        self.assertEqual((workspace / ".memlog.md").read_text(), log)


if __name__ == "__main__":
    unittest.main()
