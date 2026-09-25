const app = document.getElementById('app');

// UUID v4 (getRandomValues gibt es auch über http, randomUUID nur in sicheren Kontexten)
function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Vorgangs-IDs: Jede schreibende Aktion trägt eine eindeutige ID. Solange das Ergebnis UNBEKANNT ist (Timeout,
// Verbindungsabbruch, 502/503/504 von Home Assistant), bleibt die ID für dieselbe Anfrage erhalten – ein erneutes
// Tippen führt sie dann höchstens einmal aus. Nach einer klaren Antwort wird die ID verworfen.
// Im sessionStorage, damit das auch nach einem Neuladen der Seite gilt.
const pendingKeys = (() => {
  try { return new Map(JSON.parse(sessionStorage.getItem('pendingKeys') || '[]')); } catch (e) { return new Map(); }
})();
function savePendingKeys() {
  try { sessionStorage.setItem('pendingKeys', JSON.stringify([...pendingKeys].slice(-50))); } catch (e) { /* ohne Speicher weiter */ }
}

const UNKNOWN_OUTCOME = [408, 502, 503, 504];

// Relative Pfade (ohne führenden "/"), damit alles auch hinter HA-Ingress
// unter /api/hassio_ingress/<token>/ funktioniert.
async function api(path, opts = {}) {
  const hasBody = opts.body !== undefined && typeof opts.body !== 'string';
  const method = (opts.method || (hasBody ? 'POST' : 'GET')).toUpperCase();
  const init = { ...opts, method, headers: { ...(opts.headers || {}) } };
  if (hasBody) {
    init.body = JSON.stringify(opts.body);
    init.headers['Content-Type'] = 'application/json';
  }

  let signature = null;
  if (method !== 'GET') {
    signature = `${method} ${path} ${init.body || ''}`;
    if (!pendingKeys.has(signature)) pendingKeys.set(signature, newId());
    init.headers['Idempotency-Key'] = pendingKeys.get(signature);
    savePendingKeys();
  }
  const done = () => { if (signature) { pendingKeys.delete(signature); savePendingKeys(); } };

  const controller = new AbortController();
  init.signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), window.API_TIMEOUT_MS || 30000);
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    // Ergebnis unbekannt: ID behalten, damit ein erneutes Tippen nichts doppelt ausführt
    const err = new Error(method === 'GET'
      ? 'Keine Antwort vom Server – bitte erneut versuchen.'
      : 'Keine Antwort vom Server – bitte erneut tippen. Es wird nichts doppelt gebucht oder angelegt.');
    err.unknownOutcome = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await res.json(); } catch (e) { /* kein JSON */ }
  if (UNKNOWN_OUTCOME.includes(res.status)) {
    const err = new Error('Home Assistant antwortet gerade nicht (Fehler ' + res.status + ') – bitte erneut tippen. Es wird nichts doppelt gebucht oder angelegt.');
    err.unknownOutcome = true;
    throw err;
  }
  done();
  if (!res.ok) {
    const err = new Error((data && data.error) || `Fehler ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const state = {
  products: [],
  categories: [],
  locations: [],
  search: '',
  locationFilter: null, // location_id oder null = alle
  categoryFilter: null, // category_id, 'none' oder null = alle
  view: 'list',         // 'list' | 'detail' | 'new' | 'manage' | 'log' | 'inventory'
  inventoryLocationId: null,
  notice: null,         // einmalige Erfolgsmeldung in der Übersicht
  movements: [],        // Bewegungsprotokoll
  logProductId: null,   // Protokoll auf ein Produkt einschränken
  detail: null,         // Produkt inkl. stock-Einträgen
  step: 1,              // Menge pro Plus/Minus im Detail
  warnDays: 7,          // MHD-Warnschwelle (Add-on-Option)
  mhdOnly: false,       // Übersicht auf Produkte mit MHD-Warnung beschränken
  lowOnly: false,       // Übersicht auf Produkte unter Mindestbestand beschränken
  addingLocation: false,
  transfer: null,       // { from: location_id } solange das Umlagern-Formular offen ist
  error: null,
  errorData: null,      // Zusatzdaten zur Fehlermeldung (z. B. existing_product_id)
  busy: false,          // true, solange eine Anfrage läuft
  newDraft: null,       // Eingaben im Formular „Neues Produkt“ (bleiben nach einem Fehler erhalten)
  editOpen: false,      // Bereich „Artikel bearbeiten/zusammenführen/löschen“ im Detail aufgeklappt
  dupKeys: new Set(),   // Namensschlüssel, die mehrfach vorkommen (doppelte Artikel)
  dupOnly: false        // Übersicht auf doppelte Artikel beschränken
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

// Einlagerdatum (SQLite-UTC-Zeitstempel) als lokales Datum
function fmtStoredDate(sqlUtc) {
  return new Date(sqlUtc.replace(' ', 'T') + 'Z').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function agoText(sqlUtc) {
  const d = new Date(sqlUtc.replace(' ', 'T') + 'Z');
  const now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days <= 0) return 'heute';
  return days === 1 ? 'gestern' : `vor ${days} Tagen`;
}

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-');
  return `${day}.${m}.${y}`;
}

/* ---------- MHD ---------- */

// Tage bis zum MHD (negativ = abgelaufen), gerechnet in lokaler Zeit
function daysUntil(dateStr) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(y, m - 1, d) - today) / 86400000);
}

function mhdStatus(dateStr) {
  if (!dateStr) return null;
  const days = daysUntil(dateStr);
  if (days < 0) return 'expired';
  return days <= state.warnDays ? 'soon' : null;
}

function mhdText(dateStr) {
  const days = daysUntil(dateStr);
  if (days < 0) return `abgelaufen seit ${-days} ${-days === 1 ? 'Tag' : 'Tagen'}`;
  if (days === 0) return 'läuft heute ab';
  return `noch ${days} ${days === 1 ? 'Tag' : 'Tage'}`;
}

function mhdBadge(dateStr) {
  const status = mhdStatus(dateStr);
  return status ? `<span class="badge ${status}">MHD ${fmtDate(dateStr)} · ${mhdText(dateStr)}</span>` : '';
}

// Frühestes MHD eines Produkts; mit aktivem Standortfilter nur an diesem Standort
function productMhd(p) {
  if (state.locationFilter === null) return p.next_best_before;
  const s = p.stock.find(x => x.location_id === state.locationFilter);
  return s ? s.next_best_before : null;
}

/* ---------- Doppelte Artikel ---------- */

const nameKeyOf = n => String(n ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('de-DE');

function findDuplicateKeys(products) {
  const counts = new Map();
  products.forEach(p => counts.set(nameKeyOf(p.name), (counts.get(nameKeyOf(p.name)) || 0) + 1));
  return new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k));
}

const isDup = p => state.dupKeys.has(nameKeyOf(p.name));
const dupBadge = p => isDup(p) ? '<span class="badge expired">Doppelt vorhanden</span>' : '';

function dupBanner() {
  const n = state.dupKeys.size;
  if (!n && !state.dupOnly) return '';
  const label = n ? `${n} ${n === 1 ? 'Artikelname ist' : 'Artikelnamen sind'} mehrfach vorhanden` : 'Keine doppelten Artikel';
  return `<button class="banner expired ${state.dupOnly ? 'active' : ''}" id="dups">
    ⚠ Doppelte Artikel: ${label} <span class="muted">${state.dupOnly ? '– alle anzeigen' : '– nur diese anzeigen, dann zusammenführen'}</span></button>`;
}

/* ---------- Mindestbestand ---------- */

// Gesamtbestand über alle Truhen liegt unter dem hinterlegten Mindestbestand (0 Bestand zählt mit)
function isLow(p) {
  return p.min_stock > 0 && p.total < p.min_stock;
}

function lowBadge(p) {
  return isLow(p) ? `<span class="badge low">Unter Mindestbestand: ${fmt(p.total)} von ${fmt(p.min_stock)} ${esc(p.unit)}</span>` : '';
}

function noticeBox() {
  const html = state.notice ? `<div class="notice">${esc(state.notice)}</div>` : '';
  state.notice = null; // wird nur einmal angezeigt
  return html;
}

function errorBox() {
  if (!state.error) return '';
  // Artikel gibt es schon (409): direkt zum vorhandenen springen
  const existing = state.errorData && state.errorData.existing_product_id;
  return `<div class="error">${esc(state.error)}${existing ? ` <button type="button" data-open-existing="${existing}">Vorhandenen Artikel öffnen</button>` : ''}</div>`;
}

// Führt eine Aktion aus. Solange eine Anfrage läuft, sind alle Bedienelemente gesperrt (kein Doppelklick).
async function run(fn) {
  if (state.busy) return;
  state.busy = true;
  setBusyUi(true);
  try {
    state.error = null;
    state.errorData = null;
    await fn();
  } catch (err) {
    state.error = err.message;
    state.errorData = err.data || null;
  } finally {
    state.busy = false;
    setBusyUi(false);
  }
  render();
}

// Zuletzt angeklickter Button (Fokus ist unzuverlässig: Safari/iOS fokussieren Buttons beim Tippen oft nicht)
let lastClickedButton = null;
app.addEventListener('click', e => { lastClickedButton = e.target.closest('button'); }, true);

function setBusyUi(on) {
  document.body.classList.toggle('busy', on);
  if (!on) return;
  const b = lastClickedButton;
  if (b && b.isConnected && b.matches('button:not([aria-label]):not(.chip):not(.link)')) b.textContent = 'Speichert…';
  app.querySelectorAll('button, input, select').forEach(el => { el.disabled = true; });
}

async function loadAll() {
  const [products, categories, locations, settings] = await Promise.all([
    api('api/products'), api('api/categories'), api('api/locations'), api('api/settings')
  ]);
  Object.assign(state, { products, categories, locations, warnDays: settings.mhd_warn_days });
  state.dupKeys = findDuplicateKeys(products);
  if (!state.dupKeys.size) state.dupOnly = false;
}

function render() {
  app.dataset.view = state.view; // CSS wählt danach die Spaltenbreite
  if (state.view === 'detail' && state.detail) return renderDetail();
  if (state.view === 'new') return renderNew();
  if (state.view === 'manage') return renderManage();
  if (state.view === 'log') return renderLog();
  if (state.view === 'inventory') return renderInventory();
  renderList();
}

/* ---------- Übersicht ---------- */

function filteredProducts() {
  const q = state.search.trim().toLowerCase();
  return state.products
    .filter(p => !q || p.name.toLowerCase().includes(q) || (p.notes || []).some(n => n.toLowerCase().includes(q)))
    .filter(p => {
      if (state.categoryFilter === null) return true;
      if (state.categoryFilter === 'none') return !p.category_id;
      return p.category_id === state.categoryFilter;
    })
    .filter(p => state.locationFilter === null || p.stock.some(s => s.location_id === state.locationFilter))
    .filter(p => !state.mhdOnly || mhdStatus(productMhd(p)))
    .filter(p => !state.lowOnly || isLow(p))
    .filter(p => !state.dupOnly || isDup(p));
}

function productQty(p) {
  if (state.locationFilter === null) return p.total;
  const s = p.stock.find(x => x.location_id === state.locationFilter);
  return s ? s.quantity : 0;
}

// Zusatzzeile in der Übersicht: seit wann der Bestand liegt und die Notizen (gekürzt); mit Standortfilter nur dieser Standort
function productInfoLine(p) {
  const scope = state.locationFilter === null ? p : p.stock.find(x => x.location_id === state.locationFilter);
  if (!scope || !scope.oldest_stored_at) return '';
  const parts = [`seit ${fmtStoredDate(scope.oldest_stored_at)}`];
  const full = (scope.notes || []).join(' / ');
  if (full) parts.push(`Notiz: ${esc(full.length > 60 ? full.slice(0, 57) + '…' : full)}`);
  return `<div class="muted info" ${full ? `title="${esc(full)}"` : ''}>${parts.join(' · ')}</div>`;
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
        ${productInfoLine(p)}
        ${mhdBadge(productMhd(p))} ${lowBadge(p)} ${dupBadge(p)}
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

// Hinweisband: Anzahl Produkte mit abgelaufenem bzw. bald ablaufendem MHD (Standortfilter zählt mit)
function mhdBanner() {
  const inScope = state.products.filter(p => state.locationFilter === null || p.stock.some(s => s.location_id === state.locationFilter));
  const expired = inScope.filter(p => mhdStatus(productMhd(p)) === 'expired').length;
  const soon = inScope.filter(p => mhdStatus(productMhd(p)) === 'soon').length;
  if (!expired && !soon && !state.mhdOnly) return '';
  const parts = [];
  if (expired) parts.push(`${expired} abgelaufen`);
  if (soon) parts.push(`${soon} in den nächsten ${state.warnDays} Tagen`);
  const label = parts.length ? parts.join(' · ') : 'Keine MHD-Warnungen';
  return `<button class="banner ${expired ? 'expired' : 'soon'} ${state.mhdOnly ? 'active' : ''}" id="mhd">
    ⚠ MHD: ${label} <span class="muted">${state.mhdOnly ? '– alle anzeigen' : '– nur diese anzeigen'}</span></button>`;
}

// Hinweisband: Produkte unter Mindestbestand (unabhängig vom Standortfilter, da der Gesamtbestand zählt)
function lowBanner() {
  const count = state.products.filter(isLow).length;
  if (!count && !state.lowOnly) return '';
  const label = count ? `${count} ${count === 1 ? 'Produkt' : 'Produkte'} unter Mindestbestand` : 'Nichts unter Mindestbestand';
  return `<button class="banner low ${state.lowOnly ? 'active' : ''}" id="low">
    ⚠ Bestand: ${label} <span class="muted">${state.lowOnly ? '– alle anzeigen' : '– nur diese anzeigen'}</span></button>`;
}

function renderList() {
  const hasUncategorized = state.products.some(p => !p.category_id);
  app.innerHTML = `
    <div class="row"><h1>Kühltruhen</h1><span class="actions"><button id="log">Protokoll</button><button id="manage" aria-label="Verwaltung">⚙ Verwalten</button></span></div>
    ${errorBox()}
    ${noticeBox()}
    ${dupBanner()}
    ${mhdBanner()}
    ${lowBanner()}
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
    ${state.locationFilter !== null ? `<button id="inv" style="width:100%;margin:4px 0 8px">Inventur für „${esc(state.locations.find(l => l.id === state.locationFilter).name)}“ starten</button>` : ''}
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
  const mhd = app.querySelector('#mhd');
  if (mhd) mhd.addEventListener('click', () => { state.mhdOnly = !state.mhdOnly; render(); });
  const dups = app.querySelector('#dups');
  if (dups) dups.addEventListener('click', () => { state.dupOnly = !state.dupOnly; render(); });
  const low = app.querySelector('#low');
  if (low) low.addEventListener('click', () => { state.lowOnly = !state.lowOnly; render(); });
  const inv = app.querySelector('#inv');
  if (inv) inv.addEventListener('click', () => openInventory(state.locationFilter));
}

/* ---------- Inventur ---------- */

async function openInventory(locationId) {
  if (state.busy) return;
  state.inventoryLocationId = locationId;
  state.view = 'inventory';
  await run(loadAll); // aktuellen Sollbestand holen
}

function renderInventory() {
  const loc = state.locations.find(l => l.id === state.inventoryLocationId);
  if (!loc) return backToList();
  const currentAt = p => (p.stock.find(s => s.location_id === loc.id) || { quantity: 0 }).quantity;
  const inHere = state.products.filter(p => currentAt(p) > 0);
  const others = state.products.filter(p => currentAt(p) <= 0);

  const row = (p, prefill) => `
    <div class="card row inv-row" data-pid="${p.id}" data-current="${currentAt(p)}" data-name="${esc(p.name.toLowerCase())}">
      <div>
        <div>${esc(p.name)}</div>
        <div class="muted">Soll: ${fmt(currentAt(p))} ${esc(p.unit)} <span class="inv-diff"></span></div>
      </div>
      <input class="inv-input" type="number" inputmode="decimal" min="0" step="any" ${prefill ? `value="${currentAt(p)}"` : 'placeholder="–"'} aria-label="Gezählt: ${esc(p.name)}" />
    </div>`;

  app.innerHTML = `
    <button class="link" id="back">‹ Abbrechen</button>
    <h1>Inventur – ${esc(loc.name)}</h1>
    <p class="muted" style="margin:-6px 0 10px">Tatsächlich gezählte Mengen eintragen. Leer lassen = nicht gezählt, 0 = nichts mehr da. Gebucht werden nur Abweichungen.</p>
    ${errorBox()}
    <input class="search" id="inv-search" type="search" placeholder="Produkt suchen…" />
    ${inHere.length ? inHere.map(p => row(p, true)).join('') : '<p class="muted">An diesem Standort ist aktuell nichts erfasst.</p>'}
    ${others.length ? `<details id="inv-others"><summary>Weitere Produkte (${others.length}) – hier gefunden, aber nicht erfasst</summary>${others.map(p => row(p, false)).join('')}</details>` : ''}
    <div class="inv-bar"><button class="primary" id="inv-save" disabled>Keine Änderungen</button></div>
  `;

  const rows = () => [...app.querySelectorAll('.inv-row')];
  const parsed = r => {
    const v = r.querySelector('.inv-input').value.trim();
    return v === '' ? null : Number(v);
  };
  // Nur Zeilen mit Abweichung zum Sollbestand
  const changes = () => rows().flatMap(r => {
    const v = parsed(r);
    const cur = Number(r.dataset.current);
    return v === null || !Number.isFinite(v) || Math.abs(v - cur) < 1e-9 ? [] : [{ row: r, product_id: Number(r.dataset.pid), quantity: v, diff: v - cur }];
  });

  const save = app.querySelector('#inv-save');
  const refresh = () => {
    rows().forEach(r => {
      const v = parsed(r);
      const d = v === null ? 0 : v - Number(r.dataset.current);
      const el = r.querySelector('.inv-diff');
      el.textContent = Math.abs(d) < 1e-9 ? '' : `→ ${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}`;
      el.className = 'inv-diff ' + (d > 0 ? 'in' : 'out');
    });
    const n = changes().length;
    save.disabled = n === 0;
    save.textContent = n ? `Inventur speichern (${n} ${n === 1 ? 'Änderung' : 'Änderungen'})` : 'Keine Änderungen';
  };
  app.querySelectorAll('.inv-input').forEach(i => i.addEventListener('input', refresh));

  app.querySelector('#inv-search').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    rows().forEach(r => { r.hidden = !!q && !r.dataset.name.includes(q); });
    const others = app.querySelector('#inv-others');
    if (others && q) others.open = true;
  });

  app.querySelector('#back').addEventListener('click', backToList);
  save.addEventListener('click', () => {
    const list = changes();
    if (!list.length || !confirm(`${list.length} Abweichung(en) in „${loc.name}“ als Inventur buchen?`)) return;
    run(async () => {
      const res = await api(`api/locations/${loc.id}/inventory`, {
        body: { counts: list.map(c => ({ product_id: c.product_id, quantity: c.quantity })) }
      });
      state.notice = `Inventur ${loc.name}: ${res.changes.length} Änderung(en) gebucht.`;
      state.view = 'list';
      state.locationFilter = loc.id;
      await loadAll();
    });
  });
  refresh();
}

