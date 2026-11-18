// Estate Monitor front end. Plain ES modules, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HEALTH = ['healthy', 'warning', 'critical', 'offline'];
const HLABEL = { healthy: 'Healthy', warning: 'Warning', critical: 'Critical', offline: 'Offline' };
const OEM_SHORT = { 'poly-lens': 'PL', 'logitech-sync': 'LS', 'zoom-rooms': 'ZR', 'webex-control-hub': 'WX', 'teams-rooms': 'TR', 'google-meet-hardware': 'GM' };
const OEM_NAME = { 'poly-lens': 'Poly Lens', 'logitech-sync': 'Logitech Sync', 'zoom-rooms': 'Zoom Rooms', 'webex-control-hub': 'Webex Control Hub', 'teams-rooms': 'Teams Rooms', 'google-meet-hardware': 'Google Meet hardware' };
const FILTER_KEYS = [
  ['customer', 'Customer'], ['region', 'Region'], ['site', 'Site'], ['platform', 'Platform'],
  ['oem', 'OEM'], ['deviceType', 'Device type'], ['health', 'Health'],
];

const ICONS = {
  healthy: '<svg class="ic" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#0ca30c"/><path d="M4.8 8.2l2.1 2.1 4.3-4.6" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warning: '<svg class="ic" viewBox="0 0 16 16"><path d="M8 1.5l7 12.5H1z" fill="#fab219" stroke="#fab219" stroke-linejoin="round"/><path d="M8 6v3.6" stroke="#0b0b0b" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.8" r="1" fill="#0b0b0b"/></svg>',
  critical: '<svg class="ic" viewBox="0 0 16 16"><path d="M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1z" fill="#d03b3b"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
  offline: '<svg class="ic" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#7d8399"/><path d="M4.5 8h7" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
  resolved: '<svg class="ic" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#0ca30c" stroke-width="1.6"/><path d="M4.8 8.2l2.1 2.1 4.3-4.6" stroke="#0ca30c" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sync: '<svg class="ic" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#1a5cff"/><path d="M5 6.5a3.3 3.3 0 0 1 6-.6M11 9.5a3.3 3.3 0 0 1-6 .6" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
  chevron: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 4.5l3 3 3-3" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>',
  search: '<svg width="15" height="15" viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" stroke="#7d849e" stroke-width="1.6" fill="none"/><path d="M11 11l3.5 3.5" stroke="#7d849e" stroke-width="1.6" stroke-linecap="round"/></svg>',
};
const status = (h) => (h === 'none' ? '<span class="st offline">No devices</span>' : `<span class="st ${h}">${ICONS[h]}${HLABEL[h]}</span>`);

const S = {
  me: null, options: null, connectors: [], connections: [], customers: [], alerts: [],
  summary: null, tree: null, devices: null,
  selected: new Set(), schematicDirty: false, config: null,
  filters: loadFilters(), sort: { key: 'health', dir: -1 }, alertFilter: 'all', openFilter: null,
};

function loadFilters() {
  try { const f = JSON.parse(localStorage.getItem('dm.filters') || '{}'); return { ...emptyFilters(), ...f }; } catch { return emptyFilters(); }
}
function emptyFilters() { return Object.fromEntries([...FILTER_KEYS.map(([k]) => [k, []]), ['q', '']]); }
function saveFilters() { try { localStorage.setItem('dm.filters', JSON.stringify(S.filters)); } catch { /* ignore */ } }
const isAdmin = () => ['super_admin', 'provider_admin'].includes(S.me?.role);
const isSuper = () => S.me?.role === 'super_admin';
const acting = () => S.me?.actingCustomerId || null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && path !== '/api/login') { S.me = null; renderLogin(); throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function qs(extra = {}) {
  const p = new URLSearchParams();
  for (const [k] of FILTER_KEYS) if (S.filters[k]?.length) p.set(k, S.filters[k].join(','));
  if (S.filters.q) p.set('q', S.filters.q);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// ------------------------------------------------------------------ login
async function renderLogin(error) {
  closeEvents();
  if (!S.config) S.config = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  $('#app').innerHTML = `
  <div class="login">
    <div class="login-art">
      <div class="brand"><div class="brand-mark">${pulseMark()}</div><div>Estate Monitor<small>Unified collaboration operations</small></div></div>
      <div>
        <h1>Every meeting room device, one view.</h1>
        <p>Health, alerts and sync status for Microsoft Teams, Zoom, Cisco Webex and Google Meet rooms, pulled from each manufacturer's cloud through plug-in connectors.</p>
      </div>
      <div class="login-badges"><span>Poly Lens</span><span>Logitech Sync</span><span>Multi-customer</span><span>Live alert feed</span></div>
    </div>
    <div class="login-form">
      <form id="loginForm">
        <h2>Sign in</h2>
        <p class="muted" style="margin:0 0 18px">Use your Estate Monitor account.</p>
        ${error ? `<div class="notice err">${esc(error)}</div>` : ''}
        <div class="field"><label for="em">Email</label><input id="em" name="email" type="email" autocomplete="username" required></div>
        <div class="field"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center" type="submit">Sign in</button>
        ${S.config?.showDemoAccounts ? `<div class="demo-users">Demo accounts (password is <span class="mono">DEMO_PASSWORD</span>, default <span class="mono">demo1234</span>):
          <button type="button" data-u="superadmin@provider.example">superadmin@provider.example · super admin, onboards customers</button>
          <button type="button" data-u="admin@provider.example">admin@provider.example · provider admin, all customers</button>
          <button type="button" data-u="it@helix.example">it@helix.example · Helix Financial only</button>
          <button type="button" data-u="it@northwind.example">it@northwind.example · Northwind Retail only</button>
          <button type="button" data-u="it@meridian.example">it@meridian.example · Meridian Health only</button>
        </div>` : ''}
      </form>
    </div>
  </div>`;
  document.querySelectorAll('[data-u]').forEach((b) => b.addEventListener('click', () => { $('#em').value = b.dataset.u; $('#pw').focus(); }));
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/login', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } });
      boot();
    } catch (err) { renderLogin(err.message); }
  });
}

