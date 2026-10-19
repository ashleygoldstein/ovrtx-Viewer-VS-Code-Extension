"""Compose a read-only USD source below a temporary camera/render overlay."""
import argparse
import json
import math
from pathlib import Path


def prepare(source, output):
    from pxr import Gf, Usd, UsdGeom, UsdLux, UsdRender
    source = Path(source).resolve(strict=True)
    output = Path(output)
    original = Usd.Stage.Open(str(source))
    if not original:
        raise ValueError(f"Cannot open USD scene: {source}")
    cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_, UsdGeom.Tokens.render])
    # The pseudo-root includes all roots, even without an authored default prim.
    bound = cache.ComputeWorldBound(original.GetPseudoRoot()).ComputeAlignedRange()
    if bound.IsEmpty() or not all(math.isfinite(v) for v in (*bound.GetMin(), *bound.GetMax())) or max(bound.GetSize()) <= 0:
        raise ValueError(f"No finite, visible geometry to frame in {source.name}")
    radius = bound.GetSize().GetLength() / 2
    distance = radius / math.sin(math.atan(22.5 / (2 * 35))) * 1.1
    namespace = '/OVRTXViewer'
    while original.GetPrimAtPath(namespace):
        namespace += '_'
    camera_path = namespace + '/Camera'
    product_path = namespace + '/Render/View'
    scene = {'source': str(source), 'name': source.name, 'center': list(bound.GetMidpoint()),
             'distance': distance, 'camera_up_axis': str(UsdGeom.GetStageUpAxis(original)),
             'meters_per_unit': UsdGeom.GetStageMetersPerUnit(original),
             'camera_path': camera_path, 'product_path': product_path}
    output.mkdir(parents=True, exist_ok=True)
    stage = Usd.Stage.CreateNew(str(output / 'viewer.usda'))
    # Keep the source layer's filesystem anchor so textures and references resolve.
    stage.GetRootLayer().subLayerPaths = [source.as_posix()]
    UsdGeom.SetStageUpAxis(stage, UsdGeom.GetStageUpAxis(original))
    UsdGeom.SetStageMetersPerUnit(stage, UsdGeom.GetStageMetersPerUnit(original))
    camera = UsdGeom.Camera.Define(stage, camera_path)
    camera.CreateFocalLengthAttr(35)
    camera.CreateHorizontalApertureAttr(36)
    camera.CreateVerticalApertureAttr(22.5)
    camera.CreateClippingRangeAttr(Gf.Vec2f(max(radius * 0.0001, 0.000001), distance * 100))
    from camera import camera_matrix
    camera.AddTransformOp().Set(Gf.Matrix4d(*[v for row in camera_matrix(scene) for v in row]))
    if not any(prim.HasAPI(UsdLux.LightAPI) for prim in original.Traverse()):
        UsdLux.DomeLight.Define(stage, namespace + '/Fill').CreateIntensityAttr(350)
    product = UsdRender.Product.Define(stage, product_path)
    product.CreateResolutionAttr(Gf.Vec2i(1280, 800))
    product.CreateCameraRel().SetTargets([camera.GetPath()])
    color = UsdRender.Var.Define(stage, product_path + '/LdrColor')
    color.CreateSourceNameAttr('LdrColor')
    product.CreateOrderedVarsRel().SetTargets([color.GetPath()])
    settings = UsdRender.Settings.Define(stage, namespace + '/Render/Settings')
    settings.CreateProductsRel().SetTargets([product.GetPath()])
    stage.SetMetadata('renderSettingsPrimPath', str(settings.GetPath()))
    stage.GetRootLayer().Save()
    (output / 'scene.json').write_text(json.dumps(scene, indent=2), encoding='utf-8')
    return scene


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    prepare(args.source, args.output)
