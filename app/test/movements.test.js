const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(() => srv.stop());

async function newProduct(name = 'Rinderhack') {
  const { body } = await srv.api('POST', '/api/products', { name, unit: 'kg' });
  return body.id;
}
const total = async id => (await srv.api('GET', `/api/products/${id}`)).body.total;

test('Einlagern und Entnehmen werden protokolliert', async () => {
  const p = await newProduct();
  await srv.api('POST', `/api/products/${p}/stock-in`, { location_id: 1, quantity: 3 });
  await srv.api('POST', `/api/products/${p}/stock-out`, { location_id: 1, quantity: 1 });

  const { body: log } = await srv.api('GET', `/api/movements?product_id=${p}`);
  assert.equal(log.length, 2);
  assert.deepEqual(log.map(m => [m.reason, m.delta]), [['Entnahme', -1], ['Einlagerung', 3]]);
  assert.equal(log[0].product_name, 'Rinderhack');
  assert.equal(log[0].location_name, 'Truhe 1');
  assert.ok(log.every(m => m.undoable));
});

test('Undo einer Entnahme bucht über mehrere Einträge exakt zurück', async () => {
  const p = await newProduct('Pommes');
  await srv.api('POST', `/api/products/${p}/stock-in`, { location_id: 1, quantity: 3, best_before: '2027-01-01' });
  await srv.api('POST', `/api/products/${p}/stock-in`, { location_id: 1, quantity: 2, best_before: '2027-06-01' });
  await srv.api('POST', `/api/products/${p}/stock-out`, { location_id: 1, quantity: 4 }); // 3 + 1
  assert.equal(await total(p), 1);

  const { body: log } = await srv.api('GET', `/api/movements?product_id=${p}`);
  const out = log[0];
  assert.equal((await srv.api('POST', `/api/movements/${out.id}/undo`)).status, 200);

  const { body: prod } = await srv.api('GET', `/api/products/${p}`);
  assert.equal(prod.total, 5);
  assert.deepEqual(prod.stock.map(s => [s.quantity, s.best_before]), [[3, '2027-01-01'], [2, '2027-06-01']]);

  const { body: after } = await srv.api('GET', `/api/movements?product_id=${p}`);
  assert.equal(after[0].undoable, false);
  assert.ok(after[0].undone_at);
  assert.equal((await srv.api('POST', `/api/movements/${out.id}/undo`)).status, 409); // nicht doppelt
});

test('Einlagerung lässt sich nur zurücknehmen, solange die Menge noch da ist', async () => {
  const p = await newProduct('Erbsen');
  await srv.api('POST', `/api/products/${p}/stock-in`, { location_id: 2, quantity: 3 });
  await srv.api('POST', `/api/products/${p}/stock-out`, { location_id: 2, quantity: 1 });
  const { body: log } = await srv.api('GET', `/api/movements?product_id=${p}`);
  const [out, inn] = log;

  const blocked = await srv.api('POST', `/api/movements/${inn.id}/undo`);
  assert.equal(blocked.status, 409);
  assert.equal(await total(p), 2);

  await srv.api('POST', `/api/movements/${out.id}/undo`);
  assert.equal((await srv.api('POST', `/api/movements/${inn.id}/undo`)).status, 200);
  assert.equal(await total(p), 0);
});

test('Ungültige Anfragen liefern saubere Fehler', async () => {
  assert.equal((await srv.api('POST', '/api/movements/9999/undo')).status, 404);
  const p = await newProduct('Mais');
  assert.equal((await srv.api('POST', `/api/products/${p}/stock-out`, { location_id: 1, quantity: 1 })).status, 400);
  assert.equal((await srv.api('POST', `/api/products/${p}/stock-in`, { location_id: 999, quantity: 1 })).status, 404);
  assert.equal((await srv.api('POST', `/api/products/9999/stock-in`, { location_id: 1, quantity: 1 })).status, 404);
});
