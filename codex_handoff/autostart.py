from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

from codex_handoff.config import runtime_dir
from codex_handoff.summarize import background_safe_summary_mode


def task_name(repo_slug: str) -> str:
    return f"codex-handoff-{repo_slug}"


def codex_handoff_entrypoint() -> Path:
    return Path(__file__).resolve().parent.parent / "run_codex_handoff.py"


def command_script_path(repo_slug: str) -> Path:
    path = runtime_dir() / "autostart" / f"{repo_slug}.vbs"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def legacy_command_script_path(repo_slug: str) -> Path:
    path = runtime_dir() / "autostart" / f"{repo_slug}.cmd"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def startup_folder_path() -> Path:
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    return Path.home() / "AppData" / "Roaming" / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def startup_script_path(repo_slug: str) -> Path:
    path = startup_folder_path() / f"{repo_slug}.vbs"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def legacy_startup_script_path(repo_slug: str) -> Path:
    path = startup_folder_path() / f"{repo_slug}.cmd"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def write_autostart_script(
    *,
    repo: Path,
    repo_slug: str,
    profile_name: str,
    interval_seconds: float,
    summary_mode: str,
    include_raw_threads: bool,
    codex_home: Optional[str] = None,
) -> Path:
    script_path = command_script_path(repo_slug)
    summary_mode = background_safe_summary_mode(summary_mode)
    args = [
        background_python_executable(),
        str(codex_handoff_entrypoint()),
        "--repo",
        str(repo),
        "sync",
        "watch",
        "--profile",
        profile_name,
        "--interval",
        str(interval_seconds),
        "--summary-mode",
        summary_mode,
        "--no-initial-sync",
    ]
    if not include_raw_threads:
        args.append("--skip-raw-threads")
    if codex_home:
        args.extend(["--codex-home", codex_home])

    command = subprocess.list2cmdline(args)
    body = "\r\n".join(
        [
            'Dim shell',
            'Set shell = CreateObject("WScript.Shell")',
            f'shell.Run "{_vbscript_escape(command)}", 0, False',
        ]
    ) + "\r\n"
    script_path.write_text(body, encoding="utf-8")
    return script_path


def enable_autostart(
    *,
    repo: Path,
    repo_slug: str,
    profile_name: str,
    interval_seconds: float,
    summary_mode: str,
    include_raw_threads: bool,
    codex_home: Optional[str] = None,
) -> dict:
    if os.name != "nt":
        raise RuntimeError("Autostart registration is currently implemented for Windows only.")

    legacy_script_path = legacy_command_script_path(repo_slug)
    if legacy_script_path.exists():
        legacy_script_path.unlink()
    script_path = write_autostart_script(
        repo=repo,
        repo_slug=repo_slug,
        profile_name=profile_name,
        interval_seconds=interval_seconds,
        summary_mode=summary_mode,
        include_raw_threads=include_raw_threads,
        codex_home=codex_home,
    )
    name = task_name(repo_slug)
    result = subprocess.run(
        [
            "schtasks",
            "/Create",
            "/SC",
            "ONLOGON",
            "/RL",
            "LIMITED",
            "/TN",
            name,
            "/TR",
            f'wscript.exe //B //NoLogo "{script_path}"',
            "/F",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        startup_path = startup_script_path(repo_slug)
        if startup_path.exists():
            startup_path.unlink()
        legacy_startup_path = legacy_startup_script_path(repo_slug)
        if legacy_startup_path.exists():
            legacy_startup_path.unlink()
        return {"task_name": name, "script_path": str(script_path), "enabled": True, "method": "task-scheduler"}

    startup_path = startup_script_path(repo_slug)
    legacy_startup_path = legacy_startup_script_path(repo_slug)
    if legacy_startup_path.exists():
        legacy_startup_path.unlink()
    startup_path.write_text(script_path.read_text(encoding="utf-8"), encoding="utf-8")
    return {
        "task_name": name,
        "script_path": str(script_path),
        "startup_path": str(startup_path),
        "enabled": True,
        "method": "startup-folder",
        "scheduler_error": result.stderr.strip() or result.stdout.strip() or "Failed to create scheduled task.",
    }


def disable_autostart(repo_slug: str) -> dict:
    if os.name != "nt":
        raise RuntimeError("Autostart registration is currently implemented for Windows only.")
    name = task_name(repo_slug)
    result = subprocess.run(
        ["schtasks", "/Delete", "/TN", name, "/F"],
        check=False,
        capture_output=True,
        text=True,
    )
    script_path = command_script_path(repo_slug)
    if script_path.exists():
        script_path.unlink()
    legacy_cmd = legacy_command_script_path(repo_slug)
    if legacy_cmd.exists():
        legacy_cmd.unlink()
    startup_path = startup_script_path(repo_slug)
    if startup_path.exists():
        startup_path.unlink()
    legacy_startup_cmd = legacy_startup_script_path(repo_slug)
    if legacy_startup_cmd.exists():
        legacy_startup_cmd.unlink()
    return {
        "task_name": name,
        "enabled": False,
        "deleted": result.returncode == 0,
        "startup_deleted": not startup_path.exists(),
    }


def autostart_status(repo_slug: str) -> dict:
    if os.name != "nt":
        return {"task_name": task_name(repo_slug), "enabled": False, "platform_supported": False}
    name = task_name(repo_slug)
    result = subprocess.run(
        ["schtasks", "/Query", "/TN", name],
        check=False,
        capture_output=True,
        text=True,
    )
    startup_path = startup_script_path(repo_slug)
    legacy_startup_path = legacy_startup_script_path(repo_slug)
    script_path = command_script_path(repo_slug)
    legacy_script_path = legacy_command_script_path(repo_slug)
    startup_exists = startup_path.exists() or legacy_startup_path.exists()
    method = "task-scheduler" if result.returncode == 0 else ("startup-folder" if startup_exists else None)
    return {
        "task_name": name,
        "enabled": result.returncode == 0 or startup_exists,
        "method": method,
        "script_path": str(script_path if script_path.exists() or not legacy_script_path.exists() else legacy_script_path),
        "startup_path": str(startup_path if startup_path.exists() or not legacy_startup_path.exists() else legacy_startup_path),
        "platform_supported": True,
    }


def background_python_executable() -> str:
    if os.name == "nt":
        candidate = Path(sys.executable).with_name("pythonw.exe")
        if candidate.exists():
            return str(candidate)
    return sys.executable


def _vbscript_escape(value: str) -> str:
    return value.replace('"', '""')
