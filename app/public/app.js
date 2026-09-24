const app = document.getElementById('app');

// Relative Pfade (ohne führenden "/"), damit alles auch hinter HA-Ingress
// unter /api/hassio_ingress/<token>/ funktioniert.
async function api(path, opts = {}) {
  if (opts.body && typeof opts.body !== 'string') {
    opts = { ...opts, method: opts.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) };
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* kein JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `Fehler ${res.status}`);
  return data;
}

const state = {
  products: [],
  categories: [],
  locations: [],
  search: '',
  locationFilter: null, // location_id oder null = alle
  categoryFilter: null, // category_id, 'none' oder null = alle
  view: 'list',         // 'list' | 'detail' | 'new' | 'manage' | 'log'
  movements: [],        // Bewegungsprotokoll
  logProductId: null,   // Protokoll auf ein Produkt einschränken
  detail: null,         // Produkt inkl. stock-Einträgen
  step: 1,              // Menge pro Plus/Minus im Detail
  addingLocation: false,
  error: null
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(n) {
  return Number(n).toLocaleString('de-DE', { maximumFractionDigits: 3 });
}

function fmtDateTime(sqlUtc) {
  // SQLite speichert datetime('now') in UTC ohne Zeitzone
  return new Date(sqlUtc.replace(' ', 'T') + 'Z').toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-');
  return `${day}.${m}.${y}`;
}

function errorBox() {
  return state.error ? `<div class="error">${esc(state.error)}</div>` : '';
}

async function run(fn) {
  try {
    state.error = null;
    await fn();
  } catch (err) {
    state.error = err.message;
  }
  render();
}

async function loadAll() {
  const [products, categories, locations] = await Promise.all([
    api('api/products'), api('api/categories'), api('api/locations')
  ]);
  Object.assign(state, { products, categories, locations });
}

function render() {
  if (state.view === 'detail' && state.detail) return renderDetail();
  if (state.view === 'new') return renderNew();
  if (state.view === 'manage') return renderManage();
  if (state.view === 'log') return renderLog();
  renderList();
}

/* ---------- Übersicht ---------- */

function filteredProducts() {
  const q = state.search.trim().toLowerCase();
  return state.products
    .filter(p => !q || p.name.toLowerCase().includes(q))
    .filter(p => {
      if (state.categoryFilter === null) return true;
      if (state.categoryFilter === 'none') return !p.category_id;
      return p.category_id === state.categoryFilter;
    })
    .filter(p => state.locationFilter === null || p.stock.some(s => s.location_id === state.locationFilter));
}

function productQty(p) {
  if (state.locationFilter === null) return p.total;
  const s = p.stock.find(x => x.location_id === state.locationFilter);
  return s ? s.quantity : 0;
}

function productRow(p) {
  const qty = productQty(p);
  const where = state.locationFilter === null && p.stock.length
    ? p.stock.map(s => `${esc(s.location_name)}: ${fmt(s.quantity)}`).join(' · ')
    : '';
  return `
    <div class="card product row" data-id="${p.id}">
      <div>
        <div>${esc(p.name)}</div>
        ${where ? `<div class="muted">${where}</div>` : ''}
      </div>
      <span class="qty ${qty > 0 ? '' : 'zero'}">${fmt(qty)} ${esc(p.unit)}</span>
    </div>`;
}

function listHtml() {
  const products = filteredProducts();
  if (!state.products.length) return '<p class="muted">Noch keine Produkte angelegt.</p>';
  if (!products.length) return '<p class="muted">Keine Treffer.</p>';

  // Mit Kategoriefilter: flache Liste. Ohne: nach Kategorie gruppiert.
  if (state.categoryFilter !== null) return products.map(productRow).join('');

  const groups = state.categories
    .map(c => ({ name: c.name, items: products.filter(p => p.category_id === c.id) }))
    .concat([{ name: 'Ohne Kategorie', items: products.filter(p => !p.category_id) }])
    .filter(g => g.items.length);
  return groups.map(g => `<h2>${esc(g.name)}</h2>${g.items.map(productRow).join('')}`).join('');
}

function chip(label, active, attrs) {
  return `<button class="chip ${active ? 'active' : ''}" ${attrs}>${esc(label)}</button>`;
}

function renderList() {
  const hasUncategorized = state.products.some(p => !p.category_id);
  app.innerHTML = `
    <div class="row"><h1>Kühltruhen</h1><span class="actions"><button id="log">Protokoll</button><button id="manage" aria-label="Verwaltung">⚙ Verwalten</button></span></div>
    ${errorBox()}
    <input class="search" type="search" placeholder="Produkt suchen…" value="${esc(state.search)}" />
    <div class="chips">
      ${chip('Alle Standorte', state.locationFilter === null, 'data-loc=""')}
      ${state.locations.map(l => chip(l.name, state.locationFilter === l.id, `data-loc="${l.id}"`)).join('')}
    </div>
    <div class="chips">
      ${chip('Alle Kategorien', state.categoryFilter === null, 'data-cat=""')}
      ${state.categories.map(c => chip(c.name, state.categoryFilter === c.id, `data-cat="${c.id}"`)).join('')}
      ${hasUncategorized ? chip('Ohne Kategorie', state.categoryFilter === 'none', 'data-cat="none"') : ''}
    </div>
    <div id="list">${listHtml()}</div>
    <button class="fab primary" id="new">+ Produkt</button>
  `;

  const search = app.querySelector('.search');
  search.addEventListener('input', () => {
    state.search = search.value;
    app.querySelector('#list').innerHTML = listHtml(); // nur Liste neu, Fokus bleibt im Suchfeld
  });
  app.querySelectorAll('[data-loc]').forEach(b => b.addEventListener('click', () => {
    state.locationFilter = b.dataset.loc ? Number(b.dataset.loc) : null;
    render();
  }));
  app.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.cat;
    state.categoryFilter = v === '' ? null : v === 'none' ? 'none' : Number(v);
    render();
  }));
  app.querySelector('#list').addEventListener('click', e => {
    const row = e.target.closest('.product');
    if (row) openDetail(Number(row.dataset.id));
  });
  app.querySelector('#new').addEventListener('click', () => {
    state.view = 'new';
    state.error = null;
    render();
  });
  app.querySelector('#manage').addEventListener('click', () => {
    state.view = 'manage';
    state.error = null;
    render();
  });
  app.querySelector('#log').addEventListener('click', () => openLog());
}

