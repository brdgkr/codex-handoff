import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from codex_handoff.test_thread import codex_paths, cleanup_thread, inject_thread


class TestThreadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.codex_home = Path(self.temp_dir.name)
        self.paths = codex_paths(str(self.codex_home))

    def test_inject_and_cleanup_round_trip(self) -> None:
        result = inject_thread(
            self.paths,
            title="Synthetic Thread Title",
            thread_name="Synthetic Thread Name",
            user_message="Hello from a synthetic thread",
            assistant_message="Synthetic assistant reply",
            cwd=self.temp_dir.name,
            thread_id="test-thread-001",
            apply=True,
        )

        self.assertTrue(result.rollout_path.exists())
        lines = result.rollout_path.read_text(encoding="utf-8").splitlines()
        self.assertGreaterEqual(len(lines), 3)
        first = json.loads(lines[0])
        self.assertEqual(first["type"], "session_meta")
        self.assertEqual(first["payload"]["id"], "test-thread-001")

        index_lines = self.paths.session_index_path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(index_lines), 1)
        index_entry = json.loads(index_lines[0])
        self.assertEqual(index_entry["id"], "test-thread-001")
        self.assertEqual(index_entry["thread_name"], "Synthetic Thread Name")

        conn = sqlite3.connect(self.paths.state_db_path)
        try:
            row = conn.execute(
                "SELECT id, title, first_user_message, rollout_path FROM threads WHERE id = ?",
                ["test-thread-001"],
            ).fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(row)
        self.assertEqual(row[0], "test-thread-001")
        self.assertEqual(row[1], "Synthetic Thread Title")
        self.assertEqual(row[2], "Hello from a synthetic thread")

        cleanup = cleanup_thread(self.paths, "test-thread-001", apply=True)
        self.assertFalse(result.rollout_path.exists())
        self.assertEqual(cleanup["thread_id"], "test-thread-001")

        conn = sqlite3.connect(self.paths.state_db_path)
        try:
            row = conn.execute("SELECT 1 FROM threads WHERE id = ?", ["test-thread-001"]).fetchone()
        finally:
            conn.close()
        self.assertIsNone(row)
        self.assertEqual(self.paths.session_index_path.read_text(encoding="utf-8"), "")

    def test_inject_dry_run_does_not_write(self) -> None:
        result = inject_thread(
            self.paths,
            title="Dry Run Thread",
            thread_name=None,
            user_message="Dry run message",
            assistant_message="Dry run reply",
            cwd=self.temp_dir.name,
            thread_id="dry-run-thread",
            apply=False,
        )

        self.assertFalse(result.rollout_path.exists())
        self.assertFalse(self.paths.session_index_path.exists())
        self.assertFalse(self.paths.state_db_path.exists())
