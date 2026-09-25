const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'kuehltruhen.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

// Migrationen für bestehende Datenbanken: fehlende Spalten nachrüsten
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumnIfMissing('movements', 'undone_at', 'TEXT');   // rückgängig gemachte Bewegungen
addColumnIfMissing('products', 'min_stock', 'REAL');    // Mindestbestand (NULL = keine Warnung)

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

module.exports = db;
