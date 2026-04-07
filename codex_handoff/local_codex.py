from __future__ import annotations

import json
import os
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional, Sequence

from codex_handoff.git_config import git_origin_url_from_repo


THREADS_TABLE_SQL = """CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    git_sha TEXT,
    git_branch TEXT,
    git_origin_url TEXT,
    cli_version TEXT NOT NULL DEFAULT '',
    first_user_message TEXT NOT NULL DEFAULT '',
    agent_nickname TEXT,
    agent_role TEXT,
    memory_mode TEXT NOT NULL DEFAULT 'enabled',
    model TEXT,
    reasoning_effort TEXT,
    agent_path TEXT
)"""

DEFAULT_SANDBOX_POLICY = json.dumps({"type": "danger-full-access"}, separators=(",", ":"))
DEFAULT_SOURCE = "vscode"
DEFAULT_MODEL_PROVIDER = "openai"
DEFAULT_MODEL = "gpt-5.4"
DEFAULT_REASONING_EFFORT = "xhigh"
DEFAULT_CLI_VERSION = "0.118.0-alpha.2"
DEFAULT_APPROVAL_MODE = "never"
DEFAULT_MEMORY_MODE = "enabled"


@dataclass
class CodexPaths:
    codex_home: Path
    sessions_root: Path
    session_index_path: Path
    state_db_path: Path


@dataclass
class ThreadTemplate:
    source: str = DEFAULT_SOURCE
    model_provider: str = DEFAULT_MODEL_PROVIDER
    sandbox_policy: str = DEFAULT_SANDBOX_POLICY
    approval_mode: str = DEFAULT_APPROVAL_MODE
    cli_version: str = DEFAULT_CLI_VERSION
    memory_mode: str = DEFAULT_MEMORY_MODE
    model: Optional[str] = DEFAULT_MODEL
    reasoning_effort: Optional[str] = DEFAULT_REASONING_EFFORT
    agent_nickname: Optional[str] = None
    agent_role: Optional[str] = None
    agent_path: Optional[str] = None
    git_sha: Optional[str] = None
    git_branch: Optional[str] = None
    git_origin_url: Optional[str] = None


@dataclass
class InjectResult:
    thread_id: str
    rollout_path: Path
    session_index_entry: dict
    thread_row: dict
    created: bool


@dataclass
class DiscoveredThread:
    thread_id: str
    title: str
    cwd: Path
    rollout_path: Path
    created_at: int
    updated_at: int
    row: dict
    session_index_entry: Optional[dict]


def codex_paths(codex_home: Optional[str] = None) -> CodexPaths:
    base = Path(codex_home or os.path.expanduser("~/.codex")).expanduser().resolve()
    return CodexPaths(
        codex_home=base,
        sessions_root=base / "sessions",
        session_index_path=base / "session_index.jsonl",
        state_db_path=base / "state_5.sqlite",
    )


