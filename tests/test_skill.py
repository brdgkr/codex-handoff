import json
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from codex_handoff import cli
from codex_handoff.skills import bundled_skill_path, install_skill


class SkillTests(unittest.TestCase):
    def test_skill_install_copies_bundled_skill_when_repo_has_no_skills_dir(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir(parents=True)
            skill_target = Path(temp_dir) / "skills"
            stdout = StringIO()
            with patch("sys.stdout", stdout), patch.dict("os.environ", {"CODEX_HANDOFF_SKILLS_DIR": str(skill_target)}, clear=False):
                exit_code = cli.main(["--repo", str(repo), "skill", "install"])
            self.assertEqual(exit_code, 0)
            payload = json.loads(stdout.getvalue())
            self.assertTrue(payload["installed"])
            installed = skill_target / "codex-handoff" / "SKILL.md"
            self.assertTrue(installed.exists())
            self.assertEqual(installed.read_text(encoding="utf-8"), (bundled_skill_path() / "SKILL.md").read_text(encoding="utf-8"))

    def test_install_skill_falls_back_to_repo_skills_when_package_bundle_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            repo = temp_path / "repo"
            bundled = repo / "skills" / "codex-handoff"
            bundled.mkdir(parents=True)
            expected = "---\nname: codex-handoff\ndescription: repo bundled skill\n---\n"
            (bundled / "SKILL.md").write_text(expected, encoding="utf-8")
            skill_target = temp_path / "skills"
            with patch("codex_handoff.skills.package_root", return_value=temp_path / "missing-package-root"):
                installed_path = install_skill(repo, skill_target)
            self.assertEqual(installed_path, skill_target / "codex-handoff")
            self.assertEqual((installed_path / "SKILL.md").read_text(encoding="utf-8"), expected)
