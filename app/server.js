const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const stockService = require('./stock');
const { normalizeName, nameKey } = require('./names');
const { idempotency, purgeOld } = require('./idempotency');
const { parseMinStock, productWithStock, updateProduct, deleteProduct, mergeProducts } = require('./products');

const app = express();
const PORT = process.env.PORT || 8099;

// Add-on-Optionen schreibt Home Assistant nach /data/options.json (lokal nicht vorhanden)
function loadOptions() {
  try { return JSON.parse(fs.readFileSync('/data/options.json', 'utf8')); } catch (e) { return {}; }
}
const MHD_WARN_DAYS = Number(process.env.MHD_WARN_DAYS || loadOptions().mhd_warntage) || 7;

app.use(express.json());
// Vorgangs-ID: wiederholte schreibende Anfragen (Doppelklick, erneutes Absenden nach einem Hänger) werden nicht erneut ausgeführt
app.use('/api', idempotency(db));
app.use(express.static(path.join(__dirname, 'public')));

// Kategorien
app.get('/api/categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all());
});
app.post('/api/categories', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name fehlt' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories').get().m;
  const info = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)').run(name.trim(), maxOrder + 1);
  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid));
});

// Standorte
app.get('/api/locations', (req, res) => {
  res.json(db.prepare('SELECT * FROM locations ORDER BY sort_order, name').all());
});
app.post('/api/locations', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name fehlt' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM locations').get().m;
  const info = db.prepare('INSERT INTO locations (name, sort_order) VALUES (?, ?)').run(name.trim(), maxOrder + 1);
  res.json(db.prepare('SELECT * FROM locations WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/categories/:id', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name fehlt' });
  const info = db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name.trim(), Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(req.params.id)));
});
// Produkte der Kategorie werden dabei "ohne Kategorie" (ON DELETE SET NULL)
app.delete('/api/categories/:id', (req, res) => {
  const info = db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ ok: true });
});

