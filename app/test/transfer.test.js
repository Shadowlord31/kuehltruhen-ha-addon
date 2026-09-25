const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(() => srv.stop());

const detail = async id => (await srv.api('GET', `/api/products/${id}`)).body;
const at = (prod, loc) => prod.stock.filter(s => s.location_id === loc);
const sum = list => list.reduce((s, x) => s + x.quantity, 0);

// Produkt mit zwei Einträgen in Truhe 1: 3 kg (MHD Januar, Notiz) und 2 kg (MHD Juni)
async function seed(name = 'Hack') {
  const { body: p } = await srv.api('POST', '/api/products', { name, unit: 'kg' });
  await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 3, best_before: '2027-01-01', note: 'Kiste 7' });
  await srv.api('POST', `/api/products/${p.id}/stock-in`, { location_id: 1, quantity: 2, best_before: '2027-06-01' });
  return p.id;
}
const transfer = (id, from, to, quantity) => srv.api('POST', `/api/products/${id}/transfer`, { from_location_id: from, to_location_id: to, quantity });

test('Umlagern verschiebt FIFO und behält MHD, Notiz und Einlagerdatum je Eintrag', async () => {
  const p = await seed();
  const before = await detail(p);
  const origin = Object.fromEntries(before.stock.map(s => [s.best_before, s]));

  const res = await transfer(p, 1, 2, 4); // 3 (Januar) + 1 (Juni)
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 5); // Gesamtbestand unverändert

  const after = await detail(p);
  assert.equal(sum(at(after, 1)), 1);
  assert.equal(sum(at(after, 2)), 4);
  assert.deepEqual(at(after, 1).map(s => [s.quantity, s.best_before]), [[1, '2027-06-01']]);
  const moved = Object.fromEntries(at(after, 2).map(s => [s.best_before, s]));
  assert.equal(moved['2027-01-01'].quantity, 3);
  assert.equal(moved['2027-01-01'].note, 'Kiste 7');
  assert.equal(moved['2027-01-01'].stored_at, origin['2027-01-01'].stored_at);
  assert.equal(moved['2027-06-01'].quantity, 1);
  assert.equal(moved['2027-06-01'].stored_at, origin['2027-06-01'].stored_at);
});

test('Umlagern in eine Truhe, die schon Bestand hat, und alles umlagern', async () => {
  const p = await seed('Fisch');
  await srv.api('POST', `/api/products/${p}/stock-in`, { location_id: 2, quantity: 10 });
  await transfer(p, 1, 2, 5);
  const after = await detail(p);
  assert.equal(sum(at(after, 1)), 0);
  assert.equal(sum(at(after, 2)), 15);
  const { body: list } = await srv.api('GET', '/api/products');
  const row = list.find(x => x.id === p);
  assert.deepEqual(row.stock.map(s => s.location_id), [2]); // Truhe 1 taucht nicht mehr auf
  assert.equal(row.next_best_before, '2027-01-01'); // MHD-Warnung folgt dem Bestand
});

test('Ungültige Umlagerungen ändern nichts', async () => {
  const p = await seed('Erbsen');
  const other = await seed('Mais');
  const expectFail = async (res, status) => {
    assert.equal(res.status, status);
    const d = await detail(p);
    assert.equal(sum(at(d, 1)), 5);
    assert.equal(sum(at(d, 2)), 0);
  };
  await expectFail(await transfer(p, 1, 1, 1), 400);      // gleiche Truhe
  await expectFail(await transfer(p, 1, 2, 5.5), 400);    // mehr als vorhanden
  await expectFail(await transfer(p, 2, 1, 1), 400);      // Quelle leer
  await expectFail(await transfer(p, 1, 2, 0), 400);
  await expectFail(await transfer(p, 1, 2, -1), 400);
  await expectFail(await transfer(p, 1, 999, 1), 404);    // Ziel unbekannt
  await expectFail(await transfer(p, 999, 2, 1), 404);    // Quelle unbekannt
  await expectFail(await srv.api('POST', `/api/products/${p}/transfer`, { from_location_id: 1, quantity: 1 }), 400); // Ziel fehlt
  assert.equal((await transfer(99999, 1, 2, 1)).status, 404);
  assert.equal(sum(at(await detail(other), 1)), 5); // anderes Produkt unberührt
});

