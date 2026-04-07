import json
import subprocess
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from codex_handoff import cli
from codex_handoff.agent import write_agent_state
from codex_handoff.config import config_path
from codex_handoff.local_codex import normalize_cwd


class AgentCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.repo = Path(self.temp_dir.name) / "repo"
        self.repo.mkdir(parents=True)
        self.config_dir = Path(self.temp_dir.name) / "config"
        self.secret_path = self.config_dir / "secret.txt"
        self.secret_path.parent.mkdir(parents=True, exist_ok=True)
        self.secret_path.write_text("secret-value", encoding="utf-8")
        self.env_patch = patch.dict("os.environ", {"CODEX_HANDOFF_CONFIG_DIR": str(self.config_dir)}, clear=False)
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        config_payload = {
            "schema_version": "1.0",
            "default_profile": "default",
            "profiles": {
                "default": {
                    "provider": "cloudflare-r2",
                    "account_id": "acct123",
                    "bucket": "memory-bucket",
                    "endpoint": "https://acct123.r2.cloudflarestorage.com",
                    "region": "auto",
                    "memory_prefix": "projects/",
                    "access_key_id": "AKIA123456",
                    "secret_backend": "plaintext-file",
                    "secret_ref": str(self.secret_path),
                    "validated_at": None,
                }
            },
            "repos": {},
            "machine_id": None,
        }
        config_path().parent.mkdir(parents=True, exist_ok=True)
        config_path().write_text(json.dumps(config_payload, indent=2), encoding="utf-8")

        with patch("sys.stdout", StringIO()), patch("codex_handoff.cli.list_r2_objects", return_value=[]):
            cli.main(
                [
                    "--repo",
                    str(self.repo),
                    "enable",
                    "--profile",
                    "default",
                    "--remote-slug",
                    "fixture-remote",
                    "--skip-skill-install",
                ]
            )

    def test_agent_start_status_stop(self) -> None:
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.agent.spawn_background_process",
            return_value=SimpleNamespace(pid=43210),
        ), patch("codex_handoff.agent.is_process_running", side_effect=lambda pid: pid == 43210):
            exit_code = cli.main(["--repo", str(self.repo), "agent", "start", "--interval", "7"])
        self.assertEqual(exit_code, 0)

        stdout = StringIO()
        with patch("sys.stdout", stdout), patch("codex_handoff.agent.is_process_running", return_value=True):
            exit_code = cli.main(["--repo", str(self.repo), "agent", "status"])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["running"])
        self.assertEqual(payload["pid"], 43210)
        self.assertEqual(payload["repo_slug"], "fixture-remote")
        self.assertEqual(payload["summary_mode"], "heuristic")
        self.assertFalse(payload["initial_sync"])
        self.assertIn("autostart", payload)

        stdout = StringIO()
        with patch("sys.stdout", stdout), patch("codex_handoff.agent.is_process_running", return_value=False), patch(
            "codex_handoff.agent.terminate_process"
        ) as terminate:
            exit_code = cli.main(["--repo", str(self.repo), "agent", "stop"])
        self.assertEqual(exit_code, 0)
        terminate.assert_not_called()

    def test_agent_enable_disable_autostart(self) -> None:
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.enable_autostart",
            return_value={"task_name": "codex-handoff-fixture-remote", "enabled": True, "method": "startup-folder"},
        ):
            exit_code = cli.main(["--repo", str(self.repo), "agent", "enable"])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["enabled"])
        self.assertEqual(payload["method"], "startup-folder")

        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.disable_autostart",
            return_value={"task_name": "codex-handoff-fixture-remote", "enabled": False, "deleted": True},
        ):
            exit_code = cli.main(["--repo", str(self.repo), "agent", "disable"])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["enabled"])

    def test_agent_start_replaces_running_agent_when_same_slug_points_to_other_repo(self) -> None:
        other_repo = Path(self.temp_dir.name) / "other-repo"
        other_repo.mkdir(parents=True)
        write_agent_state(
            "fixture-remote",
            {
                "repo": str(other_repo),
                "repo_slug": "fixture-remote",
                "profile": "default",
                "pid": 11111,
                "interval_seconds": 15.0,
                "summary_mode": "auto",
                "include_raw_threads": True,
                "codex_home": None,
                "initial_sync": False,
                "log_path": str(Path(self.temp_dir.name) / "old.log"),
                "started_at": "2026-04-07T00:00:00+09:00",
                "command": ["python", "-m", "codex_handoff"],
            },
        )

        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.agent.is_process_running",
            side_effect=lambda pid: pid in {11111, 22222},
        ), patch(
            "codex_handoff.agent.terminate_process",
        ) as terminate, patch(
            "codex_handoff.agent.spawn_background_process",
            return_value=SimpleNamespace(pid=22222),
        ):
            exit_code = cli.main(["--repo", str(self.repo), "agent", "start"])
        self.assertEqual(exit_code, 0)
        terminate.assert_called_once_with(11111)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["already_running"])
        self.assertEqual(normalize_cwd(payload["repo"]), normalize_cwd(self.repo))
        self.assertEqual(payload["pid"], 22222)

    def test_agent_start_uses_absolute_entrypoint_script(self) -> None:
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.agent.spawn_background_process",
            return_value=SimpleNamespace(pid=54321),
        ), patch("codex_handoff.agent.is_process_running", side_effect=lambda pid: pid == 54321):
            exit_code = cli.main(["--repo", str(self.repo), "agent", "start"])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["command"][1].endswith("run_codex_handoff.py"))
        self.assertNotIn("-m", payload["command"])
        self.assertIn("heuristic", payload["command"])
