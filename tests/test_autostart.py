import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codex_handoff.autostart import enable_autostart


class AutostartTests(unittest.TestCase):
    def test_enable_autostart_falls_back_to_startup_folder(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            startup_dir = Path(temp_dir) / "Startup"
            runtime_dir = Path(temp_dir) / "runtime"
            legacy_runtime = runtime_dir / "autostart" / "fixture-remote.cmd"
            legacy_runtime.parent.mkdir(parents=True, exist_ok=True)
            legacy_runtime.write_text("@echo off\r\n", encoding="utf-8")
            legacy_startup = startup_dir / "fixture-remote.cmd"
            legacy_startup.parent.mkdir(parents=True, exist_ok=True)
            legacy_startup.write_text("@echo off\r\n", encoding="utf-8")
            with patch("codex_handoff.autostart.startup_folder_path", return_value=startup_dir), patch(
                "codex_handoff.autostart.runtime_dir",
                return_value=runtime_dir,
            ), patch(
                "codex_handoff.autostart.subprocess.run",
                return_value=subprocess.CompletedProcess(args=["schtasks"], returncode=1, stdout="ERROR: Access is denied.", stderr=""),
            ):
                payload = enable_autostart(
                    repo=Path(temp_dir) / "repo",
                    repo_slug="fixture-remote",
                    profile_name="default",
                    interval_seconds=15.0,
                    summary_mode="auto",
                    include_raw_threads=True,
                    codex_home=None,
                )
            self.assertTrue(payload["enabled"])
            self.assertEqual(payload["method"], "startup-folder")
            self.assertTrue(Path(payload["startup_path"]).exists())
            self.assertEqual(Path(payload["script_path"]).suffix, ".vbs")
            self.assertEqual(Path(payload["startup_path"]).suffix, ".vbs")
            self.assertIn('shell.Run', Path(payload["script_path"]).read_text(encoding="utf-8"))
            self.assertIn("run_codex_handoff.py", Path(payload["script_path"]).read_text(encoding="utf-8"))
            self.assertIn("--summary-mode heuristic", Path(payload["script_path"]).read_text(encoding="utf-8"))
            self.assertFalse(legacy_runtime.exists())
            self.assertFalse(legacy_startup.exists())
