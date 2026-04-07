import json
import subprocess
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from codex_handoff import cli
from codex_handoff.config import config_path
from codex_handoff.remote_auth import R2CredentialSourceError, _run_clipboard_command, parse_r2_credentials


class RemoteAuthSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.env_patch = patch.dict("os.environ", {"CODEX_HANDOFF_CONFIG_DIR": self.temp_dir.name}, clear=False)
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    def test_remote_login_from_env(self) -> None:
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.read_r2_credentials_from_env",
            return_value={
                "account_id": "acct123",
                "bucket": "memory-bucket",
                "access_key_id": "AKIA123456",
                "secret_access_key": "very-secret",
                "endpoint": "https://acct123.r2.cloudflarestorage.com",
            },
        ), patch(
            "codex_handoff.cli.validate_r2_credentials",
            return_value={"status": "200", "bucket": "memory-bucket", "request_url": "https://example"},
        ), patch(
            "codex_handoff.cli.store_secret",
            return_value={"secret_backend": "plaintext-file", "secret_ref": str(Path(self.temp_dir.name) / "secret.txt")},
        ):
            exit_code = cli.main(["remote", "login", "r2", "--from-env"])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["profile"], "default")
        saved = json.loads(config_path().read_text(encoding="utf-8"))
        self.assertEqual(saved["profiles"]["default"]["bucket"], "memory-bucket")

    def test_remote_login_from_clipboard(self) -> None:
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.read_r2_credentials_from_clipboard",
            return_value={
                "account_id": "acct999",
                "bucket": "clip-bucket",
                "access_key_id": "AKIA999999",
                "secret_access_key": "clip-secret",
                "endpoint": "https://acct999.r2.cloudflarestorage.com",
            },
        ), patch(
            "codex_handoff.cli.validate_r2_credentials",
            return_value={"status": "200", "bucket": "clip-bucket", "request_url": "https://example"},
        ), patch(
            "codex_handoff.cli.store_secret",
            return_value={"secret_backend": "plaintext-file", "secret_ref": str(Path(self.temp_dir.name) / "secret.txt")},
        ):
            exit_code = cli.main(["remote", "login", "r2", "--from-clipboard", "--profile", "default"])
        self.assertEqual(exit_code, 0)
        saved = json.loads(config_path().read_text(encoding="utf-8"))
        self.assertEqual(saved["profiles"]["default"]["account_id"], "acct999")

    def test_remote_login_from_dotenv(self) -> None:
        dotenv_path = Path(self.temp_dir.name) / ".env.local"
        dotenv_path.write_text(
            "\n".join(
                [
                    "account_id=acct555",
                    "bucket=dotenv-bucket",
                    "access_key_id=AKIA555555",
                    "secret_access_key=dotenv-secret",
                ]
            ),
            encoding="utf-8",
        )
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch(
            "codex_handoff.cli.validate_r2_credentials",
            return_value={"status": "200", "bucket": "dotenv-bucket", "request_url": "https://example"},
        ), patch(
            "codex_handoff.cli.store_secret",
            return_value={"secret_backend": "plaintext-file", "secret_ref": str(Path(self.temp_dir.name) / "secret.txt")},
        ):
            exit_code = cli.main(["remote", "login", "r2", "--dotenv", str(dotenv_path), "--profile", "default"])
        self.assertEqual(exit_code, 0)
        saved = json.loads(config_path().read_text(encoding="utf-8"))
        self.assertEqual(saved["profiles"]["default"]["bucket"], "dotenv-bucket")

    def test_remote_login_show_setup_info(self) -> None:
        stdout = StringIO()
        with patch("sys.stdout", stdout), patch("codex_handoff.cli.open_r2_dashboard", return_value=True):
            exit_code = cli.main(["remote", "login", "r2", "--show-setup-info", "--open-dashboard"])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertIn("dashboard_url", payload)
        self.assertIn("credential_template", payload)
        self.assertTrue(payload["opened_browser"])

    def test_remote_login_rejects_non_default_profile(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            cli.main(["remote", "login", "r2", "--profile", "other"])
        self.assertIn("supports only one remote profile", str(ctx.exception))

    def test_parse_r2_credentials_rejects_none(self) -> None:
        with self.assertRaises(R2CredentialSourceError):
            parse_r2_credentials(None)

    def test_run_clipboard_command_returns_empty_string_when_stdout_is_none(self) -> None:
        with patch(
            "codex_handoff.remote_auth.subprocess.run",
            return_value=subprocess.CompletedProcess(args=["x"], returncode=0, stdout=None, stderr=None),
        ):
            self.assertEqual(_run_clipboard_command(["dummy"], encoding="utf-8"), "")
