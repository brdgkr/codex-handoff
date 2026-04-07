from __future__ import annotations

import argparse
import getpass
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Sequence

from codex_handoff.agent import restart_agent, start_agent, status_payload, stop_agent
from codex_handoff.autostart import autostart_status, disable_autostart, enable_autostart
from codex_handoff.codex_projects import describe_current_project
from codex_handoff.config import SINGLE_REMOTE_PROFILE, config_dir, config_path, ensure_machine_id, load_config, save_config
from codex_handoff.local_codex import cleanup_thread, codex_paths, discover_threads_for_repo, normalize_cwd, normalize_git_origin_url
from codex_handoff.remote_auth import (
    R2CredentialSourceError,
    ensure_global_dotenv_template,
    open_r2_dashboard,
    r2_credential_template,
    r2_dashboard_url,
    read_r2_credentials_from_clipboard,
    read_r2_credentials_from_dotenv,
    read_r2_credentials_from_env,
)
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
from codex_handoff.r2 import R2Error, R2Profile, delete_r2_object, get_r2_object, list_r2_objects, put_r2_object, validate_r2_credentials
from codex_handoff.secrets import SecretStoreError, delete_secret, read_secret, store_secret
from codex_handoff.summarize import preferred_codex_cli
from codex_handoff.skills import install_skill, installed_skill_path
from codex_handoff.sync import (
    ThreadImportMismatchError,
    build_sync_health,
    describe_sync_state,
    export_repo_threads,
    import_thread_bundle_to_codex,
    pull_memory_tree,
    push_memory_tree,
    record_sync_event,
    sync_now,
    watch_and_sync,
)
from codex_handoff.summarize import background_safe_summary_mode
from codex_handoff.workspace import (
    build_repo_state,
    current_thread_path,
    ensure_agents_block,
    ensure_memory_dir_gitignored,
    ensure_memory_layout,
    git_origin_url,
    infer_repo_slug,
    load_repo_state,
    register_repo_mapping,
    save_repo_state,
)


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

    install = subparsers.add_parser("install", help="Bootstrap the repo for codex-handoff using the current workspace.")
    install.add_argument("--profile", default=None, help="Remote profile name. Only `default` is supported.")
    install.add_argument("--remote-slug", default=None, help="Override the remote repo slug.")
    install.add_argument(
        "--match-mode",
        default="auto",
        choices=["auto", "existing", "new"],
        help="How to resolve the remote repo when no explicit --remote-slug is provided.",
    )
    install.add_argument(
        "--summary-mode",
        default="auto",
        choices=["auto", "heuristic", "codex"],
        help="Summary generation mode for exported thread bundles.",
    )
    install.add_argument(
        "--skip-raw-threads",
        action="store_true",
        help="Do not include original rollout source files in exported thread bundles.",
    )
    install.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")
    install.add_argument(
        "--login-if-needed",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Create a remote profile automatically if none exists. Defaults to enabled.",
    )
    install.add_argument(
        "--auth-source",
        default="dotenv",
        choices=["clipboard", "env", "dotenv"],
        help="Where to read R2 credentials from when --login-if-needed is used.",
    )
    install.add_argument("--dotenv", default=None, help="Dotenv path for --auth-source dotenv.")
    install.add_argument("--skip-sync-now", action="store_true", help="Skip the initial export and push.")
    install.add_argument("--skip-agent-start", action="store_true", help="Do not start the detached sync agent.")
    install.add_argument("--skip-autostart", action="store_true", help="Do not register auto-start for the detached sync agent.")
    install.add_argument("--skip-skill-install", action="store_true", help="Do not install the bundled codex-handoff skill.")
    install.add_argument("--agent-interval", type=float, default=15.0, help="Agent polling interval in seconds.")

    subparsers.add_parser("doctor", help="Show local prerequisites and current codex-handoff setup health.")

    receive = subparsers.add_parser("receive", help="One-shot B-PC restore flow: enable, pull, import, and optionally start the agent.")
    receive.add_argument("--profile", default=None, help="Remote profile name. Only `default` is supported.")
    receive.add_argument("--remote-slug", default=None, help="Override the remote repo slug to receive from.")
    receive.add_argument(
        "--summary-mode",
        default="auto",
        choices=["auto", "heuristic", "codex"],
        help="Summary generation mode for future local exports.",
    )
    receive.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")
    receive.add_argument(
        "--login-if-needed",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Create a remote profile automatically if none exists. Defaults to enabled.",
    )
    receive.add_argument(
        "--auth-source",
        default="dotenv",
        choices=["clipboard", "env", "dotenv"],
        help="Where to read R2 credentials from when --login-if-needed is used.",
    )
    receive.add_argument("--dotenv", default=None, help="Dotenv path for --auth-source dotenv.")
    receive.add_argument("--skip-agent-start", action="store_true", help="Do not start the detached sync agent after pull.")
    receive.add_argument("--skip-autostart", action="store_true", help="Do not register auto-start for the detached sync agent.")
    receive.add_argument("--skip-skill-install", action="store_true", help="Do not install the bundled codex-handoff skill.")
    receive.add_argument("--agent-interval", type=float, default=15.0, help="Agent polling interval in seconds.")

    enable = subparsers.add_parser("enable", help="Attach the repo to codex-handoff sync and patch AGENTS.md.")
    enable.add_argument("--profile", default=None, help="Remote profile name. Only `default` is supported.")
    enable.add_argument("--remote-slug", default=None, help="Override the remote repo slug.")
    enable.add_argument(
        "--match-mode",
        default="auto",
        choices=["auto", "existing", "new"],
        help="How to resolve the remote repo when no explicit --remote-slug is provided.",
    )
    enable.add_argument(
        "--summary-mode",
        default="auto",
        choices=["auto", "heuristic", "codex"],
        help="Summary generation mode for exported thread bundles.",
    )
    enable.add_argument(
        "--skip-raw-threads",
        action="store_true",
        help="Do not include original rollout source files in exported thread bundles.",
    )
    enable.add_argument("--sync-now", action="store_true", help="Export and push the repo immediately after enabling.")
    enable.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")
    enable.add_argument(
        "--login-if-needed",
        action="store_true",
        help="If no remote profile exists yet, create it automatically from the requested auth source.",
    )
    enable.add_argument(
        "--auth-source",
        default="clipboard",
        choices=["clipboard", "env", "dotenv"],
        help="Where to read R2 credentials from when --login-if-needed is used.",
    )
    enable.add_argument(
        "--dotenv",
        default=None,
        help="Dotenv path used when --auth-source dotenv is selected. Defaults to ~/.codex-handoff/.env.local.",
    )
    enable.add_argument(
        "--skip-skill-install",
        action="store_true",
        help="Do not install the bundled codex-handoff skill into the local Codex skills directory.",
    )

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

    threads = subparsers.add_parser("threads", help="Inspect, export, and import repo-related Codex threads.")
    thread_subparsers = threads.add_subparsers(dest="threads_command", required=True)

    scan = thread_subparsers.add_parser("scan", help="List local Codex threads whose repo identity matches the repo.")
    scan.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")

    export = thread_subparsers.add_parser("export", help="Export local Codex threads into .codex-handoff bundles.")
    export.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")
    export.add_argument(
        "--summary-mode",
        default="auto",
        choices=["auto", "heuristic", "codex"],
        help="Summary generation mode for exported thread bundles.",
    )
    export.add_argument(
        "--skip-raw-threads",
        action="store_true",
        help="Do not include original rollout source files in exported thread bundles.",
    )

    thread_import = thread_subparsers.add_parser("import", help="Import a bundled thread into the local Codex store.")
    thread_import.add_argument("--thread", required=True, help="Thread id under .codex-handoff/threads/<id>.")
    thread_import.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")

    thread_cleanup = thread_subparsers.add_parser("cleanup", help="Remove a local Codex thread from the local store.")
    thread_cleanup.add_argument("--thread", required=True, help="Thread id to remove from the local Codex store.")
    thread_cleanup.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")
    thread_cleanup.add_argument("--apply", action="store_true", help="Apply changes. Default is dry-run.")

    remote = subparsers.add_parser("remote", help="Manage remote backends and credentials.")
    remote_subparsers = remote.add_subparsers(dest="remote_command", required=True)

    login = remote_subparsers.add_parser("login", help="Register a remote backend profile.")
    login_subparsers = login.add_subparsers(dest="remote_provider", required=True)

    login_r2 = login_subparsers.add_parser("r2", help="Log in to a Cloudflare R2 backend.")
    login_r2.add_argument("--profile", default="default", help="Local profile name. Only `default` is supported.")
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
    login_source_group = login_r2.add_mutually_exclusive_group()
    login_source_group.add_argument(
        "--from-env",
        action="store_true",
        help="Read R2 credentials from environment variables instead of prompting.",
    )
    login_source_group.add_argument(
        "--from-clipboard",
        action="store_true",
        help="Read R2 credentials from the OS clipboard instead of prompting.",
    )
    login_source_group.add_argument(
        "--dotenv",
        default=None,
        help="Read R2 credentials from a dotenv-style file instead of prompting.",
    )
    login_r2.add_argument(
        "--show-setup-info",
        action="store_true",
        help="Print the Cloudflare dashboard URL and a credential template for manual setup.",
    )
    login_r2.add_argument(
        "--open-dashboard",
        action="store_true",
        help="Open the Cloudflare R2 dashboard in the default browser.",
    )

    whoami = remote_subparsers.add_parser("whoami", help="Show the active remote profile.")
    whoami.add_argument("--profile", default=None, help="Profile name. Only `default` is supported.")

    validate = remote_subparsers.add_parser("validate", help="Validate stored credentials against the remote.")
    validate.add_argument("--profile", default=None, help="Profile name. Only `default` is supported.")

    logout = remote_subparsers.add_parser("logout", help="Remove a stored remote profile.")
    logout.add_argument("--profile", default=None, help="Profile name. Only `default` is supported.")

    remote_repos = remote_subparsers.add_parser("repos", help="List remote repo prefixes in the active profile.")
    remote_repos.add_argument("--profile", default=None, help="Profile name. Only `default` is supported.")
    remote_repos.add_argument("--detail", action="store_true", help="Fetch remote repo metadata when available.")

    purge_prefix = remote_subparsers.add_parser("purge-prefix", help="Delete every object under repos/<repo-slug>/.")
    purge_prefix.add_argument("--profile", default=None, help="Profile name. Only `default` is supported.")
    purge_prefix.add_argument("--repo-slug", required=True, help="Remote repo slug under repos/<repo-slug>/ to delete.")
    purge_prefix.add_argument("--apply", action="store_true", help="Apply the deletion. Default is dry-run.")

    purge_thread = remote_subparsers.add_parser("purge-thread", help="Delete one remote thread bundle and re-materialize the prefix root if needed.")
    purge_thread.add_argument("--profile", default=None, help="Profile name. Only `default` is supported.")
    purge_thread.add_argument("--repo-slug", required=True, help="Remote repo slug under repos/<repo-slug>/.")
    purge_thread.add_argument("--thread", required=True, help="Thread id to delete from the remote prefix.")
    purge_thread.add_argument("--apply", action="store_true", help="Apply the deletion. Default is dry-run.")

    sync = subparsers.add_parser("sync", help="Push or pull .codex-handoff bundles to/from the configured remote.")
    sync_subparsers = sync.add_subparsers(dest="sync_command", required=True)

    sync_push = sync_subparsers.add_parser("push", help="Upload the current .codex-handoff tree to the remote.")
    sync_push.add_argument("--profile", default=None, help="Remote profile name. Only `default` is supported.")

    sync_pull = sync_subparsers.add_parser("pull", help="Download the .codex-handoff tree from the remote.")
    sync_pull.add_argument("--profile", default=None, help="Remote profile name. Only `default` is supported.")
    sync_pull.add_argument("--thread", default=None, help="Optional thread id to import into the local Codex store.")
    sync_pull.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")

    sync_now_cmd = sync_subparsers.add_parser("now", help="Export local threads and push them to the remote.")
    sync_now_cmd.add_argument("--profile", default=None, help="Remote profile name. Only `default` is supported.")
    sync_now_cmd.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")
    sync_now_cmd.add_argument(
        "--summary-mode",
        default=None,
        choices=["auto", "heuristic", "codex"],
        help="Override the repo summary mode for this sync run.",
    )
    sync_now_cmd.add_argument(
        "--skip-raw-threads",
        action="store_true",
        help="Do not include original rollout source files in exported thread bundles.",
    )

    sync_watch = sync_subparsers.add_parser("watch", help="Watch local Codex/session changes and push with debounce polling.")
    sync_watch.add_argument("--profile", default=None, help="Remote profile name. Only `default` is supported.")
    sync_watch.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")
    sync_watch.add_argument(
        "--summary-mode",
        default=None,
        choices=["auto", "heuristic", "codex"],
        help="Override the repo summary mode for this watch run.",
    )
    sync_watch.add_argument(
        "--skip-raw-threads",
        action="store_true",
        help="Do not include original rollout source files in exported thread bundles.",
    )
    sync_watch.add_argument("--interval", type=float, default=15.0, help="Polling interval in seconds.")
    sync_watch.add_argument("--no-initial-sync", action="store_true", help="Do not sync immediately when watch starts.")

    sync_subparsers.add_parser("status", help="Show repo sync attachment status.")

    agent = subparsers.add_parser("agent", help="Manage a detached local background sync agent.")
    agent_subparsers = agent.add_subparsers(dest="agent_command", required=True)

    agent_start = agent_subparsers.add_parser("start", help="Start a detached background sync watcher.")
    agent_start.add_argument("--profile", default=None, help="Remote profile name. Only `default` is supported.")
    agent_start.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")
    agent_start.add_argument(
        "--summary-mode",
        default=None,
        choices=["auto", "heuristic", "codex"],
        help="Override the repo summary mode for this agent run.",
    )
    agent_start.add_argument(
        "--skip-raw-threads",
        action="store_true",
        help="Do not include original rollout source files in exported thread bundles.",
    )
    agent_start.add_argument("--interval", type=float, default=15.0, help="Polling interval in seconds.")

    agent_subparsers.add_parser("status", help="Show the current background agent status.")
    agent_subparsers.add_parser("stop", help="Stop the current background agent.")
    agent_subparsers.add_parser("enable", help="Register Windows logon auto-start for the background agent.")
    agent_subparsers.add_parser("disable", help="Remove Windows logon auto-start for the background agent.")

    agent_restart = agent_subparsers.add_parser("restart", help="Restart the current background agent.")
    agent_restart.add_argument("--profile", default=None, help="Remote profile name. Only `default` is supported.")
    agent_restart.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")
    agent_restart.add_argument(
        "--summary-mode",
        default=None,
        choices=["auto", "heuristic", "codex"],
        help="Override the repo summary mode for this agent run.",
    )
    agent_restart.add_argument(
        "--skip-raw-threads",
        action="store_true",
        help="Do not include original rollout source files in exported thread bundles.",
    )
    agent_restart.add_argument("--interval", type=float, default=15.0, help="Polling interval in seconds.")

    skill = subparsers.add_parser("skill", help="Install or inspect the bundled codex-handoff skill.")
    skill_subparsers = skill.add_subparsers(dest="skill_command", required=True)
    skill_install = skill_subparsers.add_parser("install", help="Install the bundled codex-handoff skill into ~/.codex/skills.")
    skill_install.add_argument("--skills-dir", default=None, help="Override the target skills directory.")
    skill_subparsers.add_parser("status", help="Show the current bundled skill installation path.")

    return parser


