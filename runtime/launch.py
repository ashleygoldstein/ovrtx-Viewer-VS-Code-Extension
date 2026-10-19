"""Prepare with OpenUSD Python, then replace this process with the RTX runtime."""
import argparse
import os
from pathlib import Path
import subprocess
import sys


def run_renderer(command):
    if os.name == 'nt':
        # Windows execv does not quote arguments containing spaces. Keep the
        # launcher as the task parent and let subprocess quote each argument.
        return subprocess.run(command, check=False).returncode
    os.execv(command[0], command)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--runtime-python', required=True)
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--gpu', type=int, default=0)
    parser.add_argument('--session', required=True)
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    if (args.port != 0 and not 1024 <= args.port <= 65535) or args.gpu < 0:
        parser.error('Use port 0 (automatic) or 1024 to 65535 and a nonnegative GPU index')
    try:
        from prepare import prepare
        print(f'Loading USD scene: {args.source}', flush=True)
        prepare(args.source, args.output)
    except ImportError as exc:
        raise SystemExit('Scene preparation requires pxr (OpenUSD). Set ovrtxViewer.pythonPath to your USD Python. ' + str(exc)) from exc
    print(f'Starting OVRTX on GPU {args.gpu}. Logs: {Path(args.output) / "ovrtx.log"}', flush=True)
    command = [args.runtime_python, '-u', str(Path(__file__).with_name('server.py')),
               '--output', args.output, '--port', str(args.port), '--gpu', str(args.gpu), '--session', args.session]
    if args.smoke:
        command.append('--smoke')
    sys.stdout.flush()
    raise SystemExit(run_renderer(command))


if __name__ == '__main__':
    main()
