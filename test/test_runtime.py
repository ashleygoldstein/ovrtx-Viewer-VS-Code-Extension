"""Real USD composition and offline HTTP tests; HTTP frames use a test image."""
import hashlib
import io
import json
import math
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock
from urllib.error import HTTPError
from urllib.request import urlopen
from http.server import HTTPServer

from PIL import Image
from pxr import Gf, Usd, UsdGeom, UsdLux
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
from prepare import prepare
from camera import camera_matrix, parse_camera
from server import handler_for, bind_server, publish_connection


class SceneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def test_all_roots_references_units_and_source_preservation(self):
        asset = Usd.Stage.CreateNew(str(self.root / 'asset.usda'))
        cube = UsdGeom.Cube.Define(asset, '/Cube')
        asset.SetDefaultPrim(cube.GetPrim())
        asset.GetRootLayer().Save()
        source = self.root / 'scene with spaces.usda'
        stage = Usd.Stage.CreateNew(str(source))
        UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
        UsdGeom.SetStageMetersPerUnit(stage, .001)
        stage.DefinePrim('/First').GetReferences().AddReference('./asset.usda')
        UsdGeom.Cube.Define(stage, '/Second').AddTranslateOp().Set(Gf.Vec3d(20, 0, 0))
        # Collision with a source prim must not overwrite it.
        UsdGeom.Xform.Define(stage, '/OVRTXViewer')
        stage.GetRootLayer().Save()
        before = hashlib.sha256(source.read_bytes()).digest()
        scene = prepare(source, self.root / 'out')
        self.assertEqual(scene['center'], [10, 0, 0])
        self.assertEqual(scene['camera_up_axis'], 'Z')
        self.assertEqual(scene['meters_per_unit'], .001)
        self.assertTrue(scene['camera_path'].startswith('/OVRTXViewer_/'))
        overlay = Usd.Stage.Open(str(self.root / 'out/viewer.usda'))
        self.assertTrue(overlay.GetPrimAtPath('/First').IsA(UsdGeom.Cube))
        self.assertTrue(overlay.GetPrimAtPath('/Second'))
        self.assertTrue(overlay.GetPrimAtPath('/OVRTXViewer_/Fill').IsA(UsdLux.DomeLight))
        self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), before)
        self.assertEqual(overlay.GetMetadata('renderSettingsPrimPath'), '/OVRTXViewer_/Render/Settings')

    def test_y_up_and_existing_lights(self):
        source = self.root / 'lit.usdc'
        stage = Usd.Stage.CreateNew(str(source))
        UsdGeom.Cube.Define(stage, '/Cube')
        UsdLux.DistantLight.Define(stage, '/Sun')
        UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
        stage.GetRootLayer().Save()
        scene = prepare(source, self.root / 'out')
        self.assertEqual(scene['camera_up_axis'], 'Y')
        overlay = Usd.Stage.Open(str(self.root / 'out/viewer.usda'))
        self.assertFalse(overlay.GetPrimAtPath('/OVRTXViewer/Fill'))

    def test_empty_stage_reports_actionable_error(self):
        source = self.root / 'empty.usda'
        stage = Usd.Stage.CreateNew(str(source))
        stage.GetRootLayer().Save()
        with self.assertRaisesRegex(ValueError, 'No finite, visible geometry'):
            prepare(source, self.root / 'out')

    def test_camera_basis_remains_orthonormal_above_and_below_scene(self):
        for axis in ('Y', 'Z'):
            for elevation in (-89.9, -45, 0, 45, 89.9):
                scene = {'center': [1, 2, 3], 'distance': 10, 'camera_up_axis': axis}
                matrix = camera_matrix(scene, elevation=elevation)
                for i in range(3):
                    for j in range(3):
                        self.assertAlmostEqual(sum(matrix[i][k] * matrix[j][k] for k in range(3)), int(i == j))
                self.assertAlmostEqual(math.dist(matrix[3][:3], scene['center']), 10)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.scene = {'name': 'test.usda', 'center': [0, 0, 0], 'distance': 10}
        self.render = Mock(side_effect=lambda **kw: Image.new('RGB', (32, 20), 'green'))
        self.server = HTTPServer(('127.0.0.1', 0), handler_for(self.scene, self.render, 'test-session'))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}/test-session'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_missing_or_incorrect_capability_cannot_access_any_endpoint(self):
        root = self.base.rsplit('/', 1)[0]
        for route in ('/health', '/scene', '/frame', '/viewer.js', '/wrong/scene', '/test-sessionX/scene'):
            with self.assertRaises(HTTPError) as caught:
                urlopen(root + route)
            self.assertEqual(caught.exception.code, 404)
        self.render.assert_not_called()

    def test_health_without_gpu_calls(self):
        with urlopen(self.base + '/health') as response:
            self.assertEqual(json.load(response), {'service': 'ovrtx-viewer', 'protocol': 1, 'ready': True, 'session': 'test-session'})
        self.render.assert_not_called()

    def test_frame_and_camera_validation(self):
        with urlopen(self.base + '/frame?elevation=-45&pan_x=.5') as response:
            self.assertEqual(Image.open(io.BytesIO(response.read())).size, (32, 20))
        self.assertEqual(self.render.call_args.kwargs['elevation'], -45)
        self.render.reset_mock()
        for query in ('yaw=nan', 'zoom=0', 'pan_x=inf', 'elevation=90', 'focus=missing'):
            with self.assertRaises(HTTPError) as caught:
                urlopen(self.base + '/frame?' + query)
            self.assertEqual(caught.exception.code, 400)
        self.render.assert_not_called()

    def test_only_viewer_assets_are_exposed(self):
        for route in ('/', '/viewer.js', '/viewer.css', '/scene'):
            with urlopen(self.base + route) as response:
                self.assertEqual(response.status, 200)
                self.assertIn("script-src 'self'", response.headers['Content-Security-Policy'])
        for route in ('/../server.py', '/scene.json', '/viewer.usda'):
            with self.assertRaises(HTTPError) as caught:
                urlopen(self.base + route)
            self.assertEqual(caught.exception.code, 404)


class PortTests(unittest.TestCase):
    def test_busy_preferred_port_gets_distinct_live_socket(self):
        handler = handler_for({}, Mock(), 'port-test')
        first = bind_server(0, handler)
        self.addCleanup(first.server_close)
        second = bind_server(first.server_port, handler)
        self.addCleanup(second.server_close)
        self.assertNotEqual(first.server_port, second.server_port)
        self.assertEqual(first.socket.getsockname(), ('127.0.0.1', first.server_port))
        self.assertEqual(second.socket.getsockname(), ('127.0.0.1', second.server_port))

    def test_connection_metadata_reports_claimed_port_and_session(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            publish_connection(output, 49152, 'owned-session')
            connection = json.loads((output / 'connection.json').read_text(encoding='utf-8'))
            self.assertEqual(connection, {'service': 'ovrtx-viewer', 'protocol': 1, 'ready': True,
                                          'session': 'owned-session', 'port': 49152})
            self.assertFalse((output / 'connection.tmp').exists())


if __name__ == '__main__':
    unittest.main()
