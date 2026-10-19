'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const {setTimeout: delay} = require('node:timers/promises');

function matches(health, session) {
  return health?.service === 'ovrtx-viewer' && health.protocol === 1 &&
    health.ready === true && health.session === session;
}

function getHealth(port, signal, session) {
  return new Promise((resolve, reject) => {
    const request = http.get({hostname: '127.0.0.1', port, path: '/' + encodeURIComponent(session) + '/health', timeout: 1500, signal}, response => {
      if (response.statusCode !== 200) { response.resume(); reject(Error('Viewer is not ready')); return; }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 8192) request.destroy(Error('Invalid viewer health response'));
      });
      response.on('error', reject);
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('timeout', () => request.destroy(Error('Viewer is still starting')));
    request.on('error', reject);
  });
}

async function waitForReady(port, session, signal, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    const health = await getHealth(port, signal, session).catch(() => null);
    if (signal.aborted) break;
    if (health) {
      if (!matches(health, session)) throw Error('This port belongs to another viewer. Change ovrtxViewer.port.');
      return;
    }
    await delay(500, undefined, {signal}).catch(() => {});
  }
  throw signal.reason || Error('Viewer startup timed out. Inspect the OVRTX Viewer task terminal.');
}

async function waitForConnection(file, session, signal, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    let connection;
    try { connection = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (connection) {
      if (!matches(connection, session) || !Number.isInteger(connection.port) || connection.port < 1024 || connection.port > 65535) {
        throw Error('Invalid viewer connection metadata for this session.');
      }
      await waitForReady(connection.port, session, signal, Math.max(0, deadline - Date.now()));
      return connection.port;
    }
    await delay(100, undefined, {signal}).catch(() => {});
  }
  throw signal.reason || Error('Viewer startup timed out. Inspect the OVRTX Viewer task terminal.');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
}

function panelHtml(css, cspSource, address, message = '') {
  const origin = address ? new URL(address).origin : "'none'";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(cspSource)}; frame-src ${escapeHtml(origin)};">
<link rel="stylesheet" href="${escapeHtml(css)}"><title>OVRTX Viewer</title></head>
<body>${address ? `<iframe title="OVRTX Viewer" src="${escapeHtml(address)}" sandbox="allow-scripts allow-same-origin"></iframe>` : `<main><p>OVRTX VIEWER</p><h1>USD scene viewer</h1><p role="status">${escapeHtml(message)}</p><p>See the OVRTX Viewer task terminal for progress. First shader compilation can take several minutes.</p></main>`}</body></html>`;
}
module.exports = {getHealth, matches, waitForReady, waitForConnection, panelHtml};