/* ---------- Bewegungsprotokoll ---------- */

function logUrl() {
  return `api/movements?limit=200${state.logProductId ? `&product_id=${state.logProductId}` : ''}`;
}

async function openLog(productId = null) {
  state.logProductId = productId;
  state.view = 'log';
  await run(async () => { state.movements = await api(logUrl()); });
}

function movementRow(m) {
  const qty = `${m.delta > 0 ? '+' : '−'}${fmt(Math.abs(m.delta))} ${esc(m.unit || '')}`;
  return `
    <div class="card row ${m.undone_at ? 'undone' : ''}">
      <div>
        <div><b>${esc(m.product_name || '(gelöschtes Produkt)')}</b> · ${esc(m.location_name || '(gelöschter Standort)')}</div>
        <div class="muted">${fmtDateTime(m.created_at)} · ${esc(m.reason || '')}${m.undone_at ? ' · rückgängig gemacht' : ''}</div>
      </div>
      <div class="actions">
        <span class="qty ${m.delta > 0 ? 'in' : 'out'}">${qty}</span>
        ${m.undoable ? `<button data-undo="${m.id}">Rückgängig</button>` : ''}
      </div>
    </div>`;
}

function renderLog() {
  const first = state.logProductId ? state.movements[0] : null;
  app.innerHTML = `
    <button class="link" id="back">‹ Zurück</button>
    <h1>Protokoll${first ? ` – ${esc(first.product_name)}` : ''}</h1>
    ${errorBox()}
    ${state.movements.length ? state.movements.map(movementRow).join('') : '<p class="muted">Noch keine Bewegungen.</p>'}
  `;
  app.querySelector('#back').addEventListener('click', () => {
    // Bestand kann sich durch Undo geändert haben, daher Detail neu laden
    if (state.logProductId) return openDetail(state.logProductId);
    backToList();
  });
  app.querySelectorAll('[data-undo]').forEach(b => b.addEventListener('click', () => {
    const m = state.movements.find(x => x.id === Number(b.dataset.undo));
    if (!confirm(`${m.reason} von ${fmt(Math.abs(m.delta))} ${m.unit || ''} „${m.product_name}“ rückgängig machen?`)) return;
    run(async () => {
      await api(`api/movements/${m.id}/undo`, { method: 'POST' });
      state.movements = await api(logUrl());
    });
  }));
}

/* ---------- Verwaltung: Standorte & Kategorien ---------- */

