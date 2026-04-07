from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from codex_handoff.codex_projects import describe_current_project
from codex_handoff.git_config import git_origin_url_from_repo

MANAGED_BLOCK_START = "<!-- codex-handoff:start -->"
MANAGED_BLOCK_END = "<!-- codex-handoff:end -->"
REPO_STATE_FILENAME = "repo.json"
THREAD_INDEX_FILENAME = "thread-index.json"
CURRENT_THREAD_FILENAME = "current-thread.json"
SYNC_STATE_FILENAME = "sync-state.json"
GITIGNORE_FILENAME = ".gitignore"


def repo_state_path(memory_dir: Path) -> Path:
    return memory_dir / REPO_STATE_FILENAME


def thread_index_path(memory_dir: Path) -> Path:
    return memory_dir / THREAD_INDEX_FILENAME


def current_thread_path(memory_dir: Path) -> Path:
    return memory_dir / CURRENT_THREAD_FILENAME


def sync_state_path(memory_dir: Path) -> Path:
    return memory_dir / SYNC_STATE_FILENAME


def load_repo_state(memory_dir: Path) -> Dict[str, Any]:
    path = repo_state_path(memory_dir)
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def save_repo_state(memory_dir: Path, payload: Dict[str, Any]) -> Path:
    ensure_memory_layout(memory_dir)
    path = repo_state_path(memory_dir)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def load_sync_state(memory_dir: Path) -> Dict[str, Any]:
    path = sync_state_path(memory_dir)
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def save_sync_state(memory_dir: Path, payload: Dict[str, Any]) -> Path:
    ensure_memory_layout(memory_dir)
    path = sync_state_path(memory_dir)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def ensure_memory_layout(memory_dir: Path) -> None:
    memory_dir.mkdir(parents=True, exist_ok=True)
    (memory_dir / "raw").mkdir(parents=True, exist_ok=True)
    (memory_dir / "threads").mkdir(parents=True, exist_ok=True)


def infer_repo_slug(repo: Path) -> str:
    origin = git_origin_url(repo)
    if origin:
        parsed = _slug_from_origin(origin)
        if parsed:
            return parsed
    return slugify(repo.name)


def git_origin_url(repo: Path) -> Optional[str]:
    return git_origin_url_from_repo(repo)


def build_repo_state(
    repo: Path,
    *,
    profile_name: str,
    machine_id: str,
    codex_project: Optional[Dict[str, Any]] = None,
    remote_slug: Optional[str] = None,
    include_raw_threads: bool = True,
    summary_mode: str = "auto",
    match_mode: str = "auto",
    match_status: str = "create_new",
) -> Dict[str, Any]:
    slug = remote_slug or infer_repo_slug(repo)
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    origin = git_origin_url(repo)
    project_info = codex_project or describe_current_project(repo)
    return {
        "schema_version": "1.0",
        "machine_id": machine_id,
        "project_name": project_info.get("project_name", repo.name),
        "workspace_root": project_info.get("workspace_root", str(repo)),
        "codex_project": project_info,
        "repo_path": str(repo),
        "repo_slug": slug,
        "remote_profile": profile_name,
        "remote_prefix": f"repos/{slug}/",
        "include_raw_threads": include_raw_threads,
        "summary_mode": summary_mode,
        "match_mode": match_mode,
        "match_status": match_status,
        "git_origin_url": origin,
        "updated_at": now,
    }


def register_repo_mapping(config_payload: Dict[str, Any], repo: Path, repo_state: Dict[str, Any]) -> Dict[str, Any]:
    repos = config_payload.setdefault("repos", {})
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    repos[str(repo)] = {
        "machine_id": repo_state["machine_id"],
        "project_name": repo_state.get("project_name", ""),
        "workspace_root": repo_state.get("workspace_root", ""),
        "repo_slug": repo_state["repo_slug"],
        "remote_profile": repo_state["remote_profile"],
        "remote_prefix": repo_state["remote_prefix"],
        "summary_mode": repo_state["summary_mode"],
        "include_raw_threads": repo_state["include_raw_threads"],
        "match_mode": repo_state["match_mode"],
        "match_status": repo_state["match_status"],
        "updated_at": now,
    }
    return config_payload


