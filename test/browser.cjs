// Browser UI checks use an explicit test frame, not an OVRTX render.
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const requests = [], errors = [];
  let failFrame = false;
  const root = path.join(__dirname, '../runtime/web');
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      // Use a path prefix to exercise forwarded URI behavior.
      const route = url.pathname.replace(/^\/proxy\/8775\//, '');
      if (route === 'scene') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({name: 'test scene.usda', source: '/models/test scene.usda', camera_up_axis: 'Z', meters_per_unit: 1}));
      } else if (route === 'frame') {
        requests.push(Object.fromEntries(url.searchParams));
        if (failFrame) { response.writeHead(500).end(); return; }
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#182025"/><text x="640" y="400" text-anchor="middle" fill="#94a0a9" font-family="sans-serif" font-size="20">UI test frame · not an RTX render</text></svg>');
      } else if (['', 'viewer.js', 'viewer.css'].includes(route)) {
        const file = route || 'index.html';
        response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
        response.end(await fs.readFile(path.join(root, file)));
      } else response.writeHead(404).end();
    } catch (error) { response.writeHead(500).end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless: true, channel: 'msedge'});
    const page = await browser.newPage({viewport: {width: 1280, height: 800}});
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/proxy/8775/`);
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Ready');
    assert.equal(await page.locator('#name').innerText(), 'test scene.usda');
    await page.locator('#top').click();
    await page.waitForTimeout(150);
    assert.equal(requests.at(-1).elevation, '89.9');
    await page.locator('#front').click();
    await page.waitForTimeout(150);
    assert.equal(requests.at(-1).elevation, '0');
    await page.locator('#frame').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    assert.equal(requests.at(-1).yaw, '5');
    await page.keyboard.press('Shift+ArrowUp');
    await page.waitForTimeout(150);
    assert.equal(requests.at(-1).pan_y, '0.05');
    await page.locator('#frame').hover();
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(200);
    assert.ok(Number(requests.at(-1).zoom) > 1);
    await page.keyboard.press('f');
    await page.waitForTimeout(150);
    assert.equal(requests.at(-1).zoom, '1');
    assert.equal(requests.at(-1).pan_y, '0');
    const box = await page.locator('#frame').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, {steps: 5});
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.ok(Number(requests.at(-1).yaw) > 30);
    failFrame = true;
    await page.locator('#reset').click();
    await page.waitForFunction(() => !document.getElementById('retry').hidden);
    failFrame = false;
    await page.locator('#retry').click();
    await page.waitForFunction(() => document.getElementById('retry').hidden);
    for (const [width, height] of [[1280, 800], [640, 600], [360, 640]]) {
      await page.setViewportSize({width, height});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const frame = await page.locator('#frame').boundingBox();
      assert.ok(frame.height > 200 && frame.y + frame.height <= height);
    }
    await fs.mkdir(path.join(__dirname, '../qa'), {recursive: true});
    await page.setViewportSize({width: 1280, height: 800});
    await page.screenshot({path: path.join(__dirname, '../qa/viewer-ui.png')});
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: load, forwarded paths, orbit, pan, zoom, frame all, retry, and responsive layout.');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
