const db = require('./db');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const EPS = 1e-9;

function requireProductAndLocation(productId, locationId) {
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(productId)) throw new HttpError(404, 'Produkt nicht gefunden');
  if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(locationId)) throw new HttpError(404, 'Standort nicht gefunden');
}

function addMovement(productId, locationId, delta, reason, entries) {
  const movementId = db.prepare('INSERT INTO movements (product_id, location_id, delta, reason) VALUES (?, ?, ?, ?)')
    .run(productId, locationId, delta, reason).lastInsertRowid;
  const link = db.prepare('INSERT INTO movement_entries (movement_id, entry_id, quantity) VALUES (?, ?, ?)');
  entries.forEach(e => link.run(movementId, e.entryId, e.quantity));
  return movementId;
}

function availableAt(productId, locationId) {
  return db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_entries WHERE product_id = ? AND location_id = ? AND quantity > 0')
    .get(productId, locationId).q;
}

// Einlagern: legt einen neuen Bestandseintrag an einem Standort an
const stockIn = db.transaction((productId, locationId, qty, { best_before = null, note = null, reason = 'Einlagerung' } = {}) => {
  if (!(qty > 0)) throw new HttpError(400, 'Menge > 0 erforderlich');
  requireProductAndLocation(productId, locationId);
  const entryId = db.prepare('INSERT INTO stock_entries (product_id, location_id, quantity, best_before, note) VALUES (?, ?, ?, ?, ?)')
    .run(productId, locationId, qty, best_before || null, note || null).lastInsertRowid;
  return addMovement(productId, locationId, qty, reason, [{ entryId, quantity: qty }]);
});

// Bucht qty FIFO (älteste Einträge zuerst) von einem Standort ab.
// Liefert die betroffenen Einträge samt entnommener Menge: [{ entry, quantity }]
function takeFifo(productId, locationId, qty) {
  const entries = db.prepare(`
    SELECT * FROM stock_entries WHERE product_id = ? AND location_id = ? AND quantity > 0 ORDER BY stored_at ASC, id ASC
  `).all(productId, locationId);
  const available = entries.reduce((s, e) => s + e.quantity, 0);
  if (available + EPS < qty) throw new HttpError(400, `Nur ${available} an diesem Standort vorrätig`);

  let remaining = qty;
  const taken = [];
  for (const entry of entries) {
    if (remaining <= EPS) break;
    const take = Math.min(entry.quantity, remaining);
    db.prepare('UPDATE stock_entries SET quantity = ROUND(quantity - ?, 6) WHERE id = ?').run(take, entry.id);
    taken.push({ entry, quantity: take });
    remaining -= take;
  }
  return taken;
}

// Entnehmen: bucht FIFO (älteste Einträge zuerst) an einem Standort ab
const stockOut = db.transaction((productId, locationId, qty, reason = 'Entnahme') => {
  if (!(qty > 0)) throw new HttpError(400, 'Menge > 0 erforderlich');
  requireProductAndLocation(productId, locationId);
  const taken = takeFifo(productId, locationId, qty);
  return addMovement(productId, locationId, -qty, reason, taken.map(t => ({ entryId: t.entry.id, quantity: t.quantity })));
});

// Umlagern: nimmt FIFO vom Quell-Standort und legt am Ziel entsprechende Einträge an.
// MHD, Notiz und Einlagerdatum bleiben je Eintrag erhalten. Aus- und Einbuchung teilen sich eine transfer_id.
const transfer = db.transaction((productId, fromLocationId, toLocationId, qty) => {
  if (!(qty > 0)) throw new HttpError(400, 'Menge > 0 erforderlich');
  if (fromLocationId === toLocationId) throw new HttpError(400, 'Quelle und Ziel müssen verschieden sein');
  requireProductAndLocation(productId, fromLocationId);
  requireProductAndLocation(productId, toLocationId);

  const taken = takeFifo(productId, fromLocationId, qty);
  const insert = db.prepare('INSERT INTO stock_entries (product_id, location_id, quantity, best_before, note, stored_at) VALUES (?, ?, ?, ?, ?, ?)');
  const created = taken.map(t => ({
    entryId: insert.run(productId, toLocationId, t.quantity, t.entry.best_before, t.entry.note, t.entry.stored_at).lastInsertRowid,
    quantity: t.quantity
  }));

  const outId = addMovement(productId, fromLocationId, -qty, 'Umlagerung', taken.map(t => ({ entryId: t.entry.id, quantity: t.quantity })));
  const inId = addMovement(productId, toLocationId, qty, 'Umlagerung', created);
  db.prepare('UPDATE movements SET transfer_id = ? WHERE id IN (?, ?)').run(outId, outId, inId);
  return outId;
});