/* ---------- Bewegungsprotokoll ---------- */

function logUrl() {
  return `api/movements?limit=200${state.logProductId ? `&product_id=${state.logProductId}` : ''}`;
}

async function openLog(productId = null) {
  if (state.busy) return;
  state.logProductId = productId;
  state.view = 'log';
  await run(async () => { state.movements = await api(logUrl()); });
}

function movementRow(m) {
  const isMove = !!m.transfer_id; // Umlagerung: eine Zeile mit Quelle → Ziel
  const gone = '(gelöschter Standort)';
  const qty = isMove
    ? `⇄ ${fmt(Math.abs(m.delta))} ${esc(m.unit || '')}`
    : `${m.delta > 0 ? '+' : '−'}${fmt(Math.abs(m.delta))} ${esc(m.unit || '')}`;
  const where = isMove
    ? `${esc(m.location_name || gone)} → ${esc(m.to_location_name || gone)}`
    : esc(m.location_name || gone);
  return `
    <div class="card row ${m.undone_at ? 'undone' : ''}">
      <div>
        <div><b>${esc(m.product_name || '(gelöschtes Produkt)')}</b> · ${where}</div>
        <div class="muted">${fmtDateTime(m.created_at)} · ${esc(m.reason || '')}${m.undone_at ? ' · rückgängig gemacht' : ''}</div>
      </div>
      <div class="actions">
        <span class="qty ${isMove ? 'move' : m.delta > 0 ? 'in' : 'out'}">${qty}</span>
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
  if (state.busy) return;
  state.view = 'detail';
  state.addingLocation = false;
  state.transfer = null;
  state.editOpen = false;
  state.step = 1;
  await run(async () => { state.detail = await api(`api/products/${id}`); });
}

function backToList() {
  state.newDraft = null;
  state.view = 'list';
  state.detail = null;
  state.transfer = null;
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

// Formular zum Umlagern eines Standort-Bestands in eine andere Truhe
function moveForm(p, g) {
  const targets = state.locations.filter(l => l.id !== g.location_id);
  return `
    <div class="form" id="move-form" data-max="${g.quantity}" style="margin-top:.75rem">
      <label>Umlagern nach
        <select name="to">${targets.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
      </label>
      <label>Menge (${esc(p.unit)}, max. ${fmt(g.quantity)})
        <span class="row">
          <input class="grow" name="quantity" type="number" inputmode="decimal" min="0.001" max="${g.quantity}" step="any" value="${Math.min(state.step, g.quantity)}" />
          <button type="button" id="move-all">Alles</button>
        </span>
      </label>
      <div class="row">
        <button id="move-cancel">Abbrechen</button>
        <button class="primary" id="move-save">Umlagern</button>
      </div>
    </div>`;
}

// Kandidaten zum Zusammenführen: gleiche Einheit (sonst lehnt der Server ab), gleichnamige zuerst
function mergeCandidates(p) {
  const sameUnit = o => o.unit.trim().toLocaleLowerCase('de-DE') === p.unit.trim().toLocaleLowerCase('de-DE');
  return state.products
    .filter(o => o.id !== p.id && sameUnit(o))
    .sort((a, b) => (nameKeyOf(b.name) === nameKeyOf(p.name)) - (nameKeyOf(a.name) === nameKeyOf(p.name)) || a.name.localeCompare(b.name, 'de'));
}

function manageProductHtml(p) {
  const candidates = mergeCandidates(p);
  return `
    <details class="card" id="manage-product" ${state.editOpen ? 'open' : ''}>
      <summary>Artikel bearbeiten, zusammenführen, löschen</summary>

      <div class="form" id="edit-form">
        <b>Bearbeiten</b>
        <label>Name
          <input name="name" type="text" value="${esc(p.name)}" />
        </label>
        <label>Einheit
          <input name="unit" type="text" value="${esc(p.unit)}" list="units-edit" />
          <datalist id="units-edit"><option value="Stk"><option value="kg"><option value="g"><option value="Pkg"><option value="Beutel"><option value="Portion"></datalist>
        </label>
        <label>Kategorie
          <select name="category_id">
            <option value="">Ohne Kategorie</option>
            ${state.categories.map(c => `<option value="${c.id}" ${p.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </label>
        <button class="primary" id="edit-save">Änderungen speichern</button>
      </div>

      <div class="form" id="merge-form">
        <b>Mit anderem Artikel zusammenführen</b>
        <p class="muted">Bestand und Protokoll dieses Artikels wandern in den gewählten Artikel, dieser Artikel wird danach gelöscht. Nur bei gleicher Einheit möglich.</p>
        ${candidates.length ? `
          <label>Zusammenführen in
            <select name="into">
              ${candidates.map(o => `<option value="${o.id}">${nameKeyOf(o.name) === nameKeyOf(p.name) ? '★ ' : ''}${esc(o.name)} · ${fmt(o.total)} ${esc(o.unit)} · Nr. ${o.id}</option>`).join('')}
            </select>
          </label>
          <button id="merge-save">Zusammenführen</button>` : `<p class="muted">Kein anderer Artikel mit der Einheit „${esc(p.unit)}“ vorhanden.</p>`}
      </div>

      <div class="form" id="delete-form">
        <b>Löschen</b>
        <p class="muted">Löscht den Artikel endgültig – mit Bestand und Protokoll. Vorher wird automatisch eine Sicherung angelegt.</p>
        <button class="danger" id="delete-product">Artikel endgültig löschen</button>
      </div>
    </details>`;
}

// Ein Bestandseintrag im Detail: Menge, MHD, Einlagerdatum und Notiz
function entryLine(e, unit) {
  const status = mhdStatus(e.best_before);
  const parts = [`<b>${fmt(e.quantity)} ${esc(unit)}</b>`];
  if (e.best_before) {
    parts.push(`<span class="${status ? 'mhd-' + status : ''}">MHD ${fmtDate(e.best_before)} (${mhdText(e.best_before)})</span>`);
  }
  if (e.stored_at) parts.push(`eingelagert ${fmtStoredDate(e.stored_at)} (${agoText(e.stored_at)})`);
  return `<li class="entry">${parts.join(' · ')}${e.note ? `<div class="entry-note">Notiz: ${esc(e.note)}</div>` : ''}</li>`;
}

function renderDetail() {
  const p = state.detail;
  const groups = stockByLocation(p);
  const usedIds = new Set(groups.map(g => g.location_id));
  const freeLocations = state.locations.filter(l => !usedIds.has(l.id));

  app.innerHTML = `
    <button class="link" id="back">‹ Zurück</button>
    <h1>${esc(p.name)}</h1>
    <div class="muted" style="margin:-8px 0 12px">${esc(p.category_name || 'Ohne Kategorie')} · gesamt <b>${fmt(p.total)} ${esc(p.unit)}</b> ${lowBadge(p)} ${dupBadge(p)}</div>
    ${noticeBox()}
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
          </div>
          <div class="stepper">
            <button data-out="${g.location_id}" aria-label="Entnehmen">−</button>
            <span class="value">${fmt(g.quantity)} ${esc(p.unit)}</span>
            <button data-in="${g.location_id}" aria-label="Einlagern">+</button>
          </div>
        </div>
        <ul class="entries">${g.entries.map(e => entryLine(e, p.unit)).join('')}</ul>
        ${state.locations.length < 2 ? '' : state.transfer && state.transfer.from === g.location_id
          ? moveForm(p, g)
          : `<button class="link" data-move="${g.location_id}">⇄ In andere Truhe umlagern</button>`}
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
    <div class="card form" id="min-form">
      <label>Mindestbestand (${esc(p.unit)}) – leer lassen für keine Warnung
        <input name="min_stock" type="number" inputmode="decimal" min="0" step="any" value="${p.min_stock ?? ''}" placeholder="kein Mindestbestand" />
      </label>
      <button id="min-save">Mindestbestand speichern</button>
    </div>
    ${manageProductHtml(p)}
    <p><button class="link" id="detail-log">Protokoll dieses Produkts</button></p>
  `;

  app.querySelector('#back').addEventListener('click', backToList);
  app.querySelector('#detail-log').addEventListener('click', () => openLog(p.id));
  app.querySelector('#manage-product').addEventListener('toggle', e => { state.editOpen = e.target.open; });

  app.querySelector('#edit-save').addEventListener('click', () => {
    const form = app.querySelector('#edit-form');
    const val = n => form.querySelector(`[name="${n}"]`).value;
    const patch = {};
    if (val('name') !== p.name) patch.name = val('name');
    if (val('unit') !== p.unit) patch.unit = val('unit');
    const cat = val('category_id') ? Number(val('category_id')) : null;
    if (cat !== p.category_id) patch.category_id = cat;
    state.editOpen = true;
    if (!Object.keys(patch).length) { state.notice = 'Keine Änderungen.'; render(); return; }
    if ('unit' in patch && p.total > 0 &&
        !confirm(`Einheit von „${p.unit}“ auf „${patch.unit.trim()}“ ändern?\nDie Mengen (${fmt(p.total)}) bleiben unverändert, nur die Bezeichnung ändert sich.`)) return;
    run(async () => {
      state.detail = await api(`api/products/${p.id}`, { method: 'PUT', body: patch });
      state.notice = 'Gespeichert.';
      await loadAll();
    });
  });

  const mergeBtn = app.querySelector('#merge-save');
  if (mergeBtn) mergeBtn.addEventListener('click', () => {
    const targetId = Number(app.querySelector('#merge-form [name="into"]').value);
    const t = state.products.find(o => o.id === targetId);
    if (!t || !confirm(`„${p.name}“ (${fmt(p.total)} ${p.unit}, ${p.movement_count} Protokolleinträge) wird in „${t.name}“ (${fmt(t.total)} ${t.unit}, Nr. ${t.id}) zusammengeführt.\n\nBestand und Protokoll wandern zum Ziel, „${p.name}“ wird gelöscht.`)) return;
    run(async () => {
      const res = await api(`api/products/${p.id}/merge`, { body: { into_product_id: targetId } });
      state.detail = res.product;
      state.editOpen = false;
      state.notice = `Zusammengeführt: Bestand und Protokoll von „${p.name}“ sind jetzt bei „${res.product.name}“.`;
      await loadAll();
    });
  });

  app.querySelector('#delete-product').addEventListener('click', () => {
    const stockLine = p.total > 0 ? `Restbestand: ${fmt(p.total)} ${p.unit}\n` : '';
    if (!confirm(`„${p.name}“ endgültig löschen?\n\n${stockLine}Protokolleinträge: ${p.movement_count}\n\nDas kann nicht rückgängig gemacht werden. Vorher wird automatisch eine Sicherung angelegt.`)) return;
    run(async () => {
      await api(`api/products/${p.id}${p.total > 0 ? '?force=1' : ''}`, { method: 'DELETE' });
      state.notice = `„${p.name}“ wurde gelöscht.`;
      state.view = 'list';
      state.detail = null;
      state.transfer = null;
      await loadAll();
    });
  });
  app.querySelector('#min-save').addEventListener('click', () => run(async () => {
    const value = app.querySelector('#min-form [name="min_stock"]').value.trim();
    state.detail = await api(`api/products/${p.id}`, { method: 'PUT', body: { min_stock: value === '' ? null : Number(value) } });
  }));
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
  if (addLoc) addLoc.addEventListener('click', () => { state.addingLocation = true; state.transfer = null; render(); });

  app.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', () => {
    state.transfer = { from: Number(b.dataset.move) };
    state.addingLocation = false;
    render();
  }));
  const mf = app.querySelector('#move-form');
  if (mf) {
    const qtyInput = mf.querySelector('[name="quantity"]');
    mf.querySelector('#move-all').addEventListener('click', () => { qtyInput.value = mf.dataset.max; });
    mf.querySelector('#move-cancel').addEventListener('click', () => { state.transfer = null; render(); });
    mf.querySelector('#move-save').addEventListener('click', () => run(async () => {
      state.detail = await api(`api/products/${p.id}/transfer`, {
        body: {
          from_location_id: state.transfer.from,
          to_location_id: Number(mf.querySelector('[name="to"]').value),
          quantity: Number(qtyInput.value)
        }
      });
      state.transfer = null;
    }));
  }

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
  const d = state.newDraft || { name: '', unit: 'Stk', category_id: state.categoryFilter, min_stock: '' };
  app.innerHTML = `
    <button class="link" id="back">‹ Zurück</button>
    <h1>Neues Produkt</h1>
    ${errorBox()}
    <div class="card form" id="new-form">
      <label>Name
        <input name="name" type="text" value="${esc(d.name)}" autofocus />
      </label>
      <label>Einheit
        <input name="unit" type="text" value="${esc(d.unit)}" list="units" />
        <datalist id="units"><option value="Stk"><option value="kg"><option value="g"><option value="Pkg"><option value="Beutel"><option value="Portion"></datalist>
      </label>
      <label>Kategorie
        <select name="category_id">
          <option value="">Ohne Kategorie</option>
          ${state.categories.map(c => `<option value="${c.id}" ${d.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </label>
      <label>Mindestbestand (optional) – Warnung, wenn der Gesamtbestand darunter fällt
        <input name="min_stock" type="number" inputmode="decimal" min="0" step="any" value="${esc(d.min_stock)}" placeholder="kein Mindestbestand" />
      </label>
      <button class="primary" id="save">Anlegen</button>
    </div>
  `;
  app.querySelector('#back').addEventListener('click', backToList);
  const form = app.querySelector('#new-form');
  form.querySelector('#save').addEventListener('click', () => {
    const val = n => form.querySelector(`[name="${n}"]`).value;
    // Entwurf merken: nach einem Fehler oder Hänger sind die Eingaben noch da
    state.newDraft = { name: val('name'), unit: val('unit'), category_id: val('category_id') ? Number(val('category_id')) : null, min_stock: val('min_stock') };
    run(async () => {
    const product = await api('api/products', {
      body: {
        name: val('name'),
        unit: val('unit'),
        category_id: val('category_id') ? Number(val('category_id')) : null,
        min_stock: val('min_stock').trim() === '' ? null : Number(val('min_stock'))
      }
    });
    state.newDraft = null;
    await loadAll();
    // Direkt ins Detail, um gleich einlagern zu können
    state.view = 'detail';
    state.detail = product;
    state.addingLocation = true;
    });
  });
}

// „Vorhandenen Artikel öffnen“ in Fehlermeldungen (Artikel gibt es schon)
app.addEventListener('click', e => {
  const b = e.target.closest('[data-open-existing]');
  if (b && !state.busy) { state.newDraft = null; openDetail(Number(b.dataset.openExisting)); }
});

/* ---------- Start ---------- */

async function init() {
  app.innerHTML = 'Lädt…';
  await loadAll();
  render();
}

init().catch(err => { app.innerHTML = '<p>Fehler: ' + esc(err.message) + '</p>'; });
