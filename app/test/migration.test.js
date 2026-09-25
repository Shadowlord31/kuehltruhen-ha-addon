const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');
const { buildLegacyDb, fingerprint, TABLES } = require('./legacy-fixtures');
const { MIGRATIONS, LATEST, runMigrations, ensureNameIndex } = require('../migrate');
const { createBackup } = require('../backup');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kuehltruhen-migration-'));
const backupsIn = dir => {
  const d = path.join(dir, 'backups');
  return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.startsWith('pre-migration-')).sort() : [];
};

for (const version of ['0.1.0', '0.4.0', '0.7.0']) {
  test(`Alt-Datenbank aus Version ${version}: alle Daten bleiben erhalten, vorher entsteht eine Sicherung`, async () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'kuehltruhen.db');
      buildLegacyDb(file, version);
      const before = fingerprint(file);
      assert.equal(before.userVersion, 0);
      assert.equal(before.names.filter(p => p.name.trim().toLowerCase() === 'hack').length, 4); // Doppelte sind wirklich drin

      const srv = await startServer({ DATA_DIR: dir });
      const { body: products } = await srv.api('GET', '/api/products');
      assert.equal(products.length, before.names.length);
      assert.equal((await srv.api('GET', '/api/movements')).status, 200);
      const { body: created } = await srv.api('POST', '/api/products', { name: 'Neu nach Migration', unit: 'kg' });
      assert.match(created.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      await srv.stop();

      // Nutzdaten unverändert (neuer Artikel zählt extra)
      const after = fingerprint(file);
      assert.equal(after.userVersion, LATEST);
      for (const t of TABLES) {
        const expected = before.counts[t] + (t === 'products' ? 1 : 0);
        // In Version 0.1.0 gab es movement_entries noch nicht – die Tabelle wird leer angelegt
        assert.equal(after.counts[t], expected, `Tabelle ${t}`);
      }
      assert.deepEqual(after.stock, before.stock);
      assert.deepEqual(after.names.slice(0, before.names.length), before.names);

      // Jede Zeile hat eine eindeutige UUID
      const db = new Database(file, { readonly: true });
      for (const t of ['categories', 'locations', 'products', 'stock_entries', 'movements']) {
        const r = db.prepare(`SELECT COUNT(*) AS n, COUNT(uuid) AS with_uuid, COUNT(DISTINCT uuid) AS uniq FROM ${t}`).get();
        assert.equal(r.with_uuid, r.n, `${t}: UUID fehlt`);
        assert.equal(r.uniq, r.n, `${t}: UUID doppelt`);
      }
      // Vorhandene Doppelte -> Unique-Index kann (noch) nicht existieren, die Migration darf daran nicht scheitern
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ux_products_name_key'").get(), undefined);
      // name_key ist überall befüllt und normalisiert
      const keys = db.prepare('SELECT name_key FROM products ORDER BY id').all().map(r => r.name_key);
      assert.deepEqual(keys.slice(0, 8), ['hack', 'hack', 'hack', 'hack', 'pommes', 'äpfel', 'äpfel', 'suppe']);
      db.close();

      // Genau eine Sicherung, mit dem Stand VOR der Migration
      const backups = backupsIn(dir);
      assert.equal(backups.length, 1);
      assert.match(backups[0], /v0-to-v6/);
      const snap = fingerprint(path.join(dir, 'backups', backups[0]));
      assert.equal(snap.userVersion, 0);
      assert.deepEqual(snap.counts.products, before.counts.products);
      assert.deepEqual(snap.stock, before.stock);
      const snapDb = new Database(path.join(dir, 'backups', backups[0]), { readonly: true });
      assert.equal(snapDb.pragma('integrity_check', { simple: true }), 'ok');
      snapDb.close();

      // Zweiter Start: nichts mehr zu migrieren, keine weitere Sicherung, Daten weiter identisch
      const again = await startServer({ DATA_DIR: dir });
      assert.equal((await again.api('GET', '/api/products')).body.length, before.names.length + 1);
      await again.stop();
      assert.equal(backupsIn(dir).length, 1);
      assert.deepEqual(fingerprint(file).stock, before.stock);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('Frische Datenbank: keine Sicherung nötig, Unique-Index und UUIDs sind da', async () => {
  const dir = tmp();
  try {
    const srv = await startServer({ DATA_DIR: dir });
    const { body: a } = await srv.api('POST', '/api/products', { name: 'Hack', unit: 'kg' });
    assert.ok(a.uuid);
    // Sicherheitsnetz: gleicher Namensschlüssel wird vom Index abgelehnt (Server antwortet 409)
    assert.equal((await srv.api('POST', '/api/products', { name: ' HACK ', unit: 'kg' })).status, 409);
    await srv.stop();

    const db = new Database(path.join(dir, 'kuehltruhen.db'), { readonly: true });
    assert.equal(db.pragma('user_version', { simple: true }), LATEST);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ux_products_name_key'").get());
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM products').get().c, 1);
    db.close();
    assert.equal(backupsIn(dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Fehlgeschlagene Migration rollt vollständig zurück und lässt die Daten unberührt', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'kuehltruhen.db');
    buildLegacyDb(file, '0.7.0');
    const before = fingerprint(file);

    const db = new Database(file);
    db.pragma('foreign_keys = ON');
    const failing = [...MIGRATIONS, { version: LATEST + 1, name: 'kaputt', up: () => { throw new Error('boom'); } }];
    assert.throws(() => runMigrations(db, { migrations: failing }), /boom/);

    // Weder Versionsnummer noch Spalten der Migrationen 4–6 sind übrig geblieben
    assert.equal(db.pragma('user_version', { simple: true }), 0);
    const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    assert.ok(!cols('products').includes('uuid'));
    assert.ok(!cols('products').includes('name_key'));
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idempotency_keys'").get(), undefined);
    db.close();
    assert.deepEqual(fingerprint(file), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Unique-Index entsteht, sobald die Doppelten weg sind', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'kuehltruhen.db');
    buildLegacyDb(file, '0.7.0');
    const db = new Database(file);
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const first = ensureNameIndex(db);
    assert.equal(first.created, false);
    assert.deepEqual(first.duplicates.map(d => [d.name_key, d.count]).sort(), [['hack', 4], ['äpfel', 2]]);

    db.prepare("DELETE FROM products WHERE id IN (2, 3, 4, 7)").run(); // Doppelte entfernen
    assert.equal(ensureNameIndex(db).created, true);
    assert.throws(() => db.prepare("INSERT INTO products (name, unit, name_key) VALUES ('Hack', 'kg', 'hack')").run(), /UNIQUE/);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Sicherungen: Aufbewahrung je Art begrenzt, Dateien sind vollständige Datenbanken', () => {
  const dir = tmp();
  try {
    const db = new Database(path.join(dir, 'kuehltruhen.db'));
    db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('a')");
    const bdir = path.join(dir, 'backups');
    for (let i = 0; i < 8; i++) createBackup(db, bdir, 'migration', `v${i}`);
    for (let i = 0; i < 7; i++) createBackup(db, bdir, 'delete', `Artikel ${i}`);
    for (let i = 0; i < 7; i++) createBackup(db, bdir, 'merge', `Artikel ${i}`);
    const files = fs.readdirSync(bdir);
    assert.equal(files.filter(f => f.startsWith('pre-migration-')).length, 5);
    assert.equal(files.filter(f => /^pre-(delete|merge)-/.test(f)).length, 10);
    // die neuesten bleiben erhalten
    assert.ok(files.some(f => f.includes('__v7')));
    assert.ok(!files.some(f => f.includes('__v0')));
    const copy = new Database(path.join(bdir, files[0]), { readonly: true });
    assert.equal(copy.prepare('SELECT x FROM t').get().x, 'a');
    copy.close();
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