def load_template(paths: CodexPaths) -> ThreadTemplate:
    if not paths.state_db_path.exists():
        return ThreadTemplate()

    conn = sqlite3.connect(paths.state_db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT * FROM threads ORDER BY updated_at DESC LIMIT 1").fetchone()
    finally:
        conn.close()
    if row is None:
        return ThreadTemplate()

    return ThreadTemplate(
        source=row["source"] or DEFAULT_SOURCE,
        model_provider=row["model_provider"] or DEFAULT_MODEL_PROVIDER,
        sandbox_policy=row["sandbox_policy"] or DEFAULT_SANDBOX_POLICY,
        approval_mode=row["approval_mode"] or DEFAULT_APPROVAL_MODE,
        cli_version=row["cli_version"] or DEFAULT_CLI_VERSION,
        memory_mode=row["memory_mode"] or DEFAULT_MEMORY_MODE,
        model=row["model"] or DEFAULT_MODEL,
        reasoning_effort=row["reasoning_effort"] or DEFAULT_REASONING_EFFORT,
        agent_nickname=row["agent_nickname"],
        agent_role=row["agent_role"],
        agent_path=row["agent_path"],
        git_sha=row["git_sha"],
        git_branch=row["git_branch"],
        git_origin_url=row["git_origin_url"],
    )


def normalize_cwd(value: str | Path) -> str:
    raw = strip_windows_prefix(str(value))
    try:
        normalized = str(Path(raw).expanduser().resolve())
    except OSError:
        normalized = os.path.normpath(raw)
    return os.path.normcase(normalized)


def repo_git_origin_url(repo: Path) -> Optional[str]:
    return git_origin_url_from_repo(repo)


def normalize_git_origin_url(value: str | None) -> Optional[str]:
    if not value:
        return None
    normalized = value.strip()
    if normalized.endswith(".git"):
        normalized = normalized[:-4]
    if "://" in normalized:
        normalized = normalized.split("://", 1)[1]
    elif "@" in normalized and ":" in normalized:
        user_host, path = normalized.split(":", 1)
        normalized = user_host.split("@", 1)[-1] + "/" + path
    normalized = normalized.replace("\\", "/").strip("/").lower()
    return normalized or None


def build_rollout_path(paths: CodexPaths, thread_id: str, timestamp: datetime) -> Path:
    date_dir = paths.sessions_root / timestamp.strftime("%Y") / timestamp.strftime("%m") / timestamp.strftime("%d")
    filename = f"rollout-{timestamp.strftime('%Y-%m-%dT%H-%M-%S')}-{thread_id}.jsonl"
    return date_dir / filename


def build_rollout_records(
    *,
    thread_id: str,
    turn_id: str,
    timestamp: datetime,
    cwd: Path,
    user_message: str,
    assistant_message: str,
    template: ThreadTemplate,
) -> list[dict]:
    base = timestamp
    return [
        {
            "timestamp": iso_utc(base),
            "type": "session_meta",
            "payload": {
                "id": thread_id,
                "timestamp": iso_utc(base),
                "cwd": str(cwd),
                "originator": "Codex Desktop",
                "cli_version": template.cli_version,
                "source": template.source,
                "model_provider": template.model_provider,
                "base_instructions": {
                    "text": "Synthetic test thread inserted by codex-handoff for materialization testing."
                },
            },
        },
        {
            "timestamp": iso_utc(base + timedelta(milliseconds=1)),
            "type": "event_msg",
            "payload": {
                "type": "task_started",
                "turn_id": turn_id,
                "model_context_window": 950000,
                "collaboration_mode_kind": "default",
            },
        },
        {
            "timestamp": iso_utc(base + timedelta(milliseconds=2)),
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": user_message}],
            },
        },
        {
            "timestamp": iso_utc(base + timedelta(milliseconds=3)),
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "message": user_message,
                "images": [],
                "local_images": [],
                "text_elements": [],
            },
        },
        {
            "timestamp": iso_utc(base + timedelta(milliseconds=4)),
            "type": "event_msg",
            "payload": {
                "type": "agent_message",
                "message": assistant_message,
                "phase": "final_answer",
                "memory_citation": None,
            },
        },
        {
            "timestamp": iso_utc(base + timedelta(milliseconds=5)),
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": assistant_message}],
                "phase": "final_answer",
            },
        },
        {
            "timestamp": iso_utc(base + timedelta(milliseconds=6)),
            "type": "event_msg",
            "payload": {
                "type": "task_complete",
                "turn_id": turn_id,
                "last_agent_message": assistant_message,
            },
        },
    ]


def build_thread_row(
    *,
    thread_id: str,
    rollout_path: Path,
    timestamp: datetime,
    cwd: Path,
    title: str,
    first_user_message: str,
    template: ThreadTemplate,
) -> dict:
    epoch = int(timestamp.timestamp())
    return {
        "id": thread_id,
        "rollout_path": db_rollout_path(rollout_path),
        "created_at": epoch,
        "updated_at": epoch,
        "source": template.source,
        "model_provider": template.model_provider,
        "cwd": db_cwd(cwd),
        "title": title,
        "sandbox_policy": template.sandbox_policy,
        "approval_mode": template.approval_mode,
        "tokens_used": 0,
        "has_user_event": 0,
        "archived": 0,
        "archived_at": None,
        "git_sha": template.git_sha,
        "git_branch": template.git_branch,
        "git_origin_url": template.git_origin_url,
        "cli_version": template.cli_version,
        "first_user_message": first_user_message,
        "agent_nickname": template.agent_nickname,
        "agent_role": template.agent_role,
        "memory_mode": template.memory_mode,
        "model": template.model,
        "reasoning_effort": template.reasoning_effort,
        "agent_path": template.agent_path,
    }


