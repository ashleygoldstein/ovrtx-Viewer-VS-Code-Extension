"""Loopback HTTP viewer; a single thread owns all GPU rendering calls."""
import argparse
import errno
import io
import hmac
import json
import socket
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import traceback
from urllib.parse import parse_qs, urlsplit
from camera import parse_camera

STATIC = Path(__file__).parent / 'web'


class ViewerHTTPServer(HTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def bind_server(port, handler):
    """Bind once and keep the socket; fall back if a preferred port is occupied."""
    try:
        return ViewerHTTPServer(('127.0.0.1', port), handler)
    except OSError as exc:
        if not port or (exc.errno not in (errno.EADDRINUSE, errno.EACCES) and getattr(exc, 'winerror', None) not in (10048, 10013)):
            raise
        print(f'Port {port} is unavailable; choosing an available viewer port.', flush=True)
        return ViewerHTTPServer(('127.0.0.1', 0), handler)


def publish_connection(output, port, session):
    pending = output / 'connection.tmp'
    pending.write_text(json.dumps({'service': 'ovrtx-viewer', 'protocol': 1, 'ready': True,
                                   'session': session, 'port': port}), encoding='utf-8')
    pending.replace(output / 'connection.json')


def handler_for(scene, render, session):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            # Request paths contain the session capability; never log them.
            pass

        def do_GET(self):
            request = urlsplit(self.path)
            parts = request.path.split('/', 2)
            if len(parts) != 3 or not hmac.compare_digest(parts[1].encode(), session.encode()):
                self.send_error(404)
                return
            route = '/' + parts[2]
            try:
                if route == '/frame':
                    camera = parse_camera(parse_qs(request.query, keep_blank_values=True), scene)
                    with render(**camera) as result, io.BytesIO() as buffer:
                        result.save(buffer, format='JPEG', quality=90)
                        body, kind = buffer.getvalue(), 'image/jpeg'
                elif route == '/health':
                    body = json.dumps({'service': 'ovrtx-viewer', 'protocol': 1, 'ready': True, 'session': session}).encode()
                    kind = 'application/json'
                elif route == '/scene':
                    body, kind = json.dumps(scene).encode(), 'application/json'
                elif route in ('/', '/viewer.js', '/viewer.css'):
                    name = 'index.html' if route == '/' else route[1:]
                    body = (STATIC / name).read_bytes()
                    kind = {'index.html': 'text/html; charset=utf-8', 'viewer.js': 'text/javascript', 'viewer.css': 'text/css'}[name]
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header('Content-Type', kind)
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Referrer-Policy', 'no-referrer')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:")
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except ValueError as exc:
                self.send_error(400, str(exc))
            except Exception:
                traceback.print_exc()
                self.send_error(500, 'Render failed. Inspect ovrtx.log in the session directory shown in the task terminal.')
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--session', required=True)
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--gpu', type=int, default=0)
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    if (args.port != 0 and not 1024 <= args.port <= 65535) or args.gpu < 0:
        parser.error('Use port 0 (automatic) or 1024 to 65535 and a nonnegative GPU index')
    scene = json.loads((args.output / 'scene.json').read_text(encoding='utf-8'))
    renderer = None
    server = bind_server(args.port, handler_for(scene, lambda **kw: renderer.render(**kw), args.session)) if not args.smoke else None
    try:
        from renderer import Renderer
        print('Warming OVRTX shaders…', flush=True)
        renderer = Renderer(args.output, scene, args.gpu)
        with renderer.render() as image:
            image.save(args.output / 'overview.png')
        if server:
            publish_connection(args.output, server.server_port, args.session)
            print(f'OVRTX Viewer ready: http://127.0.0.1:{server.server_port}/', flush=True)
            server.serve_forever()
    except ImportError as exc:
        raise SystemExit('Set ovrtxViewer.runtimePythonPath to Python with ovrtx, ovstage, numpy and Pillow. ' + str(exc)) from exc
    except KeyboardInterrupt:
        pass
    finally:
        if server:
            server.server_close()
            (args.output / 'connection.json').unlink(missing_ok=True)
        if renderer:
            renderer.close()


if __name__ == '__main__':
    main()
