const crypto = require('crypto');

// Vorgangs-ID (Idempotenz): Sendet der Client bei einer schreibenden Anfrage den Header "Idempotency-Key",
// wird diese Anfrage höchstens EINMAL ausgeführt. Wiederholungen (Doppelklick, erneutes Absenden nach einem
// Hänger von Home Assistant) bekommen die gespeicherte Antwort, ohne dass etwas erneut gebucht oder angelegt wird.
//
// Alle Handler sind synchron (better-sqlite3): Prüfen, Ausführen und Speichern laufen in einem Durchgang,
// es gibt also keine Überschneidung zwischen zwei gleichzeitigen Anfragen mit demselben Schlüssel.
const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;
const RETENTION_DAYS = 7;

function bodyHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

function idempotency(db) {
  const find = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?');
  const store = db.prepare('INSERT OR IGNORE INTO idempotency_keys (key, method, path, status, response, body_hash) VALUES (?, ?, ?, ?, ?, ?)');

  return function idempotencyMiddleware(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const key = req.get('Idempotency-Key');
    if (!key) return next();
    if (!KEY_RE.test(key)) return res.status(400).json({ error: 'Ungültige Vorgangs-ID' });

    const path = req.originalUrl; // inkl. Query, z. B. ?force=1
    const hash = bodyHash(req.body);
    const known = find.get(key);
    if (known) {
      const sameRequest = known.method === req.method && known.path === path && (!known.body_hash || known.body_hash === hash);
      if (!sameRequest) return res.status(422).json({ error: 'Diese Vorgangs-ID wurde bereits für eine andere Anfrage verwendet' });
      res.set('Idempotent-Replay', 'true');
      return res.status(known.status).type('application/json').send(known.response);
    }

    // Nur erfolgreiche Antworten merken – nach einem Fehler (z. B. Eingabe korrigieren) darf erneut ausgeführt werden
    const json = res.json.bind(res);
    res.json = payload => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        store.run(key, req.method, path, res.statusCode, JSON.stringify(payload), hash);
      }
      return json(payload);
    };
    next();
  };
}

function purgeOld(db, days = RETENTION_DAYS) {
  return db.prepare("DELETE FROM idempotency_keys WHERE created_at < datetime('now', ?)").run(`-${days} days`).changes;
}

module.exports = { idempotency, purgeOld, RETENTION_DAYS };