def _write_or_print(output: str, output_path: Optional[str]) -> None:
    if not output_path:
        print(output, end="")
        return
    path = Path(output_path).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(output, encoding="utf-8")
    print(path)


def _print_command_result(result: dict) -> None:
    if result.get("selection_required"):
        print(_format_selection_required_text(result), end="")
        return
    print(json.dumps(result, ensure_ascii=False, indent=2))


def _format_selection_required_text(result: dict) -> str:
    enable_result = result.get("enable_result", result)
    current_project = enable_result.get("current_project", {})
    candidates = enable_result.get("remote_candidates", [])
    recommended = enable_result.get("recommended_remote_project_id")
    lines = [
        "Remote project selection is required.",
        "",
        f"Current project: {current_project.get('project_name') or ''}",
        f"Workspace root: {current_project.get('workspace_root') or result.get('repo') or ''}",
        "",
    ]
    if enable_result.get("message"):
        lines.append(enable_result["message"])
        lines.append("")
    lines.append("Candidates:")
    for index, item in enumerate(candidates, start=1):
        repo_slug = item.get("repo_slug", "")
        marker = " (recommended)" if recommended and repo_slug == recommended else ""
        project_name = item.get("project_name") or ""
        repo_path = item.get("repo_path") or ""
        score = item.get("score")
        reasons = ", ".join(item.get("reasons", []))
        line = f"{index}. {repo_slug}{marker}"
        if project_name:
            line += f" | project_name={project_name}"
        if repo_path:
            line += f" | repo_path={repo_path}"
        if score is not None:
            line += f" | score={score}"
        if reasons:
            line += f" | reasons={reasons}"
        lines.append(line)
    lines.extend(
        [
            "",
            "Choose one remote project id and re-run with:",
            "  codex-handoff receive --remote-slug <remote-project-id>",
        ]
    )
    return "\n".join(lines).strip() + "\n"


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    repo = resolve_repo_path(args.repo)
    memory_dir = resolve_memory_dir(repo, args.memory_dir)

    try:
        if args.command == "status":
            print(render_status(repo, memory_dir), end="")
            return 0

        if args.command == "enable":
            _print_command_result(_handle_enable(repo, memory_dir, args))
            return 0

        if args.command == "install":
            _print_command_result(_handle_install(repo, memory_dir, args))
            return 0

        if args.command == "doctor":
            print(json.dumps(_handle_doctor(repo, memory_dir), ensure_ascii=False, indent=2))
            return 0

        if args.command == "receive":
            _print_command_result(_handle_receive(repo, memory_dir, args))
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

        if args.command == "threads":
            print(json.dumps(_handle_threads(repo, memory_dir, args), ensure_ascii=False, indent=2))
            return 0

        if args.command == "remote":
            return _handle_remote(args)

        if args.command == "sync":
            print(json.dumps(_handle_sync(repo, memory_dir, args), ensure_ascii=False, indent=2))
            return 0

        if args.command == "agent":
            print(json.dumps(_handle_agent(repo, memory_dir, args), ensure_ascii=False, indent=2))
            return 0

        if args.command == "skill":
            print(json.dumps(_handle_skill(repo, args), ensure_ascii=False, indent=2))
            return 0
    except (R2Error, SecretStoreError, R2CredentialSourceError, ThreadImportMismatchError) as error:
        raise SystemExit(str(error)) from error

    parser.error(f"unknown command: {args.command}")
    return 2


