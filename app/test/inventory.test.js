const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(() => srv.stop());

async function product(name, stock = {}) {
  const { body } = await srv.api('POST', '/api/products', { name, unit: 'kg' });
  for (const [loc, qty] of Object.entries(stock)) {
    await srv.api('POST', `/api/products/${body.id}/stock-in`, { location_id: Number(loc), quantity: qty });
  }
  return body.id;
}
const qtyAt = async (id, loc) => {
  const { body } = await srv.api('GET', `/api/products/${id}`);
  return body.stock.filter(s => s.location_id === loc).reduce((s, x) => s + x.quantity, 0);
};

test('Inventur bucht nur Differenzen und protokolliert sie als „Inventur“', async () => {
  const mehr = await product('Mehr', { 1: 2 });
  const weniger = await product('Weniger', { 1: 5 });
  const gleich = await product('Gleich', { 1: 3 });
  const neu = await product('Neu am Standort', { 2: 1 }); // liegt nur in Truhe 2
  const auf0 = await product('Aufgebraucht', { 1: 4 });

  const { status, body } = await srv.api('POST', '/api/locations/1/inventory', {
    counts: [
      { product_id: mehr, quantity: 2.5 },
      { product_id: weniger, quantity: 3 },
      { product_id: gleich, quantity: 3 },
      { product_id: neu, quantity: 2 },
      { product_id: auf0, quantity: 0 }
    ]
  });
  assert.equal(status, 200);
  assert.equal(body.unchanged, 1);
  assert.deepEqual(body.changes.map(c => c.delta), [0.5, -2, 2, -4]);

  assert.equal(await qtyAt(mehr, 1), 2.5);
  assert.equal(await qtyAt(weniger, 1), 3);
  assert.equal(await qtyAt(gleich, 1), 3);
  assert.equal(await qtyAt(neu, 1), 2);
  assert.equal(await qtyAt(neu, 2), 1); // anderer Standort bleibt unberührt
  assert.equal(await qtyAt(auf0, 1), 0);

  const { body: log } = await srv.api('GET', `/api/movements?product_id=${weniger}`);
  assert.deepEqual([log[0].reason, log[0].delta], ['Inventur', -2]);
});

test('Inventurbuchungen lassen sich einzeln rückgängig machen', async () => {
  const p = await product('Undo-Inventur', { 3: 4 });
  await srv.api('POST', '/api/locations/3/inventory', { counts: [{ product_id: p, quantity: 1 }] });
  assert.equal(await qtyAt(p, 3), 1);
  const { body: log } = await srv.api('GET', `/api/movements?product_id=${p}`);
  assert.equal((await srv.api('POST', `/api/movements/${log[0].id}/undo`)).status, 200);
  assert.equal(await qtyAt(p, 3), 4);
});

test('Ungültige Zählung bucht gar nichts (alles oder nichts)', async () => {
  const a = await product('Atomar A', { 1: 2 });
  const b = await product('Atomar B', { 1: 2 });
  const bad = [
    [{ product_id: a, quantity: 9 }, { product_id: b, quantity: -1 }],
    [{ product_id: a, quantity: 9 }, { product_id: b, quantity: 'x' }],
    [{ product_id: a, quantity: 9 }, { product_id: a, quantity: 1 }],
    [{ product_id: a, quantity: 9 }, { product_id: 99999, quantity: 1 }]
  ];
  for (const counts of bad) {
    const res = await srv.api('POST', '/api/locations/1/inventory', { counts });
    assert.ok([400, 404].includes(res.status), JSON.stringify(counts));
    assert.equal(await qtyAt(a, 1), 2, 'A darf unverändert sein');
    assert.equal(await qtyAt(b, 1), 2);
  }
});

test('Unbekannter Standort und leere Zählung', async () => {
  assert.equal((await srv.api('POST', '/api/locations/999/inventory', { counts: [{ product_id: 1, quantity: 1 }] })).status, 404);
  assert.equal((await srv.api('POST', '/api/locations/1/inventory', { counts: [] })).status, 400);
  assert.equal((await srv.api('POST', '/api/locations/1/inventory', {})).status, 400);
});
