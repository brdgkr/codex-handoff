from __future__ import annotations

import json
import os
import platform
from pathlib import Path
from typing import Any, Dict


APP_NAME = "codex-handoff"
CONFIG_ENV_VAR = "CODEX_HANDOFF_CONFIG_DIR"


def config_dir() -> Path:
    override = os.environ.get(CONFIG_ENV_VAR)
    if override:
        return Path(override).expanduser().resolve()

    system = platform.system()
    home = Path.home()
    if system == "Darwin":
        return home / "Library" / "Application Support" / APP_NAME
    if system == "Windows":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return Path(appdata).expanduser().resolve() / APP_NAME
        return home / "AppData" / "Roaming" / APP_NAME
    return home / ".config" / APP_NAME


def config_path() -> Path:
    return config_dir() / "config.json"


def load_config() -> Dict[str, Any]:
    path = config_path()
    if not path.exists():
        return {"schema_version": "1.0", "default_profile": None, "profiles": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def save_config(payload: Dict[str, Any]) -> Path:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path