def _handle_remote(args: argparse.Namespace) -> int:
    if args.remote_command == "login" and args.remote_provider == "r2":
        if args.show_setup_info or args.open_dashboard:
            payload = {
                "dashboard_url": r2_dashboard_url(),
                "credential_template": r2_credential_template(),
                "opened_browser": bool(args.open_dashboard and open_r2_dashboard()),
            }
            if args.show_setup_info and not any(
                [
                    args.account_id,
                    args.bucket,
                    args.access_key_id,
                    args.secret_access_key,
                    args.from_env,
                    args.from_clipboard,
                    args.dotenv,
                ]
            ):
                print(json.dumps(payload, ensure_ascii=False, indent=2))
                return 0
        print(json.dumps(_perform_r2_login(args), ensure_ascii=False, indent=2))
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

    if args.remote_command == "repos":
        profile_name, profile = _load_remote_profile(args.profile)
        r2_profile = _build_r2_profile(profile_name, profile)
        slugs = _list_remote_repo_slugs(r2_profile)
        payload = {"profile": profile_name, "repo_slugs": slugs}
        if args.detail:
            payload["repos"] = [_fetch_remote_repo_detail(r2_profile, slug) for slug in slugs]
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    if args.remote_command == "purge-prefix":
        profile_name, profile = _load_remote_profile(args.profile)
        r2_profile = _build_r2_profile(profile_name, profile)
        payload = _purge_remote_prefix(r2_profile, args.repo_slug, apply=args.apply)
        payload["profile"] = profile_name
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    if args.remote_command == "purge-thread":
        profile_name, profile = _load_remote_profile(args.profile)
        r2_profile = _build_r2_profile(profile_name, profile)
        payload = _purge_remote_thread(r2_profile, args.repo_slug, args.thread, apply=args.apply)
        payload["profile"] = profile_name
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    raise SystemExit(f"unsupported remote command: {args.remote_command}")


