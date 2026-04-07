import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codex_handoff.local_codex import codex_paths, discover_threads_for_repo, inject_thread, normalize_cwd
from codex_handoff.sync import ThreadImportMismatchError, compute_watch_signature, export_repo_threads, import_thread_bundle_to_codex, pull_memory_tree, push_memory_tree, sync_now


class SyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        base = Path(self.temp_dir.name)
        self.repo = base / "repo"
        self.repo.mkdir(parents=True)
        self.memory_dir = self.repo / ".codex-handoff"
        self.codex_a = base / "codex-a"
        self.codex_b = base / "codex-b"

    def test_export_and_import_thread_bundle_round_trip(self) -> None:
        paths_a = codex_paths(str(self.codex_a))
        inject_thread(
            paths_a,
            title="Synthetic Export Thread",
            thread_name="Synthetic Export Thread",
            user_message="Export this thread into a bundle.",
            assistant_message="Bundled successfully.",
            cwd=str(self.repo),
            thread_id="thread-export-001",
            apply=True,
        )

        threads = export_repo_threads(
            self.repo,
            self.memory_dir,
            codex_home=str(self.codex_a),
            summary_mode="heuristic",
            include_raw_threads=True,
        )
        self.assertEqual(len(threads), 1)

        bundle_dir = self.memory_dir / "threads" / "thread-export-001"
        self.assertTrue((bundle_dir / "manifest.json").exists())
        self.assertTrue((bundle_dir / "latest.md").exists())
        self.assertTrue((bundle_dir / "handoff.json").exists())
        self.assertTrue((bundle_dir / "raw" / "session.jsonl").exists())
        self.assertTrue((bundle_dir / "source" / "rollout.jsonl.gz").exists())
        self.assertTrue((bundle_dir / "source" / "thread-record.json").exists())

        imported = import_thread_bundle_to_codex(
            self.repo,
            self.memory_dir,
            "thread-export-001",
            codex_home=str(self.codex_b),
        )
        self.assertEqual(imported["thread_id"], "thread-export-001")
        imported_rollout = Path(imported["rollout_path"])
        self.assertTrue(imported_rollout.exists())

        conn = sqlite3.connect(self.codex_b / "state_5.sqlite")
        try:
            row = conn.execute(
                "SELECT id, cwd, rollout_path FROM threads WHERE id = ?",
                ["thread-export-001"],
            ).fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(row)
        self.assertEqual(row[0], "thread-export-001")
        self.assertEqual(normalize_cwd(self.repo), normalize_cwd(row[1]))
        self.assertIn("thread-export-001", row[2])

        index_lines = (self.codex_b / "session_index.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(index_lines), 1)
        index_entry = json.loads(index_lines[0])
        self.assertEqual(index_entry["id"], "thread-export-001")

        thread_index = json.loads((self.memory_dir / "thread-index.json").read_text(encoding="utf-8"))
        self.assertEqual(thread_index[0]["thread_id"], "thread-export-001")
        current_thread = json.loads((self.memory_dir / "current-thread.json").read_text(encoding="utf-8"))
        self.assertEqual(current_thread["thread_id"], "thread-export-001")
        self.assertTrue((self.memory_dir / "latest.md").exists())
        self.assertTrue((self.memory_dir / "handoff.json").exists())

    def test_push_and_pull_memory_tree(self) -> None:
        self.memory_dir.mkdir(parents=True)
        (self.memory_dir / "repo.json").write_text('{"repo_slug":"test-repo"}\n', encoding="utf-8")
        (self.memory_dir / "thread-index.json").write_text(
            json.dumps([{"thread_id": "thread-001", "title": "Thread 001"}], ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (self.memory_dir / "current-thread.json").write_text('{"thread_id":"thread-001"}\n', encoding="utf-8")
        (self.memory_dir / "latest.md").write_text("# Current State\n", encoding="utf-8")
        (self.memory_dir / "handoff.json").write_text(
            '{"schema_version":"1.0","project_id":"repo","updated_at":"2026-04-07T00:00:00+09:00","current_goal":"x","status_summary":"y","decisions":[],"todos":[],"related_files":[],"recent_commands":[]}\n',
            encoding="utf-8",
        )
        raw_dir = self.memory_dir / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        (raw_dir / "session.jsonl").write_text('{"role":"assistant","message":"current thread raw"}\n', encoding="utf-8")
        (raw_dir / "stale.jsonl").write_text('{"role":"assistant","message":"stale root raw"}\n', encoding="utf-8")
        live_bundle = self.memory_dir / "threads" / "thread-001"
        live_bundle.mkdir(parents=True, exist_ok=True)
        (live_bundle / "manifest.json").write_text('{"thread_id":"thread-001"}\n', encoding="utf-8")
        stale_bundle = self.memory_dir / "threads" / "thread-stale"
        stale_bundle.mkdir(parents=True, exist_ok=True)
        (stale_bundle / "manifest.json").write_text('{"thread_id":"thread-stale"}\n', encoding="utf-8")
        remote_store: dict[str, bytes] = {}

        def fake_put(profile, key, payload, timeout=30):
            remote_store[key] = payload
            return {"status": "200", "url": key}

        def fake_list(profile, prefix="", timeout=30):
            return [{"key": key, "size": str(len(value))} for key, value in remote_store.items() if key.startswith(prefix)]

        def fake_get(profile, key, timeout=30):
            return remote_store[key]

        with patch("codex_handoff.sync.put_r2_object", side_effect=fake_put), patch(
            "codex_handoff.sync.list_r2_objects", side_effect=fake_list
        ), patch("codex_handoff.sync.get_r2_object", side_effect=fake_get):
            uploaded = push_memory_tree(None, self.memory_dir, "repos/test-repo")
            self.assertEqual(len(uploaded), 7)
            self.assertIn("repos/test-repo/repo.json", remote_store)
            self.assertIn("repos/test-repo/thread-index.json", remote_store)
            self.assertIn("repos/test-repo/current-thread.json", remote_store)
            self.assertIn("repos/test-repo/latest.md", remote_store)
            self.assertIn("repos/test-repo/handoff.json", remote_store)
            self.assertIn("repos/test-repo/raw/session.jsonl", remote_store)
            self.assertIn("repos/test-repo/threads/thread-001/manifest.json", remote_store)
            self.assertNotIn("repos/test-repo/raw/stale.jsonl", remote_store)
            self.assertNotIn("repos/test-repo/threads/thread-stale/manifest.json", remote_store)

            pulled_dir = self.repo / ".codex-handoff-pulled"
            pulled_dir.mkdir(parents=True, exist_ok=True)
            (pulled_dir / "stale.txt").write_text("stale", encoding="utf-8")
            (pulled_dir / "sync-state.json").write_text('{"last_sync_direction":"push"}\n', encoding="utf-8")
            pulled = pull_memory_tree(None, pulled_dir, "repos/test-repo")
            self.assertEqual(len(pulled), 7)
            self.assertEqual((pulled_dir / "latest.md").read_text(encoding="utf-8"), "# Current State\n")
            self.assertFalse((pulled_dir / "stale.txt").exists())
            self.assertFalse((pulled_dir / "raw" / "stale.jsonl").exists())
            self.assertFalse((pulled_dir / "threads" / "thread-stale" / "manifest.json").exists())
            self.assertEqual(
                (pulled_dir / "sync-state.json").read_text(encoding="utf-8"),
                '{"last_sync_direction":"push"}\n',
            )

    def test_sync_now_records_local_sync_state(self) -> None:
        paths_a = codex_paths(str(self.codex_a))
        inject_thread(
            paths_a,
            title="Sync State Thread",
            thread_name="Sync State Thread",
            user_message="Write sync state after upload.",
            assistant_message="Sync state recorded.",
            cwd=str(self.repo),
            thread_id="thread-sync-state-001",
            apply=True,
        )
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        (self.memory_dir / "repo.json").write_text(
            json.dumps(
                {
                    "repo_path": str(self.repo),
                    "repo_slug": "test-repo",
                    "remote_profile": "default",
                    "remote_prefix": "repos/test-repo/",
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        remote_store: dict[str, bytes] = {}

        def fake_put(_profile, key, payload, timeout=30):
            remote_store[key] = payload
            return {"status": "200", "url": key}

        with patch("codex_handoff.sync.put_r2_object", side_effect=fake_put):
            result = sync_now(
                self.repo,
                self.memory_dir,
                None,
                codex_home=str(self.codex_a),
                summary_mode="heuristic",
                include_raw_threads=True,
                prefix="repos/test-repo/",
            )

        sync_state = json.loads((self.memory_dir / "sync-state.json").read_text(encoding="utf-8"))
        self.assertEqual(sync_state["repo_slug"], "test-repo")
        self.assertEqual(sync_state["last_sync_direction"], "push")
        self.assertEqual(sync_state["last_sync_command"], "now")
        self.assertEqual(sync_state["current_thread"], "thread-sync-state-001")
        self.assertEqual(sync_state["last_push"]["objects_uploaded"], len(remote_store))
        self.assertEqual(sync_state["last_push"]["threads_exported"], 1)
        self.assertEqual(result["sync_health"]["status"], "ok")
        self.assertEqual(result["sync_state"]["last_sync_direction"], "push")
        self.assertEqual(result["thread_ids"], ["thread-sync-state-001"])

    def test_watch_signature_ignores_materialized_memory_tree_outputs(self) -> None:
        paths_a = codex_paths(str(self.codex_a))
        inject_thread(
            paths_a,
            title="Synthetic Export Thread",
            thread_name="Synthetic Export Thread",
            user_message="Export this thread into a bundle.",
            assistant_message="Bundled successfully.",
            cwd=str(self.repo),
            thread_id="thread-export-002",
            apply=True,
        )
        export_repo_threads(
            self.repo,
            self.memory_dir,
            codex_home=str(self.codex_a),
            summary_mode="heuristic",
            include_raw_threads=True,
        )
        before = compute_watch_signature(self.repo, str(self.codex_a))
        (self.memory_dir / "latest.md").write_text("# Changed locally\n", encoding="utf-8")
        after = compute_watch_signature(self.repo, str(self.codex_a))
        self.assertEqual(before, after)

    def test_discover_threads_matches_by_git_origin_even_when_cwd_differs(self) -> None:
        paths = codex_paths(str(self.codex_a))
        other_workspace = Path(self.temp_dir.name) / "other-workspace"
        other_workspace.mkdir(parents=True)
        inject_thread(
            paths,
            title="Imported Same Repo Thread",
            thread_name="Imported Same Repo Thread",
            user_message="Imported from another machine.",
            assistant_message="Continue here.",
            cwd=str(other_workspace),
            thread_id="thread-origin-match",
            apply=True,
        )
        conn = sqlite3.connect(self.codex_a / "state_5.sqlite")
        try:
            conn.execute(
                "UPDATE threads SET git_origin_url = ? WHERE id = ?",
                ["https://github.com/example/repo.git", "thread-origin-match"],
            )
            conn.commit()
        finally:
            conn.close()

        with patch("codex_handoff.local_codex.repo_git_origin_url", return_value="https://github.com/example/repo.git"):
            threads = discover_threads_for_repo(self.repo, codex_home=str(self.codex_a))
        self.assertEqual([thread.thread_id for thread in threads], ["thread-origin-match"])

    def test_discover_threads_excludes_mismatched_git_origin_even_when_cwd_matches(self) -> None:
        paths = codex_paths(str(self.codex_a))
        inject_thread(
            paths,
            title="Wrong Repo Import",
            thread_name="Wrong Repo Import",
            user_message="This should not be exported.",
            assistant_message="Do not sync me.",
            cwd=str(self.repo),
            thread_id="thread-origin-mismatch",
            apply=True,
        )
        conn = sqlite3.connect(self.codex_a / "state_5.sqlite")
        try:
            conn.execute(
                "UPDATE threads SET git_origin_url = ? WHERE id = ?",
                ["https://github.com/example/other.git", "thread-origin-mismatch"],
            )
            conn.commit()
        finally:
            conn.close()

        with patch("codex_handoff.local_codex.repo_git_origin_url", return_value="https://github.com/example/repo.git"):
            threads = discover_threads_for_repo(self.repo, codex_home=str(self.codex_a))
        self.assertEqual(threads, [])

    def test_import_rejects_bundle_when_git_origin_mismatches_target_repo(self) -> None:
        paths_a = codex_paths(str(self.codex_a))
        inject_thread(
            paths_a,
            title="Mismatch Import Thread",
            thread_name="Mismatch Import Thread",
            user_message="Export this thread into a bundle.",
            assistant_message="Bundled successfully.",
            cwd=str(self.repo),
            thread_id="thread-export-mismatch",
            apply=True,
        )
        export_repo_threads(
            self.repo,
            self.memory_dir,
            codex_home=str(self.codex_a),
            summary_mode="heuristic",
            include_raw_threads=True,
        )
        thread_record_path = self.memory_dir / "threads" / "thread-export-mismatch" / "source" / "thread-record.json"
        thread_record = json.loads(thread_record_path.read_text(encoding="utf-8"))
        thread_record["git_origin_url"] = "https://github.com/example/source.git"
        thread_record_path.write_text(json.dumps(thread_record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        with patch("codex_handoff.sync.repo_git_origin_url", return_value="https://github.com/example/target.git"):
            with self.assertRaises(ThreadImportMismatchError):
                import_thread_bundle_to_codex(
                    self.repo,
                    self.memory_dir,
                    "thread-export-mismatch",
                    codex_home=str(self.codex_b),
                )

    def test_export_with_no_matching_threads_clears_materialized_root(self) -> None:
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        (self.memory_dir / "latest.md").write_text("# Stale\n", encoding="utf-8")
        (self.memory_dir / "handoff.json").write_text('{"schema_version":"1.0"}\n', encoding="utf-8")
        (self.memory_dir / "current-thread.json").write_text('{"thread_id":"stale-thread"}\n', encoding="utf-8")
        raw_dir = self.memory_dir / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        (raw_dir / "session.jsonl").write_text('{"role":"assistant","message":"stale"}\n', encoding="utf-8")

        threads = export_repo_threads(
            self.repo,
            self.memory_dir,
            codex_home=str(self.codex_a),
            summary_mode="heuristic",
            include_raw_threads=True,
        )

        self.assertEqual(threads, [])
        index_payload = json.loads((self.memory_dir / "thread-index.json").read_text(encoding="utf-8"))
        self.assertEqual(index_payload, [])
        self.assertFalse((self.memory_dir / "latest.md").exists())
        self.assertFalse((self.memory_dir / "handoff.json").exists())
        self.assertFalse((self.memory_dir / "current-thread.json").exists())
        self.assertFalse((self.memory_dir / "raw" / "session.jsonl").exists())
