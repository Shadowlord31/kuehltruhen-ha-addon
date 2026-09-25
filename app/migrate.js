const { nameKey } = require('./names');

// Versionierte, ausschließlich ADDITIVE Migrationen (neue Spalten/Tabellen/Indizes/Trigger – nie DROP, nie Tabellen umbauen).
// Die Version steht in PRAGMA user_version. Jede Migration ist idempotent, damit sie auch auf Datenbanken
// aus früheren Add-on-Versionen (die noch keine Versionsnummer hatten, also 0) gefahrlos läuft.

// UUID v4 als reiner SQL-Ausdruck – wird pro Zeile neu ausgewertet
const UUID_SQL = `(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))`;

function addColumnIfMissing(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const UUID_TABLES = ['categories', 'locations', 'products', 'stock_entries', 'movements'];

const MIGRATIONS = [
  { version: 1, name: 'movements.undone_at', up: db => addColumnIfMissing(db, 'movements', 'undone_at', 'TEXT') },
  { version: 2, name: 'products.min_stock', up: db => addColumnIfMissing(db, 'products', 'min_stock', 'REAL') },
  { version: 3, name: 'movements.transfer_id', up: db => addColumnIfMissing(db, 'movements', 'transfer_id', 'INTEGER') },
  {
    // Jede Zeile bekommt eine stabile, weltweit eindeutige ID. Die Ganzzahl-IDs bleiben unverändert (API, Fremdschlüssel).
    // Neue Zeilen erhalten ihre UUID per Trigger, egal welcher Code sie einfügt.
    version: 4,
    name: 'uuid je Datensatz',
    up: db => {
      for (const t of UUID_TABLES) {
        addColumnIfMissing(db, t, 'uuid', 'TEXT');
        db.exec(`UPDATE ${t} SET uuid = ${UUID_SQL} WHERE uuid IS NULL`);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${t}_uuid ON ${t}(uuid)`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS trg_${t}_uuid AFTER INSERT ON ${t} WHEN NEW.uuid IS NULL
                 BEGIN UPDATE ${t} SET uuid = ${UUID_SQL} WHERE id = NEW.id; END`);
      }
    }
  },
  {
    // Namensschlüssel für die Eindeutigkeit von Artikelnamen. Der Unique-Index folgt in ensureNameIndex(),
    // weil bereits vorhandene Doppelte die Migration sonst scheitern lassen würden.
    version: 5,
    name: 'products.name_key',
    up: db => {
      addColumnIfMissing(db, 'products', 'name_key', 'TEXT');
      const update = db.prepare('UPDATE products SET name_key = ? WHERE id = ?');
      db.prepare('SELECT id, name FROM products').all().forEach(p => update.run(nameKey(p.name), p.id));
    }
  },
  {
    // Bereits ausgeführte Aktionen (Idempotenz): wiederholte Anfragen mit gleichem Schlüssel führen nichts erneut aus
    version: 6,
    name: 'idempotency_keys',
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status INTEGER NOT NULL,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`)
  },
  {
    // Prüfsumme des Bodys: gleiche Vorgangs-ID mit anderem Inhalt wird abgelehnt statt still die alte Antwort zu liefern
    version: 7,
    name: 'idempotency_keys.body_hash',
    up: db => addColumnIfMissing(db, 'idempotency_keys', 'body_hash', 'TEXT')
  }
];

// Wendet alle ausstehenden Migrationen in EINER Transaktion an (alles oder nichts).
// beforeApply({ from, to }) läuft vorher und außerhalb der Transaktion – dort entsteht die Sicherung.
function runMigrations(db, { migrations = MIGRATIONS, beforeApply } = {}) {
  const from = db.pragma('user_version', { simple: true });
  const pending = migrations.filter(m => m.version > from).sort((a, b) => a.version - b.version);
  if (!pending.length) return { from, to: from, applied: [] };

  const to = pending[pending.length - 1].version;
  if (beforeApply) beforeApply({ from, to });

  db.transaction(() => {
    for (const m of pending) m.up(db);
    db.pragma(`user_version = ${to}`);
  })();

  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`Datenbankprüfung nach der Migration fehlgeschlagen: ${integrity}`);
  return { from, to, applied: pending.map(m => m.version) };
}

// Eindeutiger Index auf dem Namensschlüssel – nur möglich, solange keine Doppelten existieren.
// Wird bei jedem Start und nach Löschen/Zusammenführen erneut versucht.
function ensureNameIndex(db) {
  const duplicates = db.prepare('SELECT name_key, COUNT(*) AS count FROM products GROUP BY name_key HAVING count > 1').all();
  if (duplicates.length) return { created: false, duplicates };
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_products_name_key ON products(name_key)');
  return { created: true, duplicates: [] };
}

module.exports = { MIGRATIONS, LATEST: MIGRATIONS[MIGRATIONS.length - 1].version, UUID_SQL, addColumnIfMissing, runMigrations, ensureNameIndex };
