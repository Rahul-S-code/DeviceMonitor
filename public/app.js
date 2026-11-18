// Estate Monitor front end. Plain ES modules, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HEALTH = ['healthy', 'warning', 'critical', 'offline'];
const HLABEL = { healthy: 'Healthy', warning: 'Warning', critical: 'Critical', offline: 'Offline' };
const OEM_SHORT = { 'poly-lens': 'PL', 'logitech-sync': 'LS' };
const OEM_NAME = { 'poly-lens': 'Poly Lens', 'logitech-sync': 'Logitech Sync' };
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
const status = (h) => `<span class="st ${h}">${ICONS[h]}${HLABEL[h]}</span>`;

const S = {
  me: null, options: null, connectors: [], connections: [], customers: [], alerts: [],
  summary: null, tree: null, devices: null,
  filters: loadFilters(), sort: { key: 'health', dir: -1 }, alertFilter: 'all', openFilter: null,
};

function loadFilters() {
  try { const f = JSON.parse(localStorage.getItem('dm.filters') || '{}'); return { ...emptyFilters(), ...f }; } catch { return emptyFilters(); }
}
function emptyFilters() { return Object.fromEntries([...FILTER_KEYS.map(([k]) => [k, []]), ['q', '']]); }
function saveFilters() { try { localStorage.setItem('dm.filters', JSON.stringify(S.filters)); } catch { /* ignore */ } }
const isAdmin = () => S.me?.role === 'provider_admin';

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
function renderLogin(error) {
  closeEvents();
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
        <div class="demo-users">Demo accounts (password is <span class="mono">DEMO_PASSWORD</span>, default <span class="mono">demo1234</span>):
          <button type="button" data-u="admin@provider.example">admin@provider.example · provider admin, all customers</button>
          <button type="button" data-u="it@helix.example">it@helix.example · Helix Financial only</button>
          <button type="button" data-u="it@northwind.example">it@northwind.example · Northwind Retail only</button>
          <button type="button" data-u="it@meridian.example">it@meridian.example · Meridian Health only</button>
        </div>
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
    <a class="brand" href="#/overview"><div class="brand-mark">${pulseMark()}</div><div>Estate Monitor<small>${esc(S.me.customerName || 'Service provider view')}</small></div></a>
    <nav class="nav" id="nav">
      <a href="#/overview" data-r="overview">Overview</a>
      <a href="#/estate" data-r="estate">Sites &amp; rooms</a>
      <a href="#/devices" data-r="devices">Devices</a>
      <a href="#/alerts" data-r="alerts">Alerts</a>
      <a href="#/connections" data-r="connections">Connections</a>
    </nav>
    <div class="top-right">
      <span class="live" id="live"><i></i>Live</span>
      <span class="user-chip"><span class="avatar">${esc(initials)}</span><span>${esc(S.me.name)}</span></span>
      <button class="btn-ghost-light" id="logout">Sign out</button>
    </div>
  </div></header>
  <section class="hero"><div class="hero-inner" id="hero"></div></section>
  <main><div id="filters"></div><div id="view"></div></main>
  <div class="toast-wrap" id="toasts"></div>`;
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
  const withFilters = ['overview', 'estate', 'devices'].includes(r.name);
  $('#filters').innerHTML = '';
  if (withFilters) renderFilters();
  try {
    if (r.name === 'overview') await viewOverview();
    else if (r.name === 'estate') await viewEstate(r.args);
    else if (r.name === 'devices') await viewDevices();
    else if (r.name === 'alerts') await viewAlerts();
    else if (r.name === 'connections') await viewConnections();
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
  }, 80);
}

// ------------------------------------------------------------------ overview
async function viewOverview() {
  const [summary] = await Promise.all([api(`/api/summary${qs()}`), loadConnections()]);
  S.summary = summary;
  const t = summary.totals;
  const pct = (n) => (t.total ? `${Math.round((n / t.total) * 100)}%` : '0%');
  const availability = t.total ? (((t.total - t.offline) / t.total) * 100).toFixed(1) : '0.0';
  hero(isAdmin() ? 'Global estate overview' : `${S.me.customerName} estate`, `${t.total} devices across ${summary.rooms} rooms and ${summary.sites} sites. Updated ${ago(summary.builtAt)}.`);
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
          ${breakdownCard('By OEM connection', 'Devices per manufacturer cloud', summary.byOem.map((x) => ({ ...x, label: OEM_NAME[x.key] || x.key })), (k) => ({ k: 'oem', v: k }))}
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
        <div class="card"><div class="card-head"><div><h2>OEM sync status</h2><div class="card-sub">Each connector polls its manufacturer cloud</div></div><a href="#/connections" class="pill blue">Manage</a></div>
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
        ${deviceTable(r.devices, ['health', 'device', 'deviceType', 'serial', 'firmware', 'lastSeen', 'sources'])}</div>
      <div class="grid">
        <div class="card"><h2>Room</h2>
          <dl class="kv" style="margin-top:12px">
            <dt>Platform</dt><dd>${esc(r.platform)} <span class="muted">${platSrc ? `(${esc(platSrc)})` : ''}</span></dd>
            <dt>Site</dt><dd>${esc(s.site)}</dd><dt>Region</dt><dd>${esc(s.region)}</dd>
            ${isAdmin() ? `<dt>Customer</dt><dd>${esc(s.customerName)}</dd>` : ''}
            <dt>Health</dt><dd>${HEALTH.filter((h) => r.health[h]).map((h) => `${r.health[h]} ${HLABEL[h].toLowerCase()}`).join(', ')}</dd>
          </dl>
          ${isAdmin() ? `<div class="section-title">Set room platform</div>
            <div class="field"><select id="roomPlat">${['Unassigned', 'Microsoft Teams', 'Zoom', 'Cisco Webex', 'Google Meet'].map((p) => `<option ${p === r.platform ? 'selected' : ''}>${p}</option>`).join('')}</select>
            <div class="help">Logitech Sync does not report the meeting platform, so it is set per room here. Devices that report a platform themselves (such as Poly Lens) keep their own value.</div></div>
            <button class="btn btn-outline btn-sm" id="savePlat">Save platform</button>` : ''}
        </div>
      </div>
    </div>`;
  bindDeviceTable();
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
    <h3>${esc(r.room)}</h3><div class="sub">${esc(r.platform)} · ${esc(makes)} · ${r.devices.length} devices</div>
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
function deviceTable(rows, cols) {
  const { key, dir } = S.sort;
  const sorter = COLS[key]?.[2];
  tableRows = sorter ? [...rows].sort((a, b) => { const x = sorter(a); const y = sorter(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; }) : rows;
  if (!rows.length) return '<div class="empty">No devices match the filters</div>';
  return `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th data-sort="${c}">${COLS[c][0]}${key === c ? (dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead>
    <tbody>${tableRows.map((d) => `<tr data-id="${esc(d.id)}">${cols.map((c) => `<td>${COLS[c][1](d)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function bindDeviceTable() {
  document.querySelectorAll('tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openDevice(tr.dataset.id)));
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
  const cols = ['health', 'device', 'deviceType', ...(isAdmin() ? ['customer'] : []), 'site', 'room', 'platform', 'serial', 'firmware', 'lastSeen', 'sources'];
  $('#view').innerHTML = `<div class="card">${deviceTable(devices, cols)}</div>`;
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
    </dl>
    <div class="section-title">Reported by ${d.sources.length} source${d.sources.length > 1 ? 's' : ''}</div>
    ${d.sources.length > 1 ? '<div class="notice info">This device was reported by more than one OEM cloud and has been merged into one record. Health shows the most severe state any source reports.</div>' : ''}
    <div class="sync-list">${d.sources.map((s) => {
    const conn = S.connections.find((c) => c.id === s.connectionId);
    return `<div class="sync-item"><div class="oem-logo oem-${s.oem}">${OEM_SHORT[s.oem] || '?'}</div>
        <div><div class="sync-name">${esc(OEM_NAME[s.oem] || s.oem)}</div><div class="sync-meta mono">${esc(s.sourceId)}</div>${conn ? `<div class="sync-meta">${esc(conn.name)}</div>` : ''}</div>
        ${s.health ? status(s.health) : ''}</div>`;
  }).join('')}</div>`);
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
  hero('OEM connections', isAdmin()
    ? 'Link each customer\'s manufacturer cloud. Credentials are encrypted on the server and never sent back to the browser.'
    : 'Sync status of the manufacturer clouds feeding your estate.');
  const byCust = new Map();
  for (const c of S.connections) { if (!byCust.has(c.customerName)) byCust.set(c.customerName, []); byCust.get(c.customerName).push(c); }
  $('#view').innerHTML = `
    ${isAdmin() ? `<div class="cta"><div><h3>Link Poly Lens with API keys</h3><p>Create an API client in Poly Lens (Integrations › API Credentials), then paste the client ID and secret here. Logitech Sync uses a client certificate instead.</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-grad" id="linkPoly">Link Poly Lens</button><button class="btn btn-outline" id="addConn">Add connection</button></div></div>` : ''}
    ${[...byCust.entries()].map(([name, conns]) => `
      <div class="card" style="margin-bottom:18px"><div class="card-head"><div><h2>${esc(name)}</h2><div class="card-sub">${conns.length} connection${conns.length > 1 ? 's' : ''}</div></div></div>
        <div class="conn-grid">${conns.map(connCard).join('')}</div></div>`).join('') || '<div class="card empty">No connections yet</div>'}`;
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
    ${isAdmin() ? `<div class="conn-actions"><button class="btn btn-primary btn-sm" data-cfg="${c.id}">${c.mode === 'live' ? 'Configure' : 'Configure & go live'}</button><button class="btn btn-outline btn-sm" data-sync="${c.id}">Sync now</button></div>` : ''}
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
        <div class="field"><label>OEM</label><select id="cOem">${S.connectors.map((x) => `<option value="${x.oem}" ${x.oem === oem ? 'selected' : ''}>${esc(x.displayName)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>Connection name</label><input id="cName" value="${esc(conn?.name || '')}" placeholder="e.g. Helix Financial · ${esc(C.displayName)}"></div>
      <div class="field"><label>Data source</label><div class="seg" id="cMode"><button data-m="mock" class="${mode === 'mock' ? 'on' : ''}">Mock data</button><button data-m="live" class="${mode === 'live' ? 'on' : ''}">Live API</button></div>
        <div class="help">${mode === 'mock' ? 'Uses built-in sample data in the same format as the real API. No keys needed.' : `Calls the real ${esc(C.displayName)} API with the credentials below.`}</div></div>
      <div class="section-title">How to get credentials</div>
      <ol class="steps">${(SETUP_STEPS[oem] || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <div class="muted" style="font-size:12px;margin:-8px 0 12px">Built from the <a href="${esc(C.docsUrl)}" target="_blank" rel="noopener">official ${esc(C.displayName)} API documentation</a>.</div>
      <div class="section-title">Settings</div>
      ${C.settingFields.map((f) => `<div class="field"><label for="s_${f.key}">${esc(f.label)}${f.required ? ' *' : ''}</label>
        <input id="s_${f.key}" data-setting="${f.key}" value="${esc(conn?.settings?.[f.key] ?? '')}" placeholder="${esc(f.placeholder || f.default || '')}">${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}</div>`).join('')}
      <div class="section-title">Credentials (encrypted at rest)</div>
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
    w.querySelectorAll('#cMode button').forEach((b) => b.addEventListener('click', () => {
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
      if (['overview', 'estate', 'devices'].includes(r) && !$('#drawerWrap') && !S.openFilter) refreshView();
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
