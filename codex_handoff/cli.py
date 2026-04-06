from __future__ import annotations

import argparse
import getpass
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Sequence

from codex_handoff.config import config_path, load_config, save_config
from codex_handoff.reader import (
    extract_records,
    render_context_pack,
    render_extract_results,
    render_search_results,
    render_status,
    resolve_memory_dir,
    resolve_repo_path,
    search_raw,
)
from codex_handoff.r2 import R2Error, R2Profile, validate_r2_credentials
from codex_handoff.secrets import SecretStoreError, delete_secret, read_secret, store_secret


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="codex-handoff",
        description="Bootstrap and restore Codex context from local memory files.",
    )
    parser.add_argument(
        "--repo",
        default=".",
        help="Repository root that contains the .codex-handoff directory. Defaults to the current directory.",
    )
    parser.add_argument(
        "--memory-dir",
        default=None,
        help="Optional explicit memory directory. Overrides --repo/.codex-handoff.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("status", help="Show available memory artifacts and counts.")

    resume = subparsers.add_parser("resume", help="Build a restore pack for continuing work.")
    resume.add_argument("--goal", required=True, help="Current user goal used to rank raw evidence.")
    resume.add_argument(
        "--evidence-limit",
        type=int,
        default=5,
        help="Maximum number of ranked raw evidence rows to include.",
    )
    resume.add_argument("--output", default=None, help="Optional file path to write the restore pack.")

    context_pack = subparsers.add_parser(
        "context-pack", help="Build a compressed context pack from memory files."
    )
    context_pack.add_argument("--goal", required=True, help="Current goal used to rank raw evidence.")
    context_pack.add_argument(
        "--evidence-limit",
        type=int,
        default=5,
        help="Maximum number of ranked raw evidence rows to include.",
    )
    context_pack.add_argument("--output", default=None, help="Optional file path to write the context pack.")

    search = subparsers.add_parser("search", help="Search raw jsonl evidence by query.")
    search.add_argument("query", help="Free-form search query.")
    search.add_argument("--limit", type=int, default=8, help="Maximum number of matches to return.")

    extract = subparsers.add_parser("extract", help="Extract exact raw records by session or turn id.")
    extract.add_argument("--session", default=None, help="Session identifier to match.")
    extract.add_argument("--turn", default=None, help="Turn identifier to match.")

    remote = subparsers.add_parser("remote", help="Manage remote backends and credentials.")
    remote_subparsers = remote.add_subparsers(dest="remote_command", required=True)

    login = remote_subparsers.add_parser("login", help="Register a remote backend profile.")
    login_subparsers = login.add_subparsers(dest="remote_provider", required=True)

    login_r2 = login_subparsers.add_parser("r2", help="Log in to a Cloudflare R2 backend.")
    login_r2.add_argument("--profile", default="default", help="Local profile name. Defaults to default.")
    login_r2.add_argument("--account-id", default=None, help="Cloudflare account id.")
    login_r2.add_argument("--bucket", default=None, help="R2 bucket name.")
    login_r2.add_argument("--access-key-id", default=None, help="R2 access key id.")
    login_r2.add_argument("--secret-access-key", default=None, help="R2 secret access key.")
    login_r2.add_argument("--endpoint", default=None, help="Override the R2 endpoint.")
    login_r2.add_argument(
        "--memory-prefix",
        default="projects/",
        help="Remote prefix used later for syncing memory files.",
    )
    login_r2.add_argument(
        "--skip-validate",
        action="store_true",
        help="Store credentials without making a test API call.",
    )

    whoami = remote_subparsers.add_parser("whoami", help="Show the active remote profile.")
    whoami.add_argument("--profile", default=None, help="Profile name. Defaults to the configured default.")

    validate = remote_subparsers.add_parser("validate", help="Validate stored credentials against the remote.")
    validate.add_argument("--profile", default=None, help="Profile name. Defaults to the configured default.")

    logout = remote_subparsers.add_parser("logout", help="Remove a stored remote profile.")
    logout.add_argument("--profile", default=None, help="Profile name. Defaults to the configured default.")

    return parser


def _write_or_print(output: str, output_path: Optional[str]) -> None:
    if not output_path:
        print(output, end="")
        return
    path = Path(output_path).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(output, encoding="utf-8")
    print(path)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    repo = resolve_repo_path(args.repo)
    memory_dir = resolve_memory_dir(repo, args.memory_dir)

    try:
        if args.command == "status":
            print(render_status(repo, memory_dir), end="")
            return 0

        if args.command in {"resume", "context-pack"}:
            output = render_context_pack(repo, memory_dir, args.goal, evidence_limit=args.evidence_limit)
            _write_or_print(output, args.output)
            return 0

        if args.command == "search":
            matches = search_raw(memory_dir, args.query, limit=args.limit)
            print(render_search_results(args.query, matches), end="")
            return 0

        if args.command == "extract":
            if not args.session and not args.turn:
                parser.error("extract requires at least one of --session or --turn")
            records = extract_records(memory_dir, session_id=args.session, turn_id=args.turn)
            print(render_extract_results(records), end="")
            return 0

        if args.command == "remote":
            return _handle_remote(args)
    except (R2Error, SecretStoreError) as error:
        raise SystemExit(str(error)) from error

    parser.error(f"unknown command: {args.command}")
    return 2


def _handle_remote(args: argparse.Namespace) -> int:
    if args.remote_command == "login" and args.remote_provider == "r2":
        profile_name = args.profile
        account_id = args.account_id or input("Cloudflare Account ID: ").strip()
        bucket = args.bucket or input("R2 Bucket: ").strip()
        access_key_id = args.access_key_id or input("R2 Access Key ID: ").strip()
        secret_access_key = args.secret_access_key or getpass.getpass("R2 Secret Access Key: ").strip()
        endpoint = args.endpoint or f"https://{account_id}.r2.cloudflarestorage.com"

        profile = R2Profile(
            account_id=account_id,
            access_key_id=access_key_id,
            secret_access_key=secret_access_key,
            bucket=bucket,
            endpoint=endpoint,
            memory_prefix=args.memory_prefix,
        )

        validation_result = None
        if not args.skip_validate:
            validation_result = validate_r2_credentials(profile)

        secret_info = store_secret(profile_name, secret_access_key)
        payload = load_config()
        profiles = payload.setdefault("profiles", {})
        now = _now_iso()
        profiles[profile_name] = {
            "provider": "cloudflare-r2",
            "account_id": account_id,
            "bucket": bucket,
            "endpoint": endpoint,
            "region": "auto",
            "memory_prefix": args.memory_prefix,
            "access_key_id": access_key_id,
            "created_at": now,
            "updated_at": now,
            "validated_at": now if validation_result else None,
            **secret_info,
        }
        payload["default_profile"] = profile_name
        path = save_config(payload)
        print(json.dumps({"profile": profile_name, "config_path": str(path), "validated": bool(validation_result)}, ensure_ascii=False, indent=2))
        return 0

    if args.remote_command == "whoami":
        profile_name, profile = _load_remote_profile(args.profile)
        masked_key = _mask(profile.get("access_key_id", ""))
        print(
            json.dumps(
                {
                    "profile": profile_name,
                    "provider": profile.get("provider"),
                    "account_id": profile.get("account_id"),
                    "bucket": profile.get("bucket"),
                    "endpoint": profile.get("endpoint"),
                    "memory_prefix": profile.get("memory_prefix"),
                    "access_key_id": masked_key,
                    "secret_backend": profile.get("secret_backend"),
                    "validated_at": profile.get("validated_at"),
                    "config_path": str(config_path()),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    if args.remote_command == "validate":
        profile_name, profile = _load_remote_profile(args.profile)
        secret = read_secret(profile["secret_backend"], profile["secret_ref"], profile_name)
        result = validate_r2_credentials(
            R2Profile(
                account_id=profile["account_id"],
                access_key_id=profile["access_key_id"],
                secret_access_key=secret,
                bucket=profile["bucket"],
                endpoint=profile["endpoint"],
                region=profile.get("region", "auto"),
                memory_prefix=profile.get("memory_prefix", "projects/"),
            )
        )
        payload = load_config()
        payload["profiles"][profile_name]["validated_at"] = _now_iso()
        save_config(payload)
        print(json.dumps({"profile": profile_name, "result": result}, ensure_ascii=False, indent=2))
        return 0

    if args.remote_command == "logout":
        profile_name, profile = _load_remote_profile(args.profile)
        delete_secret(profile["secret_backend"], profile["secret_ref"], profile_name)
        payload = load_config()
        payload.get("profiles", {}).pop(profile_name, None)
        if payload.get("default_profile") == profile_name:
            remaining = sorted(payload.get("profiles", {}).keys())
            payload["default_profile"] = remaining[0] if remaining else None
        save_config(payload)
        print(json.dumps({"removed_profile": profile_name, "config_path": str(config_path())}, ensure_ascii=False, indent=2))
        return 0

    raise SystemExit(f"unsupported remote command: {args.remote_command}")


def _load_remote_profile(explicit_profile: Optional[str]) -> tuple[str, dict]:
    payload = load_config()
    profiles = payload.get("profiles", {})
    profile_name = explicit_profile or payload.get("default_profile")
    if not profile_name:
        raise SystemExit("No remote profile is configured. Run `codex-handoff remote login r2` first.")
    profile = profiles.get(profile_name)
    if not profile:
        raise SystemExit(f"Remote profile not found: {profile_name}")
    if profile.get("provider") != "cloudflare-r2":
        raise SystemExit(f"Unsupported provider in profile {profile_name}: {profile.get('provider')}")
    return profile_name, profile


def _mask(value: str) -> str:
    if len(value) <= 6:
        return "*" * len(value)
    return value[:2] + "*" * (len(value) - 4) + value[-2:]


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
