from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence


DEFAULT_MEMORY_DIRNAME = ".codex-handoff"


@dataclass
class RawMatch:
    file_path: Path
    line_number: int
    score: int
    session_id: Optional[str]
    turn_id: Optional[str]
    timestamp: Optional[str]
    role: Optional[str]
    snippet: str
    record: Dict[str, Any]


def resolve_repo_path(repo: str) -> Path:
    return Path(repo).expanduser().resolve()


def resolve_memory_dir(repo: Path, memory_dir: Optional[str] = None) -> Path:
    if memory_dir:
        return Path(memory_dir).expanduser().resolve()
    return repo / DEFAULT_MEMORY_DIRNAME


def latest_path(memory_dir: Path) -> Path:
    return memory_dir / "latest.md"


def handoff_path(memory_dir: Path) -> Path:
    return memory_dir / "handoff.json"


def raw_dir(memory_dir: Path) -> Path:
    return memory_dir / "raw"


def read_latest(memory_dir: Path) -> str:
    path = latest_path(memory_dir)
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def read_handoff(memory_dir: Path) -> Dict[str, Any]:
    path = handoff_path(memory_dir)
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _collect_text(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (int, float, bool)):
        return [str(value)]
    if isinstance(value, dict):
        items: List[str] = []
        for key, item in value.items():
            items.append(str(key))
            items.extend(_collect_text(item))
        return items
    if isinstance(value, list):
        items = []
        for item in value:
            items.extend(_collect_text(item))
        return items
    return [str(value)]


def _normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _shorten(text: str, limit: int = 240) -> str:
    clean = _normalize_whitespace(text)
    if len(clean) <= limit:
        return clean
    return clean[: limit - 3].rstrip() + "..."


def _tokenize(text: str) -> List[str]:
    seen = set()
    tokens: List[str] = []
    for token in re.findall(r"[A-Za-z0-9_.:/-]+", text.lower()):
        if len(token) < 3:
            continue
        if token in seen:
            continue
        seen.add(token)
        tokens.append(token)
    return tokens


def _match_score(haystack: str, terms: Sequence[str]) -> int:
    score = 0
    lower = haystack.lower()
    for term in terms:
        if term in lower:
            score += lower.count(term)
    return score


def _coerce_record(raw_line: str) -> Dict[str, Any]:
    payload = json.loads(raw_line)
    if isinstance(payload, dict):
        return payload
    return {"value": payload}


def iter_raw_records(memory_dir: Path) -> Iterator[RawMatch]:
    directory = raw_dir(memory_dir)
    if not directory.exists():
        return
    for file_path in sorted(directory.rglob("*.jsonl")):
        with file_path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    record = _coerce_record(line)
                except json.JSONDecodeError:
                    record = {"message": line.strip()}
                text = " ".join(_collect_text(record))
                yield RawMatch(
                    file_path=file_path,
                    line_number=line_number,
                    score=0,
                    session_id=_first_present(record, ("session_id", "session", "conversation_id")),
                    turn_id=_first_present(record, ("turn_id", "turn", "message_id", "id")),
                    timestamp=_first_present(record, ("timestamp", "created_at", "at")),
                    role=_first_present(record, ("role", "speaker", "author")),
                    snippet=_shorten(text),
                    record=record,
                )


def _first_present(record: Dict[str, Any], keys: Sequence[str]) -> Optional[str]:
    for key in keys:
        if key in record and record[key] is not None:
            return str(record[key])
    return None


def search_raw(memory_dir: Path, query: str, limit: int = 8) -> List[RawMatch]:
    terms = _tokenize(query)
    if not terms:
        return []
    matches: List[RawMatch] = []
    for item in iter_raw_records(memory_dir) or []:
        text = " ".join(_collect_text(item.record))
        score = _match_score(text, terms)
        if score <= 0:
            continue
        matches.append(
            RawMatch(
                file_path=item.file_path,
                line_number=item.line_number,
                score=score,
                session_id=item.session_id,
                turn_id=item.turn_id,
                timestamp=item.timestamp,
                role=item.role,
                snippet=item.snippet,
                record=item.record,
            )
        )
    matches.sort(key=lambda item: (-item.score, str(item.file_path), item.line_number))
    return matches[:limit]


def extract_records(memory_dir: Path, session_id: Optional[str], turn_id: Optional[str]) -> List[RawMatch]:
    records: List[RawMatch] = []
    for item in iter_raw_records(memory_dir) or []:
        if session_id and item.session_id != session_id:
            continue
        if turn_id and item.turn_id != turn_id:
            continue
        records.append(item)
    return records


def count_raw_records(memory_dir: Path) -> int:
    count = 0
    for _ in iter_raw_records(memory_dir) or []:
        count += 1
    return count


def count_raw_files(memory_dir: Path) -> int:
    directory = raw_dir(memory_dir)
    if not directory.exists():
        return 0
    return sum(1 for _ in directory.rglob("*.jsonl"))


def build_context_query(goal: str, handoff: Dict[str, Any]) -> str:
    pieces = [goal]
    current_goal = handoff.get("current_goal")
    if isinstance(current_goal, str):
        pieces.append(current_goal)
    for key in ("search_hints", "related_files", "notes"):
        value = handoff.get(key)
        if isinstance(value, list):
            pieces.extend(str(item) for item in value)
    todos = handoff.get("todos")
    if isinstance(todos, list):
        for todo in todos[:3]:
            if isinstance(todo, dict):
                summary = todo.get("summary")
                if summary:
                    pieces.append(str(summary))
    return " ".join(piece for piece in pieces if piece)


