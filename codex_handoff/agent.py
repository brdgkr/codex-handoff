from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from codex_handoff.config import agent_state_dir, log_dir
from codex_handoff.summarize import background_safe_summary_mode


def agent_state_path(repo_slug: str) -> Path:
    return agent_state_dir() / f"{repo_slug}.json"


def codex_handoff_entrypoint() -> Path:
    return Path(__file__).resolve().parent.parent / "run_codex_handoff.py"


def start_agent(
    *,
    repo: Path,
    repo_slug: str,
    profile_name: str,
    interval_seconds: float,
    summary_mode: str,
    include_raw_threads: bool,
    codex_home: Optional[str] = None,
    initial_sync: bool = False,
) -> dict:
    state_dir = agent_state_dir()
    state_dir.mkdir(parents=True, exist_ok=True)
    logs = log_dir()
    logs.mkdir(parents=True, exist_ok=True)
    summary_mode = background_safe_summary_mode(summary_mode)

    existing = read_agent_state(repo_slug)
    if existing and is_process_running(existing.get("pid")):
        if _agent_matches_request(
            existing,
            repo=repo,
            profile_name=profile_name,
            interval_seconds=interval_seconds,
            summary_mode=summary_mode,
            include_raw_threads=include_raw_threads,
            codex_home=codex_home,
            initial_sync=initial_sync,
        ):
            return {"already_running": True, **status_payload(repo_slug)}
        terminate_process(existing.get("pid"))

    log_path = logs / f"{repo_slug}.log"
    command = [
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
    ]
    if summary_mode:
        command.extend(["--summary-mode", summary_mode])
    if not include_raw_threads:
        command.append("--skip-raw-threads")
    if codex_home:
        command.extend(["--codex-home", codex_home])
    if not initial_sync:
        command.append("--no-initial-sync")

    with log_path.open("ab") as log_handle:
        process = spawn_background_process(command, log_handle)

    payload = {
        "repo": str(repo),
        "repo_slug": repo_slug,
        "profile": profile_name,
        "pid": process.pid,
        "interval_seconds": interval_seconds,
        "summary_mode": summary_mode,
        "include_raw_threads": include_raw_threads,
        "codex_home": codex_home,
        "initial_sync": initial_sync,
        "log_path": str(log_path),
        "started_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "command": command,
    }
    write_agent_state(repo_slug, payload)
    return {"already_running": False, **status_payload(repo_slug)}


def background_python_executable() -> str:
    if os.name == "nt":
        candidate = Path(sys.executable).with_name("pythonw.exe")
        if candidate.exists():
            return str(candidate)
    return sys.executable


def stop_agent(repo_slug: str) -> dict:
    payload = read_agent_state(repo_slug)
    if not payload:
        return {"running": False, "repo_slug": repo_slug, "stopped": False}
    pid = payload.get("pid")
    was_running = is_process_running(pid)
    if was_running:
        terminate_process(pid)
    return status_payload(repo_slug)


def restart_agent(
    *,
    repo: Path,
    repo_slug: str,
    profile_name: str,
    interval_seconds: float,
    summary_mode: str,
    include_raw_threads: bool,
    codex_home: Optional[str] = None,
    initial_sync: bool = False,
) -> dict:
    stop_agent(repo_slug)
    return start_agent(
        repo=repo,
        repo_slug=repo_slug,
        profile_name=profile_name,
        interval_seconds=interval_seconds,
        summary_mode=summary_mode,
        include_raw_threads=include_raw_threads,
        codex_home=codex_home,
        initial_sync=initial_sync,
    )


def status_payload(repo_slug: str) -> dict:
    payload = read_agent_state(repo_slug)
    if not payload:
        return {"repo_slug": repo_slug, "running": False, "configured": False}
    pid = payload.get("pid")
    running = is_process_running(pid)
    return {
        "repo_slug": repo_slug,
        "configured": True,
        "running": running,
        "pid": pid,
        "profile": payload.get("profile"),
        "repo": payload.get("repo"),
        "interval_seconds": payload.get("interval_seconds"),
        "summary_mode": payload.get("summary_mode"),
        "include_raw_threads": payload.get("include_raw_threads"),
        "codex_home": payload.get("codex_home"),
        "initial_sync": payload.get("initial_sync"),
        "log_path": payload.get("log_path"),
        "started_at": payload.get("started_at"),
        "command": payload.get("command"),
    }


def read_agent_state(repo_slug: str) -> Optional[dict]:
    path = agent_state_path(repo_slug)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_agent_state(repo_slug: str, payload: dict) -> None:
    path = agent_state_path(repo_slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def spawn_background_process(command: list[str], log_handle) -> subprocess.Popen:
    kwargs = {
        "stdout": log_handle,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        creationflags = 0
        creationflags |= getattr(subprocess, "DETACHED_PROCESS", 0)
        creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        creationflags |= getattr(subprocess, "CREATE_NO_WINDOW", 0)
        kwargs["creationflags"] = creationflags
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(command, **kwargs)


def is_process_running(pid: Optional[int]) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        result = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            check=False,
            capture_output=True,
            text=True,
        )
        output = result.stdout.strip()
        if not output or "No tasks are running" in output:
            return False
        for line in output.splitlines():
            line = line.strip()
            if not line:
                continue
            if line.startswith('"') and line.endswith('"'):
                parts = [part.strip('"') for part in line.split('","')]
                if len(parts) >= 2 and parts[1].isdigit() and int(parts[1]) == pid:
                    return True
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def terminate_process(pid: Optional[int]) -> None:
    if not isinstance(pid, int) or pid <= 0:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], check=False, capture_output=True, text=True)
        return
    try:
        os.kill(pid, 15)
    except OSError:
        return


def _agent_matches_request(
    existing: dict,
    *,
    repo: Path,
    profile_name: str,
    interval_seconds: float,
    summary_mode: str,
    include_raw_threads: bool,
    codex_home: Optional[str],
    initial_sync: bool,
) -> bool:
    return (
        existing.get("repo") == str(repo)
        and existing.get("profile") == profile_name
        and existing.get("interval_seconds") == interval_seconds
        and existing.get("summary_mode") == summary_mode
        and existing.get("include_raw_threads") == include_raw_threads
        and existing.get("codex_home") == codex_home
        and existing.get("initial_sync") == initial_sync
    )
