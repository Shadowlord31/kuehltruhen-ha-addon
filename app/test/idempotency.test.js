const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');
const { purgeOld } = require('../idempotency');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(() => srv.stop());

let counter = 0;
const key = () => `test-key-${Date.now()}-${++counter}-abcdef`;
const withKey = k => ({ 'Idempotency-Key': k });
const products = async () => (await srv.api('GET', '/api/products')).body;

test('Dieselbe Vorgangs-ID legt einen Artikel nur einmal an (auch bei 3 Wiederholungen)', async () => {
  const k = key();
  const responses = [];
  for (let i = 0; i < 3; i++) responses.push(await srv.api('POST', '/api/products', { name: 'Hack', unit: 'kg' }, withKey(k)));
  assert.deepEqual(responses.map(r => r.status), [200, 200, 200]);
  assert.equal(new Set(responses.map(r => r.body.id)).size, 1);
  assert.equal(responses[0].headers.get('idempotent-replay'), null);
  assert.equal(responses[1].headers.get('idempotent-replay'), 'true');
  assert.equal((await products()).filter(p => p.name === 'Hack').length, 1);
});

test('Gleichzeitige Anfragen mit derselben Vorgangs-ID werden nur einmal ausgeführt', async () => {
  const k = key();
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => srv.api('POST', '/api/products', { name: 'Parallel', unit: 'kg' }, withKey(k))));
  assert.ok(all.every(r => r.status === 200));
  assert.equal(new Set(all.map(r => r.body.id)).size, 1);
  assert.equal((await products()).filter(p => p.name === 'Parallel').length, 1);
});

test('Buchungen mit gleicher Vorgangs-ID werden nicht doppelt gebucht, mit neuer ID schon', async () => {
  const { body: p } = await srv.api('POST', '/api/products', { name: 'Erbsen', unit: 'kg' });
  const total = async () => (await srv.api('GET', `/api/products/${p.id}`)).body.total;
  const k = key();
  await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 2 }, withKey(k));
  await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 2 }, withKey(k)); // Wiederholung
  assert.equal(await total(), 2);
  await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 2 }, withKey(key())); // bewusst nochmal
  assert.equal(await total(), 4);

  const k2 = key();
  await srv.api('POST', `/api/products/${p.id}/stock-out`, { location_id: 1, quantity: 1 }, withKey(k2));
  await srv.api('POST', `/api/products/${p.id}/stock-out`, { location_id: 1, quantity: 1 }, withKey(k2));
  assert.equal(await total(), 3);

  // Undo, Umlagern und Inventur sind ebenso geschützt
  const { body: log } = await srv.api('GET', `/api/movements?product_id=${p.id}`);
  const k3 = key();
  assert.equal((await srv.api('POST', `/api/movements/${log[0].id}/undo`, undefined, withKey(k3))).status, 200);
  const again = await srv.api('POST', `/api/movements/${log[0].id}/undo`, undefined, withKey(k3));
  assert.equal(again.status, 200); // Wiederholung liefert die alte Antwort statt „bereits rückgängig“ (409)
  assert.equal(again.headers.get('idempotent-replay'), 'true');

  const k4 = key();
  const move = { from_location_id: 1, to_location_id: 2, quantity: 2 };
  await srv.api('POST', `/api/products/${p.id}/transfer`, move, withKey(k4));
  await srv.api('POST', `/api/products/${p.id}/transfer`, move, withKey(k4));
  const d = (await srv.api('GET', `/api/products/${p.id}`)).body;
  assert.equal(d.stock.filter(s => s.location_id === 2).reduce((s, x) => s + x.quantity, 0), 2);
});

test('Gleiche Vorgangs-ID für eine andere Anfrage wird abgelehnt (422)', async () => {
  const { body: p } = await srv.api('POST', '/api/products', { name: 'Mais', unit: 'kg' });
  const k = key();
  assert.equal((await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 1 }, withKey(k))).status, 200);
  assert.equal((await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 5 }, withKey(k))).status, 422); // anderer Inhalt
  assert.equal((await srv.api('POST', `/api/products/${p.id}/stock-out`, { location_id: 1, quantity: 1 }, withKey(k))).status, 422); // anderer Pfad
  assert.equal((await srv.api('GET', `/api/products/${p.id}`)).body.total, 1);
});

test('Fehlerantworten werden nicht gemerkt – nach Korrektur klappt dieselbe Vorgangs-ID', async () => {
  const k = key();
  assert.equal((await srv.api('POST', '/api/products', { name: '', unit: 'kg' }, withKey(k))).status, 400);
  const ok = await srv.api('POST', '/api/products', { name: 'Korrigiert', unit: 'kg' }, withKey(k));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('idempotent-replay'), null);
});

test('Ohne Vorgangs-ID verhält sich alles wie bisher; ungültige Schlüssel werden abgelehnt', async () => {
  const { body: p } = await srv.api('POST', '/api/products', { name: 'Lauch', unit: 'kg' });
  await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 1 });
  await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 1 });
  assert.equal((await srv.api('GET', `/api/products/${p.id}`)).body.total, 2);
  assert.equal((await srv.api('POST', '/api/products', { name: 'X' }, withKey('zu kurz!'))).status, 400);
});

test('Artikelnamen sind eindeutig – unabhängig von Groß-/Kleinschreibung und Leerzeichen', async () => {
  const { body: first } = await srv.api('POST', '/api/products', { name: 'Rinderhack', unit: 'kg' });
  for (const name of ['rinderhack', '  RINDERHACK ', 'Rinderhack']) {
    const r = await srv.api('POST', '/api/products', { name, unit: 'kg' }, withKey(key()));
    assert.equal(r.status, 409, name);
    assert.equal(r.body.existing_product_id, first.id);
    assert.match(r.body.error, /Rinderhack/);
  }
  assert.equal((await products()).filter(p => p.name.toLowerCase() === 'rinderhack').length, 1);
  assert.equal((await srv.api('POST', '/api/products', { name: 'Rinderhack Bio', unit: 'kg' })).status, 200);
  // Innere Leerräume werden zusammengefasst
  const { body: spaced } = await srv.api('POST', '/api/products', { name: 'Grüne   Bohnen', unit: 'kg' });
  assert.equal(spaced.name, 'Grüne Bohnen');
  assert.equal((await srv.api('POST', '/api/products', { name: 'grüne bohnen' })).status, 409);
});

test('Ungültiges JSON wird als 400 gemeldet', async () => {
  const res = await fetch(`${srv.base}/api/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{kaputt' });
  assert.equal(res.status, 400);
});

test('Alte Vorgangs-IDs werden aufgeräumt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuehltruhen-idem-'));
  try {
    const db = new Database(path.join(dir, 'x.db'));
    db.exec('CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, method TEXT, path TEXT, status INTEGER, response TEXT, created_at TEXT, body_hash TEXT)');
    const add = db.prepare("INSERT INTO idempotency_keys (key, method, path, status, response, created_at) VALUES (?, 'POST', '/x', 200, '{}', datetime('now', ?))");
    add.run('frisch', '-1 hours'); add.run('sechs-tage', '-6 days'); add.run('acht-tage', '-8 days'); add.run('alt', '-40 days');
    assert.equal(purgeOld(db), 2);
    assert.deepEqual(db.prepare('SELECT key FROM idempotency_keys ORDER BY key').all().map(r => r.key), ['frisch', 'sechs-tage']);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
