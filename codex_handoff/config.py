from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any, Dict


APP_NAME = "codex-handoff"
CONFIG_DIRNAME = ".codex-handoff"
CONFIG_ENV_VAR = "CODEX_HANDOFF_CONFIG_DIR"
SINGLE_REMOTE_PROFILE = "default"


def config_dir() -> Path:
    override = os.environ.get(CONFIG_ENV_VAR)
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / CONFIG_DIRNAME


def config_path() -> Path:
    return config_dir() / "config.json"


def runtime_dir() -> Path:
    return config_dir() / "runtime"


def agent_state_dir() -> Path:
    return runtime_dir() / "agents"


def log_dir() -> Path:
    return config_dir() / "logs"


def load_config() -> Dict[str, Any]:
    path = config_path()
    if not path.exists():
        return {
            "schema_version": "1.0",
            "default_profile": SINGLE_REMOTE_PROFILE,
            "profiles": {},
            "repos": {},
            "machine_id": None,
        }
    return json.loads(path.read_text(encoding="utf-8"))


def save_config(payload: Dict[str, Any]) -> Path:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def ensure_machine_id(payload: Dict[str, Any]) -> str:
    machine_id = payload.get("machine_id")
    if isinstance(machine_id, str) and machine_id:
        return machine_id
    machine_id = str(uuid.uuid4())
    payload["machine_id"] = machine_id
    return machine_id