def render_status(repo: Path, memory_dir: Path) -> str:
    latest = latest_path(memory_dir)
    handoff = handoff_path(memory_dir)
    latest_text = read_latest(memory_dir)
    handoff_payload = read_handoff(memory_dir)
    lines = [
        "# codex-handoff status",
        "",
        "## Paths",
        f"- repo: {repo}",
        f"- memory_dir: {memory_dir}",
        "",
        "## Files",
        f"- latest.md: {'present' if latest.exists() else 'missing'}",
        f"- handoff.json: {'present' if handoff.exists() else 'missing'}",
        f"- raw jsonl files: {count_raw_files(memory_dir)}",
        f"- raw records: {count_raw_records(memory_dir)}",
    ]
    if latest_text:
        lines.extend(["", "## Bootstrap Summary", latest_text])
    if handoff_payload:
        lines.extend(
            [
                "",
                "## Structured State",
                f"- current_goal: {handoff_payload.get('current_goal', '')}",
                f"- active_branch: {handoff_payload.get('active_branch', '')}",
                f"- todo_count: {len(handoff_payload.get('todos', []))}",
                f"- decision_count: {len(handoff_payload.get('decisions', []))}",
            ]
        )
    return "\n".join(lines).strip() + "\n"


def _render_decisions(handoff: Dict[str, Any]) -> List[str]:
    decisions = handoff.get("decisions")
    if not isinstance(decisions, list) or not decisions:
        return ["- none"]
    rows = []
    for item in decisions:
        if not isinstance(item, dict):
            continue
        summary = item.get("summary", "")
        rationale = item.get("rationale")
        if rationale:
            rows.append(f"- {summary} ({rationale})")
        else:
            rows.append(f"- {summary}")
    return rows or ["- none"]


def _render_todos(handoff: Dict[str, Any]) -> List[str]:
    todos = handoff.get("todos")
    if not isinstance(todos, list) or not todos:
        return ["- none"]
    rows = []
    for item in todos:
        if not isinstance(item, dict):
            continue
        status = item.get("status", "pending")
        summary = item.get("summary", "")
        priority = item.get("priority")
        label = f"- [{status}] {summary}"
        if priority:
            label += f" (priority: {priority})"
        rows.append(label)
    return rows or ["- none"]


def _render_commands(handoff: Dict[str, Any]) -> List[str]:
    commands = handoff.get("recent_commands")
    if not isinstance(commands, list) or not commands:
        return ["- none"]
    rows = []
    for item in commands[:5]:
        if not isinstance(item, dict):
            continue
        command = item.get("command", "")
        purpose = item.get("purpose")
        if purpose:
            rows.append(f"- `{command}` ({purpose})")
        else:
            rows.append(f"- `{command}`")
    return rows or ["- none"]


def render_context_pack(repo: Path, memory_dir: Path, goal: str, evidence_limit: int = 5) -> str:
    latest = read_latest(memory_dir)
    handoff = read_handoff(memory_dir)
    query = build_context_query(goal, handoff)
    evidence = search_raw(memory_dir, query, limit=evidence_limit)

    lines = [
        "# Codex Restore Pack",
        "",
        f"- repo: {repo}",
        f"- memory_dir: {memory_dir}",
        f"- requested_goal: {goal}",
        "",
        "## Bootstrap",
        latest or "_missing latest.md_",
        "",
        "## Structured State",
        f"- current_goal: {handoff.get('current_goal', '')}",
        f"- status_summary: {handoff.get('status_summary', '')}",
        f"- active_branch: {handoff.get('active_branch', '')}",
        f"- next_prompt: {handoff.get('next_prompt', '')}",
        "",
        "## Decisions",
    ]
    lines.extend(_render_decisions(handoff))
    lines.extend(["", "## TODOs"])
    lines.extend(_render_todos(handoff))
    lines.extend(["", "## Related Files"])
    related_files = handoff.get("related_files")
    if isinstance(related_files, list) and related_files:
        lines.extend(f"- {item}" for item in related_files)
    else:
        lines.append("- none")
    lines.extend(["", "## Recent Commands"])
    lines.extend(_render_commands(handoff))
    lines.extend(["", "## Ranked Raw Evidence"])
    if not evidence:
        lines.append("- none")
    else:
        for item in evidence:
            label = f"- score={item.score} session={item.session_id or '?'} turn={item.turn_id or '?'}"
            if item.timestamp:
                label += f" at={item.timestamp}"
            lines.append(label)
            lines.append(f"  file={item.file_path}:{item.line_number}")
            lines.append(f"  snippet={item.snippet}")
    return "\n".join(lines).strip() + "\n"


def render_search_results(query: str, matches: Sequence[RawMatch]) -> str:
    lines = [
        "# codex-handoff search",
        "",
        f"- query: {query}",
        f"- matches: {len(matches)}",
        "",
    ]
    if not matches:
        lines.append("No matches found.")
        return "\n".join(lines).strip() + "\n"
    for item in matches:
        lines.append(
            f"- score={item.score} session={item.session_id or '?'} turn={item.turn_id or '?'} role={item.role or '?'}"
        )
        lines.append(f"  file={item.file_path}:{item.line_number}")
        if item.timestamp:
            lines.append(f"  timestamp={item.timestamp}")
        lines.append(f"  snippet={item.snippet}")
    return "\n".join(lines).strip() + "\n"


def render_extract_results(records: Sequence[RawMatch]) -> str:
    payload = []
    for item in records:
        payload.append(
            {
                "file": str(item.file_path),
                "line_number": item.line_number,
                "session_id": item.session_id,
                "turn_id": item.turn_id,
                "timestamp": item.timestamp,
                "role": item.role,
                "record": item.record,
            }
        )
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
