from __future__ import annotations

import os
import shutil
from pathlib import Path


SKILLS_DIR_ENV_VAR = "CODEX_HANDOFF_SKILLS_DIR"
SKILL_NAME = "codex-handoff"


def package_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _bundled_skill_candidates(repo_root: Path | None = None) -> list[Path]:
    candidates = [package_root() / "skills" / SKILL_NAME]
    if repo_root is not None:
        repo_candidate = repo_root / "skills" / SKILL_NAME
        if repo_candidate not in candidates:
            candidates.append(repo_candidate)
    return candidates


def bundled_skill_path(repo_root: Path | None = None) -> Path:
    for candidate in _bundled_skill_candidates(repo_root):
        if candidate.exists():
            return candidate
    looked_up = ", ".join(str(candidate) for candidate in _bundled_skill_candidates(repo_root))
    raise FileNotFoundError(f"Bundled skill not found. Looked in: {looked_up}")


def default_skills_dir() -> Path:
    override = os.environ.get(SKILLS_DIR_ENV_VAR)
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / ".codex" / "skills"


def installed_skill_path(skills_dir: Path | None = None) -> Path:
    return (skills_dir or default_skills_dir()) / SKILL_NAME


def install_skill(repo_root: Path, skills_dir: Path | None = None) -> Path:
    source = bundled_skill_path(repo_root)
    destination = installed_skill_path(skills_dir)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination)
    return destination
