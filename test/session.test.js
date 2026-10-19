'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {getHealth, matches, waitForReady, waitForConnection, panelHtml} = require('../session');
const ready = {service: 'ovrtx-viewer', protocol: 1, ready: true, session: 'owned-session'};

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}
test('only accepts the owned renderer session and protocol', () => {
  assert.ok(matches(ready, 'owned-session'));
  for (const value of [{...ready, ready: false}, {...ready, service: 'other'}, {...ready, protocol: 2}, {...ready, session: 'other'}, null]) {
    assert.equal(matches(value, 'owned-session'), false);
  }
});
test('waits for first-frame readiness', async t => {
  let count = 0;
  const port = await serve(t, (_, res) => { if (++count === 1) res.writeHead(503).end(); else res.end(JSON.stringify(ready)); });
  await waitForReady(port, 'owned-session', new AbortController().signal);
  assert.equal(count, 2);
});
test('refuses another session on the port', async t => {
  const port = await serve(t, (_, res) => res.end(JSON.stringify(ready)));
  await assert.rejects(waitForReady(port, 'different-session', new AbortController().signal), /another viewer/);
});
test('cancellation interrupts a hanging health request', async t => {
  const port = await serve(t, () => {});
  const controller = new AbortController();
  const waiting = waitForReady(port, 'owned-session', controller.signal);
  controller.abort(Error('process failed'));
  await assert.rejects(waiting, /process failed/);
});
test('malformed health and elapsed startup deadline fail', async t => {
  const port = await serve(t, (_, res) => res.end('invalid JSON'));
  await assert.rejects(getHealth(port));
  await assert.rejects(waitForReady(port, 'owned-session', new AbortController().signal, 0), /timed out/);
});
test('panel preserves forwarded path and escapes scene/error text', () => {
  const html = panelHtml('style', 'vscode-webview://id', 'https://forward.example/proxy/8775/?a=1&b=2');
  assert.ok(html.includes('frame-src https://forward.example'));
  assert.ok(html.includes('src="https://forward.example/proxy/8775/?a=1&amp;b=2"'));
  assert.ok(panelHtml('style', 'source', undefined, '<script>bad</script>').includes('&lt;script&gt;bad&lt;/script&gt;'));
});

test('uses the port actually claimed by the session, not the preferred port', async t => {
  const port = await serve(t, (_, res) => res.end(JSON.stringify(ready)));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ovrtx-connection-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'connection.json');
  const controller = new AbortController();
  const pending = waitForConnection(file, 'owned-session', controller.signal);
  await fs.writeFile(file, JSON.stringify({...ready, port}));
  assert.equal(await pending, port);
  await fs.writeFile(file, JSON.stringify({...ready, session: 'other', port}));
  await assert.rejects(waitForConnection(file, 'owned-session', controller.signal), /Invalid viewer connection/);
  await fs.writeFile(file, JSON.stringify({...ready, port: 0}));
  await assert.rejects(waitForConnection(file, 'owned-session', controller.signal), /Invalid viewer connection/);
});

test('connection wait is cancellable before the server publishes its port', async () => {
  const controller = new AbortController();
  const pending = waitForConnection(path.join(os.tmpdir(), 'missing-ovrtx-connection.json'), 'owned-session', controller.signal);
  controller.abort(Error('startup cancelled'));
  await assert.rejects(pending, /startup cancelled/);
});
