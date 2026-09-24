const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Startet den Server mit eigener, temporärer Datenbank auf einem freien Port.
async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuehltruhen-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ...extraEnv },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;

  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (e) { /* noch nicht bereit */ }
    await new Promise(r => setTimeout(r, 100));
  }

  const api = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  return {
    base,
    api,
    stop() {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

module.exports = { startServer };