def _handle_enable(repo: Path, memory_dir: Path, args: argparse.Namespace) -> dict:
    ensure_memory_layout(memory_dir)
    try:
        profile_name, profile_payload = _load_remote_profile(args.profile)
    except SystemExit:
        if not args.login_if_needed:
            raise
        login_args = argparse.Namespace(
            profile=args.profile or "default",
            account_id=None,
            bucket=None,
            access_key_id=None,
            secret_access_key=None,
            endpoint=None,
            memory_prefix="projects/",
            skip_validate=False,
            from_env=args.auth_source == "env",
            from_clipboard=args.auth_source == "clipboard",
            dotenv=_resolve_default_dotenv_path(args.dotenv) if args.auth_source == "dotenv" else None,
            show_setup_info=False,
            open_dashboard=False,
        )
        _perform_r2_login(login_args)
        profile_name, profile_payload = _load_remote_profile(args.profile or "default")
    r2_profile = _build_r2_profile(profile_name, profile_payload)
    remote_details = _list_remote_repo_details(r2_profile)
    remote_slugs = [item["repo_slug"] for item in remote_details]
    config_payload = load_config()
    machine_id = ensure_machine_id(config_payload)
    current_project = describe_current_project(repo)
    match_result = _resolve_repo_slug(repo, memory_dir, args, remote_details, current_project)
    if match_result.get("selection_required"):
        return {
            "repo": str(repo),
            "memory_dir": str(memory_dir),
            "machine_id": machine_id,
            "selection_required": True,
            "current_project": current_project,
            "remote_candidates": match_result["remote_candidates"],
            "recommended_remote_project_id": match_result.get("recommended_remote_project_id"),
            "message": match_result["message"],
        }
    resolved_slug = match_result["repo_slug"]
    match_status = match_result["match_status"]
    repo_state = build_repo_state(
        repo,
        profile_name=profile_name,
        machine_id=machine_id,
        codex_project=current_project,
        remote_slug=resolved_slug,
        include_raw_threads=not args.skip_raw_threads,
        summary_mode=args.summary_mode,
        match_mode=args.match_mode,
        match_status=match_status,
    )
    save_repo_state(memory_dir, repo_state)
    register_repo_mapping(config_payload, repo, repo_state)
    if not args.skip_skill_install:
        skill_path = install_skill(repo)
        repo_state["installed_skill_path"] = str(skill_path)
        save_repo_state(memory_dir, repo_state)
        register_repo_mapping(config_payload, repo, repo_state)
    gitignore_path = ensure_memory_dir_gitignored(repo, memory_dir)
    ensure_agents_block(repo, repo_state)
    save_config(config_payload)
    result = {
        "repo": str(repo),
        "memory_dir": str(memory_dir),
        "machine_id": machine_id,
        "repo_slug": repo_state["repo_slug"],
        "remote_profile": profile_name,
        "remote_prefix": repo_state["remote_prefix"],
        "current_project": current_project,
        "summary_mode": repo_state["summary_mode"],
        "include_raw_threads": repo_state["include_raw_threads"],
        "match_mode": repo_state["match_mode"],
        "match_status": repo_state["match_status"],
        "remote_candidates": remote_slugs,
        "remote_candidate_details": remote_details,
        "agents_path": str(repo / "AGENTS.md"),
        "gitignore_path": str(gitignore_path) if gitignore_path else None,
        "installed_skill_path": repo_state.get("installed_skill_path"),
        "sync_now": False,
    }
    if args.sync_now:
        sync_result = sync_now(
            repo,
            memory_dir,
            r2_profile,
            codex_home=args.codex_home,
            summary_mode=repo_state["summary_mode"],
            include_raw_threads=repo_state["include_raw_threads"],
            prefix=repo_state["remote_prefix"],
        )
        result["sync_now"] = True
        result["sync_result"] = sync_result
    return result


def _handle_install(repo: Path, memory_dir: Path, args: argparse.Namespace) -> dict:
    enable_args = argparse.Namespace(
        profile=args.profile,
        remote_slug=args.remote_slug,
        match_mode=args.match_mode,
        summary_mode=args.summary_mode,
        skip_raw_threads=args.skip_raw_threads,
        sync_now=False,
        codex_home=args.codex_home,
        login_if_needed=args.login_if_needed,
        auth_source=args.auth_source,
        dotenv=args.dotenv,
        skip_skill_install=args.skip_skill_install,
    )
    enable_result = _handle_enable(repo, memory_dir, enable_args)
    if enable_result.get("selection_required"):
        return {
            "repo": str(repo),
            "install": True,
            "selection_required": True,
            "enable_result": enable_result,
            "sync_action": None,
            "sync_result": None,
            "autostart_result": None,
            "autostart_error": None,
            "agent_result": None,
        }
    sync_result = None
    sync_action = None
    if not args.skip_sync_now:
        sync_args = argparse.Namespace(
            profile=args.profile,
            codex_home=args.codex_home,
            summary_mode=args.summary_mode,
            skip_raw_threads=args.skip_raw_threads,
            thread=None,
            interval=args.agent_interval,
            no_initial_sync=True,
        )
        remote_exists = enable_result["repo_slug"] in enable_result.get("remote_candidates", [])
        if remote_exists:
            sync_args.sync_command = "pull"
            sync_result = _handle_sync(repo, memory_dir, sync_args)
            sync_action = "pull"
        else:
            sync_args.sync_command = "now"
            sync_result = _handle_sync(repo, memory_dir, sync_args)
            sync_action = "push"
    autostart_result = None
    autostart_error = None
    if not args.skip_autostart:
        autostart_args = argparse.Namespace(agent_command="enable", profile=args.profile, codex_home=args.codex_home, summary_mode=args.summary_mode, skip_raw_threads=args.skip_raw_threads, interval=args.agent_interval)
        try:
            autostart_result = _handle_agent(repo, memory_dir, autostart_args)
        except Exception as error:
            autostart_error = str(error)
    agent_result = None
    if not args.skip_agent_start:
        agent_args = argparse.Namespace(
            agent_command="start",
            profile=args.profile,
            codex_home=args.codex_home,
            summary_mode=args.summary_mode,
            skip_raw_threads=args.skip_raw_threads,
            interval=args.agent_interval,
        )
        agent_result = _handle_agent(repo, memory_dir, agent_args)
    return {
        "repo": str(repo),
        "install": True,
        "enable_result": enable_result,
        "sync_action": sync_action,
        "sync_result": sync_result,
        "autostart_result": autostart_result,
        "autostart_error": autostart_error,
        "agent_result": agent_result,
    }


