import json
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from codex_handoff import cli
from codex_handoff.config import config_path
from codex_handoff.local_codex import codex_paths, inject_thread


class InstallDoctorTests(unittest.TestCase):
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

    def test_install_runs_enable_and_agent(self) -> None:
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch("codex_handoff.cli.list_r2_objects", return_value=[]), patch(
            "codex_handoff.cli.install_skill",
            return_value=self.repo / ".mock-skill",
        ), patch(
            "codex_handoff.agent.spawn_background_process",
            return_value=SimpleNamespace(pid=12345),
        ), patch("codex_handoff.agent.is_process_running", side_effect=lambda pid: pid == 12345):
            exit_code = cli.main(
                [
                    "--repo",
                    str(self.repo),
                    "install",
                    "--profile",
                    "default",
                    "--remote-slug",
                    "fixture-remote",
                    "--skip-sync-now",
                ]
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["enable_result"]["repo_slug"], "fixture-remote")
        self.assertIsNone(payload["sync_action"])
        self.assertTrue(payload["agent_result"]["running"])

    def test_install_pulls_when_remote_repo_exists(self) -> None:
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.list_r2_objects",
            return_value=[{"key": "repos/fixture-remote/manifest.json"}],
        ), patch(
            "codex_handoff.cli.install_skill",
            return_value=self.repo / ".mock-skill",
        ), patch(
            "codex_handoff.cli.pull_memory_tree",
            return_value=[],
        ), patch(
            "codex_handoff.agent.spawn_background_process",
            return_value=SimpleNamespace(pid=12345),
        ), patch("codex_handoff.agent.is_process_running", side_effect=lambda pid: pid == 12345):
            exit_code = cli.main(
                [
                    "--repo",
                    str(self.repo),
                    "install",
                    "--profile",
                    "default",
                    "--remote-slug",
                    "fixture-remote",
                ]
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["sync_action"], "pull")

    def test_install_pushes_when_single_remote_candidate_does_not_match_local_repo(self) -> None:
        repo = Path(self.temp_dir.name) / "fresh-local-repo"
        repo.mkdir(parents=True, exist_ok=True)
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.list_r2_objects",
            return_value=[{"key": "repos/fixture-remote/manifest.json"}],
        ), patch(
            "codex_handoff.cli.install_skill",
            return_value=repo / ".mock-skill",
        ), patch(
            "codex_handoff.cli.sync_now",
            return_value={"uploaded_objects": 3, "prefix": "repos/fresh-local-repo/"},
        ), patch(
            "codex_handoff.agent.spawn_background_process",
            return_value=SimpleNamespace(pid=12345),
        ), patch("codex_handoff.agent.is_process_running", side_effect=lambda pid: pid == 12345):
            exit_code = cli.main(
                [
                    "--repo",
                    str(repo),
                    "install",
                    "--profile",
                    "default",
                ]
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["enable_result"]["repo_slug"], "fresh-local-repo")
        self.assertEqual(payload["enable_result"]["match_status"], "create_new")
        self.assertEqual(payload["sync_action"], "push")

    def test_install_first_push_uploads_objects_when_remote_repo_is_absent(self) -> None:
        repo = Path(self.temp_dir.name) / "first-push-repo"
        repo.mkdir(parents=True, exist_ok=True)
        codex_home = Path(self.temp_dir.name) / "codex-home"
        inject_thread(
            codex_paths(str(codex_home)),
            title="First Push Thread",
            thread_name="First Push Thread",
            user_message="Verify the first push flow.",
            assistant_message="First push should upload this thread bundle.",
            cwd=str(repo),
            thread_id="first-push-thread-001",
            apply=True,
        )

        uploaded_payloads: dict[str, bytes] = {}

        def fake_put(_profile, key, payload, timeout=30):
            uploaded_payloads[key] = payload
            return {"status": "200", "url": key}

        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.list_r2_objects",
            return_value=[],
        ), patch(
            "codex_handoff.cli.install_skill",
            return_value=repo / ".mock-skill",
        ), patch(
            "codex_handoff.sync.put_r2_object",
            side_effect=fake_put,
        ):
            exit_code = cli.main(
                [
                    "--repo",
                    str(repo),
                    "install",
                    "--profile",
                    "default",
                    "--codex-home",
                    str(codex_home),
                    "--skip-agent-start",
                    "--skip-autostart",
                ]
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["enable_result"]["repo_slug"], "first-push-repo")
        self.assertEqual(payload["enable_result"]["match_status"], "create_new")
        self.assertEqual(payload["sync_action"], "push")
        self.assertGreater(payload["sync_result"]["objects_uploaded"], 0)
        self.assertIn("repos/first-push-repo/repo.json", uploaded_payloads)
        self.assertIn("repos/first-push-repo/latest.md", uploaded_payloads)
        self.assertIn("repos/first-push-repo/threads/first-push-thread-001/manifest.json", uploaded_payloads)

    def test_doctor_reports_basic_health(self) -> None:
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch("codex_handoff.cli.preferred_codex_cli", return_value="C:\\Codex\\codex.exe"):
            exit_code = cli.main(["--repo", str(self.repo), "doctor"])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["python"])
        self.assertTrue(payload["node"])
        self.assertTrue(payload["npm"])
        self.assertEqual(payload["codex"], "C:\\Codex\\codex.exe")
        self.assertTrue(payload["agents_exists"] is False or payload["agents_exists"] is True)
        self.assertTrue(payload["repo_state_consistent"])

    def test_doctor_warns_when_repo_state_points_to_other_repo(self) -> None:
        memory_dir = self.repo / ".codex-handoff"
        memory_dir.mkdir(parents=True, exist_ok=True)
        (memory_dir / "repo.json").write_text(
            json.dumps(
                {
                    "repo_path": str(Path(self.temp_dir.name) / "other-repo"),
                    "repo_slug": "fixture-remote",
                    "remote_profile": "default",
                    "remote_prefix": "repos/fixture-remote/",
                    "git_origin_url": "https://github.com/example/other.git",
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        stdout = StringIO()
        with patch("sys.stdout", stdout):
            exit_code = cli.main(["--repo", str(self.repo), "doctor"])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["repo_state_consistent"])
        self.assertIn("repo.json points to", payload["repo_state_warning"])

    def test_doctor_reports_local_sync_health_when_sync_state_exists(self) -> None:
        memory_dir = self.repo / ".codex-handoff"
        raw_dir = memory_dir / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        (memory_dir / "repo.json").write_text(
            json.dumps(
                {
                    "repo_path": str(self.repo),
                    "repo_slug": "fixture-remote",
                    "remote_profile": "default",
                    "remote_prefix": "repos/fixture-remote/",
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        (memory_dir / "thread-index.json").write_text(
            json.dumps([{"thread_id": "thread-001", "title": "Thread 001"}], ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (memory_dir / "current-thread.json").write_text('{"thread_id":"thread-001"}\n', encoding="utf-8")
        (memory_dir / "latest.md").write_text("# Current State\n", encoding="utf-8")
        (memory_dir / "handoff.json").write_text('{"schema_version":"1.0"}\n', encoding="utf-8")
        (raw_dir / "session.jsonl").write_text('{"message":"current"}\n', encoding="utf-8")
        (memory_dir / "sync-state.json").write_text(
            json.dumps(
                {
                    "schema_version": "1.0",
                    "repo_slug": "fixture-remote",
                    "remote_profile": "default",
                    "remote_prefix": "repos/fixture-remote/",
                    "last_sync_at": "2026-04-07T10:00:00+09:00",
                    "last_sync_direction": "push",
                    "last_sync_command": "now",
                    "current_thread": "thread-001",
                    "thread_count": 1,
                    "thread_ids": ["thread-001"],
                    "materialized_root": {
                        "latest_md_present": True,
                        "handoff_json_present": True,
                        "raw_session_present": True,
                    },
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        stdout = StringIO()
        with patch("sys.stdout", stdout):
            exit_code = cli.main(["--repo", str(self.repo), "doctor"])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["sync_state"]["last_sync_direction"], "push")
        self.assertEqual(payload["sync_health"]["status"], "ok")
        self.assertEqual(payload["sync_health"]["current_thread"], "thread-001")

    def test_install_defaults_to_login_if_needed_with_global_dotenv(self) -> None:
        config_path().write_text(
            json.dumps({"schema_version": "1.0", "default_profile": "default", "profiles": {}, "repos": {}, "machine_id": None}, indent=2),
            encoding="utf-8",
        )
        global_dotenv = self.config_dir / ".env.local"
        global_dotenv.write_text(
            "\n".join(
                [
                    "account_id=acct-global",
                    "bucket=global-bucket",
                    "access_key_id=AKIA-global",
                    "secret_access_key=global-secret",
                ]
            ),
            encoding="utf-8",
        )
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.validate_r2_credentials",
            return_value={"status": "200", "bucket": "global-bucket", "request_url": "https://example"},
        ), patch(
            "codex_handoff.cli.store_secret",
            return_value={"secret_backend": "plaintext-file", "secret_ref": str(self.secret_path)},
        ), patch("codex_handoff.cli.list_r2_objects", return_value=[]), patch(
            "codex_handoff.cli.install_skill",
            return_value=self.repo / ".mock-skill",
        ):
            exit_code = cli.main(
                [
                    "--repo",
                    str(self.repo),
                    "install",
                    "--skip-sync-now",
                    "--skip-agent-start",
                    "--skip-autostart",
                ]
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["enable_result"]["remote_profile"], "default")
