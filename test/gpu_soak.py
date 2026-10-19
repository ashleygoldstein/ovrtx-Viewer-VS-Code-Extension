"""Run with the renderer Python: python test/gpu_soak.py --frames 300.

Creates a temporary primitive scene; prepares it in another process to isolate
OpenUSD runtimes. Prints memory samples as JSON. Run outside a sandbox on an RTX
host. Samples describe this finite run, not a proof of absence of native leaks.
"""
import argparse
import ctypes
import gc
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def memory_mib():
    if os.name == 'nt':
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in ('PeakWorkingSetSize', 'WorkingSetSize',
                'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
                'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage', 'PrivateUsage')]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        kernel, psapi = ctypes.windll.kernel32, ctypes.windll.psapi
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            raise ctypes.WinError()
        return {'rss_mib': round(counters.WorkingSetSize / 2**20, 2),
                'private_mib': round(counters.PrivateUsage / 2**20, 2)}
    return {'rss_mib': round(int(Path('/proc/self/statm').read_text().split()[1]) * os.sysconf('SC_PAGE_SIZE') / 2**20, 2)}


def gpu_memory():
    try:
        value = subprocess.check_output(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'], text=True)
        return [int(line) for line in value.splitlines()]
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--frames', type=int, default=300)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--worker', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        sys.path.insert(0, str(ROOT / 'runtime'))
        from renderer import Renderer
        scene = json.loads((args.worker / 'scene.json').read_text())
        renderer = Renderer(args.worker, scene, 0)
        samples = []
        started = time.monotonic()
        try:
            for index in range(args.frames + 1):
                with renderer.render(yaw=(index % 36) * 10 - 180, elevation=30) as image:
                    assert image.size == (1280, 800)
                    assert image.getextrema() != ((0, 0), (0, 0), (0, 0))
                if index % 25 == 0 or index == args.frames:
                    gc.collect()
                    sample = {'frame': index, **memory_mib(), 'gpu_total_mib': gpu_memory()}
                    samples.append(sample)
                    print(json.dumps(sample), flush=True)
        finally:
            renderer.close()
        result = {'frames': args.frames, 'seconds': round(time.monotonic() - started, 2),
                  'samples': samples, 'after_close': memory_mib(), 'gpu_after_close_mib': gpu_memory()}
        (args.worker / 'result.json').write_text(json.dumps(result, indent=2))
        return
    with tempfile.TemporaryDirectory(prefix='ovrtx-soak-') as temporary:
        folder = Path(temporary)
        source = folder / 'primitives.usda'
        source.write_text('#usda 1.0\n(\n metersPerUnit = 1\n upAxis = "Y"\n)\ndef Cube "Cube" {\n double size = 2\n}\n')
        prepare = 'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from prepare import prepare; prepare(Path(sys.argv[2]),Path(sys.argv[3]))'
        subprocess.run([sys.executable, '-c', prepare, str(ROOT / 'runtime'), str(source), str(folder / 'session')], check=True)
        before = gpu_memory()
        subprocess.run([sys.executable, __file__, '--worker', str(folder / 'session'), '--frames', str(args.frames)], check=True)
        result = json.loads((folder / 'session/result.json').read_text())
        result.update(gpu_before_mib=before, gpu_after_process_mib=gpu_memory(), worker_exited=True)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
