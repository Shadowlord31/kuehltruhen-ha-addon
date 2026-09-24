const express = require('express');
const path = require('path');
const db = require('./db');
const stockService = require('./stock');

const app = express();
const PORT = process.env.PORT || 8099;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function productWithStock(productId) {
  const product = db.prepare('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?').get(productId);
  if (!product) return null;
  const stock = db.prepare(`
    SELECT se.id, se.location_id, l.name AS location_name, se.quantity, se.best_before, se.note, se.stored_at
    FROM stock_entries se JOIN locations l ON l.id = se.location_id
    WHERE se.product_id = ? AND se.quantity > 0
    ORDER BY se.stored_at ASC
  `).all(productId);
  const total = stock.reduce((sum, s) => sum + s.quantity, 0);
  return { ...product, stock, total };
}

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

// Produkte (inkl. Bestand)
app.get('/api/products', (req, res) => {
  const products = db.prepare('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.name').all();
  const stockRows = db.prepare(`
    SELECT se.product_id, se.location_id, l.name AS location_name, SUM(se.quantity) AS quantity
    FROM stock_entries se JOIN locations l ON l.id = se.location_id
    WHERE se.quantity > 0
    GROUP BY se.product_id, se.location_id
  `).all();

  const byProduct = {};
  stockRows.forEach(r => {
    (byProduct[r.product_id] = byProduct[r.product_id] || []).push({ location_id: r.location_id, location_name: r.location_name, quantity: r.quantity });
  });

  res.json(products.map(p => ({
    ...p,
    stock: byProduct[p.id] || [],
    total: (byProduct[p.id] || []).reduce((s, x) => s + x.quantity, 0)
  })));
});

app.get('/api/products/:id', (req, res) => {
  const product = productWithStock(Number(req.params.id));
  if (!product) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json(product);
});

app.post('/api/products', (req, res) => {
  const { name, unit, category_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name fehlt' });
  const info = db.prepare('INSERT INTO products (name, unit, category_id) VALUES (?, ?, ?)')
    .run(name.trim(), (unit || 'Stk').trim(), category_id || null);
  res.json(productWithStock(info.lastInsertRowid));
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
  if (err instanceof stockService.HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  const status = err.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500;
  const error = status === 409 ? 'Name existiert bereits' : 'Interner Fehler';
  res.status(status).json({ error });
});

app.listen(PORT, () => console.log(`Kühltruhen-Add-on läuft auf Port ${PORT}`));