test('Protokoll zeigt eine Umlagerung als eine Zeile mit Ziel', async () => {
  const p = await seed('Pommes');
  await transfer(p, 1, 3, 4);
  const { body: log } = await srv.api('GET', `/api/movements?product_id=${p}`);
  assert.equal(log.length, 3); // 2 Einlagerungen + 1 Umlagerung
  const row = log[0];
  assert.equal(row.reason, 'Umlagerung');
  assert.equal(row.delta, -4);
  assert.equal(row.location_name, 'Truhe 1');
  assert.equal(row.to_location_name, 'Truhe 3');
  assert.equal(row.undoable, true);

  // Auch am Limit-Rand darf die Umlagerung nicht „halb“ verschwinden
  const { body: newest } = await srv.api('GET', '/api/movements?limit=1');
  assert.equal(newest[0].id, row.id);
});

test('Undo einer Umlagerung stellt beide Seiten exakt wieder her', async () => {
  const p = await seed('Brokkoli');
  const before = await detail(p);
  await transfer(p, 1, 2, 4);
  const { body: log } = await srv.api('GET', `/api/movements?product_id=${p}`);

  assert.equal((await srv.api('POST', `/api/movements/${log[0].id}/undo`)).status, 200);
  const after = await detail(p);
  assert.equal(sum(at(after, 2)), 0);
  assert.deepEqual(
    at(after, 1).map(s => [s.quantity, s.best_before, s.stored_at]).sort(),
    before.stock.map(s => [s.quantity, s.best_before, s.stored_at]).sort()
  );

  const { body: log2 } = await srv.api('GET', `/api/movements?product_id=${p}`);
  assert.equal(log2[0].undoable, false);
  assert.ok(log2[0].undone_at);
  assert.equal((await srv.api('POST', `/api/movements/${log[0].id}/undo`)).status, 409); // nicht doppelt
});

test('Undo ist blockiert und atomar, solange das Ziel teilweise entnommen wurde', async () => {
  const p = await seed('Spinat');
  await transfer(p, 1, 2, 3);
  await srv.api('POST', `/api/products/${p}/stock-out`, { location_id: 2, quantity: 1 });
  const { body: log } = await srv.api('GET', `/api/movements?product_id=${p}`);
  const move = log.find(m => m.reason === 'Umlagerung');
  const out = log.find(m => m.reason === 'Entnahme');

  const blocked = await srv.api('POST', `/api/movements/${move.id}/undo`);
  assert.equal(blocked.status, 409);
  const d = await detail(p);
  assert.equal(sum(at(d, 1)), 2); // Quelle wurde NICHT angefasst
  assert.equal(sum(at(d, 2)), 2);
  const { body: still } = await srv.api('GET', `/api/movements?product_id=${p}`);
  assert.equal(still.find(m => m.id === move.id).undone_at, null);

  // Erst die Entnahme zurücknehmen, dann geht die Umlagerung
  assert.equal((await srv.api('POST', `/api/movements/${out.id}/undo`)).status, 200);
  assert.equal((await srv.api('POST', `/api/movements/${move.id}/undo`)).status, 200);
  const done = await detail(p);
  assert.equal(sum(at(done, 1)), 5);
  assert.equal(sum(at(done, 2)), 0);
});

test('Umlagerung lässt sich mit der Inventur kombinieren (Sollbestand stimmt)', async () => {
  const p = await seed('Lauch');
  await transfer(p, 1, 2, 2);
  const inv = await srv.api('POST', '/api/locations/2/inventory', { counts: [{ product_id: p, quantity: 2 }] });
  assert.equal(inv.status, 200);
  assert.equal(inv.body.unchanged, 1); // Soll war 2 → keine Abweichung
});