function manageSection(title, kind, items, hint) {
  return `
    <h2>${title}</h2>
    ${hint ? `<p class="muted" style="margin:0 4px 8px">${hint}</p>` : ''}
    ${items.map(i => `
      <div class="card row" data-kind="${kind}" data-id="${i.id}">
        <input class="grow" value="${esc(i.name)}" aria-label="Name" />
        <span class="actions">
          <button data-rename>Speichern</button>
          <button data-delete class="danger">Löschen</button>
        </span>
      </div>`).join('')}
    <div class="card row" data-kind="${kind}" data-new>
      <input class="grow" placeholder="Neu hinzufügen…" aria-label="Neuer Name" />
      <span class="actions"><button class="primary" data-add>Hinzufügen</button></span>
    </div>`;
}

function renderManage() {
  app.innerHTML = `
    <button class="link" id="back">‹ Zurück</button>
    <h1>Verwaltung</h1>
    ${errorBox()}
    ${manageSection('Standorte (Truhen)', 'locations', state.locations, 'Ein Standort mit Bestand kann nicht gelöscht werden.')}
    ${manageSection('Kategorien', 'categories', state.categories, 'Beim Löschen landen die Produkte unter „Ohne Kategorie“.')}
  `;
  app.querySelector('#back').addEventListener('click', backToList);

  app.querySelectorAll('[data-kind]').forEach(card => {
    const kind = card.dataset.kind;
    const id = card.dataset.id;
    const input = card.querySelector('input');
    const reload = async () => { await loadAll(); };

    const add = card.querySelector('[data-add]');
    if (add) {
      const doAdd = () => run(async () => {
        await api(`api/${kind}`, { body: { name: input.value } });
        await reload();
      });
      add.addEventListener('click', doAdd);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
      return;
    }

    const save = () => run(async () => {
      await api(`api/${kind}/${id}`, { method: 'PUT', body: { name: input.value } });
      await reload();
    });
    card.querySelector('[data-rename]').addEventListener('click', save);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    card.querySelector('[data-delete]').addEventListener('click', () => {
      if (!confirm(`„${input.defaultValue}“ wirklich löschen?`)) return;
      run(async () => {
        await api(`api/${kind}/${id}`, { method: 'DELETE' });
        // gefilterte Kategorie/Standort gibt es evtl. nicht mehr
        if (state.locationFilter === Number(id) && kind === 'locations') state.locationFilter = null;
        if (state.categoryFilter === Number(id) && kind === 'categories') state.categoryFilter = null;
        await reload();
      });
    });
  });
}

/* ---------- Produktdetail ---------- */

async function openDetail(id) {
  state.view = 'detail';
  state.addingLocation = false;
  state.step = 1;
  await run(async () => { state.detail = await api(`api/products/${id}`); });
}

function backToList() {
  state.view = 'list';
  state.detail = null;
  state.error = null;
  run(loadAll);
}

// Bestandseinträge je Standort zusammenfassen (nur Standorte mit Bestand > 0)
function stockByLocation(product) {
  const map = new Map();
  product.stock.forEach(s => {
    const g = map.get(s.location_id) || { location_id: s.location_id, location_name: s.location_name, quantity: 0, entries: [] };
    g.quantity += s.quantity;
    g.entries.push(s);
    map.set(s.location_id, g);
  });
  return [...map.values()];
}

