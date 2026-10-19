"""Windows launcher regressions: argument boundaries and exit status."""
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
from launch import run_renderer


@unittest.skipUnless(os.name == 'nt', 'Windows-specific subprocess launcher')
class WindowsLaunchTests(unittest.TestCase):
    def test_paths_with_spaces_and_exit_code(self):
        with tempfile.TemporaryDirectory(prefix='ovrtx viewer ') as root:
            script = Path(root) / 'renderer with spaces.py'
            script.write_text('import sys\nassert sys.argv[1:] == ["scene with spaces.usda", "output with spaces"]\nsys.exit(7)\n', encoding='utf-8')
            code = run_renderer([sys.executable, str(script), 'scene with spaces.usda', 'output with spaces'])
            self.assertEqual(code, 7)


if __name__ == '__main__':
    unittest.main()
