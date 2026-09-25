const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(() => srv.stop());

const create = async name => (await srv.api('POST', '/api/products', { name, unit: 'kg' })).body;
const stockIn = (id, loc, quantity, note) => srv.api('POST', `/api/products/${id}/stock-in`, { location_id: loc, quantity, ...(note !== undefined ? { note } : {}) });
const listed = async id => (await srv.api('GET', '/api/products')).body.find(p => p.id === id);

test('Liste enthält Notizen (dedupliziert, älteste zuerst), frühestes Einlagerdatum und Anzahl Protokolleinträge', async () => {
  const a = await create('Mit Notizen');
  await stockIn(a.id, 1, 2, 'Kiste 7');
  await stockIn(a.id, 1, 1, ' Kiste 7 ');   // gleiche Notiz (getrimmt) → nur einmal
  await stockIn(a.id, 1, 3, 'Reste');
  await stockIn(a.id, 2, 1, '   ');         // leere Notiz zählt nicht
  await stockIn(a.id, 2, 2);                // ohne Notiz

  const p = await listed(a.id);
  assert.deepEqual(p.notes, ['Kiste 7', 'Reste']);
  const t1 = p.stock.find(s => s.location_id === 1);
  const t2 = p.stock.find(s => s.location_id === 2);
  assert.deepEqual(t1.notes, ['Kiste 7', 'Reste']);
  assert.deepEqual(t2.notes, []);
  assert.equal(p.movement_count, 5);

  const detail = (await srv.api('GET', `/api/products/${a.id}`)).body;
  const oldest = detail.stock.map(s => s.stored_at).sort()[0];
  assert.match(p.oldest_stored_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(p.oldest_stored_at, oldest);
  assert.equal(t1.oldest_stored_at, detail.stock.filter(s => s.location_id === 1).map(s => s.stored_at).sort()[0]);
});

test('Nur vorhandener Bestand zählt; Artikel ohne Bestand haben keine Notizen und kein Datum', async () => {
  const b = await create('Aufgebraucht mit Notiz');
  await stockIn(b.id, 1, 1, 'Alt');
  await srv.api('POST', `/api/products/${b.id}/stock-out`, { location_id: 1, quantity: 1 });
  const p = await listed(b.id);
  assert.deepEqual(p.notes, []);
  assert.equal(p.oldest_stored_at, null);
  assert.equal(p.total, 0);
  assert.equal(p.movement_count, 2);

  const none = await create('Ohne alles');
  const q = await listed(none.id);
  assert.deepEqual([q.notes, q.oldest_stored_at, q.movement_count], [[], null, 0]);
});

test('Die automatische Notiz der Inventur erscheint nicht in der Übersicht, bleibt aber im Detail', async () => {
  const c = await create('Per Inventur');
  await srv.api('POST', '/api/locations/1/inventory', { counts: [{ product_id: c.id, quantity: 4 }] });
  const p = await listed(c.id);
  assert.equal(p.total, 4);
  assert.deepEqual(p.notes, []);
  const detail = (await srv.api('GET', `/api/products/${c.id}`)).body;
  assert.equal(detail.stock[0].note, 'Inventur');
});

test('Umlagern behält Notiz und Einlagerdatum am Ziel', async () => {
  const d = await create('Wird umgelagert');
  await stockIn(d.id, 1, 2, 'Kiste 7');
  await stockIn(d.id, 1, 3, 'Reste');
  const before = await listed(d.id);
  await srv.api('POST', `/api/products/${d.id}/transfer`, { from_location_id: 1, to_location_id: 3, quantity: 2 });
  const after = await listed(d.id);
  const target = after.stock.find(s => s.location_id === 3);
  const source = after.stock.find(s => s.location_id === 1);
  assert.deepEqual(target.notes, ['Kiste 7']);
  assert.deepEqual(source.notes, ['Reste']);
  assert.equal(target.oldest_stored_at, before.oldest_stored_at); // Einlagerdatum wandert mit
  assert.deepEqual(after.notes.sort(), ['Kiste 7', 'Reste']);
});