app.put('/api/locations/:id', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name fehlt' });
  const info = db.prepare('UPDATE locations SET name = ? WHERE id = ?').run(name.trim(), Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json(db.prepare('SELECT * FROM locations WHERE id = ?').get(Number(req.params.id)));
});
// Standorte mit Bestand dürfen nicht gelöscht werden (Bestandseinträge hängen per CASCADE daran)
app.delete('/api/locations/:id', (req, res) => {
  const id = Number(req.params.id);
  const stock = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_entries WHERE location_id = ? AND quantity > 0').get(id).q;
  if (stock > 0) return res.status(409).json({ error: 'Standort hat noch Bestand und kann nicht gelöscht werden' });
  const info = db.prepare('DELETE FROM locations WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ ok: true });
});

// Inventur: body { counts: [{ product_id, quantity }] } – gebucht werden nur Abweichungen zum Sollbestand
app.post('/api/locations/:id/inventory', (req, res) => {
  res.json(stockService.applyInventory(Number(req.params.id), req.body.counts));
});

// Produkte (inkl. Bestand)
app.get('/api/products', (req, res) => {
  const products = db.prepare('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.name').all();
  const stockRows = db.prepare(`
    SELECT se.product_id, se.location_id, l.name AS location_name, SUM(se.quantity) AS quantity,
           MIN(se.best_before) AS next_best_before, MIN(se.stored_at) AS oldest_stored_at
    FROM stock_entries se JOIN locations l ON l.id = se.location_id
    WHERE se.quantity > 0
    GROUP BY se.product_id, se.location_id
  `).all();

  // Notizen der vorhandenen Bestände (Menge > 0), älteste zuerst. Der Text "Inventur", den die Inventur
  // automatisch setzt, wird für die Übersicht ausgelassen.
  const noteRows = db.prepare(`
    SELECT product_id, location_id, TRIM(note) AS note FROM stock_entries
    WHERE quantity > 0 AND note IS NOT NULL AND TRIM(note) <> '' AND TRIM(note) <> 'Inventur'
    ORDER BY stored_at ASC, id ASC
  `).all();
  const notesBy = {}; // "produkt:standort" -> [Notizen]
  const addNote = (key, note) => { const list = (notesBy[key] = notesBy[key] || []); if (!list.includes(note)) list.push(note); };
  noteRows.forEach(n => { addNote(`${n.product_id}:${n.location_id}`, n.note); addNote(`${n.product_id}`, n.note); });

  const movementCounts = Object.fromEntries(
    db.prepare('SELECT product_id, COUNT(*) AS c FROM movements GROUP BY product_id').all().map(r => [r.product_id, r.c])
  );

  const byProduct = {};
  stockRows.forEach(r => {
    (byProduct[r.product_id] = byProduct[r.product_id] || []).push({
      location_id: r.location_id, location_name: r.location_name, quantity: r.quantity,
      next_best_before: r.next_best_before, oldest_stored_at: r.oldest_stored_at,
      notes: notesBy[`${r.product_id}:${r.location_id}`] || []
    });
  });

  res.json(products.map(p => {
    const stock = byProduct[p.id] || [];
    const dates = stock.map(s => s.next_best_before).filter(Boolean).sort();
    const stored = stock.map(s => s.oldest_stored_at).filter(Boolean).sort();
    return {
      ...p, stock, total: stock.reduce((s, x) => s + x.quantity, 0), next_best_before: dates[0] || null,
      oldest_stored_at: stored[0] || null, notes: notesBy[String(p.id)] || [], movement_count: movementCounts[p.id] || 0
    };
  }));
});

// Einstellungen fürs Frontend (MHD-Warnschwelle)
app.get('/api/settings', (req, res) => {
  res.json({ mhd_warn_days: MHD_WARN_DAYS });
});

app.get('/api/products/:id', (req, res) => {
  const product = productWithStock(Number(req.params.id));
  if (!product) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json(product);
});

app.post('/api/products', (req, res) => {
  const { name, unit, category_id, min_stock } = req.body;
  if (!name || !normalizeName(name)) return res.status(400).json({ error: 'Name fehlt' });
  const cleanName = normalizeName(name);
  const existing = db.prepare('SELECT id, name FROM products WHERE name_key = ?').get(nameKey(cleanName));
  if (existing) {
    return res.status(409).json({ error: `Den Artikel „${existing.name}“ gibt es schon.`, existing_product_id: existing.id });
  }
  const info = db.prepare('INSERT INTO products (name, unit, category_id, min_stock, name_key) VALUES (?, ?, ?, ?, ?)')
    .run(cleanName, (unit || 'Stk').trim(), category_id || null, parseMinStock(min_stock), nameKey(cleanName));
  res.json(productWithStock(info.lastInsertRowid));
});

// Artikel bearbeiten: beliebige Teilmenge aus name, unit, category_id, min_stock
app.put('/api/products/:id', (req, res) => {
  res.json(updateProduct(Number(req.params.id), req.body));
});

// Artikel ENDGÜLTIG löschen (inkl. Bestand und Protokoll). Mit Restbestand nur mit ?force=1. Vorher automatische Sicherung.
app.delete('/api/products/:id', (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  res.json(deleteProduct(Number(req.params.id), { force }));
});

// Artikel in einen anderen zusammenführen: Bestand und Protokoll wandern zum Ziel, dieser Artikel wird gelöscht
app.post('/api/products/:id/merge', (req, res) => {
  const target = Number(req.body.into_product_id);
  if (!target) return res.status(400).json({ error: 'Ziel-Artikel fehlt' });
  res.json(mergeProducts(Number(req.params.id), target));
});

// Einlagern: legt einen neuen Bestandseintrag an einem Standort an
app.post('/api/products/:id/stock-in', (req, res) => {
  const productId = Number(req.params.id);
  const { location_id, quantity, best_before, note } = req.body;
  if (!location_id || !(Number(quantity) > 0)) return res.status(400).json({ error: 'Standort und Menge > 0 erforderlich' });
  stockService.stockIn(productId, Number(location_id), Number(quantity), { best_before, note });
  res.json(productWithStock(productId));
});

// Entnehmen: bucht FIFO (älteste Einträge zuerst) an einem Standort ab
app.post('/api/products/:id/stock-out', (req, res) => {
  const productId = Number(req.params.id);
  const { location_id, quantity } = req.body;
  if (!location_id || !(Number(quantity) > 0)) return res.status(400).json({ error: 'Standort und Menge > 0 erforderlich' });
  stockService.stockOut(productId, Number(location_id), Number(quantity));
  res.json(productWithStock(productId));
});

// Umlagern: Bestand von einer Truhe in eine andere verschieben (MHD bleibt erhalten)
app.post('/api/products/:id/transfer', (req, res) => {
  const productId = Number(req.params.id);
  const { from_location_id, to_location_id, quantity } = req.body;
  if (!from_location_id || !to_location_id || !(Number(quantity) > 0)) {
    return res.status(400).json({ error: 'Quell-Standort, Ziel-Standort und Menge > 0 erforderlich' });
  }
  stockService.transfer(productId, Number(from_location_id), Number(to_location_id), Number(quantity));
  res.json(productWithStock(productId));
});

// Bewegungsprotokoll (neueste zuerst), optional pro Produkt
app.get('/api/movements', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const productId = req.query.product_id ? Number(req.query.product_id) : null;
  res.json(stockService.listMovements({ limit, productId }));
});

app.post('/api/movements/:id/undo', (req, res) => {
  stockService.undoMovement(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Fehler immer als JSON zurückgeben (z. B. doppelter Kategorie-/Standortname)
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültige Anfrage (kein gültiges JSON)' });
  if (err instanceof stockService.HttpError) return res.status(err.status).json({ error: err.message, ...err.data });
  console.error(err);
  const status = err.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500;
  const error = status === 409 ? 'Name existiert bereits' : 'Interner Fehler';
  res.status(status).json({ error });
});

// Alte Vorgangs-IDs aufräumen (beim Start und danach alle 6 Stunden)
purgeOld(db);
setInterval(() => purgeOld(db), 6 * 60 * 60 * 1000).unref();

app.listen(PORT, () => console.log(`Kühltruhen-Add-on läuft auf Port ${PORT}`));
