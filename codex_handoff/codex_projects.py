from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

from codex_handoff.local_codex import normalize_cwd


def global_state_path(codex_home: str | None = None) -> Path:
    base = Path(codex_home or os.path.expanduser("~/.codex")).expanduser().resolve()
    return base / ".codex-global-state.json"


def load_global_state(codex_home: str | None = None) -> Dict[str, Any]:
    path = global_state_path(codex_home)
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def describe_current_project(repo: Path, codex_home: str | None = None) -> Dict[str, Any]:
    payload = load_global_state(codex_home)
    norm_repo = normalize_cwd(repo)
    state = payload.get("electron-persisted-atom-state", {})
    labels = state.get("electron-workspace-root-labels", {}) or {}
    saved = payload.get("electron-saved-workspace-roots", []) or []
    active = payload.get("active-workspace-roots", []) or []
    order = payload.get("project-order", []) or []
    sidebar_groups = list((state.get("sidebar-collapsed-groups", {}) or {}).keys())

    def contains(items: list[str]) -> bool:
        return any(normalize_cwd(item) == norm_repo for item in items)

    display_name = labels.get(str(repo)) or labels.get(_matching_key(labels, repo)) or repo.name
    return {
        "project_name": display_name,
        "workspace_root": str(repo),
        "is_active": contains(active),
        "is_saved": contains(saved),
        "is_in_project_order": contains(order),
        "is_in_sidebar_groups": contains(sidebar_groups),
    }


def _matching_key(mapping: Dict[str, Any], repo: Path) -> str | None:
    norm_repo = normalize_cwd(repo)
    for key in mapping.keys():
        if normalize_cwd(key) == norm_repo:
            return key
    return None
