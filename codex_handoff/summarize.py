from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Sequence

from codex_handoff.local_codex import DiscoveredThread, iso_utc
from codex_handoff.subprocess_utils import no_window_kwargs


@dataclass
class SummaryArtifacts:
    latest_md: str
    handoff_json: dict[str, Any]
    raw_records: list[dict[str, Any]]


def summarize_rollout(
    repo: Path,
    thread: DiscoveredThread,
    rollout_records: Sequence[dict[str, Any]],
    *,
    summary_mode: str = "auto",
) -> SummaryArtifacts:
    raw_records = normalize_rollout_records(rollout_records)

    if summary_mode == "codex" or summary_mode == "auto":
        codex_result = summarize_with_codex(repo, thread, rollout_records)
        if codex_result is not None:
            codex_result.raw_records = raw_records
            return codex_result
        if summary_mode == "codex":
            raise RuntimeError("Codex summarization was requested but the Codex CLI is unavailable or failed.")

    return summarize_heuristically(repo, thread, raw_records)


def summarize_heuristically(repo: Path, thread: DiscoveredThread, raw_records: Sequence[dict[str, Any]]) -> SummaryArtifacts:
    first_user = next((item for item in raw_records if item.get("role") == "user"), None)
    last_user = next((item for item in reversed(raw_records) if item.get("role") == "user"), None)
    last_assistant = next((item for item in reversed(raw_records) if item.get("role") == "assistant"), None)
    last_record = raw_records[-1] if raw_records else None

    current_goal = first_user["message"] if first_user else thread.title
    related_files = sorted(find_related_files(item.get("message", "")) for item in raw_records)
    flattened_files = sorted({path for paths in related_files for path in paths})
    search_hints = sorted({token for token in tokenize_search_hints(thread.title + " " + current_goal)})[:12]
    status_bits = []
    if last_assistant:
        status_bits.append(f"Last assistant message: {shorten(last_assistant['message'])}")
    if last_user and last_user is not first_user:
        status_bits.append(f"Most recent user ask: {shorten(last_user['message'])}")
    if last_record and last_record.get("timestamp"):
        status_bits.append(f"Last activity: {last_record['timestamp']}")
    status_summary = " ".join(status_bits) or "Thread bundle exported from the local Codex session source."

    latest_lines = [
        "# Current State",
        "",
        f"- Source thread title: {thread.title}",
        f"- Current goal: {shorten(current_goal, 180)}",
    ]
    if last_assistant:
        latest_lines.append(f"- Last assistant message: {shorten(last_assistant['message'], 180)}")
    if last_record and last_record.get("timestamp"):
        latest_lines.append(f"- Last activity at: {last_record['timestamp']}")
    latest_lines.extend(
        [
            "",
            "# Immediate Goal",
            "",
            current_goal,
            "",
        ]
    )

    handoff_json = {
        "schema_version": "1.0",
        "project_id": repo.name,
        "updated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "active_branch": "",
        "current_goal": current_goal,
        "status_summary": status_summary,
        "next_prompt": last_user["message"] if last_user else current_goal,
        "search_hints": search_hints,
        "related_files": flattened_files,
        "decisions": [],
        "todos": [],
        "recent_commands": [],
        "notes": [
            f"Generated from local Codex thread {thread.thread_id}.",
            "Heuristic summary fallback was used.",
        ],
    }
    return SummaryArtifacts(latest_md="\n".join(latest_lines).strip() + "\n", handoff_json=handoff_json, raw_records=list(raw_records))


