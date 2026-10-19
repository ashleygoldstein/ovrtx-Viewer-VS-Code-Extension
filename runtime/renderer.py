"""Render the viewer overlay through the public OVRTX and OVStage APIs."""
from camera import camera_matrix


class Renderer:
    def __init__(self, output, scene, gpu):
        import numpy as np
        import ovrtx  # Register renderer schemas before importing ovstage.
        import ovstage
        self.np, self.ovrtx, self.ovstage = np, ovrtx, ovstage
        self.scene, self.ordinal = scene, 1
        self.renderer = self.stage = None
        self.attached = False
        try:
            self.renderer = ovrtx.Renderer(config=ovrtx.RendererConfig(
                active_cuda_gpus=str(gpu), log_file_path=str(output / 'ovrtx.log')))
            self.stage = ovstage.Stage('ovrtx.viewer')
            self.renderer.attach_ovstage(self.stage)
            self.attached = True
            ovstage.population.open_usd(self.stage, str(output / 'viewer.usda'), ordinal=self.ordinal)
            self.stage.advance_write_floor(self.ordinal, ovstage.Scope.ALL).wait()
        except BaseException:
            self.close()
            raise

    def render(self, **camera):
        from PIL import Image
        np, ovstage, ovrtx = self.np, self.ovstage, self.ovrtx
        transforms = np.asarray(camera_matrix(self.scene, **camera), dtype=np.float64).reshape(1, 4, 4)
        self.ordinal += 1
        with ovstage.PathDictionary(self.stage) as paths:
            selection = paths.create_path_list_from_strings([self.scene['camera_path']])
            try:
                with self.stage.query_from_path_list(selection) as query:
                    tensor = ovstage.make_dltensor(transforms, dtype=ovstage.numpy_to_dldatatype(transforms.dtype, lanes=16), shape=[1], ndim=1)
                    self.stage.write_attribute(query, paths.intern_token('omni:xform'), ordinal=self.ordinal,
                                               tensors=tensor, is_array=False, semantic=ovstage.AttributeSemantic.MATRIX).wait()
            finally:
                paths.destroy_path_list(selection)
        self.stage.advance_write_floor(self.ordinal, ovstage.Scope.ALL).wait()
        product = self.scene['product_path']
        pixels = None
        for index in range(10):
            products = self.renderer.step(render_products={product}, delta_time=1/60, ordinal=self.ordinal)
            if product not in products:
                del products
                continue
            frame = products[product].frames[0]
            mapped = frame.render_vars[product + '/LdrColor'].map(device=ovrtx.Device.CPU)
            try:
                pixels = np.from_dlpack(mapped).copy()
            finally:
                mapped.unmap()
            del mapped, frame, products
            if index >= 2:
                break
        if pixels is None:
            raise RuntimeError('OVRTX did not produce the configured camera output')
        with Image.fromarray(pixels) as image:
            return image.convert('RGB')

    def close(self):
        try:
            if self.attached:
                self.attached = False
                self.renderer.detach_ovstage()
        finally:
            try:
                if self.renderer is not None:
                    renderer, self.renderer = self.renderer, None
                    renderer.destroy()
            finally:
                if self.stage is not None:
                    stage, self.stage = self.stage, None
                    stage.destroy()
