'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const tick = () => new Promise(resolve => setImmediate(resolve));
test('repeated frames retain one blob; closing aborts pending work and releases it', async () => {
  const elements = new Map(), events = {}, live = new Set();
  let next = 0, held, hold = false, aborted = false;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {setAttribute() {}, addEventListener() {}});
    return elements.get(id);
  };
  const context = vm.createContext({AbortController, URLSearchParams, setTimeout, clearTimeout,
    document: {getElementById: element, querySelector: element, addEventListener() {}},
    window: {addEventListener: (name, callback) => { events[name] = callback; }},
    URL: {createObjectURL: () => { const id = String(++next); live.add(id); return id; }, revokeObjectURL: id => live.delete(id)},
    fetch: async (url, {signal}) => {
      signal.addEventListener('abort', () => { aborted = true; }, {once: true});
      if (url === 'scene') return {ok: true, json: async () => ({name: 'test'})};
      return {ok: true, blob: () => hold ? new Promise(resolve => { held = resolve; }) : Promise.resolve({})};
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../runtime/web/viewer.js'), 'utf8'), context);
  await tick();
  for (let i = 0; i < 100; i++) {
    await vm.runInContext('refresh()', context);
    assert.equal(live.size, 1);
  }
  hold = true;
  const pending = vm.runInContext('refresh()', context);
  await tick();
  await vm.runInContext('refresh()', context); // queue another render
  events.pagehide();
  held({}); // A response already being decoded can outlive fetch cancellation.
  await pending;
  await tick();
  assert.ok(aborted);
  assert.equal(live.size, 0);
  const count = next;
  await vm.runInContext('refresh(); loadScene();', context);
  assert.equal(next, count);
});