def summarize_with_codex(
    repo: Path,
    thread: DiscoveredThread,
    rollout_records: Sequence[dict[str, Any]],
) -> Optional[SummaryArtifacts]:
    for codex_cmd in codex_cli_candidates():
        login_status = _run_codex_subprocess([*codex_cmd, "login", "status"])
        if login_status is None:
            continue
        if login_status.returncode != 0 or "Logged in" not in login_status.stdout:
            continue

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            rollout_path = temp_path / "rollout.jsonl"
            schema_path = temp_path / "schema.json"
            output_path = temp_path / "output.json"
            rollout_path.write_text(
                "\n".join(json.dumps(item, ensure_ascii=False) for item in rollout_records) + "\n",
                encoding="utf-8",
            )
            schema = {
                "type": "object",
                "properties": {
                    "latest_md": {"type": "string"},
                    "handoff_json": {
                        "type": "object",
                        "required": [
                            "schema_version",
                            "project_id",
                            "updated_at",
                            "current_goal",
                            "status_summary",
                            "decisions",
                            "todos",
                            "related_files",
                            "recent_commands",
                        ],
                        "properties": {
                            "schema_version": {"type": "string"},
                            "project_id": {"type": "string"},
                            "updated_at": {"type": "string"},
                            "active_branch": {"type": "string"},
                            "current_goal": {"type": "string"},
                            "status_summary": {"type": "string"},
                            "next_prompt": {"type": "string"},
                            "search_hints": {"type": "array", "items": {"type": "string"}},
                            "related_files": {"type": "array", "items": {"type": "string"}},
                            "decisions": {"type": "array", "items": {"type": "object"}},
                            "todos": {"type": "array", "items": {"type": "object"}},
                            "recent_commands": {"type": "array", "items": {"type": "object"}},
                            "notes": {"type": "array", "items": {"type": "string"}},
                        },
                        "additionalProperties": True,
                    },
                },
                "required": ["latest_md", "handoff_json"],
                "additionalProperties": False,
            }
            schema_path.write_text(json.dumps(schema, indent=2), encoding="utf-8")
            prompt = (
                "Read the Codex rollout JSONL at "
                f"{rollout_path}. "
                "Summarize only the work context needed to continue on another machine. "
                "Return a concise latest.md string and a handoff_json object. "
                f"The source thread title is: {thread.title}. "
                "If a field is unknown, leave it empty or use an empty array."
            )
            result = _run_codex_subprocess(
                [
                    *codex_cmd,
                    "exec",
                    "--ephemeral",
                    "--skip-git-repo-check",
                    "-C",
                    str(repo),
                    "--output-schema",
                    str(schema_path),
                    "-o",
                    str(output_path),
                    prompt,
                ]
            )
            if result is None:
                continue
            if result.returncode != 0 or not output_path.exists():
                continue
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            latest_md = payload["latest_md"].strip() + "\n"
            handoff_json = payload["handoff_json"]
            if "updated_at" not in handoff_json or not handoff_json["updated_at"]:
                handoff_json["updated_at"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
            return SummaryArtifacts(latest_md=latest_md, handoff_json=handoff_json, raw_records=[])
    return None


def preferred_codex_cli() -> Optional[str]:
    candidates = codex_cli_candidates()
    return " ".join(candidates[0]) if candidates else None


def background_safe_summary_mode(summary_mode: str) -> str:
    if os.name == "nt":
        return "heuristic"
    return summary_mode


def codex_cli_candidates() -> list[list[str]]:
    direct = shutil.which("codex")
    if os.name != "nt":
        return [[direct]] if direct else []

    ordered: list[tuple[int, int, list[str]]] = []
    seen: set[tuple[str, ...]] = set()
    sequence = 0

    def add(candidate: Optional[list[str]], rank: int) -> None:
        nonlocal sequence
        if not candidate:
            return
        normalized = [str(Path(part)) if index == 0 else part for index, part in enumerate(candidate)]
        executable = Path(normalized[0])
        if not executable.exists():
            return
        key = tuple(part.lower() for part in normalized)
        if key in seen:
            return
        seen.add(key)
        ordered.append((rank, sequence, normalized))
        sequence += 1

    discovered = list(_where_codex_candidates())
    for name in ["codex.exe", "codex.com", "codex", "codex.cmd", "codex.bat", "codex.ps1"]:
        candidate = shutil.which(name)
        if candidate:
            discovered.append(candidate)
    if direct:
        discovered.append(direct)

    for candidate in discovered:
        suffix = Path(candidate).suffix.lower()
        if suffix in {".cmd", ".bat"}:
            add(_vendor_codex_candidate(candidate), 0)
            add(_node_wrapped_codex_candidate(candidate), 1)
        if suffix == ".exe":
            add([candidate], 2)
        elif suffix == ".com":
            add([candidate], 3)
        elif suffix == "":
            add([candidate], 4)
        elif suffix in {".cmd", ".bat"}:
            add([candidate], 5)
        elif suffix == ".ps1":
            add([candidate], 6)
        else:
            add([candidate], 7)

    return [candidate for _, _, candidate in sorted(ordered, key=lambda item: (item[0], item[1]))]


def normalize_rollout_records(records: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    session_id = None
    current_turn_id = None
    normalized: list[dict[str, Any]] = []

    for item in records:
        record_type = item.get("type")
        payload = item.get("payload", {})
        timestamp = item.get("timestamp")
        if record_type == "session_meta":
            session_id = payload.get("id")
            continue
        if record_type == "event_msg" and payload.get("type") == "task_started":
            current_turn_id = payload.get("turn_id")
            continue
        if record_type == "event_msg" and payload.get("type") == "user_message":
            normalized.append(
                {
                    "session_id": session_id,
                    "turn_id": current_turn_id,
                    "timestamp": timestamp,
                    "role": "user",
                    "message": payload.get("message", ""),
                }
            )
            continue
        if record_type == "event_msg" and payload.get("type") == "agent_message":
            normalized.append(
                {
                    "session_id": session_id,
                    "turn_id": current_turn_id,
                    "timestamp": timestamp,
                    "role": "assistant",
                    "message": payload.get("message", ""),
                }
            )
            continue
        if record_type == "response_item" and payload.get("type") == "function_call":
            normalized.append(
                {
                    "session_id": session_id,
                    "turn_id": current_turn_id,
                    "timestamp": timestamp,
                    "role": "tool_call",
                    "message": f"{payload.get('name', '')} {payload.get('arguments', '')}".strip(),
                }
            )
            continue
        if record_type == "response_item" and payload.get("type") == "function_call_output":
            normalized.append(
                {
                    "session_id": session_id,
                    "turn_id": current_turn_id,
                    "timestamp": timestamp,
                    "role": "tool_output",
                    "message": str(payload.get("output", "")),
                }
            )
            continue

    return [item for item in normalized if item.get("message")]


def find_related_files(text: str) -> set[str]:
    matches = set()
    for match in re.findall(r"(?:[A-Za-z]:\\|/)?[\w .#&()\-/\\]+\.[A-Za-z0-9]+", text):
        cleaned = match.strip().strip("`'\"")
        if len(cleaned) >= 4:
            matches.add(cleaned)
    return matches


def tokenize_search_hints(text: str) -> list[str]:
    tokens = []
    seen = set()
    for token in re.findall(r"[A-Za-z0-9._/-]+", text.lower()):
        if len(token) < 3 or token in seen:
            continue
        seen.add(token)
        tokens.append(token)
    return tokens


def shorten(text: str, limit: int = 240) -> str:
    normalized = re.sub(r"\s+", " ", text).strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 3].rstrip() + "..."


def _subprocess_kwargs_no_window() -> dict:
    return no_window_kwargs()


def _where_codex_candidates() -> list[str]:
    if os.name != "nt":
        return []
    try:
        result = subprocess.run(
            ["where.exe", "codex"],
            check=False,
            capture_output=True,
            text=True,
            **no_window_kwargs(),
        )
    except OSError:
        return []
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _node_wrapped_codex_candidate(wrapper_path: str) -> Optional[list[str]]:
    path = Path(wrapper_path)
    if path.suffix.lower() not in {".cmd", ".bat"}:
        return None
    package_root = _codex_package_root(path)
    if package_root is None:
        return None
    script_path = package_root / "bin" / "codex.js"
    if not script_path.exists():
        return None
    local_node = path.parent / "node.exe"
    node_path = str(local_node) if local_node.exists() else shutil.which("node")
    if not node_path:
        return None
    if not Path(node_path).exists():
        return None
    return [node_path, str(script_path)]


def _vendor_codex_candidate(wrapper_path: str) -> Optional[list[str]]:
    path = Path(wrapper_path)
    package_root = _codex_package_root(path)
    if package_root is None:
        return None

    for vendor_binary in _vendor_codex_binaries(package_root):
        if vendor_binary.exists():
            return [str(vendor_binary)]
    return None


def _codex_package_root(candidate_path: Path) -> Optional[Path]:
    direct_root = candidate_path.parent / "node_modules" / "@openai" / "codex"
    if (direct_root / "bin" / "codex.js").exists():
        return direct_root

    for parent in candidate_path.parents:
        if parent.name == "codex" and parent.parent.name == "@openai" and (parent / "bin" / "codex.js").exists():
            return parent
    return None


def _vendor_codex_binaries(package_root: Path) -> list[Path]:
    preferred_arch = platform.machine().lower()
    candidates: list[Path] = []

    def add(pattern: str) -> None:
        for match in package_root.glob(pattern):
            if match not in candidates:
                candidates.append(match)

    if "arm" in preferred_arch or "aarch64" in preferred_arch:
        add("node_modules/@openai/codex-win32-arm64/vendor/*/codex/codex.exe")
        add("node_modules/@openai/codex-win32-x64/vendor/*/codex/codex.exe")
    else:
        add("node_modules/@openai/codex-win32-x64/vendor/*/codex/codex.exe")
        add("node_modules/@openai/codex-win32-arm64/vendor/*/codex/codex.exe")
    add("vendor/*/codex/codex.exe")
    return candidates


def _run_codex_subprocess(argv: Sequence[str]) -> Optional[subprocess.CompletedProcess[str]]:
    try:
        return subprocess.run(
            list(argv),
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            **no_window_kwargs(),
        )
    except OSError:
        return None
