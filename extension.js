'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {waitForConnection, panelHtml} = require('./session');
let active, panel, opening = false;

function showPanel(context, title, address, message) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel('ovrtxViewer', title, vscode.ViewColumn.Active,
      {enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri]});
    panel.onDidDispose(() => { panel = undefined; void stop().catch(error => vscode.window.showErrorMessage(error.message)); });
  }
  panel.title = title;
  const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'panel.css'));
  panel.webview.html = panelHtml(css.toString(), panel.webview.cspSource, address, message);
  panel.reveal();
}

async function pythonPaths(config, folder) {
  const suffix = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  const roots = folder ? [folder.uri.fsPath] : [];
  async function find(configured, candidates, setting) {
    if (configured) {
      if (!path.isAbsolute(configured)) throw Error(setting + ' must be an absolute Python executable path.');
      candidates = [configured];
    }
    for (const candidate of candidates) {
      try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* Try next environment. */ }
    }
    throw Error('Set ' + setting + ' to a Python executable on the GPU host. See the OVRTX Viewer README for runtime requirements.');
  }
  const runtime = await find(config.get('runtimePythonPath'),
    roots.map(root => path.join(root, '.venv', suffix)), 'ovrtxViewer.runtimePythonPath');
  const python = await find(config.get('pythonPath'), [...roots.map(root => path.join(root, '.venv', suffix)), runtime], 'ovrtxViewer.pythonPath');
  return {python, runtime};
}

async function stop() {
  const previous = active;
  if (!previous) return;
  previous.controller.abort(Error('Viewer stopped.'));
  previous.execution?.terminate();
  let timer;
  try {
    await Promise.race([previous.ended, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('The previous viewer is still stopping. Check its task terminal.')), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

async function open(context, uri) {
  if (opening) { vscode.window.showInformationMessage('OVRTX Viewer is starting. Use OVRTX Viewer: Stop Viewer to cancel.'); return; }
  opening = true;
  let started;
  try {
    if (!vscode.workspace.isTrusted) throw Error('Trust the workspace before starting OVRTX Viewer.');
    if (!uri) {
      const selected = await vscode.window.showOpenDialog({canSelectMany: false, openLabel: 'Open USD Scene', filters: {'USD scenes': ['usd', 'usda', 'usdc']}});
      if (!selected?.length) return;
      uri = selected[0];
    }
    if (!['file', 'vscode-remote'].includes(uri.scheme) || !/\.(usd|usda|usdc)$/i.test(uri.fsPath)) throw Error('Choose a .usd, .usda, or .usdc file on the extension host.');
    const source = await fs.realpath(uri.fsPath);
    if (!(await fs.stat(source)).isFile()) throw Error('Choose a USD file.');
    const folder = vscode.workspace.getWorkspaceFolder(uri) || vscode.workspace.workspaceFolders?.[0];
    const config = vscode.workspace.getConfiguration('ovrtxViewer', uri);
    const preferredPort = config.get('port', 0), gpu = config.get('gpu', 0);
    if (!Number.isInteger(preferredPort) || (preferredPort !== 0 && preferredPort < 1024) || preferredPort > 65535 || !Number.isInteger(gpu) || gpu < 0) throw Error('Invalid OVRTX Viewer port or GPU setting.');
    const {python, runtime} = await pythonPaths(config, folder);
    // Each Open reloads the chosen file, including edits made since the last view.
    await stop();
    const id = randomUUID();
    const out = path.join(context.globalStorageUri.fsPath, 'sessions', id);
    await fs.mkdir(out, {recursive: true});
    const args = ['-u', path.join(context.extensionPath, 'runtime', 'launch.py'), '--source', source,
      '--output', out, '--runtime-python', runtime, '--port', String(preferredPort), '--gpu', String(gpu), '--session', id];
    const task = new vscode.Task({type: 'ovrtx-viewer', session: id}, folder || vscode.TaskScope.Global,
      'OVRTX Viewer', 'OVRTX Viewer', new vscode.ProcessExecution(python, args, {cwd: path.dirname(source)}), []);
    task.presentationOptions = {reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, focus: false};
    let resolveEnded;
    started = active = {id, controller: new AbortController(), ended: new Promise(resolve => { resolveEnded = resolve; }), resolveEnded: () => resolveEnded()};
    showPanel(context, 'OVRTX Viewer · ' + path.basename(source), undefined, 'Loading ' + path.basename(source) + '…');
    started.execution = await vscode.tasks.executeTask(task);
    if (started.controller.signal.aborted) { started.execution.terminate(); throw started.controller.signal.reason; }
    const port = await waitForConnection(path.join(out, 'connection.json'), id, started.controller.signal);
    const external = await vscode.env.asExternalUri(vscode.Uri.parse('http://127.0.0.1:' + port + '/' + id + '/'));
    if (started.controller.signal.aborted) throw started.controller.signal.reason;
    showPanel(context, 'OVRTX Viewer · ' + path.basename(source), external.toString());
  } catch (error) {
    const message = started?.controller.signal.reason?.message || error.message;
    if (started && !started.execution && active === started) { started.resolveEnded(); active = undefined; }
    started?.execution?.terminate();
    if (panel || !started) showPanel(context, 'OVRTX Viewer', undefined, message);
    vscode.window.showErrorMessage('OVRTX Viewer: ' + message);
  } finally { opening = false; }
}

function activate(context) {
  function ended(execution, exitCode) {
    if (!active || active.id !== execution.task.definition.session) return;
    const previous = active;
    active = undefined;
    previous.controller.abort(Error('Viewer exited (' + (exitCode ?? 'task ended') + '). See the OVRTX Viewer task terminal.'));
    previous.resolveEnded();
    if (panel) showPanel(context, 'OVRTX Viewer', undefined, 'Viewer stopped. Run OVRTX Viewer: Open USD Scene to load a scene.');
  }
  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess(event => ended(event.execution, event.exitCode)),
    vscode.tasks.onDidEndTask(event => ended(event.execution)),
    vscode.commands.registerCommand('ovrtxViewer.open', uri => open(context, uri)),
    vscode.commands.registerCommand('ovrtxViewer.stop', () => stop().catch(error => vscode.window.showErrorMessage(error.message)))
  );
}
function deactivate() { active?.controller.abort(Error('Extension deactivated')); active?.execution?.terminate(); }
module.exports = {activate, deactivate};
