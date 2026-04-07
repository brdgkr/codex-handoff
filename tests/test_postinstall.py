import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class PostinstallTests(unittest.TestCase):
    def test_postinstall_writes_hidden_codex_bin_wrappers_and_copies_skill(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            codex_bin_dir = temp_path / "codex-bin"
            skills_dir = temp_path / "skills"
            env = os.environ.copy()
            env["CODEX_HANDOFF_CODEX_BIN_DIR"] = str(codex_bin_dir)
            env["CODEX_HANDOFF_SKILLS_DIR"] = str(skills_dir)

            result = subprocess.run(
                ["node", str(repo_root / "npm" / "postinstall.js")],
                cwd=str(repo_root),
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertIn("Installed Codex bin wrappers", result.stdout)
            self.assertTrue((skills_dir / "codex-handoff" / "SKILL.md").exists())

            vbs_path = codex_bin_dir / "codex-handoff.vbs"
            cmd_path = codex_bin_dir / "codex-handoff.cmd"
            ps1_path = codex_bin_dir / "codex-handoff.ps1"
            self.assertTrue(vbs_path.exists())
            self.assertTrue(cmd_path.exists())
            self.assertTrue(ps1_path.exists())

            vbs_text = vbs_path.read_text(encoding="utf-8")
            cmd_text = cmd_path.read_text(encoding="utf-8")
            ps1_text = ps1_path.read_text(encoding="utf-8")

            self.assertIn('shell.Run command, 0, False', vbs_text)
            self.assertIn('QuoteArg', vbs_text)
            self.assertIn('wscript.exe //B //NoLogo "%~dp0codex-handoff.vbs" %*', cmd_text)
            self.assertIn('wscript.exe //B //NoLogo "$PSScriptRoot\\codex-handoff.vbs" $args', ps1_text)
