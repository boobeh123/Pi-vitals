// Starts the real server.js on a free port and checks it over HTTP: the dashboard, both JSON APIs,
// the 404 page, and the temperature history file. Reads this Pi's real sensors, so run it on the Pi.
//
//   npm test
//
// HISTORY_FILE points each server at a temp folder, so the dashboard's own data/history.json is never touched.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_DIR = path.join(__dirname, '..');
const MINUTE_MS = 60 * 1000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getFreePort = () =>
  new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

// Runs server.js with its own port and history file, and waits until it answers
const startServer = async (historyFile) => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', HISTORY_FILE: historyFile, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errorOutput = '';
  child.stderr.on('data', (chunk) => {
    errorOutput += chunk;
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  for (let tries = 0; tries < 50; tries += 1) {
    try {
      await fetch(`${baseUrl}/api/history`);
      return { child, baseUrl, getErrorOutput: () => errorOutput };
    } catch {
      await wait(100);
    }
  }
  child.kill();
  throw new Error(`server.js did not start:\n${errorOutput}`);
};

// Stops the server the way systemd does, and resolves with how it exited
const stopServer = (child) =>
  new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.kill('SIGTERM');
  });

const getJson = async (url) => {
  const response = await fetch(url);
  return { status: response.status, type: response.headers.get('content-type'), body: await response.json() };
};

describe('the running server', () => {
  let tempDir;
  let server;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-vitals-test-'));
    server = await startServer(path.join(tempDir, 'history.json'));
  });

  after(async () => {
    if (server) await stopServer(server.child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves the dashboard', async () => {
    const response = await fetch(server.baseUrl);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<h1 class="siteTitle">Pi Vitals<\/h1>/);
    assert.ok(html.includes(os.hostname()), 'shows the hostname');
    assert.match(html, /name="chartRange" value="24h"/);
  });

  it('sends security headers', async () => {
    const response = await fetch(server.baseUrl);
    assert.ok(response.headers.get('content-security-policy'));
    assert.equal(response.headers.get('x-powered-by'), null);
  });

  it('returns the vitals as JSON', async () => {
    const { status, type, body } = await getJson(`${server.baseUrl}/api/vitals`);
    assert.equal(status, 200);
    assert.match(type, /application\/json/);

    assert.ok(Math.abs(body.time - Date.now()) < 5000, 'time is now');
    assert.ok(body.cpuTempC > 0 && body.cpuTempC < 110, `CPU temperature ${body.cpuTempC}`);
    assert.ok(body.cores >= 1);
    assert.equal(body.load.length, 3);
    assert.ok(body.uptimeSec > 0);
    assert.ok(body.memory.totalMb > 0 && body.memory.usedMb > 0 && body.memory.usedMb < body.memory.totalMb);
    assert.ok(body.memory.swapUsedMb >= 0 && body.memory.swapUsedMb <= body.memory.swapTotalMb);
    assert.ok(body.disk.totalBytes > body.disk.usedBytes && body.disk.usedPercent > 0 && body.disk.usedPercent <= 100);
    assert.equal(typeof body.adguard, 'string');
    assert.equal(typeof body.dnsCheck.ok, 'boolean');
    assert.ok(Math.abs(body.lastRestart.bootedAt - (Date.now() - body.uptimeSec * 1000)) < 5000, 'booted uptime ago');
    assert.equal(typeof body.lastRestart.logReadable, 'boolean');
  });

  it('lists the busiest programs from the second poll on', async () => {
    // The server measures CPU use between two polls, so ask twice
    await getJson(`${server.baseUrl}/api/vitals`);
    await wait(500);
    const { body } = await getJson(`${server.baseUrl}/api/vitals`);
    assert.ok(Array.isArray(body.topProcesses) && body.topProcesses.length > 0 && body.topProcesses.length <= 5);
    body.topProcesses.forEach((program) => {
      assert.equal(typeof program.name, 'string');
      assert.ok(program.cpuPercent >= 0 && program.memoryMb >= 0 && program.count >= 1);
    });
  });

  it('returns the temperature history as JSON', async () => {
    const { status, body } = await getJson(`${server.baseUrl}/api/history`);
    assert.equal(status, 200);
    assert.ok(body.recent.length >= 1, 'a reading is taken as soon as the server starts');
    assert.ok(body.recent.every((sample) => Number.isFinite(sample.time) && Number.isFinite(sample.tempC)));
    assert.deepEqual(body.minutes, []);
  });

  it('shows a 404 page for unknown pages', async () => {
    const response = await fetch(`${server.baseUrl}/no-such-page`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /That page does not exist\./);
  });
});

describe('the temperature history file', () => {
  let tempDir;
  let historyFile;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-vitals-test-'));
    historyFile = path.join(tempDir, 'history.json');
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads the saved day, skipping readings older than 24 hours and broken ones', async () => {
    const now = Date.now();
    const kept = [
      { time: now - 10 * MINUTE_MS, tempC: 51.25 },
      { time: now - 5 * MINUTE_MS, tempC: 52.5 },
    ];
    fs.writeFileSync(historyFile, JSON.stringify({
      minutes: [{ time: now - 25 * 60 * MINUTE_MS, tempC: 49 }, ...kept, { time: 'soon', tempC: 50 }],
    }));

    const server = await startServer(historyFile);
    const { body } = await getJson(`${server.baseUrl}/api/history`);
    const exit = await stopServer(server.child);

    assert.deepEqual(body.minutes, kept);
    assert.deepEqual(exit, { code: 0, signal: null }, 'SIGTERM ends it cleanly');
    const saved = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    assert.deepEqual(saved.minutes.slice(0, 2), kept, 'it saved the history again on the way out');
    assert.equal(fs.existsSync(`${historyFile}.tmp`), false);
  });

  it('starts a fresh history when the file is damaged', async () => {
    fs.writeFileSync(historyFile, '{"minutes": [{"time": 1, "tem');

    const server = await startServer(historyFile);
    const { body } = await getJson(`${server.baseUrl}/api/history`);
    await stopServer(server.child);

    assert.deepEqual(body.minutes, []);
    assert.match(server.getErrorOutput(), /is unreadable/);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(historyFile, 'utf8')), 'the file is valid again');
  });
});
