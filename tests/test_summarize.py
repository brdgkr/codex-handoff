import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codex_handoff.local_codex import DiscoveredThread
from codex_handoff.summarize import preferred_codex_cli, summarize_rollout


class SummarizeTests(unittest.TestCase):
    def test_codex_summary_mode_uses_codex_exec_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir()
            rollout_path = Path(temp_dir) / "rollout.jsonl"
            rollout_path.write_text("", encoding="utf-8")
            thread = DiscoveredThread(
                thread_id="thread-1",
                title="Codex Summary Thread",
                cwd=repo,
                rollout_path=rollout_path,
                created_at=1,
                updated_at=2,
                row={"source": "vscode", "model_provider": "openai", "model": "gpt-5.4", "reasoning_effort": "xhigh"},
                session_index_entry=None,
            )
            records = [
                {
                    "timestamp": "2026-04-07T00:00:00.000Z",
                    "type": "session_meta",
                    "payload": {"id": "thread-1", "cwd": str(repo)},
                },
                {
                    "timestamp": "2026-04-07T00:00:01.000Z",
                    "type": "event_msg",
                    "payload": {"type": "task_started", "turn_id": "turn-1"},
                },
                {
                    "timestamp": "2026-04-07T00:00:02.000Z",
                    "type": "event_msg",
                    "payload": {"type": "user_message", "message": "Summarize this thread"},
                },
            ]

            def fake_run(cmd, check=False, capture_output=False, text=False, **kwargs):
                if cmd[1:3] == ["login", "status"]:
                    return subprocess.CompletedProcess(cmd, 0, stdout="Logged in using an API key - sk-***", stderr="")
                output_index = cmd.index("-o") + 1
                output_path = Path(cmd[output_index])
                output_path.write_text(
                    json.dumps(
                        {
                            "latest_md": "# Current State\n\n- Codex generated summary.\n",
                            "handoff_json": {
                                "schema_version": "1.0",
                                "project_id": "repo",
                                "updated_at": "2026-04-07T00:00:03+09:00",
                                "current_goal": "Summarize this thread",
                                "status_summary": "Codex summary status.",
                                "decisions": [],
                                "todos": [],
                                "related_files": [],
                                "recent_commands": [],
                            },
                        },
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
                return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

            with patch("codex_handoff.summarize.codex_cli_candidates", return_value=[["codex.exe"]]), patch(
                "codex_handoff.summarize.subprocess.run",
                side_effect=fake_run,
            ):
                summary = summarize_rollout(repo, thread, records, summary_mode="codex")

            self.assertIn("Codex generated summary.", summary.latest_md)
            self.assertEqual(summary.handoff_json["current_goal"], "Summarize this thread")

    def test_codex_summary_mode_sets_no_window_flag_on_windows(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir) / "repo"
            repo.mkdir()
            rollout_path = Path(temp_dir) / "rollout.jsonl"
            rollout_path.write_text("", encoding="utf-8")
            thread = DiscoveredThread(
                thread_id="thread-2",
                title="Codex Summary Thread",
                cwd=repo,
                rollout_path=rollout_path,
                created_at=1,
                updated_at=2,
                row={"source": "vscode", "model_provider": "openai", "model": "gpt-5.4", "reasoning_effort": "xhigh"},
                session_index_entry=None,
            )
            records = [
                {
                    "timestamp": "2026-04-07T00:00:00.000Z",
                    "type": "session_meta",
                    "payload": {"id": "thread-2", "cwd": str(repo)},
                }
            ]
            calls = []

            def fake_run(cmd, **kwargs):
                calls.append(kwargs)
                if cmd[1:3] == ["login", "status"]:
                    return subprocess.CompletedProcess(cmd, 0, stdout="Logged in using an API key - sk-***", stderr="")
                output_index = cmd.index("-o") + 1
                Path(cmd[output_index]).write_text(
                    json.dumps(
                        {
                            "latest_md": "# Current State\n\n- Codex generated summary.\n",
                            "handoff_json": {
                                "schema_version": "1.0",
                                "project_id": "repo",
                                "updated_at": "2026-04-07T00:00:03+09:00",
                                "current_goal": "Summarize this thread",
                                "status_summary": "Codex summary status.",
                                "decisions": [],
                                "todos": [],
                                "related_files": [],
                                "recent_commands": [],
                            },
                        }
                    ),
                    encoding="utf-8",
                )
                return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

            with patch("codex_handoff.summarize.codex_cli_candidates", return_value=[["codex.exe"]]), patch(
                "codex_handoff.summarize.subprocess.run",
                side_effect=fake_run,
            ):
                summarize_rollout(repo, thread, records, summary_mode="codex")

            self.assertTrue(any("creationflags" in item for item in calls))

    @unittest.skipUnless(os.name == "nt", "Windows-specific test")
    def test_preferred_codex_cli_prefers_exe_over_cmd_on_windows(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            cmd_path = temp / "codex.cmd"
            bare_path = temp / "codex"
            exe_path = temp / "codex.exe"
            for path in [cmd_path, bare_path, exe_path]:
                path.write_text("stub", encoding="utf-8")

            def fake_which(name: str):
                mapping = {
                    "codex": str(cmd_path),
                    "codex.exe": str(exe_path),
                    "codex.cmd": str(cmd_path),
                }
                return mapping.get(name)

            with patch(
                "codex_handoff.summarize._where_codex_candidates",
                return_value=[str(cmd_path), str(bare_path), str(exe_path)],
            ), patch(
                "codex_handoff.summarize.shutil.which",
                side_effect=fake_which,
            ):
                self.assertEqual(preferred_codex_cli(), str(exe_path))

    @unittest.skipUnless(os.name == "nt", "Windows-specific test")
    def test_preferred_codex_cli_prefers_node_wrapper_over_cmd_on_windows(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            cmd_path = temp / "codex.cmd"
            node_path = temp / "node.exe"
            script_path = temp / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
            cmd_path.write_text("stub", encoding="utf-8")
            node_path.write_text("stub", encoding="utf-8")
            script_path.parent.mkdir(parents=True, exist_ok=True)
            script_path.write_text("console.log('codex');", encoding="utf-8")

            with patch(
                "codex_handoff.summarize._where_codex_candidates",
                return_value=[str(cmd_path)],
            ), patch(
                "codex_handoff.summarize.shutil.which",
                side_effect=lambda name: str(cmd_path) if name in {"codex", "codex.cmd"} else None,
            ):
                self.assertEqual(preferred_codex_cli(), f"{node_path} {script_path}")

    @unittest.skipUnless(os.name == "nt", "Windows-specific test")
    def test_preferred_codex_cli_prefers_vendor_binary_over_node_wrapper_on_windows(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            cmd_path = temp / "codex.cmd"
            node_path = temp / "node.exe"
            script_path = temp / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
            vendor_path = (
                temp
                / "node_modules"
                / "@openai"
                / "codex"
                / "node_modules"
                / "@openai"
                / "codex-win32-x64"
                / "vendor"
                / "x86_64-pc-windows-msvc"
                / "codex"
                / "codex.exe"
            )
            cmd_path.write_text("stub", encoding="utf-8")
            node_path.write_text("stub", encoding="utf-8")
            script_path.parent.mkdir(parents=True, exist_ok=True)
            script_path.write_text("console.log('codex');", encoding="utf-8")
            vendor_path.parent.mkdir(parents=True, exist_ok=True)
            vendor_path.write_text("binary", encoding="utf-8")

            with patch(
                "codex_handoff.summarize._where_codex_candidates",
                return_value=[str(cmd_path)],
            ), patch(
                "codex_handoff.summarize.shutil.which",
                side_effect=lambda name: str(cmd_path) if name in {"codex", "codex.cmd"} else None,
            ):
                self.assertEqual(preferred_codex_cli(), str(vendor_path))