function pulseMark() {
  return '<svg width="18" height="18" viewBox="0 0 32 32"><path d="M4 17h6l3-8 6 15 3-7h6" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

// ------------------------------------------------------------------ shell
function renderShell() {
  const initials = (S.me.name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
  $('#app').innerHTML = `
  <header class="topbar"><div class="topbar-inner">
    <a class="brand" href="#/overview"><div class="brand-mark">${pulseMark()}</div><div>Estate Monitor<small>${esc(S.me.customerName || S.me.actingCustomerName || (isSuper() ? 'Super admin' : 'Service provider view'))}</small></div></a>
    <nav class="nav" id="nav">
      <a href="#/overview" data-r="overview">Overview</a>
      <a href="#/map" data-r="map">Map</a>
      <a href="#/estate" data-r="estate">Sites &amp; rooms</a>
      <a href="#/devices" data-r="devices">Devices</a>
      <a href="#/lifecycle" data-r="lifecycle">Lifecycle</a>
      <a href="#/sla" data-r="sla">SLA</a>
      <a href="#/alerts" data-r="alerts">Alerts</a>
      <a href="#/connections" data-r="connections">Connections</a>
      ${isAdmin() ? '<a href="#/models" data-r="models">Models</a><a href="#/audit" data-r="audit">Audit log</a>' : ''}
      ${isSuper() ? '<a href="#/customers" data-r="customers">Customers</a>' : ''}
    </nav>
    <div class="top-right">
      ${isAdmin() ? `<select class="enter-select" id="enterSel" aria-label="Enter a customer"><option value="">${acting() ? 'Exit to all customers' : 'Enter customer…'}</option>${S.customers.map((c) => `<option value="${esc(c.id)}" ${c.id === acting() ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : ''}
      <span class="live" id="live"><i></i>Live</span>
      <span class="user-chip"><span class="avatar">${esc(initials)}</span><span>${esc(S.me.name)}</span></span>
      <button class="btn-ghost-light" id="logout">Sign out</button>
    </div>
  </div></header>
  ${acting() ? `<div class="acting-bar"><span>You're viewing <b>${esc(S.me.actingCustomerName)}</b> exactly as that customer sees their estate.</span><button class="btn btn-sm btn-outline" id="exitCust">Exit customer</button></div>` : ''}
  <section class="hero"><div class="hero-inner" id="hero"></div></section>
  <main><div id="filters"></div><div id="view"></div></main>
  <div class="toast-wrap" id="toasts"></div>`;
  $('#enterSel')?.addEventListener('change', (e) => enterCustomer(e.target.value || null));
  $('#exitCust')?.addEventListener('click', () => enterCustomer(null));
  $('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); S.me = null; renderLogin(); });
}

function route() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'overview').split('/').map(decodeURIComponent);
  return { name: parts[0] || 'overview', args: parts.slice(1) };
}

async function navigate() {
  if (!S.me) return;
  const r = route();
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === r.name));
  const withFilters = ['overview', 'estate', 'devices', 'map', 'lifecycle', 'sla'].includes(r.name);
  if (r.name !== 'map') destroyMap();
  $('#filters').innerHTML = '';
  if (withFilters) renderFilters();
  try {
    if (r.name === 'overview') await viewOverview();
    else if (r.name === 'estate') await viewEstate(r.args);
    else if (r.name === 'devices') await viewDevices();
    else if (r.name === 'alerts') await viewAlerts();
    else if (r.name === 'connections') await viewConnections();
    else if (r.name === 'map') await viewMap(r.args);
    else if (r.name === 'customers' && isSuper()) await viewCustomers();
    else if (r.name === 'lifecycle') await viewLifecycle();
    else if (r.name === 'sla') await viewSla();
    else if (r.name === 'models' && isAdmin()) await viewModels();
    else if (r.name === 'audit' && isAdmin()) await viewAudit();
    else location.hash = '#/overview';
  } catch (e) {
    if (e.message !== 'Signed out') $('#view').innerHTML = `<div class="card"><div class="notice err">${esc(e.message)}</div></div>`;
  }
}

function hero(title, sub, crumbs) {
  $('#hero').innerHTML = `${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}<h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}`;
}

// ------------------------------------------------------------------ filters
function renderFilters() {
  const o = S.options;
  if (!o) return;
  const keys = FILTER_KEYS.filter(([k]) => !(k === 'customer' && o.customer.length < 2));
  const opt = (k) => (o[k] || []).map((x) => (typeof x === 'string' ? { value: x, label: k === 'health' ? HLABEL[x] : x } : x));
  const any = FILTER_KEYS.some(([k]) => S.filters[k].length) || S.filters.q;
  $('#filters').innerHTML = `<div class="filters">
    ${keys.map(([k, label]) => {
    const sel = S.filters[k];
    const opts = opt(k);
    const text = !sel.length ? 'All' : sel.length === 1 ? (opts.find((x) => x.value === sel[0])?.label ?? sel[0]) : `${sel.length} selected`;
    return `<div class="fdrop" data-k="${k}">
        <button class="fbtn ${sel.length ? 'on' : ''}" type="button">${esc(label)}: <b>${esc(text)}</b>${ICONS.chevron}</button>
        ${S.openFilter === k ? `<div class="fpanel">${opts.map((x) => `<label><input type="checkbox" value="${esc(x.value)}" ${sel.includes(x.value) ? 'checked' : ''}>${k === 'health' ? ICONS[x.value] : ''}${esc(x.label)}</label>`).join('') || '<div class="muted" style="padding:8px">No values</div>'}
          <div class="fpanel-foot"><button class="linkbtn" data-clear="${k}">Clear</button><button class="linkbtn" data-close>Done</button></div></div>` : ''}
      </div>`;
  }).join('')}
    <div class="search">${ICONS.search}<input id="q" placeholder="Search model, room, serial…" value="${esc(S.filters.q)}"></div>
    ${any ? '<button class="linkbtn clear-all" id="clearAll">Clear filters</button>' : ''}
  </div>`;
  document.querySelectorAll('.fdrop').forEach((el) => {
    const k = el.dataset.k;
    el.querySelector('.fbtn').addEventListener('click', (e) => { e.stopPropagation(); S.openFilter = S.openFilter === k ? null : k; renderFilters(); });
    el.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => {
      const v = cb.value;
      S.filters[k] = cb.checked ? [...S.filters[k], v] : S.filters[k].filter((x) => x !== v);
      applyFilters(true);
    }));
    el.querySelector('.fpanel')?.addEventListener('click', (e) => e.stopPropagation());
    el.querySelector('[data-clear]')?.addEventListener('click', () => { S.filters[k] = []; applyFilters(true); });
    el.querySelector('[data-close]')?.addEventListener('click', () => { S.openFilter = null; renderFilters(); });
  });
  let t;
  $('#q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { S.filters.q = e.target.value; applyFilters(false, true); }, 250); });
  $('#clearAll')?.addEventListener('click', () => { S.filters = emptyFilters(); S.openFilter = null; applyFilters(); });
}
document.addEventListener('click', () => { if (S.openFilter) { S.openFilter = null; renderFilters(); } });

function applyFilters(keepOpen, keepSearchFocus) {
  if (!keepOpen) S.openFilter = null;
  saveFilters();
  if (!keepSearchFocus) renderFilters();
  refreshView();
}

function setFilter(k, v, go) {
  S.filters[k] = [v];
  saveFilters();
  if (go) location.hash = go; else { renderFilters(); refreshView(); }
}

let refreshTimer;
function refreshView() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const r = route();
    if (r.name === 'overview') viewOverview(true);
    else if (r.name === 'estate') viewEstate(r.args, true);
    else if (r.name === 'devices') viewDevices(true);
    else if (r.name === 'connections') viewConnections(true);
    else if (r.name === 'alerts') viewAlerts(true);
    else if (r.name === 'map') viewMap(r.args, true);
    else if (r.name === 'lifecycle') viewLifecycle();
    else if (r.name === 'sla') viewSla();
  }, 80);
}

// ------------------------------------------------------------------ overview
async function viewOverview() {
  const [summary] = await Promise.all([api(`/api/summary${qs()}`), loadConnections()]);
  S.summary = summary;
  const t = summary.totals;
  const pct = (n) => (t.total ? `${Math.round((n / t.total) * 100)}%` : '0%');
  const availability = t.total ? (((t.total - t.offline) / t.total) * 100).toFixed(1) : '0.0';
  hero(isAdmin() && !acting() ? 'Global estate overview' : `${S.me.customerName || S.me.actingCustomerName} estate`, `${t.total} devices across ${summary.rooms} rooms and ${summary.sites} sites. Updated ${ago(summary.builtAt)}.`);
  const fourth = isAdmin() && S.options.customer.length > 1
    ? breakdownCard('By customer', 'Each customer only sees its own estate', summary.byCustomer, (k) => ({ k: 'customer', v: S.options.customer.find((c) => c.label === k)?.value }))
    : breakdownCard('By device type', 'Classified from the model name', summary.byType, (k) => ({ k: 'deviceType', v: k }));
  $('#view').innerHTML = `
    <div class="kpis">
      <div class="kpi total" data-h=""><div class="lbl">Devices monitored</div><div class="val">${t.total}</div>
        <div class="meta"><span>${availability}% online</span><span>${summary.mergedDuplicates} merged duplicates</span></div></div>
      ${HEALTH.map((h) => `<div class="kpi" data-h="${h}"><div class="lbl">${ICONS[h]}${HLABEL[h]}</div><div class="val">${t[h]}</div><div class="pct">${pct(t[h])} of estate</div><div class="bar f-${h}" style="width:${t.total ? (t[h] / t.total) * 100 : 0}%"></div></div>`).join('')}
    </div>
    <div class="grid cols-main">
      <div class="grid">
        <div class="grid cols-2">
          ${breakdownCard('By source', 'Devices per manufacturer cloud or platform portal', summary.byOem.map((x) => ({ ...x, label: OEM_NAME[x.key] || x.key })), (k) => ({ k: 'oem', v: k }))}
          ${breakdownCard('By meeting platform', 'Teams, Zoom, Webex and Google Meet', summary.byPlatform, (k) => ({ k: 'platform', v: k }))}
        </div>
        <div class="grid cols-2">
          ${fourth}
          ${breakdownCard('By manufacturer', 'Make of the physical device', summary.byMake, null)}
        </div>
        ${breakdownCard('By site', 'Click a site to drill into its rooms', summary.bySite.map((s) => ({ ...s, sub: s.region })), (k) => ({ k: 'site', v: k, go: '#/estate' }), true)}
      </div>
      <div class="grid">
        <div class="card"><div class="card-head"><div><h2>Live alert feed</h2><div class="card-sub">Health changes as they happen</div></div><a href="#/alerts" class="pill blue">View all</a></div>
          <div class="feed" id="feed"></div></div>
        <div class="card"><div class="card-head"><div><h2>Sync status</h2><div class="card-sub">Manufacturer clouds and meeting-platform portals</div></div><a href="#/connections" class="pill blue">Manage</a></div>
          <div class="sync-list" id="syncList"></div></div>
      </div>
    </div>`;
  document.querySelectorAll('.kpi').forEach((el) => el.addEventListener('click', () => {
    S.filters.health = el.dataset.h ? [el.dataset.h] : [];
    saveFilters();
    location.hash = '#/devices';
  }));
  bindBreakdowns();
  renderFeed();
  renderSyncList();
}

const ROW_ACTIONS = new Map();
function breakdownCard(title, sub, rows, action, wide) {
  const id = `b${Math.random().toString(36).slice(2, 8)}`;
  ROW_ACTIONS.set(id, { rows, action });
  const body = rows.length ? rows.map((r, i) => `
    <div class="brk-row" data-b="${id}" data-i="${i}" ${action ? '' : 'style="cursor:default"'}>
      <div class="brk-name" title="${esc(r.label || r.key)}">${esc(r.label || r.key)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</div>
      <div class="brk-bar">${HEALTH.filter((h) => r[h]).map((h) => `<span class="f-${h}" style="flex:${r[h]}"></span>`).join('')}</div>
      <div class="brk-tot">${r.total}<small>${r.total ? Math.round((r.healthy / r.total) * 100) : 0}% ok</small></div>
    </div>`).join('') : '<div class="empty">No devices match the filters</div>';
  return `<div class="card" ${wide ? '' : ''}>
    <div class="card-head"><div><h2>${esc(title)}</h2><div class="card-sub">${esc(sub)}</div></div></div>
    <div class="legend" style="margin-bottom:12px">${HEALTH.map((h) => `<span><i class="f-${h}"></i>${HLABEL[h]}</span>`).join('')}</div>
    <div class="brk">${body}</div></div>`;
}

let tipEl;
function showTip(e, html) {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.appendChild(tipEl); }
  tipEl.innerHTML = html;
  tipEl.style.display = 'block';
  const x = Math.min(e.clientX + 14, window.innerWidth - tipEl.offsetWidth - 8);
  const y = Math.min(e.clientY + 14, window.innerHeight - tipEl.offsetHeight - 8);
  tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
}
function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

function bindBreakdowns() {
  document.querySelectorAll('.brk-row[data-b]').forEach((el) => {
    const { rows, action } = ROW_ACTIONS.get(el.dataset.b);
    const r = rows[Number(el.dataset.i)];
    el.addEventListener('mousemove', (e) => showTip(e, `<b>${esc(r.label || r.key)}</b>${HEALTH.map((h) => `<div><span><i class="f-${h}"></i>${HLABEL[h]}</span><span>${r[h]}</span></div>`).join('')}<div style="margin-top:4px;opacity:.8"><span>Total</span><span>${r.total}</span></div>`));
    el.addEventListener('mouseleave', hideTip);
    if (action) el.addEventListener('click', () => { hideTip(); const a = action(r.key); if (a.v) setFilter(a.k, a.v, a.go); });
  });
}

// ------------------------------------------------------------------ alert feed
function alertIcon(a) { return a.severity === 'resolved' ? ICONS.resolved : a.kind === 'sync' ? ICONS.sync : (ICONS[a.to] || ICONS.critical); }
function feedItem(a, fresh) {
  const cust = S.options?.customer.find((c) => c.value === a.customerId)?.label;
  return `<div class="feed-item ${fresh ? 'new' : ''}" data-dev="${esc(a.deviceId || '')}" data-conn="${esc(a.connectionId || '')}">
    <div class="sev-dot">${alertIcon(a)}</div>
    <div><div class="feed-msg">${esc(a.message)}</div>
      <div class="feed-meta"><span>${ago(a.at)}</span>${a.site ? `<span>${esc(a.site)}</span>` : ''}${isAdmin() && cust ? `<span>${esc(cust)}</span>` : ''}${a.platform && a.platform !== 'Unassigned' ? `<span>${esc(a.platform)}</span>` : ''}${a.initial ? '<span>at startup</span>' : ''}</div></div>
  </div>`;
}
function bindFeed(root) {
  root.querySelectorAll('.feed-item').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.dev) openDevice(el.dataset.dev);
    else if (el.dataset.conn) location.hash = '#/connections';
  }));
}
function renderFeed(freshId) {
  const el = $('#feed');
  if (!el) return;
  const list = S.alerts.slice(0, 30);
  el.innerHTML = list.length ? list.map((a) => feedItem(a, a.id === freshId)).join('') : '<div class="empty">No alerts yet</div>';
  bindFeed(el);
}

// ------------------------------------------------------------------ sync status
async function loadConnections() {
  S.connections = await api('/api/connections');
  return S.connections;
}
function syncState(st) {
  const label = { ok: 'Synced', error: 'Error', syncing: 'Syncing', never: 'Not synced' }[st.state] || st.state;
  return `<span class="sync-state s-${st.state}"><i></i>${label}</span>`;
}
function renderSyncList() {
  const el = $('#syncList');
  if (!el) return;
  el.innerHTML = S.connections.map((c) => `
    <div class="sync-item">
      <div class="oem-logo oem-${c.oem}">${OEM_SHORT[c.oem] || '?'}</div>
      <div><div class="sync-name">${esc(c.name)}</div>
        <div class="sync-meta"><span class="pill ${c.mode}" style="padding:1px 7px">${c.mode === 'live' ? 'Live' : 'Mock'}</span> · ${c.status.deviceCount} devices · ${ago(c.status.lastSuccessAt)}</div>
        ${c.status.error ? `<div class="err-line">${esc(c.status.error)}</div>` : ''}</div>
      ${syncState(c.status)}
    </div>`).join('') || '<div class="empty">No connections</div>';
}

// ------------------------------------------------------------------ estate drill-down
async function viewEstate(args) {
  const [customerId, site, room] = args;
  const tree = await api(`/api/tree${qs()}`);
  S.tree = tree;
  const crumbBase = '<a href="#/estate">All sites</a>';
  if (!customerId) {
    hero('Sites & rooms', `${tree.length} sites. Pick a site to see its rooms, then a room to see its devices.`);
    $('#view').innerHTML = tree.length ? `<div class="tiles">${tree.map((s) => siteTile(s)).join('')}</div>` : '<div class="card empty">No sites match the filters</div>';
    document.querySelectorAll('.tile[data-href]').forEach((el) => el.addEventListener('click', () => { location.hash = el.dataset.href; }));
    return;
  }
  const s = tree.find((x) => x.customerId === customerId && x.site === site);
  if (!s) { hero('Site not found', 'It may be hidden by the current filters.', crumbBase); $('#view').innerHTML = '<div class="card empty">Nothing to show. Try clearing filters.</div>'; return; }
  const siteHref = `#/estate/${encodeURIComponent(customerId)}/${encodeURIComponent(site)}`;
  if (!room) {
    hero(s.site, `${isAdmin() ? `${esc(s.customerName)} · ` : ''}${esc(s.region || '')}${s.country ? ` · ${esc(s.country)}` : ''} · ${s.rooms.length} rooms · ${s.health.total} devices`, `${crumbBase} <span>›</span> <span>${esc(s.site)}</span>`);
    $('#view').innerHTML = `<div class="tiles">${s.rooms.map((r) => roomTile(r, `${siteHref}/${encodeURIComponent(r.room)}`)).join('')}</div>`;
    document.querySelectorAll('.tile[data-href]').forEach((el) => el.addEventListener('click', () => { location.hash = el.dataset.href; }));
    return;
  }
  const r = s.rooms.find((x) => x.room === room);
  if (!r) { location.hash = siteHref; return; }
  hero(r.room, `${esc(s.site)} · ${esc(r.platform)} room · ${r.devices.length} devices`, `${crumbBase} <span>›</span> <a href="${siteHref}">${esc(s.site)}</a> <span>›</span> <span>${esc(r.room)}</span>`);
  const platSrc = r.devices.find((d) => d.platformSource)?.platformSource;
  $('#view').innerHTML = `
    <div class="grid cols-main">
      <div class="card"><div class="card-head"><div><h2>Devices in this room</h2><div class="card-sub">Click a device for full details and source data</div></div>${status(r.worst)}</div>
        ${r.devices.length ? deviceTable(r.devices, ['health', 'device', 'deviceType', 'serial', 'firmware', 'lastSeen', 'sources'], true) : '<div class="empty">No devices are assigned to this room yet. Use Devices › Group into room to move devices here.</div>'}</div>
      <div class="grid">
        <div class="card"><h2>Room</h2>
          <dl class="kv" style="margin-top:12px">
            <dt>Platform</dt><dd>${esc(r.platform)} <span class="muted">${platSrc ? `(${esc(platSrc)})` : ''}</span></dd>
            <dt>Site</dt><dd>${esc(s.site)}</dd><dt>Region</dt><dd>${esc(s.region)}</dd>
            ${isAdmin() ? `<dt>Customer</dt><dd>${esc(s.customerName)}</dd>` : ''}
            <dt>Health</dt><dd>${HEALTH.filter((h) => r.health[h]).map((h) => `${r.health[h]} ${HLABEL[h].toLowerCase()}`).join(', ') || 'No devices'}</dd>
          </dl>
          ${isAdmin() ? `<div class="section-title">Set room platform</div>
            <div class="field"><select id="roomPlat">${['Unassigned', 'Microsoft Teams', 'Zoom', 'Cisco Webex', 'Google Meet'].map((p) => `<option ${p === r.platform ? 'selected' : ''}>${p}</option>`).join('')}</select>
            <div class="help">Logitech Sync does not report the meeting platform, so it is set per room here. Devices that report a platform themselves (such as Poly Lens) keep their own value.</div></div>
            <button class="btn btn-outline btn-sm" id="savePlat">Save platform</button>` : ''}
        </div>
      </div>
    </div>`;
  bindDeviceTable();
  const schemCard = document.createElement('div');
  schemCard.className = 'card';
  schemCard.style.marginTop = '18px';
  $('#view').appendChild(schemCard);
  mountSchematic(schemCard, { customerId, site, room, devices: r.devices });
  $('#savePlat')?.addEventListener('click', async () => {
    await api('/api/rooms/platform', { method: 'PUT', body: { customerId, site, room, platform: $('#roomPlat').value } });
    toast(ICONS.resolved, 'Room platform saved');
    viewEstate(args);
  });
}

function healthCounts(h) {
  return HEALTH.filter((k) => h[k]).map((k) => `<span class="st ${k}">${ICONS[k]}${h[k]}</span>`).join('');
}
function siteTile(s) {
  return `<div class="tile w-${s.worst}" data-href="#/estate/${encodeURIComponent(s.customerId)}/${encodeURIComponent(s.site)}">
    <h3>${esc(s.site)}</h3><div class="sub">${isAdmin() ? `${esc(s.customerName)} · ` : ''}${esc(s.region || '')}${s.country ? ` · ${esc(s.country)}` : ''} · ${s.rooms.length} rooms</div>
    <div class="brk-bar">${HEALTH.filter((h) => s.health[h]).map((h) => `<span class="f-${h}" style="flex:${s.health[h]}"></span>`).join('')}</div>
    <div class="counts">${healthCounts(s.health)}</div></div>`;
}
function roomTile(r, href) {
  const makes = [...new Set(r.devices.map((d) => d.make))].join(' + ');
  return `<div class="tile w-${r.worst}" data-href="${href}">
    <h3>${esc(r.room)}</h3><div class="sub">${esc(r.platform)}${makes ? ` · ${esc(makes)}` : ''} · ${r.devices.length} devices${r.hasSchematic ? ' · schematic' : ''}</div>
    <div class="counts">${healthCounts(r.health)}</div></div>`;
}

// ------------------------------------------------------------------ devices table
const COLS = {
  health: ['Health', (d) => status(d.health), (d) => ['healthy', 'warning', 'offline', 'critical'].indexOf(d.health)],
  device: ['Device', (d) => `<b>${esc(d.make)}</b> ${esc(d.model.replace(new RegExp(`^${d.make}\\s+`), ''))}`, (d) => `${d.make} ${d.model}`],
  deviceType: ['Type', (d) => esc(d.deviceType), (d) => d.deviceType],
  customer: ['Customer', (d) => esc(d.customerName), (d) => d.customerName],
  site: ['Site', (d) => esc(d.site), (d) => d.site],
  room: ['Room', (d) => esc(d.room), (d) => d.room],
  platform: ['Platform', (d) => esc(d.platform), (d) => d.platform],
  serial: ['Serial', (d) => `<span class="mono">${esc(d.serial || '—')}</span>`, (d) => d.serial || ''],
  firmware: ['Firmware', (d) => `<span class="mono">${esc(d.firmware || '—')}</span>`, (d) => d.firmware || ''],
  lastSeen: ['Last seen', (d) => ago(d.lastSeen), (d) => d.lastSeen || ''],
  sources: ['Sources', (d) => `<span class="src-tags">${d.oems.map((o) => `<span class="pill" title="${esc(OEM_NAME[o] || o)}">${OEM_SHORT[o] || o}</span>`).join('')}</span>`, (d) => d.oems.length],
};
let tableRows = [];
function deviceTable(rows, cols, selectable) {
  const { key, dir } = S.sort;
  const sorter = COLS[key]?.[2];
  tableRows = sorter ? [...rows].sort((a, b) => { const x = sorter(a); const y = sorter(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; }) : rows;
  if (!rows.length) return '<div class="empty">No devices match the filters</div>';
  const sel = selectable && isAdmin();
  const allOn = sel && tableRows.every((d) => S.selected.has(d.id));
  return `<div class="table-wrap"><table><thead><tr>${sel ? `<th class="cb"><input type="checkbox" id="selAll" aria-label="Select all" ${allOn ? 'checked' : ''}></th>` : ''}${cols.map((c) => `<th data-sort="${c}">${COLS[c][0]}${key === c ? (dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead>
    <tbody>${tableRows.map((d) => `<tr data-id="${esc(d.id)}" class="${S.selected.has(d.id) ? 'sel' : ''}">${sel ? `<td class="cb"><input type="checkbox" data-sel="${esc(d.id)}" aria-label="Select" ${S.selected.has(d.id) ? 'checked' : ''}></td>` : ''}${cols.map((c) => `<td>${COLS[c][1](d)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function bindDeviceTable() {
  document.querySelectorAll('tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.closest('.cb')) return; openDevice(tr.dataset.id); }));
  document.querySelectorAll('input[data-sel]').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) S.selected.add(cb.dataset.sel); else S.selected.delete(cb.dataset.sel);
    cb.closest('tr').classList.toggle('sel', cb.checked);
    renderBulkBar();
  }));
  $('#selAll')?.addEventListener('change', (e) => {
    for (const d of tableRows) if (e.target.checked) S.selected.add(d.id); else S.selected.delete(d.id);
    document.querySelectorAll('input[data-sel]').forEach((cb) => { cb.checked = e.target.checked; cb.closest('tr').classList.toggle('sel', cb.checked); });
    renderBulkBar();
  });
  renderBulkBar();
  document.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : 1 };
    refreshView();
  }));
}

async function viewDevices() {
  const devices = await api(`/api/devices${qs()}`);
  S.devices = devices;
  hero('Devices', `${devices.length} devices match the current filters. Duplicates reported by more than one source appear once.`);
  const cols = ['health', 'device', 'deviceType', ...(isAdmin() && !acting() ? ['customer'] : []), 'site', 'room', 'platform', 'serial', 'firmware', 'lastSeen', 'sources'];
  const known = new Set(devices.map((d) => d.id));
  for (const id of [...S.selected]) if (!known.has(id)) S.selected.delete(id);
  $('#view').innerHTML = `${isAdmin() ? '<div class="bulk-hint muted">Tick devices to group them into a room or update them in bulk.</div>' : ''}<div class="card">${deviceTable(devices, cols, true)}</div>`;
  bindDeviceTable();
}

// ------------------------------------------------------------------ device drawer
async function openDevice(id) {
  let d;
  try { d = await api(`/api/devices/${encodeURIComponent(id)}`); } catch (e) { toast(ICONS.warning, e.message); return; }
  const roomHref = `#/estate/${encodeURIComponent(d.customerId)}/${encodeURIComponent(d.site)}/${encodeURIComponent(d.room)}`;
  drawer(`${d.make} ${d.model.replace(new RegExp(`^${d.make}\\s+`), '')}`, `${esc(d.deviceType)} · ${esc(d.room)}, ${esc(d.site)}`, `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:6px">${status(d.health)}${d.inUse ? '<span class="pill blue">In a meeting</span>' : ''}</div>
    ${d.healthReason ? `<div class="notice ${d.health === 'healthy' ? 'ok' : d.health === 'warning' ? 'info' : 'err'}">${esc(d.healthReason)}</div>` : ''}
    <div class="section-title">Common device record</div>
    <dl class="kv">
      ${isAdmin() ? `<dt>Customer</dt><dd>${esc(d.customerName)}</dd>` : ''}
      <dt>Region</dt><dd>${esc(d.region)}</dd><dt>Site</dt><dd>${esc(d.site)}</dd>
      <dt>Room</dt><dd><a href="${roomHref}" data-closedrawer>${esc(d.room)}</a></dd>
      <dt>Device type</dt><dd>${esc(d.deviceType)}</dd><dt>Make</dt><dd>${esc(d.make)}</dd><dt>Model</dt><dd>${esc(d.model)}</dd>
      <dt>Serial</dt><dd class="mono">${esc(d.serial || '—')}</dd><dt>Firmware</dt><dd class="mono">${esc(d.firmware || '—')}</dd>
      <dt>Health</dt><dd>${HLABEL[d.health]}</dd>
      <dt>Last seen</dt><dd>${d.lastSeen ? `${ago(d.lastSeen)} <span class="muted">(${new Date(d.lastSeen).toLocaleString()})</span>` : '—'}</dd>
      <dt>Platform</dt><dd>${esc(d.platform)} <span class="muted">${d.platformSource ? `(${esc(d.platformSource)})` : ''}</span></dd>
      ${d.hostName ? `<dt>Host name</dt><dd class="mono">${esc(d.hostName)}</dd>` : ''}
      ${d.ip ? `<dt>IP address</dt><dd class="mono">${esc(d.ip)}</dd>` : ''}
      ${d.mac ? `<dt>MAC address</dt><dd class="mono">${esc(d.mac)}</dd>` : ''}
      ${d.assetTag ? `<dt>Asset tag</dt><dd class="mono">${esc(d.assetTag)}</dd>` : ''}
      ${d.tags?.length ? `<dt>Tags</dt><dd>${d.tags.map((t) => `<span class="pill blue">${esc(t)}</span>`).join(' ')}</dd>` : ''}
      ${d.notes ? `<dt>Notes</dt><dd>${esc(d.notes)}</dd>` : ''}
    </dl>
    ${lifecycleSection(d)}
    ${d.overridden?.length ? `<div class="notice info" style="margin-top:14px">Manually changed: ${d.overridden.map(esc).join(', ')}. The OEM reports this device in <b>${esc(d.reportedRoom)}</b>, ${esc(d.reportedSite)}.</div>` : ''}
    ${isAdmin() ? `<div class="section-title">Edit this device</div>
      <div class="grid cols-2" style="gap:10px">
        <div class="field"><label>Site</label><input id="eSite" value="${esc(d.site)}" list="eSites"></div>
        <div class="field"><label>Room</label><input id="eRoom" value="${esc(d.room)}"></div>
        <div class="field"><label>Platform</label><select id="ePlat">${['Unassigned', 'Microsoft Teams', 'Zoom', 'Cisco Webex', 'Google Meet'].map((p) => `<option ${p === d.platform ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        <div class="field"><label>Asset tag</label><input id="eAsset" value="${esc(d.assetTag || '')}"></div>
      </div>
      <div class="field"><label>Tags (comma separated)</label><input id="eTags" value="${esc((d.tags || []).join(', '))}"></div>
      <div class="field"><label>Notes</label><input id="eNotes" value="${esc(d.notes || '')}"></div>
      <div class="grid cols-2" style="gap:10px">
        <div class="field"><label>Warranty end</label><input id="eWarr" type="date" value="${esc(d.warrantyExpires || '')}"></div>
        <div class="field"><label>Warranty / support plan</label><input id="eWarrType" value="${esc(d.warrantyType || '')}" placeholder="e.g. Poly+ Premier, Logitech Select"></div>
        <div class="field"><label>Contract reference</label><input id="eContract" value="${esc(d.contractRef || '')}"></div>
        <div class="field"><label>Purchase date</label><input id="ePurchase" type="date" value="${esc(d.purchaseDate || '')}"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary btn-sm" id="eSave">Save changes</button>${d.overridden?.length ? '<button class="btn btn-outline btn-sm" id="eReset">Reset to OEM values</button>' : ''}</div>` : ''}
    <div class="section-title">Reported by ${d.sources.length} source${d.sources.length > 1 ? 's' : ''}</div>
    ${d.sources.length > 1 ? '<div class="notice info">This device was reported by more than one OEM cloud and has been merged into one record. Health shows the most severe state any source reports.</div>' : ''}
    <div class="sync-list">${d.sources.map((s) => {
    const conn = S.connections.find((c) => c.id === s.connectionId);
    return `<div class="sync-item"><div class="oem-logo oem-${s.oem}">${OEM_SHORT[s.oem] || '?'}</div>
        <div><div class="sync-name">${esc(OEM_NAME[s.oem] || s.oem)}</div><div class="sync-meta mono">${esc(s.sourceId)}</div>${conn ? `<div class="sync-meta">${esc(conn.name)}</div>` : ''}</div>
        ${s.health ? status(s.health) : ''}</div>`;
  }).join('')}</div>`);
  $('#eSave')?.addEventListener('click', async () => {
    const tags = $('#eTags').value.split(',').map((t) => t.trim()).filter(Boolean);
    const set = { site: $('#eSite').value, room: $('#eRoom').value, platform: $('#ePlat').value, assetTag: $('#eAsset').value || null, notes: $('#eNotes').value || null, removeTags: d.tags || [], addTags: tags };
    const changed = (id, cur) => ($(id).value !== (cur || '') ? ($(id).value || null) : undefined);
    set.warrantyExpires = changed('#eWarr', d.warrantyExpires);
    set.warrantyType = changed('#eWarrType', d.warrantyType);
    set.contractRef = changed('#eContract', d.contractRef);
    set.purchaseDate = changed('#ePurchase', d.purchaseDate);
    if (set.site === d.reportedSite) set.site = null;
    if (set.room === d.reportedRoom) set.room = null;
    try { await api('/api/devices/bulk', { method: 'POST', body: { ids: [d.id], set } }); toast(ICONS.resolved, 'Device updated'); closeDrawer(); refreshView(); } catch (e) { toast(ICONS.critical, e.message); }
  });
  $('#eReset')?.addEventListener('click', async () => {
    await api('/api/devices/bulk', { method: 'POST', body: { ids: [d.id], reset: true } });
    toast(ICONS.resolved, 'Device reset to OEM values'); closeDrawer(); refreshView();
  });
}

function drawer(title, sub, body, foot) {
  closeDrawer();
  const wrap = document.createElement('div');
  wrap.id = 'drawerWrap';
  wrap.innerHTML = `<div class="scrim"></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="drawer-head"><div><h2>${esc(title)}</h2><div class="muted">${sub || ''}</div></div><button class="x" aria-label="Close">×</button></div>
    <div class="drawer-body">${body}</div>${foot ? `<div class="drawer-foot">${foot}</div>` : ''}</aside>`;
  document.body.appendChild(wrap);
  wrap.querySelector('.scrim').addEventListener('click', closeDrawer);
  wrap.querySelector('.x').addEventListener('click', closeDrawer);
  wrap.querySelectorAll('[data-closedrawer]').forEach((a) => a.addEventListener('click', closeDrawer));
  return wrap;
}
function closeDrawer() { $('#drawerWrap')?.remove(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ------------------------------------------------------------------ alerts view
async function viewAlerts() {
  S.alerts = await api('/api/alerts?limit=300');
  hero('Alerts', 'Device health changes and connector sync problems, newest first.');
  const f = S.alertFilter;
  const match = (a) => f === 'all' || (f === 'sync' ? a.kind === 'sync' : a.severity === f);
  const list = S.alerts.filter(match);
  $('#view').innerHTML = `<div class="card">
    <div class="card-head"><div class="seg" id="alertSeg">${[['all', 'All'], ['critical', 'Critical'], ['warning', 'Warning'], ['resolved', 'Resolved'], ['sync', 'Sync']].map(([k, l]) => `<button data-f="${k}" class="${f === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="muted">${list.length} alerts</span></div>
    <div class="feed" style="max-height:none" id="alertList">${list.map((a) => feedItem(a)).join('') || '<div class="empty">No alerts</div>'}</div></div>`;
  document.querySelectorAll('#alertSeg button').forEach((b) => b.addEventListener('click', () => { S.alertFilter = b.dataset.f; viewAlerts(); }));
  bindFeed($('#alertList'));
}

// ------------------------------------------------------------------ connections view
async function viewConnections() {
  await loadConnections();
  hero('Connections', isAdmin()
    ? 'Link each customer\'s manufacturer clouds and meeting-platform portals. Credentials are encrypted on the server and never sent back to the browser.'
    : 'Sync status of the manufacturer clouds and platform portals feeding your estate.');
  const byCust = new Map();
  for (const c of S.connections) { if (!byCust.has(c.customerName)) byCust.set(c.customerName, []); byCust.get(c.customerName).push(c); }
  $('#view').innerHTML = `
    ${isAdmin() ? `<div class="cta"><div><h3>Link Poly Lens with API keys</h3><p>Create an API client in Poly Lens (Integrations › API Credentials), then paste the client ID and secret here. Logitech Sync uses a client certificate instead.</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-grad" id="linkPoly">Link Poly Lens</button><button class="btn btn-outline" id="addConn">Add connection</button></div></div>` : ''}
    ${[...byCust.entries()].map(([name, conns]) => `
      <div class="card" style="margin-bottom:18px"><div class="card-head"><div><h2>${esc(name)}</h2><div class="card-sub">${conns.length} connection${conns.length > 1 ? 's' : ''}</div></div></div>
        ${['oem', 'platform'].map((k) => { const list = conns.filter((c) => (S.connectors.find((x) => x.oem === c.oem)?.kind || 'oem') === k); return list.length ? `<div class="section-title" style="margin-top:4px">${k === 'oem' ? 'Manufacturer clouds' : 'Meeting-platform portals'}</div><div class="conn-grid">${list.map(connCard).join('')}</div>` : ''; }).join('')}</div>`).join('') || '<div class="card empty">No connections yet</div>'}`;
  document.querySelectorAll('[data-cfg]').forEach((b) => b.addEventListener('click', () => openConnection(S.connections.find((c) => c.id === b.dataset.cfg))));
  document.querySelectorAll('[data-sync]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Syncing…';
    try { await api(`/api/connections/${b.dataset.sync}/sync`, { method: 'POST' }); } catch (e) { toast(ICONS.critical, e.message); }
    viewConnections();
  }));
  $('#linkPoly')?.addEventListener('click', () => {
    const existing = S.connections.find((c) => c.oem === 'poly-lens' && c.mode === 'mock');
    openConnection(existing || null, { oem: 'poly-lens', mode: 'live' });
  });
  $('#addConn')?.addEventListener('click', () => openConnection(null, {}));
}

function connCard(c) {
  const st = c.status;
  return `<div class="conn-card">
    <div class="conn-top"><div class="oem-logo oem-${c.oem}">${OEM_SHORT[c.oem] || '?'}</div>
      <div><div class="sync-name">${esc(c.oemName)}</div><div class="sync-meta">${esc(c.name)}</div></div>
      <span class="pill ${c.mode}">${c.mode === 'live' ? 'Live' : 'Mock data'}</span></div>
    <div class="conn-stats"><div><span class="muted">Status</span>${syncState(st)}</div><div><span class="muted">Devices</span><b>${st.deviceCount}</b></div><div><span class="muted">Last sync</span><b>${ago(st.lastSuccessAt)}</b></div></div>
    ${st.error ? `<div class="err-line">${esc(st.error)}</div>` : ''}
    ${S.connectors.find((x) => x.oem === c.oem)?.liveSupported === false ? '<div class="muted" style="font-size:12px">Mock only: no public API for live data.</div>' : ''}
    ${isAdmin() ? `<div class="conn-actions"><button class="btn btn-primary btn-sm" data-cfg="${c.id}">${c.mode === 'live' || S.connectors.find((x) => x.oem === c.oem)?.liveSupported === false ? 'Configure' : 'Configure & go live'}</button><button class="btn btn-outline btn-sm" data-sync="${c.id}">Sync now</button></div>` : ''}
  </div>`;
}

const SETUP_STEPS = {
  'poly-lens': [
    'Sign in to Poly Lens as a tenant admin.',
    'Open Integrations › API Credentials and create a new credential.',
    'Copy the client ID and client secret (the secret is shown once).',
    'Paste them below, press Test connection, then switch to Live and save.',
  ],
  'logitech-sync': [
    'In the Sync Portal open Settings › Sync Cloud API (needs a Select, Essential or Sync Plus licence).',
    'Copy the Organization ID and the API Server shown there.',
    'Generate a certificate and download certificate.pem and privateKey.pem.',
    'Paste both PEM files below, press Test connection, then switch to Live and save.',
  ],
};

function openConnection(conn, preset = {}) {
  const creating = !conn;
  let oem = conn?.oem || preset.oem || S.connectors[0]?.oem;
  let mode = preset.mode || conn?.mode || 'mock';
  const render = () => {
    const C = S.connectors.find((x) => x.oem === oem);
    const body = `
      <div id="connMsg"></div>
      ${creating ? `<div class="field"><label>Customer</label><select id="cCust">${S.customers.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Source</label><select id="cOem">${['oem', 'platform'].map((k) => `<optgroup label="${k === 'oem' ? 'Manufacturer clouds' : 'Meeting-platform portals'}">${S.connectors.filter((x) => x.kind === k).map((x) => `<option value="${x.oem}" ${x.oem === oem ? 'selected' : ''}>${esc(x.displayName)}</option>`).join('')}</optgroup>`).join('')}</select></div>` : ''}
      <div class="field"><label>Connection name</label><input id="cName" value="${esc(conn?.name || '')}" placeholder="e.g. Helix Financial · ${esc(C.displayName)}"></div>
      <div class="field"><label>Data source</label><div class="seg" id="cMode"><button data-m="mock" class="${mode === 'mock' ? 'on' : ''}">Mock data</button><button data-m="live" class="${mode === 'live' ? 'on' : ''}" ${C.liveSupported === false ? 'disabled title="No public API available"' : ''}>Live API</button></div>
        <div class="help">${mode === 'mock' ? 'Uses built-in sample data in the same format as the real API. No keys needed.' : `Calls the real ${esc(C.displayName)} API with the credentials below.`}</div></div>
      ${C.liveSupported === false ? `<div class="notice info">${esc(C.liveNote)}</div>` : `<div class="section-title">How to get credentials</div>
      <ol class="steps">${(C.setupSteps?.length ? C.setupSteps : SETUP_STEPS[oem] || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`}
      <div class="muted" style="font-size:12px;margin:-8px 0 12px">${C.liveSupported === false ? `<a href="${esc(C.docsUrl)}" target="_blank" rel="noopener">Source for this</a>` : `Built from the <a href="${esc(C.docsUrl)}" target="_blank" rel="noopener">official ${esc(C.displayName)} API documentation</a>.`}</div>
      ${C.settingFields.length ? '<div class="section-title">Settings</div>' : ''}
      ${C.settingFields.map((f) => `<div class="field"><label for="s_${f.key}">${esc(f.label)}${f.required ? ' *' : ''}</label>
        <input id="s_${f.key}" data-setting="${f.key}" value="${esc(conn?.settings?.[f.key] ?? '')}" placeholder="${esc(f.placeholder || f.default || '')}">${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}</div>`).join('')}
      ${C.credentialFields.length ? '<div class="section-title">Credentials (encrypted at rest)</div>' : ''}
      ${C.credentialFields.map((f) => {
    const stored = conn?.credentials?.[f.key];
    const ph = stored ? 'Stored. Leave blank to keep the current value.' : '';
    return `<div class="field"><label for="k_${f.key}">${esc(f.label)}${f.required ? ' *' : ''} ${stored ? '<span class="stored">✓ stored</span>' : ''}</label>
          ${f.multiline ? `<textarea id="k_${f.key}" data-cred="${f.key}" placeholder="${esc(ph || '-----BEGIN ...-----')}" spellcheck="false"></textarea>` : `<input id="k_${f.key}" data-cred="${f.key}" type="password" autocomplete="off" placeholder="${esc(ph)}">`}
          ${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}</div>`;
  }).join('')}`;
    const foot = `${!creating ? '<button class="btn btn-danger" id="cDel" style="margin-right:auto">Remove</button>' : ''}
      ${!creating ? '<button class="btn btn-outline" id="cTest">Test connection</button>' : ''}
      <button class="btn btn-primary" id="cSave">${creating ? 'Create connection' : 'Save'}</button>`;
    const w = drawer(creating ? 'Add OEM connection' : conn.name, creating ? 'Connect a manufacturer cloud to a customer' : `${esc(C.displayName)} · ${esc(conn.customerName)}`, body, foot);
    const collect = () => ({
      name: $('#cName', w).value.trim() || undefined,
      mode,
      settings: Object.fromEntries([...w.querySelectorAll('[data-setting]')].map((i) => [i.dataset.setting, i.value])),
      credentials: Object.fromEntries([...w.querySelectorAll('[data-cred]')].map((i) => [i.dataset.cred, i.value]).filter(([, v]) => v.trim())),
    });
    const msg = (kind, text) => { $('#connMsg', w).innerHTML = `<div class="notice ${kind}">${esc(text)}</div>`; w.querySelector('.drawer-body').scrollTop = 0; };
    $('#cOem', w)?.addEventListener('change', (e) => { oem = e.target.value; render(); });
    w.querySelectorAll('#cMode button:not([disabled])').forEach((b) => b.addEventListener('click', () => {
      // Preserve typed values across re-render.
      const keep = collect();
      mode = b.dataset.m; render();
      for (const [k, v] of Object.entries(keep.settings)) { const i = document.querySelector(`[data-setting="${k}"]`); if (i) i.value = v; }
      for (const [k, v] of Object.entries(keep.credentials)) { const i = document.querySelector(`[data-cred="${k}"]`); if (i) i.value = v; }
      if (keep.name) $('#cName').value = keep.name;
    }));
    $('#cTest', w)?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Testing…';
      try { const r = await api(`/api/connections/${conn.id}/test`, { method: 'POST', body: collect() }); msg(r.ok ? 'ok' : 'err', r.message); } catch (err) { msg('err', err.message); }
      e.target.disabled = false; e.target.textContent = 'Test connection';
    });
    $('#cSave', w).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const body = collect();
        if (creating) await api('/api/connections', { method: 'POST', body: { ...body, customerId: $('#cCust', w).value, oem } });
        else await api(`/api/connections/${conn.id}`, { method: 'PUT', body });
        closeDrawer();
        toast(ICONS.resolved, creating ? 'Connection created' : 'Connection saved and synced');
        viewConnections();
      } catch (err) { msg('err', err.message); e.target.disabled = false; }
    });
    $('#cDel', w)?.addEventListener('click', async () => {
      if (!$('#cDel', w).dataset.confirm) { $('#cDel', w).dataset.confirm = '1'; $('#cDel', w).textContent = 'Click again to remove'; return; }
      await api(`/api/connections/${conn.id}`, { method: 'DELETE' });
      closeDrawer(); toast(ICONS.resolved, 'Connection removed'); viewConnections();
    });
  };
  render();
}

// ------------------------------------------------------------------ toasts & live events
function toast(icon, text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div>${icon}</div><div>${esc(text)}</div>`;
  $('#toasts')?.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

let es;
function closeEvents() { es?.close(); es = null; }
function openEvents() {
  closeEvents();
  es = new EventSource('/api/events');
  es.onopen = () => $('#live')?.classList.remove('down');
  es.onerror = () => $('#live')?.classList.add('down');
  es.addEventListener('alert', (e) => {
    const a = JSON.parse(e.data);
    S.alerts.unshift(a);
    S.alerts.length = Math.min(S.alerts.length, 300);
    renderFeed(a.id);
    if (a.severity === 'critical') toast(alertIcon(a), a.message);
    if (route().name === 'alerts') viewAlerts();
  });
  es.addEventListener('sync', (e) => {
    const s = JSON.parse(e.data);
    const c = S.connections.find((x) => x.id === s.connectionId);
    if (c) { c.status = { ...c.status, ...s }; renderSyncList(); }
  });
  let invTimer;
  es.addEventListener('inventory', () => {
    clearTimeout(invTimer);
    invTimer = setTimeout(async () => {
      S.options = await api('/api/filters').catch(() => S.options);
      const r = route().name;
      if (['overview', 'estate', 'devices', 'map'].includes(r) && !$('#drawerWrap') && !S.openFilter && !S.selected.size && !S.schematicDirty) refreshView();
      if (r === 'connections' && !$('#drawerWrap')) viewConnections();
    }, 500);
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  try { S.me = await api('/api/me'); } catch { renderLogin(); return; }
  const [options, connectors, alerts, customers] = await Promise.all([api('/api/filters'), api('/api/connectors'), api('/api/alerts?limit=100'), api('/api/customers')]);
  Object.assign(S, { options, connectors, alerts, customers });
  // Drop saved filter values the user can no longer see.
  for (const [k] of FILTER_KEYS) {
    const allowed = (options[k] || []).map((x) => (typeof x === 'string' ? x : x.value));
    S.filters[k] = S.filters[k].filter((v) => allowed.includes(v));
  }
  renderShell();
  openEvents();
  navigate();
}

window.addEventListener('hashchange', () => { closeDrawer(); navigate(); });
boot();

// ------------------------------------------------------------------ enter customer
async function enterCustomer(id) {
  try {
    if (id) await api('/api/session/enter', { method: 'POST', body: { customerId: id } });
    else await api('/api/session/exit', { method: 'POST' });
    S.selected.clear();
    S.filters = emptyFilters(); saveFilters();
    location.hash = '#/overview';
    boot();
  } catch (e) { toast(ICONS.critical, e.message); }
}

// ------------------------------------------------------------------ bulk update
const PLATFORM_LIST = ['Microsoft Teams', 'Zoom', 'Cisco Webex', 'Google Meet', 'Unassigned'];

function renderBulkBar() {
  let bar = $('#bulkBar');
  if (!isAdmin() || !S.selected.size) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'bulkBar'; bar.className = 'bulk-bar'; document.body.appendChild(bar); }
  bar.innerHTML = `<b>${S.selected.size} selected</b>
    <button class="btn btn-sm btn-grad" data-act="room">Group into room</button>
    <button class="btn btn-sm btn-outline" data-act="platform">Set platform</button>
    <button class="btn btn-sm btn-outline" data-act="tags">Tags &amp; notes</button>
    <button class="btn btn-sm btn-outline" data-act="warranty">Warranty</button>
    <button class="btn btn-sm btn-outline" data-act="reset">Reset to OEM values</button>
    <button class="linkbtn" data-act="clear">Clear selection</button>`;
  bar.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => bulkAction(b.dataset.act)));
}

async function selectedDevices() {
  const all = await api('/api/devices');
  return all.filter((d) => S.selected.has(d.id));
}

async function bulkAction(act) {
  if (act === 'clear') { S.selected.clear(); document.querySelectorAll('input[data-sel], #selAll').forEach((c) => { c.checked = false; c.closest('tr')?.classList.remove('sel'); }); renderBulkBar(); return; }
  const devs = await selectedDevices();
  const ids = devs.map((d) => d.id);
  const run = async (body, msg) => {
    try {
      const r = await api('/api/devices/bulk', { method: 'POST', body: { ids, ...body } });
      toast(ICONS.resolved, `${msg} (${r.updated} devices)`);
      S.selected.clear(); renderBulkBar(); closeDrawer(); refreshView();
    } catch (e) { toast(ICONS.critical, e.message); }
  };
  if (act === 'reset') { await run({ reset: true }, 'Reset to OEM values'); return; }
  const custs = [...new Set(devs.map((d) => d.customerId))];
  const list = `<div class="muted" style="margin-bottom:12px">${devs.slice(0, 8).map((d) => `${esc(d.make)} ${esc(d.model.replace(new RegExp(`^${d.make}\\s+`), ''))} · ${esc(d.room)}`).join('<br>')}${devs.length > 8 ? `<br>…and ${devs.length - 8} more` : ''}</div>`;
  if (act === 'room') {
    if (custs.length > 1) { toast(ICONS.warning, 'Pick devices from one customer to group them into a room.'); return; }
    const tree = await api(`/api/tree?customer=${encodeURIComponent(custs[0])}`);
    const sites = tree.map((s) => s.site);
    const roomsBySite = Object.fromEntries(tree.map((s) => [s.site, s.rooms.map((r) => r.room)]));
    const cur = devs[0];
    const w = drawer('Group into room', `${devs.length} device${devs.length > 1 ? 's' : ''} will be shown together in one room`, `${list}
      <div class="field"><label>Site</label><select id="gSite">${sites.map((x) => `<option ${x === cur.site ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
      <div class="field"><label>Room</label><input id="gRoom" list="gRooms" placeholder="Pick an existing room or type a new name"><datalist id="gRooms"></datalist>
        <div class="help">Typing a new name creates the room. Devices keep their OEM data; only where they're shown changes, and you can reset it any time.</div></div>
      <div class="field"><label>Platform for these devices (optional)</label><select id="gPlat"><option value="">Keep as is</option>${PLATFORM_LIST.map((p) => `<option>${p}</option>`).join('')}</select></div>`,
    '<button class="btn btn-primary" id="gGo">Move devices</button>');
    const fillRooms = () => { $('#gRooms', w).innerHTML = (roomsBySite[$('#gSite', w).value] || []).map((r) => `<option value="${esc(r)}">`).join(''); };
    fillRooms();
    $('#gSite', w).addEventListener('change', fillRooms);
    $('#gGo', w).addEventListener('click', () => {
      const room = $('#gRoom', w).value.trim();
      if (!room) { $('#gRoom', w).focus(); return; }
      const set = { site: $('#gSite', w).value, room };
      if ($('#gPlat', w).value) set.platform = $('#gPlat', w).value;
      run({ set }, `Grouped into ${room}`);
    });
  } else if (act === 'platform') {
    const w = drawer('Set platform', `${devs.length} devices`, `${list}<div class="field"><label>Platform</label><select id="pPlat">${PLATFORM_LIST.map((p) => `<option>${p}</option>`).join('')}</select>
      <div class="help">Overrides what the OEM reports. "Unassigned" removes the override.</div></div>`, '<button class="btn btn-primary" id="pGo">Apply</button>');
    $('#pGo', w).addEventListener('click', () => run({ set: { platform: $('#pPlat', w).value } }, 'Platform updated'));
  } else if (act === 'warranty') {
    const w = drawer('Warranty and contract', `${devs.length} devices`, `${list}
      <div class="grid cols-2" style="gap:10px">
        <div class="field"><label>Warranty end</label><input id="wEnd" type="date"></div>
        <div class="field"><label>Warranty / support plan</label><input id="wType" placeholder="e.g. Poly+ Premier"></div>
        <div class="field"><label>Contract reference</label><input id="wRef"></div>
        <div class="field"><label>Purchase date</label><input id="wBuy" type="date"></div>
      </div><div class="help">Only the fields you fill in are changed. A date entered here overrides the warranty date reported by Logitech Sync.</div>`, '<button class="btn btn-primary" id="wGo">Apply</button>');
    $('#wGo', w).addEventListener('click', () => {
      const set = {};
      for (const [id, k] of [['#wEnd', 'warrantyExpires'], ['#wType', 'warrantyType'], ['#wRef', 'contractRef'], ['#wBuy', 'purchaseDate']]) if ($(id, w).value.trim()) set[k] = $(id, w).value.trim();
      if (!Object.keys(set).length) { toast(ICONS.warning, 'Fill in at least one field'); return; }
      run({ set }, 'Warranty updated');
    });
  } else if (act === 'tags') {
    const w = drawer('Tags & notes', `${devs.length} devices`, `${list}
      <div class="field"><label>Add tags (comma separated)</label><input id="tAdd" placeholder="e.g. VIP, Floor 4, Refresh 2027"></div>
      <div class="field"><label>Remove tags</label><input id="tRem"></div>
      <div class="field"><label>Notes (replaces existing notes, leave blank to keep)</label><input id="tNotes"></div>`, '<button class="btn btn-primary" id="tGo">Apply</button>');
    $('#tGo', w).addEventListener('click', () => {
      const split = (v) => v.split(',').map((t) => t.trim()).filter(Boolean);
      const set = { addTags: split($('#tAdd', w).value), removeTags: split($('#tRem', w).value) };
      if ($('#tNotes', w).value.trim()) set.notes = $('#tNotes', w).value.trim();
      run({ set }, 'Tags updated');
    });
  }
}

// ------------------------------------------------------------------ map
let MAP = null;
function destroyMap() { if (MAP) { MAP.map.remove(); MAP = null; } }
const HCOLOR = { healthy: '#0ca30c', warning: '#fab219', critical: '#d03b3b', offline: '#7d8399', none: '#b8bdcc' };

async function viewMap(args, isRefresh) {
  const sites = await api(`/api/map${qs()}`);
  const placed = sites.filter((s) => s.lat !== null && s.lng !== null);
  const unplaced = sites.filter((s) => s.lat === null || s.lng === null);
  hero('Estate map', `${placed.length} sites on the map. Zoom in from regions to sites, then pick a site to drill into its rooms and devices.`);
  if (!window.L) { $('#view').innerHTML = '<div class="card"><div class="notice err">The map library did not load.</div></div>'; return; }
  const keepView = isRefresh && MAP;
  const center = keepView ? MAP.map.getCenter() : null;
  const zoom = keepView ? MAP.map.getZoom() : null;
  const selection = keepView ? MAP.sel : { siteKey: null, room: null };
  destroyMap();
  $('#view').innerHTML = `<div class="grid map-grid">
    <div class="card map-card"><div id="map"></div>
      <div class="map-legend">${['healthy', 'warning', 'critical', 'offline'].map((h) => `<span>${ICONS[h]}${HLABEL[h]}</span>`).join('')}<span class="muted">Marker colour = worst device</span></div></div>
    <div class="card map-side" id="mapSide"></div></div>`;
  const map = L.map('map', { worldCopyJump: true, zoomControl: true, attributionControl: true }).setView([30, 10], 2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 18, subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  MAP = { map, sites, sel: selection, layer: L.layerGroup().addTo(map) };
  const key = (s) => `${s.customerId}|${s.site}`;
  const worstOf = (list) => ['critical', 'offline', 'warning', 'healthy'].find((h) => list.some((s) => s.health[h])) || 'none';
  const sum = (list) => list.reduce((a, s) => a + s.health.total, 0);
  const pin = (count, color, size, label) => L.divIcon({
    className: 'pin-wrap',
    html: `<div class="pin" style="--c:${color};width:${size}px;height:${size}px"><b>${count}</b></div>${label ? `<div class="pin-label">${esc(label)}</div>` : ''}`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  });

  const draw = () => {
    MAP.layer.clearLayers();
    const z = map.getZoom();
    if (z < 4) {
      const regions = new Map();
      for (const s of placed) { const r = s.region || 'Unassigned'; if (!regions.has(r)) regions.set(r, []); regions.get(r).push(s); }
      for (const [region, list] of regions) {
        const lat = list.reduce((a, s) => a + s.lat, 0) / list.length;
        const lng = list.reduce((a, s) => a + s.lng, 0) / list.length;
        const m = L.marker([lat, lng], { icon: pin(sum(list), HCOLOR[worstOf(list)], 58, `${region} · ${list.length} sites`) }).addTo(MAP.layer);
        m.on('click', () => map.fitBounds(L.latLngBounds(list.map((s) => [s.lat, s.lng])).pad(0.4), { maxZoom: 6 }));
        m.bindTooltip(regionTip(region, list), { direction: 'top', offset: [0, -30] });
      }
    } else {
      for (const s of placed) {
        const m = L.marker([s.lat, s.lng], { icon: pin(s.health.total, HCOLOR[s.worst], MAP.sel.siteKey === key(s) ? 48 : 40, s.site) }).addTo(MAP.layer);
        m.on('click', () => selectSite(s, true));
        m.bindTooltip(regionTip(s.site, [s]), { direction: 'top', offset: [0, -24] });
      }
    }
  };
  const regionTip = (title, list) => {
    const h = { healthy: 0, warning: 0, critical: 0, offline: 0 };
    for (const s of list) for (const k of Object.keys(h)) h[k] += s.health[k];
    return `<b>${esc(title)}</b><br>${Object.entries(h).filter(([, v]) => v).map(([k, v]) => `${v} ${HLABEL[k].toLowerCase()}`).join(' · ') || 'No devices yet'}`;
  };

  const side = $('#mapSide');
  const crumbs = (parts) => `<div class="map-crumbs">${parts.map((p, i) => (p.act ? `<a href="#" data-crumb="${i}">${esc(p.label)}</a>` : `<span>${esc(p.label)}</span>`)).join(' <span class="muted">›</span> ')}</div>`;
  const showWorld = () => {
    MAP.sel = { siteKey: null, room: null };
    const byRegion = new Map();
    for (const s of sites) { const r = s.region || 'Unassigned'; if (!byRegion.has(r)) byRegion.set(r, []); byRegion.get(r).push(s); }
    side.innerHTML = `${crumbs([{ label: 'All regions' }])}<h2>Regions</h2><div class="card-sub" style="margin-bottom:12px">Click a region or site to zoom in</div>
      ${[...byRegion.entries()].map(([r, list]) => `<div class="side-group"><div class="side-title">${esc(r)} <span class="muted">${list.length} sites · ${sum(list)} devices</span></div>
        ${list.map((s) => `<button class="side-row" data-site="${esc(key(s))}">${status(s.worst)}<span class="grow">${esc(s.site)}${isAdmin() && !acting() ? `<small>${esc(s.customerName)}</small>` : ''}</span><b>${s.health.total}</b></button>`).join('')}</div>`).join('')}
      ${unplaced.length ? `<div class="notice info" style="margin-top:12px">${unplaced.length} site(s) have no coordinates: ${unplaced.map((s) => esc(s.site)).join(', ')}.${isSuper() ? ' Add them under Customers.' : ''}</div>` : ''}`;
    bindSide();
  };
  const selectSite = (s, fly) => {
    MAP.sel = { siteKey: key(s), room: null };
    if (fly && s.lat !== null) map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 11), { duration: 0.8 });
    side.innerHTML = `${crumbs([{ label: 'All regions', act: 1 }, { label: s.site }])}
      <h2>${esc(s.site)}</h2><div class="card-sub">${isAdmin() && !acting() ? `${esc(s.customerName)} · ` : ''}${esc([s.city, s.country].filter(Boolean).join(', ') || s.region)}${s.address ? `<br>${esc(s.address)}` : ''}</div>
      <div class="counts" style="display:flex;gap:12px;margin:12px 0">${HEALTH.filter((h) => s.health[h]).map((h) => `<span class="st ${h}">${ICONS[h]}${s.health[h]}</span>`).join('')}</div>
      <div class="side-title">${s.rooms.length} rooms</div>
      ${s.rooms.map((r) => `<button class="side-row" data-room="${esc(r.room)}">${status(r.worst)}<span class="grow">${esc(r.room)}<small>${esc(r.platform)} · ${r.devices.length} devices${r.hasSchematic ? ' · schematic' : ''}</small></span></button>`).join('') || '<div class="empty">No rooms yet</div>'}
      <a class="btn btn-outline btn-sm" style="margin-top:12px" href="#/estate/${encodeURIComponent(s.customerId)}/${encodeURIComponent(s.site)}">Open site page</a>`;
    bindSide(s);
    draw();
  };
  const selectRoom = async (s, r) => {
    MAP.sel = { siteKey: key(s), room: r.room };
    const sch = await api(`/api/rooms/schematic?customerId=${encodeURIComponent(s.customerId)}&site=${encodeURIComponent(s.site)}&room=${encodeURIComponent(r.room)}`).catch(() => null);
    side.innerHTML = `${crumbs([{ label: 'All regions', act: 1 }, { label: s.site, act: 1 }, { label: r.room }])}
      <h2>${esc(r.room)}</h2><div class="card-sub">${esc(r.platform)} · ${r.devices.length} devices</div>
      <div style="margin:12px 0">${r.devices.map((d) => `<button class="side-row" data-dev="${esc(d.id)}">${status(d.health)}<span class="grow">${esc(d.model)}<small>${esc(d.deviceType)}</small></span></button>`).join('') || '<div class="empty">No devices</div>'}</div>
      ${sch?.nodes?.length ? `<div class="side-title">Room schematic</div><div class="schem-mini">${schematicSVG(sch, r.devices)}</div>` : ''}
      <a class="btn btn-primary btn-sm" style="margin-top:12px" href="#/estate/${encodeURIComponent(s.customerId)}/${encodeURIComponent(s.site)}/${encodeURIComponent(r.room)}">Open room</a>`;
    bindSide(s);
  };
  function bindSide(s) {
    side.querySelectorAll('[data-crumb]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      if (a.dataset.crumb === '0') { showWorld(); if (placed.length) map.flyToBounds(L.latLngBounds(placed.map((x) => [x.lat, x.lng])).pad(0.3), { duration: 0.8 }); draw(); } else selectSite(s, true);
    }));
    side.querySelectorAll('[data-site]').forEach((b) => b.addEventListener('click', () => selectSite(sites.find((x) => key(x) === b.dataset.site), true)));
    side.querySelectorAll('[data-room]').forEach((b) => b.addEventListener('click', () => selectRoom(s, s.rooms.find((r) => r.room === b.dataset.room))));
    side.querySelectorAll('[data-dev]').forEach((b) => b.addEventListener('click', () => openDevice(b.dataset.dev)));
  }

  map.on('zoomend', draw);
  if (keepView) map.setView(center, zoom, { animate: false });
  else if (placed.length) map.fitBounds(L.latLngBounds(placed.map((x) => [x.lat, x.lng])).pad(0.3));
  draw();
  const selSite = selection.siteKey && sites.find((x) => key(x) === selection.siteKey);
  if (selSite && selection.room && selSite.rooms.some((r) => r.room === selection.room)) selectRoom(selSite, selSite.rooms.find((r) => r.room === selection.room));
  else if (selSite) selectSite(selSite, false);
  else showWorld();
  setTimeout(() => map.invalidateSize(), 50);
}

// ------------------------------------------------------------------ room schematic
const NODE_KINDS = [['core', 'Codec / video bar'], ['controller', 'Touch controller'], ['camera', 'Camera'], ['audio', 'Audio / mic'], ['display', 'Display'], ['source', 'PC / laptop / source'], ['network', 'Network'], ['peripheral', 'Other']];
const CABLES = ['HDMI', 'USB', 'USB-C', 'Ethernet', 'PoE', 'DisplayPort', 'Audio', 'Power', 'Wireless'];
const CABLE_STYLE = {
  HDMI: ['#1a5cff', ''], USB: ['#6b4bff', ''], 'USB-C': ['#9b7bff', ''], Ethernet: ['#0d8fb3', ''], PoE: ['#0b1d4d', '6 4'],
  DisplayPort: ['#3b77ff', '6 4'], Audio: ['#b4318f', ''], Power: ['#4a5373', '2 4'], Wireless: ['#7d849e', '1 5'],
};
const COLUMN = { source: 0, network: 0, core: 1, controller: 2, camera: 2, audio: 2, peripheral: 2, display: 3 };

function layoutSchematic(sch) {
  const W = 190; const H = 58; const GX = 90; const GY = 30;
  const cols = [[], [], [], []];
  for (const n of sch.nodes) cols[COLUMN[n.kind] ?? 2].push(n);
  // Network gear sits below sources in the first column.
  cols[0].sort((a, b) => (a.kind === 'network') - (b.kind === 'network'));
  const pos = {};
  const maxRows = Math.max(1, ...cols.map((c) => c.length));
  cols.forEach((col, ci) => {
    const offset = ((maxRows - col.length) * (H + GY)) / 2;
    col.forEach((n, ri) => {
      pos[n.id] = Number.isFinite(n.x) ? { x: n.x, y: n.y } : { x: 20 + ci * (W + GX), y: 20 + offset + ri * (H + GY) };
    });
  });
  const width = Math.max(...Object.values(pos).map((p) => p.x + W), 300) + 20;
  const height = Math.max(...Object.values(pos).map((p) => p.y + H), 120) + 20;
  return { pos, W, H, width, height };
}

function schematicSVG(sch, devices = []) {
  if (!sch?.nodes?.length) return '<div class="empty">No schematic yet</div>';
  const { pos, W, H, width, height } = layoutSchematic(sch);
  const devById = new Map(devices.map((d) => [d.id, d]));
  const usedCables = [...new Set(sch.links.map((l) => l.cable))];
  const linkSvg = sch.links.map((l, i) => {
    const a = pos[l.from]; const b = pos[l.to];
    if (!a || !b) return '';
    const leftToRight = a.x <= b.x;
    const x1 = leftToRight ? a.x + W : a.x; const x2 = leftToRight ? b.x : b.x + W;
    const sameCol = Math.abs(a.x - b.x) < 5;
    const y1 = a.y + H / 2 + ((i % 3) - 1) * 8; const y2 = b.y + H / 2 + ((i % 3) - 1) * 8;
    const dx = sameCol ? 70 : Math.max(40, Math.abs(x2 - x1) / 2);
    const sx1 = sameCol ? a.x + W : x1; const sx2 = sameCol ? b.x + W : x2;
    const d = sameCol
      ? `M${sx1},${y1} C${sx1 + dx},${y1} ${sx2 + dx},${y2} ${sx2},${y2}`
      : `M${x1},${y1} C${x1 + (leftToRight ? dx : -dx)},${y1} ${x2 - (leftToRight ? dx : -dx)},${y2} ${x2},${y2}`;
    const [color, dash] = CABLE_STYLE[l.cable] || ['#7d849e', ''];
    const mx = sameCol ? sx1 + dx * 0.75 : (x1 + x2) / 2; const my = (y1 + y2) / 2;
    const title = `${l.cable}: ${sch.nodes.find((n) => n.id === l.from)?.label}${l.fromPort ? ` (${l.fromPort})` : ''} → ${sch.nodes.find((n) => n.id === l.to)?.label}${l.toPort ? ` (${l.toPort})` : ''}${l.note ? ` · ${l.note}` : ''}`;
    return `<g class="schem-link"><title>${esc(title)}</title><path d="${d}" stroke="${color}" stroke-width="2.4" fill="none" stroke-dasharray="${dash}" marker-end="url(#arr)"/>
      <rect x="${mx - 34}" y="${my - 10}" width="68" height="20" rx="10" fill="#fff" stroke="${color}"/><text x="${mx}" y="${my + 4}" text-anchor="middle" class="schem-cable" fill="${color}">${esc(l.cable)}</text></g>`;
  }).join('');
  const nodeSvg = sch.nodes.map((n) => {
    const p = pos[n.id];
    const dev = n.deviceId ? devById.get(n.deviceId) : null;
    const kindLabel = NODE_KINDS.find(([k]) => k === n.kind)?.[1] || n.kind;
    const ports = sch.links.filter((l) => l.from === n.id || l.to === n.id).map((l) => (l.from === n.id ? l.fromPort : l.toPort)).filter(Boolean);
    return `<g class="schem-node"><title>${esc(n.label)}${n.model ? ` · ${n.model}` : ''}${ports.length ? `\nPorts: ${ports.join(', ')}` : ''}</title>
      <rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="12" fill="#fff" stroke="${dev ? HCOLOR[dev.health] : '#d5dbea'}" stroke-width="${dev ? 2.5 : 1.2}"/>
      <rect x="${p.x}" y="${p.y}" width="6" height="${H}" rx="3" fill="${n.kind === 'core' ? '#1a5cff' : n.kind === 'display' ? '#0b1d4d' : n.kind === 'network' ? '#0d8fb3' : '#b9c3e0'}"/>
      <text x="${p.x + 16}" y="${p.y + 24}" class="schem-label">${esc(n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label)}</text>
      <text x="${p.x + 16}" y="${p.y + 42}" class="schem-sub">${esc(dev ? `${HLABEL[dev.health]} · ${kindLabel}` : kindLabel)}</text>
      ${dev ? `<circle cx="${p.x + W - 14}" cy="${p.y + 14}" r="5" fill="${HCOLOR[dev.health]}"/>` : ''}</g>`;
  }).join('');
  return `<svg class="schem-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Room schematic">
    <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#7d849e"/></marker></defs>
    ${linkSvg}${nodeSvg}</svg>
    <div class="legend" style="margin-top:8px">${usedCables.map((c) => `<span><i style="background:${(CABLE_STYLE[c] || ['#7d849e'])[0]}"></i>${esc(c)}</span>`).join('')}<span class="muted">Hover a cable or item for ports</span></div>`;
}

async function mountSchematic(card, ctx) {
  const { customerId, site, room, devices } = ctx;
  const q = `customerId=${encodeURIComponent(customerId)}&site=${encodeURIComponent(site)}&room=${encodeURIComponent(room)}`;
  const [saved, templates] = await Promise.all([api(`/api/rooms/schematic?${q}`), S.templates || api('/api/schematic-templates')]);
  S.templates = templates;
  let draft = saved ? structuredClone(saved) : { nodes: [], links: [] };
  let editing = false;
  S.schematicDirty = false;
  const nid = () => { let i = draft.nodes.length + 1; while (draft.nodes.some((n) => n.id === `n${i}`)) i++; return `n${i}`; };

  const render = () => {
    const nodeOpts = draft.nodes.map((n) => `<option value="${esc(n.id)}">${esc(n.label)}</option>`).join('');
    card.innerHTML = `<div class="card-head"><div><h2>Room schematic</h2><div class="card-sub">How the room is cabled: which device plugs into which, and on which port${saved?.updatedAt ? ` · saved ${ago(saved.updatedAt)}` : ''}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${draft.nodes.length ? '<button class="btn btn-outline btn-sm" id="scExport">Export JSON</button>' : ''}${isAdmin() && !editing ? `<button class="btn btn-primary btn-sm" id="scEdit">${draft.nodes.length ? 'Edit schematic' : 'Create schematic'}</button>` : ''}</div></div>
      <div class="schem-wrap">${schematicSVG(draft, devices)}</div>
      ${editing ? `
      <div class="schem-tools">
        <div class="field"><label>Start from a template</label><div style="display:flex;gap:8px"><select id="scTpl"><option value="">Choose a room type…</option>${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select><button class="btn btn-outline btn-sm" id="scTplGo">Apply</button></div></div>
        <div class="field"><label>Or load a file</label><div style="display:flex;gap:8px;align-items:center"><input type="file" id="scFile" accept="application/json,.json"></div><div class="help">A JSON file exported from another room, or prepared during onboarding.</div></div>
        <button class="btn btn-outline btn-sm" id="scAddDevs">Add this room's devices</button>
      </div>
      <div class="section-title">Items in the room</div>
      <div class="table-wrap schem-table"><table><thead><tr><th>Name</th><th>Type</th><th>Model</th><th>Linked device</th><th></th></tr></thead><tbody>
        ${draft.nodes.map((n, i) => `<tr><td><input data-n="${i}" data-f="label" value="${esc(n.label)}"></td>
          <td><select data-n="${i}" data-f="kind">${NODE_KINDS.map(([k, l]) => `<option value="${k}" ${k === n.kind ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          <td><input data-n="${i}" data-f="model" value="${esc(n.model || '')}"></td>
          <td><select data-n="${i}" data-f="deviceId"><option value="">None</option>${devices.map((d) => `<option value="${esc(d.id)}" ${d.id === n.deviceId ? 'selected' : ''}>${esc(d.model)}${d.serial ? ` (${esc(d.serial)})` : ''}</option>`).join('')}</select></td>
          <td><button class="linkbtn" data-delnode="${i}">Remove</button></td></tr>`).join('')}
      </tbody></table></div>
      <button class="btn btn-outline btn-sm" id="scAddNode" style="margin-top:10px">Add item</button>
      <div class="section-title">Connections</div>
      <div class="table-wrap schem-table"><table><thead><tr><th>From</th><th>Port</th><th>Cable</th><th>To</th><th>Port</th><th>Note</th><th></th></tr></thead><tbody>
        ${draft.links.map((l, i) => `<tr>
          <td><select data-l="${i}" data-f="from">${draft.nodes.map((n) => `<option value="${esc(n.id)}" ${n.id === l.from ? 'selected' : ''}>${esc(n.label)}</option>`).join('')}</select></td>
          <td><input data-l="${i}" data-f="fromPort" value="${esc(l.fromPort || '')}" placeholder="e.g. HDMI out 1"></td>
          <td><select data-l="${i}" data-f="cable">${CABLES.map((c) => `<option ${c === l.cable ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
          <td><select data-l="${i}" data-f="to">${draft.nodes.map((n) => `<option value="${esc(n.id)}" ${n.id === l.to ? 'selected' : ''}>${esc(n.label)}</option>`).join('')}</select></td>
          <td><input data-l="${i}" data-f="toPort" value="${esc(l.toPort || '')}" placeholder="e.g. HDMI 1"></td>
          <td><input data-l="${i}" data-f="note" value="${esc(l.note || '')}"></td>
          <td><button class="linkbtn" data-dellink="${i}">Remove</button></td></tr>`).join('')}
      </tbody></table></div>
      ${draft.nodes.length >= 2 ? `<div class="add-link"><select id="lkFrom">${nodeOpts}</select><select id="lkCable">${CABLES.map((c) => `<option>${c}</option>`).join('')}</select><select id="lkTo">${nodeOpts}</select><button class="btn btn-outline btn-sm" id="scAddLink">Add connection</button></div>` : '<div class="muted">Add at least two items to connect them.</div>'}
      <div id="scMsg"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap">
        ${saved ? '<button class="btn btn-danger btn-sm" id="scDelete" style="margin-right:auto">Delete schematic</button>' : ''}
        <button class="btn btn-outline btn-sm" id="scCancel">Cancel</button><button class="btn btn-primary btn-sm" id="scSave">Save schematic</button></div>` : ''}`;
    bind();
  };
  const dirty = () => { S.schematicDirty = true; };
  const bind = () => {
    $('#scEdit', card)?.addEventListener('click', () => { editing = true; render(); });
    $('#scExport', card)?.addEventListener('click', () => {
      const { updatedAt, ...clean } = draft;
      const blob = new Blob([JSON.stringify({ site, room, ...clean }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${site}-${room}-schematic.json`.replace(/[^a-z0-9.-]+/gi, '_'); a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    if (!editing) return;
    card.querySelectorAll('[data-n]').forEach((el) => el.addEventListener('change', () => {
      const n = draft.nodes[Number(el.dataset.n)];
      n[el.dataset.f] = el.value || undefined;
      if (el.dataset.f === 'deviceId' && el.value) { const d = devices.find((x) => x.id === el.value); if (d && !n.model) n.model = d.model; }
      dirty(); render();
    }));
    card.querySelectorAll('[data-l]').forEach((el) => el.addEventListener('change', () => { draft.links[Number(el.dataset.l)][el.dataset.f] = el.value || undefined; dirty(); render(); }));
    card.querySelectorAll('[data-delnode]').forEach((b) => b.addEventListener('click', () => {
      const [n] = draft.nodes.splice(Number(b.dataset.delnode), 1);
      draft.links = draft.links.filter((l) => l.from !== n.id && l.to !== n.id); dirty(); render();
    }));
    card.querySelectorAll('[data-dellink]').forEach((b) => b.addEventListener('click', () => { draft.links.splice(Number(b.dataset.dellink), 1); dirty(); render(); }));
    $('#scAddNode', card).addEventListener('click', () => { draft.nodes.push({ id: nid(), label: 'New item', kind: 'peripheral' }); dirty(); render(); });
    $('#scAddLink', card)?.addEventListener('click', () => {
      const from = $('#lkFrom', card).value; const to = $('#lkTo', card).value;
      if (from === to) { $('#scMsg', card).innerHTML = '<div class="notice err">Pick two different items.</div>'; return; }
      draft.links.push({ from, to, cable: $('#lkCable', card).value }); dirty(); render();
    });
    $('#scAddDevs', card).addEventListener('click', () => {
      for (const d of devices) {
        if (draft.nodes.some((n) => n.deviceId === d.id)) continue;
        const kind = { 'Video bar': 'core', 'Video system': 'core', 'Touch controller': 'controller', Camera: 'camera', 'Whiteboard camera': 'camera', 'Conference phone': 'audio', 'Room PC': 'source', 'Room sensor': 'peripheral', Display: 'display' }[d.deviceType] || 'peripheral';
        draft.nodes.push({ id: nid(), label: d.model, kind, model: d.model, deviceId: d.id });
      }
      dirty(); render();
    });
    $('#scTplGo', card).addEventListener('click', () => {
      const t = templates.find((x) => x.id === $('#scTpl', card).value);
      if (!t) return;
      draft = structuredClone(t.schematic);
      // Link template items to devices in the room with a matching model.
      for (const n of draft.nodes) { const d = devices.find((x) => n.model && x.model === n.model && !draft.nodes.some((m) => m.deviceId === x.id)); if (d) n.deviceId = d.id; }
      dirty(); render();
    });
    $('#scFile', card).addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { const j = JSON.parse(await f.text()); if (!Array.isArray(j.nodes)) throw new Error('The file has no "nodes" list'); draft = { nodes: j.nodes, links: j.links || [] }; dirty(); render(); } catch (err) { $('#scMsg', card).innerHTML = `<div class="notice err">Could not read that file: ${esc(err.message)}</div>`; }
    });
    $('#scCancel', card).addEventListener('click', () => { draft = saved ? structuredClone(saved) : { nodes: [], links: [] }; editing = false; S.schematicDirty = false; render(); });
    $('#scDelete', card)?.addEventListener('click', async (e) => {
      if (!e.target.dataset.confirm) { e.target.dataset.confirm = 1; e.target.textContent = 'Click again to delete'; return; }
      await api('/api/rooms/schematic', { method: 'PUT', body: { customerId, site, room, schematic: null } });
      S.schematicDirty = false; toast(ICONS.resolved, 'Schematic deleted'); mountSchematic(card, ctx);
    });
    $('#scSave', card).addEventListener('click', async () => {
      try {
        await api('/api/rooms/schematic', { method: 'PUT', body: { customerId, site, room, schematic: draft } });
        S.schematicDirty = false; toast(ICONS.resolved, 'Schematic saved'); mountSchematic(card, ctx);
      } catch (err) { $('#scMsg', card).innerHTML = `<div class="notice err">${esc(err.message)}</div>`; }
    });
  };
  render();
}

// ------------------------------------------------------------------ customers & onboarding (super admin)
const CITY_PRESETS = [
  ['London', 'United Kingdom', 'EMEA', 51.5074, -0.1278], ['Manchester', 'United Kingdom', 'EMEA', 53.4808, -2.2426], ['Edinburgh', 'United Kingdom', 'EMEA', 55.9533, -3.1883],
  ['Dublin', 'Ireland', 'EMEA', 53.3498, -6.2603], ['Paris', 'France', 'EMEA', 48.8566, 2.3522], ['Frankfurt', 'Germany', 'EMEA', 50.1109, 8.6821], ['Munich', 'Germany', 'EMEA', 48.1351, 11.582],
  ['Amsterdam', 'Netherlands', 'EMEA', 52.3676, 4.9041], ['Madrid', 'Spain', 'EMEA', 40.4168, -3.7038], ['Milan', 'Italy', 'EMEA', 45.4642, 9.19], ['Zurich', 'Switzerland', 'EMEA', 47.3769, 8.5417],
  ['Stockholm', 'Sweden', 'EMEA', 59.3293, 18.0686], ['Dubai', 'United Arab Emirates', 'EMEA', 25.2048, 55.2708], ['Johannesburg', 'South Africa', 'EMEA', -26.2041, 28.0473],
  ['New York', 'United States', 'AMER', 40.7128, -74.006], ['Chicago', 'United States', 'AMER', 41.8781, -87.6298], ['San Francisco', 'United States', 'AMER', 37.7749, -122.4194],
  ['Dallas', 'United States', 'AMER', 32.7767, -96.797], ['Toronto', 'Canada', 'AMER', 43.6532, -79.3832], ['São Paulo', 'Brazil', 'AMER', -23.5505, -46.6333], ['Mexico City', 'Mexico', 'AMER', 19.4326, -99.1332],
  ['Mumbai', 'India', 'APAC', 19.076, 72.8777], ['Bengaluru', 'India', 'APAC', 12.9716, 77.5946], ['Pune', 'India', 'APAC', 18.5204, 73.8567], ['Chennai', 'India', 'APAC', 13.0827, 80.2707],
  ['Singapore', 'Singapore', 'APAC', 1.3521, 103.8198], ['Hong Kong', 'Hong Kong', 'APAC', 22.3193, 114.1694], ['Tokyo', 'Japan', 'APAC', 35.6762, 139.6503], ['Sydney', 'Australia', 'APAC', -33.8688, 151.2093],
];

async function viewCustomers() {
  const list = await api('/api/admin/customers');
  hero('Customers', `${list.length} customers. Onboard a new customer, add its users, or enter a customer to see exactly what they see.`);
  $('#view').innerHTML = `
    <div class="cta"><div><h3>Onboard a new customer</h3><p>Add the customer, its sites (for the map), user logins, OEM connections and room schematics in one go.</p></div>
      <div><button class="btn btn-grad" id="onboard">Onboard customer</button></div></div>
    <div class="conn-grid">${list.map((c) => `
      <div class="conn-card">
        <div class="conn-top"><div class="oem-logo" style="background:var(--grad)">${esc(c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join(''))}</div>
          <div><div class="sync-name">${esc(c.name)}</div><div class="sync-meta">${c.sites.length} sites · ${c.users.length} users · ${c.connections.length} connections</div></div>
          ${status(c.health.total ? ['critical', 'offline', 'warning', 'healthy'].find((h) => c.health[h]) : 'none')}</div>
        <div class="brk-bar" style="height:8px">${HEALTH.filter((h) => c.health[h]).map((h) => `<span class="f-${h}" style="flex:${c.health[h]}"></span>`).join('')}</div>
        <div class="conn-stats"><div><span class="muted">Devices</span><b>${c.deviceCount}</b></div><div><span class="muted">Sites</span><b>${c.sites.length}</b></div><div><span class="muted">Platforms</span><b style="font-size:12px">${esc((c.platforms || []).join(', ') || '—')}</b></div></div>
        <div class="conn-actions"><button class="btn btn-primary btn-sm" data-enter="${esc(c.id)}">Enter customer</button><button class="btn btn-outline btn-sm" data-edit="${esc(c.id)}">Sites &amp; users</button></div>
      </div>`).join('')}</div>`;
  $('#onboard').addEventListener('click', () => openOnboarding());
  document.querySelectorAll('[data-enter]').forEach((b) => b.addEventListener('click', () => enterCustomer(b.dataset.enter)));
  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openCustomerEdit(list.find((c) => c.id === b.dataset.edit))));
}

function siteRow(s = {}, i) {
  return `<div class="site-row" data-site-row="${i}">
    <select data-k="preset" aria-label="City preset"><option value="">City preset…</option>${CITY_PRESETS.map(([c, co], j) => `<option value="${j}">${esc(c)}, ${esc(co)}</option>`).join('')}</select>
    <input data-k="name" placeholder="Site name *" value="${esc(s.name || '')}">
    <select data-k="region">${['EMEA', 'AMER', 'APAC', 'LATAM', 'Unassigned'].map((r) => `<option ${r === (s.region || 'EMEA') ? 'selected' : ''}>${r}</option>`).join('')}</select>
    <input data-k="city" placeholder="City" value="${esc(s.city || '')}">
    <input data-k="country" placeholder="Country" value="${esc(s.country || '')}">
    <input data-k="address" placeholder="Address (optional)" value="${esc(s.address || '')}">
    <input data-k="lat" placeholder="Latitude" value="${esc(s.lat ?? '')}">
    <input data-k="lng" placeholder="Longitude" value="${esc(s.lng ?? '')}">
    <input data-k="mockRooms" placeholder="Mock rooms" title="Rooms of sample devices to generate while the connections are in mock mode" value="${esc(s.mockRooms ?? 4)}">
    <button class="linkbtn" data-remove-row>Remove</button></div>`;
}
function readSites(root) {
  return [...root.querySelectorAll('[data-site-row]')].map((r) => Object.fromEntries([...r.querySelectorAll('[data-k]')].filter((i) => i.dataset.k !== 'preset').map((i) => [i.dataset.k, i.value.trim()]))).filter((s) => s.name);
}
function bindSiteRows(root, onChange) {
  root.querySelectorAll('[data-site-row]').forEach((row) => {
    row.querySelector('[data-k=preset]').addEventListener('change', (e) => {
      const p = CITY_PRESETS[Number(e.target.value)]; if (!p) return;
      const set = (k, v) => { row.querySelector(`[data-k=${k}]`).value = v; };
      if (!row.querySelector('[data-k=name]').value) set('name', p[0]);
      set('city', p[0]); set('country', p[1]); set('region', p[2]); set('lat', p[3]); set('lng', p[4]);
      onChange?.();
    });
    row.querySelector('[data-k=name]').addEventListener('change', () => onChange?.());
    row.querySelector('[data-remove-row]').addEventListener('click', () => { row.remove(); onChange?.(); });
  });
}

function openOnboarding() {
  const state = { sites: [{}], users: [{}], rooms: [] };
  const w = drawer('Onboard customer', 'Everything here can be changed later', `
    <div id="obMsg"></div>
    <div class="step"><span>1</span>Customer</div>
    <div class="field"><label>Customer name *</label><input id="obName" placeholder="e.g. Contoso Group"></div>
    <div class="field"><label>Meeting platforms used</label><div class="chk-row">${PLATFORM_LIST.filter((p) => p !== 'Unassigned').map((p) => `<label><input type="checkbox" class="obPlat" value="${p}" checked> ${p}</label>`).join('')}</div></div>
    <div class="step"><span>2</span>Sites</div>
    <div class="help" style="margin-bottom:8px">Pick a city preset to fill in the map coordinates, or type them. Sites with coordinates appear on the map.</div>
    <div id="obSites"></div><button class="btn btn-outline btn-sm" id="obAddSite">Add site</button>
    <div class="step"><span>3</span>Customer logins</div>
    <div class="help" style="margin-bottom:8px">These users only ever see this customer's devices.</div>
    <div id="obUsers"></div><button class="btn btn-outline btn-sm" id="obAddUser">Add user</button>
    <div class="step"><span>4</span>Connections</div>
    <div class="help" style="margin-bottom:6px">Manufacturer clouds</div>
    <div class="chk-row">${S.connectors.filter((c) => c.kind !== 'platform').map((c) => `<label><input type="checkbox" class="obConn" value="${c.oem}" checked> ${esc(c.displayName)}</label>`).join('')}</div>
    <div class="help" style="margin:10px 0 6px">Meeting-platform portals</div>
    <div class="chk-row">${S.connectors.filter((c) => c.kind === 'platform').map((c) => `<label><input type="checkbox" class="obConn" value="${c.oem}" checked> ${esc(c.displayName)}${c.liveSupported === false ? ' <span class="muted">(mock only)</span>' : ''}</label>`).join('')}</div>
    <div class="help">Connections start on mock data. Add the API keys afterwards on the Connections page to go live.</div>
    <div class="step"><span>5</span>Rooms and schematics (optional)</div>
    <div class="help" style="margin-bottom:8px">Pre-load rooms with their platform and cabling, from a template or a JSON file. Devices can be grouped into these rooms later.</div>
    <div id="obRooms"></div><button class="btn btn-outline btn-sm" id="obAddRoom">Add room</button>`,
  '<button class="btn btn-primary" id="obGo">Create customer</button>');
  w.querySelector('.drawer').classList.add('wide');
  const renderSites = () => {
    const cur = $('#obSites', w).children.length ? readSitesAll() : state.sites;
    $('#obSites', w).innerHTML = cur.map((s, i) => siteRow(s, i)).join('');
    bindSiteRows($('#obSites', w), renderRoomsSiteOptions);
  };
  const readSitesAll = () => [...$('#obSites', w).querySelectorAll('[data-site-row]')].map((r) => Object.fromEntries([...r.querySelectorAll('[data-k]')].filter((i) => i.dataset.k !== 'preset').map((i) => [i.dataset.k, i.value.trim()])));
  const userRow = (u = {}) => `<div class="user-row"><input data-u="email" type="email" placeholder="Email *" value="${esc(u.email || '')}"><input data-u="name" placeholder="Name" value="${esc(u.name || '')}"><input data-u="password" type="password" placeholder="Password (8+ characters) *" autocomplete="new-password"><button class="linkbtn" data-remove-row>Remove</button></div>`;
  const roomRow = () => `<div class="room-row"><select data-r="site"></select><input data-r="room" placeholder="Room name *"><select data-r="platform"><option value="">Platform…</option>${PLATFORM_LIST.filter((p) => p !== 'Unassigned').map((p) => `<option>${p}</option>`).join('')}</select>
    <select data-r="template"><option value="">No schematic</option>${(S.templates || []).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}<option value="file">Load from JSON file…</option></select>
    <input type="file" data-r="file" accept=".json,application/json" class="hidden"><button class="linkbtn" data-remove-row>Remove</button></div>`;
  function renderRoomsSiteOptions() {
    const names = readSitesAll().map((s) => s.name).filter(Boolean);
    $('#obRooms', w).querySelectorAll('[data-r=site]').forEach((sel) => { const v = sel.value; sel.innerHTML = names.map((n) => `<option ${n === v ? 'selected' : ''}>${esc(n)}</option>`).join('') || '<option value="">Add a site first</option>'; });
  }
  const bindRemove = (root) => root.querySelectorAll('[data-remove-row]').forEach((b) => { b.onclick = () => b.parentElement.remove(); });
  renderSites();
  $('#obUsers', w).innerHTML = userRow(); bindRemove($('#obUsers', w));
  $('#obAddSite', w).addEventListener('click', () => { $('#obSites', w).insertAdjacentHTML('beforeend', siteRow({}, Date.now())); bindSiteRows($('#obSites', w), renderRoomsSiteOptions); });
  $('#obAddUser', w).addEventListener('click', () => { $('#obUsers', w).insertAdjacentHTML('beforeend', userRow()); bindRemove($('#obUsers', w)); });
  $('#obAddRoom', w).addEventListener('click', async () => {
    S.templates = S.templates || await api('/api/schematic-templates');
    $('#obRooms', w).insertAdjacentHTML('beforeend', roomRow());
    const row = $('#obRooms', w).lastElementChild;
    row.querySelector('[data-r=template]').addEventListener('change', (e) => row.querySelector('[data-r=file]').classList.toggle('hidden', e.target.value !== 'file'));
    bindRemove($('#obRooms', w)); renderRoomsSiteOptions();
  });
  $('#obGo', w).addEventListener('click', async (e) => {
    const msg = (t) => { $('#obMsg', w).innerHTML = `<div class="notice err">${esc(t)}</div>`; w.querySelector('.drawer-body').scrollTop = 0; };
    try {
      const rooms = [];
      for (const row of $('#obRooms', w).querySelectorAll('.room-row')) {
        const get = (k) => row.querySelector(`[data-r=${k}]`);
        if (!get('room').value.trim()) continue;
        let schematic = null;
        if (get('template').value === 'file') {
          const f = get('file').files[0];
          if (f) { const j = JSON.parse(await f.text()); schematic = { nodes: j.nodes || [], links: j.links || [] }; }
        } else if (get('template').value) schematic = S.templates.find((t) => t.id === get('template').value)?.schematic;
        rooms.push({ site: get('site').value, room: get('room').value.trim(), platform: get('platform').value || null, schematic });
      }
      const body = {
        name: $('#obName', w).value.trim(),
        platforms: [...w.querySelectorAll('.obPlat:checked')].map((c) => c.value),
        sites: readSites($('#obSites', w)),
        users: [...$('#obUsers', w).querySelectorAll('.user-row')].map((r) => Object.fromEntries([...r.querySelectorAll('[data-u]')].map((i) => [i.dataset.u, i.value.trim()]))).filter((u) => u.email),
        connections: [...w.querySelectorAll('.obConn:checked')].map((c) => c.value),
        rooms,
      };
      if (!body.name) return msg('Enter the customer name.');
      if (!body.sites.length) return msg('Add at least one site.');
      e.target.disabled = true; e.target.textContent = 'Creating…';
      const c = await api('/api/admin/customers', { method: 'POST', body });
      closeDrawer();
      toast(ICONS.resolved, `${c.name} onboarded with ${c.deviceCount} mock devices`);
      S.customers = await api('/api/customers');
      S.options = await api('/api/filters');
      renderShell(); navigate();
    } catch (err) { msg(err.message); e.target.disabled = false; e.target.textContent = 'Create customer'; }
  });
}

function openCustomerEdit(c) {
  const w = drawer(c.name, 'Sites, users and customer details', `
    <div id="ceMsg"></div>
    <div class="grid cols-2" style="gap:10px"><div class="field"><label>Customer name</label><input id="ceName" value="${esc(c.name)}"></div>
      <div class="field"><label>SLA availability target (%)</label><input id="ceSla" type="number" step="0.01" min="50" max="100" value="${esc(c.slaTarget ?? 99.5)}"><div class="help">Shown against measured availability on the SLA tab.</div></div></div>
    <div class="section-title">Sites</div>
    <div id="ceSites">${c.sites.map((s, i) => siteRow(s, i)).join('')}</div>
    <button class="btn btn-outline btn-sm" id="ceAddSite">Add site</button>
    <div class="section-title">Users</div>
    ${c.users.map((u) => `<div class="side-row" style="cursor:default"><span class="grow">${esc(u.name)}<small>${esc(u.email)}</small></span><button class="linkbtn" data-deluser="${esc(u.id)}">Remove</button></div>`).join('') || '<div class="muted">No users yet</div>'}
    <div class="user-row" style="margin-top:10px"><input id="nuEmail" type="email" placeholder="Email"><input id="nuName" placeholder="Name"><input id="nuPw" type="password" placeholder="Password (8+ characters)" autocomplete="new-password"><button class="btn btn-outline btn-sm" id="nuAdd">Add user</button></div>
    <div class="section-title">Connections</div>
    ${c.connections.map((x) => `<div class="side-row" style="cursor:default"><span class="grow">${esc(x.name)}<small>${x.mode === 'live' ? 'Live' : 'Mock data'} · ${x.status.deviceCount} devices</small></span>${syncState(x.status)}</div>`).join('')}
    <div class="help">Manage API keys on the Connections page.</div>`,
  `<button class="btn btn-danger" id="ceDel" style="margin-right:auto">Delete customer</button><button class="btn btn-primary" id="ceSave">Save</button>`);
  w.querySelector('.drawer').classList.add('wide');
  const msg = (t, ok) => { $('#ceMsg', w).innerHTML = `<div class="notice ${ok ? 'ok' : 'err'}">${esc(t)}</div>`; w.querySelector('.drawer-body').scrollTop = 0; };
  bindSiteRows($('#ceSites', w));
  $('#ceAddSite', w).addEventListener('click', () => { $('#ceSites', w).insertAdjacentHTML('beforeend', siteRow({}, Date.now())); bindSiteRows($('#ceSites', w)); });
  $('#ceSave', w).addEventListener('click', async () => {
    try { await api(`/api/admin/customers/${c.id}`, { method: 'PUT', body: { name: $('#ceName', w).value, slaTarget: Number($('#ceSla', w).value), sites: readSites($('#ceSites', w)) } }); closeDrawer(); toast(ICONS.resolved, 'Customer saved'); S.customers = await api('/api/customers'); viewCustomers(); } catch (e) { msg(e.message); }
  });
  $('#nuAdd', w).addEventListener('click', async () => {
    try { const u = await api(`/api/admin/customers/${c.id}/users`, { method: 'POST', body: { email: $('#nuEmail', w).value, name: $('#nuName', w).value, password: $('#nuPw', w).value } }); openCustomerEdit(u); toast(ICONS.resolved, 'User added'); } catch (e) { msg(e.message); }
  });
  w.querySelectorAll('[data-deluser]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/admin/users/${b.dataset.deluser}`, { method: 'DELETE' });
    const fresh = (await api('/api/admin/customers')).find((x) => x.id === c.id); openCustomerEdit(fresh);
  }));
  $('#ceDel', w).addEventListener('click', async (e) => {
    if (!e.target.dataset.confirm) { e.target.dataset.confirm = 1; e.target.textContent = `Click again to delete ${c.name}`; return; }
    await api(`/api/admin/customers/${c.id}`, { method: 'DELETE' });
    closeDrawer(); toast(ICONS.resolved, `${c.name} deleted`);
    S.customers = await api('/api/customers'); S.options = await api('/api/filters'); viewCustomers();
  });
}

// ------------------------------------------------------------------ lifecycle helpers
const FW_LABEL = { compliant: 'At baseline', ahead: 'Ahead of baseline', behind: 'Below baseline', 'no-baseline': 'No baseline set', uncatalogued: 'Model not in master', unknown: 'Not reported' };
const FW_TONE = { compliant: 'good', ahead: 'good', behind: 'crit', 'no-baseline': 'mute', uncatalogued: 'mute', unknown: 'mute' };
const W_LABEL = { active: 'In warranty', expiring: 'Expires within 90 days', expired: 'Expired', unknown: 'Not recorded' };
const W_TONE = { active: 'good', expiring: 'warn', expired: 'crit', unknown: 'mute' };
const LC_LABEL = { supported: 'Supported', soon: 'Milestone within 12 months', eosale: 'End of sale', eos: 'End of support', eol: 'End of life', nodates: 'No lifecycle dates', unknown: 'Not in model master' };
const LC_TONE = { supported: 'good', soon: 'warn', eosale: 'warn', eos: 'crit', eol: 'crit', nodates: 'mute', unknown: 'mute' };
const chip = (text, tone) => `<span class="chip ${tone || 'mute'}">${esc(text)}</span>`;
const fmtDate = (v) => {
  if (!v) return '—';
  const d = new Date(String(v).length === 10 ? `${v}T00:00:00Z` : v);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', ...(String(v).length === 10 ? { timeZone: 'UTC' } : {}) });
};
const fmtDateTime = (v) => new Date(v).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const shortModel = (make, model) => String(model).replace(new RegExp(`^${make}\\s+`, 'i'), '');
function cmpVer(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function statTile(label, value, sub, tone) {
  return `<div class="stat ${tone || ''}"><div class="lbl">${label}</div><div class="val">${value}</div>${sub ? `<div class="pct">${sub}</div>` : ''}</div>`;
}
function barList(rows, total) {
  return `<div class="barlist">${rows.map((r) => `<div class="barrow"><span class="grow">${esc(r.label)}</span><b>${r.n}</b>
    <span class="bartrack"><span class="tone-${r.tone}" style="width:${total ? Math.max((r.n / total) * 100, r.n ? 1.5 : 0) : 0}%"></span></span></div>`).join('')}</div>`;
}
function lifecycleSection(d) {
  const lc = d.lifecycle || {};
  return `<div class="section-title">Firmware, warranty and lifecycle</div>
    <dl class="kv">
      <dt>Firmware</dt><dd><span class="mono">${esc(d.firmware || '—')}</span> ${chip(FW_LABEL[d.firmwareStatus] || 'Unknown', FW_TONE[d.firmwareStatus])}</dd>
      <dt>Approved baseline</dt><dd class="mono">${esc(d.baseline || '—')}</dd>
      <dt>Warranty</dt><dd>${chip(W_LABEL[d.warrantyStatus] || 'Not recorded', W_TONE[d.warrantyStatus])} ${d.warrantyExpires ? `until ${fmtDate(d.warrantyExpires)}` : ''}
        ${d.warrantyType || d.warrantySource ? `<div class="muted" style="font-size:12px">${esc([d.warrantyType, d.warrantySource && `from ${d.warrantySource}`].filter(Boolean).join(' · '))}</div>` : ''}</dd>
      ${d.contractRef ? `<dt>Contract</dt><dd class="mono">${esc(d.contractRef)}</dd>` : ''}
      ${d.purchaseDate ? `<dt>Purchased</dt><dd>${fmtDate(d.purchaseDate)}</dd>` : ''}
      <dt>Lifecycle</dt><dd>${chip(lc.label || 'Unknown', LC_TONE[lc.stage])}</dd>
      <dt>End of sale</dt><dd>${fmtDate(lc.endOfSale)}</dd>
      <dt>End of support</dt><dd>${fmtDate(lc.endOfSupport)}</dd>
      <dt>End of life</dt><dd>${fmtDate(lc.endOfLife)}</dd>
    </dl>`;
}

// ------------------------------------------------------------------ lifecycle view
async function viewLifecycle() {
  const lc = await api(`/api/lifecycle${qs()}`);
  hero('Lifecycle', `Firmware against the approved baseline, warranty cover, and end-of-sale, support and life dates from the model master. ${lc.total} devices.`);
  const n = (o, k) => o[k] || 0;
  const f = lc.firmware; const w = lc.warranty; const l = lc.lifecycle;
  const rated = n(f, 'compliant') + n(f, 'ahead') + n(f, 'behind');
  const compliance = rated ? `${(((n(f, 'compliant') + n(f, 'ahead')) / rated) * 100).toFixed(1)}%` : '—';
  const pastSupport = n(l, 'eos') + n(l, 'eol');
  $('#view').innerHTML = `
    <div class="stats">
      ${statTile('Firmware compliance', compliance, `${n(f, 'behind')} devices below baseline · ${rated} with a baseline`, n(f, 'behind') ? 'warn' : 'good')}
      ${statTile('Warranty expired', n(w, 'expired'), `${n(w, 'expiring')} more expire within 90 days`, n(w, 'expired') ? 'crit' : 'good')}
      ${statTile('Past end of support', pastSupport, `${n(l, 'eol')} end of life · ${n(l, 'eosale')} end of sale`, pastSupport ? 'crit' : 'good')}
      ${statTile('Missing lifecycle dates', n(l, 'nodates') + n(l, 'unknown'), isSuper() ? '<a href="#/models">Add them in the model master</a>' : 'Maintained in the model master', '')}
    </div>
    <div class="grid cols-2" style="margin-bottom:18px">
      <div class="card"><div class="card-head"><div><h2>Firmware by model</h2><div class="card-sub">Versions running in the fleet against the approved baseline</div></div>${isAdmin() ? '<a class="pill blue" href="#/models">Model master</a>' : ''}</div>
        <div class="table-wrap flat"><table><thead><tr><th>Model</th><th>Baseline</th><th>Devices</th><th>Below</th><th>Versions in fleet</th></tr></thead><tbody>
        ${lc.models.map((m) => `<tr><td><b>${esc(m.make)}</b> ${esc(shortModel(m.make, m.model))}${m.modelId ? '' : ' <span class="muted">(not in master)</span>'}</td><td class="mono">${esc(m.baseline || '—')}</td><td>${m.total}</td><td>${m.behind ? chip(m.behind, 'crit') : '0'}</td>
          <td>${Object.entries(m.versions).sort((a, b) => cmpVer(b[0], a[0])).map(([v, c]) => `<span class="pill mono ${m.baseline && cmpVer(v, m.baseline) < 0 ? 'bad' : ''}">${esc(v)} × ${c}</span>`).join(' ') || '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No devices</td></tr>'}
        </tbody></table></div></div>
      <div class="card"><div class="card-head"><div><h2>Warranty</h2><div class="card-sub">From Logitech Sync where it reports it, otherwise entered on the device</div></div></div>
        ${barList(['active', 'expiring', 'expired', 'unknown'].map((k) => ({ label: W_LABEL[k], n: n(w, k), tone: W_TONE[k] })), lc.total)}
        <div class="section-title">Model lifecycle stage</div>
        ${barList(['supported', 'soon', 'eosale', 'eos', 'eol', 'nodates', 'unknown'].map((k) => ({ label: LC_LABEL[k], n: n(l, k), tone: LC_TONE[k] })).filter((x) => x.n), lc.total)}
      </div>
    </div>
    <div class="card"><div class="card-head"><div><h2>Devices needing attention</h2><div class="card-sub">${lc.attentionTotal} devices below baseline, out of warranty or past a lifecycle milestone${lc.attentionTotal > lc.attention.length ? ` (first ${lc.attention.length} shown)` : ''}</div></div></div>
      ${lc.attention.length ? `<div class="table-wrap"><table><thead><tr><th>Device</th>${isAdmin() && !acting() ? '<th>Customer</th>' : ''}<th>Site / room</th><th>Firmware</th><th>Warranty</th><th>Lifecycle</th></tr></thead><tbody>
        ${lc.attention.map((d) => `<tr data-id="${esc(d.id)}"><td><b>${esc(d.make)}</b> ${esc(shortModel(d.make, d.model))}<div class="muted mono" style="font-size:11.5px">${esc(d.serial || '')}</div></td>${isAdmin() && !acting() ? `<td>${esc(d.customerName)}</td>` : ''}
          <td>${esc(d.site)}<div class="muted">${esc(d.room)}</div></td>
          <td><span class="mono">${esc(d.firmware || '—')}</span> ${d.firmwareStatus === 'behind' ? chip(`baseline ${d.baseline}`, 'crit') : ''}</td>
          <td>${chip(W_LABEL[d.warrantyStatus], W_TONE[d.warrantyStatus])}${d.warrantyExpires ? `<div class="muted" style="font-size:12px">${fmtDate(d.warrantyExpires)}</div>` : ''}</td>
          <td>${chip(d.lifecycle?.label || '—', LC_TONE[d.lifecycle?.stage])}${d.lifecycle?.date ? `<div class="muted" style="font-size:12px">${fmtDate(d.lifecycle.date)}</div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Nothing needs attention</div>'}</div>`;
  document.querySelectorAll('tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openDevice(tr.dataset.id)));
}

// ------------------------------------------------------------------ SLA view
const WIN_LABEL = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
const pctText = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(v >= 99.9 ? 3 : 2)}%`);
const mins = (m) => (m === null || m === undefined ? '—' : m < 60 ? `${m} min` : m < 1440 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} d`);
async function viewSla() {
  const win = S.slaWindow || '7d';
  const r = await api(`/api/sla${qs({ window: win })}`);
  const o = r.overall;
  const targets = [...new Set(r.byCustomer.map((c) => c.target))];
  const target = targets.length === 1 ? targets[0] : null;
  hero('Service levels', `Availability over the last ${WIN_LABEL[win]}. A device is unavailable while it is offline or critical; warnings still count as available.`);
  const metChip = (g) => (g.met === null ? '' : g.met ? chip('Met', 'good') : chip('Missed', 'crit'));
  $('#view').innerHTML = `
    <div class="card-head" style="margin-bottom:14px"><div class="seg" id="slaWin">${Object.keys(WIN_LABEL).map((k) => `<button data-w="${k}" class="${k === win ? 'on' : ''}">${WIN_LABEL[k]}</button>`).join('')}</div>
      ${r.simulated ? '<span class="muted" style="font-size:12.5px">History for mock connections is simulated. Live connections use the health recorded at every sync.</span>' : ''}</div>
    <div class="stats">
      ${statTile('Availability', pctText(o.availability), target !== null ? `Target ${target}%` : `${o.customersMeeting} of ${o.customers} customers meet their target`, o.availability === null ? '' : target !== null ? (o.availability >= target ? 'good' : 'crit') : (o.customersMeeting === o.customers ? 'good' : 'warn'))}
      ${statTile('Incidents', o.incidents, `${o.devices} devices measured`, '')}
      ${statTile('Mean time to restore', mins(o.mttrMin), 'Average length of incidents that ended', '')}
      ${statTile('Total downtime', mins(o.downtimeMin), 'Summed across devices', '')}
    </div>
    <div class="card" style="margin-bottom:18px"><div class="card-head"><div><h2>Availability trend</h2><div class="card-sub">${win === '24h' ? 'Hourly' : 'Daily'} availability across the devices in view${target !== null ? `, with the ${target}% target` : ''}</div></div></div>
      ${trendChart(r.trend, target, win)}</div>
    <div class="grid cols-2" style="margin-bottom:18px">
      <div class="card"><div class="card-head"><div><h2>By customer</h2><div class="card-sub">${isSuper() ? 'Set targets under Customers › Sites &amp; users' : 'Measured against the agreed target'}</div></div></div>
        <div class="table-wrap flat"><table><thead><tr><th>Customer</th><th>Availability</th><th>Target</th><th></th><th>Incidents</th><th>MTTR</th></tr></thead><tbody>
        ${r.byCustomer.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${pctText(c.availability)}</td><td>${c.target}%</td><td>${metChip(c)}</td><td>${c.incidents}</td><td>${mins(c.mttrMin)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No data</td></tr>'}</tbody></table></div></div>
      <div class="card"><div class="card-head"><div><h2>By site</h2><div class="card-sub">Lowest availability first</div></div></div>
        <div class="table-wrap flat"><table><thead><tr><th>Site</th>${isAdmin() && !acting() ? '<th>Customer</th>' : ''}<th>Availability</th><th></th><th>Incidents</th><th>Downtime</th></tr></thead><tbody>
        ${r.bySite.map((s) => `<tr><td><b>${esc(s.site)}</b><div class="muted">${esc(s.region || '')}</div></td>${isAdmin() && !acting() ? `<td>${esc(s.customerName)}</td>` : ''}<td>${pctText(s.availability)}</td><td>${metChip(s)}</td><td>${s.incidents}</td><td>${mins(s.downtimeMin)}</td></tr>`).join('')}</tbody></table></div></div>
    </div>
    <div class="grid cols-2" style="margin-bottom:18px">
      <div class="card"><div class="card-head"><div><h2>Rooms with the lowest availability</h2></div></div>
        <div class="table-wrap flat"><table><thead><tr><th>Room</th><th>Availability</th><th>Incidents</th><th>Downtime</th></tr></thead><tbody>
        ${r.worstRooms.map((x) => `<tr class="link" data-room="${esc(JSON.stringify([x.customerId, x.site, x.room]))}"><td><b>${esc(x.room)}</b><div class="muted">${esc(x.site)}${isAdmin() && !acting() ? ` · ${esc(x.customerName)}` : ''}</div></td><td>${pctText(x.availability)}</td><td>${x.incidents}</td><td>${mins(x.downtimeMin)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card"><div class="card-head"><div><h2>Devices with the lowest availability</h2></div></div>
        <div class="table-wrap flat"><table><thead><tr><th>Device</th><th>Availability</th><th>Incidents</th><th>Now</th></tr></thead><tbody>
        ${r.worstDevices.map((d) => `<tr data-id="${esc(d.id)}"><td><b>${esc(d.make)}</b> ${esc(shortModel(d.make, d.model))}<div class="muted">${esc(d.room)}, ${esc(d.site)}</div></td><td>${pctText(d.availability)}</td><td>${d.incidents}</td><td>${status(d.health)}</td></tr>`).join('')}</tbody></table></div></div>
    </div>
    <div class="card"><div class="card-head"><div><h2>Recent incidents</h2><div class="card-sub">Periods when a device was offline or critical</div></div></div>
      ${r.incidents.length ? `<div class="table-wrap"><table><thead><tr><th>Started</th><th>Device</th>${isAdmin() && !acting() ? '<th>Customer</th>' : ''}<th>Room</th><th>State</th><th>Duration</th></tr></thead><tbody>
      ${r.incidents.slice(0, 50).map((i) => `<tr data-id="${esc(i.deviceId)}"><td>${fmtDateTime(i.start)}</td><td><b>${esc(i.make)}</b> ${esc(shortModel(i.make, i.model))}</td>${isAdmin() && !acting() ? `<td>${esc(i.customerName)}</td>` : ''}<td>${esc(i.room)}<div class="muted">${esc(i.site)}</div></td><td>${status(i.health)}</td><td>${i.ongoing ? chip('Ongoing', 'crit') : mins(i.durationMin)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No incidents in this period</div>'}</div>`;
  document.querySelectorAll('#slaWin button').forEach((b) => b.addEventListener('click', () => { S.slaWindow = b.dataset.w; viewSla(); }));
  document.querySelectorAll('#view tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openDevice(tr.dataset.id)));
  document.querySelectorAll('#view tr[data-room]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/estate/${JSON.parse(tr.dataset.room).map(encodeURIComponent).join('/')}`; }));
}

function trendChart(points, target, win) {
  const vals = points.map((p) => p.availability).filter((v) => v !== null);
  if (!vals.length) return '<div class="empty">No history yet</div>';
  const W = 1100; const H = 200; const L = 44; const B = 24; const T = 18;
  const lo = Math.max(0, Math.min(Math.floor(Math.min(...vals, target ?? 100) - 0.5), 99));
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (100 - lo));
  const bw = (W - L) / points.length;
  const ticks = [lo, (lo + 100) / 2, 100];
  const label = (iso) => { const d = new Date(iso); return win === '24h' ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
  const every = Math.ceil(points.length / 8);
  return `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Availability trend">
    ${ticks.map((t) => `<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid-line"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" class="axis">${t.toFixed(t % 1 ? 1 : 0)}%</text>`).join('')}
    ${points.map((p, i) => (p.availability === null ? '' : `<rect x="${L + i * bw + bw * 0.18}" y="${y(p.availability)}" width="${bw * 0.64}" height="${Math.max(H - B - y(p.availability), 1)}" rx="3" class="${target !== null && p.availability < target ? 'bar-miss' : 'bar-ok'}"><title>${label(p.start)}: ${pctText(p.availability)}</title></rect>`)).join('')}
    ${target !== null ? `<line x1="${L}" x2="${W}" y1="${y(target)}" y2="${y(target)}" class="target-line"/><text x="${L + 4}" y="${y(target) - 5}" class="axis target-text">Target ${target}%</text>` : ''}
    ${points.map((p, i) => (i % every ? '' : `<text x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle" class="axis">${label(p.start)}</text>`)).join('')}
  </svg>`;
}

// ------------------------------------------------------------------ model master
async function viewModels() {
  const r = await api('/api/models');
  S.modelList = r.models;
  hero('Model master', isSuper()
    ? 'The approved catalogue of device models: firmware baseline, release history and end-of-sale, support and life dates. Devices are checked against it on every sync.'
    : 'The approved catalogue of device models, maintained by the super admin.');
  $('#view').innerHTML = `
    ${isSuper() ? `<div class="cta"><div><h3>Keep the master current</h3><p>Set the approved firmware baseline per model and fill in lifecycle dates from the manufacturer's notices. New firmware versions seen in the fleet are added to each model's release list automatically.</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-grad" id="mAdd">Add model</button></div></div>` : ''}
    ${r.uncatalogued.length ? `<div class="card" style="margin-bottom:18px"><div class="card-head"><div><h2>Models in the estate but not in the master</h2><div class="card-sub">${r.uncatalogued.reduce((a, u) => a + u.devices, 0)} devices can't be checked for firmware compliance or lifecycle</div></div>${isSuper() ? '<button class="btn btn-primary btn-sm" id="mImport">Add all to the master</button>' : ''}</div>
      <div class="chips">${r.uncatalogued.map((u, i) => `<button class="pill" data-unc="${i}" ${isSuper() ? '' : 'disabled'}>${esc(u.make)} ${esc(shortModel(u.make, u.model))} · ${u.devices}</button>`).join('')}</div></div>` : ''}
    <div class="card"><div class="card-head"><div><h2>${r.models.length} models</h2><div class="card-sub">Click a model to ${isSuper() ? 'edit it and its releases' : 'see its releases'}</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>Make</th><th>Model</th><th>Type</th><th>Monitored by</th><th>Baseline</th><th>Newest known</th><th>End of sale</th><th>End of support</th><th>End of life</th><th>Devices</th><th>Below baseline</th></tr></thead><tbody>
      ${r.models.map((m) => `<tr data-model="${esc(m.id)}"><td><b>${esc(m.make)}</b></td><td>${esc(shortModel(m.make, m.model))}</td><td>${esc(m.deviceType)}</td>
        <td><span class="src-tags">${(m.monitoredBy || []).map((o) => `<span class="pill" title="${esc(OEM_NAME[o] || o)}">${OEM_SHORT[o] || esc(o)}</span>`).join('') || '<span class="muted">Not monitored</span>'}</span></td>
        <td class="mono">${esc(m.baseline || '—')}</td><td class="mono">${esc(m.latest || '—')}${m.latest && m.baseline && cmpVer(m.latest, m.baseline) > 0 ? ` ${chip('newer', 'warn')}` : ''}</td>
        <td>${fmtDate(m.endOfSale)}</td><td>${fmtDate(m.endOfSupport)}</td><td>${fmtDate(m.endOfLife)}</td><td>${m.devices}</td><td>${m.behind ? chip(m.behind, 'crit') : '0'}</td></tr>`).join('') || '<tr><td colspan="11" class="empty">No models yet</td></tr>'}
      </tbody></table></div></div>`;
  document.querySelectorAll('tr[data-model]').forEach((tr) => tr.addEventListener('click', () => openModel(S.modelList.find((m) => m.id === tr.dataset.model))));
  $('#mAdd')?.addEventListener('click', () => openModel(null));
  document.querySelectorAll('[data-unc]').forEach((b) => b.addEventListener('click', () => openModel(null, r.uncatalogued[b.dataset.unc])));
  $('#mImport')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { const x = await api('/api/models/import', { method: 'POST', body: {} }); toast(ICONS.resolved, `${x.added} models added`); viewModels(); } catch (err) { toast(ICONS.critical, err.message); e.target.disabled = false; }
  });
}

const DEVICE_TYPES = ['Video bar', 'Video system', 'Touch controller', 'Camera', 'Conference phone', 'Desk phone', 'Room PC', 'Whiteboard camera', 'Room sensor', 'Display', 'Headset', 'Desk dock', 'Peripheral'];
function openModel(m, preset = {}) {
  const creating = !m;
  const ro = !isSuper();
  const v = (k) => esc(m?.[k] ?? preset[k] ?? '');
  const dis = ro ? 'disabled' : '';
  const monitored = m?.monitoredBy ?? preset.oems ?? [];
  const w = drawer(creating ? 'Add model' : `${m.make} ${shortModel(m.make, m.model)}`, creating ? 'Add a device model to the master' : `${m.devices} devices in the estate${m.behind ? `, ${m.behind} below baseline` : ''}`, `
    <div id="mMsg"></div>
    <div class="grid cols-2" style="gap:10px">
      <div class="field"><label>Make *</label><input id="mMake" value="${v('make')}" ${dis} placeholder="e.g. Poly"></div>
      <div class="field"><label>Model *</label><input id="mModel" value="${v('model')}" ${dis} placeholder="e.g. Studio X50"></div>
      <div class="field"><label>Device type</label><select id="mType" ${dis}>${DEVICE_TYPES.map((t) => `<option ${t === (m?.deviceType || preset.deviceType) ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label>Approved firmware baseline</label><input id="mBase" list="mVers" value="${v('baseline')}" ${dis} placeholder="e.g. 4.2.0"><datalist id="mVers">${(m?.releases || []).map((r) => `<option value="${esc(r.version)}">`).join('')}</datalist>
        <div class="help">Devices below this version are flagged on the Lifecycle tab.</div></div>
    </div>
    <div class="field"><label>Monitored by</label><div class="chk-row">${S.connectors.map((c) => `<label><input type="checkbox" class="mMon" value="${c.oem}" ${monitored.includes(c.oem) ? 'checked' : ''} ${dis}> ${esc(c.displayName)}</label>`).join('')}</div>
      <div class="help">Which connectors can report this model. Leave all unticked for kit with no API.</div></div>
    <div class="section-title">Lifecycle</div>
    <div class="grid cols-2" style="gap:10px">
      <div class="field"><label>End of sale</label><input id="mEosale" type="date" value="${v('endOfSale')}" ${dis}></div>
      <div class="field"><label>End of support</label><input id="mEos" type="date" value="${v('endOfSupport')}" ${dis}></div>
      <div class="field"><label>End of life</label><input id="mEol" type="date" value="${v('endOfLife')}" ${dis}></div>
      <div class="field"><label>Manufacturer notice (link)</label><input id="mUrl" value="${v('lifecycleUrl')}" ${dis} placeholder="https://"></div>
    </div>
    <div class="help block" style="margin:-4px 0 10px">Take these from the manufacturer's end-of-life notice. They are not filled in automatically.</div>
    <div class="field"><label>Notes</label><input id="mNotes" value="${v('notes')}" ${dis}></div>
    ${creating ? '' : `<div class="section-title">Firmware releases</div>
      <div class="help block" style="margin-bottom:8px">Versions seen in the fleet are added automatically (marked "seen in fleet"). Add official releases with their release notes so a new version is known before devices take it.</div>
      <div class="table-wrap flat"><table><thead><tr><th>Version</th><th>Released</th><th>Source</th><th>Notes</th><th></th></tr></thead><tbody>
      ${m.releases.map((r) => `<tr><td class="mono"><b>${esc(r.version)}</b> ${r.version === m.baseline ? chip('baseline', 'good') : ''}</td><td>${r.releasedAt ? fmtDate(r.releasedAt) : r.firstSeenAt ? `<span class="muted">seen ${fmtDate(r.firstSeenAt)}</span>` : '—'}</td>
        <td>${r.source === 'fleet' ? 'Seen in fleet' : r.source === 'manual' ? 'Added by admin' : 'Fleet + admin'}</td><td>${r.notesUrl ? `<a href="${esc(r.notesUrl)}" target="_blank" rel="noopener">Release notes</a>` : esc(r.notes || '')}</td>
        <td>${ro ? '' : `<button class="linkbtn" data-rel-del="${esc(r.version)}">Remove</button>`}${!ro && r.version !== m.baseline ? ` <button class="linkbtn" data-rel-base="${esc(r.version)}">Set baseline</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No releases recorded</td></tr>'}</tbody></table></div>
      ${ro ? '' : `<div class="user-row" style="margin-top:10px"><input id="rVer" placeholder="Version *"><input id="rDate" type="date" title="Release date"><input id="rUrl" placeholder="Release notes link (https://)"><button class="btn btn-outline btn-sm" id="rAdd">Add release</button></div>`}`}`,
  ro ? '' : `${creating ? '' : '<button class="btn btn-danger" id="mDel" style="margin-right:auto">Delete model</button>'}<button class="btn btn-primary" id="mSave">${creating ? 'Add model' : 'Save'}</button>`);
  w.querySelector('.drawer').classList.add('wide');
  if (ro) return;
  const msg = (t) => { $('#mMsg', w).innerHTML = `<div class="notice err">${esc(t)}</div>`; w.querySelector('.drawer-body').scrollTop = 0; };
  const reopen = (fresh) => { S.modelList = S.modelList.map((x) => (x.id === fresh.id ? fresh : x)); openModel(fresh); viewModels(); };
  $('#mSave', w).addEventListener('click', async () => {
    const body = {
      make: $('#mMake', w).value.trim(), model: $('#mModel', w).value.trim(), deviceType: $('#mType', w).value,
      monitoredBy: [...w.querySelectorAll('.mMon:checked')].map((c) => c.value), baseline: $('#mBase', w).value.trim() || null,
      endOfSale: $('#mEosale', w).value || null, endOfSupport: $('#mEos', w).value || null, endOfLife: $('#mEol', w).value || null,
      lifecycleUrl: $('#mUrl', w).value.trim() || null, notes: $('#mNotes', w).value.trim() || null,
    };
    try {
      await api(creating ? '/api/models' : `/api/models/${m.id}`, { method: creating ? 'POST' : 'PUT', body });
      closeDrawer(); toast(ICONS.resolved, creating ? 'Model added' : 'Model saved'); viewModels();
    } catch (e) { msg(e.message); }
  });
  $('#mDel', w)?.addEventListener('click', async (e) => {
    if (!e.target.dataset.confirm) { e.target.dataset.confirm = 1; e.target.textContent = 'Click again to delete'; return; }
    await api(`/api/models/${m.id}`, { method: 'DELETE' }); closeDrawer(); toast(ICONS.resolved, 'Model deleted'); viewModels();
  });
  $('#rAdd', w)?.addEventListener('click', async () => {
    try { reopen(await api(`/api/models/${m.id}/releases`, { method: 'POST', body: { version: $('#rVer', w).value, releasedAt: $('#rDate', w).value || null, notesUrl: $('#rUrl', w).value.trim() || null } })); toast(ICONS.resolved, 'Release added'); } catch (e) { msg(e.message); }
  });
  w.querySelectorAll('[data-rel-del]').forEach((b) => b.addEventListener('click', async () => {
    try { reopen(await api(`/api/models/${m.id}/releases/${encodeURIComponent(b.dataset.relDel)}`, { method: 'DELETE' })); } catch (e) { msg(e.message); }
  }));
  w.querySelectorAll('[data-rel-base]').forEach((b) => b.addEventListener('click', async () => {
    try { reopen(await api(`/api/models/${m.id}`, { method: 'PUT', body: { baseline: b.dataset.relBase } })); toast(ICONS.resolved, `Baseline set to ${b.dataset.relBase}`); } catch (e) { msg(e.message); }
  }));
}

// ------------------------------------------------------------------ audit log
const AUDIT_GROUPS = [['', 'All activity'], ['auth.', 'Sign-ins'], ['session.', 'Enter customer'], ['device.', 'Device edits'], ['room.', 'Rooms and schematics'], ['customer.', 'Customers'], ['user.', 'Users'], ['connection.', 'Connections and keys'], ['model.', 'Model master'], ['firmware.', 'New firmware seen'], ['audit.', 'Audit exports']];
const AUDIT_LABEL = {
  'auth.login': 'Signed in', 'auth.login_failed': 'Failed sign-in', 'auth.logout': 'Signed out',
  'session.enter_customer': 'Entered customer', 'session.exit_customer': 'Left customer',
  'device.bulk_update': 'Updated devices', 'device.reset': 'Reset devices to OEM values',
  'room.schematic_saved': 'Saved room schematic', 'room.schematic_removed': 'Removed room schematic', 'room.platform': 'Changed room platform',
  'customer.onboard': 'Onboarded customer', 'customer.update': 'Updated customer', 'customer.delete': 'Deleted customer',
  'user.create': 'Added user', 'user.delete': 'Removed user',
  'connection.create': 'Added connection', 'connection.update': 'Changed connection', 'connection.test': 'Tested connection', 'connection.sync': 'Ran sync', 'connection.delete': 'Removed connection',
  'model.create': 'Added model', 'model.update': 'Changed model', 'model.delete': 'Deleted model', 'model.release_add': 'Added firmware release', 'model.release_remove': 'Removed firmware release', 'model.import': 'Imported models from estate',
  'firmware.detected': 'New firmware seen in fleet', 'audit.export': 'Exported audit log',
};
function auditDetails(e) {
  const d = e.details;
  if (!d) return '';
  const parts = [];
  for (const [k, v] of Object.entries(d)) {
    if (k === 'deviceIds') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && 'from' in v) parts.push(`${k}: ${v.from ?? '—'} → ${v.to ?? '—'}`);
    else if (Array.isArray(v)) parts.push(`${k}: ${v.join(', ') || '—'}`);
    else if (typeof v === 'object' && v) parts.push(`${k}: ${JSON.stringify(v)}`);
    else parts.push(`${k}: ${v}`);
  }
  return esc(parts.join(' · '));
}
async function viewAudit() {
  const f = S.auditFilter || (S.auditFilter = { action: '', actor: '', q: '', from: '', to: '' });
  const p = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  const r = await api(`/api/audit?${p}&limit=500`);
  hero('Audit log', `Sign-ins, configuration changes and exports, newest first. Credential values are never recorded.${acting() ? ' Showing this customer only.' : ''}`);
  $('#view').innerHTML = `
    <div class="filters audit-filters">
      <select id="aAction">${AUDIT_GROUPS.map(([v, l]) => `<option value="${v}" ${f.action === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input id="aActor" placeholder="User email" value="${esc(f.actor)}">
      <label class="muted">From <input id="aFrom" type="date" value="${esc(f.from)}"></label>
      <label class="muted">To <input id="aTo" type="date" value="${esc(f.to)}"></label>
      <div class="search">${ICONS.search}<input id="aQ" placeholder="Search target or details…" value="${esc(f.q)}"></div>
      <a class="btn btn-outline btn-sm" href="/api/audit.csv?${p}" download>Export CSV</a>
    </div>
    <div class="card"><div class="card-head"><div><h2>${r.total} entries</h2>${r.total > r.entries.length ? `<div class="card-sub">Newest ${r.entries.length} shown. Export to get them all.</div>` : ''}</div></div>
      ${r.entries.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th>${acting() ? '' : '<th>Customer</th>'}<th>Details</th></tr></thead><tbody>
      ${r.entries.map((e) => `<tr class="${e.action === 'auth.login_failed' ? 'warn-row' : ''}"><td style="white-space:nowrap">${fmtDateTime(e.at)}</td>
        <td>${esc(e.actor?.name || e.actor?.email || '—')}<div class="muted" style="font-size:11.5px">${esc(e.actor?.role === 'system' ? 'automatic' : e.actor?.email || '')}${e.actingCustomerId && !acting() ? ' · acting as customer' : ''}</div></td>
        <td><b>${esc(AUDIT_LABEL[e.action] || e.action)}</b></td><td>${esc(e.target || '')}</td>${acting() ? '' : `<td>${esc(e.customerName || '')}</td>`}
        <td class="audit-details">${auditDetails(e)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No matching entries</div>'}</div>`;
  const go = () => {
    S.auditFilter = { action: $('#aAction').value, actor: $('#aActor').value.trim(), q: $('#aQ').value.trim(), from: $('#aFrom').value, to: $('#aTo').value };
    viewAudit();
  };
  for (const id of ['#aAction', '#aFrom', '#aTo']) $(id).addEventListener('change', go);
  let t;
  for (const id of ['#aActor', '#aQ']) $(id).addEventListener('input', () => { clearTimeout(t); t = setTimeout(go, 400); });
}
