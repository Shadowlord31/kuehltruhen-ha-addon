const fs = require('fs');
const path = require('path');

// Sicherungen der Datenbank per VACUUM INTO: synchron, konsistent (auch im WAL-Modus) und ohne Lock-Probleme.
// Sie liegen in /data/backups und sind damit Teil der normalen Home-Assistant-Backups des Add-ons.
//
// Aufbewahrung getrennt nach Art, damit häufige Aktionen die Migrations-Sicherungen nicht verdrängen:
//   migration        -> letzte 5
//   delete / merge   -> letzte 10 (gemeinsam)
const POOLS = {
  migration: { prefixes: ['pre-migration-'], keep: 5 },
  delete: { prefixes: ['pre-delete-', 'pre-merge-'], keep: 10 },
  merge: { prefixes: ['pre-delete-', 'pre-merge-'], keep: 10 }
};

function safeDetail(detail) {
  return String(detail || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
}

function pruneBackups(dir, kind) {
  const pool = POOLS[kind];
  if (!pool) return;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.db') && pool.prefixes.some(p => f.startsWith(p)))
    .sort(); // Zeitstempel im Namen -> alphabetisch = zeitlich
  files.slice(0, Math.max(0, files.length - pool.keep)).forEach(f => fs.rmSync(path.join(dir, f), { force: true }));
}

// Legt eine Sicherung an und liefert den Dateipfad. Darf nicht innerhalb einer Transaktion aufgerufen werden.
function createBackup(db, dir, kind, detail = '') {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const unique = Math.random().toString(36).slice(2, 6);
  const suffix = safeDetail(detail) ? `__${safeDetail(detail)}` : '';
  const file = path.join(dir, `pre-${kind}-${stamp}-${unique}${suffix}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  pruneBackups(dir, kind);
  return file;
}

module.exports = { createBackup, pruneBackups };