def _handle_receive(repo: Path, memory_dir: Path, args: argparse.Namespace) -> dict:
    enable_args = argparse.Namespace(
        profile=args.profile,
        remote_slug=args.remote_slug,
        match_mode="existing",
        summary_mode=args.summary_mode,
        skip_raw_threads=False,
        sync_now=False,
        codex_home=args.codex_home,
        login_if_needed=args.login_if_needed,
        auth_source=args.auth_source,
        dotenv=args.dotenv,
        skip_skill_install=args.skip_skill_install,
    )
    enable_result = _handle_enable(repo, memory_dir, enable_args)
    if enable_result.get("selection_required"):
        return {
            "repo": str(repo),
            "receive": True,
            "selection_required": True,
            "enable_result": enable_result,
            "sync_action": None,
            "sync_result": None,
            "autostart_result": None,
            "autostart_error": None,
            "agent_result": None,
        }
    sync_args = argparse.Namespace(
        sync_command="pull",
        profile=args.profile,
        codex_home=args.codex_home,
        thread=None,
    )
    sync_result = _handle_sync(repo, memory_dir, sync_args)
    autostart_result = None
    autostart_error = None
    if not args.skip_autostart:
        autostart_args = argparse.Namespace(
            agent_command="enable",
            profile=args.profile,
            codex_home=args.codex_home,
            summary_mode=args.summary_mode,
            skip_raw_threads=False,
            interval=args.agent_interval,
        )
        try:
            autostart_result = _handle_agent(repo, memory_dir, autostart_args)
        except Exception as error:
            autostart_error = str(error)
    agent_result = None
    if not args.skip_agent_start:
        agent_args = argparse.Namespace(
            agent_command="start",
            profile=args.profile,
            codex_home=args.codex_home,
            summary_mode=args.summary_mode,
            skip_raw_threads=False,
            interval=args.agent_interval,
        )
        agent_result = _handle_agent(repo, memory_dir, agent_args)
    return {
        "repo": str(repo),
        "receive": True,
        "enable_result": enable_result,
        "sync_action": "pull",
        "sync_result": sync_result,
        "autostart_result": autostart_result,
        "autostart_error": autostart_error,
        "agent_result": agent_result,
    }


def _handle_doctor(repo: Path, memory_dir: Path) -> dict:
    repo_state = load_repo_state(memory_dir)
    sync_report = describe_sync_state(memory_dir)
    global_dotenv = ensure_global_dotenv_template()
    remote_ok = False
    remote_error = None
    try:
        profile_name, _profile = _load_remote_profile(None)
        remote_ok = True
    except SystemExit as error:
        profile_name = None
        remote_error = str(error)
    repo_state_consistent, repo_state_warning = _validate_repo_state_consistency(repo, repo_state)

    return {
        "repo": str(repo),
        "memory_dir": str(memory_dir),
        "python": shutil.which("python") or shutil.which("python3"),
        "node": shutil.which("node"),
        "npm": shutil.which("npm"),
        "codex": preferred_codex_cli(),
        "global_dotenv_path": str(global_dotenv),
        "global_dotenv_exists": global_dotenv.exists(),
        "preferred_dotenv_path": _resolve_default_dotenv_path(None),
        "skill_path": str(installed_skill_path()),
        "skill_installed": installed_skill_path().exists(),
        "repo_enabled": bool(repo_state),
        "repo_state_consistent": repo_state_consistent,
        "repo_state_warning": repo_state_warning,
        "repo_state": repo_state,
        "sync_state_path": sync_report["sync_state_path"],
        "sync_state": sync_report["sync_state"],
        "sync_health": sync_report["sync_health"],
        "remote_profile": profile_name,
        "remote_configured": remote_ok,
        "remote_error": remote_error,
        "agents_path": str(repo / "AGENTS.md"),
        "agents_exists": (repo / "AGENTS.md").exists(),
    }


def _handle_threads(repo: Path, memory_dir: Path, args: argparse.Namespace) -> dict:
    if args.threads_command == "scan":
        threads = discover_threads_for_repo(repo, args.codex_home)
        return {
            "repo": str(repo),
            "thread_count": len(threads),
            "threads": [
                {
                    "thread_id": thread.thread_id,
                    "title": thread.title,
                    "cwd": str(thread.cwd),
                    "rollout_path": str(thread.rollout_path),
                    "updated_at": thread.updated_at,
                    "thread_name": (thread.session_index_entry or {}).get("thread_name"),
                }
                for thread in threads
            ],
        }

    if args.threads_command == "export":
        threads = export_repo_threads(
            repo,
            memory_dir,
            codex_home=args.codex_home,
            summary_mode=args.summary_mode,
            include_raw_threads=not args.skip_raw_threads,
        )
        return {
            "repo": str(repo),
            "memory_dir": str(memory_dir),
            "thread_count": len(threads),
            "current_thread": threads[0].thread_id if threads else None,
        }

    if args.threads_command == "import":
        result = import_thread_bundle_to_codex(
            repo,
            memory_dir,
            args.thread,
            codex_home=args.codex_home,
        )
        return {
            "repo": str(repo),
            "thread_id": args.thread,
            "import_result": result,
        }

    if args.threads_command == "cleanup":
        result = cleanup_thread(codex_paths(args.codex_home), args.thread, apply=args.apply)
        return {
            "repo": str(repo),
            "thread_id": args.thread,
            "cleanup_result": result,
        }

    raise SystemExit(f"unsupported threads command: {args.threads_command}")


