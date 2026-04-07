from __future__ import annotations

import base64
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path
from typing import Dict

from codex_handoff.config import config_dir


SECRET_ENV_VAR = "CODEX_HANDOFF_SECRET_BACKEND"
TEST_SECRET_BACKEND = "plaintext-file"


class SecretStoreError(RuntimeError):
    """Raised when a secret backend operation fails."""


def recommended_secret_backend() -> str:
    override = os.environ.get(SECRET_ENV_VAR)
    if override:
        return override
    system = platform.system()
    if system == "Darwin":
        return "macos-keychain"
    if system == "Windows":
        return "windows-dpapi"
    raise SecretStoreError("Unsupported OS for secure secret storage. Expected macOS or Windows.")


def store_secret(profile_name: str, secret: str) -> Dict[str, str]:
    backend = recommended_secret_backend()
    if backend == "macos-keychain":
        service = f"codex-handoff:r2:{profile_name}"
        _run(
            [
                "security",
                "add-generic-password",
                "-a",
                profile_name,
                "-s",
                service,
                "-w",
                secret,
                "-U",
            ]
        )
        return {"secret_backend": backend, "secret_ref": service}
    if backend == "windows-dpapi":
        secret_path = _windows_secret_path(profile_name)
        protected = _windows_protect(secret)
        secret_path.parent.mkdir(parents=True, exist_ok=True)
        secret_path.write_text(protected + "\n", encoding="utf-8")
        return {"secret_backend": backend, "secret_ref": str(secret_path)}
    if backend == TEST_SECRET_BACKEND:
        secret_path = _test_secret_path(profile_name)
        secret_path.parent.mkdir(parents=True, exist_ok=True)
        secret_path.write_text(secret, encoding="utf-8")
        return {"secret_backend": backend, "secret_ref": str(secret_path)}
    raise SecretStoreError(f"Unsupported secret backend: {backend}")


def read_secret(secret_backend: str, secret_ref: str, profile_name: str) -> str:
    if secret_backend == "macos-keychain":
        return _run(
            [
                "security",
                "find-generic-password",
                "-a",
                profile_name,
                "-s",
                secret_ref,
                "-w",
            ]
        ).strip()
    if secret_backend == "windows-dpapi":
        return _windows_unprotect(Path(secret_ref))
    if secret_backend == TEST_SECRET_BACKEND:
        return Path(secret_ref).read_text(encoding="utf-8")
    raise SecretStoreError(f"Unsupported secret backend: {secret_backend}")


def delete_secret(secret_backend: str, secret_ref: str, profile_name: str) -> None:
    if secret_backend == "macos-keychain":
        _run(
            [
                "security",
                "delete-generic-password",
                "-a",
                profile_name,
                "-s",
                secret_ref,
            ]
        )
        return
    if secret_backend in {"windows-dpapi", TEST_SECRET_BACKEND}:
        path = Path(secret_ref)
        if path.exists():
            path.unlink()
        return
    raise SecretStoreError(f"Unsupported secret backend: {secret_backend}")


def _run(command: list[str]) -> str:
    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SecretStoreError(result.stderr.strip() or result.stdout.strip() or "secret store command failed")
    return result.stdout


def _windows_secret_path(profile_name: str) -> Path:
    safe_profile = profile_name.replace("/", "_")
    return config_dir() / "secrets" / f"{safe_profile}.dpapi"


def _test_secret_path(profile_name: str) -> Path:
    safe_profile = profile_name.replace("/", "_")
    return config_dir() / "secrets" / f"{safe_profile}.txt"


def _powershell_executable() -> str:
    shell = shutil.which("powershell") or shutil.which("pwsh")
    if not shell:
        raise SecretStoreError("PowerShell is required for Windows DPAPI support.")
    return shell


def _powershell(script: str) -> str:
    result = subprocess.run(
        [_powershell_executable(), "-NoProfile", "-Command", script],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SecretStoreError(result.stderr.strip() or result.stdout.strip() or "PowerShell command failed")
    return result.stdout.strip()


def _windows_protect(secret: str) -> str:
    encoded = base64.b64encode(secret.encode("utf-8")).decode("ascii")
    script = (
        "$plain = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("
        + json.dumps(encoded)
        + "));"
        "$secure = ConvertTo-SecureString $plain -AsPlainText -Force;"
        "ConvertFrom-SecureString $secure"
    )
    return _powershell(script)


def _windows_unprotect(path: Path) -> str:
    encoded = path.read_text(encoding="utf-8").strip()
    script = (
        "$secure = ConvertTo-SecureString "
        + json.dumps(encoded)
        + ";"
        "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);"
        "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } "
        "finally { if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) } }"
    )
    return _powershell(script)
