const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(() => srv.stop());

test('Mindestbestand wird beim Anlegen gespeichert und in der Liste geliefert', async () => {
  const { body: p } = await srv.api('POST', '/api/products', { name: 'Hack', unit: 'kg', min_stock: 5 });
  assert.equal(p.min_stock, 5);
  const { body: list } = await srv.api('GET', '/api/products');
  assert.equal(list.find(x => x.id === p.id).min_stock, 5);
  const { body: noMin } = await srv.api('POST', '/api/products', { name: 'Ohne', unit: 'kg' });
  assert.equal(noMin.min_stock, null);
});

test('Mindestbestand ändern, leeren und 0 als „keine Warnung“', async () => {
  const { body: p } = await srv.api('POST', '/api/products', { name: 'Fisch', unit: 'kg' });
  const set = await srv.api('PUT', `/api/products/${p.id}`, { min_stock: 2.5 });
  assert.equal(set.status, 200);
  assert.equal(set.body.min_stock, 2.5);
  assert.equal((await srv.api('PUT', `/api/products/${p.id}`, { min_stock: '3' })).body.min_stock, 3); // Zahl als Text
  assert.equal((await srv.api('PUT', `/api/products/${p.id}`, { min_stock: 0 })).body.min_stock, null);
  await srv.api('PUT', `/api/products/${p.id}`, { min_stock: 4 });
  assert.equal((await srv.api('PUT', `/api/products/${p.id}`, { min_stock: null })).body.min_stock, null);
});

test('Ungültige Werte und unbekannte Produkte', async () => {
  const { body: p } = await srv.api('POST', '/api/products', { name: 'Erbsen', unit: 'kg', min_stock: 1 });
  for (const bad of [-1, 'abc', '1e999x']) {
    const r = await srv.api('PUT', `/api/products/${p.id}`, { min_stock: bad });
    assert.equal(r.status, 400, String(bad));
  }
  assert.equal((await srv.api('PUT', `/api/products/${p.id}`, {})).status, 400);
  assert.equal((await srv.api('POST', '/api/products', { name: 'X', min_stock: -3 })).status, 400);
  assert.equal((await srv.api('PUT', '/api/products/99999', { min_stock: 1 })).status, 404);
  const { body: after } = await srv.api('GET', `/api/products/${p.id}`);
  assert.equal(after.min_stock, 1); // ungültige Änderungen haben nichts verändert
});

test('Migration: Datenbank ohne Spalte min_stock wird beim Start ergänzt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuehltruhen-migration-'));
  try {
    // Alte Datenbank im Schema von Version 0.1.0 anlegen
    const Database = require('better-sqlite3');
    const old = new Database(path.join(dir, 'kuehltruhen.db'));
    old.exec(`
      CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE locations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'Stk',
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE stock_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE, quantity REAL NOT NULL DEFAULT 0, best_before TEXT, note TEXT,
        stored_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE movements (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, location_id INTEGER NOT NULL,
        delta REAL NOT NULL, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO products (name, unit) VALUES ('Altprodukt', 'kg');
    `);
    old.close();

    const migrated = await startServer({ DATA_DIR: dir });
    try {
      const { body: list } = await migrated.api('GET', '/api/products');
      assert.equal(list[0].name, 'Altprodukt');
      assert.equal(list[0].min_stock, null);
      const put = await migrated.api('PUT', `/api/products/${list[0].id}`, { min_stock: 2 });
      assert.equal(put.body.min_stock, 2);
      assert.equal((await migrated.api('GET', '/api/movements')).status, 200); // Protokoll mit neuen Spalten (undone_at, transfer_id)
    } finally {
      migrated.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
