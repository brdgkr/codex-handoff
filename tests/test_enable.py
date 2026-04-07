import json
import subprocess
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from codex_handoff import cli
from codex_handoff.config import config_path


class EnableCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.repo = Path(self.temp_dir.name) / "repo"
        self.repo.mkdir(parents=True)
        (self.repo / "AGENTS.md").write_text("# Existing Instructions\n", encoding="utf-8")
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
        }
        config_path().parent.mkdir(parents=True, exist_ok=True)
        config_path().write_text(json.dumps(config_payload, indent=2), encoding="utf-8")

    def test_enable_writes_repo_state_and_agents_block(self) -> None:
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch("codex_handoff.cli.list_r2_objects", return_value=[]):
            exit_code = cli.main(
                [
                    "--repo",
                    str(self.repo),
                    "enable",
                    "--profile",
                    "default",
                    "--remote-slug",
                    "fixture-remote",
                    "--summary-mode",
                    "heuristic",
                    "--skip-raw-threads",
                    "--skip-skill-install",
                ]
            )
        self.assertEqual(exit_code, 0)

        memory_dir = self.repo / ".codex-handoff"
        repo_state = json.loads((memory_dir / "repo.json").read_text(encoding="utf-8"))
        self.assertEqual(repo_state["repo_slug"], "fixture-remote")
        self.assertEqual(repo_state["remote_profile"], "default")
        self.assertFalse(repo_state["include_raw_threads"])
        self.assertEqual(repo_state["summary_mode"], "heuristic")
        self.assertEqual(repo_state["match_status"], "explicit")
        self.assertTrue(repo_state["machine_id"])

        agents = (self.repo / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("<!-- codex-handoff:start -->", agents)
        self.assertIn("fixture-remote", agents)
        self.assertIn("codex-handoff --repo . resume", agents)
        gitignore = (self.repo / ".gitignore").read_text(encoding="utf-8")
        self.assertIn(".codex-handoff/", gitignore)

        config_payload = json.loads(config_path().read_text(encoding="utf-8"))
        self.assertEqual(len(config_payload["repos"]), 1)
        stored_repo, stored_payload = next(iter(config_payload["repos"].items()))
        self.assertTrue(stored_repo.lower().endswith("\\repo"))
        self.assertEqual(stored_payload["repo_slug"], "fixture-remote")

    def test_enable_does_not_duplicate_gitignore_entry(self) -> None:
        (self.repo / ".gitignore").write_text(".codex-handoff/\n", encoding="utf-8")
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch("codex_handoff.cli.list_r2_objects", return_value=[]):
            exit_code = cli.main(
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
        self.assertEqual(exit_code, 0)
        gitignore = (self.repo / ".gitignore").read_text(encoding="utf-8")
        self.assertEqual(gitignore.count(".codex-handoff/"), 1)

    def test_enable_auto_matches_existing_remote_slug(self) -> None:
        second_repo = Path(self.temp_dir.name) / "repo"
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.list_r2_objects",
            return_value=[{"key": "repos/repo/manifest.json"}],
        ):
            exit_code = cli.main(
                [
                    "--repo",
                    str(second_repo),
                    "enable",
                    "--profile",
                    "default",
                    "--skip-skill-install",
                ]
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["repo_slug"], "repo")
        self.assertEqual(payload["match_status"], "matched_remote_inferred")

    def test_enable_auto_matches_existing_remote_by_git_origin_when_slug_differs(self) -> None:
        second_repo = Path(self.temp_dir.name) / "local-repo"
        second_repo.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init"], cwd=second_repo, check=True, capture_output=True)
        subprocess.run(
            ["git", "remote", "add", "origin", "https://github.com/example/matching.git"],
            cwd=second_repo,
            check=True,
            capture_output=True,
        )
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.list_r2_objects",
            return_value=[{"key": "repos/remote-copy/repo.json"}],
        ), patch(
            "codex_handoff.cli.get_r2_object",
            return_value=json.dumps({"repo_slug": "remote-copy", "git_origin_url": "https://github.com/example/matching.git"}).encode("utf-8"),
        ):
            exit_code = cli.main(
                [
                    "--repo",
                    str(second_repo),
                    "enable",
                    "--profile",
                    "default",
                    "--skip-skill-install",
                ]
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["repo_slug"], "remote-copy")
        self.assertEqual(payload["match_status"], "matched_remote_best_candidate")

    def test_enable_auto_creates_new_remote_when_single_remote_candidate_does_not_match(self) -> None:
        second_repo = Path(self.temp_dir.name) / "local-repo"
        second_repo.mkdir(parents=True, exist_ok=True)
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.list_r2_objects",
            return_value=[{"key": "repos/remote-only/manifest.json"}],
        ):
            exit_code = cli.main(
                [
                    "--repo",
                    str(second_repo),
                    "enable",
                    "--profile",
                    "default",
                    "--skip-skill-install",
                ]
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["repo_slug"], "local-repo")
        self.assertEqual(payload["match_status"], "create_new")

    def test_enable_auto_creates_new_remote_when_multiple_remote_candidates_are_ambiguous(self) -> None:
        second_repo = Path(self.temp_dir.name) / "another-local-repo"
        second_repo.mkdir(parents=True, exist_ok=True)
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.list_r2_objects",
            return_value=[{"key": "repos/alpha/manifest.json"}, {"key": "repos/beta/manifest.json"}],
        ):
            exit_code = cli.main(
                [
                    "--repo",
                    str(second_repo),
                    "enable",
                    "--profile",
                    "default",
                    "--skip-skill-install",
                ]
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["repo_slug"], "another-local-repo")
        self.assertEqual(payload["match_status"], "create_new")

    def test_enable_reuses_existing_local_repo_state_before_re_matching(self) -> None:
        with patch("sys.stdout", StringIO()), patch("codex_handoff.cli.list_r2_objects", return_value=[]):
            first_exit = cli.main(
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
        self.assertEqual(first_exit, 0)

        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.list_r2_objects",
            return_value=[{"key": "repos/some-other-remote/manifest.json"}],
        ):
            exit_code = cli.main(
                [
                    "--repo",
                    str(self.repo),
                    "enable",
                    "--profile",
                    "default",
                    "--skip-skill-install",
                ]
            )
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["repo_slug"], "fixture-remote")
        self.assertEqual(payload["match_status"], "existing_local")

    def test_enable_login_if_needed_uses_auth_source(self) -> None:
        config_path().write_text(
            json.dumps({"schema_version": "1.0", "default_profile": None, "profiles": {}, "repos": {}, "machine_id": None}, indent=2),
            encoding="utf-8",
        )
        secret_target = Path(self.temp_dir.name) / "secret.txt"
        secret_target.write_text("auto-secret", encoding="utf-8")
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.read_r2_credentials_from_clipboard",
            return_value={
                "account_id": "acct777",
                "bucket": "auto-bucket",
                "access_key_id": "AKIA777777",
                "secret_access_key": "auto-secret",
                "endpoint": "https://acct777.r2.cloudflarestorage.com",
            },
        ), patch(
            "codex_handoff.cli.validate_r2_credentials",
            return_value={"status": "200", "bucket": "auto-bucket", "request_url": "https://example"},
        ), patch(
            "codex_handoff.cli.store_secret",
            return_value={"secret_backend": "plaintext-file", "secret_ref": str(secret_target)},
        ), patch("codex_handoff.cli.list_r2_objects", return_value=[]):
            exit_code = cli.main(
                [
                    "--repo",
                    str(self.repo),
                    "enable",
                    "--login-if-needed",
                    "--auth-source",
                    "clipboard",
                    "--skip-skill-install",
                ]
            )
        self.assertEqual(exit_code, 0)
        repo_state = json.loads((self.repo / ".codex-handoff" / "repo.json").read_text(encoding="utf-8"))
        self.assertEqual(repo_state["remote_profile"], "default")

    def test_enable_login_if_needed_uses_default_dotenv_path(self) -> None:
        config_path().write_text(
            json.dumps({"schema_version": "1.0", "default_profile": None, "profiles": {}, "repos": {}, "machine_id": None}, indent=2),
            encoding="utf-8",
        )
        dotenv_path = self.config_dir / ".env.local"
        dotenv_path.write_text(
            "\n".join(
                [
                    "account_id=acct-dotenv",
                    "bucket=dotenv-bucket",
                    "access_key_id=AKIA-dotenv",
                    "secret_access_key=dotenv-secret",
                ]
            ),
            encoding="utf-8",
        )
        secret_target = Path(self.temp_dir.name) / "secret-dotenv.txt"
        secret_target.write_text("dotenv-secret", encoding="utf-8")
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.validate_r2_credentials",
            return_value={"status": "200", "bucket": "dotenv-bucket", "request_url": "https://example"},
        ), patch(
            "codex_handoff.cli.store_secret",
            return_value={"secret_backend": "plaintext-file", "secret_ref": str(secret_target)},
        ), patch("codex_handoff.cli.list_r2_objects", return_value=[]):
            exit_code = cli.main(
                [
                    "--repo",
                    str(self.repo),
                    "enable",
                    "--login-if-needed",
                    "--auth-source",
                    "dotenv",
                    "--skip-skill-install",
                ]
            )
        self.assertEqual(exit_code, 0)
        repo_state = json.loads((self.repo / ".codex-handoff" / "repo.json").read_text(encoding="utf-8"))
        self.assertEqual(repo_state["remote_profile"], "default")
