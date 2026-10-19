'use strict';
const frame = document.getElementById('frame');
const viewport = document.querySelector('.viewport');
const status = document.getElementById('status');
const retry = document.getElementById('retry');
const camera = {yaw: 30, elevation: 30, zoom: 1, pan_x: 0, pan_y: 0};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const lifetime = new AbortController();
let disposed = false;
let loaded = false, busy = false, pending = false, objectURL, gesture, timer;

async function refresh() {
  if (!loaded || disposed) return;
  if (busy) { pending = true; return; }
  busy = true;
  viewport.setAttribute('aria-busy', 'true');
  status.textContent = 'Rendering…';
  try {
    // Relative routes preserve VS Code's forwarded URL prefix.
    const response = await fetch('frame?' + new URLSearchParams(camera), {signal: lifetime.signal});
    if (!response.ok) throw Error('Render failed (' + response.status + '). Check the task terminal, then Retry.');
    const blob = await response.blob();
    if (disposed) return;
    const next = URL.createObjectURL(blob);
    const old = objectURL;
    frame.src = next;
    objectURL = next;
    if (old) URL.revokeObjectURL(old);
    status.textContent = 'Ready';
    retry.hidden = true;
  } catch (error) {
    if (disposed) return;
    status.textContent = error.message;
    retry.hidden = false;
  } finally {
    busy = false;
    viewport.setAttribute('aria-busy', 'false');
    if (pending && !disposed) { pending = false; refresh(); }
  }
}

function schedule() { if (disposed) return; clearTimeout(timer); timer = setTimeout(refresh, 60); }
function reset(yaw = 30, elevation = 30) {
  Object.assign(camera, {yaw, elevation, zoom: 1, pan_x: 0, pan_y: 0});
  schedule();
}
document.getElementById('reset').addEventListener('click', () => reset());
document.getElementById('perspective').addEventListener('click', () => reset());
document.getElementById('top').addEventListener('click', () => reset(0, 89.9));
document.getElementById('front').addEventListener('click', () => reset(0, 0));
frame.addEventListener('pointerdown', event => {
  if (!loaded || ![0, 1, 2].includes(event.button)) return;
  event.preventDefault();
  frame.focus();
  frame.setPointerCapture(event.pointerId);
  gesture = {id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.shiftKey || event.button !== 0};
});
frame.addEventListener('pointermove', event => {
  if (!gesture || gesture.id !== event.pointerId) return;
  const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
  gesture.x = event.clientX;
  gesture.y = event.clientY;
  if (gesture.pan) {
    camera.pan_x = clamp(camera.pan_x - dx / Math.max(1, frame.clientWidth), -2, 2);
    camera.pan_y = clamp(camera.pan_y + dy / Math.max(1, frame.clientHeight), -2, 2);
  } else {
    camera.yaw = ((camera.yaw + dx * .5 + 540) % 360) - 180;
    camera.elevation = clamp(camera.elevation + dy * .3, -89.9, 89.9);
  }
  refresh();
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) frame.addEventListener(name, () => { gesture = undefined; });
frame.addEventListener('contextmenu', event => event.preventDefault());
frame.addEventListener('dragstart', event => event.preventDefault());
frame.addEventListener('wheel', event => {
  event.preventDefault();
  camera.zoom = clamp(camera.zoom * Math.exp(-event.deltaY * .002), .3, 4);
  schedule();
}, {passive: false});
frame.addEventListener('dblclick', () => reset());
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); reset(); return; }
  if (document.activeElement !== frame || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(event.key)) return;
  event.preventDefault();
  const horizontal = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  const vertical = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
  if (event.shiftKey) {
    camera.pan_x = clamp(camera.pan_x + horizontal * .05, -2, 2);
    camera.pan_y = clamp(camera.pan_y + vertical * .05, -2, 2);
  } else {
    camera.yaw = ((camera.yaw + horizontal * 5 + 540) % 360) - 180;
    camera.elevation = clamp(camera.elevation + vertical * 5, -89.9, 89.9);
  }
  if (['+', '=', '-'].includes(event.key)) camera.zoom = clamp(camera.zoom + (event.key === '-' ? -.1 : .1), .3, 4);
  schedule();
});

async function loadScene() {
  if (disposed) return;
  try {
    const response = await fetch('scene', {signal: lifetime.signal});
    if (!response.ok) throw Error('Could not load the scene. Check the task terminal, then Retry.');
    const scene = await response.json();
    if (disposed) return;
    document.getElementById('name').textContent = scene.name;
    document.getElementById('name').title = scene.source;
    document.getElementById('units').textContent = scene.camera_up_axis + '-up · ' + scene.meters_per_unit + ' m/unit';
    loaded = true;
    await refresh();
  } catch (error) {
    if (disposed) return;
    status.textContent = error.message;
    retry.hidden = false;
    viewport.setAttribute('aria-busy', 'false');
  }
}
retry.addEventListener('click', () => loaded ? refresh() : loadScene());
window.addEventListener('pagehide', () => {
  disposed = true;
  pending = false;
  gesture = undefined;
  clearTimeout(timer);
  lifetime.abort();
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = undefined;
});
loadScene();