def _handle_sync(repo: Path, memory_dir: Path, args: argparse.Namespace) -> dict:
    repo_state = _require_repo_state(memory_dir)
    profile_name = getattr(args, "profile", None) or repo_state.get("remote_profile")
    profile_name, profile_payload = _load_remote_profile(profile_name)
    r2_profile = _build_r2_profile(profile_name, profile_payload)
    prefix = repo_state["remote_prefix"]

    if args.sync_command == "status":
        current_thread = None
        if current_thread_path(memory_dir).exists():
            current_thread = json.loads(current_thread_path(memory_dir).read_text(encoding="utf-8")).get("thread_id")
        return _augment_sync_result(
            memory_dir,
            repo_state,
            {
                "repo": str(repo),
                "memory_dir": str(memory_dir),
                "repo_slug": repo_state["repo_slug"],
                "remote_profile": profile_name,
                "remote_prefix": prefix,
                "current_thread": current_thread,
            },
        )

    if args.sync_command == "push":
        uploaded = push_memory_tree(r2_profile, memory_dir, prefix)
        record_sync_event(
            memory_dir,
            repo=repo,
            prefix=prefix,
            direction="push",
            command="push",
            objects_uploaded=len(uploaded),
        )
        return _augment_sync_result(
            memory_dir,
            repo_state,
            {
                "repo": str(repo),
                "repo_slug": repo_state["repo_slug"],
                "remote_profile": profile_name,
                "remote_prefix": prefix,
                "prefix": prefix,
                "uploaded_objects": len(uploaded),
            },
        )

    if args.sync_command == "pull":
        downloaded = pull_memory_tree(r2_profile, memory_dir, prefix)
        thread_id = args.thread
        if thread_id is None and current_thread_path(memory_dir).exists():
            thread_id = json.loads(current_thread_path(memory_dir).read_text(encoding="utf-8")).get("thread_id")
        imported = None
        if thread_id:
            imported = import_thread_bundle_to_codex(repo, memory_dir, thread_id, codex_home=args.codex_home)
        record_sync_event(
            memory_dir,
            repo=repo,
            prefix=prefix,
            direction="pull",
            command="pull",
            downloaded_objects=len(downloaded),
            imported_thread=imported,
        )
        return _augment_sync_result(
            memory_dir,
            repo_state,
            {
                "repo": str(repo),
                "repo_slug": repo_state["repo_slug"],
                "remote_profile": profile_name,
                "remote_prefix": prefix,
                "prefix": prefix,
                "downloaded_objects": len(downloaded),
                "imported_thread": imported,
            },
        )

    if args.sync_command == "now":
        summary_mode = args.summary_mode or repo_state.get("summary_mode", "auto")
        include_raw_threads = repo_state.get("include_raw_threads", True) and not args.skip_raw_threads
        return _augment_sync_result(
            memory_dir,
            repo_state,
            sync_now(
                repo,
                memory_dir,
                r2_profile,
                codex_home=args.codex_home,
                summary_mode=summary_mode,
                include_raw_threads=include_raw_threads,
                prefix=prefix,
            ),
        )

    if args.sync_command == "watch":
        summary_mode = background_safe_summary_mode(args.summary_mode or repo_state.get("summary_mode", "auto"))
        include_raw_threads = repo_state.get("include_raw_threads", True) and not args.skip_raw_threads
        watch_and_sync(
            repo,
            memory_dir,
            r2_profile,
            codex_home=args.codex_home,
            summary_mode=summary_mode,
            include_raw_threads=include_raw_threads,
            prefix=prefix,
            interval_seconds=args.interval,
            initial_sync=not args.no_initial_sync,
        )
        return {"repo": str(repo), "watching": True, "prefix": prefix, "interval_seconds": args.interval}

    raise SystemExit(f"unsupported sync command: {args.sync_command}")


def _handle_agent(repo: Path, memory_dir: Path, args: argparse.Namespace) -> dict:
    repo_state = _require_repo_state(memory_dir)
    profile_name = getattr(args, "profile", None) or repo_state.get("remote_profile")
    summary_mode = getattr(args, "summary_mode", None) or repo_state.get("summary_mode", "auto")
    include_raw_threads = repo_state.get("include_raw_threads", True) and not getattr(args, "skip_raw_threads", False)

    if args.agent_command == "status":
        payload = status_payload(repo_state["repo_slug"])
        payload["autostart"] = autostart_status(repo_state["repo_slug"])
        return payload

    if args.agent_command == "stop":
        return stop_agent(repo_state["repo_slug"])

    if args.agent_command == "enable":
        return enable_autostart(
            repo=repo,
            repo_slug=repo_state["repo_slug"],
            profile_name=profile_name,
            interval_seconds=getattr(args, "interval", 15.0),
            summary_mode=summary_mode,
            include_raw_threads=include_raw_threads,
            codex_home=getattr(args, "codex_home", None),
        )

    if args.agent_command == "disable":
        return disable_autostart(repo_state["repo_slug"])

    if args.agent_command == "start":
        return start_agent(
            repo=repo,
            repo_slug=repo_state["repo_slug"],
            profile_name=profile_name,
            interval_seconds=args.interval,
            summary_mode=summary_mode,
            include_raw_threads=include_raw_threads,
            codex_home=args.codex_home,
            initial_sync=False,
        )

    if args.agent_command == "restart":
        return restart_agent(
            repo=repo,
            repo_slug=repo_state["repo_slug"],
            profile_name=profile_name,
            interval_seconds=args.interval,
            summary_mode=summary_mode,
            include_raw_threads=include_raw_threads,
            codex_home=args.codex_home,
            initial_sync=False,
        )

    raise SystemExit(f"unsupported agent command: {args.agent_command}")


def _handle_skill(repo: Path, args: argparse.Namespace) -> dict:
    if args.skill_command == "install":
        path = install_skill(repo, Path(args.skills_dir).expanduser().resolve() if args.skills_dir else None)
        return {"installed": True, "skill_path": str(path)}
    if args.skill_command == "status":
        path = installed_skill_path()
        return {"installed": path.exists(), "skill_path": str(path)}
    raise SystemExit(f"unsupported skill command: {args.skill_command}")


def _augment_sync_result(memory_dir: Path, repo_state: dict, payload: dict) -> dict:
    result = dict(payload)
    sync_report = describe_sync_state(memory_dir)
    result.setdefault("repo_slug", repo_state.get("repo_slug"))
    result.setdefault("remote_profile", repo_state.get("remote_profile"))
    result.setdefault("remote_prefix", repo_state.get("remote_prefix") or result.get("prefix"))
    result.setdefault("prefix", result.get("remote_prefix"))
    if result.get("current_thread") is None:
        result["current_thread"] = sync_report["sync_health"].get("current_thread")
    if result.get("thread_count") is None:
        result["thread_count"] = sync_report["sync_health"].get("thread_count")
    if result.get("thread_ids") is None:
        result["thread_ids"] = sync_report["sync_health"].get("thread_ids")
    result["sync_state_path"] = sync_report["sync_state_path"]
    result["sync_state"] = sync_report["sync_state"]
    result["sync_health"] = build_sync_health(memory_dir, sync_report["sync_state"] or {})
    return result


def _load_remote_profile(explicit_profile: Optional[str]) -> tuple[str, dict]:
    payload = load_config()
    profiles = payload.get("profiles", {})
    requested = _single_remote_profile_name(explicit_profile) if explicit_profile else None
    profile_name = requested or payload.get("default_profile") or SINGLE_REMOTE_PROFILE
    if not profile_name:
        raise SystemExit("No remote profile is configured. Run `codex-handoff remote login r2` first.")
    profile = profiles.get(profile_name)
    if not profile:
        raise SystemExit(f"Remote profile not found: {profile_name}")
    if profile.get("provider") != "cloudflare-r2":
        raise SystemExit(f"Unsupported provider in profile {profile_name}: {profile.get('provider')}")
    return profile_name, profile


def _build_r2_profile(profile_name: str, profile: dict) -> R2Profile:
    secret = read_secret(profile["secret_backend"], profile["secret_ref"], profile_name)
    return R2Profile(
        account_id=profile["account_id"],
        access_key_id=profile["access_key_id"],
        secret_access_key=secret,
        bucket=profile["bucket"],
        endpoint=profile["endpoint"],
        region=profile.get("region", "auto"),
        memory_prefix=profile.get("memory_prefix", "projects/"),
    )


