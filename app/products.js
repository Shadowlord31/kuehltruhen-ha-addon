const path = require('path');
const db = require('./db');
const { HttpError } = require('./stock');
const { normalizeName, nameKey } = require('./names');
const { createBackup } = require('./backup');
const { ensureNameIndex } = require('./migrate');

// Mindestbestand: leer/null/0 = keine Warnung, sonst Zahl > 0
function parseMinStock(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Mindestbestand muss eine Zahl ≥ 0 sein');
  return n === 0 ? null : n;
}

function productWithStock(productId) {
  const product = db.prepare('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?').get(productId);
  if (!product) return null;
  const stock = db.prepare(`
    SELECT se.id, se.uuid, se.location_id, l.name AS location_name, se.quantity, se.best_before, se.note, se.stored_at
    FROM stock_entries se JOIN locations l ON l.id = se.location_id
    WHERE se.product_id = ? AND se.quantity > 0
    ORDER BY se.stored_at ASC
  `).all(productId);
  const total = stock.reduce((sum, s) => sum + s.quantity, 0);
  const movementCount = db.prepare('SELECT COUNT(*) AS c FROM movements WHERE product_id = ?').get(productId).c;
  return { ...product, stock, total, movement_count: movementCount };
}

function requireProduct(id) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'Artikel nicht gefunden');
  return p;
}

const totalStock = id => db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_entries WHERE product_id = ? AND quantity > 0').get(id).q;

// Ändert eine beliebige Teilmenge aus name, unit, category_id, min_stock. Mengen bleiben unangetastet
// (auch bei geänderter Einheit ändert sich nur die Beschriftung).
const updateProduct = db.transaction((id, patch = {}) => {
  requireProduct(id);
  const fields = ['name', 'unit', 'category_id', 'min_stock'].filter(k => k in patch);
  if (!fields.length) throw new HttpError(400, 'Nichts zu ändern');

  const set = {};
  if ('name' in patch) {
    const name = normalizeName(patch.name);
    if (!name) throw new HttpError(400, 'Name fehlt');
    const clash = db.prepare('SELECT id, name FROM products WHERE name_key = ? AND id <> ?').get(nameKey(name), id);
    if (clash) throw new HttpError(409, `Den Artikel „${clash.name}“ gibt es schon.`, { existing_product_id: clash.id });
    set.name = name;
    set.name_key = nameKey(name);
  }
  if ('unit' in patch) {
    const unit = String(patch.unit ?? '').trim();
    if (!unit) throw new HttpError(400, 'Einheit fehlt');
    set.unit = unit;
  }
  if ('category_id' in patch) {
    const raw = patch.category_id;
    if (raw === null || raw === '' || raw === undefined) {
      set.category_id = null;
    } else {
      const cid = Number(raw);
      if (!Number.isInteger(cid) || !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(cid)) throw new HttpError(400, 'Kategorie nicht gefunden');
      set.category_id = cid;
    }
  }
  if ('min_stock' in patch) set.min_stock = parseMinStock(patch.min_stock);

  const cols = Object.keys(set);
  db.prepare(`UPDATE products SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => set[c]), id);
  ensureNameIndex(db); // nach einer Umbenennung können frühere Doppelte aufgelöst sein
  return productWithStock(id);
});

// Löscht einen Artikel ENDGÜLTIG samt Bestand und Protokoll. Vorher entsteht automatisch eine Sicherung.
// Mit Restbestand nur mit force = true (der Client fragt vorher nach).
function deleteProduct(id, { force = false } = {}) {
  const product = requireProduct(id);
  const stock = totalStock(id);
  if (stock > 0 && !force) {
    throw new HttpError(409, `„${product.name}“ hat noch Bestand (${stock} ${product.unit}). Zum endgültigen Löschen bitte bestätigen.`, { needs_force: true, stock });
  }

  const backup = createBackup(db, db.backupDir, 'delete', product.name); // nie innerhalb einer Transaktion
  const deleted = db.transaction(() => {
    const entries = db.prepare('SELECT COUNT(*) AS c FROM stock_entries WHERE product_id = ?').get(id).c;
    // movement_entries fallen per CASCADE mit; Bewegungen haben keinen Fremdschlüssel und müssen explizit weg
    const movements = db.prepare('DELETE FROM movements WHERE product_id = ?').run(id).changes;
    db.prepare('DELETE FROM products WHERE id = ?').run(id); // stock_entries per CASCADE
    return { stock_entries: entries, movements };
  })();
  ensureNameIndex(db);
  return { ok: true, name: product.name, deleted, backup: path.basename(backup) };
}

// Führt den Artikel `sourceId` in `targetId` zusammen: Bestand und Protokoll wandern zum Ziel, die Quelle wird gelöscht.
// Die Bestandseinträge behalten ihre IDs – Rückgängig im Protokoll funktioniert danach weiter.
function mergeProducts(sourceId, targetId) {
  if (sourceId === targetId) throw new HttpError(400, 'Ein Artikel kann nicht mit sich selbst zusammengeführt werden');
  const source = requireProduct(sourceId);
  const target = requireProduct(targetId);
  const same = (a, b) => a.trim().toLocaleLowerCase('de-DE') === b.trim().toLocaleLowerCase('de-DE');
  if (!same(source.unit, target.unit)) {
    throw new HttpError(409, `Die Einheiten unterscheiden sich („${source.unit}“ und „${target.unit}“). Bitte zuerst die Einheit angleichen.`);
  }

  const backup = createBackup(db, db.backupDir, 'merge', `${source.name}-in-${target.name}`);
  db.transaction(() => {
    db.prepare('UPDATE stock_entries SET product_id = ? WHERE product_id = ?').run(targetId, sourceId);
    db.prepare('UPDATE movements SET product_id = ? WHERE product_id = ?').run(targetId, sourceId);
    if (target.category_id === null && source.category_id !== null) db.prepare('UPDATE products SET category_id = ? WHERE id = ?').run(source.category_id, targetId);
    if (target.min_stock === null && source.min_stock !== null) db.prepare('UPDATE products SET min_stock = ? WHERE id = ?').run(source.min_stock, targetId);
    db.prepare('DELETE FROM products WHERE id = ?').run(sourceId); // Bestände sind bereits umgehängt
  })();
  ensureNameIndex(db);
  return { product: productWithStock(targetId), backup: path.basename(backup) };
}

module.exports = { parseMinStock, productWithStock, updateProduct, deleteProduct, mergeProducts };
