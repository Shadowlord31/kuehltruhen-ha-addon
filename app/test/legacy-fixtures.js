// Erzeugt Datenbanken im Schema früherer Add-on-Versionen – mit Daten, wie sie im Betrieb entstehen würden,
// inkl. absichtlich mehrfach vorhandener Artikelnamen (der Hänger von Home Assistant).
const Database = require('better-sqlite3');

const BASE = `
  CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE locations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE stock_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    quantity REAL NOT NULL DEFAULT 0, best_before TEXT, note TEXT,
    stored_at TEXT NOT NULL DEFAULT (datetime('now')));
`;

// version: '0.1.0' | '0.4.0' | '0.7.0' – so sah das Schema in diesen Add-on-Versionen aus.
// Alle Datenbanken aus dieser Zeit haben PRAGMA user_version = 0.
function buildLegacyDb(file, version) {
  const has = { protokollLinks: version !== '0.1.0', minStock: version === '0.7.0', transfer: version === '0.7.0' };
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(BASE);
  db.exec(`CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'Stk',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    ${has.minStock ? ', min_stock REAL' : ''})`);
  db.exec(`CREATE TABLE movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, location_id INTEGER NOT NULL,
    delta REAL NOT NULL, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    ${has.protokollLinks ? ', undone_at TEXT' : ''}${has.transfer ? ', transfer_id INTEGER' : ''})`);
  if (has.protokollLinks) {
    db.exec(`CREATE TABLE movement_entries (
      movement_id INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
      entry_id INTEGER NOT NULL REFERENCES stock_entries(id) ON DELETE CASCADE, quantity REAL NOT NULL)`);
  }

  ['Fleisch', 'Gemüse'].forEach((n, i) => db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)').run(n, i));
  ['Truhe 1', 'Truhe 2', 'Truhe 3'].forEach((n, i) => db.prepare('INSERT INTO locations (name, sort_order) VALUES (?, ?)').run(n, i));

  // Drei identische „Hack“ (Hänger), dazu Schreibvarianten desselben Namens
  const products = [
    ['Hack', 'kg', 1], ['Hack', 'kg', 1], ['Hack', 'kg', 1], ['hack ', 'kg', 1],
    ['Pommes', 'kg', 2], ['Äpfel', 'kg', 2], ['äpfel', 'kg', 2], ['Suppe', 'Portion', null]
  ];
  const addProduct = db.prepare(`INSERT INTO products (name, unit, category_id${has.minStock ? ', min_stock' : ''}) VALUES (?, ?, ?${has.minStock ? ', ?' : ''})`);
  products.forEach((p, i) => addProduct.run(...p, ...(has.minStock ? [i === 4 ? 5 : null] : [])));

  const addEntry = db.prepare('INSERT INTO stock_entries (product_id, location_id, quantity, best_before, note) VALUES (?, ?, ?, ?, ?)');
  const addMove = db.prepare(`INSERT INTO movements (product_id, location_id, delta, reason${has.transfer ? ', transfer_id' : ''}) VALUES (?, ?, ?, ?${has.transfer ? ', ?' : ''})`);
  const link = has.protokollLinks ? db.prepare('INSERT INTO movement_entries (movement_id, entry_id, quantity) VALUES (?, ?, ?)') : null;
  const stockIn = (product, loc, qty, mhd, note) => {
    const entry = addEntry.run(product, loc, qty, mhd, note).lastInsertRowid;
    const move = addMove.run(product, loc, qty, 'Einlagerung', ...(has.transfer ? [null] : [])).lastInsertRowid;
    if (link) link.run(move, entry, qty);
    return entry;
  };
  stockIn(1, 1, 3, '2027-01-01', 'Kiste 7');
  stockIn(1, 1, 2, '2027-06-01', null);
  stockIn(2, 2, 4, null, null);
  stockIn(5, 1, 10, '2026-12-24', null);
  stockIn(5, 3, 2.5, null, 'Reste');
  stockIn(6, 2, 6, null, null);
  stockIn(8, 3, 12, null, null);
  // Eine Entnahme (Bewegung ohne Verknüpfung, wie in Version 0.1.0)
  db.prepare('UPDATE stock_entries SET quantity = 8 WHERE id = 4').run();
  addMove.run(5, 1, -2, 'Entnahme', ...(has.transfer ? [null] : []));

  if (has.transfer) {
    // Umlagerung: 1 kg Hack aus Truhe 1 nach Truhe 3 (zwei Bewegungen mit gleicher transfer_id)
    db.prepare('UPDATE stock_entries SET quantity = 2 WHERE id = 1').run();
    const moved = addEntry.run(1, 3, 1, '2027-01-01', 'Kiste 7').lastInsertRowid;
    const out = addMove.run(1, 1, -1, 'Umlagerung', null).lastInsertRowid;
    const inn = addMove.run(1, 3, 1, 'Umlagerung', null).lastInsertRowid;
    db.prepare('UPDATE movements SET transfer_id = ? WHERE id IN (?, ?)').run(out, out, inn);
    link.run(out, 1, 1);
    link.run(inn, moved, 1);
  }
  db.close();
}

const TABLES = ['categories', 'locations', 'products', 'stock_entries', 'movements', 'movement_entries'];

// Zeilenzahlen und Bestandssummen je Artikel – der „Fingerabdruck“ der Nutzdaten
function fingerprint(file) {
  const db = new Database(file, { readonly: true });
  try {
    const counts = {};
    for (const t of TABLES) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      counts[t] = exists ? db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c : 0;
    }
    const stock = db.prepare('SELECT product_id, ROUND(SUM(quantity), 6) AS q FROM stock_entries GROUP BY product_id ORDER BY product_id').all();
    const names = db.prepare('SELECT id, name FROM products ORDER BY id').all();
    return { counts, stock, names, userVersion: db.pragma('user_version', { simple: true }) };
  } finally {
    db.close();
  }
}

module.exports = { buildLegacyDb, fingerprint, TABLES };
