// A small CDP capture tool: serves the built output, opens one route of the dashboard in desktop
// Chrome at the competition's size, waits for the page to render, and saves a PNG.
//
//   node tools/capture.mjs --route "#board" --out screenshots/1-board.png
//
// The page is served from out/ (main.ts writes out/dashboard/ and out/data.js), so the screenshot is of
// the real program's output, never of a mockup.

import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repo, 'out');
const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf('--' + name);
  return index === -1 ? fallback : args[index + 1];
}
const route = arg('route', '#board');
const outPath = resolve(repo, arg('out', 'screenshots/1-board.png'));
const width = Number(arg('width', '1400'));
const height = Number(arg('height', '900'));
const settle = Number(arg('settle', '500'));
const port = Number(arg('port', '8092'));
const chromePath = arg('chrome', 'C:/Users/ACER/AppData/Local/Google/Chrome/Application/chrome.exe');
const profile = join(tmpdir(), 'token-radar-cdp-' + process.pid);
const debugPort = Number(arg('debugPort', '9333'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = resolve(join(root, normalize(pathname)));
  if (file !== root && !file.startsWith(root + sep)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end('not found');
  }
});

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function getJson(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // Chrome is still coming up.
    }
    await wait(200);
  }
  throw new Error('no response from ' + url);
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else done(message.result);
      }
    });
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((done, reject) => {
      this.pending.set(id, { resolve: done, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 60000);
    });
  }
}

let serverHandle = null;
let chrome = null;
try {
  await new Promise((done) => server.listen(port, '127.0.0.1', done));
  serverHandle = server;
  await mkdir(resolve(outPath, '..'), { recursive: true });
  chrome = spawn(chromePath, [
    '--headless=new',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
    '--window-size=' + width + ',' + height,
    'about:blank',
  ], { stdio: 'ignore' });
  const targets = await getJson('http://127.0.0.1:' + debugPort + '/json/list');
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('no page target');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/dashboard/index.html' + route });
  let ready = false;
  for (let i = 0; i < 120; i += 1) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'document.readyState === "complete" && !!window.RADAR && (!!document.querySelector(".kpis") || !!document.querySelector(".detail-head") || !!document.querySelector(".method") || !!document.querySelector(".filtered-head"))',
      returnByValue: true,
    }).catch(() => ({ result: { value: false } }));
    if (result.result?.value === true) { ready = true; break; }
    await wait(150);
  }
  if (!ready) {
    const diag = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ title: document.title, rows: window.RADAR ? window.RADAR.rows.length : null, body: document.body.innerText.slice(0, 400) })',
      returnByValue: true,
    }).catch(() => null);
    throw new Error('page never rendered: ' + (diag?.result?.value ?? 'no diagnostic'));
  }
  await wait(settle);
  const errors = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__RADAR_ERRORS__ || [])',
    returnByValue: true,
  }).catch(() => null);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const buffer = Buffer.from(shot.data, 'base64');
  await writeFile(outPath, buffer);
  const info = await stat(outPath);
  console.log(outPath + ' \u00b7 ' + info.size + ' bytes \u00b7 ' + width + 'x' + height + ' \u00b7 route ' + route + (errors?.result?.value && errors.result.value !== '[]' ? ' \u00b7 page errors ' + errors.result.value : ''));
  socket.close();
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  if (chrome) chrome.kill('SIGKILL');
  if (serverHandle) serverHandle.close();
}