def _require_repo_state(memory_dir: Path) -> dict:
    repo_state = load_repo_state(memory_dir)
    if not repo_state:
        raise SystemExit("This repo is not enabled for codex-handoff yet. Run `codex-handoff --repo . enable` first.")
    return repo_state


def _validate_repo_state_consistency(repo: Path, repo_state: dict) -> tuple[bool, Optional[str]]:
    if not repo_state:
        return True, None
    stored_repo_path = repo_state.get("repo_path")
    if isinstance(stored_repo_path, str) and stored_repo_path and normalize_cwd(stored_repo_path) != normalize_cwd(repo):
        return False, f"repo.json points to {stored_repo_path} instead of {repo}"
    stored_origin = normalize_git_origin_url(str(repo_state.get("git_origin_url") or ""))
    current_origin = normalize_git_origin_url(git_origin_url(repo))
    if stored_origin and current_origin and stored_origin != current_origin:
        return False, f"repo.json git origin {repo_state.get('git_origin_url')} does not match current repo origin {git_origin_url(repo)}"
    return True, None


def _perform_r2_login(args: argparse.Namespace) -> dict:
    profile_name = _single_remote_profile_name(args.profile)
    source_payload = _load_r2_credentials_from_source(args)
    account_id = args.account_id or source_payload.get("account_id") or input("Cloudflare Account ID: ").strip()
    bucket = args.bucket or source_payload.get("bucket") or input("R2 Bucket: ").strip()
    access_key_id = args.access_key_id or source_payload.get("access_key_id") or input("R2 Access Key ID: ").strip()
    secret_access_key = (
        args.secret_access_key
        or source_payload.get("secret_access_key")
        or getpass.getpass("R2 Secret Access Key: ").strip()
    )
    endpoint = args.endpoint or source_payload.get("endpoint") or f"https://{account_id}.r2.cloudflarestorage.com"

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
    ensure_machine_id(payload)
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
    return {"profile": profile_name, "config_path": str(path), "validated": bool(validation_result)}


def _load_r2_credentials_from_source(args: argparse.Namespace) -> dict:
    if getattr(args, "from_env", False):
        return read_r2_credentials_from_env()
    if getattr(args, "from_clipboard", False):
        return read_r2_credentials_from_clipboard()
    if getattr(args, "dotenv", None):
        return read_r2_credentials_from_dotenv(args.dotenv)
    return {}


def _resolve_default_dotenv_path(explicit_path: Optional[str]) -> str:
    if explicit_path:
        return explicit_path
    return str(ensure_global_dotenv_template())


def _purge_remote_prefix(profile: R2Profile, repo_slug: str, *, apply: bool) -> dict:
    _assert_remote_repo_not_running(repo_slug)
    prefix = f"repos/{repo_slug}/"
    keys = [item["key"] for item in list_r2_objects(profile, prefix=prefix)]
    payload = {
        "repo_slug": repo_slug,
        "prefix": prefix,
        "object_count": len(keys),
        "keys": keys[:50],
        "applied": apply,
    }
    if not apply:
        return payload
    for key in keys:
        delete_r2_object(profile, key)
    payload["deleted_keys"] = len(keys)
    return payload


def _purge_remote_thread(profile: R2Profile, repo_slug: str, thread_id: str, *, apply: bool) -> dict:
    _assert_remote_repo_not_running(repo_slug)
    prefix = f"repos/{repo_slug}/"
    thread_prefix = f"{prefix}threads/{thread_id}/"
    thread_keys = [item["key"] for item in list_r2_objects(profile, prefix=thread_prefix)]
    thread_index_key = f"{prefix}thread-index.json"
    current_thread_key = f"{prefix}current-thread.json"
    current_thread_id = _read_remote_current_thread(profile, current_thread_key)
    thread_index = _read_remote_thread_index(profile, thread_index_key)
    remaining_index = [item for item in thread_index if item.get("thread_id") != thread_id]
    next_thread_id = remaining_index[0]["thread_id"] if remaining_index else None

    payload = {
        "repo_slug": repo_slug,
        "thread_id": thread_id,
        "thread_prefix": thread_prefix,
        "object_count": len(thread_keys),
        "keys": thread_keys[:50],
        "current_thread_id": current_thread_id,
        "next_thread_id": next_thread_id if current_thread_id == thread_id else None,
        "applied": apply,
    }
    if not apply:
        return payload

    for key in thread_keys:
        delete_r2_object(profile, key)

    if remaining_index:
        _put_remote_json(profile, thread_index_key, remaining_index)
    else:
        delete_r2_object(profile, thread_index_key)

    if current_thread_id == thread_id:
        if next_thread_id:
            _rematerialize_remote_root_from_thread(profile, prefix, next_thread_id)
        else:
            _delete_remote_keys_if_present(
                profile,
                [
                    current_thread_key,
                    f"{prefix}latest.md",
                    f"{prefix}handoff.json",
                    f"{prefix}raw/session.jsonl",
                ],
            )
    payload["deleted_keys"] = len(thread_keys)
    payload["remaining_threads"] = [item["thread_id"] for item in remaining_index]
    return payload


def _assert_remote_repo_not_running(repo_slug: str) -> None:
    agent = status_payload(repo_slug)
    if agent.get("running"):
        raise SystemExit(f"Stop the running agent for {repo_slug} before deleting remote objects.")


def _read_remote_json(profile: R2Profile, key: str) -> Optional[object]:
    try:
        return json.loads(get_r2_object(profile, key).decode("utf-8"))
    except Exception:
        return None