def write_rollout_file(path: Path, records: Sequence[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def read_rollout_records(path: Path) -> list[dict]:
    records: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                records.append(json.loads(line))
    return records


def upsert_session_index(path: Path, entry: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = []
    if path.exists():
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                payload = json.loads(line)
                if payload.get("id") == entry["id"]:
                    continue
                existing.append(payload)
    existing.append(entry)
    with path.open("w", encoding="utf-8") as handle:
        for payload in existing:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def read_session_index_map(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    items: dict[str, dict] = {}
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            payload = json.loads(line)
            thread_id = payload.get("id")
            if isinstance(thread_id, str):
                items[thread_id] = payload
    return items


def upsert_thread_row(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    try:
        conn.execute(THREADS_TABLE_SQL)
        columns = list(row.keys())
        placeholders = ", ".join("?" for _ in columns)
        sql = f"INSERT OR REPLACE INTO threads ({', '.join(columns)}) VALUES ({placeholders})"
        conn.execute(sql, [row[column] for column in columns])
        conn.commit()
    finally:
        conn.close()


def discover_threads_for_repo(repo: Path, codex_home: Optional[str] = None) -> list[DiscoveredThread]:
    paths = codex_paths(codex_home)
    if not paths.state_db_path.exists():
        return []

    index_map = read_session_index_map(paths.session_index_path)
    repo_key = normalize_cwd(repo)
    repo_origin = normalize_git_origin_url(repo_git_origin_url(repo))
    conn = sqlite3.connect(paths.state_db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT * FROM threads ORDER BY updated_at DESC").fetchall()
    finally:
        conn.close()

    matches: list[DiscoveredThread] = []
    for row in rows:
        row_payload = {key: row[key] for key in row.keys()}
        if not _thread_matches_repo(row_payload, repo_key, repo_origin):
            continue
        rollout_path = Path(strip_windows_prefix(row_payload["rollout_path"]))
        matches.append(
            DiscoveredThread(
                thread_id=row_payload["id"],
                title=row_payload["title"],
                cwd=Path(strip_windows_prefix(row_payload["cwd"])),
                rollout_path=rollout_path,
                created_at=int(row_payload["created_at"]),
                updated_at=int(row_payload["updated_at"]),
                row=row_payload,
                session_index_entry=index_map.get(row_payload["id"]),
            )
        )
    return matches


def _thread_matches_repo(row_payload: dict, repo_key: str, repo_origin: Optional[str]) -> bool:
    row_origin = normalize_git_origin_url(str(row_payload.get("git_origin_url") or ""))
    if repo_origin and row_origin:
        return row_origin == repo_origin
    return normalize_cwd(row_payload["cwd"]) == repo_key


def find_rollout_path(path: Path, thread_id: str) -> Optional[Path]:
    if not path.exists():
        return None
    conn = sqlite3.connect(path)
    try:
        row = conn.execute("SELECT rollout_path FROM threads WHERE id = ?", [thread_id]).fetchone()
    finally:
        conn.close()
    if row is None or row[0] is None:
        return None
    return Path(strip_windows_prefix(row[0]))


def thread_row_exists(path: Path, thread_id: str) -> bool:
    if not path.exists():
        return False
    conn = sqlite3.connect(path)
    try:
        row = conn.execute("SELECT 1 FROM threads WHERE id = ? LIMIT 1", [thread_id]).fetchone()
    finally:
        conn.close()
    return row is not None


def delete_thread_row(path: Path, thread_id: str) -> None:
    if not path.exists():
        return
    conn = sqlite3.connect(path, timeout=10)
    try:
        conn.execute("DELETE FROM threads WHERE id = ?", [thread_id])
        conn.commit()
    finally:
        conn.close()


def session_index_removal_count(path: Path, thread_id: str) -> int:
    if not path.exists():
        return 0
    count = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            payload = json.loads(line)
            if payload.get("id") == thread_id:
                count += 1
    return count


def rewrite_session_index_without(path: Path, thread_id: str) -> None:
    if not path.exists():
        return
    keep = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            payload = json.loads(line)
            if payload.get("id") == thread_id:
                continue
            keep.append(payload)
    with path.open("w", encoding="utf-8") as handle:
        for payload in keep:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def db_rollout_path(path: Path) -> str:
    resolved = str(path.resolve())
    if os.name == "nt" and not resolved.startswith("\\\\?\\"):
        return "\\\\?\\" + resolved
    return resolved


def db_cwd(path: Path) -> str:
    resolved = str(path.resolve())
    if os.name == "nt" and not resolved.startswith("\\\\?\\"):
        return "\\\\?\\" + resolved
    return resolved


def strip_windows_prefix(value: str) -> str:
    if value.startswith("\\\\?\\"):
        return value[4:]
    return value


def short_thread_name(title: str, limit: int = 80) -> str:
    short = " ".join(title.split())
    if len(short) <= limit:
        return short
    return short[: limit - 3].rstrip() + "..."


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def inject_thread(
    paths: CodexPaths,
    *,
    title: str,
    thread_name: Optional[str],
    user_message: str,
    assistant_message: str,
    cwd: str,
    thread_id: Optional[str] = None,
    apply: bool = False,
) -> InjectResult:
    now = datetime.now(timezone.utc)
    thread_id = thread_id or str(uuid.uuid4())
    turn_id = str(uuid.uuid4())
    display_name = thread_name or short_thread_name(title)
    template = load_template(paths)
    rollout_path = build_rollout_path(paths, thread_id, now)
    rollout_records = build_rollout_records(
        thread_id=thread_id,
        turn_id=turn_id,
        timestamp=now,
        cwd=Path(cwd).expanduser().resolve(),
        user_message=user_message,
        assistant_message=assistant_message,
        template=template,
    )

    index_entry = {
        "id": thread_id,
        "thread_name": display_name,
        "updated_at": iso_utc(now),
    }
    thread_row = build_thread_row(
        thread_id=thread_id,
        rollout_path=rollout_path,
        timestamp=now,
        cwd=Path(cwd).expanduser().resolve(),
        title=title,
        first_user_message=user_message,
        template=template,
    )

    if apply:
        write_rollout_file(rollout_path, rollout_records)
        upsert_session_index(paths.session_index_path, index_entry)
        upsert_thread_row(paths.state_db_path, thread_row)

    return InjectResult(
        thread_id=thread_id,
        rollout_path=rollout_path,
        session_index_entry=index_entry,
        thread_row=thread_row,
        created=apply,
    )


def cleanup_thread(paths: CodexPaths, thread_id: str, *, apply: bool = False) -> dict:
    rollout_path = find_rollout_path(paths.state_db_path, thread_id)
    session_index_removed = session_index_removal_count(paths.session_index_path, thread_id)
    thread_exists = thread_row_exists(paths.state_db_path, thread_id)
    rollout_exists = bool(rollout_path and rollout_path.exists())

    result = {
        "thread_id": thread_id,
        "thread_exists": thread_exists,
        "session_index_matches": session_index_removed,
        "rollout_path": str(rollout_path) if rollout_path else None,
        "rollout_exists": rollout_exists,
        "applied": apply,
    }

    if not apply:
        return result

    if rollout_path and rollout_path.exists():
        rollout_path.unlink()
    rewrite_session_index_without(paths.session_index_path, thread_id)
    delete_thread_row(paths.state_db_path, thread_id)
    result["rollout_exists"] = False
    result["thread_exists"] = False
    result["session_index_matches"] = 0
    return result