function renderDetail() {
  const p = state.detail;
  const groups = stockByLocation(p);
  const usedIds = new Set(groups.map(g => g.location_id));
  const freeLocations = state.locations.filter(l => !usedIds.has(l.id));

  app.innerHTML = `
    <button class="link" id="back">‹ Zurück</button>
    <h1>${esc(p.name)}</h1>
    <div class="muted" style="margin:-8px 0 12px">${esc(p.category_name || 'Ohne Kategorie')} · gesamt <b>${fmt(p.total)} ${esc(p.unit)}</b></div>
    ${errorBox()}

    <div class="card row">
      <span>Menge pro Klick</span>
      <input id="step" type="number" min="0.001" step="any" value="${state.step}" style="width:90px" />
    </div>

    ${groups.length ? groups.map(g => `
      <div class="card">
        <div class="row">
          <div>
            <div>${esc(g.location_name)}</div>
            <div class="muted">${g.entries.filter(e => e.best_before).map(e => `MHD ${fmtDate(e.best_before)} (${fmt(e.quantity)})`).join(' · ')}</div>
          </div>
          <div class="stepper">
            <button data-out="${g.location_id}" aria-label="Entnehmen">−</button>
            <span class="value">${fmt(g.quantity)} ${esc(p.unit)}</span>
            <button data-in="${g.location_id}" aria-label="Einlagern">+</button>
          </div>
        </div>
      </div>`).join('') : '<p class="muted">Aktuell an keinem Standort vorrätig.</p>'}

    ${state.addingLocation ? `
      <div class="card form" id="add-form">
        <label>Standort
          <select name="location_id">
            ${freeLocations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}
          </select>
        </label>
        <label>Menge (${esc(p.unit)})
          <input name="quantity" type="number" min="0.001" step="any" value="${state.step}" />
        </label>
        <label>MHD (optional)
          <input name="best_before" type="date" />
        </label>
        <label>Notiz (optional)
          <input name="note" type="text" />
        </label>
        <div class="row">
          <button id="add-cancel">Abbrechen</button>
          <button class="primary" id="add-save">Einlagern</button>
        </div>
      </div>
    ` : freeLocations.length ? `<button id="add-loc" style="width:100%">+ Weiterer Standort</button>` : ''}
    <p><button class="link" id="detail-log">Protokoll dieses Produkts</button></p>
  `;

  app.querySelector('#back').addEventListener('click', backToList);
  app.querySelector('#detail-log').addEventListener('click', () => openLog(p.id));
  const stepInput = app.querySelector('#step');
  stepInput.addEventListener('change', () => {
    const v = Number(stepInput.value);
    state.step = v > 0 ? v : 1;
  });

  app.querySelectorAll('[data-in]').forEach(b => b.addEventListener('click', () => run(async () => {
    state.detail = await api(`api/products/${p.id}/stock-in`, { body: { location_id: Number(b.dataset.in), quantity: state.step } });
  })));
  app.querySelectorAll('[data-out]').forEach(b => b.addEventListener('click', () => run(async () => {
    state.detail = await api(`api/products/${p.id}/stock-out`, { body: { location_id: Number(b.dataset.out), quantity: state.step } });
  })));

  const addLoc = app.querySelector('#add-loc');
  if (addLoc) addLoc.addEventListener('click', () => { state.addingLocation = true; render(); });

  const form = app.querySelector('#add-form');
  if (form) {
    form.querySelector('#add-cancel').addEventListener('click', () => { state.addingLocation = false; render(); });
    form.querySelector('#add-save').addEventListener('click', () => run(async () => {
      const val = n => form.querySelector(`[name="${n}"]`).value;
      state.detail = await api(`api/products/${p.id}/stock-in`, {
        body: {
          location_id: Number(val('location_id')),
          quantity: Number(val('quantity')),
          best_before: val('best_before') || null,
          note: val('note').trim() || null
        }
      });
      state.addingLocation = false;
    }));
  }
}

/* ---------- Neues Produkt ---------- */

function renderNew() {
  app.innerHTML = `
    <button class="link" id="back">‹ Zurück</button>
    <h1>Neues Produkt</h1>
    ${errorBox()}
    <div class="card form" id="new-form">
      <label>Name
        <input name="name" type="text" autofocus />
      </label>
      <label>Einheit
        <input name="unit" type="text" value="Stk" list="units" />
        <datalist id="units"><option value="Stk"><option value="kg"><option value="g"><option value="Pkg"><option value="Beutel"><option value="Portion"></datalist>
      </label>
      <label>Kategorie
        <select name="category_id">
          <option value="">Ohne Kategorie</option>
          ${state.categories.map(c => `<option value="${c.id}" ${state.categoryFilter === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </label>
      <button class="primary" id="save">Anlegen</button>
    </div>
  `;
  app.querySelector('#back').addEventListener('click', backToList);
  const form = app.querySelector('#new-form');
  form.querySelector('#save').addEventListener('click', () => run(async () => {
    const val = n => form.querySelector(`[name="${n}"]`).value;
    const product = await api('api/products', {
      body: { name: val('name'), unit: val('unit'), category_id: val('category_id') ? Number(val('category_id')) : null }
    });
    await loadAll();
    // Direkt ins Detail, um gleich einlagern zu können
    state.view = 'detail';
    state.detail = product;
    state.addingLocation = true;
  }));
}

/* ---------- Start ---------- */

async function init() {
  app.innerHTML = 'Lädt…';
  await loadAll();
  render();
}

init().catch(err => { app.innerHTML = '<p>Fehler: ' + esc(err.message) + '</p>'; });
