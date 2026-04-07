from __future__ import annotations

import argparse
import json
from typing import Optional, Sequence

from codex_handoff.local_codex import cleanup_thread, codex_paths, inject_thread


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="codex-handoff-test-thread",
        description="Inject or clean up a synthetic Codex thread for materialization testing.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    inject = subparsers.add_parser("inject", help="Create a synthetic thread in a Codex home.")
    inject.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")
    inject.add_argument("--thread-id", default=None, help="Optional explicit thread id.")
    inject.add_argument("--title", required=True, help="Thread title shown in the threads table.")
    inject.add_argument("--thread-name", default=None, help="Optional session_index display name.")
    inject.add_argument("--user-message", default=None, help="First user message. Defaults to the title.")
    inject.add_argument(
        "--assistant-message",
        default="This is a synthetic Codex thread inserted by codex-handoff for materialization testing.",
        help="Assistant reply written into the synthetic rollout.",
    )
    inject.add_argument("--cwd", default=".", help="Workspace path recorded in the synthetic thread.")
    inject.add_argument("--apply", action="store_true", help="Apply changes. Default is dry-run.")

    cleanup = subparsers.add_parser("cleanup", help="Remove a synthetic thread from a Codex home.")
    cleanup.add_argument("--codex-home", default=None, help="Override Codex home. Defaults to ~/.codex.")
    cleanup.add_argument("--thread-id", required=True, help="Thread id to remove.")
    cleanup.add_argument("--apply", action="store_true", help="Apply changes. Default is dry-run.")

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "inject":
        result = inject_thread(
            codex_paths(args.codex_home),
            title=args.title,
            thread_name=args.thread_name,
            user_message=args.user_message or args.title,
            assistant_message=args.assistant_message,
            cwd=args.cwd,
            thread_id=args.thread_id,
            apply=args.apply,
        )
        print(
            json.dumps(
                {
                    "thread_id": result.thread_id,
                    "created": result.created,
                    "rollout_path": str(result.rollout_path),
                    "session_index_entry": result.session_index_entry,
                    "thread_row": result.thread_row,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    if args.command == "cleanup":
        result = cleanup_thread(codex_paths(args.codex_home), args.thread_id, apply=args.apply)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    parser.error(f"unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
