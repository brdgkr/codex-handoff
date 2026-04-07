from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import webbrowser
from pathlib import Path
from typing import Dict

from codex_handoff.config import config_dir


class R2CredentialSourceError(RuntimeError):
    """Raised when R2 credentials cannot be loaded from the requested source."""


def read_r2_credentials_from_env() -> Dict[str, str]:
    aliases = {
        "account_id": ["CODEX_HANDOFF_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID", "R2_ACCOUNT_ID"],
        "bucket": ["CODEX_HANDOFF_R2_BUCKET", "R2_BUCKET", "AWS_BUCKET", "BUCKET"],
        "access_key_id": ["CODEX_HANDOFF_R2_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
        "secret_access_key": ["CODEX_HANDOFF_R2_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"],
        "endpoint": ["CODEX_HANDOFF_R2_ENDPOINT", "R2_ENDPOINT", "AWS_ENDPOINT_URL_S3", "AWS_ENDPOINT_URL"],
    }
    payload: Dict[str, str] = {}
    missing = []
    for field, names in aliases.items():
        value = next((os.environ.get(name) for name in names if os.environ.get(name)), None)
        if value:
            payload[field] = value.strip()
        elif field != "endpoint":
            missing.append(field)
    if missing:
        raise R2CredentialSourceError(
            "Missing R2 credentials in environment. Expected account_id, bucket, access_key_id, secret_access_key."
        )
    if "endpoint" not in payload:
        payload["endpoint"] = f"https://{payload['account_id']}.r2.cloudflarestorage.com"
    return payload


def read_r2_credentials_from_clipboard() -> Dict[str, str]:
    text = _read_clipboard_text()
    payload = parse_r2_credentials(text)
    for field in ("account_id", "bucket", "access_key_id", "secret_access_key"):
        if not payload.get(field):
            raise R2CredentialSourceError(
                "Clipboard did not contain all required R2 fields. Expected account_id, bucket, access_key_id, secret_access_key."
            )
    if "endpoint" not in payload:
        payload["endpoint"] = f"https://{payload['account_id']}.r2.cloudflarestorage.com"
    return payload


def read_r2_credentials_from_dotenv(path: str) -> Dict[str, str]:
    dotenv_path = Path(path).expanduser().resolve()
    if not dotenv_path.exists():
        raise R2CredentialSourceError(f"Dotenv file not found: {dotenv_path}")
    return parse_r2_credentials(dotenv_path.read_text(encoding="utf-8"))


def parse_r2_credentials(text: str) -> Dict[str, str]:
    if text is None:
        raise R2CredentialSourceError("Clipboard could not be read.")
    stripped = text.strip()
    if not stripped:
        raise R2CredentialSourceError("Clipboard is empty.")

    try:
        payload = json.loads(stripped)
        if isinstance(payload, dict):
            return _normalize_fields({str(key): str(value) for key, value in payload.items() if value is not None})
    except json.JSONDecodeError:
        pass

    items: Dict[str, str] = {}
    for line in stripped.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"^([A-Za-z0-9_.-]+)\s*[:=]\s*(.+)$", line)
        if not match:
            continue
        key = match.group(1).strip()
        value = match.group(2).strip().strip("\"'")
        items[key] = value
    return _normalize_fields(items)


def _normalize_fields(items: Dict[str, str]) -> Dict[str, str]:
    normalized: Dict[str, str] = {}
    aliases = {
        "account_id": {"account_id", "account-id", "cloudflare_account_id", "r2_account_id", "CODEX_HANDOFF_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID", "R2_ACCOUNT_ID"},
        "bucket": {"bucket", "bucket_name", "bucket-name", "r2_bucket", "CODEX_HANDOFF_R2_BUCKET", "R2_BUCKET", "AWS_BUCKET"},
        "access_key_id": {"access_key_id", "access-key-id", "aws_access_key_id", "r2_access_key_id", "CODEX_HANDOFF_R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID"},
        "secret_access_key": {"secret_access_key", "secret-access-key", "aws_secret_access_key", "r2_secret_access_key", "CODEX_HANDOFF_R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY"},
        "endpoint": {"endpoint", "r2_endpoint", "aws_endpoint_url", "aws_endpoint_url_s3", "CODEX_HANDOFF_R2_ENDPOINT", "R2_ENDPOINT"},
    }
    for raw_key, value in items.items():
        canonical = None
        lowered = raw_key.lower()
        for field, names in aliases.items():
            lowered_names = {name.lower() for name in names}
            if lowered in lowered_names:
                canonical = field
                break
        if canonical:
            normalized[canonical] = value
    return normalized


def r2_dashboard_url() -> str:
    return "https://dash.cloudflare.com/?to=/:account/r2/overview"


def r2_credential_template() -> str:
    return "\n".join(
        [
            "# Cloudflare R2 credentials for codex-handoff",
            "account_id=",
            "bucket=",
            "access_key_id=",
            "secret_access_key=",
            "# endpoint=https://<account_id>.r2.cloudflarestorage.com",
        ]
    )


def default_global_dotenv_path() -> Path:
    return config_dir() / ".env.local"


def ensure_global_dotenv_template() -> Path:
    path = default_global_dotenv_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(r2_credential_template() + "\n", encoding="utf-8")
    return path


def open_r2_dashboard() -> bool:
    return webbrowser.open(r2_dashboard_url())


def _read_clipboard_text() -> str:
    system = platform.system()
    if system == "Windows":
        return _run_clipboard_command(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
                "$text = Get-Clipboard -Raw; "
                "if ($null -eq $text) { '' } else { $text }",
            ],
            encoding="utf-8",
        )
    if system == "Darwin":
        return _run_clipboard_command(["pbpaste"], encoding="utf-8")
    raise R2CredentialSourceError("Clipboard-based R2 auth is supported on Windows and macOS only.")


def _run_clipboard_command(command: list[str], *, encoding: str) -> str:
    result = subprocess.run(command, check=False, capture_output=True, text=True, encoding=encoding, errors="replace")
    if result.returncode != 0:
        raise R2CredentialSourceError(
            (result.stderr or "").strip() or (result.stdout or "").strip() or "Failed to read clipboard."
        )
    return result.stdout or ""
