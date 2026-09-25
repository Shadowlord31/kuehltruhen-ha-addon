const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Startet den Server mit eigener, temporärer Datenbank auf einem freien Port.
async function startServer(extraEnv = {}) {
  // Mit eigenem DATA_DIR (z. B. vorbereitete Alt-Datenbank) räumt der Aufrufer selbst auf
  const ownDir = !extraEnv.DATA_DIR;
  const dir = extraEnv.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'kuehltruhen-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, ...extraEnv, PORT: String(port), DATA_DIR: dir },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;

  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (e) { /* noch nicht bereit */ }
    await new Promise(r => setTimeout(r, 100));
  }

  const api = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };

  return {
    base,
    dir,
    api,
    // Wartet, bis der Serverprozess beendet ist (danach darf die Datenbankdatei geprüft werden)
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await exited;
      }
      if (ownDir) fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

module.exports = { startServer };
