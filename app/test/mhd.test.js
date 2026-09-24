const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startServer({ MHD_WARN_DAYS: '10' }); });
test.after(() => srv.stop());

test('Einstellungen liefern die MHD-Warnschwelle', async () => {
  const { body } = await srv.api('GET', '/api/settings');
  assert.equal(body.mhd_warn_days, 10);
});

test('Produktliste enthält das früheste MHD je Standort und Produkt', async () => {
  const { body: p } = await srv.api('POST', '/api/products', { name: 'Hack', unit: 'kg' });
  await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 2, best_before: '2027-03-01' });
  await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 1, best_before: '2027-01-15' });
  await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 1 }); // ohne MHD
  await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 2, quantity: 4, best_before: '2026-12-24' });
  const { body: none } = await srv.api('POST', '/api/products', { name: 'Ohne MHD', unit: 'Stk' });
  await srv.api('POST', `/api/products/${none.id}/stock-in`, { location_id: 3, quantity: 1 });

  const { body: list } = await srv.api('GET', '/api/products');
  const hack = list.find(x => x.id === p.id);
  assert.equal(hack.next_best_before, '2026-12-24');
  assert.deepEqual(
    hack.stock.map(s => [s.location_id, s.next_best_before]).sort(),
    [[1, '2027-01-15'], [2, '2026-12-24']]
  );
  assert.equal(list.find(x => x.id === none.id).next_best_before, null);
});

test('Ein leergeräumter Eintrag zählt nicht mehr fürs MHD', async () => {
  const { body: p } = await srv.api('POST', '/api/products', { name: 'Fisch', unit: 'kg' });
  await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 1, best_before: '2026-10-01' });
  await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 1, best_before: '2027-05-01' });
  await srv.api('POST', `/api/products/${p.id}/stock-out`, { location_id: 1, quantity: 1 }); // FIFO: der ältere Eintrag
  const { body: list } = await srv.api('GET', '/api/products');
  assert.equal(list.find(x => x.id === p.id).next_best_before, '2027-05-01');
});
