import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codex_handoff.config import config_dir, config_path


class ConfigTests(unittest.TestCase):
    def test_default_config_dir_uses_hidden_home_directory(self) -> None:
        fake_home = Path(tempfile.gettempdir()) / "codex-handoff-home"
        with patch.dict("os.environ", {}, clear=False), patch("pathlib.Path.home", return_value=fake_home):
            self.assertEqual(config_dir(), fake_home / ".codex-handoff")
            self.assertEqual(config_path(), fake_home / ".codex-handoff" / "config.json")

    def test_env_override_wins(self) -> None:
        override = Path(tempfile.gettempdir()) / "codex-handoff-override"
        with patch.dict("os.environ", {"CODEX_HANDOFF_CONFIG_DIR": str(override)}, clear=False):
            self.assertEqual(config_dir(), override.resolve())
            self.assertEqual(config_path(), override.resolve() / "config.json")
