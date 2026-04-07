import json
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from codex_handoff import cli
from codex_handoff.config import config_path


class ReceiveTests(unittest.TestCase):
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

    def test_receive_runs_enable_pull_and_agent(self) -> None:
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.list_r2_objects",
            return_value=[{"key": "repos/fixture-remote/manifest.json"}],
        ), patch(
            "codex_handoff.cli.pull_memory_tree",
            return_value=[],
        ), patch(
            "codex_handoff.cli.enable_autostart",
            return_value={"task_name": "codex-handoff-fixture-remote", "enabled": True},
        ), patch(
            "codex_handoff.agent.spawn_background_process",
            return_value=SimpleNamespace(pid=55555),
        ), patch("codex_handoff.agent.is_process_running", side_effect=lambda pid: pid == 55555), patch(
            "codex_handoff.cli.install_skill",
            return_value=self.repo / ".mock-skill",
        ):
            exit_code = cli.main(
                [
                    "--repo",
                    str(self.repo),
                    "receive",
                    "--profile",
                    "default",
                    "--remote-slug",
                    "fixture-remote",
                ]
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["sync_action"], "pull")
        self.assertTrue(payload["autostart_result"]["enabled"])
        self.assertTrue(payload["agent_result"]["running"])

    def test_receive_returns_selection_payload_when_remote_choice_is_ambiguous(self) -> None:
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.list_r2_objects",
            return_value=[{"key": "repos/alpha/manifest.json"}, {"key": "repos/beta/manifest.json"}],
        ), patch(
            "codex_handoff.cli.install_skill",
            return_value=self.repo / ".mock-skill",
        ):
            exit_code = cli.main(
                [
                    "--repo",
                    str(self.repo),
                    "receive",
                    "--profile",
                    "default",
                    "--skip-agent-start",
                    "--skip-autostart",
                ]
            )
        self.assertEqual(exit_code, 0)
        text = stdout.getvalue()
        self.assertIn("Remote project selection is required.", text)
        self.assertIn("Candidates:", text)
        self.assertIn("1. alpha", text)
        self.assertIn("2. beta", text)

    def test_receive_matches_single_existing_remote_candidate(self) -> None:
        repo = Path(self.temp_dir.name) / "fresh-local-repo"
        repo.mkdir(parents=True, exist_ok=True)
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.list_r2_objects",
            return_value=[{"key": "repos/fixture-remote/manifest.json"}],
        ), patch(
            "codex_handoff.cli.pull_memory_tree",
            return_value=[],
        ), patch(
            "codex_handoff.agent.spawn_background_process",
            return_value=SimpleNamespace(pid=55555),
        ), patch("codex_handoff.agent.is_process_running", side_effect=lambda pid: pid == 55555), patch(
            "codex_handoff.cli.install_skill",
            return_value=repo / ".mock-skill",
        ):
            exit_code = cli.main(
                [
                    "--repo",
                    str(repo),
                    "receive",
                    "--profile",
                    "default",
                    "--skip-autostart",
                ]
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["enable_result"]["repo_slug"], "fixture-remote")
        self.assertEqual(payload["enable_result"]["match_status"], "matched_remote_single_candidate")
        self.assertEqual(payload["sync_action"], "pull")