// Nimmt die Wirkung einer einzelnen Bewegung zurück (exakt auf den betroffenen Bestandseinträgen)
function reverseMovement(m) {
  const links = db.prepare('SELECT * FROM movement_entries WHERE movement_id = ?').all(m.id);
  if (!links.length) throw new HttpError(400, 'Diese Bewegung kann nicht rückgängig gemacht werden');

  const getEntry = db.prepare('SELECT * FROM stock_entries WHERE id = ?');
  if (m.delta > 0) {
    // Einlagerung zurücknehmen: geht nur, solange die Menge noch da ist
    for (const l of links) {
      const entry = getEntry.get(l.entry_id);
      if (!entry || entry.quantity + EPS < l.quantity) {
        throw new HttpError(409, 'Die Menge wurde inzwischen teilweise entnommen – zuerst die späteren Entnahmen rückgängig machen');
      }
    }
    links.forEach(l => db.prepare('UPDATE stock_entries SET quantity = ROUND(quantity - ?, 6) WHERE id = ?').run(l.quantity, l.entry_id));
  } else {
    links.forEach(l => db.prepare('UPDATE stock_entries SET quantity = ROUND(quantity + ?, 6) WHERE id = ?').run(l.quantity, l.entry_id));
  }
  db.prepare("UPDATE movements SET undone_at = datetime('now') WHERE id = ?").run(m.id);
}

// Macht eine Bewegung rückgängig. Eine Umlagerung wird immer als Ganzes zurückgenommen (erst Ziel, dann Quelle);
// schlägt ein Teil fehl, wird nichts verändert (Transaktion).
const undoMovement = db.transaction(movementId => {
  const m = db.prepare('SELECT * FROM movements WHERE id = ?').get(movementId);
  if (!m) throw new HttpError(404, 'Bewegung nicht gefunden');
  if (m.undone_at) throw new HttpError(409, 'Bewegung wurde bereits rückgängig gemacht');
  const group = m.transfer_id
    ? db.prepare('SELECT * FROM movements WHERE transfer_id = ? ORDER BY delta DESC').all(m.transfer_id)
    : [m];
  group.forEach(reverseMovement);
});

// Inventur: gezählte Mengen an einem Standort mit dem Sollbestand abgleichen und nur Differenzen buchen.
// Alles oder nichts – bei einem ungültigen Eintrag wird nichts gebucht.
const applyInventory = db.transaction((locationId, counts) => {
  if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(locationId)) throw new HttpError(404, 'Standort nicht gefunden');
  if (!Array.isArray(counts) || !counts.length) throw new HttpError(400, 'Keine Zählwerte übergeben');

  const seen = new Set();
  const changes = [];
  for (const c of counts) {
    const productId = Number(c && c.product_id);
    const counted = c && c.quantity;
    if (!productId || typeof counted !== 'number' || !Number.isFinite(counted) || counted < 0) {
      throw new HttpError(400, 'Ungültige Zählmenge (Zahl ≥ 0 erforderlich)');
    }
    if (seen.has(productId)) throw new HttpError(400, 'Produkt mehrfach in der Zählung');
    seen.add(productId);

    const diff = Math.round((counted - availableAt(productId, locationId)) * 1e6) / 1e6;
    if (diff === 0) continue;
    if (diff > 0) stockIn(productId, locationId, diff, { reason: 'Inventur', note: 'Inventur' });
    else stockOut(productId, locationId, -diff, 'Inventur');
    changes.push({ product_id: productId, delta: diff });
  }
  return { changes, unchanged: counts.length - changes.length };
});

// Protokoll, neueste zuerst. Eine Umlagerung erscheint als eine Zeile (Aus-Seite plus Ziel-Standort).
function listMovements({ limit = 100, productId = null } = {}) {
  const rows = db.prepare(`
    SELECT m.id, m.product_id, p.name AS product_name, p.unit, m.location_id, l.name AS location_name,
           m.delta, m.reason, m.created_at, m.undone_at, m.transfer_id,
           m2.location_id AS to_location_id, l2.name AS to_location_name,
           EXISTS(SELECT 1 FROM movement_entries me WHERE me.movement_id = m.id) AS has_entries,
           EXISTS(SELECT 1 FROM movement_entries me WHERE me.movement_id = m2.id) AS partner_has_entries
    FROM movements m
    LEFT JOIN products p ON p.id = m.product_id
    LEFT JOIN locations l ON l.id = m.location_id
    LEFT JOIN movements m2 ON m.transfer_id IS NOT NULL AND m2.transfer_id = m.transfer_id AND m2.id <> m.id
    LEFT JOIN locations l2 ON l2.id = m2.location_id
    WHERE (? IS NULL OR m.product_id = ?)
      AND NOT (m.transfer_id IS NOT NULL AND m.delta > 0)
    ORDER BY m.id DESC
    LIMIT ?
  `).all(productId, productId, limit);
  return rows.map(({ has_entries, partner_has_entries, ...m }) => ({
    ...m,
    undoable: !!has_entries && (!m.transfer_id || !!partner_has_entries) && !m.undone_at
  }));
}

module.exports = { HttpError, stockIn, stockOut, transfer, undoMovement, applyInventory, listMovements, availableAt };
