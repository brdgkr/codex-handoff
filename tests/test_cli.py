import json
import subprocess
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from codex_handoff import cli
from codex_handoff.config import config_path


FIXTURE_LATEST = """# Current State

- Resume flow is under test.
- Search should rank raw evidence instead of dumping whole logs.
"""


FIXTURE_HANDOFF = {
    "schema_version": "1.0",
    "project_id": "fixture-project",
    "updated_at": "2026-04-07T00:00:00+09:00",
    "current_goal": "Validate restore output.",
    "status_summary": "Testing the local reader CLI.",
    "active_branch": "main",
    "next_prompt": "Run resume and inspect the ranked evidence.",
    "search_hints": ["scene-evidence", "restore", "reader"],
    "related_files": ["src/app.ts", "README.md"],
    "decisions": [{"summary": "Use latest.md first.", "rationale": "Fast bootstrap."}],
    "todos": [
        {
            "id": "todo-1",
            "summary": "Verify search output.",
            "status": "pending",
            "priority": "high"
        }
    ],
    "recent_commands": [{"command": "python3 -m codex_handoff status --repo .", "purpose": "sanity check"}]
}


FIXTURE_RAW = [
    {
        "session_id": "sess-1",
        "turn_id": "turn-1",
        "timestamp": "2026-04-07T00:00:01+09:00",
        "role": "assistant",
        "message": "reader CLI should build a restore pack from scene-evidence notes"
    },
    {
        "session_id": "sess-1",
        "turn_id": "turn-2",
        "timestamp": "2026-04-07T00:00:02+09:00",
        "role": "assistant",
        "message": "unrelated output"
    }
]


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp_dir.name)
        memory_dir = self.repo / ".codex-handoff"
        raw_dir = memory_dir / "raw"
        raw_dir.mkdir(parents=True)
        (memory_dir / "latest.md").write_text(FIXTURE_LATEST, encoding="utf-8")
        (memory_dir / "handoff.json").write_text(
            json.dumps(FIXTURE_HANDOFF, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        with (raw_dir / "session.jsonl").open("w", encoding="utf-8") as handle:
            for record in FIXTURE_RAW:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def run_cli(self, *args: str) -> str:
        result = subprocess.run(
            [sys.executable, "-m", "codex_handoff", "--repo", str(self.repo), *args],
            cwd=str(Path(__file__).resolve().parents[1]),
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout

    def test_status_reports_counts(self) -> None:
        output = self.run_cli("status")
        self.assertIn("latest.md: present", output)
        self.assertIn("handoff.json: present", output)
        self.assertIn("raw jsonl files: 1", output)
        self.assertIn("raw records: 2", output)

    def test_search_finds_ranked_matches(self) -> None:
        output = self.run_cli("search", "scene-evidence")
        self.assertIn("matches: 1", output)
        self.assertIn("session=sess-1", output)
        self.assertIn("turn=turn-1", output)

    def test_resume_renders_restore_pack(self) -> None:
        output = self.run_cli("resume", "--goal", "scene-evidence 이어서")
        self.assertIn("# Codex Restore Pack", output)
        self.assertIn("Validate restore output.", output)
        self.assertIn("Verify search output.", output)
        self.assertIn("session=sess-1", output)

    def test_extract_returns_raw_json(self) -> None:
        output = self.run_cli("extract", "--session", "sess-1", "--turn", "turn-1")
        payload = json.loads(output)
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["turn_id"], "turn-1")


class RemoteCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.env_patch = patch.dict("os.environ", {"CODEX_HANDOFF_CONFIG_DIR": self.temp_dir.name}, clear=False)
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    def test_remote_login_and_whoami(self) -> None:
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.validate_r2_credentials",
            return_value={"status": "200", "bucket": "memory-bucket", "request_url": "https://example"},
        ), patch(
            "codex_handoff.cli.store_secret",
            return_value={"secret_backend": "plaintext-file", "secret_ref": str(Path(self.temp_dir.name) / "secret.txt")},
        ):
            exit_code = cli.main(
                [
                    "remote",
                    "login",
                    "r2",
                    "--profile",
                    "default",
                    "--account-id",
                    "acct123",
                    "--bucket",
                    "memory-bucket",
                    "--access-key-id",
                    "AKIA123456",
                    "--secret-access-key",
                    "very-secret",
                ]
            )
        self.assertEqual(exit_code, 0)
        saved = json.loads(config_path().read_text(encoding="utf-8"))
        self.assertEqual(saved["default_profile"], "default")
        self.assertEqual(saved["profiles"]["default"]["provider"], "cloudflare-r2")

        stdout = StringIO()
        with patch("sys.stdout", stdout):
            exit_code = cli.main(["remote", "whoami"])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["profile"], "default")
        self.assertEqual(payload["bucket"], "memory-bucket")
        self.assertTrue(payload["access_key_id"].startswith("AK"))

    def test_remote_validate_and_logout(self) -> None:
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
                    "secret_ref": str(Path(self.temp_dir.name) / "secret.txt"),
                    "validated_at": None
                }
            }
        }
        Path(self.temp_dir.name, "secret.txt").write_text("very-secret", encoding="utf-8")
        config_path().parent.mkdir(parents=True, exist_ok=True)
        config_path().write_text(json.dumps(config_payload, indent=2), encoding="utf-8")

        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.validate_r2_credentials",
            return_value={"status": "200", "bucket": "memory-bucket", "request_url": "https://example"},
        ):
            exit_code = cli.main(["remote", "validate"])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["profile"], "default")

        stdout = StringIO()
        with patch("sys.stdout", stdout):
            exit_code = cli.main(["remote", "logout"])
        self.assertEqual(exit_code, 0)
        saved = json.loads(config_path().read_text(encoding="utf-8"))
        self.assertEqual(saved["profiles"], {})


if __name__ == "__main__":
    unittest.main()
