from __future__ import annotations

import gzip
import json
import time
from datetime import datetime, timezone
from itertools import chain
from pathlib import Path
from typing import Any, Iterable, Optional

from codex_handoff.local_codex import (
    CodexPaths,
    DiscoveredThread,
    codex_paths,
    db_cwd,
    db_rollout_path,
    discover_threads_for_repo,
    normalize_git_origin_url,
    read_rollout_records,
    repo_git_origin_url,
    strip_windows_prefix,
    upsert_session_index,
    upsert_thread_row,
    write_rollout_file,
)
from codex_handoff.r2 import R2Profile, get_r2_object, list_r2_objects, put_r2_object
from codex_handoff.summarize import summarize_rollout
from codex_handoff.workspace import (
    current_thread_path,
    ensure_memory_layout,
    load_repo_state,
    load_sync_state,
    materialized_root_paths,
    save_sync_state,
    sync_state_path,
    thread_index_path,
)


class ThreadImportMismatchError(Exception):
    pass


def export_repo_threads(
    repo: Path,
    memory_dir: Path,
    *,
    codex_home: Optional[str] = None,
    summary_mode: str = "auto",
    include_raw_threads: bool = True,
) -> list[DiscoveredThread]:
    ensure_memory_layout(memory_dir)
    threads = discover_threads_for_repo(repo, codex_home)
    index_payload = []
    for thread in threads:
        export_thread_bundle(
            repo,
            memory_dir,
            thread,
            summary_mode=summary_mode,
            include_raw_threads=include_raw_threads,
        )
        index_payload.append(
            {
                "thread_id": thread.thread_id,
                "title": thread.title,
                "updated_at": thread.updated_at,
                "rollout_path": str(thread.rollout_path),
            }
        )

    thread_index_path(memory_dir).write_text(
        json.dumps(index_payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    if threads:
        current_thread_path(memory_dir).write_text(
            json.dumps({"thread_id": threads[0].thread_id}, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        materialize_root_from_thread(memory_dir, threads[0].thread_id)
    else:
        clear_materialized_root(memory_dir)
    return threads


def export_thread_bundle(
    repo: Path,
    memory_dir: Path,
    thread: DiscoveredThread,
    *,
    summary_mode: str = "auto",
    include_raw_threads: bool = True,
) -> Path:
    bundle_dir = memory_dir / "threads" / thread.thread_id
    raw_dir = bundle_dir / "raw"
    source_dir = bundle_dir / "source"
    raw_dir.mkdir(parents=True, exist_ok=True)
    source_dir.mkdir(parents=True, exist_ok=True)

    rollout_records = read_rollout_records(thread.rollout_path)
    summary = summarize_rollout(repo, thread, rollout_records, summary_mode=summary_mode)

    manifest = build_thread_manifest(repo, thread)
    (bundle_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (bundle_dir / "latest.md").write_text(summary.latest_md, encoding="utf-8")
    (bundle_dir / "handoff.json").write_text(
        json.dumps(summary.handoff_json, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    with (raw_dir / "session.jsonl").open("w", encoding="utf-8") as handle:
        for record in summary.raw_records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    if thread.session_index_entry is not None:
        (source_dir / "index-entry.json").write_text(
            json.dumps(thread.session_index_entry, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    (source_dir / "thread-record.json").write_text(
        json.dumps(thread.row, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    if include_raw_threads:
        with thread.rollout_path.open("rb") as source_handle:
            payload = source_handle.read()
        with gzip.open(source_dir / "rollout.jsonl.gz", "wb") as handle:
            handle.write(payload)
    return bundle_dir


def build_thread_manifest(repo: Path, thread: DiscoveredThread) -> dict[str, object]:
    source_relpath = _relative_session_path(thread.rollout_path)
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    return {
        "schema_version": "1.0",
        "thread_id": thread.thread_id,
        "thread_title": thread.title,
        "thread_name": (thread.session_index_entry or {}).get("thread_name"),
        "cwd": str(repo),
        "original_cwd": str(thread.cwd),
        "rollout_path": str(thread.rollout_path),
        "source_session_relpath": source_relpath,
        "updated_at": thread.updated_at,
        "created_at": thread.created_at,
        "exported_at": now,
        "source": thread.row.get("source"),
        "model_provider": thread.row.get("model_provider"),
        "model": thread.row.get("model"),
        "reasoning_effort": thread.row.get("reasoning_effort"),
    }


def materialize_root_from_thread(memory_dir: Path, thread_id: str) -> None:
    bundle_dir = memory_dir / "threads" / thread_id
    latest_src = bundle_dir / "latest.md"
    handoff_src = bundle_dir / "handoff.json"
    raw_src = bundle_dir / "raw" / "session.jsonl"
    if not latest_src.exists() or not handoff_src.exists():
        raise FileNotFoundError(f"Thread bundle is incomplete: {bundle_dir}")

    roots = materialized_root_paths(memory_dir)
    roots["raw_dir"].mkdir(parents=True, exist_ok=True)
    roots["latest"].write_text(latest_src.read_text(encoding="utf-8"), encoding="utf-8")
    roots["handoff"].write_text(handoff_src.read_text(encoding="utf-8"), encoding="utf-8")
    if raw_src.exists():
        roots["raw_session"].write_text(raw_src.read_text(encoding="utf-8"), encoding="utf-8")

    current_thread_path(memory_dir).write_text(
        json.dumps({"thread_id": thread_id}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def clear_materialized_root(memory_dir: Path) -> None:
    roots = materialized_root_paths(memory_dir)
    for path in [roots["latest"], roots["handoff"], roots["raw_session"], current_thread_path(memory_dir)]:
        if path.exists():
            path.unlink()
    _remove_empty_dirs(chain([roots["raw_dir"]], sorted(memory_dir.rglob("*"), reverse=True)))


def import_thread_bundle_to_codex(
    repo: Path,
    memory_dir: Path,
    thread_id: str,
    *,
    codex_home: Optional[str] = None,
) -> dict[str, str]:
    bundle_dir = memory_dir / "threads" / thread_id
    manifest = json.loads((bundle_dir / "manifest.json").read_text(encoding="utf-8"))
    source_dir = bundle_dir / "source"
    paths = codex_paths(codex_home)

    if (source_dir / "rollout.jsonl.gz").exists():
        rollout_path = paths.codex_home / manifest["source_session_relpath"]
        rollout_path.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(source_dir / "rollout.jsonl.gz", "rb") as handle:
            payload = handle.read()
        rollout_path.write_bytes(payload)
    else:
        rollout_path = paths.sessions_root / "missing-rollout.jsonl"

    if (source_dir / "index-entry.json").exists():
        entry = json.loads((source_dir / "index-entry.json").read_text(encoding="utf-8"))
        upsert_session_index(paths.session_index_path, entry)

    thread_row = json.loads((source_dir / "thread-record.json").read_text(encoding="utf-8"))
    target_origin = normalize_git_origin_url(repo_git_origin_url(repo))
    source_origin = normalize_git_origin_url(str(thread_row.get("git_origin_url") or ""))
    if target_origin and source_origin and target_origin != source_origin:
        raise ThreadImportMismatchError(
            f"Thread {thread_id} belongs to {thread_row.get('git_origin_url')} and cannot be imported into {repo}."
        )
    thread_row["cwd"] = db_cwd(repo)
    thread_row["rollout_path"] = db_rollout_path(rollout_path)
    upsert_thread_row(paths.state_db_path, thread_row)
    materialize_root_from_thread(memory_dir, thread_id)
    return {
        "thread_id": thread_id,
        "rollout_path": str(rollout_path),
        "cwd": str(repo),
    }


def push_memory_tree(profile: R2Profile, memory_dir: Path, prefix: str) -> list[str]:
    uploaded = []
    for path in iter_memory_files(memory_dir):
        relpath = path.relative_to(memory_dir).as_posix()
        key = prefix.rstrip("/") + "/" + relpath
        put_r2_object(profile, key, path.read_bytes())
        uploaded.append(key)
    return uploaded


def pull_memory_tree(profile: R2Profile, memory_dir: Path, prefix: str) -> list[Path]:
    downloaded: list[Path] = []
    remote_paths: set[Path] = set()
    for item in list_r2_objects(profile, prefix=prefix.rstrip("/") + "/"):
        key = item["key"]
        relpath = key[len(prefix.rstrip("/") + "/") :]
        local_path = memory_dir / Path(relpath)
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(get_r2_object(profile, key))
        downloaded.append(local_path)
        remote_paths.add(local_path.resolve())
    for path in sorted(memory_dir.rglob("*"), reverse=True):
        relpath = path.relative_to(memory_dir).as_posix() if path.is_file() else None
        if path.is_file() and path.resolve() not in remote_paths and not _should_preserve_local_relpath(relpath or ""):
            path.unlink()
    _remove_empty_dirs(sorted(memory_dir.rglob("*"), reverse=True))
    return downloaded


def sync_now(
    repo: Path,
    memory_dir: Path,
    profile: R2Profile,
    *,
    codex_home: Optional[str] = None,
    summary_mode: str = "auto",
    include_raw_threads: bool = True,
    prefix: str,
) -> dict[str, object]:
    threads = export_repo_threads(
        repo,
        memory_dir,
        codex_home=codex_home,
        summary_mode=summary_mode,
        include_raw_threads=include_raw_threads,
    )
    uploaded = push_memory_tree(profile, memory_dir, prefix)
    thread_ids = [thread.thread_id for thread in threads]
    current_thread = thread_ids[0] if thread_ids else None
    sync_state = record_sync_event(
        memory_dir,
        repo=repo,
        prefix=prefix,
        direction="push",
        command="now",
        thread_ids=thread_ids,
        current_thread=current_thread,
        threads_exported=len(threads),
        objects_uploaded=len(uploaded),
    )
    repo_state = load_repo_state(memory_dir)
    return {
        "repo": str(repo),
        "repo_slug": repo_state.get("repo_slug"),
        "remote_profile": repo_state.get("remote_profile"),
        "remote_prefix": prefix,
        "prefix": prefix,
        "threads_exported": len(threads),
        "thread_count": len(thread_ids),
        "thread_ids": thread_ids,
        "current_thread": current_thread,
        "objects_uploaded": len(uploaded),
        "sync_state_path": str(sync_state_path(memory_dir)),
        "sync_state": sync_state,
        "sync_health": build_sync_health(memory_dir, sync_state),
    }


def watch_and_sync(
    repo: Path,
    memory_dir: Path,
    profile: R2Profile,
    *,
    codex_home: Optional[str] = None,
    summary_mode: str = "auto",
    include_raw_threads: bool = True,
    prefix: str,
    interval_seconds: float = 15.0,
    initial_sync: bool = True,
) -> None:
    previous_signature = None
    if initial_sync:
        sync_now(
            repo,
            memory_dir,
            profile,
            codex_home=codex_home,
            summary_mode=summary_mode,
            include_raw_threads=include_raw_threads,
            prefix=prefix,
        )
        previous_signature = compute_watch_signature(repo, codex_home)

    while True:
        current_signature = compute_watch_signature(repo, codex_home)
        if previous_signature is None:
            previous_signature = current_signature
        elif current_signature != previous_signature:
            sync_now(
                repo,
                memory_dir,
                profile,
                codex_home=codex_home,
                summary_mode=summary_mode,
                include_raw_threads=include_raw_threads,
                prefix=prefix,
            )
            previous_signature = compute_watch_signature(repo, codex_home)
        time.sleep(interval_seconds)


def iter_memory_files(memory_dir: Path) -> Iterable[Path]:
    thread_ids = _indexed_thread_ids(memory_dir)
    current_thread_id = _current_thread_id(memory_dir)
    for path in sorted(memory_dir.rglob("*")):
        if path.is_file():
            relpath = path.relative_to(memory_dir).as_posix()
            if _should_sync_relpath(relpath, thread_ids, current_thread_id):
                yield path


def compute_watch_signature(repo: Path, codex_home: Optional[str]) -> tuple[tuple[str, int, int], ...]:
    paths = codex_paths(codex_home)
    watched: list[Path] = []
    if paths.session_index_path.exists():
        watched.append(paths.session_index_path)
    if paths.state_db_path.exists():
        watched.append(paths.state_db_path)
    for thread in discover_threads_for_repo(repo, codex_home):
        if thread.rollout_path.exists():
            watched.append(thread.rollout_path)

    signature = []
    for path in sorted({item.resolve() for item in watched}):
        stat = path.stat()
        signature.append((str(path), stat.st_mtime_ns, stat.st_size))
    return tuple(signature)


def describe_sync_state(memory_dir: Path) -> dict[str, object]:
    sync_state = load_sync_state(memory_dir)
    return {
        "sync_state_path": str(sync_state_path(memory_dir)),
        "sync_state": sync_state or None,
        "sync_health": build_sync_health(memory_dir, sync_state),
    }


def build_sync_health(memory_dir: Path, sync_state: Optional[dict[str, Any]] = None) -> dict[str, object]:
    state = sync_state if sync_state is not None else load_sync_state(memory_dir)
    thread_ids = sorted(_indexed_thread_ids(memory_dir))
    current_thread = _current_thread_id(memory_dir)
    materialized_root = _materialized_root_status(memory_dir)
    status = "never_synced"
    if state.get("last_sync_at"):
        status = "ok"
        if thread_ids and not current_thread:
            status = "current_thread_missing"
        elif current_thread and current_thread not in thread_ids:
            status = "current_thread_missing"
        elif current_thread and not all(materialized_root.values()):
            status = "materialized_root_incomplete"
    return {
        "status": status,
        "last_sync_at": state.get("last_sync_at"),
        "last_sync_direction": state.get("last_sync_direction"),
        "last_sync_command": state.get("last_sync_command"),
        "current_thread": current_thread,
        "thread_count": len(thread_ids),
        "thread_ids": thread_ids,
        "materialized_root": materialized_root,
    }


def record_sync_event(
    memory_dir: Path,
    *,
    repo: Optional[Path],
    prefix: str,
    direction: str,
    command: str,
    thread_ids: Optional[list[str]] = None,
    current_thread: Optional[str] = None,
    threads_exported: Optional[int] = None,
    objects_uploaded: Optional[int] = None,
    downloaded_objects: Optional[int] = None,
    imported_thread: Optional[dict[str, object]] = None,
) -> dict[str, object]:
    existing = load_sync_state(memory_dir)
    repo_state = load_repo_state(memory_dir)
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    normalized_thread_ids = sorted(thread_ids) if thread_ids is not None else sorted(_indexed_thread_ids(memory_dir))
    resolved_current_thread = current_thread if current_thread is not None else _current_thread_id(memory_dir)
    materialized_root = _materialized_root_status(memory_dir)

    event: dict[str, object] = {
        "at": now,
        "command": command,
        "current_thread": resolved_current_thread,
        "thread_count": len(normalized_thread_ids),
        "thread_ids": normalized_thread_ids,
    }
    if threads_exported is not None:
        event["threads_exported"] = threads_exported
    if objects_uploaded is not None:
        event["objects_uploaded"] = objects_uploaded
    if downloaded_objects is not None:
        event["downloaded_objects"] = downloaded_objects
    if imported_thread is not None:
        event["imported_thread"] = imported_thread

    payload = {
        "schema_version": "1.0",
        "repo": str(repo or repo_state.get("repo_path") or ""),
        "repo_slug": repo_state.get("repo_slug") or existing.get("repo_slug"),
        "remote_profile": repo_state.get("remote_profile") or existing.get("remote_profile"),
        "remote_prefix": prefix or existing.get("remote_prefix"),
        "last_sync_at": now,
        "last_sync_direction": direction,
        "last_sync_command": command,
        "current_thread": resolved_current_thread,
        "thread_count": len(normalized_thread_ids),
        "thread_ids": normalized_thread_ids,
        "materialized_root": materialized_root,
        "last_push": existing.get("last_push"),
        "last_pull": existing.get("last_pull"),
    }
    if direction == "push":
        payload["last_push"] = event
    elif direction == "pull":
        payload["last_pull"] = event

    save_sync_state(memory_dir, payload)
    return payload


def _relative_session_path(path: Path) -> str:
    parts = path.parts
    if "sessions" in parts:
        idx = parts.index("sessions")
        return "/".join(parts[idx:])
    return path.name


def _indexed_thread_ids(memory_dir: Path) -> set[str]:
    path = thread_index_path(memory_dir)
    if not path.exists():
        return set()
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        return set()
    return {
        str(item.get("thread_id"))
        for item in payload
        if isinstance(item, dict) and isinstance(item.get("thread_id"), str) and item.get("thread_id")
    }


def _current_thread_id(memory_dir: Path) -> Optional[str]:
    path = current_thread_path(memory_dir)
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    thread_id = payload.get("thread_id")
    if isinstance(thread_id, str) and thread_id:
        return thread_id
    return None


def _materialized_root_status(memory_dir: Path) -> dict[str, bool]:
    roots = materialized_root_paths(memory_dir)
    return {
        "latest_md_present": roots["latest"].exists(),
        "handoff_json_present": roots["handoff"].exists(),
        "raw_session_present": roots["raw_session"].exists(),
    }


def _should_sync_relpath(relpath: str, thread_ids: set[str], current_thread_id: Optional[str]) -> bool:
    if relpath == "repo.json":
        return True
    if relpath == "thread-index.json":
        return True
    if relpath == "current-thread.json":
        return current_thread_id is not None and current_thread_id in thread_ids
    if relpath in {"latest.md", "handoff.json", "raw/session.jsonl"}:
        return current_thread_id is not None and current_thread_id in thread_ids
    parts = relpath.split("/")
    if len(parts) >= 3 and parts[0] == "threads":
        return parts[1] in thread_ids
    return False


def _should_preserve_local_relpath(relpath: str) -> bool:
    return relpath == "sync-state.json" or relpath.startswith("conflicts/")


def _remove_empty_dirs(paths: Iterable[Path]) -> None:
    for path in paths:
        if path.is_dir():
            try:
                path.rmdir()
            except OSError:
                continue
