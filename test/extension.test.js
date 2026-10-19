'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(options = {}) {
  const commands = {}, errors = [], tasks = [], endListeners = [], forwarded = [];
  const root = path.resolve('/gpu/project');
  const uri = {scheme: 'file', fsPath: path.join(root, 'a scene.usda')};
  const folder = {uri: {fsPath: root}};
  let html = '', waitSignal, dispose;
  const vscode = {
    workspace: {isTrusted: options.trusted !== false, workspaceFolders: [folder], getWorkspaceFolder: () => folder,
      getConfiguration: () => ({get: (key, fallback) => ({pythonPath: path.join(root, 'usd/python'), runtimePythonPath: path.join(root, 'rtx/python')})[key] ?? fallback})},
    window: {
      showOpenDialog: async () => options.cancel ? undefined : [uri],
      showInformationMessage() {}, showErrorMessage: message => errors.push(message),
      createWebviewPanel: () => ({webview: {asWebviewUri: () => ({toString: () => 'vscode-webview://id/panel.css'}), cspSource: 'vscode-webview://id',
        set html(value) { html = value; }}, reveal() {}, onDidDispose(callback) { dispose = callback; }})
    },
    commands: {registerCommand: (id, callback) => { commands[id] = callback; return {}; }},
    ViewColumn: {Active: 1}, TaskScope: {Global: 1}, TaskRevealKind: {Always: 1}, TaskPanelKind: {Dedicated: 1},
    Uri: {joinPath: () => ({}), parse: value => value},
    env: {asExternalUri: async uri => { forwarded.push(uri); return {toString: () => 'https://forward.example/proxy/49152/'}; }},
    ProcessExecution: class { constructor(command, args, options) { Object.assign(this, {command, args, options}); } },
    Task: class { constructor(definition, scope, name, source, execution) { Object.assign(this, {definition, scope, name, source, execution}); } },
    tasks: {
      executeTask: async task => {
        const execution = {task, terminate() { execution.terminated = true; for (const callback of endListeners) callback({execution}); }};
        tasks.push(execution);
        return execution;
      },
      onDidEndTask: callback => { endListeners.push(callback); return {}; }, onDidEndTaskProcess: () => ({})
    }
  };
  const session = {...require('../session'), waitForConnection: async (_, id, signal) => {
    waitSignal = signal;
    if (options.hang) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    return 49152;
  }};
  const fakeFs = {realpath: async value => value, stat: async () => ({isFile: () => true}), mkdir: async () => {}};
  const context = {module: {exports: {}}, require: id => id === 'vscode' ? vscode : id === './session' ? session : id === 'node:fs/promises' ? fakeFs : require(id), process, AbortController, setTimeout, clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8'), context);
  context.module.exports.activate({subscriptions: [], extensionUri: {}, extensionPath: '/extension', globalStorageUri: {fsPath: '/storage'}});
  return {commands, errors, tasks, uri, root, forwarded, dispose: () => dispose(), get html() { return html; }, get signal() { return waitSignal; }};
}

test('file picker launches a bundled viewer with literal scene and runtime arguments', async () => {
  const h = harness();
  await h.commands['ovrtxViewer.open']();
  assert.deepEqual(h.errors, []);
  assert.equal(h.tasks.length, 1);
  const args = h.tasks[0].task.execution.args;
  assert.equal(args[args.indexOf('--source') + 1], h.uri.fsPath);
  assert.equal(args[args.indexOf('--runtime-python') + 1], path.join(h.root, 'rtx/python'));
  assert.equal(args[args.indexOf('--port') + 1], '0');
  assert.equal(h.forwarded[0], 'http://127.0.0.1:49152/' + h.tasks[0].task.definition.session + '/');
  assert.ok(h.html.includes('https://forward.example/proxy/49152/'));
});
test('opening another scene stops only the owned task before launching', async () => {
  const h = harness();
  await h.commands['ovrtxViewer.open'](h.uri);
  await h.commands['ovrtxViewer.open']({...h.uri, fsPath: path.join(h.root, 'second.usdc')});
  assert.deepEqual(h.errors, []);
  assert.equal(h.tasks.length, 2);
  assert.ok(h.tasks[0].terminated);
  assert.ok(!h.tasks[1].terminated);
  await h.commands['ovrtxViewer.stop']();
  assert.ok(h.tasks[1].terminated);
});
test('cancel and untrusted workspaces never launch a process', async () => {
  for (const options of [{cancel: true}, {trusted: false}]) {
    const h = harness(options);
    await h.commands['ovrtxViewer.open']();
    assert.equal(h.tasks.length, 0);
  }
});
test('unsupported file selections never launch a process', async () => {
  const h = harness();
  await h.commands['ovrtxViewer.open']({...h.uri, fsPath: 'scene.txt'});
  assert.equal(h.tasks.length, 0);
  assert.match(h.errors[0], /Choose a/);
});
test('stop cancels renderer warmup and terminates the owned task', async () => {
  const h = harness({hang: true});
  const opening = h.commands['ovrtxViewer.open'](h.uri);
  while (!h.signal) await new Promise(resolve => setImmediate(resolve));
  await h.commands['ovrtxViewer.stop']();
  await opening;
  assert.ok(h.signal.aborted);
  assert.ok(h.tasks[0].terminated);
});

test('closing the panel terminates its owned task and cancels requests', async () => {
  const h = harness();
  await h.commands['ovrtxViewer.open'](h.uri);
  h.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.tasks[0].terminated);
  assert.ok(h.signal.aborted);
});
