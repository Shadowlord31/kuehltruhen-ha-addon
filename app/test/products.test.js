const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');
const { buildLegacyDb, fingerprint } = require('./legacy-fixtures');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(() => srv.stop());

const create = async (name, extra = {}) => (await srv.api('POST', '/api/products', { name, unit: 'kg', ...extra })).body;
const get = id => srv.api('GET', `/api/products/${id}`);
const stockIn = (id, loc, quantity, extra = {}) => srv.api('POST', `/api/products/${id}/stock-in`, { location_id: loc, quantity, ...extra });
const backupsIn = (dir, prefix) => {
  const d = path.join(dir, 'backups');
  return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.startsWith(prefix)) : [];
};

/* ---------- Bearbeiten ---------- */

test('Bearbeiten: beliebige Teilmengen, Mengen bleiben bei Einheitenwechsel unverändert', async () => {
  const p = await create('Bearbeitbar', { category_id: 1, min_stock: 4 });
  await stockIn(p.id, 1, 3, { best_before: '2027-01-01', note: 'Kiste' });

  const r1 = await srv.api('PUT', `/api/products/${p.id}`, { name: '  Bearbeitet   Neu ' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.name, 'Bearbeitet Neu');
  assert.equal(r1.body.unit, 'kg');
  assert.equal(r1.body.category_id, 1);
  assert.equal(r1.body.min_stock, 4); // nicht angefasst

  const r2 = await srv.api('PUT', `/api/products/${p.id}`, { unit: 'Beutel', category_id: 2 });
  assert.equal(r2.body.unit, 'Beutel');
  assert.equal(r2.body.category_name, 'Beilagen');
  assert.equal(r2.body.total, 3);                      // Menge unverändert, nur die Beschriftung
  assert.equal(r2.body.stock[0].best_before, '2027-01-01');
  assert.equal(r2.body.stock[0].note, 'Kiste');

  const r3 = await srv.api('PUT', `/api/products/${p.id}`, { category_id: null, min_stock: 0 });
  assert.equal(r3.body.category_id, null);
  assert.equal(r3.body.min_stock, null);
});

test('Bearbeiten: Validierung, Namenskollision, unbekannter Artikel', async () => {
  const a = await create('Kollision A');
  const b = await create('Kollision B');
  const put = (id, body) => srv.api('PUT', `/api/products/${id}`, body);

  const clash = await put(b.id, { name: 'kollision a' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.existing_product_id, a.id);
  assert.equal((await get(b.id)).body.name, 'Kollision B'); // unverändert

  assert.equal((await put(a.id, { name: 'KOLLISION A' })).status, 200); // nur andere Schreibweise des eigenen Namens: erlaubt
  assert.equal((await get(a.id)).body.name, 'KOLLISION A');

  assert.equal((await put(a.id, {})).status, 400);
  assert.equal((await put(a.id, { name: '   ' })).status, 400);
  assert.equal((await put(a.id, { unit: ' ' })).status, 400);
  assert.equal((await put(a.id, { category_id: 9999 })).status, 400);
  assert.equal((await put(a.id, { category_id: 'abc' })).status, 400);
  assert.equal((await put(a.id, { min_stock: -1 })).status, 400);
  assert.equal((await put(99999, { name: 'X' })).status, 404);
  // Ein fehlerhaftes Feld verhindert die ganze Änderung
  assert.equal((await put(a.id, { name: 'Neuer Name', category_id: 9999 })).status, 400);
  assert.equal((await get(a.id)).body.name, 'KOLLISION A');
});

/* ---------- Löschen ---------- */

test('Löschen: entfernt Artikel, Bestand und Protokoll – nur mit force bei Restbestand – und sichert vorher', async () => {
  const p = await create('Löschbar');
  const keep = await create('Bleibt');
  await stockIn(keep.id, 1, 7);
  await stockIn(p.id, 1, 3, { best_before: '2027-01-01' });
  await stockIn(p.id, 2, 2);
  await srv.api('POST', `/api/products/${p.id}/transfer`, { from_location_id: 1, to_location_id: 3, quantity: 1 });
  await srv.api('POST', `/api/products/${p.id}/stock-out`, { location_id: 2, quantity: 1 });
  const keepLogBefore = (await srv.api('GET', `/api/movements?product_id=${keep.id}`)).body;

  // Ohne force abgelehnt, nichts passiert
  const refused = await srv.api('DELETE', `/api/products/${p.id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.needs_force, true);
  assert.equal(refused.body.stock, 4);
  assert.equal((await get(p.id)).status, 200);
  assert.equal(backupsIn(srv.dir, 'pre-delete-').length, 0);

  const done = await srv.api('DELETE', `/api/products/${p.id}?force=1`);
  assert.equal(done.status, 200);
  assert.equal(done.body.deleted.stock_entries, 3);   // 2 Einlagerungen + 1 durch die Umlagerung
  assert.equal(done.body.deleted.movements, 5);        // 2 Einlagerungen, Umlagerung (2 Zeilen), Entnahme
  assert.equal((await get(p.id)).status, 404);
  assert.ok(!(await srv.api('GET', '/api/products')).body.some(x => x.id === p.id));
  assert.deepEqual((await srv.api('GET', `/api/movements?product_id=${p.id}`)).body, []);
  assert.ok(!(await srv.api('GET', '/api/movements?limit=500')).body.some(m => m.product_id === p.id));

  // Anderer Artikel unberührt
  assert.equal((await get(keep.id)).body.total, 7);
  assert.deepEqual((await srv.api('GET', `/api/movements?product_id=${keep.id}`)).body, keepLogBefore);

  // Sicherung liegt vor und enthält den gelöschten Artikel noch vollständig
  const files = backupsIn(srv.dir, 'pre-delete-');
  assert.equal(files.length, 1);
  assert.equal(files[0], done.body.backup);
  const snap = new Database(path.join(srv.dir, 'backups', files[0]), { readonly: true });
  assert.equal(snap.prepare('SELECT name FROM products WHERE id = ?').get(p.id).name, 'Löschbar');
  assert.equal(snap.prepare('SELECT COUNT(*) AS c FROM stock_entries WHERE product_id = ?').get(p.id).c, 3);
  assert.equal(snap.prepare('SELECT COUNT(*) AS c FROM movements WHERE product_id = ?').get(p.id).c, 5);
  snap.close();

  // Der Name ist danach wieder frei
  assert.equal((await srv.api('POST', '/api/products', { name: 'löschbar', unit: 'kg' })).status, 200);
});

test('Löschen: Artikel ohne Bestand geht ohne force; unbekannter Artikel 404', async () => {
  const leer = await create('Leer');
  assert.equal((await srv.api('DELETE', `/api/products/${leer.id}`)).status, 200);
  assert.equal((await get(leer.id)).status, 404);
  assert.equal((await srv.api('DELETE', '/api/products/99999')).status, 404);

  // Aufgebrauchter Artikel (Bestand 0, aber Protokoll vorhanden) ebenfalls
  const used = await create('Aufgebraucht');
  await stockIn(used.id, 1, 2);
  await srv.api('POST', `/api/products/${used.id}/stock-out`, { location_id: 1, quantity: 2 });
  assert.equal((await srv.api('DELETE', `/api/products/${used.id}`)).status, 200);
});

/* ---------- Zusammenführen ---------- */

test('Zusammenführen: Kategorie und Mindestbestand des Ziels werden bei Bedarf ergänzt', async () => {
  const target = await create('Ziel ohne Angaben');
  const source = await create('Quelle mit Angaben', { category_id: 2, min_stock: 3 });
  await stockIn(source.id, 1, 2, { best_before: '2027-05-05', note: 'von Quelle' });
  const r = await srv.api('POST', `/api/products/${source.id}/merge`, { into_product_id: target.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.product.id, target.id);
  assert.equal(r.body.product.category_id, 2);
  assert.equal(r.body.product.min_stock, 3);
  assert.equal(r.body.product.stock[0].note, 'von Quelle');
  assert.equal((await get(source.id)).status, 404);
});

test('Zusammenführen: Ablehnungen (Selbst-Merge, unbekannt, andere Einheit) ändern nichts', async () => {
  const a = await create('Merge A');
  const b = await create('Merge B', { unit: 'Stk' });
  await stockIn(a.id, 1, 1);
  const merge = (id, into) => srv.api('POST', `/api/products/${id}/merge`, { into_product_id: into });
  assert.equal((await merge(a.id, a.id)).status, 400);
  assert.equal((await merge(a.id, 99999)).status, 404);
  assert.equal((await merge(99999, a.id)).status, 404);
  assert.equal((await srv.api('POST', `/api/products/${a.id}/merge`, {})).status, 400);
  const unit = await merge(a.id, b.id);
  assert.equal(unit.status, 409);
  assert.match(unit.body.error, /Einheiten unterscheiden sich/);
  assert.equal((await get(a.id)).body.total, 1);
  assert.equal((await get(b.id)).status, 200);
});

test('Zusammenführen der 3 doppelten Artikel aus der Alt-Datenbank: nichts geht verloren, danach entsteht der Unique-Index', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuehltruhen-merge-'));
  try {
    const file = path.join(dir, 'kuehltruhen.db');
    buildLegacyDb(file, '0.7.0'); // Hack ×3 + „hack “ (ids 1–4), Äpfel/äpfel (6, 7), Pommes (5), Suppe in Portion (8)
    const before = fingerprint(file);
    const sumStock = f => f.stock.reduce((s, x) => s + x.q, 0);

    const s = await startServer({ DATA_DIR: dir });
    const merge = (id, into) => s.api('POST', `/api/products/${id}/merge`, { into_product_id: into });

    const first = await merge(2, 1); // Hack (Truhe 2, 4 kg) → Hack
    assert.equal(first.status, 200);
    assert.equal(first.body.product.total, 9);           // 5 + 4
    assert.equal(first.body.product.stock.length, 4);
    assert.match(first.body.backup, /^pre-merge-/);
    assert.equal((await s.api('GET', '/api/products/2')).status, 404);

    // Protokoll der Quelle gehört jetzt zum Ziel, und Undo alter Bewegungen klappt weiter
    const { body: log } = await s.api('GET', '/api/movements?product_id=1');
    const oldIn = log.find(m => m.reason === 'Einlagerung' && m.location_name === 'Truhe 2' && m.delta === 4);
    assert.ok(oldIn, 'Einlagerung des zusammengeführten Artikels im Protokoll');
    assert.equal(oldIn.undoable, true);
    assert.equal((await s.api('POST', `/api/movements/${oldIn.id}/undo`)).status, 200);
    assert.equal((await s.api('GET', '/api/products/1')).body.total, 5);

    // Rest zusammenführen (der Undo oben nahm 4 kg bewusst wieder heraus, das wird unten eingerechnet)
    assert.equal((await merge(3, 1)).status, 200);
    assert.equal((await merge(4, 1)).status, 200);      // „hack “
    assert.equal((await merge(1, 8)).status, 409);      // Portion ≠ kg

    assert.equal((await merge(7, 6)).status, 200);      // äpfel → Äpfel
    await s.stop();

    // Nutzdaten erhalten: gleiche Bewegungen/Bestandseinträge, gleiche Gesamtmenge abzüglich des einen Undo (4 kg)
    const after = fingerprint(file);
    assert.equal(after.counts.movements, before.counts.movements);
    assert.equal(after.counts.stock_entries, before.counts.stock_entries);
    assert.equal(after.counts.products, before.counts.products - 4);   // 2, 3, 4, 7 sind weg
    assert.ok(Math.abs(sumStock(after) - (sumStock(before) - 4)) < 1e-9);

    const db = new Database(file, { readonly: true });
    // Keine Doppelten mehr → Unique-Index ist entstanden und schützt ab jetzt auch auf DB-Ebene
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ux_products_name_key'").get());
    assert.equal(db.pragma('foreign_key_check').length, 0);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.close();
    assert.equal(backupsIn(dir, 'pre-merge-').length, 4); // eine Sicherung je Zusammenführung (außer der abgelehnten)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
