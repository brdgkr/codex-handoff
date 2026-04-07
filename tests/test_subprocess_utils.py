import os
import tempfile
import unittest
from pathlib import Path

from codex_handoff.git_config import git_origin_url_from_repo
from codex_handoff.local_codex import repo_git_origin_url
from codex_handoff.subprocess_utils import no_window_kwargs
from codex_handoff.workspace import git_origin_url


class SubprocessUtilsTests(unittest.TestCase):
    def test_no_window_kwargs_sets_flags_on_windows(self) -> None:
        kwargs = no_window_kwargs()
        if os.name == "nt":
            self.assertIn("creationflags", kwargs)
        else:
            self.assertEqual(kwargs, {})

    def test_git_origin_url_reads_plain_git_config(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir)
            git_dir = repo / ".git"
            git_dir.mkdir(parents=True, exist_ok=True)
            (git_dir / "config").write_text(
                "[core]\n\trepositoryformatversion = 0\n[remote \"origin\"]\n\turl = https://github.com/example/repo.git\n",
                encoding="utf-8",
            )
            value = git_origin_url(repo)
            self.assertEqual(value, "https://github.com/example/repo.git")

    def test_git_origin_url_reads_worktree_gitdir_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir)
            gitdir = repo / ".git-main" / "worktrees" / "repo"
            commondir = gitdir / "commondir"
            commondir.parent.mkdir(parents=True, exist_ok=True)
            common_dir = repo / ".git-main"
            common_dir.mkdir(parents=True, exist_ok=True)
            (repo / ".git").write_text("gitdir: .git-main/worktrees/repo\n", encoding="utf-8")
            commondir.write_text("../..\n", encoding="utf-8")
            (common_dir / "config").write_text(
                "[remote \"origin\"]\n\turl = https://github.com/example/worktree.git\n",
                encoding="utf-8",
            )
            value = git_origin_url_from_repo(repo)
            self.assertEqual(value, "https://github.com/example/worktree.git")
            self.assertEqual(repo_git_origin_url(repo), "https://github.com/example/worktree.git")

    def test_git_origin_url_returns_none_when_not_a_git_repo(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir)
            value = git_origin_url(repo)
            self.assertIsNone(value)
            self.assertIsNone(repo_git_origin_url(repo))

    def test_local_codex_git_origin_matches_workspace_helper(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir)
            git_dir = repo / ".git"
            git_dir.mkdir(parents=True, exist_ok=True)
            (git_dir / "config").write_text(
                "[remote \"origin\"]\n\turl = https://github.com/example/repo.git\n",
                encoding="utf-8",
            )
            workspace_value = git_origin_url(repo)
            value = repo_git_origin_url(repo)
            self.assertEqual(workspace_value, value)
            self.assertEqual(value, "https://github.com/example/repo.git")
