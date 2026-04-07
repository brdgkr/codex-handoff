from __future__ import annotations

import configparser
import re
from pathlib import Path
from typing import Optional


REMOTE_ORIGIN_SECTION_PATTERN = re.compile(r'^remote\s+"origin"$', re.IGNORECASE)


def git_origin_url_from_repo(repo: Path) -> Optional[str]:
    git_dir = resolve_git_dir(repo)
    if git_dir is None:
        return None
    for config_path in iter_git_config_paths(git_dir):
        url = read_origin_url_from_config(config_path)
        if url:
            return url
    return None


def resolve_git_dir(repo: Path) -> Optional[Path]:
    dotgit = repo / ".git"
    if dotgit.is_dir():
        return dotgit.resolve()
    if not dotgit.is_file():
        return None

    try:
        payload = dotgit.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    for line in payload.splitlines():
        if line.lower().startswith("gitdir:"):
            value = line.split(":", 1)[1].strip()
            if not value:
                return None
            git_dir = Path(value)
            if not git_dir.is_absolute():
                git_dir = (repo / git_dir).resolve()
            return git_dir
    return None


def iter_git_config_paths(git_dir: Path) -> list[Path]:
    candidates: list[Path] = []
    seen: set[str] = set()

    def add(path: Path) -> None:
        normalized = str(path.resolve()) if path.exists() else str(path)
        key = normalized.lower()
        if key in seen:
            return
        seen.add(key)
        if path.exists():
            candidates.append(path)

    add(git_dir / "config")

    common_dir = resolve_common_git_dir(git_dir)
    if common_dir is not None:
        add(common_dir / "config")

    return candidates


def resolve_common_git_dir(git_dir: Path) -> Optional[Path]:
    path = git_dir / "commondir"
    if not path.exists():
        return None
    try:
        value = path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    if not value:
        return None
    common_dir = Path(value)
    if not common_dir.is_absolute():
        common_dir = (git_dir / common_dir).resolve()
    return common_dir


def read_origin_url_from_config(config_path: Path) -> Optional[str]:
    parser = configparser.RawConfigParser(interpolation=None, strict=False)
    try:
        with config_path.open("r", encoding="utf-8", errors="replace") as handle:
            parser.read_file(handle)
    except (OSError, configparser.Error):
        return None

    for section in parser.sections():
        if REMOTE_ORIGIN_SECTION_PATTERN.fullmatch(section):
            for option_name, option_value in parser.items(section):
                if option_name.lower() == "url":
                    value = option_value.strip()
                    return value or None
    return None
