const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { createBackup } = require('./backup');
const { runMigrations, ensureNameIndex } = require('./migrate');

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'kuehltruhen.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
// Gab es die Datenbank schon (mit Daten aus einer früheren Version)? Dann wird vor Migrationen gesichert.
const existed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'products'").get();

// Grundschema (nur für frische Datenbanken relevant; spätere Ergänzungen kommen über die Migrationen)
db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'Stk',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stock_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    quantity REAL NOT NULL DEFAULT 0,
    best_before TEXT,
    note TEXT,
    stored_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    location_id INTEGER NOT NULL,
    delta REAL NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Welche Bestandseinträge eine Bewegung betroffen hat (Grundlage für Undo)
  CREATE TABLE IF NOT EXISTS movement_entries (
    movement_id INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
    entry_id INTEGER NOT NULL REFERENCES stock_entries(id) ON DELETE CASCADE,
    quantity REAL NOT NULL
  );
`);

// Migrationen: alles oder nichts. Bei einer bestehenden Datenbank entsteht vorher automatisch eine Sicherung.
// Schlägt etwas fehl, wird zurückgerollt und der Start bricht ab – die Daten bleiben unangetastet.
try {
  const result = runMigrations(db, {
    beforeApply: ({ from, to }) => {
      if (!existed) return;
      const file = createBackup(db, BACKUP_DIR, 'migration', `v${from}-to-v${to}`);
      console.log(`[db] Sicherung vor Migration v${from} -> v${to}: ${file}`);
    }
  });
  if (result.applied.length) console.log(`[db] Migration v${result.from} -> v${result.to} abgeschlossen`);
} catch (err) {
  console.error('[db] MIGRATION FEHLGESCHLAGEN – es wurde nichts verändert. Ursache:', err.message);
  throw err;
}

// Eindeutige Artikelnamen: der Index entsteht erst, wenn keine Doppelten (mehr) vorhanden sind
const nameIndex = ensureNameIndex(db);
if (!nameIndex.created) {
  const names = nameIndex.duplicates.map(d => `"${d.name_key}" (${d.count}x)`).join(', ');
  console.warn(`[db] Doppelte Artikelnamen vorhanden, bitte zusammenführen: ${names}`);
}

// Startdaten, falls leer
const catCount = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
if (catCount === 0) {
  const insertCat = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
  ['Fleisch', 'Beilagen', 'Gemüse', 'Sonstiges'].forEach((name, i) => insertCat.run(name, i));
}

const locCount = db.prepare('SELECT COUNT(*) AS c FROM locations').get().c;
if (locCount === 0) {
  const insertLoc = db.prepare('INSERT INTO locations (name, sort_order) VALUES (?, ?)');
  ['Truhe 1', 'Truhe 2', 'Truhe 3'].forEach((name, i) => insertLoc.run(name, i));
}

db.backupDir = BACKUP_DIR;
module.exports = db;