def _put_remote_json(profile: R2Profile, key: str, payload: object) -> None:
    put_r2_object(profile, key, (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def _read_remote_thread_index(profile: R2Profile, key: str) -> list[dict]:
    payload = _read_remote_json(profile, key)
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return []


def _read_remote_current_thread(profile: R2Profile, key: str) -> Optional[str]:
    payload = _read_remote_json(profile, key)
    if isinstance(payload, dict) and isinstance(payload.get("thread_id"), str):
        return payload["thread_id"]
    return None


def _rematerialize_remote_root_from_thread(profile: R2Profile, prefix: str, thread_id: str) -> None:
    root_targets = {
        f"{prefix}latest.md": f"{prefix}threads/{thread_id}/latest.md",
        f"{prefix}handoff.json": f"{prefix}threads/{thread_id}/handoff.json",
        f"{prefix}raw/session.jsonl": f"{prefix}threads/{thread_id}/raw/session.jsonl",
    }
    for root_key, source_key in root_targets.items():
        put_r2_object(profile, root_key, get_r2_object(profile, source_key))
    _put_remote_json(profile, f"{prefix}current-thread.json", {"thread_id": thread_id})


def _delete_remote_keys_if_present(profile: R2Profile, keys: list[str]) -> None:
    existing = {item["key"] for item in list_r2_objects(profile, prefix="")}
    for key in keys:
        if key in existing:
            delete_r2_object(profile, key)


def _list_remote_repo_slugs(profile: R2Profile) -> list[str]:
    return [item["repo_slug"] for item in _list_remote_repo_details(profile)]


def _list_remote_repo_details(profile: R2Profile) -> list[dict]:
    keys = [item["key"] for item in list_r2_objects(profile, prefix="repos/")]
    slugs = sorted({key.split("/", 2)[1] for key in keys if key.startswith("repos/") and len(key.split("/", 2)) >= 2})
    return [_fetch_remote_repo_detail(profile, slug) for slug in slugs]


def _fetch_remote_repo_detail(profile: R2Profile, slug: str) -> dict:
    for candidate in [f"repos/{slug}/repo.json", f"repos/{slug}/manifest.json"]:
        try:
            payload = json.loads(get_r2_object(profile, candidate).decode("utf-8"))
            payload.setdefault("repo_slug", slug)
            payload.setdefault("manifest_key", candidate)
            return payload
        except Exception:
            continue
    return {"repo_slug": slug}


def _resolve_repo_slug(
    repo: Path,
    memory_dir: Path,
    args: argparse.Namespace,
    remote_details: list[dict],
    current_project: dict,
) -> dict:
    if args.remote_slug:
        return {"repo_slug": args.remote_slug, "match_status": "explicit"}

    existing = load_repo_state(memory_dir)
    if existing.get("repo_slug"):
        return {"repo_slug": str(existing["repo_slug"]), "match_status": "existing_local"}

    inferred = infer_repo_slug(repo)
    remote_slugs = [item["repo_slug"] for item in remote_details]
    if args.match_mode == "existing":
        return _resolve_existing_remote_match(repo, inferred, remote_details, current_project)
    if args.match_mode == "new":
        return {"repo_slug": inferred, "match_status": "create_new"}
    if inferred in remote_slugs:
        return {"repo_slug": inferred, "match_status": "matched_remote_inferred"}
    if remote_details:
        best = _best_remote_candidate(repo, inferred, remote_details, current_project, strong_only=True)
        if best is not None:
            return {"repo_slug": best["repo_slug"], "match_status": "matched_remote_best_candidate"}
    return {"repo_slug": inferred, "match_status": "create_new"}


def _resolve_existing_remote_match(repo: Path, inferred_slug: str, remote_details: list[dict], current_project: dict) -> dict:
    remote_slugs = [item["repo_slug"] for item in remote_details]
    if inferred_slug in remote_slugs:
        return {"repo_slug": inferred_slug, "match_status": "matched_remote_inferred"}
    if len(remote_details) == 1:
        return {"repo_slug": remote_details[0]["repo_slug"], "match_status": "matched_remote_single_candidate"}
    best = _best_remote_candidate(repo, inferred_slug, remote_details, current_project)
    if best is not None:
        return {"repo_slug": best["repo_slug"], "match_status": "matched_remote_best_candidate"}
    ranked = _rank_remote_candidates(repo, inferred_slug, remote_details, current_project)
    return {
        "selection_required": True,
        "recommended_remote_project_id": ranked[0]["repo_slug"] if ranked and ranked[0]["score"] > 0 else None,
        "remote_candidates": ranked,
        "message": _remote_selection_required_message(repo, inferred_slug, current_project, remote_details),
    }


def _best_remote_candidate(
    repo: Path,
    inferred_slug: str,
    remote_details: list[dict],
    current_project: dict,
    *,
    strong_only: bool = False,
) -> Optional[dict]:
    ranked = _rank_remote_candidates(repo, inferred_slug, remote_details, current_project)
    if strong_only:
        ranked = [item for item in ranked if _is_strong_remote_match(item)]
    if not ranked or ranked[0]["score"] <= 0:
        return None
    if len(ranked) > 1 and ranked[0]["score"] == ranked[1]["score"]:
        return None
    return ranked[0]


def _rank_remote_candidates(repo: Path, inferred_slug: str, remote_details: list[dict], current_project: dict) -> list[dict]:
    repo_name = repo.name.lower()
    repo_origin = (git_origin_url(repo) or "").strip().lower()
    project_name = str(current_project.get("project_name") or repo.name).strip().lower()
    scored = []
    for item in remote_details:
        score = 0
        reasons = []
        if item.get("repo_slug") == inferred_slug:
            score += 100
            reasons.append("slug")
        candidate_origin = str(item.get("git_origin_url") or "").strip().lower()
        if repo_origin and candidate_origin and repo_origin == candidate_origin:
            score += 80
            reasons.append("git_origin")
        candidate_path_name = Path(str(item.get("repo_path", repo_name))).name.lower() if item.get("repo_path") else ""
        if candidate_path_name and candidate_path_name == repo_name:
            score += 20
            reasons.append("repo_name")
        candidate_project_name = str(item.get("project_name") or "").strip().lower()
        if candidate_project_name and candidate_project_name == project_name:
            score += 25
            reasons.append("project_name")
        if repo_name and repo_name in str(item.get("repo_slug", "")):
            score += 5
            reasons.append("slug_contains_repo_name")
        enriched = dict(item)
        enriched["score"] = score
        enriched["reasons"] = reasons
        scored.append(enriched)
    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored


def _is_strong_remote_match(candidate: dict) -> bool:
    reasons = set(candidate.get("reasons") or [])
    return "slug" in reasons or "git_origin" in reasons


def _remote_selection_required_message(repo: Path, inferred_slug: str, current_project: dict, remote_details: list[dict]) -> str:
    lines = [
        "Multiple remote repos are available and codex-handoff could not safely choose one automatically.",
        f"- local repo path: {repo}",
        f"- current project name: {current_project.get('project_name') or repo.name}",
        f"- inferred slug: {inferred_slug}",
        "- remote candidates:",
    ]
    for item in remote_details:
        lines.append(
            f"  - {item.get('repo_slug')} (project_name={item.get('project_name') or ''}, git_origin_url={item.get('git_origin_url') or ''}, repo_path={item.get('repo_path') or ''})"
        )
    lines.append("Re-run with `--remote-slug <repo-slug>` to choose one, or use `--match-mode new` to create a new remote repo.")
    return "\n".join(lines)


def _mask(value: str) -> str:
    if len(value) <= 6:
        return "*" * len(value)
    return value[:2] + "*" * (len(value) - 4) + value[-2:]


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _single_remote_profile_name(profile_name: Optional[str]) -> str:
    if profile_name and profile_name != SINGLE_REMOTE_PROFILE:
        raise SystemExit(
            f"codex-handoff supports only one remote profile. Use `{SINGLE_REMOTE_PROFILE}` or omit --profile."
        )
    return SINGLE_REMOTE_PROFILE
