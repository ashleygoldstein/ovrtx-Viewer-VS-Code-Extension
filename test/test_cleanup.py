"""Exercise native cleanup paths without requiring NVIDIA libraries."""
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
from renderer import Renderer


class CleanupTests(unittest.TestCase):
    def test_cleanup_remains_idempotent_after_native_failures(self):
        for failure in (None, 'detach', 'renderer', 'stage'):
            with self.subTest(failure=failure):
                instance = Renderer.__new__(Renderer)
                renderer, stage = Mock(), Mock()
                instance.renderer, instance.stage, instance.attached = renderer, stage, True
                if failure:
                    target = {'detach': renderer.detach_ovstage, 'renderer': renderer.destroy, 'stage': stage.destroy}[failure]
                    target.side_effect = RuntimeError('native failure')
                    with self.assertRaises(RuntimeError):
                        instance.close()
                else:
                    instance.close()
                instance.close()
                renderer.detach_ovstage.assert_called_once()
                renderer.destroy.assert_called_once()
                stage.destroy.assert_called_once()
                self.assertIsNone(instance.renderer)
                self.assertIsNone(instance.stage)
