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

// Entnehmen: bucht FIFO (älteste Einträge zuerst) an einem Standort ab
const stockOut = db.transaction((productId, locationId, qty, reason = 'Entnahme') => {
  if (!(qty > 0)) throw new HttpError(400, 'Menge > 0 erforderlich');
  requireProductAndLocation(productId, locationId);
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
    taken.push({ entryId: entry.id, quantity: take });
    remaining -= take;
  }
  return addMovement(productId, locationId, -qty, reason, taken);
});

// Macht eine Bewegung rückgängig, indem die betroffenen Bestandseinträge exakt zurückgesetzt werden
const undoMovement = db.transaction(movementId => {
  const m = db.prepare('SELECT * FROM movements WHERE id = ?').get(movementId);
  if (!m) throw new HttpError(404, 'Bewegung nicht gefunden');
  if (m.undone_at) throw new HttpError(409, 'Bewegung wurde bereits rückgängig gemacht');
  const links = db.prepare('SELECT * FROM movement_entries WHERE movement_id = ?').all(movementId);
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
  db.prepare("UPDATE movements SET undone_at = datetime('now') WHERE id = ?").run(movementId);
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

function listMovements({ limit = 100, productId = null } = {}) {
  const rows = db.prepare(`
    SELECT m.id, m.product_id, p.name AS product_name, p.unit, m.location_id, l.name AS location_name,
           m.delta, m.reason, m.created_at, m.undone_at,
           EXISTS(SELECT 1 FROM movement_entries me WHERE me.movement_id = m.id) AS has_entries
    FROM movements m
    LEFT JOIN products p ON p.id = m.product_id
    LEFT JOIN locations l ON l.id = m.location_id
    WHERE (? IS NULL OR m.product_id = ?)
    ORDER BY m.id DESC
    LIMIT ?
  `).all(productId, productId, limit);
  return rows.map(({ has_entries, ...m }) => ({ ...m, undoable: !!has_entries && !m.undone_at }));
}

module.exports = { HttpError, stockIn, stockOut, undoMovement, applyInventory, listMovements, availableAt };