def ensure_agents_block(repo: Path, repo_state: Dict[str, Any]) -> Path:
    path = repo / "AGENTS.md"
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    block = render_agents_block(repo_state)
    if MANAGED_BLOCK_START in existing and MANAGED_BLOCK_END in existing:
        updated = re.sub(
            rf"{re.escape(MANAGED_BLOCK_START)}[\s\S]*?{re.escape(MANAGED_BLOCK_END)}",
            lambda _: block,
            existing,
            count=1,
        )
    elif existing.strip():
        updated = existing.rstrip() + "\n\n" + block + "\n"
    else:
        updated = block + "\n"
    path.write_text(updated, encoding="utf-8")
    return path


def ensure_memory_dir_gitignored(repo: Path, memory_dir: Path) -> Optional[Path]:
    try:
        relative = memory_dir.resolve().relative_to(repo.resolve())
    except ValueError:
        return None
    entry = relative.as_posix().rstrip("/") + "/"
    if entry == "/":
        return None

    path = repo / GITIGNORE_FILENAME
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    existing_entries = {line.strip() for line in existing.splitlines()}
    if entry in existing_entries:
        return path

    if existing and not existing.endswith(("\n", "\r")):
        updated = existing + "\n" + entry + "\n"
    elif existing:
        updated = existing + entry + "\n"
    else:
        updated = entry + "\n"
    path.write_text(updated, encoding="utf-8")
    return path


def render_agents_block(repo_state: Dict[str, Any]) -> str:
    lines = [
        MANAGED_BLOCK_START,
        "## Codex Handoff Sync",
        "",
        "This repository is attached to codex-handoff sync.",
        f"- local project name: `{repo_state.get('project_name', '')}`",
        f"- local workspace root: `{repo_state.get('workspace_root', '')}`",
        f"- remote profile: `{repo_state['remote_profile']}`",
        f"- remote repo slug: `{repo_state['repo_slug']}`",
        f"- remote prefix: `{repo_state['remote_prefix']}`",
        f"- summary mode: `{repo_state['summary_mode']}`",
        f"- include raw threads: `{str(repo_state['include_raw_threads']).lower()}`",
        f"- match status: `{repo_state['match_status']}`",
        f"- installed skill path: `{repo_state.get('installed_skill_path', '')}`",
        "",
        "Before doing substantive work in this repository:",
        "0. If the local `codex-handoff` skill is installed, use it for sync, pull, import, and resume orchestration.",
        "1. Read `.codex-handoff/latest.md` first if it exists.",
        "2. If the user asks to continue previous work, run `codex-handoff --repo . resume --goal \"<user-goal>\"`.",
        "3. If the bootstrap summary is insufficient, inspect `.codex-handoff/handoff.json`.",
        "4. Never load raw session jsonl files wholesale. Use `codex-handoff --repo . search`, `codex-handoff --repo . extract`, or `codex-handoff --repo . context-pack` to retrieve only relevant evidence.",
        MANAGED_BLOCK_END,
    ]
    return "\n".join(lines)


def materialized_root_paths(memory_dir: Path) -> dict[str, Path]:
    return {
        "latest": memory_dir / "latest.md",
        "handoff": memory_dir / "handoff.json",
        "raw_dir": memory_dir / "raw",
        "raw_session": memory_dir / "raw" / "session.jsonl",
    }


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-._").lower()
    return slug or "repo"


def _slug_from_origin(origin: str) -> Optional[str]:
    normalized = origin.strip()
    if normalized.endswith(".git"):
        normalized = normalized[:-4]
    if "://" in normalized:
        parts = normalized.split("://", 1)[1].split("/")
    elif ":" in normalized and "@" in normalized:
        parts = normalized.split(":", 1)[1].split("/")
    else:
        parts = normalized.split("/")
    if len(parts) < 2:
        return None
    owner = slugify(parts[-2])
    repo = slugify(parts[-1])
    return f"{owner}-{repo}" if owner else repo
