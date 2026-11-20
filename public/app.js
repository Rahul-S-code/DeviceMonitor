import { docSections } from './docs.js';
// Estate Monitor front end. Plain ES modules, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HEALTH = ['healthy', 'warning', 'critical', 'offline'];
// Includes devices added by hand, which have no live health.
const HEALTH_BARS = [...HEALTH, 'unmonitored'];
const HLABEL = { healthy: 'Healthy', warning: 'Warning', critical: 'Critical', offline: 'Offline', unmonitored: 'Not monitored' };
// Badge and name per source, filled from /api/connectors once signed in.
const OEM_SHORT = { manual: 'MN' };
const OEM_NAME = { manual: 'Manual entry' };
const FILTER_KEYS = [
  ['customer', 'Customer'], ['region', 'Region'], ['site', 'Site'], ['platform', 'Platform'],
  ['oem', 'Source'], ['deviceType', 'Device type'], ['health', 'Health'],
  ['firmwareStatus', 'Firmware'], ['warrantyStatus', 'Warranty'],
];

const ICONS = {
  healthy: '<svg class="ic" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#0ca30c"/><path d="M4.8 8.2l2.1 2.1 4.3-4.6" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warning: '<svg class="ic" viewBox="0 0 16 16"><path d="M8 1.5l7 12.5H1z" fill="#fab219" stroke="#fab219" stroke-linejoin="round"/><path d="M8 6v3.6" stroke="#0b0b0b" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.8" r="1" fill="#0b0b0b"/></svg>',
  critical: '<svg class="ic" viewBox="0 0 16 16"><path d="M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1z" fill="#d03b3b"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
  unmonitored: '<svg class="ic" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="#9aa1b8" stroke-width="1.6" stroke-dasharray="2.4 2"/></svg>',
  offline: '<svg class="ic" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#7d8399"/><path d="M4.5 8h7" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
  resolved: '<svg class="ic" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="#0ca30c" stroke-width="1.6"/><path d="M4.8 8.2l2.1 2.1 4.3-4.6" stroke="#0ca30c" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sync: '<svg class="ic" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#1a5cff"/><path d="M5 6.5a3.3 3.3 0 0 1 6-.6M11 9.5a3.3 3.3 0 0 1-6 .6" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
  chevron: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 4.5l3 3 3-3" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>',
  search: '<svg width="15" height="15" viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" stroke="#7d849e" stroke-width="1.6" fill="none"/><path d="M11 11l3.5 3.5" stroke="#7d849e" stroke-width="1.6" stroke-linecap="round"/></svg>',
};
// Devices that come only from demo (mock) connections, not a live API or manual entry.
const mockTag = (d) => (d.mock ? ' <span class="mock-tag" title="Demo data from a mock connection, not a live API">Mock</span>' : '');
const status = (h) => (h === 'none' ? '<span class="st offline">No devices</span>' : `<span class="st ${h}">${ICONS[h]}${HLABEL[h]}</span>`);

const S = {
  me: null, options: null, connectors: [], connections: [], customers: [], alerts: [],
  summary: null, tree: null, devices: null,
  selected: new Set(), schematicDirty: false, config: null,
  filters: loadFilters(), sort: { key: 'health', dir: -1 }, alertFilter: 'all', openFilter: null,
  devPage: { offset: 0, limit: 100, query: null }, tileLimit: 120,
};

function loadFilters() {
  try { const f = JSON.parse(localStorage.getItem('dm.filters') || '{}'); return { ...emptyFilters(), ...f }; } catch { return emptyFilters(); }
}
function emptyFilters() { return Object.fromEntries([...FILTER_KEYS.map(([k]) => [k, []]), ['q', '']]); }
function saveFilters() { try { localStorage.setItem('dm.filters', JSON.stringify(S.filters)); } catch { /* ignore */ } }
// What the signed-in user may do comes from their role's permissions (set on the Roles page).
const can = (perm) => (S.me?.permissions || []).includes(perm);
// Super admins and MSP admins look after several customers.
const multi = () => !!S.me?.multiCustomer;
const isSuper = () => S.me?.role === 'super_admin';
const seesModels = () => (S.me?.rank ?? 9) <= 1;
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

// Firmware and warranty filters belong to the asset views only.
const ASSET_FILTERS = ['firmwareStatus', 'warrantyStatus'];
const assetFiltersOn = () => ['devices', 'lifecycle'].includes(route().name);
function qs(extra = {}) {
  const p = new URLSearchParams();
  for (const [k] of FILTER_KEYS) if (S.filters[k]?.length && (!ASSET_FILTERS.includes(k) || assetFiltersOn())) p.set(k, S.filters[k].join(','));
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
      <div class="login-badges"><span>Poly Lens</span><span>Logitech Sync</span><span>Zoom Rooms</span><span>Webex</span><span>SLA reporting</span><span>Firmware &amp; lifecycle</span><span>Audit log</span></div>
    </div>
    <div class="login-form">
      <form id="loginForm">
        ${homeLinkHTML('login-home')}
        <h2>Sign in</h2>
        <p class="muted" style="margin:0 0 18px">Use your Estate Monitor account.</p>
        ${error ? `<div class="notice err">${esc(error)}</div>` : ''}
        <div class="field"><label for="em">Email</label><input id="em" name="email" type="email" autocomplete="username" required></div>
        <div class="field"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center" type="submit">Sign in</button>
        ${S.config?.showDemoAccounts ? `<div class="demo-users">Demo accounts (password is <span class="mono">DEMO_PASSWORD</span>, default <span class="mono">demo1234</span>):
          <button type="button" data-u="superadmin@provider.example">superadmin@provider.example · super admin, the whole platform</button>
          <button type="button" data-u="admin@provider.example">admin@provider.example · MSP admin, the default MSP's customers</button>
          <button type="button" data-u="admin@demo.example">admin@demo.example · customer admin, Demo Customer</button>
          <button type="button" data-u="tech@demo.example">tech@demo.example · technical user, Demo Customer</button>
          <button type="button" data-u="it@demo.example">it@demo.example · end user, Demo Customer (read only)</button>
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
// Sidebar icons (16px line icons, original).
const NAV_ICON = {
  overview: '<path d="M2 9h4v5H2zM6.5 5h3v9h-3zM10 2h4v12h-4z"/>',
  map: '<path d="M8 15s5-4.6 5-8.5A5 5 0 0 0 3 6.5C3 10.4 8 15 8 15z"/><circle cx="8" cy="6.5" r="1.8"/>',
  estate: '<path d="M2 14V4l5-2v12M7 14V6l7 2v6M2 14h12"/>',
  devices: '<rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 14h5M8 11v3"/>',
  alerts: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1.5 2h-11zM6.5 14.5h3"/>',
  sla: '<path d="M2 12a6 6 0 1 1 12 0"/><path d="M8 12l3-4"/>',
  baselines: '<path d="M8 1.5l5.5 2v4.2c0 3.2-2.3 5.8-5.5 6.8-3.2-1-5.5-3.6-5.5-6.8V3.5z"/><path d="M5.5 8.2l1.7 1.7 3.3-3.4"/>',
  lifecycle: '<path d="M13.5 6.5A5.5 5.5 0 0 0 3 5M2.5 9.5A5.5 5.5 0 0 0 13 11"/><path d="M3 2v3h3M13 14v-3h-3"/>',
  connections: '<circle cx="4" cy="8" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M5.8 7l4.4-2.2M5.8 9l4.4 2.2"/>',
  models: '<path d="M2.5 4.5L8 2l5.5 2.5v7L8 14l-5.5-2.5z"/><path d="M2.5 4.5L8 7l5.5-2.5M8 7v7"/>',
  msps: '<path d="M2 14V5l6-3 6 3v9"/><path d="M5.5 14v-4h5v4M5.5 7h.01M10.5 7h.01"/>',
  users: '<circle cx="8" cy="5" r="2.8"/><path d="M2.5 14.5a5.5 5.5 0 0 1 11 0"/>',
  roles: '<path d="M8 1.5l5.5 2v4.2c0 3.2-2.3 5.8-5.5 6.8-3.2-1-5.5-3.6-5.5-6.8V3.5z"/><circle cx="8" cy="6.8" r="1.6"/><path d="M5.6 11a2.6 2.6 0 0 1 4.8 0"/>',
  sites: '<path d="M8 14.5s4.5-4.3 4.5-8a4.5 4.5 0 0 0-9 0c0 3.7 4.5 8 4.5 8z"/><circle cx="8" cy="6.5" r="1.6"/>',
  customers: '<circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 14a4.5 4.5 0 0 1 9 0M11 3.5a2.3 2.3 0 0 1 0 4.5M12.5 10a3.8 3.8 0 0 1 2 4"/>',
  audit: '<path d="M4 1.5h6l3 3V14.5H4z"/><path d="M6.5 8h4M6.5 10.5h4M6.5 5.5h2"/>',
  apis: '<path d="M1.5 8h3l2-5 3 10 2-5h3"/>',
  errors: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.6M8 10.8v.4"/>',
  docs: '<path d="M3 2.5h7l3 3v8H3z"/><path d="M10 2.5v3h3M5.5 8h5M5.5 10.5h5"/>',
  sync: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.5 1.5"/>',
  inbox: '<path d="M2 9.5l1.8-6h8.4l1.8 6V13.5H2z"/><path d="M2 9.5h3.5l1 1.8h3l1-1.8H14"/>',
};
const navIcon = (k) => `<svg class="nav-ic" viewBox="0 0 16 16" aria-hidden="true">${NAV_ICON[k]}</svg>`;
const ROUTE_TITLE = { msps: 'MSPs', users: 'Users', roles: 'Roles & permissions', sites: 'Sites', inbox: 'Action inbox', overview: 'Overview', map: 'Map', estate: 'Sites & rooms', devices: 'Devices', alerts: 'Alerts', sla: 'Service levels', lifecycle: 'Lifecycle', baselines: 'Baselines', connections: 'Connections', models: 'Model master', customers: 'Customers', audit: 'Audit log', apis: 'API tracker', errors: 'Error codes', docs: 'Documentation', sync: 'Sync schedule' };

function navGroups() {
  return [
    ['Monitor', ['overview', 'map', 'estate', 'devices', 'alerts', ...(can('inbox.view') ? ['inbox'] : [])]],
    ...(can('service.view') ? [['Service', ['sla', 'lifecycle', 'baselines', 'errors']]] : []),
    ['Configure', [
      ...(can('connections.view') ? ['connections'] : []), ...(can('connections.manage') ? ['sync'] : []), ...(seesModels() ? ['models'] : []),
      ...(isSuper() ? ['msps'] : []), ...(can('customers.manage') ? ['customers'] : []), ...(can('sites.manage') && !multi() ? ['sites'] : []),
      ...(can('users.manage') ? ['users'] : []), 'roles', ...(can('apis.view') ? ['apis'] : []), ...(can('audit.view') ? ['audit'] : []),
    ]],
    ['Help', ['docs']],
  ];
}

/** "Back to" link for the app Estate Monitor is opened from (L2O, the UC Order Hub), set by HOME_LINK_URL. */
function homeLinkHTML(cls) {
  const h = S.config?.homeLink;
  if (!h?.url || !/^https?:\/\//i.test(h.url)) return '';
  return `<a class="${cls}" href="${esc(h.url)}" title="Back to ${esc(h.name)}"><svg class="nav-ic" viewBox="0 0 16 16"><path d="M10 3 5 8l5 5"/></svg><span>Back to ${esc(h.name)}</span></a>`;
}

function renderShell() {
  const initials = (S.me.name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
  const label = { estate: 'Sites &amp; rooms', sla: 'SLA', models: 'Models', roles: 'Roles', sites: 'Sites' };
  $('#app').innerHTML = `
  <div class="shell">
    <aside class="side" id="side">
      <a class="brand" href="#/overview"><div class="brand-mark">${pulseMark()}</div><div>Estate Monitor<small>${esc(S.me.customerName || S.me.actingCustomerName || (isSuper() ? 'Platform' : S.me.mspName || 'Service provider'))}</small></div></a>
      <nav class="nav" id="nav">${navGroups().map(([g, items]) => `<div class="nav-group">${esc(g)}</div>${items.map((k) => `<a href="#/${k}" data-r="${k}">${navIcon(k)}<span>${label[k] || ROUTE_TITLE[k]}</span>${k === 'alerts' ? '<b class="nav-badge" id="alertBadge" hidden></b>' : ''}${k === 'inbox' ? '<b class="nav-badge" id="inboxBadge" hidden></b>' : ''}</a>`).join('')}`).join('')}${homeLinkHTML('nav-home')}</nav>
      <div class="side-foot">
        <span class="avatar">${esc(initials)}</span>
        <span class="who">${esc(S.me.name)}<small>${esc(S.me.roleLabel || S.me.role)}</small></span>
        <button class="icon-btn" id="logout" title="Sign out" aria-label="Sign out"><svg viewBox="0 0 16 16"><path d="M6 2.5H3v11h3M10 5l3 3-3 3M13 8H6"/></svg></button>
      </div>
    </aside>
    <div class="scrim-side" id="sideScrim"></div>
    <div class="content">
      <header class="topbar"><div class="topbar-inner">
        <button class="icon-btn menu-btn" id="menuBtn" aria-label="Menu"><svg viewBox="0 0 16 16"><path d="M2 4h12M2 8h12M2 12h12"/></svg></button>
        <div class="top-title" id="topTitle"></div>
        <div class="top-right">
          ${multi() ? `<select class="enter-select" id="enterSel" aria-label="Enter a customer"><option value="">${acting() ? 'Exit to all customers' : 'All customers'}</option>${S.customers.map((c) => `<option value="${esc(c.id)}" ${c.id === acting() ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : ''}
          <span class="live" id="live"><i></i>Live</span>
        </div>
      </div></header>
      ${acting() ? `<div class="acting-bar"><span>You're viewing <b>${esc(S.me.actingCustomerName)}</b> exactly as that customer sees their estate.</span><button class="btn btn-sm btn-outline" id="exitCust">Exit customer</button></div>` : ''}
      <section class="hero"><div class="hero-inner" id="hero"></div></section>
      <main><div id="filters"></div><div id="view"></div></main>
    </div>
  </div>
  <div class="toast-wrap" id="toasts"></div>`;
  $('#enterSel')?.addEventListener('change', (e) => enterCustomer(e.target.value || null));
  $('#exitCust')?.addEventListener('click', () => enterCustomer(null));
  const side = (open) => document.body.classList.toggle('side-open', open);
  $('#menuBtn').addEventListener('click', () => side(!document.body.classList.contains('side-open')));
  $('#sideScrim').addEventListener('click', () => side(false));
  $('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) side(false); });
  $('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); S.me = null; renderLogin(); });
  updateAlertBadge();
  if (can('inbox.view')) updateInboxBadge();
}

/** Count of devices currently critical or offline, shown on the Alerts nav item. */
function updateAlertBadge(summary) {
  const el = $('#alertBadge');
  if (!el) return;
  const apply = (t) => { const n = (t?.critical || 0) + (t?.offline || 0); el.hidden = !n; el.textContent = n > 99 ? '99+' : n; el.title = `${n} devices critical or offline`; };
  if (summary) apply(summary.totals);
  else api('/api/summary').then((x) => apply(x.totals)).catch(() => {});
}

function route() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'overview').split('/').map(decodeURIComponent);
  return { name: parts[0] || 'overview', args: parts.slice(1) };
}

async function navigate() {
  if (!S.me) return;
  const r = route();
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === r.name));
  const group = navGroups().find(([, items]) => items.includes(r.name))?.[0];
  if ($('#topTitle')) $('#topTitle').textContent = [group, multi() ? null : S.me.customerName].filter(Boolean).join(' · ');
  const withFilters = ['overview', 'estate', 'devices', 'map', 'lifecycle', 'sla'].includes(r.name);
  if (r.name !== 'map') destroyMap();
  $('#filters').innerHTML = '';
  if (withFilters) renderFilters();
  try {
    if (r.name === 'overview') await viewOverview();
    else if (r.name === 'estate') await viewEstate(r.args);
    else if (r.name === 'devices') await viewDevices();
    else if (r.name === 'alerts') await viewAlerts();
    else if (r.name === 'connections' && can('connections.view')) await viewConnections();
    else if (r.name === 'map') await viewMap(r.args);
    else if (r.name === 'customers' && can('customers.manage')) await viewCustomers();
    else if (r.name === 'msps' && isSuper()) await viewMsps();
    else if (r.name === 'users' && can('users.manage')) await viewUsers();
    else if (r.name === 'roles') await viewRoles(r.args);
    else if (r.name === 'sites' && can('sites.manage')) await viewSites(r.args);
    else if (r.name === 'lifecycle' && can('service.view')) await viewLifecycle();
    else if (r.name === 'baselines' && can('service.view')) await viewBaselines(r.args);
    else if (r.name === 'sla' && can('service.view')) await viewSla();
    else if (r.name === 'models' && seesModels()) await viewModels();
    else if (r.name === 'audit' && can('audit.view')) await viewAudit();
    else if (r.name === 'apis' && can('apis.view')) await viewApis();
    else if (r.name === 'sync' && can('connections.manage')) await viewSyncSchedule();
    else if (r.name === 'errors' && can('service.view')) await viewErrorCodes();
    else if (r.name === 'inbox' && can('inbox.view')) await viewInbox(r.args);
    else if (r.name === 'docs') viewDocs(r.args);
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
  const keys = FILTER_KEYS.filter(([k]) => !(k === 'customer' && o.customer.length < 2) && (!ASSET_FILTERS.includes(k) || assetFiltersOn()));
  const LABELS = { health: HLABEL, firmwareStatus: FW_LABEL, warrantyStatus: W_LABEL };
  const opt = (k) => (o[k] || []).map((x) => (typeof x === 'string' ? { value: x, label: LABELS[k]?.[x] ?? x } : x));
  const any = keys.some(([k]) => S.filters[k].length) || S.filters.q;
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
  const [summary, , sla, life] = await Promise.all([api(`/api/summary${qs()}`), loadConnections(), api(`/api/sla${qs({ window: '7d' })}`).catch(() => null), api(`/api/lifecycle${qs()}`).catch(() => null)]);
  S.summary = summary;
  updateAlertBadge(summary);
  const t = summary.totals;
  const pct = (n) => (t.total ? `${Math.round((n / t.total) * 100)}%` : '0%');
  const monitored = t.total - (t.unmonitored || 0);
  const availability = monitored ? (((monitored - t.offline) / monitored) * 100).toFixed(1) : '0.0';
  hero(multi() && !acting() ? 'Global estate overview' : `${S.me.customerName || S.me.actingCustomerName} estate`, `${t.total} devices across ${summary.rooms} rooms and ${summary.sites} sites. Updated ${ago(summary.builtAt)}.`);
  const fourth = multi() && S.options.customer.length > 1
    ? breakdownCard('By customer', 'Each customer only sees its own estate', summary.byCustomer, (k) => ({ k: 'customer', v: S.options.customer.find((c) => c.label === k)?.value }))
    : breakdownCard('By device type', 'Classified from the model name', summary.byType, (k) => ({ k: 'deviceType', v: k }));
  $('#view').innerHTML = `
    <div class="kpis">
      <div class="kpi total" data-h=""><div class="lbl">Devices</div><div class="val">${t.total}</div>
        <div class="meta"><span>${availability}% online</span><span>${summary.mergedDuplicates} merged duplicates</span>${t.unmonitored ? `<span>${t.unmonitored} not monitored</span>` : ''}</div></div>
      ${HEALTH.map((h) => `<div class="kpi" data-h="${h}"><div class="lbl">${ICONS[h]}${HLABEL[h]}</div><div class="val">${t[h]}</div><div class="pct">${pct(t[h])} of estate</div><div class="bar f-${h}" style="width:${t.total ? (t[h] / t.total) * 100 : 0}%"></div></div>`).join('')}
    </div>
    ${serviceStrip(sla, life)}
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
        ${can('connections.view') ? `<div class="card"><div class="card-head"><div><h2>Sync status</h2><div class="card-sub">Manufacturer clouds and meeting-platform portals</div></div><a href="#/connections" class="pill blue">${can('connections.manage') ? 'Manage' : 'View'}</a></div>
          <div class="sync-list" id="syncList"></div></div>` : ''}
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

/** Headline service figures on the overview, each linking to its tab. */
function serviceStrip(sla, life) {
  if (!sla && !life) return '';
  const tiles = [];
  if (sla) {
    const o = sla.overall;
    const targets = [...new Set(sla.byCustomer.map((c) => c.target))];
    const target = targets.length === 1 ? targets[0] : null;
    const ok = target !== null ? o.availability >= target : o.customersMeeting === o.customers;
    tiles.push(['#/sla', 'Availability, 7 days', pctText(o.availability), target !== null ? `Target ${target}%` : `${o.customersMeeting} of ${o.customers} customers on target`, o.availability === null ? '' : ok ? 'good' : 'crit']);
    tiles.push(['#/sla', 'Incidents, 7 days', o.incidents, `Mean time to restore ${mins(o.mttrMin)}`, '']);
  }
  if (life) {
    const f = life.firmware; const n = (k) => f[k] || 0;
    const rated = n('compliant') + n('ahead') + n('behind');
    tiles.push(['#/lifecycle', 'Firmware compliance', rated ? `${(((n('compliant') + n('ahead')) / rated) * 100).toFixed(1)}%` : '—', `${n('behind')} below customer baseline`, n('behind') ? 'warn' : 'good']);
    const w = life.warranty;
    tiles.push(['#/lifecycle', 'Warranty', `${w.expired || 0} expired`, `${w.expiring || 0} expire within the notice period`, w.expired ? 'crit' : w.expiring ? 'warn' : 'good']);
  }
  return `<div class="stats service-strip">${tiles.map(([href, l, v, sub, tone]) => `<a class="stat ${tone}" href="${href}"><div class="lbl">${l}</div><div class="val">${v}</div><div class="pct">${sub}</div></a>`).join('')}</div>`;
}

const ROW_ACTIONS = new Map();
function breakdownCard(title, sub, rows, action, wide) {
  const id = `b${Math.random().toString(36).slice(2, 8)}`;
  ROW_ACTIONS.set(id, { rows, action });
  const body = rows.length ? rows.map((r, i) => `
    <div class="brk-row" data-b="${id}" data-i="${i}" ${action ? '' : 'style="cursor:default"'}>
      <div class="brk-name" title="${esc(r.label || r.key)}">${esc(r.label || r.key)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</div>
      <div class="brk-bar">${HEALTH_BARS.filter((h) => r[h]).map((h) => `<span class="f-${h}" style="flex:${r[h]}"></span>`).join('')}</div>
      <div class="brk-tot">${r.total}<small>${r.total ? Math.round((r.healthy / r.total) * 100) : 0}% ok</small></div>
    </div>`).join('') : '<div class="empty">No devices match the filters</div>';
  return `<div class="card" ${wide ? '' : ''}>
    <div class="card-head"><div><h2>${esc(title)}</h2><div class="card-sub">${esc(sub)}</div></div></div>
    <div class="legend" style="margin-bottom:12px">${HEALTH_BARS.map((h) => `<span><i class="f-${h}"></i>${HLABEL[h]}</span>`).join('')}</div>
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
    el.addEventListener('mousemove', (e) => showTip(e, `<b>${esc(r.label || r.key)}</b>${HEALTH_BARS.filter((h) => h !== 'unmonitored' || r[h]).map((h) => `<div><span><i class="f-${h}"></i>${HLABEL[h]}</span><span>${r[h]}</span></div>`).join('')}<div style="margin-top:4px;opacity:.8"><span>Total</span><span>${r.total}</span></div>`));
    el.addEventListener('mouseleave', hideTip);
    if (action) el.addEventListener('click', () => { hideTip(); const a = action(r.key); if (a.v) setFilter(a.k, a.v, a.go); });
  });
}

// ------------------------------------------------------------------ alert feed
function alertIcon(a) { return a.severity === 'resolved' ? ICONS.resolved : a.kind === 'sync' ? ICONS.sync : a.kind === 'report' ? ICONS.warning : (ICONS[a.to] || ICONS.critical); }
function feedItem(a, fresh) {
  const cust = S.options?.customer.find((c) => c.value === a.customerId)?.label;
  return `<div class="feed-item ${fresh ? 'new' : ''}" data-dev="${esc(a.deviceId || '')}" data-conn="${esc(a.connectionId || '')}">
    <div class="sev-dot">${alertIcon(a)}</div>
    <div><div class="feed-msg">${esc(a.message)}${(a.errorCodes || []).map((c) => ` <span class="code-chip">${esc(c)}</span>`).join('')}</div>
      <div class="feed-meta"><span>${ago(a.at)}</span>${a.site ? `<span>${esc(a.site)}</span>` : ''}${multi() && cust ? `<span>${esc(cust)}</span>` : ''}${a.platform && a.platform !== 'Unassigned' ? `<span>${esc(a.platform)}</span>` : ''}${a.initial ? '<span>at startup</span>' : ''}</div></div>
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
  S.connections = can('connections.view') ? await api('/api/connections') : [];
  return S.connections;
}
function syncState(st) {
  const label = { ok: 'Synced', error: 'Error', syncing: 'Syncing', never: 'Not synced' }[st.state] || st.state;
  return `<span class="sync-state s-${st.state}"><i></i>${label}</span>`;
}
function renderSyncList() {
  const el = $('#syncList');
  if (!el) return;
  // Large estates have hundreds of connections: show problems first and link to the full list.
  const order = { error: 0, syncing: 1, never: 2, ok: 3 };
  const list = [...S.connections].sort((a, b) => (order[a.status.state] ?? 4) - (order[b.status.state] ?? 4)).slice(0, 12);
  const more = S.connections.length - list.length;
  el.innerHTML = list.map((c) => `
    <div class="sync-item">
      <div class="oem-logo oem-${c.oem}">${OEM_SHORT[c.oem] || '?'}</div>
      <div><div class="sync-name">${esc(c.name)}</div>
        <div class="sync-meta"><span class="pill ${c.mode}" style="padding:1px 7px">${c.mode === 'live' ? 'Live' : c.status.mockOff ? 'Not live' : 'Mock'}</span> · ${c.status.deviceCount} devices · ${ago(c.status.lastSuccessAt)}</div>
        ${c.status.error ? `<div class="err-line">${esc(c.status.error)}</div>` : ''}</div>
      ${syncState(c.status)}
    </div>`).join('') + (more > 0 ? `<a class="muted" style="display:block;padding:8px 4px;font-size:12.5px" href="#/${can('connections.manage') ? 'sync' : 'connections'}">${more} more connections</a>` : '') || '<div class="empty">No connections</div>';
}

// ------------------------------------------------------------------ estate drill-down
async function viewEstate(args) {
  const [customerId, site, room] = args;
  // The site list carries counts only; a room's devices are fetched for that one site.
  const tree = await api(`/api/tree${customerId ? qs({ customer: customerId, site, devices: room ? '1' : '' }) : qs()}`);
  S.tree = tree;
  const crumbBase = '<a href="#/estate">All sites</a>';
  if (!customerId) {
    hero('Sites & rooms', `${tree.length.toLocaleString()} sites. Pick a site to see its rooms, then a room to see its devices.`);
    const shown = tree.slice(0, S.tileLimit);
    $('#view').innerHTML = tree.length ? `<div class="tiles">${shown.map((s) => siteTile(s)).join('')}</div>${tree.length > shown.length ? `<div class="more-row"><span class="muted">Showing ${shown.length} of ${tree.length.toLocaleString()} sites. Use the filters or search to narrow the list.</span><button class="btn btn-outline btn-sm" id="moreTiles">Show ${Math.min(240, tree.length - shown.length)} more</button></div>` : ''}` : '<div class="card empty">No sites match the filters</div>';
    document.querySelectorAll('.tile[data-href]').forEach((el) => el.addEventListener('click', () => { location.hash = el.dataset.href; }));
    $('#moreTiles')?.addEventListener('click', () => { S.tileLimit += 240; viewEstate(args); });
    return;
  }
  const s = tree.find((x) => x.customerId === customerId && x.site === site);
  if (!s) { hero('Site not found', 'It may be hidden by the current filters.', crumbBase); $('#view').innerHTML = '<div class="card empty">Nothing to show. Try clearing filters.</div>'; return; }
  const siteHref = `#/estate/${encodeURIComponent(customerId)}/${encodeURIComponent(site)}`;
  if (!room) {
    hero(s.site, `${multi() ? `${esc(s.customerName)} · ` : ''}${esc(s.region || '')}${s.country ? ` · ${esc(s.country)}` : ''} · ${s.rooms.length} rooms · ${s.health.total} devices`, `${crumbBase} <span>›</span> <span>${esc(s.site)}</span>`);
    $('#view').innerHTML = `<div class="tiles">${s.rooms.map((r) => roomTile(r, `${siteHref}/${encodeURIComponent(r.room)}`)).join('')}</div>`;
    document.querySelectorAll('.tile[data-href]').forEach((el) => el.addEventListener('click', () => { location.hash = el.dataset.href; }));
    return;
  }
  const r = s.rooms.find((x) => x.room === room);
  if (!r) { location.hash = siteHref; return; }
  r.devices ||= [];
  hero(r.room, `${esc(s.site)} · ${esc(r.platform)} room · ${r.devices.length} devices`, `${crumbBase} <span>›</span> <a href="${siteHref}">${esc(s.site)}</a> <span>›</span> <span>${esc(r.room)}</span>`);
  const platSrc = r.devices.find((d) => d.platformSource)?.platformSource;
  $('#view').innerHTML = `
    <div class="grid cols-main">
      <div class="card"><div class="card-head"><div><h2>Devices in this room</h2><div class="card-sub">Click a device for full details and source data</div></div><div style="display:flex;gap:10px;align-items:center">${can('estate.edit') ? '<button class="btn btn-outline btn-sm" id="roomAddDev">+ Add device</button>' : ''}${status(r.worst)}</div></div>
        ${r.devices.length ? deviceTable(r.devices, ['health', 'device', 'deviceType', 'serial', 'firmware', 'lastSeen', 'sources'], true) : '<div class="empty">No devices are assigned to this room yet. Add one by hand, or use Devices › Group into room to move devices here.</div>'}</div>
      <div class="grid">
        <div class="card"><h2>Room</h2>
          <dl class="kv" style="margin-top:12px">
            <dt>Platform</dt><dd>${esc(r.platform)} <span class="muted">${platSrc ? `(${esc(platSrc)})` : ''}</span></dd>
            <dt>Site</dt><dd>${esc(s.site)}</dd><dt>Region</dt><dd>${esc(s.region)}</dd>
            ${multi() ? `<dt>Customer</dt><dd>${esc(s.customerName)}</dd>` : ''}
            <dt>Health</dt><dd>${HEALTH_BARS.filter((h) => r.health[h]).map((h) => `${r.health[h]} ${HLABEL[h].toLowerCase()}`).join(', ') || 'No devices'}</dd>
          </dl>
          ${can('estate.edit') ? `<div class="section-title">Set room platform</div>
            <div class="field"><select id="roomPlat">${['Unassigned', 'Microsoft Teams', 'Zoom', 'Cisco Webex', 'Google Meet'].map((p) => `<option ${p === r.platform ? 'selected' : ''}>${p}</option>`).join('')}</select>
            <div class="help">Logitech Sync does not report the meeting platform, so it is set per room here. Devices that report a platform themselves (such as Poly Lens) keep their own value.</div></div>
            <button class="btn btn-outline btn-sm" id="savePlat">Save platform</button>` : ''}
          ${reportIssueHTML()}
        </div>
      </div>
    </div>`;
  bindDeviceTable();
  bindReportIssue($('#view'), { customerId: s.customerId, site: s.site, room: r.room });
  $('#roomAddDev')?.addEventListener('click', () => openManualDevice(null, { customerId: s.customerId, site: s.site, room: r.room }));
  const schemCard = document.createElement('div');
  schemCard.className = 'card';
  schemCard.style.marginTop = '18px';
  $('#view').appendChild(schemCard);
  mountSchematic(schemCard, { customerId, site, room, devices: r.devices });
  const docCard = document.createElement('div');
  docCard.className = 'card';
  docCard.style.marginTop = '18px';
  $('#view').appendChild(docCard);
  mountDesigns(docCard, { customerId, site, room });
  $('#savePlat')?.addEventListener('click', async () => {
    await api('/api/rooms/platform', { method: 'PUT', body: { customerId, site, room, platform: $('#roomPlat').value } });
    toast(ICONS.resolved, 'Room platform saved');
    viewEstate(args);
  });
}

function healthCounts(h) {
  return HEALTH_BARS.filter((k) => h[k]).map((k) => `<span class="st ${k}">${ICONS[k]}${h[k]}</span>`).join('');
}
function siteTile(s) {
  return `<div class="tile w-${s.worst}" data-href="#/estate/${encodeURIComponent(s.customerId)}/${encodeURIComponent(s.site)}">
    <h3>${esc(s.site)}</h3><div class="sub">${multi() ? `${esc(s.customerName)} · ` : ''}${esc(s.region || '')}${s.country ? ` · ${esc(s.country)}` : ''} · ${s.rooms.length} rooms</div>
    <div class="brk-bar">${HEALTH_BARS.filter((h) => s.health[h]).map((h) => `<span class="f-${h}" style="flex:${s.health[h]}"></span>`).join('')}</div>
    <div class="counts">${healthCounts(s.health)}</div></div>`;
}
function roomTile(r, href) {
  const makes = (r.makes || []).join(' + ');
  return `<div class="tile w-${r.worst}" data-href="${href}">
    <h3>${esc(r.room)}</h3><div class="sub">${esc(r.platform)}${makes ? ` · ${esc(makes)}` : ''} · ${r.deviceCount} devices${r.hasSchematic ? ' · schematic' : ''}</div>
    <div class="counts">${healthCounts(r.health)}</div></div>`;
}

// ------------------------------------------------------------------ devices table
const PAGE_SIZES = [50, 100, 250, 500];
const COLS = {
  health: ['Health', (d) => status(d.health), (d) => ['unmonitored', 'healthy', 'warning', 'offline', 'critical'].indexOf(d.health)],
  device: ['Device', (d) => `<b>${esc(d.make)}</b> ${esc(shortModel(d.make, d.model))}${mockTag(d)}`, (d) => `${d.make} ${d.model}`],
  deviceType: ['Type', (d) => esc(d.deviceType), (d) => d.deviceType],
  customer: ['Customer', (d) => esc(d.customerName), (d) => d.customerName],
  site: ['Site', (d) => esc(d.site), (d) => d.site],
  room: ['Room', (d) => esc(d.room), (d) => d.room],
  platform: ['Platform', (d) => esc(d.platform), (d) => d.platform],
  serial: ['Serial', (d) => `<span class="mono">${esc(d.serial || '—')}</span>`, (d) => d.serial || ''],
  firmware: ['Firmware', (d) => `<span class="mono">${esc(d.firmware || '—')}</span>${d.firmwareStatus === 'behind' ? ` <span class="chip crit" title="Approved baseline ${esc(d.baseline)}">below ${esc(d.baseline)}</span>` : ''}`, (d) => d.firmware || ''],
  warranty: ['Warranty', (d) => (d.warrantyStatus === 'unknown' ? '<span class="muted">—</span>' : `${chip(W_LABEL[d.warrantyStatus], W_TONE[d.warrantyStatus])}`), (d) => d.warrantyExpires || ''],
  lastSeen: ['Last seen', (d) => ago(d.lastSeen), (d) => d.lastSeen || ''],
  sources: ['Sources', (d) => `<span class="src-tags">${d.oems.map((o) => `<span class="pill" title="${esc(OEM_NAME[o] || o)}">${OEM_SHORT[o] || o}</span>`).join('')}</span>`, (d) => d.oems.length],
};
let tableRows = [];
function deviceTable(rows, cols, selectable, { serverSorted = false } = {}) {
  const { key, dir } = S.sort;
  const sorter = serverSorted ? null : COLS[key]?.[2];
  tableRows = sorter ? [...rows].sort((a, b) => { const x = sorter(a); const y = sorter(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; }) : rows;
  if (!rows.length) return '<div class="empty">No devices match the filters</div>';
  const sel = selectable && can('estate.edit');
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

// Paged on the server: filters, search and sorting run there, and only one page of rows comes back.
async function viewDevices() {
  const P = S.devPage;
  const q = qs();
  const sortKey = `${S.sort.key}|${S.sort.dir}`;
  if (P.query !== q || P.sortKey !== sortKey) { P.offset = 0; P.query = q; P.sortKey = sortKey; }
  const params = new URLSearchParams(q.slice(1));
  Object.entries({ limit: P.limit, offset: P.offset, sort: S.sort.key, dir: S.sort.dir < 0 ? 'desc' : 'asc' }).forEach(([k, v]) => params.set(k, v));
  const page = await api(`/api/devices?${params}`);
  if (page.offset >= page.total && page.total && P.offset) { P.offset = Math.max(0, Math.floor((page.total - 1) / P.limit) * P.limit); return viewDevices(); }
  const devices = page.items;
  S.devices = devices;
  hero('Devices', `${page.total.toLocaleString()} devices match the current filters. Duplicates reported by more than one source appear once.`);
  const cols = ['health', 'device', 'deviceType', ...(multi() && !acting() ? ['customer'] : []), 'site', 'room', 'platform', 'serial', 'firmware', 'warranty', 'lastSeen', 'sources'];
  const from = page.total ? page.offset + 1 : 0;
  const to = page.offset + devices.length;
  const last = Math.max(0, Math.floor((page.total - 1) / page.limit) * page.limit);
  const pager = page.total > Math.min(...PAGE_SIZES) ? `<div class="pager">
      <span class="muted">${from.toLocaleString()}–${to.toLocaleString()} of ${page.total.toLocaleString()}</span>
      <span class="pager-btns">
        <button class="btn btn-outline btn-sm" data-pg="0" ${page.offset === 0 ? 'disabled' : ''} aria-label="First page">«</button>
        <button class="btn btn-outline btn-sm" data-pg="${Math.max(0, page.offset - page.limit)}" ${page.offset === 0 ? 'disabled' : ''}>Previous</button>
        <span class="muted">Page ${Math.floor(page.offset / page.limit) + 1} of ${Math.floor(last / page.limit) + 1}</span>
        <button class="btn btn-outline btn-sm" data-pg="${page.offset + page.limit}" ${to >= page.total ? 'disabled' : ''}>Next</button>
        <button class="btn btn-outline btn-sm" data-pg="${last}" ${to >= page.total ? 'disabled' : ''} aria-label="Last page">»</button>
      </span>
      <label class="muted pager-size">Rows <select id="pgSize">${PAGE_SIZES.map((n) => `<option ${n === page.limit ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    </div>` : '';
  $('#view').innerHTML = `${can('estate.edit') ? `<div class="toolbar"><span class="muted">Tick devices to group them into a room or update them in bulk. Ticks are kept when you change page.</span><span style="display:flex;gap:8px"><button class="btn btn-outline btn-sm" id="bulkDev">Bulk add (CSV)</button><button class="btn btn-grad btn-sm" id="addDev">+ Add device</button></span></div>` : ''}<div class="card">${deviceTable(devices, cols, true, { serverSorted: true })}${pager}</div>`;
  bindDeviceTable();
  document.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { P.offset = Number(b.dataset.pg); viewDevices(); $('#view').scrollIntoView({ block: 'start' }); }));
  $('#pgSize')?.addEventListener('change', (e) => { P.limit = Number(e.target.value); P.offset = 0; viewDevices(); });
  $('#addDev')?.addEventListener('click', () => openManualDevice(null));
  $('#bulkDev')?.addEventListener('click', () => openBulkImport());
}

// ------------------------------------------------------------------ documentation
function viewDocs(args = []) {
  const sections = docSections({ connectors: S.connectors, role: S.me.role, perms: S.me.permissions, status });
  hero('Documentation', 'How to use Estate Monitor, and how to set up each connector.');
  $('#view').innerHTML = `<div class="docs">
    <nav class="docs-toc card" aria-label="Contents">
      <div class="docs-search"><input id="docQ" placeholder="Search the docs" aria-label="Search the docs"></div>
      ${sections.map((x) => `<a href="#/docs/${x.id}" data-doc="doc-${x.id}">${esc(x.title)}</a>${x.id === 'connectors' ? `<div class="docs-sub">${S.connectors.map((c) => `<a href="#/docs/conn-${esc(c.oem)}" data-doc="doc-conn-${esc(c.oem)}">${esc(c.displayName)}</a>`).join('')}</div>` : ''}`).join('')}
    </nav>
    <div class="docs-body">${sections.map((x) => `<article class="card doc-sec" id="doc-${x.id}"><h2>${esc(x.title)}</h2>${x.html}</article>`).join('')}<div class="card empty" id="docNone" hidden>Nothing in the documentation matches that search.</div></div>
  </div>`;
  const go = (id, smooth = true) => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }); };
  // In-page links keep the URL shareable without re-rendering the page.
  $('.docs').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-doc]');
    if (!a) return;
    e.preventDefault();
    history.replaceState(null, '', a.getAttribute('href'));
    go(a.dataset.doc);
  });
  $('#docQ').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll('.doc-sec').forEach((sec) => {
      const parts = sec.querySelectorAll('.doc-conn');
      if (parts.length) parts.forEach((p) => { p.hidden = !!q && !p.textContent.toLowerCase().includes(q); });
      const hit = !q || sec.textContent.toLowerCase().includes(q);
      sec.hidden = !hit; if (hit) shown++;
    });
    $('#docNone').hidden = shown > 0;
  });
  const target = args[0] ? `doc-${args[0]}` : null;
  if (target) requestAnimationFrame(() => go(target, false));
}

// Bulk add from CSV: template, preview with per-row errors, then import the valid rows.
function openBulkImport() {
  let csv = null;
  let fileName = '';
  const custOpts = `<option value="">Use the customer column in the file</option>${S.customers.map((c) => `<option value="${esc(c.id)}" ${c.id === (acting() || '') ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
  const w = drawer('Bulk add devices', 'Import kit from a CSV file. Devices are added as manual records, like + Add device.', `
    <ol class="steps">
      <li><a href="/api/manual-devices/template.csv" download>Download the CSV template</a>. It lists the columns and every make and model in the model master.</li>
      <li>Fill one row per device. <b>site</b>, <b>room</b>, <b>make</b> and <b>model</b> are required; make and model must match the model master.</li>
      <li>Choose the file, check the preview, then import. Rows with errors are skipped.</li>
    </ol>
    <div class="field"><label for="bkCust">Customer</label><select id="bkCust">${custOpts}</select><div class="help">Rows with a customer column use that instead.</div></div>
    <div class="field"><label for="bkFile">CSV file</label><input type="file" id="bkFile" accept=".csv,text/csv"><div class="help">Up to 2,000 rows and 2 MB. Save from Excel as "CSV UTF-8".</div></div>
    <label class="chk"><input type="checkbox" id="bkOther"> Allow models that are not in the model master (added as "Other")</label>
    <div id="bkMsg"></div><div id="bkPreview"></div>`,
  '<button class="btn btn-outline" data-closedrawer>Cancel</button><button class="btn btn-outline" id="bkCheck" disabled>Preview</button><button class="btn btn-primary" id="bkGo" disabled>Import</button>');
  const msg = (cls, text) => { $('#bkMsg', w).innerHTML = text ? `<div class="notice ${cls}">${esc(text)}</div>` : ''; };
  const body = (commit) => ({ csv, customerId: $('#bkCust', w).value || null, allowUnlisted: $('#bkOther', w).checked, commit });
  const preview = async () => {
    msg('', ''); $('#bkGo', w).disabled = true;
    try {
      const r = await api('/api/manual-devices/import', { method: 'POST', body: body(false) });
      $('#bkPreview', w).innerHTML = `<div class="bulk-sum"><span class="pill live">${r.valid} ready</span>${r.invalid ? `<span class="pill bad">${r.invalid} with errors</span>` : ''}<span class="muted">${esc(fileName)}</span></div>
        <div class="table-wrap flat"><table class="bulk-tbl"><thead><tr><th>Line</th><th></th><th>Customer</th><th>Site / room</th><th>Device</th><th>Serial</th></tr></thead><tbody>
        ${r.rows.map((x) => `<tr class="${x.ok ? '' : 'bad'}"><td class="mono">${x.line}</td><td>${x.ok ? '<span class="ok-dot" title="Ready">✓</span>' : '<span class="bad-dot" title="Error">!</span>'}</td><td>${esc(x.customer || '')}</td><td>${esc(x.site || '')} / ${esc(x.room || '')}</td>
          <td>${esc(`${x.make || ''} ${shortModel(x.make, x.model || '')}`)}${x.ok && !x.linked ? ' <span class="muted">(Other)</span>' : ''}${x.ok ? '' : `<div class="err-line">${esc(x.error)}</div>`}</td><td class="mono">${esc(x.serial || '')}</td></tr>`).join('')}
        </tbody></table></div>`;
      $('#bkGo', w).disabled = !r.valid;
      $('#bkGo', w).textContent = r.valid ? `Import ${r.valid} device${r.valid === 1 ? '' : 's'}` : 'Import';
    } catch (e) { $('#bkPreview', w).innerHTML = ''; msg('err', e.message); }
  };
  $('#bkFile', w).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    csv = null; $('#bkCheck', w).disabled = true; $('#bkGo', w).disabled = true; $('#bkPreview', w).innerHTML = ''; msg('', '');
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { msg('err', 'That file is over 2 MB. Split it and import each part.'); return; }
    csv = await f.text(); fileName = f.name;
    $('#bkCheck', w).disabled = false;
    preview();
  });
  for (const id of ['#bkCust', '#bkOther']) $(id, w).addEventListener('change', () => { if (csv) preview(); });
  $('#bkCheck', w).addEventListener('click', preview);
  $('#bkGo', w).addEventListener('click', async () => {
    $('#bkGo', w).disabled = true;
    try {
      const r = await api('/api/manual-devices/import', { method: 'POST', body: body(true) });
      closeDrawer();
      toast(ICONS.resolved, `Added ${r.added} device${r.added === 1 ? '' : 's'}${r.invalid ? `. ${r.invalid} rows skipped` : ''}`);
      S.options = await api('/api/filters').catch(() => S.options);
      navigate();
    } catch (e) { msg('err', e.message); $('#bkGo', w).disabled = false; }
  });
}

// ------------------------------------------------------------------ device drawer
async function openDevice(id) {
  let d;
  try { d = await api(`/api/devices/${encodeURIComponent(id)}`); } catch (e) { toast(ICONS.warning, e.message); return; }
  const roomHref = `#/estate/${encodeURIComponent(d.customerId)}/${encodeURIComponent(d.site)}/${encodeURIComponent(d.room)}`;
  drawer(`${d.make} ${shortModel(d.make, d.model)}`, `${esc(d.deviceType)} · ${esc(d.room)}, ${esc(d.site)}`, `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:6px">${status(d.health)}${mockTag(d)}${d.inUse ? '<span class="pill blue">In a meeting</span>' : ''}</div>
    ${d.healthReason && d.health !== 'unmonitored' ? `<div class="notice ${d.health === 'healthy' ? 'ok' : d.health === 'warning' ? 'info' : 'err'}">${esc(d.healthReason)}</div>` : ''}
    ${d.diagnosis?.length ? diagnosisSection(d) : ''}
    <div class="section-title">Common device record</div>
    <dl class="kv">
      ${multi() ? `<dt>Customer</dt><dd>${esc(d.customerName)}</dd>` : ''}
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
    ${deviceUiHTML(d)}
    ${d.manualId ? `<div class="notice ${d.health === 'unmonitored' ? 'info' : 'ok'}" style="margin-top:14px">${d.health === 'unmonitored' ? `${esc(d.healthReason || 'Added manually.')} It has no live health.` : 'Added manually and now also reported by a connected API, which provides its live health.'}
      ${can('estate.edit') ? `<div style="margin-top:8px;display:flex;gap:8px"><button class="btn btn-outline btn-sm" id="mEdit">Edit manual record</button><button class="btn btn-danger btn-sm" id="mDel">Remove manual record</button></div>` : ''}</div>` : ''}
    ${lifecycleSection(d)}
    ${reportIssueHTML()}
    ${can('devices.actions') && d.sources.some((x) => x.oem !== 'manual') ? '<div class="section-title">Remote actions</div><div id="devActions"><div class="muted">Loading…</div></div>' : ''}
    ${d.overridden?.length ? `<div class="notice info" style="margin-top:14px">Manually changed: ${d.overridden.map(esc).join(', ')}. The OEM reports this device in <b>${esc(d.reportedRoom)}</b>, ${esc(d.reportedSite)}.</div>` : ''}
    ${can('estate.edit') ? `<div class="section-title">Edit this device</div>
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
        <div class="field"><label>Device UI address</label><input id="eWebUrl" value="${esc(d.webUrl || '')}" placeholder="${esc(d.ip ? `Default https://${d.ip}/` : 'e.g. https://10.0.4.21/')}"><div class="help">Where its own web interface lives, if not https://&lt;IP&gt;/ (for example another port or http).</div></div>
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
  if ($('#devActions')) mountDeviceActions($('#devActions'), d);
  if ($('#diagCables')) mountDiagCables($('#diagCables'), d);
  bindReportIssue(document.querySelector('.drawer'), { deviceId: d.id });
  // The link opens the device directly; this only records who opened it.
  $('#openUi')?.addEventListener('click', () => { fetch(`/api/devices/${encodeURIComponent(d.id)}/webui`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin', keepalive: true }).catch(() => {}); });
  $('#eSave')?.addEventListener('click', async () => {
    const tags = $('#eTags').value.split(',').map((t) => t.trim()).filter(Boolean);
    const set = { site: $('#eSite').value, room: $('#eRoom').value, platform: $('#ePlat').value, assetTag: $('#eAsset').value || null, notes: $('#eNotes').value || null, removeTags: d.tags || [], addTags: tags };
    const changed = (id, cur) => ($(id).value !== (cur || '') ? ($(id).value || null) : undefined);
    set.warrantyExpires = changed('#eWarr', d.warrantyExpires);
    set.warrantyType = changed('#eWarrType', d.warrantyType);
    set.contractRef = changed('#eContract', d.contractRef);
    set.purchaseDate = changed('#ePurchase', d.purchaseDate);
    set.webUrl = changed('#eWebUrl', d.webUrl);
    if (set.site === d.reportedSite) set.site = null;
    if (set.room === d.reportedRoom) set.room = null;
    try { await api('/api/devices/bulk', { method: 'POST', body: { ids: [d.id], set } }); toast(ICONS.resolved, 'Device updated'); closeDrawer(); refreshView(); } catch (e) { toast(ICONS.critical, e.message); }
  });
  $('#mEdit')?.addEventListener('click', async () => {
    try { openManualDevice(await api(`/api/manual-devices/${encodeURIComponent(d.manualId)}`)); } catch (e) { toast(ICONS.critical, e.message); }
  });
  $('#mDel')?.addEventListener('click', async (e) => {
    if (!e.target.dataset.confirm) { e.target.dataset.confirm = 1; e.target.textContent = 'Click again to remove'; return; }
    try { await api(`/api/manual-devices/${encodeURIComponent(d.manualId)}`, { method: 'DELETE' }); toast(ICONS.resolved, 'Manual device removed'); closeDrawer(); refreshView(); } catch (err) { toast(ICONS.critical, err.message); }
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

// Error codes: what each fault means, likely causes and what to check.
function diagnosisSection(d) {
  return `<div class="section-title">Error codes and likely causes</div>
    ${d.diagnosis.map((x, i) => `<details class="diag ${d.health}" ${i === 0 ? 'open' : ''}>
      <summary><span class="code-chip">${esc(x.code)}</span><b>${esc(x.title)}</b><span class="muted">${esc(x.area)}</span></summary>
      <div class="diag-body">
        <div class="muted diag-src">Reported by <b>${esc(x.source)}</b>${x.raw ? ` as <span class="mono">${esc(x.raw)}</span>` : ''}</div>
        <p>${esc(x.meaning)}</p>
        <div class="diag-h">Likely causes, most likely first</div><ol>${x.causes.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>
        <div class="diag-h">What to check</div><ul>${x.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      </div></details>`).join('')}
    <div id="diagCables"></div>`;
}
/** The device's cables from the room schematic, so the checks point at real ports. */
async function mountDiagCables(el, d) {
  const sch = await api(`/api/rooms/schematic?customerId=${encodeURIComponent(d.customerId)}&site=${encodeURIComponent(d.site)}&room=${encodeURIComponent(d.room)}`).catch(() => null);
  const roomHref = `#/estate/${encodeURIComponent(d.customerId)}/${encodeURIComponent(d.site)}/${encodeURIComponent(d.room)}`;
  const node = sch?.nodes?.find((n) => n.deviceId === d.id);
  if (!node) { el.innerHTML = `<div class="muted diag-src">${sch?.nodes?.length ? 'This device is not linked on the room schematic.' : 'No room schematic yet.'} <a href="${roomHref}" data-closedrawer>Open the room</a> to ${sch?.nodes?.length ? 'link it' : 'draw one'} so its cables show here.</div>`; el.querySelector('a')?.addEventListener('click', closeDrawer); return; }
  const links = sch.links.filter((l) => l.from === node.id || l.to === node.id);
  el.innerHTML = `<div class="diag-h" style="margin-top:12px">Cables to check (from the room schematic)</div>
    ${links.map((l) => { const out = l.from === node.id; return `<div class="conn-row"><b>${esc((out ? l.fromPort : l.toPort) || 'Cable')}</b> ${out ? '→' : '←'} ${esc(endText(sch, out ? l.to : l.from, out ? l.toPort : l.fromPort))}<small>${esc(cableText(l))}${l.condition ? ` · ${COND_LABEL[l.condition]}` : ''}${node.location ? ` · ${esc(node.location)}` : ''}</small></div>`; }).join('') || '<div class="muted">No cables drawn to this device.</div>'}
    <a href="${roomHref}" class="linkbtn" id="diagRoom">Open the room schematic</a>`;
  $('#diagRoom', el).addEventListener('click', closeDrawer);
}

// Remote actions run through the vendor API that reports the device: the OEM
// cloud (e.g. Poly Lens) or the meeting platform (e.g. Webex Control Hub).
async function mountDeviceActions(el, d) {
  let r;
  try { r = await api(`/api/devices/${encodeURIComponent(d.id)}/actions`); } catch (e) { el.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; return; }
  const any = r.sets.some((x) => x.actions.length);
  el.innerHTML = `<div class="help" style="margin:-4px 0 10px">Each action runs through the API of the service shown. ${r.sets.length > 1 ? 'This device is reported by more than one service, so pick which API to use.' : ''}</div>
    ${r.sets.map((set) => `<div class="act-set">
      <div class="act-head"><b>${esc(set.displayName)}</b><span class="pill ${set.kind === 'platform' ? 'blue' : ''}">${esc(set.apiSet)}</span>${set.mode ? `<span class="pill ${set.mode}">${set.mode === 'live' ? 'Live' : 'Demo'}</span>` : ''}</div>
      ${set.actions.map((a) => `<div class="act-row"><div><b>${esc(a.label)}</b>${a.target === 'room' ? ' <span class="muted">(whole room)</span>' : ''}<div class="muted">${esc(a.description)}</div>
          <div class="act-api"><span class="mono">${esc(a.api.method)} ${esc(a.api.endpoint)}</span> · ${esc(a.api.name)} · needs ${esc(a.scope)}</div></div>
        <button class="btn btn-outline btn-sm" data-act="${esc(a.id)}" data-conn="${esc(set.connectionId)}" data-confirm-text="${esc(a.confirm)}">${esc(a.label)}</button></div>`).join('')}
      ${set.note ? `<div class="muted act-note">${esc(set.note)}</div>` : ''}
      ${set.mode === 'mock' && set.actions.length ? '<div class="muted act-note">Demo connection: the action is simulated and nothing is sent.</div>' : ''}
    </div>`).join('')}
    ${any ? '' : '<div class="muted">None of the services reporting this device offers remote actions.</div>'}
    <div id="actMsg"></div>`;
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    if (!b.dataset.armed) { b.dataset.armed = 1; b.dataset.label = b.textContent; b.textContent = `${b.dataset.confirmText} Click to confirm`; b.classList.add('btn-danger'); setTimeout(() => { if (b.isConnected && b.dataset.armed) { delete b.dataset.armed; b.textContent = b.dataset.label; b.classList.remove('btn-danger'); } }, 6000); return; }
    delete b.dataset.armed; b.disabled = true; b.textContent = 'Sending…';
    try {
      const res = await api(`/api/devices/${encodeURIComponent(d.id)}/actions`, { method: 'POST', body: { connectionId: b.dataset.conn, action: b.dataset.act } });
      $('#actMsg', el).innerHTML = `<div class="notice ${res.simulated ? 'info' : 'ok'}"><b>${esc(res.action)} via ${esc(res.via)}</b> (${esc(res.apiSet)} API). ${esc(res.message)}</div>`;
      toast(ICONS.resolved, `${res.action} ${res.simulated ? 'simulated' : 'sent'} via ${res.via}`);
    } catch (e) { $('#actMsg', el).innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
    b.disabled = false; b.textContent = b.dataset.label; b.classList.remove('btn-danger');
  }));
}

// ------------------------------------------------------------------ alerts view
async function viewAlerts() {
  S.alerts = await api('/api/alerts?limit=300');
  hero('Alerts', 'Device health changes, connector sync problems and issues reported by users, newest first.');
  const f = S.alertFilter;
  const match = (a) => f === 'all' || (f === 'sync' || f === 'report' ? a.kind === f : a.severity === f);
  const list = S.alerts.filter(match);
  $('#view').innerHTML = `<div class="card">
    <div class="card-head" style="flex-wrap:wrap"><div class="seg" id="alertSeg">${[['all', 'All'], ['critical', 'Critical'], ['warning', 'Warning'], ['resolved', 'Resolved'], ['sync', 'Sync'], ['report', 'Reported']].map(([k, l]) => `<button data-f="${k}" class="${f === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="muted">${list.length} alerts</span></div>
    <div class="feed" style="max-height:none" id="alertList">${list.map((a) => feedItem(a)).join('') || '<div class="empty">No alerts</div>'}</div></div>`;
  document.querySelectorAll('#alertSeg button').forEach((b) => b.addEventListener('click', () => { S.alertFilter = b.dataset.f; viewAlerts(); }));
  bindFeed($('#alertList'));
}

// ------------------------------------------------------------------ connections view
async function viewConnections() {
  await loadConnections();
  hero('Connections', can('connections.manage')
    ? 'Link each customer\'s manufacturer clouds and meeting-platform portals. Credentials are encrypted on the server and never sent back to the browser.'
    : 'Sync status of the manufacturer clouds and platform portals feeding your estate.');
  const byCust = new Map();
  for (const c of S.connections) { if (!byCust.has(c.customerName)) byCust.set(c.customerName, []); byCust.get(c.customerName).push(c); }
  $('#view').innerHTML = `
    ${can('connections.manage') ? `<div class="cta"><div><h3>Link Poly Lens with API keys</h3><p>Create an API client in Poly Lens (Integrations › API Credentials), then paste the client ID and secret here. Logitech Sync uses a client certificate instead.</p></div>
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
      <span class="pill ${c.mode}">${c.mode === 'live' ? 'Live' : st.mockOff ? 'Not live' : 'Mock data'}</span></div>
    <div class="conn-stats"><div><span class="muted">Status</span>${syncState(st)}</div><div><span class="muted">Devices</span><b>${st.deviceCount}</b></div><div><span class="muted">Last sync</span><b>${ago(st.lastSuccessAt)}</b></div></div>
    ${st.intervalSec ? `<div class="muted" style="font-size:12px">Syncs every ${fmtInterval(st.intervalSec)}${st.intervalSource === 'default' ? ' (default)' : ''}${st.nextRunAt ? `, next ${inTime(st.nextRunAt)}` : ''}${can('connections.manage') ? ' · <a href="#/sync">Change</a>' : ''}</div>` : ''}
    ${st.error ? `<div class="err-line">${esc(st.error)}</div>` : ''}
    ${st.mockOff ? '<div class="muted" style="font-size:12px">Mock data is off for this customer, so this connection shows no devices until it goes live.</div>' : ''}
    ${S.connectors.find((x) => x.oem === c.oem)?.liveSupported === false ? '<div class="muted" style="font-size:12px">Mock only: no public API for live data.</div>' : ''}
    ${can('connections.manage') || can('connections.sync') ? `<div class="conn-actions">${can('connections.manage') ? `<button class="btn btn-primary btn-sm" data-cfg="${c.id}">${c.mode === 'live' || S.connectors.find((x) => x.oem === c.oem)?.liveSupported === false ? 'Configure' : 'Configure & go live'}</button>` : ''}${can('connections.sync') ? `<button class="btn btn-outline btn-sm" data-sync="${c.id}">Sync now</button>` : ''}</div>` : ''}
  </div>`;
}

// Keeps browsers and password managers from filling connection fields
// (autofill once put a sign-in email into the Poly Lens Token URL).
const NO_AUTOFILL = 'autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" readonly data-noauto="1"';
// Browsers (Edge especially) fill password fields and the text field before them
// on Save, which overwrote the Poly Lens Client ID and Token URL. So: no
// type=password (masked with CSS instead), fields readonly until focused, and
// only values the person actually typed or pasted are sent.
function guardAutofill(w) {
  w.querySelectorAll('[data-noauto]').forEach((i) => {
    i.addEventListener('focus', () => { if (!i.dataset.touched && i.value !== i.defaultValue) i.value = i.defaultValue; i.removeAttribute('readonly'); });
    i.addEventListener('blur', () => i.setAttribute('readonly', ''));
    for (const ev of ['keydown', 'paste', 'cut', 'drop']) i.addEventListener(ev, () => { i.dataset.touched = '1'; });
  });
}
const isUrlSetting = (f) => f.type === 'url' || /Url$/.test(f.key);
function urlSettingError(w) {
  for (const i of w.querySelectorAll('[data-url]')) {
    if (!i.dataset.touched) continue;
    const v = i.value.trim();
    if (!v) continue;
    let ok = false; try { ok = new URL(v).protocol === 'https:' && !v.includes('@'); } catch { /* invalid */ }
    if (!ok) { i.focus(); return `${i.closest('.field')?.querySelector('label')?.textContent.replace(/\s*\*$/, '').trim() || 'URL'} must be a full https:// address. Clear it to use the default.`; }
  }
  return null;
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
      <div class="field"><label>Connection name</label><input id="cName" type="text" autocomplete="off" ${NO_AUTOFILL} name="em-name-${Math.random().toString(36).slice(2, 8)}" value="${esc(conn?.name || '')}" placeholder="e.g. Demo Customer · ${esc(C.displayName)}"></div>
      <div class="field"><label>Data source</label><div class="seg" id="cMode"><button data-m="mock" class="${mode === 'mock' ? 'on' : ''}">Mock data</button><button data-m="live" class="${mode === 'live' ? 'on' : ''}" ${C.liveSupported === false ? 'disabled title="No public API available"' : ''}>Live API</button></div>
        <div class="help">${mode === 'mock' ? 'Uses built-in sample data in the same format as the real API. No keys needed.' : `Calls the real ${esc(C.displayName)} API with the credentials below.`}</div></div>
      ${C.liveSupported === false ? `<div class="notice info">${esc(C.liveNote)}</div>` : `<div class="section-title">How to get credentials</div>
      <ol class="steps">${(C.setupSteps?.length ? C.setupSteps : SETUP_STEPS[oem] || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`}
      <div class="muted" style="font-size:12px;margin:-8px 0 12px">${C.liveSupported === false ? `<a href="${esc(C.docsUrl)}" target="_blank" rel="noopener">Source for this</a>` : `Built from the <a href="${esc(C.docsUrl)}" target="_blank" rel="noopener">official ${esc(C.displayName)} API documentation</a>.`}</div>
      ${C.settingFields.length ? '<div class="section-title">Settings</div>' : ''}
      ${C.settingFields.map((f) => `<div class="field"><label for="s_${f.key}">${esc(f.label)}${f.required ? ' *' : ''}</label>
        <input id="s_${f.key}" data-setting="${f.key}" ${isUrlSetting(f) ? 'type="url" inputmode="url" data-url="1"' : 'type="text"'} autocomplete="off" ${NO_AUTOFILL} name="em-set-${f.key}-${Math.random().toString(36).slice(2, 8)}" value="${esc(conn?.settings?.[f.key] ?? '')}" placeholder="${esc(f.placeholder || f.default || '')}">${f.help || isUrlSetting(f) ? `<div class="help">${esc(f.help || '')}${isUrlSetting(f) && f.default ? `${f.help ? ' ' : ''}Leave blank to use the default.` : ''}</div>` : ''}</div>`).join('')}
      ${C.credentialFields.length ? '<div class="section-title">Credentials (encrypted at rest)</div>' : ''}
      ${C.credentialFields.map((f) => {
    const stored = conn?.credentials?.[f.key];
    const ph = stored ? 'Stored. Leave blank to keep the current value.' : '';
    return `<div class="field"><label for="k_${f.key}">${esc(f.label)}${f.required ? ' *' : ''} ${stored ? '<span class="stored">✓ stored</span>' : ''}</label>
          ${f.multiline ? `<textarea id="k_${f.key}" data-cred="${f.key}" autocomplete="off" ${NO_AUTOFILL} placeholder="${esc(ph || '-----BEGIN ...-----')}" spellcheck="false"></textarea>` : `<input id="k_${f.key}" data-cred="${f.key}" type="text" class="secret-input" autocomplete="off" ${NO_AUTOFILL} name="em-key-${f.key}-${Math.random().toString(36).slice(2, 8)}" placeholder="${esc(ph)}">`}
          ${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}</div>`;
  }).join('')}`;
    const foot = `${!creating ? '<button class="btn btn-danger" id="cDel" style="margin-right:auto">Remove</button>' : ''}
      ${!creating ? '<button class="btn btn-outline" id="cTest">Test connection</button>' : ''}
      <button class="btn btn-primary" id="cSave">${creating ? 'Create connection' : 'Save'}</button>`;
    const w = drawer(creating ? 'Add OEM connection' : conn.name, creating ? 'Connect a manufacturer cloud to a customer' : `${esc(C.displayName)} · ${esc(conn.customerName)}`, body, foot);
    guardAutofill(w);
    const collect = () => ({
      name: ($('#cName', w).dataset.touched && $('#cName', w).value.trim()) || undefined,
      mode,
      // Untouched settings keep their saved value, whatever the browser put in the box.
      settings: Object.fromEntries([...w.querySelectorAll('[data-setting]')].map((i) => [i.dataset.setting, i.dataset.touched ? i.value : (conn?.settings?.[i.dataset.setting] ?? '')])),
      credentials: Object.fromEntries([...w.querySelectorAll('[data-cred]')].filter((i) => i.dataset.touched).map((i) => [i.dataset.cred, i.value]).filter(([, v]) => v.trim())),
    });
    const msg = (kind, text) => { $('#connMsg', w).innerHTML = `<div class="notice ${kind}">${esc(text)}</div>`; w.querySelector('.drawer-body').scrollTop = 0; };
    $('#cOem', w)?.addEventListener('change', (e) => { oem = e.target.value; render(); });
    w.querySelectorAll('#cMode button:not([disabled])').forEach((b) => b.addEventListener('click', () => {
      // Preserve typed values across re-render.
      const keep = collect();
      mode = b.dataset.m; render();
      for (const [k, v] of Object.entries(keep.settings)) { const i = document.querySelector(`[data-setting="${k}"]`); if (i && v !== (conn?.settings?.[k] ?? '')) { i.value = v; i.dataset.touched = '1'; } }
      for (const [k, v] of Object.entries(keep.credentials)) { const i = document.querySelector(`[data-cred="${k}"]`); if (i) { i.value = v; i.dataset.touched = '1'; } }
      if (keep.name) { $('#cName').value = keep.name; $('#cName').dataset.touched = '1'; }
    }));
    $('#cTest', w)?.addEventListener('click', async (e) => {
      const bad = urlSettingError(w); if (bad) return msg('err', bad);
      e.target.disabled = true; e.target.textContent = 'Testing…';
      try { const r = await api(`/api/connections/${conn.id}/test`, { method: 'POST', body: collect() }); msg(r.ok ? 'ok' : 'err', r.message); } catch (err) { msg('err', err.message); }
      e.target.disabled = false; e.target.textContent = 'Test connection';
    });
    $('#cSave', w).addEventListener('click', async (e) => {
      const bad = urlSettingError(w); if (bad) return msg('err', bad);
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
  const wrap = $('#toasts');
  wrap?.appendChild(el);
  // Never stack more than four: the oldest goes first.
  while (wrap && wrap.children.length > 4) wrap.firstElementChild.remove();
  setTimeout(() => el.remove(), 5000);
}
// Critical alerts toast one by one, but a burst (a vendor cloud down for many customers)
// becomes a single "N new critical alerts" toast instead of a wall of them.
const alertToasts = { times: [], held: 0, timer: null };
function toastAlert(a) {
  const now = Date.now();
  alertToasts.times = alertToasts.times.filter((t) => now - t < 10_000);
  if (alertToasts.times.length < 3) { alertToasts.times.push(now); toast(alertIcon(a), a.message); return; }
  alertToasts.held++;
  if (alertToasts.timer) return;
  alertToasts.timer = setTimeout(() => {
    const n = alertToasts.held;
    alertToasts.held = 0; alertToasts.timer = null;
    if (n) toast(ICONS.critical, `${n} more critical alert${n === 1 ? '' : 's'}. See Alerts.`);
  }, 4000);
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
    if (a.severity === 'critical') toastAlert(a);
    if (route().name === 'alerts') viewAlerts();
  });
  // Many alerts at once (e.g. the first sync of a large estate): reload the feed instead of one toast each.
  es.addEventListener('alerts', async () => {
    S.alerts = await api('/api/alerts?limit=300').catch(() => S.alerts);
    renderFeed();
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
      updateAlertBadge();
      const r = route().name;
      if (['overview', 'estate', 'devices', 'map'].includes(r) && !$('#drawerWrap') && !S.openFilter && !S.selected.size && !S.schematicDirty) refreshView();
      if (r === 'connections' && !$('#drawerWrap')) viewConnections();
    }, 500);
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  try { S.me = await api('/api/me'); } catch { renderLogin(); return; }
  const [options, connectors, alerts, customers, config] = await Promise.all([api('/api/filters'), api('/api/connectors'), api('/api/alerts?limit=100'), api('/api/customers'), S.config ? S.config : fetch('/api/config').then((r) => r.json()).catch(() => ({}))]);
  Object.assign(S, { options, connectors, alerts, customers, config });
  for (const c of connectors) { OEM_SHORT[c.oem] = c.short || c.displayName.slice(0, 2).toUpperCase(); OEM_NAME[c.oem] = c.displayName; }
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
  if (!can('estate.edit') || !S.selected.size) { bar?.remove(); return; }
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
  return api('/api/devices/lookup', { method: 'POST', body: { ids: [...S.selected] } });
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
  const list = `<div class="muted" style="margin-bottom:12px">${devs.slice(0, 8).map((d) => `${esc(d.make)} ${esc(shortModel(d.make, d.model))} · ${esc(d.room)}`).join('<br>')}${devs.length > 8 ? `<br>…and ${devs.length - 8} more` : ''}</div>`;
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
const HCOLOR = { healthy: '#0ca30c', warning: '#fab219', critical: '#d03b3b', offline: '#7d8399', unmonitored: '#9aa1b8', none: '#b8bdcc' };

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
  // Open map data: OpenStreetMap tiles by default, with a switcher for the other layers.
  if (!S.config?.mapLayers) S.config = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  const layers = S.config?.mapLayers?.length ? S.config.mapLayers : [{ id: 'osm', name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }];
  // OpenStreetMap's tile policy needs a Referer, so tiles send the site origin (the rest of the app sends none).
  const base = Object.fromEntries(layers.map((l) => [l.name, L.tileLayer(l.url, { maxZoom: l.maxZoom || 19, subdomains: l.subdomains || 'abc', attribution: l.attribution, referrerPolicy: 'strict-origin-when-cross-origin', crossOrigin: false })]));
  let chosen = null;
  try { chosen = localStorage.getItem('dm.mapLayer'); } catch { /* ignore */ }
  (base[chosen] || Object.values(base)[0]).addTo(map);
  if (layers.length > 1) L.control.layers(base, null, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => { try { localStorage.setItem('dm.mapLayer', e.name); } catch { /* ignore */ } });
  MAP = { map, sites, sel: selection, layer: L.layerGroup().addTo(map) };
  const key = (s) => `${s.customerId}|${s.site}`;
  const worstOf = (list) => ['critical', 'offline', 'warning', 'healthy'].find((h) => list.some((s) => s.health[h])) || 'none';
  const sev = (s) => ['none', 'unmonitored', 'healthy', 'warning', 'offline', 'critical'].indexOf(s.worst);
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
      // Sites close together on screen are drawn as one cluster pin (count = devices), and
      // only pins inside the visible area (plus a margin) are drawn, so thousands of sites stay fast.
      const view = map.getBounds().pad(0.25);
      const cells = new Map();
      const CELL = 64;
      for (const s of placed) {
        if (!view.contains([s.lat, s.lng])) continue;
        const pt = map.project([s.lat, s.lng], z);
        const k = `${Math.floor(pt.x / CELL)}|${Math.floor(pt.y / CELL)}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(s);
      }
      for (const list of cells.values()) {
        if (list.length === 1 || z >= map.getMaxZoom()) {
          for (const s of list) {
            const m = L.marker([s.lat, s.lng], { icon: pin(s.health.total, HCOLOR[s.worst], MAP.sel.siteKey === key(s) ? 48 : 40, s.site) }).addTo(MAP.layer);
            m.on('click', () => selectSite(s, true));
            m.bindTooltip(regionTip(s.site, [s]), { direction: 'top', offset: [0, -24] });
          }
          continue;
        }
        const lat = list.reduce((a, s) => a + s.lat, 0) / list.length;
        const lng = list.reduce((a, s) => a + s.lng, 0) / list.length;
        const size = Math.min(64, 42 + Math.round(Math.log2(list.length) * 3));
        const m = L.marker([lat, lng], { icon: pin(sum(list), HCOLOR[worstOf(list)], size, `${list.length} sites`) }).addTo(MAP.layer);
        m.on('click', () => map.fitBounds(L.latLngBounds(list.map((s) => [s.lat, s.lng])).pad(0.5), { maxZoom: Math.min(map.getMaxZoom(), z + 3) }));
        m.bindTooltip(regionTip(`${list.length} sites`, list), { direction: 'top', offset: [0, -28] });
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
      ${[...byRegion.entries()].map(([r, list]) => { const top = [...list].sort((a, b) => sev(b) - sev(a) || b.health.total - a.health.total).slice(0, 25); return `<div class="side-group"><div class="side-title">${esc(r)} <span class="muted">${list.length.toLocaleString()} sites · ${sum(list).toLocaleString()} devices</span></div>
        ${top.map((s) => `<button class="side-row" data-site="${esc(key(s))}">${status(s.worst)}<span class="grow">${esc(s.site)}${multi() && !acting() ? `<small>${esc(s.customerName)}</small>` : ''}</span><b>${s.health.total}</b></button>`).join('')}
        ${list.length > top.length ? `<div class="muted" style="font-size:12px;padding:4px 8px">${list.length - top.length} more sites. Worst first; zoom in or filter to see the rest.</div>` : ''}</div>`; }).join('')}
      ${unplaced.length ? `<div class="notice info" style="margin-top:12px">${unplaced.length} site(s) have no coordinates: ${unplaced.slice(0, 20).map((s) => esc(s.site)).join(', ')}${unplaced.length > 20 ? '…' : ''}.${isSuper() ? ' Add them under Customers.' : ''}</div>` : ''}`;
    bindSide();
  };
  // Room lists come from the tree for that one site (the map itself only carries site totals).
  const siteRooms = async (s, withDevices) => {
    const t = await api(`/api/tree${qs({ customer: s.customerId, site: s.site, devices: withDevices ? '1' : '' })}`).catch(() => []);
    return t.find((x) => x.customerId === s.customerId && x.site === s.site)?.rooms || [];
  };
  const selectSite = async (s, fly) => {
    MAP.sel = { siteKey: key(s), room: null };
    if (fly && s.lat !== null) map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 11), { duration: 0.8 });
    s.rooms = await siteRooms(s, false);
    if (MAP?.sel.siteKey !== key(s)) return;
    side.innerHTML = `${crumbs([{ label: 'All regions', act: 1 }, { label: s.site }])}
      <h2>${esc(s.site)}</h2><div class="card-sub">${multi() && !acting() ? `${esc(s.customerName)} · ` : ''}${esc([s.city, s.country].filter(Boolean).join(', ') || s.region)}${s.address ? `<br>${esc(s.address)}` : ''}</div>
      <div class="counts" style="display:flex;gap:12px;margin:12px 0">${HEALTH_BARS.filter((h) => s.health[h]).map((h) => `<span class="st ${h}">${ICONS[h]}${s.health[h]}</span>`).join('')}</div>
      <div class="side-title">${s.rooms.length} rooms</div>
      ${s.rooms.map((r) => `<button class="side-row" data-room="${esc(r.room)}">${status(r.worst)}<span class="grow">${esc(r.room)}<small>${esc(r.platform)} · ${r.deviceCount} devices${r.hasSchematic ? ' · schematic' : ''}</small></span></button>`).join('') || '<div class="empty">No rooms yet</div>'}
      <a class="btn btn-outline btn-sm" style="margin-top:12px" href="#/estate/${encodeURIComponent(s.customerId)}/${encodeURIComponent(s.site)}">Open site page</a>`;
    bindSide(s);
    draw();
  };
  const selectRoom = async (s, room) => {
    MAP.sel = { siteKey: key(s), room: room.room };
    const r = (await siteRooms(s, true)).find((x) => x.room === room.room) || { ...room, devices: [] };
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
  map.on('moveend', () => { if (map.getZoom() >= 4) draw(); });
  if (keepView) map.setView(center, zoom, { animate: false });
  else if (placed.length) map.fitBounds(L.latLngBounds(placed.map((x) => [x.lat, x.lng])).pad(0.3));
  draw();
  const selSite = selection.siteKey && sites.find((x) => key(x) === selection.siteKey);
  if (selSite && selection.room) selectRoom(selSite, { room: selection.room });
  else if (selSite) selectSite(selSite, false);
  else showWorld();
  setTimeout(() => map.invalidateSize(), 50);
}

// ------------------------------------------------------------------ room schematic designer
// Building blocks with typed ports (HDMI in/out, USB, LAN, power...) are
// placed on a canvas and wired port to port. The same drawing is the
// troubleshooting view: live health on linked devices, a cable schedule,
// signal-path tracing and flagged cables.
const KIND_LABEL = { core: 'Codec / video bar', controller: 'Controller', camera: 'Camera', audio: 'Audio', display: 'Display', source: 'Source / PC', network: 'Network', av: 'AV signal', power: 'Power', peripheral: 'Other' };
const KIND_COLOR = { core: '#1a5cff', controller: '#6b4bff', camera: '#12b5e5', audio: '#b4318f', display: '#0b1d4d', source: '#e07a1f', network: '#0d8fb3', av: '#3b77ff', power: '#4a5373', peripheral: '#9aa1b8' };
const CABLE_STYLE = {
  HDMI: ['#1a5cff', ''], DisplayPort: ['#3b77ff', '6 4'], HDBaseT: ['#2c3e9e', '9 3'], USB: ['#6b4bff', ''], 'USB-C': ['#9b7bff', ''],
  Ethernet: ['#0d8fb3', ''], PoE: ['#0b6e8a', '6 4'], Audio: ['#b4318f', ''], Speaker: ['#d0569f', '4 3'], Fibre: ['#e07a1f', ''], Power: ['#4a5373', '2 4'], Wireless: ['#7d849e', '1 5'],
};
const COND_LABEL = { ok: 'Tested OK', suspect: 'Suspect', faulty: 'Faulty' };
const DIR_LABEL = { in: 'In', out: 'Out', io: 'In/out' };
const DEVTYPE_BLOCK = { 'Video bar': 'video-bar', 'Video system': 'codec', 'Touch controller': 'controller', Camera: 'camera', 'Whiteboard camera': 'content-camera', 'Conference phone': 'speakerphone', 'Desk phone': 'speakerphone', 'Room PC': 'room-pc', 'Room sensor': 'sensor', Display: 'display' };
const PORT_FAMILY = { PoE: 'Ethernet', 'USB-C': 'USB', Speaker: 'Audio' };
const portFits = (a, b) => (PORT_FAMILY[a] || a) === (PORT_FAMILY[b] || b);
const BW = 216; const HEAD = 48; const ROW = 20;
const portKey = (id, name) => `${id}|${String(name || '').toLowerCase()}`;

function portSide(n, p) {
  if (p.dir === 'in') return 'L';
  if (p.dir === 'out') return 'R';
  return ['network', 'power', 'source'].includes(n.kind) ? 'R' : 'L';
}
function nodeGeom(n) {
  const left = []; const right = [];
  for (const p of n.ports || []) (portSide(n, p) === 'L' ? left : right).push(p);
  return { w: BW, h: HEAD + Math.max(left.length, right.length, 1) * ROW + 8, left, right };
}
function portAnchor(n, name) {
  const g = nodeGeom(n);
  const key = String(name || '').toLowerCase();
  let i = g.left.findIndex((p) => p.name.toLowerCase() === key);
  if (i >= 0) return { x: n.x, y: n.y + HEAD + i * ROW + ROW / 2, dir: -1 };
  i = g.right.findIndex((p) => p.name.toLowerCase() === key);
  if (i >= 0) return { x: n.x + g.w, y: n.y + HEAD + i * ROW + ROW / 2, dir: 1 };
  return { x: n.x + g.w, y: n.y + HEAD / 2, dir: 1 };
}

const LAYOUT_COL = { source: 0, network: 0, power: 0, camera: 1, audio: 1, controller: 1, av: 1, peripheral: 1, core: 2, display: 3 };
/** Give positions to nodes that have none (or to all, when `all`). */
function autoLayout(sch, all = false) {
  const colY = [24, 24, 24, 24];
  for (const n of sch.nodes) if (!all && Number.isFinite(n.x)) { const c = LAYOUT_COL[n.kind] ?? 1; colY[c] = Math.max(colY[c], n.y + nodeGeom(n).h + 28); }
  for (const n of sch.nodes) {
    if (!all && Number.isFinite(n.x)) continue;
    const c = LAYOUT_COL[n.kind] ?? 1;
    n.x = 24 + c * 270; n.y = colY[c];
    colY[c] += nodeGeom(n).h + 28;
  }
  return sch;
}

function linkGeom(sch, l) {
  const a = sch.nodes.find((n) => n.id === l.from); const b = sch.nodes.find((n) => n.id === l.to);
  if (!a || !b) return null;
  const p = portAnchor(a, l.fromPort); const q = portAnchor(b, l.toPort);
  const c = Math.max(46, Math.abs(q.x - p.x) / 2);
  const c1 = { x: p.x + p.dir * c, y: p.y }; const c2 = { x: q.x + q.dir * c, y: q.y };
  return { d: `M${p.x},${p.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${q.x},${q.y}`, mx: (p.x + 3 * c1.x + 3 * c2.x + q.x) / 8, my: (p.y + 3 * c1.y + 3 * c2.y + q.y) / 8 };
}
const cableText = (l) => [l.label, l.cable, l.length ? `${l.length} m` : null].filter(Boolean).join(' · ');
const nodeName = (sch, id) => sch.nodes.find((n) => n.id === id)?.label || id;
const endText = (sch, id, port) => `${nodeName(sch, id)}${port ? ` · ${port}` : ''}`;

/** Upstream and downstream items of a node, following cable direction. */
function tracePath(sch, id) {
  const walk = (start, fwd) => {
    const seen = new Set(); const links = new Set(); const q = [start];
    while (q.length) {
      const cur = q.shift();
      sch.links.forEach((l, i) => {
        const [a, b] = fwd ? [l.from, l.to] : [l.to, l.from];
        if (a !== cur) return;
        links.add(i);
        if (!seen.has(b) && b !== start) { seen.add(b); q.push(b); }
      });
    }
    return { nodes: seen, links };
  };
  const up = walk(id, false); const down = walk(id, true);
  return { up: up.nodes, down: down.nodes, links: new Set([...up.links, ...down.links]) };
}

/** The schematic as SVG markup (no outer <svg>). */
function schematicBody(sch, devices, o = {}) {
  const dev = new Map(devices.map((d) => [d.id, d]));
  const used = new Map();
  sch.links.forEach((l, i) => { used.set(portKey(l.from, l.fromPort), i); used.set(portKey(l.to, l.toPort), i); });
  const dim = o.trace ? (id) => id !== o.sel?.id && !o.trace.up.has(id) && !o.trace.down.has(id) : () => false;
  const labels = [];
  const links = sch.links.map((l, i) => {
    const g = linkGeom(sch, l); if (!g) return '';
    let [color, dash] = CABLE_STYLE[l.cable] || ['#7d849e', ''];
    if (l.condition === 'faulty') { color = '#d03b3b'; dash = '5 3'; } else if (l.condition === 'suspect') color = '#c98a00';
    const sel = o.sel?.type === 'link' && o.sel.i === i;
    const faded = o.trace && !o.trace.links.has(i);
    const txt = cableText(l); const tw = txt.length * 6.1 + 16;
    const title = `<title>${esc(`${endText(sch, l.from, l.fromPort)} → ${endText(sch, l.to, l.toPort)}\n${txt}${l.condition ? ` · ${COND_LABEL[l.condition]}` : ''}${l.note ? `\n${l.note}` : ''}`)}</title>`;
    // Cable tags sit above the blocks so they stay readable.
    labels.push(`<g class="sl sl-tag${faded ? ' faded' : ''}" data-link="${i}">${title}<rect x="${g.mx - tw / 2}" y="${g.my - 9}" width="${tw}" height="18" rx="9" fill="#fff" stroke="${color}" stroke-width="${sel ? 2 : 1}"/><text x="${g.mx}" y="${g.my + 4}" text-anchor="middle" fill="${color}" class="sl-t">${esc(txt)}</text></g>`);
    return `<g class="sl${sel ? ' sel' : ''}${faded ? ' faded' : ''}" data-link="${i}">${title}
      <path class="sl-hit" d="${g.d}"/><path class="sl-line" d="${g.d}" stroke="${color}" stroke-dasharray="${dash}" stroke-width="${sel ? 4 : l.condition === 'faulty' ? 3 : 2.2}"/></g>`;
  }).join('');
  const nodes = sch.nodes.map((n) => {
    const g = nodeGeom(n); const d = n.deviceId ? dev.get(n.deviceId) : null;
    const sel = o.sel?.type === 'node' && o.sel.id === n.id;
    const kc = KIND_COLOR[n.kind] || '#9aa1b8';
    const sub = [n.model && n.model !== n.label ? n.model : KIND_LABEL[n.kind], n.location].filter(Boolean).join(' · ');
    const port = (p, i, side) => {
      const y = HEAD + i * ROW + ROW / 2; const li = used.get(portKey(n.id, p.name)); const l = li === undefined ? null : sch.links[li];
      const color = l?.condition === 'faulty' ? '#d03b3b' : (CABLE_STYLE[p.type] || ['#7d849e'])[0];
      const x = side === 'L' ? -5 : g.w - 5;
      return `<g class="sp${o.pending && o.pending.node === n.id && o.pending.port === p.name ? ' armed' : ''}" data-node="${esc(n.id)}" data-port="${esc(p.name)}"><title>${esc(`${p.name} · ${p.type} ${DIR_LABEL[p.dir].toLowerCase()}${l ? `\n→ ${l.from === n.id ? endText(sch, l.to, l.toPort) : endText(sch, l.from, l.fromPort)}` : '\nFree'}`)}</title>
        <rect class="sp-hit" x="${side === 'L' ? -10 : g.w - 70}" y="${y - ROW / 2}" width="80" height="${ROW}"/>
        <rect x="${x}" y="${y - 5}" width="10" height="10" rx="2.5" fill="${l ? color : '#fff'}" stroke="${color}" stroke-width="1.6"/>
        <text x="${side === 'L' ? 11 : g.w - 11}" y="${y + 4}" text-anchor="${side === 'L' ? 'start' : 'end'}" class="sp-t${l ? '' : ' free'}">${esc(p.name.length > 15 ? `${p.name.slice(0, 14)}…` : p.name)}</text></g>`;
    };
    return `<g class="sn${sel ? ' sel' : ''}${dim(n.id) ? ' faded' : ''}" data-node="${esc(n.id)}" transform="translate(${n.x},${n.y})">
      <rect class="sn-box" width="${g.w}" height="${g.h}" rx="10" stroke="${d ? HCOLOR[d.health] : '#d5dbea'}" stroke-width="${d && d.health !== 'healthy' ? 2.6 : 1.3}"/>
      <rect width="${g.w}" height="5" rx="2.5" fill="${kc}"/>
      <text x="12" y="23" class="sn-t">${esc(n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label)}</text>
      <text x="12" y="39" class="sn-s">${esc(sub.length > 32 ? `${sub.slice(0, 31)}…` : sub)}</text>
      ${d ? `<g><title>${esc(`${HLABEL[d.health]}${d.healthReason ? `: ${d.healthReason}` : ''}`)}</title><circle cx="${g.w - 15}" cy="20" r="6" fill="${HCOLOR[d.health]}"/></g>` : ''}
      ${g.left.map((p, i) => port(p, i, 'L')).join('')}${g.right.map((p, i) => port(p, i, 'R')).join('')}</g>`;
  }).join('');
  return `${links}${nodes}${labels.join('')}<path id="tmpWire" class="tmp-wire" d=""/>`;
}
function canvasSize(sch) {
  let w = 700; let h = 300;
  for (const n of sch.nodes) { const g = nodeGeom(n); w = Math.max(w, n.x + g.w + 120); h = Math.max(h, n.y + g.h + 60); }
  return { w, h };
}

/** Read-only drawing, e.g. the map sidebar. */
function schematicSVG(sch, devices = []) {
  if (!sch?.nodes?.length) return '<div class="empty">No schematic yet</div>';
  const s = autoLayout(structuredClone(sch));
  const { w, h } = canvasSize(s);
  return `<svg class="schem-svg" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Room schematic">${schematicBody(s, devices)}</svg>`;
}

/** What to check in this room: unhealthy linked devices with their cabling, and flagged cables. */
function roomFindings(sch, devices) {
  const out = [];
  const dev = new Map(devices.map((d) => [d.id, d]));
  for (const n of sch.nodes) {
    const d = n.deviceId ? dev.get(n.deviceId) : null;
    if (n.deviceId && !d) { out.push({ level: 'warning', node: n.id, title: `${n.label} is linked to a device that is no longer in this room`, checks: [], affected: [] }); continue; }
    if (!d || !['warning', 'critical', 'offline'].includes(d.health)) continue;
    const checks = sch.links.filter((l) => l.to === n.id || l.from === n.id).map((l) => {
      const mine = l.from === n.id ? l.fromPort : l.toPort;
      const other = l.from === n.id ? endText(sch, l.to, l.toPort) : endText(sch, l.from, l.fromPort);
      return `${mine || 'Cable'} ${l.from === n.id ? '→' : '←'} ${other} (${cableText(l)}${l.condition ? `, ${COND_LABEL[l.condition].toLowerCase()}` : ''})`;
    });
    const t = tracePath(sch, n.id);
    out.push({ level: d.health === 'warning' ? 'warning' : 'critical', node: n.id, title: `${n.label} is ${HLABEL[d.health].toLowerCase()}${d.healthReason ? `: ${d.healthReason}` : ''}`, checks, affected: [...t.down].map((id) => nodeName(sch, id)) });
  }
  sch.links.forEach((l, i) => {
    if (l.condition === 'faulty' || l.condition === 'suspect') out.push({ level: l.condition === 'faulty' ? 'critical' : 'warning', link: i, title: `${l.label ? `Cable ${l.label}` : `${l.cable} cable`} is marked ${COND_LABEL[l.condition].toLowerCase()}`, checks: [`${endText(sch, l.from, l.fromPort)} → ${endText(sch, l.to, l.toPort)}${l.note ? ` · ${l.note}` : ''}`], affected: [...tracePath(sch, l.to).down, l.to].map((id) => nodeName(sch, id)) });
  });
  const placed = new Set(sch.nodes.map((n) => n.deviceId).filter(Boolean));
  const missing = devices.filter((d) => !placed.has(d.id));
  if (sch.nodes.length && missing.length) out.push({ level: 'info', title: `${missing.length} device${missing.length > 1 ? 's' : ''} in this room ${missing.length > 1 ? 'are' : 'is'} not on the schematic`, checks: missing.slice(0, 6).map((d) => d.model), affected: [] });
  return out;
}

function csvCell(v) { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; }
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name.replace(/[^a-z0-9.-]+/gi, '_'); a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function mountSchematic(card, ctx) {
  const { customerId, site, room, devices } = ctx;
  const q = `customerId=${encodeURIComponent(customerId)}&site=${encodeURIComponent(site)}&room=${encodeURIComponent(room)}`;
  const [saved, templates, lib] = await Promise.all([api(`/api/rooms/schematic?${q}`), S.templates || api('/api/schematic-templates'), S.blockLib || api('/api/schematic-blocks')]);
  S.templates = templates; S.blockLib = lib;
  const blank = () => ({ nodes: [], links: [] });
  let draft = autoLayout(saved ? structuredClone(saved) : blank());
  let editing = false; let sel = null; let pending = null; let zoom = 1; let undo = [];
  const openGroups = new Set(['__dev', 'Video', 'Control']);
  S.schematicDirty = false;
  const devById = new Map(devices.map((d) => [d.id, d]));
  const nid = () => { let i = draft.nodes.length + 1; while (draft.nodes.some((n) => n.id === `n${i}`)) i++; return `n${i}`; };
  const nextTag = () => { let m = 0; for (const l of draft.links) { const x = /^C-?(\d+)$/i.exec(l.label || ''); if (x) m = Math.max(m, Number(x[1])); } return `C-${String(m + 1).padStart(2, '0')}`; };
  const snap = () => { undo.push(JSON.stringify(draft)); if (undo.length > 40) undo.shift(); S.schematicDirty = true; };
  const usedPort = (id, port, except = -1) => draft.links.findIndex((l, i) => i !== except && l.cable !== 'Wireless' && ((l.from === id && (l.fromPort || '').toLowerCase() === String(port).toLowerCase()) || (l.to === id && (l.toPort || '').toLowerCase() === String(port).toLowerCase())));
  const say = (msg, kind = 'err') => { const m = $('#scMsg', card); if (m) m.innerHTML = msg ? `<div class="notice ${kind}">${esc(msg)}</div>` : ''; };

  const render = () => {
    // Keep scroll positions across re-renders.
    const keep = ['#scCanvasWrap', '.palette', '#scInspector'].map((k) => { const el = $(k, card); return el ? [k, el.scrollLeft, el.scrollTop] : null; }).filter(Boolean);
    paint();
    for (const [k, l, t] of keep) { const el = $(k, card); if (el) { el.scrollLeft = l; el.scrollTop = t; } }
  };
  const paint = () => {
    const { w, h } = canvasSize(draft);
    const findings = editing ? [] : roomFindings(draft, devices);
    const crit = findings.filter((f) => f.level !== 'info').length;
    card.innerHTML = `<div class="card-head"><div><h2>Room schematic</h2><div class="card-sub">${editing ? 'Add building blocks, then drag from one port to another to connect a cable. Drag blocks to move them.' : `Port-to-port cabling for troubleshooting${saved?.updatedAt ? ` · saved ${ago(saved.updatedAt)}${saved.updatedBy ? ` by ${esc(saved.updatedBy)}` : ''}` : ''}`}</div></div>
      <div class="schem-actions">${draft.nodes.length && !editing ? '<button class="btn btn-outline btn-sm" id="scCsv">Cable schedule (CSV)</button><button class="btn btn-outline btn-sm" id="scExport">Export JSON</button>' : ''}
        ${can('rooms.design') && !editing ? `<button class="btn btn-primary btn-sm" id="scEdit">${draft.nodes.length ? 'Open designer' : 'Design schematic'}</button>` : ''}</div></div>
      ${editing ? designerToolbar() : ''}
      <div id="scMsg"></div>
      ${!draft.nodes.length && !editing ? `<div class="empty">No schematic for this room yet.${can('rooms.design') ? ' Open the designer to draw one from building blocks or a template, or upload an existing drawing below.' : ''}</div>` : `
      <div class="designer${editing ? ' editing' : ''}">
        ${editing ? `<div class="palette">${paletteHtml()}</div>` : ''}
        <div class="canvas-wrap" id="scCanvasWrap"><svg class="schem-canvas" id="scSvg" width="${w * zoom}" height="${h * zoom}" viewBox="0 0 ${w} ${h}">${schematicBody(draft, devices, { sel, pending, trace: !editing && sel?.type === 'node' ? tracePath(draft, sel.id) : null })}</svg></div>
        <div class="inspector" id="scInspector">${editing ? inspectorHtml() : troubleshootHtml(findings)}</div>
      </div>
      <div class="legend schem-legend">${[...new Set(draft.links.map((l) => l.cable))].map((c) => `<span><i style="background:${(CABLE_STYLE[c] || ['#7d849e'])[0]}"></i>${esc(c)}</span>`).join('')}<span><i style="background:#d03b3b"></i>Faulty cable</span><span class="muted">${editing ? 'Hollow ports are free' : 'Click an item to trace its signal path'}</span></div>
      ${draft.links.length ? cableSchedule() : ''}`}
      ${editing ? `<div class="schem-foot">${saved ? '<button class="btn btn-danger btn-sm" id="scDelete">Delete schematic</button>' : ''}<span class="grow"></span>
        <button class="btn btn-outline btn-sm" id="scCancel">Cancel</button><button class="btn btn-primary btn-sm" id="scSave">Save schematic</button></div>` : ''}`;
    if (!editing && crit && !sel) card.querySelector('.inspector')?.classList.add('alerting');
    bind();
  };

  const designerToolbar = () => `<div class="schem-toolbar">
    <select id="scTpl" aria-label="Template"><option value="">Start from a template…</option>${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
    <label class="btn btn-outline btn-sm file-btn">Load JSON<input type="file" id="scFile" accept="application/json,.json" hidden></label>
    <span class="tb-sep"></span>
    <button class="btn btn-outline btn-sm" id="scUndo" ${undo.length ? '' : 'disabled'}>Undo</button>
    <button class="btn btn-outline btn-sm" id="scArrange">Auto-arrange</button>
    <button class="btn btn-outline btn-sm" id="scZoomOut" aria-label="Zoom out">−</button><span class="muted zoom-lbl">${Math.round(zoom * 100)}%</span><button class="btn btn-outline btn-sm" id="scZoomIn" aria-label="Zoom in">+</button>
  </div>`;

  const paletteHtml = () => {
    const groups = [...new Set(lib.blocks.map((b) => b.group))];
    const unplaced = devices.filter((d) => !draft.nodes.some((n) => n.deviceId === d.id));
    return `${unplaced.length ? `<details data-g="__dev" ${openGroups.has('__dev') ? 'open' : ''}><summary>This room's devices</summary>${unplaced.map((d) => `<button class="pal-item" data-dev="${esc(d.id)}"><i style="background:${HCOLOR[d.health]}"></i>${esc(d.model)}<small>${esc(d.deviceType)}</small></button>`).join('')}</details>` : ''}
      ${groups.map((g) => `<details data-g="${esc(g)}" ${openGroups.has(g) ? 'open' : ''}><summary>${esc(g)}</summary>${lib.blocks.filter((b) => b.group === g).map((b) => `<button class="pal-item" data-block="${b.id}"><i style="background:${KIND_COLOR[b.kind]}"></i>${esc(b.name)}<small>${b.ports.length} ports</small></button>`).join('')}</details>`).join('')}`;
  };

  const portOptions = (id, cur) => {
    const n = draft.nodes.find((x) => x.id === id);
    return (n?.ports || []).map((p) => `<option value="${esc(p.name)}" ${p.name === cur ? 'selected' : ''}>${esc(p.name)} (${esc(p.type)})</option>`).join('') + (cur && !(n?.ports || []).some((p) => p.name === cur) ? `<option selected>${esc(cur)}</option>` : '');
  };

  const inspectorHtml = () => {
    if (sel?.type === 'node') {
      const n = draft.nodes.find((x) => x.id === sel.id); if (!n) return '';
      const block = lib.blocks.find((b) => b.id === n.block);
      return `<div class="insp-title">${esc(n.label)}<small>${esc(block?.name || KIND_LABEL[n.kind])}</small></div>
        <div class="field"><label>Name</label><input data-nf="label" value="${esc(n.label)}" maxlength="80"></div>
        <div class="field"><label>Type</label><select data-nf="kind">${lib.kinds.map((k) => `<option value="${k}" ${k === n.kind ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}</select></div>
        <div class="field"><label>Model</label><input data-nf="model" value="${esc(n.model || '')}" maxlength="80"></div>
        <div class="field"><label>Monitored device</label><select data-nf="deviceId"><option value="">Not linked</option>${devices.map((d) => `<option value="${esc(d.id)}" ${d.id === n.deviceId ? 'selected' : ''}>${esc(d.model)}${d.serial ? ` (${esc(d.serial)})` : ''}</option>`).join('')}</select><div class="help">Linked items show live health and are traced when they fail.</div></div>
        <div class="field"><label>Location</label><input data-nf="location" value="${esc(n.location || '')}" placeholder="e.g. Under table, rack, behind display" maxlength="60"></div>
        <div class="field"><label>Notes</label><textarea data-nf="notes" rows="2" maxlength="300">${esc(n.notes || '')}</textarea></div>
        <div class="section-title" style="margin-top:14px">Ports</div>
        <div class="port-rows">${(n.ports || []).map((p, i) => `<div class="port-row"><input data-pf="name" data-pi="${i}" value="${esc(p.name)}" maxlength="40" aria-label="Port name">
          <select data-pf="type" data-pi="${i}" aria-label="Port type">${lib.cables.map((c) => `<option ${c === p.type ? 'selected' : ''}>${c}</option>`).join('')}</select>
          <select data-pf="dir" data-pi="${i}" aria-label="Direction">${['in', 'out', 'io'].map((d) => `<option value="${d}" ${d === p.dir ? 'selected' : ''}>${DIR_LABEL[d]}</option>`).join('')}</select>
          <button class="linkbtn" data-delport="${i}" aria-label="Remove port">×</button></div>`).join('') || '<div class="muted">No ports yet.</div>'}</div>
        <button class="btn btn-outline btn-sm" id="scAddPort">Add port</button>
        <div class="insp-foot"><button class="btn btn-outline btn-sm" id="scDup">Duplicate</button><button class="btn btn-danger btn-sm" id="scDelSel">Remove item</button></div>`;
    }
    if (sel?.type === 'link') {
      const l = draft.links[sel.i]; if (!l) return '';
      const nodeOpts = (cur) => draft.nodes.map((n) => `<option value="${esc(n.id)}" ${n.id === cur ? 'selected' : ''}>${esc(n.label)}</option>`).join('');
      const a = draft.nodes.find((n) => n.id === l.from)?.ports?.find((p) => p.name === l.fromPort);
      const b = draft.nodes.find((n) => n.id === l.to)?.ports?.find((p) => p.name === l.toPort);
      const mismatch = a && b && !portFits(a.type, b.type) ? `<div class="notice err">The ports don't match (${esc(a.type)} to ${esc(b.type)}). Check an adapter or converter is fitted, or add it as a block.</div>` : '';
      return `<div class="insp-title">${esc(l.label ? `Cable ${l.label}` : `${l.cable} cable`)}<small>${esc(endText(draft, l.from, l.fromPort))} → ${esc(endText(draft, l.to, l.toPort))}</small></div>${mismatch}
        <div class="grid cols-2" style="gap:8px"><div class="field"><label>From</label><select data-lf="from">${nodeOpts(l.from)}</select></div><div class="field"><label>Port</label><select data-lf="fromPort">${portOptions(l.from, l.fromPort)}</select></div>
        <div class="field"><label>To</label><select data-lf="to">${nodeOpts(l.to)}</select></div><div class="field"><label>Port</label><select data-lf="toPort">${portOptions(l.to, l.toPort)}</select></div></div>
        <div class="grid cols-2" style="gap:8px"><div class="field"><label>Cable type</label><select data-lf="cable">${lib.cables.map((c) => `<option ${c === l.cable ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Cable tag</label><input data-lf="label" value="${esc(l.label || '')}" placeholder="e.g. C-03" maxlength="24"></div>
        <div class="field"><label>Length (m)</label><input data-lf="length" type="number" min="0" step="0.5" value="${esc(l.length ?? '')}"></div>
        <div class="field"><label>Condition</label><select data-lf="condition"><option value="">Not tested</option>${lib.conditions.map((c) => `<option value="${c}" ${c === l.condition ? 'selected' : ''}>${COND_LABEL[c]}</option>`).join('')}</select></div></div>
        <div class="field"><label>Note</label><input data-lf="note" value="${esc(l.note || '')}" placeholder="e.g. Runs through floor box, EDID minder fitted" maxlength="200"></div>
        <div class="insp-foot"><button class="btn btn-outline btn-sm" id="scSwap">Swap ends</button><button class="btn btn-danger btn-sm" id="scDelSel">Remove cable</button></div>`;
    }
    return `<div class="insp-title">Designer<small>${draft.nodes.length} items · ${draft.links.length} cables</small></div>
      <ol class="tips"><li>Click a building block on the left to add it. Pick a template above to start faster.</li><li>Drag from a port square to another port to run a cable. Outputs (right side) feed inputs (left side).</li><li>Click a block or cable to edit its ports, tag, length or condition.</li><li>Link blocks to monitored devices so live health shows on the drawing.</li></ol>
      <div class="field"><label>Room notes</label><textarea id="scNotes" rows="4" maxlength="1000" placeholder="e.g. Rack in comms cupboard B. HDMI runs are 4K-rated.">${esc(draft.notes || '')}</textarea></div>
      <div class="muted" style="font-size:12px">Delete removes the selected item. Ctrl+Z undoes.</div>`;
  };

  const troubleshootHtml = (findings) => {
    if (sel?.type === 'node') {
      const n = draft.nodes.find((x) => x.id === sel.id); if (!n) return '';
      const d = n.deviceId ? devById.get(n.deviceId) : null;
      const t = tracePath(draft, n.id);
      const conns = draft.links.map((l, i) => ({ l, i })).filter(({ l }) => l.from === n.id || l.to === n.id);
      return `<div class="insp-title">${esc(n.label)}<small>${esc([n.model, KIND_LABEL[n.kind], n.location].filter(Boolean).join(' · '))}</small></div>
        ${d ? `<div style="margin:6px 0 10px">${status(d.health)}${d.healthReason && d.health !== 'healthy' ? `<div class="muted" style="font-size:12.5px;margin-top:4px">${esc(d.healthReason)}</div>` : ''}<button class="linkbtn" data-opendev="${esc(d.id)}">Device details</button></div>` : '<div class="muted" style="margin-bottom:10px">Not linked to a monitored device.</div>'}
        ${n.notes ? `<div class="notice info">${esc(n.notes)}</div>` : ''}
        <div class="section-title" style="margin-top:8px">Cables (${conns.length})</div>
        ${conns.map(({ l, i }) => { const out = l.from === n.id; return `<button class="conn-row" data-sellink="${i}"><b>${esc((out ? l.fromPort : l.toPort) || '—')}</b> ${out ? '→' : '←'} ${esc(out ? endText(draft, l.to, l.toPort) : endText(draft, l.from, l.fromPort))}<small>${esc(cableText(l))}${l.condition ? ` · ${COND_LABEL[l.condition]}` : ''}</small></button>`; }).join('') || '<div class="muted">No cables.</div>'}
        ${(n.ports || []).filter((p) => usedPort(n.id, p.name) < 0).length ? `<div class="muted" style="font-size:12px;margin-top:6px">Free ports: ${esc(n.ports.filter((p) => usedPort(n.id, p.name) < 0).map((p) => p.name).join(', '))}</div>` : ''}
        <div class="section-title">Depends on</div><div class="trace-list">${[...t.up].map((id) => `<span>${esc(nodeName(draft, id))}</span>`).join('') || '<span class="muted">Nothing upstream</span>'}</div>
        <div class="section-title">Affected if it fails</div><div class="trace-list">${[...t.down].map((id) => `<span>${esc(nodeName(draft, id))}</span>`).join('') || '<span class="muted">Nothing downstream</span>'}</div>
        <button class="btn btn-outline btn-sm" id="scClear" style="margin-top:14px">Back to room check</button>`;
    }
    if (sel?.type === 'link') {
      const l = draft.links[sel.i]; if (!l) return '';
      return `<div class="insp-title">${esc(l.label ? `Cable ${l.label}` : `${l.cable} cable`)}<small>${esc(cableText(l))}</small></div>
        <dl class="kv"><dt>From</dt><dd>${esc(endText(draft, l.from, l.fromPort))}</dd><dt>To</dt><dd>${esc(endText(draft, l.to, l.toPort))}</dd><dt>Condition</dt><dd>${esc(COND_LABEL[l.condition] || 'Not tested')}</dd>${l.note ? `<dt>Note</dt><dd>${esc(l.note)}</dd>` : ''}</dl>
        <button class="btn btn-outline btn-sm" id="scClear" style="margin-top:14px">Back to room check</button>`;
    }
    return `<div class="insp-title">Room check<small>${findings.filter((f) => f.level !== 'info').length ? 'Things to look at, with the cables involved' : 'Linked devices and flagged cables'}</small></div>
      ${findings.map((f) => `<div class="finding ${f.level}" ${f.node ? `data-selnode="${esc(f.node)}"` : f.link !== undefined ? `data-sellink="${f.link}"` : ''}>
        <b>${esc(f.title)}</b>${f.checks.length ? `<ul>${f.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}${f.affected.length ? `<div class="muted">Affects: ${esc(f.affected.join(', '))}</div>` : ''}</div>`).join('') || `<div class="notice ok">All linked devices are healthy and no cables are flagged.</div>`}
      ${draft.notes ? `<div class="section-title">Room notes</div><div class="muted" style="white-space:pre-wrap">${esc(draft.notes)}</div>` : ''}`;
  };

  const cableSchedule = () => `<div class="section-title">Cable schedule</div><div class="table-wrap"><table class="cable-table"><thead><tr><th>Tag</th><th>From</th><th>Cable</th><th>Length</th><th>To</th><th>Condition</th><th>Note</th></tr></thead><tbody>
    ${draft.links.map((l, i) => ({ l, i })).sort((a, b) => (a.l.label || '~').localeCompare(b.l.label || '~', undefined, { numeric: true })).map(({ l, i }) => `<tr data-sellink="${i}" class="${sel?.type === 'link' && sel.i === i ? 'sel' : ''}"><td><b>${esc(l.label || '—')}</b></td><td>${esc(nodeName(draft, l.from))}<div class="muted">${esc(l.fromPort || '')}</div></td>
      <td><span class="cable-chip" style="--c:${(CABLE_STYLE[l.cable] || ['#7d849e'])[0]}">${esc(l.cable)}</span></td><td>${l.length ? `${l.length} m` : '—'}</td>
      <td>${esc(nodeName(draft, l.to))}<div class="muted">${esc(l.toPort || '')}</div></td><td>${l.condition ? `<span class="cond ${l.condition}">${COND_LABEL[l.condition]}</span>` : '<span class="muted">Not tested</span>'}</td><td>${esc(l.note || '')}</td></tr>`).join('')}</tbody></table></div>`;

  const addNode = (node) => {
    snap();
    // First free spot in the visible part of the canvas, scanning left to right, top to bottom.
    const wrap = $('#scCanvasWrap', card);
    const vx = (wrap?.scrollLeft || 0) / zoom; const vy = (wrap?.scrollTop || 0) / zoom;
    const vw = Math.max(600, (wrap?.clientWidth || 900) / zoom); const vh = Math.max(400, (wrap?.clientHeight || 600) / zoom);
    const h = nodeGeom(node).h;
    const free = (x, y) => draft.nodes.every((n) => { const g = nodeGeom(n); return x + BW + 20 <= n.x || x >= n.x + g.w + 20 || y + h + 20 <= n.y || y >= n.y + g.h + 20; });
    let spot = null;
    for (let y = Math.round(vy / 10) * 10 + 20; !spot && y < vy + vh * 2; y += 20) for (let x = Math.round(vx / 10) * 10 + 20; !spot && x + BW < vx + vw; x += 20) if (free(x, y)) spot = { x, y };
    if (!spot) spot = { x: 24, y: Math.max(24, ...draft.nodes.map((n) => n.y + nodeGeom(n).h + 30)) };
    const n = { id: nid(), ...node, ...spot };
    draft.nodes.push(n); sel = { type: 'node', id: n.id }; render();
  };
  const fromBlock = (b, extra = {}) => ({ label: b.name, kind: b.kind, block: b.id, ports: structuredClone(b.ports), ...extra });

  const connect = (a, b) => {
    if (a.node === b.node) return;
    const na = draft.nodes.find((n) => n.id === a.node); const nb = draft.nodes.find((n) => n.id === b.node);
    const pa = na.ports.find((p) => p.name === a.port); const pb = nb.ports.find((p) => p.name === b.port);
    if (pa.dir !== 'io' && pa.dir === pb.dir) { say(`Both ports are ${pa.dir === 'in' ? 'inputs' : 'outputs'}. Connect an output to an input.`); return; }
    if (pa.type !== 'Wireless' && usedPort(na.id, pa.name) >= 0) { say(`${na.label} · ${pa.name} already has a cable. Remove it first.`); return; }
    if (pb.type !== 'Wireless' && usedPort(nb.id, pb.name) >= 0) { say(`${nb.label} · ${pb.name} already has a cable. Remove it first.`); return; }
    let [from, to] = [a, b]; let [pf, pt] = [pa, pb];
    if (pa.dir === 'in' || pb.dir === 'out') { [from, to] = [b, a]; [pf, pt] = [pb, pa]; }
    const cable = pf.type === 'PoE' || pt.type === 'PoE' ? (portFits(pf.type, pt.type) ? 'PoE' : pf.type) : pf.type;
    snap();
    draft.links.push({ from: from.node, fromPort: from.port, to: to.node, toPort: to.port, cable, label: nextTag() });
    sel = { type: 'link', i: draft.links.length - 1 };
    render();
    if (!portFits(pf.type, pt.type)) say(`Connected, but the port types differ (${pf.type} to ${pt.type}). Note the adapter, or add a converter block.`, 'info');
  };

  const svgPoint = (svg, e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };

  const bind = () => {
    bindFoot();
    $('#scEdit', card)?.addEventListener('click', () => { editing = true; sel = null; undo = []; render(); });
    $('#scExport', card)?.addEventListener('click', () => { const { updatedAt, updatedBy, ...clean } = draft; download(`${site}-${room}-schematic.json`, JSON.stringify({ site, room, ...clean }, null, 2), 'application/json'); });
    $('#scCsv', card)?.addEventListener('click', () => {
      const rows = [['Tag', 'From', 'From port', 'Cable', 'Length (m)', 'To', 'To port', 'Condition', 'Note'], ...draft.links.map((l) => [l.label, nodeName(draft, l.from), l.fromPort, l.cable, l.length, nodeName(draft, l.to), l.toPort, COND_LABEL[l.condition] || 'Not tested', l.note])];
      download(`${site}-${room}-cable-schedule.csv`, rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
    });
    card.querySelectorAll('[data-sellink]').forEach((el) => el.addEventListener('click', () => { sel = { type: 'link', i: Number(el.dataset.sellink) }; render(); }));
    card.querySelectorAll('[data-selnode]').forEach((el) => el.addEventListener('click', () => { sel = { type: 'node', id: el.dataset.selnode }; render(); }));
    card.querySelectorAll('[data-opendev]').forEach((el) => el.addEventListener('click', () => openDevice(el.dataset.opendev)));
    $('#scClear', card)?.addEventListener('click', () => { sel = null; render(); });
    const svg = $('#scSvg', card);
    if (svg && !editing) {
      svg.addEventListener('click', (e) => {
        const ln = e.target.closest('[data-link]'); const nd = e.target.closest('.sn');
        sel = ln ? { type: 'link', i: Number(ln.dataset.link) } : nd ? { type: 'node', id: nd.dataset.node } : null;
        render();
      });
    }
    if (!editing) return;
    // --- designer interactions
    card.querySelectorAll('.palette details').forEach((d) => d.addEventListener('toggle', () => { if (d.open) openGroups.add(d.dataset.g); else openGroups.delete(d.dataset.g); }));
    card.querySelectorAll('.pal-item[data-block]').forEach((b) => b.addEventListener('click', () => addNode(fromBlock(lib.blocks.find((x) => x.id === b.dataset.block)))));
    card.querySelectorAll('.pal-item[data-dev]').forEach((b) => b.addEventListener('click', () => {
      const d = devById.get(b.dataset.dev);
      const blk = lib.blocks.find((x) => x.id === (DEVTYPE_BLOCK[d.deviceType] || 'generic'));
      addNode(fromBlock(blk, { label: d.model, model: d.model, deviceId: d.id }));
    }));
    $('#scTpl', card).addEventListener('change', (e) => {
      const t = templates.find((x) => x.id === e.target.value); if (!t) return;
      snap();
      draft = autoLayout({ ...structuredClone(t.schematic), notes: draft.notes });
      draft.links.forEach((l, i) => { l.label ||= `C-${String(i + 1).padStart(2, '0')}`; });
      for (const n of draft.nodes) { const d = devices.find((x) => n.model && x.model === n.model && !draft.nodes.some((m) => m.deviceId === x.id)); if (d) n.deviceId = d.id; }
      sel = null; render(); say(`Applied "${t.name}". Rename ports and add cable tags to match the room as built.`, 'info');
    });
    $('#scFile', card).addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (!Array.isArray(j.nodes)) throw new Error('The file has no "nodes" list');
        const prepared = await api('/api/schematics/prepare', { method: 'POST', body: { nodes: j.nodes, links: j.links || [], notes: j.notes } });
        snap(); draft = autoLayout(prepared); sel = null; render(); say('File loaded. Check it, then save.', 'info');
      } catch (err) { say(`Could not read that file: ${err.message}`); }
    });
    $('#scUndo', card).addEventListener('click', () => { if (!undo.length) return; draft = JSON.parse(undo.pop()); sel = null; render(); });
    $('#scArrange', card).addEventListener('click', () => { snap(); autoLayout(draft, true); render(); });
    $('#scZoomIn', card).addEventListener('click', () => { zoom = Math.min(1.6, Math.round((zoom + 0.1) * 10) / 10); render(); });
    $('#scZoomOut', card).addEventListener('click', () => { zoom = Math.max(0.5, Math.round((zoom - 0.1) * 10) / 10); render(); });
    $('#scNotes', card)?.addEventListener('change', (e) => { snap(); draft.notes = e.target.value.trim() || undefined; });
    // Inspector: item fields
    card.querySelectorAll('[data-nf]').forEach((el) => el.addEventListener('change', () => {
      const n = draft.nodes.find((x) => x.id === sel.id); snap();
      n[el.dataset.nf] = el.value.trim() || undefined;
      if (el.dataset.nf === 'label' && !n.label) n.label = 'Item';
      if (el.dataset.nf === 'deviceId' && el.value) { const d = devById.get(el.value); if (d && !n.model) n.model = d.model; }
      render();
    }));
    card.querySelectorAll('[data-pf]').forEach((el) => el.addEventListener('change', () => {
      const n = draft.nodes.find((x) => x.id === sel.id); const p = n.ports[Number(el.dataset.pi)];
      if (el.dataset.pf === 'name') {
        const name = el.value.trim();
        if (!name || n.ports.some((x) => x !== p && x.name.toLowerCase() === name.toLowerCase())) { say('Each port needs a different name.'); el.value = p.name; return; }
        snap();
        for (const l of draft.links) { if (l.from === n.id && l.fromPort === p.name) l.fromPort = name; if (l.to === n.id && l.toPort === p.name) l.toPort = name; }
        p.name = name;
      } else { snap(); p[el.dataset.pf] = el.value; }
      render();
    }));
    card.querySelectorAll('[data-delport]').forEach((b) => b.addEventListener('click', () => {
      const n = draft.nodes.find((x) => x.id === sel.id); const [p] = n.ports.splice(Number(b.dataset.delport), 1); snap();
      draft.links = draft.links.filter((l) => !((l.from === n.id && l.fromPort === p.name) || (l.to === n.id && l.toPort === p.name)));
      render();
    }));
    $('#scAddPort', card)?.addEventListener('click', () => {
      const n = draft.nodes.find((x) => x.id === sel.id); snap();
      let i = n.ports.length + 1; while (n.ports.some((p) => p.name === `Port ${i}`)) i++;
      n.ports.push({ name: `Port ${i}`, type: 'HDMI', dir: 'in' }); render();
    });
    $('#scDup', card)?.addEventListener('click', () => {
      const n = draft.nodes.find((x) => x.id === sel.id);
      const { id, deviceId, x, y, ...rest } = structuredClone(n);
      addNode({ ...rest, label: `${n.label} (copy)` });
    });
    // Inspector: cable fields
    card.querySelectorAll('[data-lf]').forEach((el) => el.addEventListener('change', () => {
      const l = draft.links[sel.i]; const f = el.dataset.lf; const v = el.value.trim();
      if (['fromPort', 'toPort'].includes(f)) {
        const end = f === 'fromPort' ? l.from : l.to;
        if (usedPort(end, v, sel.i) >= 0) { say('That port already has a cable.'); render(); return; }
      }
      snap();
      if (f === 'from' || f === 'to') {
        if (v === (f === 'from' ? l.to : l.from)) { undo.pop(); say('A cable needs two different items.'); render(); return; }
        l[f] = v;
        const n = draft.nodes.find((x) => x.id === v);
        const free = n.ports.find((p) => portFits(p.type, l.cable) && usedPort(v, p.name, sel.i) < 0) || n.ports.find((p) => usedPort(v, p.name, sel.i) < 0);
        l[`${f}Port`] = free?.name;
      } else if (f === 'length') l.length = v === '' ? undefined : Number(v);
      else l[f] = v || undefined;
      render();
    }));
    $('#scSwap', card)?.addEventListener('click', () => { const l = draft.links[sel.i]; snap(); [l.from, l.to, l.fromPort, l.toPort] = [l.to, l.from, l.toPort, l.fromPort]; render(); });
    $('#scDelSel', card)?.addEventListener('click', removeSelected);
    // Canvas: drag blocks, draw cables between ports, select.
    let drag = null;
    svg?.addEventListener('pointerdown', (e) => {
      const pt = svgPoint(svg, e);
      const port = e.target.closest('.sp');
      if (port) {
        drag = { kind: 'wire', from: { node: port.dataset.node, port: port.dataset.port }, start: portAnchor(draft.nodes.find((n) => n.id === port.dataset.node), port.dataset.port) };
        svg.setPointerCapture(e.pointerId); e.preventDefault(); return;
      }
      const nd = e.target.closest('.sn');
      if (nd) {
        const n = draft.nodes.find((x) => x.id === nd.dataset.node);
        drag = { kind: 'move', n, dx: pt.x - n.x, dy: pt.y - n.y, moved: false, before: JSON.stringify(draft) };
        sel = { type: 'node', id: n.id };
        svg.setPointerCapture(e.pointerId); e.preventDefault();
        return;
      }
      const ln = e.target.closest('[data-link]');
      sel = ln ? { type: 'link', i: Number(ln.dataset.link) } : null;
      render();
    });
    svg?.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const pt = svgPoint(svg, e);
      if (drag.kind === 'move') {
        const x = Math.max(0, Math.round((pt.x - drag.dx) / 10) * 10); const y = Math.max(0, Math.round((pt.y - drag.dy) / 10) * 10);
        if (x === drag.n.x && y === drag.n.y) return;
        drag.n.x = x; drag.n.y = y; drag.moved = true;
        svg.innerHTML = schematicBody(draft, devices, { sel });
      } else {
        const s = drag.start; const c = Math.max(46, Math.abs(pt.x - s.x) / 2);
        $('#tmpWire', svg)?.setAttribute('d', `M${s.x},${s.y} C${s.x + s.dir * c},${s.y} ${pt.x - s.dir * c},${pt.y} ${pt.x},${pt.y}`);
      }
    });
    svg?.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.kind === 'move') {
        if (d.moved) { undo.push(d.before); S.schematicDirty = true; }
        render();
        return;
      }
      $('#tmpWire', svg)?.setAttribute('d', '');
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.sp');
      const t = el ? { node: el.dataset.node, port: el.dataset.port } : null;
      const same = t && t.node === d.from.node && t.port === d.from.port;
      if (t && !same) { pending = null; connect(d.from, t); return; }
      if (!same) return;
      // A click (no drag) on a port: click-to-connect, for touch screens and trackpads.
      if (pending && !(pending.node === t.node && pending.port === t.port)) { const p = pending; pending = null; connect(p, t); return; }
      pending = pending ? null : t; render();
      if (pending) say('Now click the port at the other end of the cable. Esc cancels.', 'info');
    });
  };
  const removeSelected = () => {
    if (!sel) return;
    snap();
    if (sel.type === 'node') { draft.nodes = draft.nodes.filter((n) => n.id !== sel.id); draft.links = draft.links.filter((l) => l.from !== sel.id && l.to !== sel.id); } else draft.links.splice(sel.i, 1);
    sel = null; render();
  };
  const onKey = (e) => {
    if (!card.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (!editing || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); removeSelected(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && undo.length) { e.preventDefault(); draft = JSON.parse(undo.pop()); sel = null; render(); }
    if (e.key === 'Escape' && pending) { pending = null; render(); }
  };
  document.addEventListener('keydown', onKey);
  // Save / cancel / delete live in the footer, bound on every render.
  const bindFoot = () => {
    $('#scCancel', card)?.addEventListener('click', () => { draft = autoLayout(saved ? structuredClone(saved) : blank()); editing = false; sel = null; pending = null; S.schematicDirty = false; render(); });
    $('#scDelete', card)?.addEventListener('click', async (e) => {
      if (!e.target.dataset.confirm) { e.target.dataset.confirm = 1; e.target.textContent = 'Click again to delete'; return; }
      await api('/api/rooms/schematic', { method: 'PUT', body: { customerId, site, room, schematic: null } });
      S.schematicDirty = false; toast(ICONS.resolved, 'Schematic deleted'); mountSchematic(card, ctx);
    });
    $('#scSave', card)?.addEventListener('click', async () => {
      try {
        const { updatedAt, updatedBy, ...body } = draft;
        await api('/api/rooms/schematic', { method: 'PUT', body: { customerId, site, room, schematic: body } });
        S.schematicDirty = false; toast(ICONS.resolved, 'Schematic saved'); mountSchematic(card, ctx);
      } catch (err) { say(err.message); card.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    });
  };
  render();
}

// ------------------------------------------------------------------ room design documents (uploads)
function fmtBytes(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
async function mountDesigns(card, ctx) {
  const { customerId, site, room } = ctx;
  const q = `customerId=${encodeURIComponent(customerId)}&site=${encodeURIComponent(site)}&room=${encodeURIComponent(room)}`;
  const [files, lib] = await Promise.all([api(`/api/rooms/designs?${q}`), S.blockLib || api('/api/schematic-blocks')]);
  S.blockLib = lib;
  const icon = (f) => `<div class="doc-ic ${f.ext}">${esc(f.ext.toUpperCase())}</div>`;
  card.innerHTML = `<div class="card-head"><div><h2>Design documents</h2><div class="card-sub">As-built drawings, line diagrams and installer schematics for this room</div></div></div>
    ${can('rooms.design') ? `<div class="upload-row"><input type="file" id="dsFile" accept="${esc(lib.designAccept)}"><input id="dsTitle" placeholder="Title (optional), e.g. As-built AV schematic rev B" maxlength="120"><button class="btn btn-primary btn-sm" id="dsUp">Upload</button></div>
      <div class="help" style="margin:-4px 0 12px">PDF, PNG, JPEG, Visio (.vsdx) or AutoCAD (.dwg), up to 10 MB. Images and PDFs open in the browser; Visio and AutoCAD files download.</div><div id="dsMsg"></div>` : ''}
    ${files.length ? `<div class="doc-grid">${files.map((f) => `<div class="doc">
      <a class="doc-thumb" href="${f.url}" target="_blank" rel="noopener">${f.preview === 'image' ? `<img src="${f.url}" alt="${esc(f.title || f.name)}" loading="lazy">` : icon(f)}</a>
      <div class="doc-meta"><b>${esc(f.title || f.name)}</b><small>${esc(f.label)} · ${fmtBytes(f.size)} · ${esc(f.uploadedBy || '')} · ${ago(f.uploadedAt)}</small>
        <div class="doc-acts"><a class="linkbtn" href="${f.url}" target="_blank" rel="noopener">${f.preview === 'download' ? 'Download' : 'Open'}</a>${f.preview !== 'download' ? `<a class="linkbtn" href="${f.url}?download">Download</a>` : ''}${can('rooms.design') ? `<button class="linkbtn danger" data-deldoc="${f.id}">Remove</button>` : ''}</div></div></div>`).join('')}</div>`
    : '<div class="empty">No documents uploaded for this room.</div>'}`;
  $('#dsUp', card)?.addEventListener('click', async () => {
    const f = $('#dsFile', card).files[0]; const msg = $('#dsMsg', card);
    if (!f) { msg.innerHTML = '<div class="notice err">Choose a file first.</div>'; return; }
    if (f.size > 10 * 1024 * 1024) { msg.innerHTML = '<div class="notice err">Files can be up to 10 MB.</div>'; return; }
    const btn = $('#dsUp', card); btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      const res = await fetch(`/api/rooms/designs?${q}&name=${encodeURIComponent(f.name)}&title=${encodeURIComponent($('#dsTitle', card).value.trim())}`, { method: 'POST', body: f, credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'x-requested-with': 'estate-monitor' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast(ICONS.resolved, `Uploaded ${f.name}`); mountDesigns(card, ctx);
    } catch (e) { msg.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; btn.disabled = false; btn.textContent = 'Upload'; }
  });
  card.querySelectorAll('[data-deldoc]').forEach((b) => b.addEventListener('click', async () => {
    if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = 'Click again to remove'; return; }
    await api(`/api/designs/${b.dataset.deldoc}`, { method: 'DELETE' });
    toast(ICONS.resolved, 'Document removed'); mountDesigns(card, ctx);
  }));
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
  hero('Customers', `${list.length} customer${list.length === 1 ? "" : "s"}${isSuper() ? ' across every MSP' : S.me.mspName ? ` of ${esc(S.me.mspName)}` : ''}. Onboard a new customer, add its users, or enter a customer to see exactly what they see.`);
  $('#view').innerHTML = `
    <div class="cta"><div><h3>Onboard a new customer</h3><p>Add the customer, its sites (for the map), user logins, OEM connections and room schematics in one go.</p></div>
      <div><button class="btn btn-grad" id="onboard">Onboard customer</button></div></div>
    <div class="conn-grid">${list.map((c) => `
      <div class="conn-card">
        <div class="conn-top"><div class="oem-logo" style="background:var(--grad)">${esc(c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join(''))}</div>
          <div><div class="sync-name">${esc(c.name)}</div><div class="sync-meta">${isSuper() && c.mspName ? `${esc(c.mspName)} · ` : ''}${c.sites.length} sites · ${c.users.length} users · ${c.connections.length} connections</div>
            <div style="margin-top:4px">${c.mockData === false ? '<span class="pill live" style="padding:1px 7px">Live and uploaded data only</span>' : '<span class="pill mock" style="padding:1px 7px">Mock data on</span>'}</div></div>
          ${status(c.health.total ? ['critical', 'offline', 'warning', 'healthy'].find((h) => c.health[h]) : 'none')}</div>
        <div class="brk-bar" style="height:8px">${HEALTH_BARS.filter((h) => c.health[h]).map((h) => `<span class="f-${h}" style="flex:${c.health[h]}"></span>`).join('')}</div>
        <div class="conn-stats"><div><span class="muted">Devices</span><b>${c.deviceCount}</b></div><div><span class="muted">Sites</span><b>${c.sites.length}</b></div><div><span class="muted">Platforms</span><b style="font-size:12px">${esc((c.platforms || []).join(', ') || '—')}</b></div></div>
        <div class="conn-actions"><button class="btn btn-primary btn-sm" data-enter="${esc(c.id)}">Enter customer</button><button class="btn btn-outline btn-sm" data-edit="${esc(c.id)}">Sites &amp; users</button></div>
      </div>`).join('')}</div>`;
  $('#onboard').addEventListener('click', () => openOnboarding());
  S.roleLabels = (await api('/api/users').catch(() => null))?.labels || S.roleLabels;
  document.querySelectorAll('[data-enter]').forEach((b) => b.addEventListener('click', () => enterCustomer(b.dataset.enter)));
  if (isSuper()) S.msps = await api('/api/admin/msps').catch(() => []);
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

/** The per-customer "Mock data" switch, shared by onboarding and the edit drawer. */
function mockSwitch(id, on) {
  return `<div class="mock-switch">
    <label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} role="switch"><span class="slider"></span></label>
    <div><b>Mock data</b> <span class="muted" data-mock-state>${on ? 'On' : 'Off'}</span>
      <div class="help" data-mock-help></div></div></div>`;
}
function bindMockSwitch(root, id, onChange) {
  const box = $(`#${id}`, root);
  const wrap = box.closest('.mock-switch');
  const paint = () => {
    wrap.querySelector('[data-mock-state]').textContent = box.checked ? 'On' : 'Off';
    wrap.querySelector('[data-mock-help]').textContent = box.checked
      ? 'Sample devices are generated for this customer\'s sites while its connections are in mock mode.'
      : 'No sample devices. This customer only shows devices from live API connections and from manual or CSV uploads.';
    onChange?.();
  };
  box.addEventListener('change', paint);
  paint();
}

const CUSTOMER_ROLES = ['customer_admin', 'technical_user', 'end_user'];
function customerRoleOptions(sel) {
  const labels = S.roleLabels || { customer_admin: 'Customer admin', technical_user: 'Technical user', end_user: 'End user' };
  return CUSTOMER_ROLES.filter((r) => (S.me?.rank ?? 9) < CUSTOMER_ROLES.indexOf(r) + 2).map((r) => `<option value="${r}" ${r === sel ? 'selected' : ''}>${esc(labels[r] || r)}</option>`).join('');
}

async function openOnboarding() {
  if (isSuper()) S.msps = await api('/api/admin/msps').catch(() => []);
  const state = { sites: [{}], users: [{}], rooms: [] };
  const w = drawer('Onboard customer', 'Everything here can be changed later', `
    <div id="obMsg"></div>
    <div class="step"><span>1</span>Customer</div>
    <div class="field"><label>Customer name *</label><input id="obName" placeholder="e.g. Contoso Group"></div>
    ${isSuper() && S.msps?.length ? `<div class="field"><label>MSP</label><select id="obMsp">${S.msps.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select><div class="help">The MSP whose admins look after this customer.</div></div>` : ''}
    <div class="field"><label>Meeting platforms used</label><div class="chk-row">${PLATFORM_LIST.filter((p) => p !== 'Unassigned').map((p) => `<label><input type="checkbox" class="obPlat" value="${p}" checked> ${p}</label>`).join('')}</div></div>
    ${mockSwitch('obMock', true)}
    <div class="step"><span>2</span>Sites</div>
    <div class="help" style="margin-bottom:8px">Pick a city preset to fill in the map coordinates, or type them. Sites with coordinates appear on the map.</div>
    <div id="obSites"></div><button class="btn btn-outline btn-sm" id="obAddSite">Add site</button>
    <div class="step"><span>3</span>Customer logins</div>
    <div class="help" style="margin-bottom:8px">These users only ever see this customer's devices. A customer admin can add the rest of their team later.</div>
    <div id="obUsers"></div><button class="btn btn-outline btn-sm" id="obAddUser">Add user</button>
    <div class="step"><span>4</span>Connections</div>
    <div class="help" style="margin-bottom:6px">Manufacturer clouds</div>
    <div class="chk-row">${S.connectors.filter((c) => c.kind !== 'platform').map((c) => `<label><input type="checkbox" class="obConn" value="${c.oem}" ${['poly-lens', 'logitech-sync'].includes(c.oem) ? 'checked' : ''}> ${esc(c.displayName)}${c.liveSupported === false ? ' <span class="muted">(demo only)</span>' : ''}</label>`).join('')}</div>
    <div class="help" style="margin:10px 0 6px">Meeting-platform portals</div>
    <div class="chk-row">${S.connectors.filter((c) => c.kind === 'platform').map((c) => `<label><input type="checkbox" class="obConn" value="${c.oem}" checked> ${esc(c.displayName)}${c.liveSupported === false ? ' <span class="muted">(mock only)</span>' : ''}</label>`).join('')}</div>
    <div class="help" id="obConnHelp">Connections start on mock data. Add the API keys afterwards on the Connections page to go live.</div>
    <div class="step"><span>5</span>Rooms and schematics (optional)</div>
    <div class="help" style="margin-bottom:8px">Pre-load rooms with their platform and cabling, from a template or a JSON file. Devices can be grouped into these rooms later.</div>
    <div id="obRooms"></div><button class="btn btn-outline btn-sm" id="obAddRoom">Add room</button>`,
  '<button class="btn btn-primary" id="obGo">Create customer</button>');
  w.querySelector('.drawer').classList.add('wide');
  const syncMockUi = () => {
    const on = $('#obMock', w).checked;
    w.classList.toggle('mock-off', !on);
    $('#obConnHelp', w).textContent = on
      ? 'Connections start on mock data. Add the API keys afterwards on the Connections page to go live.'
      : 'Mock data is off, so these connections show no devices until you add their API keys on the Connections page. You can also add devices by hand or by CSV upload.';
  };
  bindMockSwitch(w, 'obMock', syncMockUi);
  const renderSites = () => {
    const cur = $('#obSites', w).children.length ? readSitesAll() : state.sites;
    $('#obSites', w).innerHTML = cur.map((s, i) => siteRow(s, i)).join('');
    bindSiteRows($('#obSites', w), renderRoomsSiteOptions);
  };
  const readSitesAll = () => [...$('#obSites', w).querySelectorAll('[data-site-row]')].map((r) => Object.fromEntries([...r.querySelectorAll('[data-k]')].filter((i) => i.dataset.k !== 'preset').map((i) => [i.dataset.k, i.value.trim()])));
  const userRow = (u = {}) => `<div class="user-row"><input data-u="email" type="email" placeholder="Email *" value="${esc(u.email || '')}"><input data-u="name" placeholder="Name" value="${esc(u.name || '')}"><select data-u="role" aria-label="Role">${customerRoleOptions('customer_admin')}</select><input data-u="password" type="password" placeholder="Password (8+ characters) *" autocomplete="new-password"><button class="linkbtn" data-remove-row>Remove</button></div>`;
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
        mockData: $('#obMock', w).checked,
        ...($('#obMsp', w) ? { mspId: $('#obMsp', w).value } : {}),
      };
      if (!body.name) return msg('Enter the customer name.');
      if (!body.sites.length) return msg('Add at least one site.');
      e.target.disabled = true; e.target.textContent = 'Creating…';
      const c = await api('/api/admin/customers', { method: 'POST', body });
      closeDrawer();
      toast(ICONS.resolved, c.mockData === false ? `${c.name} onboarded with no devices. Add API keys or upload devices to fill it.` : `${c.name} onboarded with ${c.deviceCount} mock devices`);
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
    ${isSuper() && S.msps?.length ? `<div class="field"><label>MSP</label><select id="ceMsp">${S.msps.map((m) => `<option value="${esc(m.id)}" ${m.id === c.mspId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select><div class="help">Moving a customer hands it to that MSP's admins.</div></div>` : ''}
    ${mockSwitch('ceMock', c.mockData !== false)}
    <div class="help"><a href="#/roles/customer/${encodeURIComponent(c.id)}">Role permissions for this customer</a></div>
    <div class="section-title">Sites</div>
    <div id="ceSites">${c.sites.map((s, i) => siteRow(s, i)).join('')}</div>
    <button class="btn btn-outline btn-sm" id="ceAddSite">Add site</button>
    <div class="section-title">Users</div>
    ${c.users.map((u) => `<div class="side-row" style="cursor:default"><span class="grow">${esc(u.name)}<small>${esc(u.email)} · ${esc((S.roleLabels || {})[u.role] || u.role)}${u.disabled ? ' · disabled' : ''}</small></span>${can('users.manage') ? `<button class="linkbtn" data-deluser="${esc(u.id)}">Remove</button>` : ''}</div>`).join('') || '<div class="muted">No users yet</div>'}
    ${can('users.manage') ? `<div class="user-row" style="margin-top:10px"><input id="nuEmail" type="email" placeholder="Email"><input id="nuName" placeholder="Name"><select id="nuRole" aria-label="Role">${customerRoleOptions('customer_admin')}</select><input id="nuPw" type="password" placeholder="Password (8+ characters)" autocomplete="new-password"><button class="btn btn-outline btn-sm" id="nuAdd">Add user</button></div>
    <div class="help"><a href="#/users">Users</a> lists everyone, with role changes, password resets and disabling.</div>` : ''}
    <div class="section-title">Connections</div>
    ${c.connections.map((x) => `<div class="side-row" style="cursor:default"><span class="grow">${esc(x.name)}<small>${x.mode === 'live' ? 'Live' : x.status.mockOff ? 'Awaiting API keys' : 'Mock data'} · ${x.status.deviceCount} devices</small></span>${syncState(x.status)}</div>`).join('')}
    <div class="help">Manage API keys on the Connections page.</div>`,
  `<button class="btn btn-danger" id="ceDel" style="margin-right:auto">Delete customer</button><button class="btn btn-primary" id="ceSave">Save</button>`);
  w.querySelector('.drawer').classList.add('wide');
  const msg = (t, ok) => { $('#ceMsg', w).innerHTML = `<div class="notice ${ok ? 'ok' : 'err'}">${esc(t)}</div>`; w.querySelector('.drawer-body').scrollTop = 0; };
  bindSiteRows($('#ceSites', w));
  const syncCeMock = () => w.classList.toggle('mock-off', !$('#ceMock', w).checked);
  bindMockSwitch(w, 'ceMock', syncCeMock);
  $('#ceAddSite', w).addEventListener('click', () => { $('#ceSites', w).insertAdjacentHTML('beforeend', siteRow({}, Date.now())); bindSiteRows($('#ceSites', w)); });
  $('#ceSave', w).addEventListener('click', async (e) => {
    const mockData = $('#ceMock', w).checked;
    const turningOff = c.mockData !== false && !mockData;
    if (turningOff && !e.currentTarget.dataset.confirm) {
      e.currentTarget.dataset.confirm = 1; e.currentTarget.textContent = 'Click again to remove all mock devices';
      return msg(`Turning mock data off removes every mock device, mock room and mock alert for ${c.name}. Devices from live API connections and manual or CSV uploads stay.`);
    }
    try {
      const fresh = await api(`/api/admin/customers/${c.id}`, { method: 'PUT', body: { name: $('#ceName', w).value, slaTarget: Number($('#ceSla', w).value), sites: readSites($('#ceSites', w)), mockData, ...($('#ceMsp', w) ? { mspId: $('#ceMsp', w).value } : {}) } });
      closeDrawer();
      toast(ICONS.resolved, turningOff ? `Mock data off. ${fresh.name} now has ${fresh.deviceCount} devices.` : 'Customer saved');
      S.customers = await api('/api/customers'); S.options = await api('/api/filters'); viewCustomers();
    } catch (err) { msg(err.message); }
  });
  $('#nuAdd', w)?.addEventListener('click', async () => {
    try { const u = await api(`/api/admin/customers/${c.id}/users`, { method: 'POST', body: { email: $('#nuEmail', w).value, name: $('#nuName', w).value, role: $('#nuRole', w).value, password: $('#nuPw', w).value } }); openCustomerEdit(u); toast(ICONS.resolved, 'User added'); } catch (e) { msg(e.message); }
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
const W_LABEL = { active: 'In warranty', expiring: 'Expiring soon', expired: 'Expired', unknown: 'Not recorded' };
const W_TONE = { active: 'good', expiring: 'warn', expired: 'crit', unknown: 'mute' };
const LC_LABEL = { supported: 'Supported', soon: 'Milestone within 12 months', eosale: 'End of sale', eos: 'End of support', eol: 'End of life', nodates: 'No lifecycle dates', notannounced: 'EOL not announced', discontinued: 'Discontinued, no dates', unknown: 'Not in model master' };
const LC_TONE = { supported: 'good', soon: 'warn', eosale: 'warn', eos: 'crit', eol: 'crit', nodates: 'mute', notannounced: 'mute', discontinued: 'warn', unknown: 'mute' };
// A lifecycle date, or "Not announced" when the manufacturer has published none.
const lcDate = (v, status) => (v ? fmtDate(v) : status === 'not-announced' || status === 'discontinued' ? '<span class="muted">Not announced</span>' : '—');
const LC_STATUS = { announced: 'Dates announced', discontinued: 'Discontinued, no dates published', 'not-announced': 'Not announced' };
function lcSources(refs, url) {
  const list = (refs && refs.length ? refs : url ? [{ label: 'Manufacturer notice', url }] : []);
  return list.map((r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.label)}</a>`).join('<br>');
}
const chip = (text, tone) => `<span class="chip ${tone || 'mute'}">${esc(text)}</span>`;
const fmtDate = (v) => {
  if (!v) return '—';
  const d = new Date(String(v).length === 10 ? `${v}T00:00:00Z` : v);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', ...(String(v).length === 10 ? { timeZone: 'UTC' } : {}) });
};
const fmtDateTime = (v) => new Date(v).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function shortModel(make, model) {
  const m = String(model ?? '');
  const k = String(make ?? '');
  return k && m.toLowerCase().startsWith(`${k.toLowerCase()} `) ? m.slice(k.length + 1) : m;
}
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
      <dt>Customer baseline</dt><dd><span class="mono">${esc(d.baseline || '—')}</span> <span class="muted" style="font-size:12px">${esc({ advisory: 'follows advisory', latest: 'highest level', customer: 'set by customer', 'not enforced': 'not enforced' }[d.baselineSource] || '')} · <a href="#/baselines/${esc(d.customerId)}">v${d.baselineVersion ?? 0}</a></span></dd>
      <dt>Advisory baseline</dt><dd><span class="mono">${esc(d.advisoryBaseline || '—')}</span> ${d.baselineDrift && d.baselineDrift !== 'same' ? chip(DRIFT_LABEL[d.baselineDrift] || d.baselineDrift, DRIFT_TONE[d.baselineDrift]) : ''}${d.advisoryStatus === 'behind' && d.firmwareStatus !== 'behind' ? ` ${chip('Below advisory', 'warn')}` : ''}</dd>
      <dt>Warranty</dt><dd>${chip(W_LABEL[d.warrantyStatus] || 'Not recorded', W_TONE[d.warrantyStatus])} ${d.warrantyExpires ? `until ${fmtDate(d.warrantyExpires)}` : ''}
        ${d.warrantyType || d.warrantySource ? `<div class="muted" style="font-size:12px">${esc([d.warrantyType, d.warrantySource && `from ${d.warrantySource}`].filter(Boolean).join(' · '))}</div>` : ''}</dd>
      ${d.contractRef ? `<dt>Contract</dt><dd class="mono">${esc(d.contractRef)}</dd>` : ''}
      ${d.purchaseDate ? `<dt>Purchased</dt><dd>${fmtDate(d.purchaseDate)}</dd>` : ''}
      <dt>Lifecycle</dt><dd>${chip(lc.label || 'Unknown', LC_TONE[lc.stage])}</dd>
      <dt>End of sale</dt><dd>${lcDate(lc.endOfSale, lc.status)}</dd>
      <dt>End of support</dt><dd>${lcDate(lc.endOfSupport, lc.status)}</dd>
      <dt>End of life</dt><dd>${lcDate(lc.endOfLife, lc.status)}</dd>
      ${lc.note ? `<dt>Lifecycle note</dt><dd style="font-size:13px">${esc(lc.note)}</dd>` : ''}
      ${lc.refs?.length || lc.url ? `<dt>Source</dt><dd style="font-size:13px">${lcSources(lc.refs, lc.url)}${lc.checkedAt ? `<div class="muted" style="font-size:12px">Checked ${fmtDate(lc.checkedAt)}</div>` : ''}</dd>` : ''}
    </dl>`;
}

// ------------------------------------------------------------------ lifecycle view
async function viewLifecycle() {
  const lc = await api(`/api/lifecycle${qs()}`);
  hero('Lifecycle', `Firmware, warranty and lifecycle against each customer's baseline, with drift from our advisory baseline. ${lc.total} devices.`);
  const n = (o, k) => o[k] || 0;
  const f = lc.firmware; const w = lc.warranty; const l = lc.lifecycle;
  const rated = n(f, 'compliant') + n(f, 'ahead') + n(f, 'behind');
  const compliance = rated ? `${(((n(f, 'compliant') + n(f, 'ahead')) / rated) * 100).toFixed(1)}%` : '—';
  const pastSupport = n(l, 'eos') + n(l, 'eol');
  $('#view').innerHTML = `
    <div class="stats">
      ${statTile('Firmware compliance', compliance, `${n(f, 'behind')} below customer baseline · ${n(lc.advisoryFirmware, 'behind')} below advisory`, n(f, 'behind') ? 'warn' : 'good')}
      ${statTile('Warranty expired', n(w, 'expired'), `${n(w, 'expiring')} more expire within the notice period`, n(w, 'expired') ? 'crit' : 'good')}
      ${statTile('Past end of support', pastSupport, `${n(l, 'eol')} end of life · ${n(l, 'eosale')} end of sale`, pastSupport ? 'crit' : 'good')}
      ${statTile('Missing lifecycle dates', n(l, 'nodates') + n(l, 'unknown'), isSuper() ? '<a href="#/models">Add them in the model master</a>' : 'Maintained in the model master', '')}
    </div>
    <div class="card" style="margin-bottom:18px"><div class="card-head"><div><h2>Baselines in force</h2><div class="card-sub">Each customer's own baseline (versioned). Advisory v${lc.advisory.version}: ${esc(policyText(lc.advisory.policy))}</div></div><a class="pill blue" href="#/baselines">Baselines</a></div>
      <div class="table-wrap flat"><table><thead><tr><th>Customer</th><th>Version</th><th>Firmware level</th><th>Warranty and lifecycle rules</th><th>Meets baseline</th><th>Meets own, below advisory</th></tr></thead><tbody>
      ${lc.baselines.map((x) => `<tr><td><a href="#/baselines/${esc(x.customerId)}"><b>${esc(x.customerName)}</b></a></td><td>v${x.version}${x.updatedAt ? `<div class="muted" style="font-size:12px">${fmtDate(x.updatedAt)}</div>` : ''}</td>
        <td>${esc(LEVEL_SHORT[x.level] || x.level)}${x.exceptions ? ` · ${x.exceptions} exception${x.exceptions === 1 ? '' : 's'}` : ''}</td><td style="font-size:12.5px">${x.policySource === 'customer' ? 'Own: ' : 'Advisory: '}${esc(policyText(x.policy))}</td>
        <td>${x.devices ? `${x.compliant} of ${x.devices}` : '—'}</td><td>${x.meetsCustomerBelowAdvisory ? chip(x.meetsCustomerBelowAdvisory, 'warn') : '0'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No customers</td></tr>'}
      </tbody></table></div></div>
    <div class="grid cols-2" style="margin-bottom:18px">
      <div class="card"><div class="card-head"><div><h2>Firmware by model</h2><div class="card-sub">Versions running in the fleet against the customer's target and our advisory</div></div>${seesModels() ? '<a class="pill blue" href="#/models">Model master</a>' : ''}</div>
        <div class="table-wrap flat"><table><thead><tr><th>Model</th><th>Advisory</th><th>Customer target</th><th>Devices</th><th>Below target</th><th>Versions in fleet</th></tr></thead><tbody>
        ${lc.models.map((m) => `<tr><td><b>${esc(m.make)}</b> ${esc(shortModel(m.make, m.model))}${m.modelId ? '' : ' <span class="muted">(not in master)</span>'}</td><td class="mono">${esc(m.advisory || '—')}</td><td class="mono">${m.mixedTargets ? '<span class="muted">Varies by customer</span>' : esc(m.baseline || '—')}${!m.mixedTargets && m.baseline && m.advisory && m.baseline !== m.advisory ? ` ${chip(cmpVer(m.baseline, m.advisory) > 0 ? 'above' : 'below', cmpVer(m.baseline, m.advisory) > 0 ? 'good' : 'warn')}` : ''}</td><td>${m.total}</td><td>${m.behind ? chip(m.behind, 'crit') : '0'}</td>
          <td>${Object.entries(m.versions).sort((a, b) => cmpVer(b[0], a[0])).map(([v, c]) => `<span class="pill mono ${m.baseline && cmpVer(v, m.baseline) < 0 ? 'bad' : ''}">${esc(v)} × ${c}</span>`).join(' ') || '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No devices</td></tr>'}
        </tbody></table></div></div>
      <div class="card"><div class="card-head"><div><h2>Warranty</h2><div class="card-sub">From Logitech Sync where it reports it, otherwise entered on the device</div></div></div>
        ${barList(['active', 'expiring', 'expired', 'unknown'].map((k) => ({ label: W_LABEL[k], n: n(w, k), tone: W_TONE[k] })), lc.total)}
        <div class="section-title">Model lifecycle stage</div>
        ${barList(['supported', 'soon', 'eosale', 'eos', 'eol', 'discontinued', 'notannounced', 'nodates', 'unknown'].map((k) => ({ label: LC_LABEL[k], n: n(l, k), tone: LC_TONE[k] })).filter((x) => x.n), lc.total)}
      </div>
    </div>
    <div class="card"><div class="card-head"><div><h2>Devices needing attention</h2><div class="card-sub">${lc.attentionTotal} devices failing their customer's baseline (firmware, warranty or lifecycle limit), or close to it${lc.attentionTotal > lc.attention.length ? ` (first ${lc.attention.length} shown)` : ''}</div></div></div>
      ${lc.attention.length ? `<div class="table-wrap"><table><thead><tr><th>Device</th>${multi() && !acting() ? '<th>Customer</th>' : ''}<th>Site / room</th><th>Firmware</th><th>Warranty</th><th>Lifecycle</th></tr></thead><tbody>
        ${lc.attention.map((d) => `<tr data-id="${esc(d.id)}"><td><b>${esc(d.make)}</b> ${esc(shortModel(d.make, d.model))}<div class="muted mono" style="font-size:11.5px">${esc(d.serial || '')}</div></td>${multi() && !acting() ? `<td>${esc(d.customerName)}</td>` : ''}
          <td>${esc(d.site)}<div class="muted">${esc(d.room)}</div></td>
          <td><span class="mono">${esc(d.firmware || '—')}</span> ${d.firmwareStatus === 'behind' ? chip(`target ${d.baseline}`, 'crit') : d.advisoryStatus === 'behind' ? chip(`advisory ${d.advisoryBaseline}`, 'warn') : ''}</td>
          <td>${chip(W_LABEL[d.warrantyStatus], W_TONE[d.warrantyStatus])}${d.warrantyExpires ? `<div class="muted" style="font-size:12px">${fmtDate(d.warrantyExpires)}</div>` : ''}</td>
          <td>${chip(d.lifecycle?.label || '—', LC_TONE[d.lifecycle?.stage])}${d.lifecycle?.date ? `<div class="muted" style="font-size:12px">${fmtDate(d.lifecycle.date)}</div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Nothing needs attention</div>'}</div>`;
  document.querySelectorAll('tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openDevice(tr.dataset.id)));
}

// ------------------------------------------------------------------ baselines view
// Two tiers: the provider's advisory baseline (model master firmware + advisory policy),
// and each customer's own versioned baseline, which can follow, lower or raise it.
const DRIFT_LABEL = { above: 'Above advisory', same: 'Same as advisory', below: 'Below advisory', 'not-enforced': 'Not enforced', 'no-advisory': 'No advisory set' };
const DRIFT_TONE = { above: 'good', same: 'mute', below: 'warn', 'not-enforced': 'warn', 'no-advisory': 'mute' };
const LEVEL_SHORT = { advisory: 'Follows advisory', latest: 'Highest level' };
const LC_LIMIT = { eosale: 'end of sale', eos: 'end of support', eol: 'end of life', none: 'none' };
const policyText = (p) => (p ? `Warranty ${p.warrantyRequired ? 'required' : 'not required'} · ${p.warrantyNoticeDays}-day notice · ${p.lifecycleLimit === 'none' ? 'lifecycle not enforced' : `fails at ${LC_LIMIT[p.lifecycleLimit] || p.lifecycleLimit}`}` : '');
function ruleOptions(m, level, rule) {
  const def = level === 'latest' ? `Default: highest (${m.latest || m.advisory || '—'})` : `Default: advisory (${m.advisory || '—'})`;
  const vers = [...new Set([...(m.releases || []), ...(rule && !['advisory', 'latest', 'none'].includes(rule) ? [rule] : [])])].sort((a, b) => cmpVer(b, a));
  const o = (v, l) => `<option value="${esc(v)}" ${(rule || '') === v ? 'selected' : ''}>${esc(l)}</option>`;
  return [o('', def), level === 'latest' ? o('advisory', `Advisory (${m.advisory || '—'})`) : o('latest', `Highest (${m.latest || '—'})`), o('none', 'Not enforced'),
    `<optgroup label="Pin a version">${vers.map((v) => o(v, `${v}${v === m.advisory ? ' (advisory)' : ''}${v === m.latest ? ' (newest)' : ''}`)).join('')}</optgroup>`, o('__other', 'Other version…')].join('');
}

async function viewBaselines(args = []) {
  const custs = S.customers;
  const cid = acting() || S.me.customerId || (custs.some((c) => c.id === args[0]) ? args[0] : custs[0]?.id);
  hero('Baselines', 'The provider\'s advisory baseline, and each customer\'s own baseline for firmware, warranty and lifecycle. A customer can follow the advisory, aim for the highest level, or set individual models lower or higher. Devices are judged against their customer\'s baseline, with drift from the advisory shown alongside.');
  if (!cid) { $('#view').innerHTML = '<div class="card"><div class="empty">No customers yet</div></div>'; return; }
  const viewVersion = args[1] !== undefined && args[1] !== '' ? Number(args[1]) : null;
  const [adv, b] = await Promise.all([api('/api/baselines/advisory'), api(`/api/baselines/customers/${encodeURIComponent(cid)}${viewVersion !== null ? `?version=${viewVersion}` : ''}`)]);
  const historic = viewVersion !== null && viewVersion !== b.latestVersion;
  const canEdit = can('baselines.edit') && !historic;
  const pol = b.current.policy || adv.policy;
  const custPolicy = !!b.current.policy;
  const withDevices = b.models.filter((m) => m.devices);
  const below = withDevices.filter((m) => m.drift === 'below' || m.drift === 'not-enforced').length;
  const above = withDevices.filter((m) => m.drift === 'above').length;
  const limitOpts = (sel) => Object.entries(adv.lifecycleLimits).map(([k, l]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const custPick = !acting() && multi() && custs.length > 1 ? `<select id="blCust" class="pill" style="font-weight:600">${custs.map((c) => `<option value="${esc(c.id)}" ${c.id === cid ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : '';
  $('#view').innerHTML = `
    <div class="stats">
      ${statTile(`${esc(b.customerName)} baseline`, `v${b.current.version}`, `${esc(LEVEL_SHORT[b.current.level] || b.current.level)} · ${b.current.exceptions} model exception${b.current.exceptions === 1 ? '' : 's'}`, '')}
      ${statTile('Models above advisory', above, 'Customer asks for newer firmware than advised', above ? 'good' : '')}
      ${statTile('Models below advisory', below, 'Lower than advised, or not enforced', below ? 'warn' : 'good')}
      ${statTile('Advisory baseline', `v${adv.version}`, policyText(adv.policy, adv.lifecycleLimits), '')}
    </div>
    <div class="grid cols-2" style="margin-bottom:18px">
      <div class="card"><div class="card-head"><div><h2>Advisory baseline</h2><div class="card-sub">Recommended by us for every customer. Firmware targets are the approved baselines in the model master.</div></div>${seesModels() ? '<a class="pill blue" href="#/models">Model master</a>' : ''}</div>
        <div id="advMsg"></div>
        <div class="grid cols-2" style="gap:10px">
          <div class="field"><label class="inline-chk"><input type="checkbox" id="advW" ${adv.policy.warrantyRequired ? 'checked' : ''} ${isSuper() ? '' : 'disabled'}> Warranty cover required</label><div class="help">Expired warranty fails the baseline.</div></div>
          <div class="field"><label>Warranty notice (days)</label><input id="advDays" type="number" min="0" max="730" value="${adv.policy.warrantyNoticeDays}" ${isSuper() ? '' : 'disabled'}></div>
          <div class="field"><label>Lifecycle limit</label><select id="advLc" ${isSuper() ? '' : 'disabled'}>${limitOpts(adv.policy.lifecycleLimit)}</select><div class="help">Devices at or past this stage fail the baseline.</div></div>
          ${isSuper() ? '<div class="field"><label>Change note</label><input id="advNote" placeholder="Why it changed"></div>' : ''}
        </div>
        ${isSuper() ? '<div style="display:flex;justify-content:flex-end"><button class="btn btn-primary btn-sm" id="advSave">Save advisory as new version</button></div>' : ''}
        ${adv.versions.length ? `<div class="section-title">Advisory history</div><div class="table-wrap flat"><table><thead><tr><th>Version</th><th>Saved</th><th>Policy</th><th>Note</th></tr></thead><tbody>
          ${adv.versions.map((v) => `<tr><td><b>v${v.version}</b></td><td>${fmtDate(v.createdAt)}<div class="muted" style="font-size:12px">${esc(v.createdBy || '')}</div></td><td style="font-size:12.5px">${esc(policyText(v.policy, adv.lifecycleLimits))}</td><td>${esc(v.note || '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="help block">Version 0: the built-in default policy.</div>'}
      </div>
      <div class="card"><div class="card-head"><div><h2>${esc(b.customerName)} baseline ${historic ? `v${b.current.version} <span class="chip warn">Earlier version</span>` : `v${b.current.version}`}</h2><div class="card-sub">${b.current.createdAt ? `Saved ${fmtDate(b.current.createdAt)}${b.current.createdBy ? ` by ${esc(b.current.createdBy)}` : ''}` : 'Not customised yet: follows the advisory'}${b.current.note ? ` · ${esc(b.current.note)}` : ''}</div></div>${custPick}</div>
        <div id="blMsg"></div>
        ${historic ? `<div class="notice info">You're looking at version ${b.current.version}. The current version is v${b.latestVersion}. <a href="#/baselines/${esc(cid)}">Back to current</a></div>` : ''}
        <div class="field"><label>Firmware level</label><select id="blLevel" ${canEdit ? '' : 'disabled'}>${Object.entries(b.levels).map(([k, l]) => `<option value="${k}" ${b.current.level === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
          <div class="help">The default for every model. Set exceptions per model in the table below, lower or higher than advisory.</div></div>
        <div class="field"><label class="inline-chk"><input type="checkbox" id="blOwnPol" ${custPolicy ? 'checked' : ''} ${canEdit ? '' : 'disabled'}> Own warranty and lifecycle rules (otherwise follow the advisory policy)</label></div>
        <div class="grid cols-2" style="gap:10px" id="blPol">
          <div class="field"><label class="inline-chk"><input type="checkbox" id="blW" ${pol.warrantyRequired ? 'checked' : ''}> Warranty cover required</label></div>
          <div class="field"><label>Warranty notice (days)</label><input id="blDays" type="number" min="0" max="730" value="${pol.warrantyNoticeDays}"></div>
          <div class="field"><label>Lifecycle limit</label><select id="blLc">${limitOpts(pol.lifecycleLimit)}</select></div>
        </div>
        ${canEdit ? `<div class="field"><label>Change note</label><input id="blNote" placeholder="e.g. Exec floor on newest firmware"></div>
          <div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-primary btn-sm" id="blSave">Save as v${b.latestVersion + 1}</button></div>` : !can('baselines.edit') ? '<div class="help block">Your service provider maintains this baseline. Ask them to change it.</div>' : ''}
        <div class="section-title">Version history</div>
        <div class="table-wrap flat"><table><thead><tr><th>Version</th><th>Saved</th><th>Level</th><th>Exceptions</th><th>Rules</th><th>Note</th><th></th></tr></thead><tbody>
          ${[...b.versions, { version: 0, level: 'advisory', exceptions: 0, policy: null, note: 'Default: follows the advisory', createdAt: null }].map((v) => `<tr><td><b>v${v.version}</b>${v.version === b.latestVersion ? ` ${chip('current', 'good')}` : ''}</td><td>${v.createdAt ? `${fmtDate(v.createdAt)}<div class="muted" style="font-size:12px">${esc(v.createdBy || '')}</div>` : '—'}</td>
            <td>${esc(LEVEL_SHORT[v.level] || v.level)}</td><td>${v.exceptions}</td><td style="font-size:12.5px">${v.policy ? 'Own' : 'Advisory'}</td><td>${esc(v.note || '')}${v.restoredFrom !== null && v.restoredFrom !== undefined ? ` <span class="muted">(from v${v.restoredFrom})</span>` : ''}</td>
            <td style="white-space:nowrap">${v.version !== b.latestVersion && v.version ? `<a class="linkbtn" href="#/baselines/${esc(cid)}/${v.version}">View</a>` : ''}${can('baselines.edit') && v.version !== b.latestVersion ? ` <button class="linkbtn" data-restore="${v.version}">Restore</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>
      </div>
    </div>
    <div class="card"><div class="card-head"><div><h2>Firmware by model</h2><div class="card-sub">${esc(b.customerName)}'s target per model against the advisory. Models in use are listed first.</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>Model</th><th>Devices</th><th>Advisory</th><th>Newest known</th><th>Customer rule</th><th>Target</th><th>Drift</th><th>Below target</th><th>Below advisory</th></tr></thead><tbody>
      ${b.models.map((m) => `<tr data-m="${esc(m.id)}"${m.devices ? '' : ' class="muted"'}><td><b>${esc(m.make)}</b> ${esc(shortModel(m.make, m.model))}<div class="muted" style="font-size:12px">${esc(m.deviceType)}</div></td><td>${m.devices}</td>
        <td class="mono">${esc(m.advisory || '—')}</td><td class="mono">${esc(m.latest || '—')}</td>
        <td><select class="blRule" data-id="${esc(m.id)}" ${canEdit ? '' : 'disabled'} style="max-width:220px">${ruleOptions(m, b.current.level, m.rule)}</select><input class="blOther mono" data-id="${esc(m.id)}" placeholder="e.g. 4.2.0" hidden style="width:110px;margin-left:6px"></td>
        <td class="mono"><b>${esc(m.target || '—')}</b></td><td>${chip(DRIFT_LABEL[m.drift] || m.drift, DRIFT_TONE[m.drift])}</td>
        <td>${m.behind ? chip(m.behind, 'crit') : '0'}</td><td>${m.behindAdvisory ? chip(m.behindAdvisory, 'warn') : '0'}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No models in the master</td></tr>'}
      </tbody></table></div></div>`;

  $('#blCust')?.addEventListener('change', (e) => { location.hash = `#/baselines/${encodeURIComponent(e.target.value)}`; });
  const polBox = $('#blPol');
  const syncPol = () => { const own = $('#blOwnPol').checked; polBox.style.opacity = own ? 1 : 0.55; polBox.querySelectorAll('input,select').forEach((x) => { x.disabled = !own || !canEdit; }); };
  $('#blOwnPol').addEventListener('change', syncPol); syncPol();
  document.querySelectorAll('.blRule').forEach((sel) => sel.addEventListener('change', () => {
    const other = sel.parentElement.querySelector('.blOther');
    other.hidden = sel.value !== '__other';
    if (!other.hidden) other.focus();
  }));
  document.querySelectorAll('[data-restore]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!btn.dataset.confirm) { btn.dataset.confirm = 1; btn.textContent = `Restore v${btn.dataset.restore} as v${b.latestVersion + 1}?`; return; }
    try { await api(`/api/baselines/customers/${encodeURIComponent(cid)}/restore`, { method: 'POST', body: { version: Number(btn.dataset.restore) } }); toast(ICONS.resolved, `Restored v${btn.dataset.restore} as v${b.latestVersion + 1}`); location.hash = `#/baselines/${encodeURIComponent(cid)}`; viewBaselines([cid]); } catch (e) { $('#blMsg').innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
  }));
  $('#blSave')?.addEventListener('click', async (e) => {
    const models = {};
    document.querySelectorAll('.blRule').forEach((s) => {
      const v = s.value === '__other' ? s.parentElement.querySelector('.blOther').value.trim() : s.value;
      if (v) models[s.dataset.id] = v;
    });
    const body = {
      level: $('#blLevel').value, models, note: $('#blNote').value.trim() || null,
      policy: $('#blOwnPol').checked ? { warrantyRequired: $('#blW').checked, warrantyNoticeDays: Number($('#blDays').value), lifecycleLimit: $('#blLc').value } : null,
    };
    e.target.disabled = true;
    try { const r = await api(`/api/baselines/customers/${encodeURIComponent(cid)}`, { method: 'POST', body }); toast(ICONS.resolved, `${b.customerName} baseline saved as v${r.current.version}`); viewBaselines([cid]); } catch (err) { $('#blMsg').innerHTML = `<div class="notice err">${esc(err.message)}</div>`; e.target.disabled = false; }
  });
  $('#advSave')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const v = await api('/api/baselines/advisory', { method: 'PUT', body: { policy: { warrantyRequired: $('#advW').checked, warrantyNoticeDays: Number($('#advDays').value), lifecycleLimit: $('#advLc').value }, note: $('#advNote').value.trim() || null } });
      toast(ICONS.resolved, `Advisory baseline saved as v${v.version}`); viewBaselines(args);
    } catch (err) { $('#advMsg').innerHTML = `<div class="notice err">${esc(err.message)}</div>`; e.target.disabled = false; }
  });
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
        <div class="table-wrap flat"><table><thead><tr><th>Site</th>${multi() && !acting() ? '<th>Customer</th>' : ''}<th>Availability</th><th></th><th>Incidents</th><th>Downtime</th></tr></thead><tbody>
        ${r.bySite.map((s) => `<tr><td><b>${esc(s.site)}</b><div class="muted">${esc(s.region || '')}</div></td>${multi() && !acting() ? `<td>${esc(s.customerName)}</td>` : ''}<td>${pctText(s.availability)}</td><td>${metChip(s)}</td><td>${s.incidents}</td><td>${mins(s.downtimeMin)}</td></tr>`).join('')}</tbody></table></div></div>
    </div>
    <div class="grid cols-2" style="margin-bottom:18px">
      <div class="card"><div class="card-head"><div><h2>Rooms with the lowest availability</h2></div></div>
        <div class="table-wrap flat"><table><thead><tr><th>Room</th><th>Availability</th><th>Incidents</th><th>Downtime</th></tr></thead><tbody>
        ${r.worstRooms.map((x) => `<tr class="link" data-room="${esc(JSON.stringify([x.customerId, x.site, x.room]))}"><td><b>${esc(x.room)}</b><div class="muted">${esc(x.site)}${multi() && !acting() ? ` · ${esc(x.customerName)}` : ''}</div></td><td>${pctText(x.availability)}</td><td>${x.incidents}</td><td>${mins(x.downtimeMin)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card"><div class="card-head"><div><h2>Devices with the lowest availability</h2></div></div>
        <div class="table-wrap flat"><table><thead><tr><th>Device</th><th>Availability</th><th>Incidents</th><th>Now</th></tr></thead><tbody>
        ${r.worstDevices.map((d) => `<tr data-id="${esc(d.id)}"><td><b>${esc(d.make)}</b> ${esc(shortModel(d.make, d.model))}<div class="muted">${esc(d.room)}, ${esc(d.site)}</div></td><td>${pctText(d.availability)}</td><td>${d.incidents}</td><td>${status(d.health)}</td></tr>`).join('')}</tbody></table></div></div>
    </div>
    <div class="card"><div class="card-head"><div><h2>Recent incidents</h2><div class="card-sub">Periods when a device was offline or critical</div></div></div>
      ${r.incidents.length ? `<div class="table-wrap"><table><thead><tr><th>Started</th><th>Device</th>${multi() && !acting() ? '<th>Customer</th>' : ''}<th>Room</th><th>State</th><th>Duration</th></tr></thead><tbody>
      ${r.incidents.slice(0, 50).map((i) => `<tr data-id="${esc(i.deviceId)}"><td>${fmtDateTime(i.start)}</td><td><b>${esc(i.make)}</b> ${esc(shortModel(i.make, i.model))}</td>${multi() && !acting() ? `<td>${esc(i.customerName)}</td>` : ''}<td>${esc(i.room)}<div class="muted">${esc(i.site)}</div></td><td>${status(i.health)}</td><td>${i.ongoing ? chip('Ongoing', 'crit') : mins(i.durationMin)}</td></tr>`).join('')}
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
      <div class="table-wrap"><table><thead><tr><th>Make</th><th>Model</th><th>Type</th><th>Monitored by</th><th>Baseline</th><th>Newest known</th><th>End of sale</th><th>End of support</th><th>End of life</th><th>Source</th><th>Devices</th><th>Below baseline</th></tr></thead><tbody>
      ${r.models.map((m) => `<tr data-model="${esc(m.id)}"><td><b>${esc(m.make)}</b></td><td>${esc(shortModel(m.make, m.model))}</td><td>${esc(m.deviceType)}</td>
        <td><span class="src-tags">${(m.monitoredBy || []).map((o) => `<span class="pill" title="${esc(OEM_NAME[o] || o)}">${OEM_SHORT[o] || esc(o)}</span>`).join('') || '<span class="muted">Not monitored</span>'}</span></td>
        <td class="mono">${esc(m.baseline || '—')}</td><td class="mono">${esc(m.latest || '—')}${m.latest && m.baseline && cmpVer(m.latest, m.baseline) > 0 ? ` ${chip('newer', 'warn')}` : ''}</td>
        <td>${lcDate(m.endOfSale, m.lifecycleStatus)}</td><td>${lcDate(m.endOfSupport, m.lifecycleStatus)}</td><td>${lcDate(m.endOfLife, m.lifecycleStatus)}</td>
        <td>${(m.lifecycleRefs?.[0] || m.lifecycleUrl) ? `<a href="${esc(m.lifecycleRefs?.[0]?.url || m.lifecycleUrl)}" target="_blank" rel="noopener">${m.lifecycleStatus === 'discontinued' ? 'Discontinued' : 'Vendor page'}</a>` : m.lifecycleStatus ? '<span class="muted">No notice</span>' : '—'}</td><td>${m.devices}</td><td>${m.behind ? chip(m.behind, 'crit') : '0'}</td></tr>`).join('') || '<tr><td colspan="12" class="empty">No models yet</td></tr>'}
      </tbody></table></div></div>`;
  document.querySelectorAll('tr[data-model]').forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.closest('a')) return; openModel(S.modelList.find((m) => m.id === tr.dataset.model)); }));
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
      <div class="field"><label>Status</label><select id="mLcStatus" ${dis}><option value="">Not checked</option>${Object.entries(LC_STATUS).map(([k, l]) => `<option value="${k}" ${m?.lifecycleStatus === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Lifecycle note</label><textarea id="mLcNote" rows="3" ${dis}>${v('lifecycleNote')}</textarea></div>
    ${m?.lifecycleRefs?.length ? `<div class="help block" style="margin:-4px 0 6px"><b>Sources checked${m.lifecycleCheckedAt ? ` ${fmtDate(m.lifecycleCheckedAt)}` : ''}:</b><br>${lcSources(m.lifecycleRefs)}</div>` : ''}
    <div class="help block" style="margin:-4px 0 10px">Dates come only from official manufacturer notices${m?.lifecycleSource === 'catalogue' ? ' (pre-filled from the built-in lifecycle catalogue)' : ''}. Where none is published, leave them blank and set the status to "Not announced".</div>
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
      lifecycleStatus: $('#mLcStatus', w).value || null, lifecycleNote: $('#mLcNote', w).value.trim() || null,
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
const AUDIT_GROUPS = [['', 'All activity'], ['auth.', 'Sign-ins'], ['session.', 'Enter customer'], ['device.', 'Device edits and actions'], ['room.', 'Rooms and schematics'], ['customer.', 'Customers'], ['user.', 'Users'], ['connection.', 'Connections and keys'], ['model.', 'Model master'], ['baseline.', 'Baselines'], ['firmware.', 'New firmware seen'], ['api.', 'API checks'], ['audit.', 'Audit exports']];
const AUDIT_LABEL = {
  'auth.login': 'Signed in', 'auth.login_failed': 'Failed sign-in', 'auth.logout': 'Signed out',
  'session.enter_customer': 'Entered customer', 'session.exit_customer': 'Left customer',
  'device.bulk_update': 'Updated devices', 'device.manual_add': 'Added device manually', 'device.bulk_import': 'Bulk added devices (CSV)', 'device.manual_update': 'Edited manual device', 'device.manual_delete': 'Removed manual device', 'device.reset': 'Reset devices to OEM values',
  'device.action': 'Ran a device action', 'device.action_failed': 'Device action failed', 'room.schematic_saved': 'Saved room schematic', 'room.design_uploaded': 'Uploaded room design document', 'room.design_removed': 'Removed room design document', 'api.check': 'Ran API check', 'room.schematic_removed': 'Removed room schematic', 'room.platform': 'Changed room platform',
  'customer.onboard': 'Onboarded customer', 'customer.update': 'Updated customer', 'customer.delete': 'Deleted customer',
  'user.create': 'Added user', 'user.delete': 'Removed user',
  'connection.create': 'Added connection', 'connection.update': 'Changed connection', 'connection.test': 'Tested connection', 'connection.sync': 'Ran sync', 'connection.delete': 'Removed connection',
  'model.create': 'Added model', 'model.update': 'Changed model', 'model.delete': 'Deleted model', 'model.release_add': 'Added firmware release', 'model.release_remove': 'Removed firmware release', 'model.import': 'Imported models from estate',
  'baseline.advisory_save': 'Changed advisory baseline', 'baseline.customer_save': 'Changed customer baseline', 'baseline.customer_restore': 'Restored customer baseline version',
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

// ------------------------------------------------------------------ error code reference
async function viewErrorCodes() {
  const codes = await api('/api/error-codes');
  hero('Error codes', 'What each red or amber code means, its likely causes and what to check. Codes are the same whichever vendor reported the fault; the device panel also shows the vendor\'s own value.');
  const areas = [...new Set(codes.map((c) => c.area))];
  $('#view').innerHTML = areas.map((a) => `<div class="card" style="margin-bottom:18px"><div class="card-head"><h2>${esc(a)}</h2></div>
    ${codes.filter((c) => c.area === a).map((c) => `<details class="diag" id="${esc(c.code)}"><summary><span class="code-chip">${esc(c.code)}</span><b>${esc(c.title)}</b>${c.devices ? `<a class="pill bad" href="#/devices" data-code="${esc(c.code)}">${c.devices} device${c.devices > 1 ? 's' : ''} now</a>` : '<span class="muted">none now</span>'}</summary>
      <div class="diag-body"><p>${esc(c.meaning)}</p><div class="diag-h">Likely causes, most likely first</div><ol>${c.causes.map((x) => `<li>${esc(x)}</li>`).join('')}</ol><div class="diag-h">What to check</div><ul>${c.checks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></details>`).join('')}</div>`).join('');
  document.querySelectorAll('[data-code]').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); S.filters = emptyFilters(); S.filters.q = el.dataset.code; saveFilters(); location.hash = '#/devices'; }));
}

// ------------------------------------------------------------------ API tracker (admins; checks: super admin)
const API_STATE = { up: ['Up', 'good'], slow: ['Slow', 'warn'], down: ['Down', 'crit'], unchecked: ['Not checked', 'mute'], retired: ['Retired by vendor', 'mute'], 'no-api': ['No public API', 'mute'] };
function latencyBars(checks) {
  const list = [...checks].reverse();
  if (!list.length) return '<span class="muted">—</span>';
  const max = Math.max(500, ...list.map((c) => c.ms));
  return `<svg class="spark" viewBox="0 0 ${list.length * 6} 24" width="${list.length * 6}" height="24" aria-hidden="true">${list.map((c, i) => { const h = c.ok ? Math.max(2, (c.ms / max) * 22) : 22; return `<rect x="${i * 6}" y="${24 - h}" width="4" height="${h}" rx="1" fill="${c.ok ? (c.ms > 1500 ? '#fab219' : '#0ca30c') : '#d03b3b'}"><title>${esc(`${fmtDateTime(c.at)} · ${c.ok ? `${c.ms} ms` : 'failed'}${c.status ? ` · HTTP ${c.status}` : ''}`)}</title></rect>`; }).join('')}</svg>`;
}
// ------------------------------------------------------------------ sync schedule (admin)
const fmtInterval = (sec) => {
  if (!sec) return '—';
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
};
const inTime = (iso) => {
  if (!iso) return '—';
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 5) return 'due now';
  if (s < 90) return `in ${s} s`;
  if (s < 5400) return `in ${Math.round(s / 60)} min`;
  return `in ${Math.round(s / 3600)} h`;
};
async function viewSyncSchedule() {
  const r = await api('/api/admin/sync');
  const opts = (min, cur, withDefault) => `${withDefault ? `<option value="" ${cur === null ? 'selected' : ''}>Default (${fmtInterval(r.defaultIntervalSec)})</option>` : ''}${[...new Set([...r.presets, ...(cur ? [cur] : [])])].filter((v) => v >= min).sort((a, b) => a - b).map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>Every ${fmtInterval(v)}</option>`).join('')}`;
  const failing = r.connections.filter((c) => c.state === 'error').length;
  hero('Sync schedule', `How often each connection pulls its devices from the vendor API. Longer intervals put less load on vendor rate limits; shorter ones show changes sooner. Minimum ${fmtInterval(r.limits.min)}, maximum ${fmtInterval(r.limits.max)}.`);
  const sourceLabel = { admin: 'set here', environment: 'from SYNC_INTERVAL_SECONDS', 'built-in': 'built-in default' }[r.defaultSource];
  $('#view').innerHTML = `
    <div class="stats">
      ${statTile('Default interval', fmtInterval(r.defaultIntervalSec), sourceLabel, '')}
      ${statTile('Connections', r.connections.length.toLocaleString(), `${r.connections.filter((c) => c.source === 'connection').length} with their own interval`, '')}
      ${statTile('API pulls per hour', r.pullsPerHour.toLocaleString(), `At most ${r.concurrency} at a time, staggered`, '')}
      ${statTile('Failing', failing, failing ? 'Retried with back-off, up to hourly' : 'All connections syncing', failing ? 'crit' : 'good')}
    </div>
    <div class="card" style="margin-bottom:18px"><div class="card-head"><div><h2>Default interval</h2><div class="card-sub">Used by every connection that has no interval of its own.${r.updatedAt ? ` Last changed ${ago(r.updatedAt)}${r.updatedBy ? ` by ${esc(r.updatedBy)}` : ''}.` : ''}</div></div></div>
      ${r.canEditDefault ? `<div class="sync-default">
        <div class="field"><label for="syDef">Sync every</label><select id="syDef">${opts(r.limits.min, r.defaultIntervalSec, false)}<option value="custom">Custom…</option></select></div>
        <div class="field hidden" id="syCustomWrap"><label for="syCustom">Seconds</label><input id="syCustom" type="number" min="${r.limits.min}" max="${r.limits.max}" step="1" value="${r.defaultIntervalSec}"></div>
        <button class="btn btn-primary btn-sm" id="sySave">Save default</button>
      </div><div id="syMsg"></div>` : `<p class="muted">Every ${fmtInterval(r.defaultIntervalSec)}. Only the super admin can change the default; you can set an interval per connection below.</p>`}
      <div class="help" style="margin-top:8px">A sync that runs longer than ${r.timeoutSec} seconds is abandoned and retried. A failing connection keeps its last good data and retries at twice its interval, then four times, up to once an hour, until it recovers.</div>
    </div>
    <div class="card"><div class="card-head"><div><h2>Per connection</h2><div class="card-sub">Pick "Default" to follow the default above. Some vendors set a higher minimum.</div></div>
      <input class="sy-filter" id="syQ" placeholder="Filter connections" aria-label="Filter connections"></div>
      <div class="table-wrap flat"><table class="sync-table"><thead><tr><th>Connection</th>${multi() && !acting() ? '<th>Customer</th>' : ''}<th>Status</th><th>Interval</th><th>Last sync</th><th>Next sync</th><th>Devices</th></tr></thead><tbody>
      ${r.connections.map((c) => `<tr data-q="${esc(`${c.name} ${c.customerName} ${c.oemName}`.toLowerCase())}">
        <td><b>${esc(c.oemName)}</b><div class="muted">${esc(c.name)} · ${c.mode === 'live' ? 'Live' : 'Mock'}</div></td>
        ${multi() && !acting() ? `<td>${esc(c.customerName)}</td>` : ''}
        <td>${syncState({ state: c.state })}${c.failures ? `<div class="muted">${c.failures} failed in a row</div>` : ''}</td>
        <td><select data-iv="${esc(c.id)}" aria-label="Interval for ${esc(c.name)}">${opts(c.minSec, c.syncIntervalSec, true)}</select>${c.minSec > r.limits.min ? `<div class="muted">Vendor minimum ${fmtInterval(c.minSec)}</div>` : ''}</td>
        <td>${ago(c.lastRunAt)}${c.durationMs !== null && c.durationMs !== undefined ? `<div class="muted">took ${(c.durationMs / 1000).toFixed(1)} s</div>` : ''}</td>
        <td>${inTime(c.nextRunAt)}</td>
        <td>${(c.deviceCount || 0).toLocaleString()}</td></tr>`).join('') || `<tr><td colspan="7" class="empty">No connections</td></tr>`}
      </tbody></table></div></div>
    ${r.storage ? `<div class="muted" style="margin-top:12px;font-size:12px">Estate: ${r.estate.devices.toLocaleString()} devices from ${r.estate.connections.toLocaleString()} connections. Storage: ${r.storage.kind === 'postgres' ? 'Postgres' : 'files on disk'}.</div>` : ''}`;
  $('#syDef')?.addEventListener('change', (e) => { $('#syCustomWrap').classList.toggle('hidden', e.target.value !== 'custom'); });
  $('#sySave')?.addEventListener('click', async () => {
    const v = $('#syDef').value === 'custom' ? Number($('#syCustom').value) : Number($('#syDef').value);
    try { await api('/api/admin/sync', { method: 'PUT', body: { defaultIntervalSec: v } }); toast(ICONS.resolved, `Default sync interval set to ${fmtInterval(v)}`); viewSyncSchedule(); } catch (e) { $('#syMsg').innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
  });
  document.querySelectorAll('select[data-iv]').forEach((sel) => sel.addEventListener('change', async () => {
    const v = sel.value === '' ? null : Number(sel.value);
    sel.disabled = true;
    try { await api(`/api/connections/${encodeURIComponent(sel.dataset.iv)}/schedule`, { method: 'PUT', body: { syncIntervalSec: v } }); toast(ICONS.resolved, v ? `Syncs every ${fmtInterval(v)}` : 'Follows the default interval'); viewSyncSchedule(); } catch (e) { toast(ICONS.critical, e.message); sel.disabled = false; }
  }));
  $('#syQ').addEventListener('input', (e) => { const q = e.target.value.trim().toLowerCase(); document.querySelectorAll('.sync-table tbody tr[data-q]').forEach((tr) => { tr.hidden = !!q && !tr.dataset.q.includes(q); }); });
}

async function viewApis(report) {
  const r = report || await api('/api/admin/apis');
  S.apiReport = r;
  const s = r.summary;
  hero('API tracker', `Every external API this tool depends on, which customers use it, and how it is performing.${r.intervalMinutes ? ` Checked automatically every ${r.intervalMinutes} minutes.` : ''}`);
  const groups = [...new Set(r.apis.map((a) => a.group))];
  $('#view').innerHTML = `
    <div class="stats">
      ${statTile('Up', s.up, `${s.total} APIs tracked`, s.up ? 'good' : '')}
      ${statTile('Slow', s.slow, `Answer took over ${r.slowMs / 1000} s`, s.slow ? 'warn' : '')}
      ${statTile('Down', s.down, s.down ? 'Not reachable at the last check' : 'None at the last check', s.down ? 'crit' : 'good')}
      ${statTile('Not checked / no API', s.unchecked + s.unavailable, `${s.unavailable} have no live API from the vendor`, '')}
    </div>
    <div class="card" style="margin-bottom:18px"><div class="card-head"><div><h2>Checks</h2><div class="card-sub">${r.lastRunAt ? `Last run ${ago(r.lastRunAt)} (${fmtDateTime(r.lastRunAt)})` : 'Not run yet'}. A check calls each API without credentials and times the answer. A 401 or 403 means it is up and asking for a token, as expected. It also tests each customer connection with its own credentials.</div></div>
      ${isSuper() ? '<button class="btn btn-primary btn-sm" id="apiCheckAll">Check all APIs</button>' : '<span class="muted">Only the super admin can run checks</span>'}</div><div id="apiMsg"></div></div>
    ${groups.map((g) => `<div class="card" style="margin-bottom:18px"><div class="card-head"><div><h2>${esc(g)}</h2><div class="card-sub">${g === 'Map and browser' ? 'Called by the user\'s browser, not the server' : 'Called by the server when it syncs devices'}</div></div></div>
      <div class="table-wrap flat"><table class="api-table"><thead><tr><th>Status</th><th>API</th><th>Used by</th><th>Last check</th><th>Response time (last 24 checks)</th><th>Live calls</th><th></th></tr></thead><tbody>
      ${r.apis.filter((a) => a.group === g).map((a) => { const [lbl, tone] = API_STATE[a.state]; return `<tr data-api="${esc(a.id)}">
        <td>${chip(lbl, tone)}</td>
        <td><b>${esc(a.name)}</b><div class="muted">${esc(a.provider)}${a.method ? ` · <span class="mono">${esc(a.method)}</span>` : ''}</div>${a.url ? `<div class="mono api-url">${esc(a.url)}</div>` : ''}</td>
        <td>${a.calledFrom === 'Browser' ? '<span class="muted">Every signed-in user</span>' : a.connections.length ? `${a.live ? chip(`${a.live} live`, 'good') : ''} ${a.mock ? chip(`${a.mock} demo`, 'mute') : ''}<div class="muted">${esc([...new Set(a.connections.map((c) => c.customerName))].slice(0, 3).join(', '))}${new Set(a.connections.map((c) => c.customerName)).size > 3 ? '…' : ''}</div>` : '<span class="muted">No connections</span>'}</td>
        <td>${a.latest ? `<b>${a.latest.ok ? `${a.latest.ms} ms` : 'Failed'}</b>${a.latest.status ? ` <span class="muted">HTTP ${a.latest.status}</span>` : ''}<div class="muted">${esc(a.latest.note || '')}${a.latest.note ? ' · ' : ''}${ago(a.latest.at)}</div>` : '<span class="muted">—</span>'}</td>
        <td>${latencyBars(a.checks)}${a.avgMs !== null ? `<div class="muted">avg ${a.avgMs} ms · p95 ${a.p95Ms} ms · ${a.uptime}% up</div>` : ''}</td>
        <td>${a.calls ? `<b>${a.calls.calls}</b> calls<div class="muted">${a.calls.errors} errors · avg ${a.calls.avgMs} ms${a.calls.lastError ? ` · last: ${esc(a.calls.lastError)}` : ''}</div>` : `<span class="muted">${a.live ? 'None since restart' : 'Live mode only'}</span>`}</td>
        <td style="white-space:nowrap">${isSuper() && a.probeUrl ? `<button class="btn btn-outline btn-sm" data-check="${esc(a.id)}">Check</button>` : ''}</td></tr>`; }).join('')}
      </tbody></table></div></div>`).join('')}`;
  const run = async (btn, id) => {
    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Checking…';
    try { const rep = await api('/api/admin/apis/check', { method: 'POST', body: id ? { id } : {} }); toast(ICONS.resolved, id ? 'API checked' : `Checked ${rep.apis.filter((a) => a.latest).length} APIs`); viewApis(rep); } catch (e) { $('#apiMsg').innerHTML = `<div class="notice err">${esc(e.message)}</div>`; btn.disabled = false; btn.textContent = old; }
  };
  $('#apiCheckAll')?.addEventListener('click', (e) => run(e.target, null));
  document.querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); run(b, b.dataset.check); }));
  document.querySelectorAll('tr[data-api]').forEach((tr) => tr.addEventListener('click', () => openApi(r.apis.find((a) => a.id === tr.dataset.api))));
}
function openApi(a) {
  const [lbl, tone] = API_STATE[a.state];
  drawer(a.name, `${esc(a.provider)} · ${esc(a.group)}`, `
    <div style="margin-bottom:12px">${chip(lbl, tone)}</div>
    <dl class="kv"><dt>Purpose</dt><dd>${esc(a.purpose)}</dd>
      ${a.url ? `<dt>Endpoint</dt><dd class="mono" style="word-break:break-all">${esc(a.method || '')} ${esc(a.url)}</dd>` : ''}
      ${a.probeUrl && a.probeUrl !== a.url ? `<dt>Checked at</dt><dd class="mono" style="word-break:break-all">${esc(a.probeUrl)}</dd>` : ''}
      <dt>Authentication</dt><dd>${esc(a.auth || '—')}</dd><dt>Called from</dt><dd>${esc(a.calledFrom)}</dd>
      ${a.docsUrl ? `<dt>Documentation</dt><dd><a href="${esc(a.docsUrl)}" target="_blank" rel="noopener">Vendor docs</a></dd>` : ''}</dl>
    ${a.connections.length ? `<div class="section-title">Customer connections using it</div>
      <div class="table-wrap flat"><table><thead><tr><th>Connection</th><th>Mode</th><th>Last sync</th><th>Credential test</th></tr></thead><tbody>
      ${a.connections.map((c) => `<tr><td><b>${esc(c.name)}</b><div class="muted">${esc(c.customerName)}</div></td><td><span class="pill ${c.mode}">${c.mode === 'live' ? 'Live' : 'Demo'}</span></td>
        <td>${c.sync.state === 'error' ? chip('Failed', 'crit') : c.sync.state === 'ok' ? chip('OK', 'good') : chip(c.sync.state, 'mute')}<div class="muted">${c.sync.lastSuccessAt ? `${ago(c.sync.lastSuccessAt)} · ${c.sync.durationMs} ms` : ''}${c.sync.error ? esc(c.sync.error) : ''}</div></td>
        <td>${c.test ? `${chip(c.test.ok ? 'Passed' : 'Failed', c.test.ok ? 'good' : 'crit')} <span class="muted">${c.test.ms} ms</span><div class="muted">${esc(c.test.message || '')}</div>` : '<span class="muted">Runs with the next check</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${a.calls ? `<div class="section-title">Live calls since the server started</div><dl class="kv"><dt>Calls</dt><dd>${a.calls.calls} (${a.calls.errors} errors)</dd><dt>Average</dt><dd>${a.calls.avgMs} ms</dd><dt>Last call</dt><dd>${ago(a.calls.lastAt)}${a.calls.lastStatus ? ` · HTTP ${a.calls.lastStatus}` : ''}</dd>${a.calls.lastError ? `<dt>Last error</dt><dd>${esc(a.calls.lastError)}</dd>` : ''}</dl>` : ''}
    ${a.checks.length ? `<div class="section-title">Recent checks</div><div class="table-wrap flat"><table><thead><tr><th>Time</th><th>Result</th><th>Time taken</th></tr></thead><tbody>
      ${a.checks.map((c) => `<tr><td>${fmtDateTime(c.at)}</td><td>${c.ok ? chip('Up', 'good') : chip('Down', 'crit')}${c.status ? ` <span class="muted">HTTP ${c.status}</span>` : ''}</td><td>${c.ms} ms</td></tr>`).join('')}</tbody></table></div>` : ''}`);
}

// ------------------------------------------------------------------ add a device by hand
async function openManualDevice(rec, preset = {}) {
  const editing = !!rec;
  const [modelsRes] = await Promise.all([api('/api/models')]);
  const models = modelsRes.models;
  const custs = S.customers;
  let customerId = rec?.customerId || preset.customerId || acting() || (S.filters.customer?.length === 1 ? S.filters.customer[0] : custs[0]?.id);
  const makes = [...new Set(models.map((m) => m.make))].sort();
  const curModel = models.find((m) => m.id === rec?.modelId);
  const OTHER = '__other';
  // A record typed in under "Other": its make may or may not be in the master.
  const customMake = rec && !rec.modelId ? rec.make : null;
  const startMake = curModel?.make || (customMake && makes.includes(customMake) ? customMake : customMake ? OTHER : preset.make);
  const v = (k) => esc(rec?.[k] ?? preset[k] ?? '');
  const w = drawer(editing ? 'Edit manual device' : 'Add device', editing ? 'Changes apply to the manual record' : 'For kit with no API, or not connected yet', `
    <div id="mdvMsg"></div>
    <div class="notice info">Devices added here show as <b>Not monitored</b>. If a connected API later reports the same serial number or MAC address, the two records merge and live health takes over.</div>
    ${custs.length > 1 && !editing ? `<div class="field"><label>Customer *</label><select id="mdvCust">${custs.map((c) => `<option value="${esc(c.id)}" ${c.id === customerId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>` : ''}
    <div class="grid cols-2" style="gap:10px">
      <div class="field"><label>Make *</label><select id="mdvMake"><option value="">Choose make…</option>${makes.map((m) => `<option ${m === startMake ? 'selected' : ''}>${esc(m)}</option>`).join('')}<option value="${OTHER}" ${startMake === OTHER ? 'selected' : ''}>Other (type it in)…</option></select></div>
      <div class="field"><label>Model *</label><select id="mdvModel"></select></div>
    </div>
    <div id="mdvOther" class="grid cols-2 other-box hidden" style="gap:10px">
      <div class="field" id="mdvMakeTxtF"><label>Manufacturer *</label><input id="mdvMakeTxt" value="${esc(customMake || '')}" placeholder="e.g. Neat, Yealink, Crestron"></div>
      <div class="field"><label>Model *</label><input id="mdvModelTxt" value="${esc(rec && !rec.modelId ? rec.model || '' : '')}" placeholder="e.g. Bar Pro"></div>
      <div class="field"><label>Device type</label><select id="mdvType">${DEVICE_TYPES.map((t) => `<option ${t === (rec?.deviceType || 'Peripheral') ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="help" style="align-self:center">Not in the model master, so no API connector can monitor it. It will be tagged <b>Not monitored</b>.${isSuper() ? ' You can add it to the master later from the Models tab.' : ''}</div>
    </div>
    <div class="help" id="mdvModelInfo" style="margin:-6px 0 12px"></div>
    <div class="grid cols-2" style="gap:10px">
      <div class="field"><label for="mdvSiteSel">Site *</label><select id="mdvSiteSel"><option value="">Loading sites…</option></select><input id="mdvSiteNew" class="hidden" style="margin-top:6px" placeholder="New site name" maxlength="80"></div>
      <div class="field"><label for="mdvRoomSel">Room *</label><select id="mdvRoomSel"><option value="">Choose a site first</option></select><input id="mdvRoomNew" class="hidden" style="margin-top:6px" placeholder="New room name" maxlength="80"></div>
      <div class="field"><label>Serial number</label><input id="mdvSerial" value="${v('serial')}" class="mono"></div>
      <div class="field"><label>MAC address</label><input id="mdvMac" value="${v('mac')}" class="mono" placeholder="00:e0:db:12:34:56"></div>
      <div class="field"><label>Firmware version</label><input id="mdvFw" value="${v('firmware')}" class="mono"></div>
      <div class="field"><label>Meeting platform</label><select id="mdvPlat">${PLATFORM_LIST.map((p) => `<option ${p === (rec?.platform || 'Unassigned') ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      <div class="field"><label>Asset tag</label><input id="mdvAsset" value="${v('assetTag')}"></div>
      <div class="field"><label>Warranty end</label><input id="mdvWarr" type="date" value="${v('warrantyExpires')}"></div>
    </div>
    <div class="field"><label>Notes</label><input id="mdvNotes" value="${v('notes')}"></div>
    <div class="help">Add the serial or MAC whenever you can: that is how the device is matched if it is connected to an API later.</div>`,
  `${editing ? '' : '<button class="btn btn-outline" id="mdvMore">Save and add another</button>'}<button class="btn btn-primary" id="mdvSave">${editing ? 'Save' : 'Add device'}</button>`);
  const fillModels = () => {
    const make = $('#mdvMake', w).value;
    const list = models.filter((m) => m.make === make);
    const wantOther = customMake && make === customMake && !curModel;
    $('#mdvModel', w).disabled = make === OTHER;
    $('#mdvModel', w).innerHTML = make === OTHER ? '<option value="">Type it in below</option>'
      : make ? `${list.map((m) => `<option value="${esc(m.id)}" ${m.id === (curModel?.id || preset.modelId) ? 'selected' : ''}>${esc(shortModel(m.make, m.model))}</option>`).join('')}<option value="${OTHER}" ${wantOther ? 'selected' : ''}>Other (type it in)…</option>` : '<option value="">Choose a make first</option>';
    showInfo();
  };
  const showInfo = () => {
    const make = $('#mdvMake', w).value;
    const other = make === OTHER || $('#mdvModel', w).value === OTHER;
    $('#mdvOther', w).classList.toggle('hidden', !other);
    $('#mdvMakeTxtF', w).classList.toggle('hidden', make !== OTHER);
    const m = models.find((x) => x.id === $('#mdvModel', w).value);
    $('#mdvModelInfo', w).innerHTML = other ? ''
      : m ? `${esc(m.deviceType)}${m.baseline ? ` · approved firmware ${esc(m.baseline)}` : ''}${m.monitoredBy?.length ? ` · can be monitored by ${m.monitoredBy.map((o) => esc(OEM_NAME[o] || o)).join(', ')}` : ' · <b>no API connector</b>, so it will be tagged Not monitored'}`
        : 'Not in the list? Choose <b>Other</b> to type the manufacturer and model in.';
    if (m?.baseline && !$('#mdvFw', w).value && !editing) $('#mdvFw', w).placeholder = m.baseline;
  };
  // Site and room are dropdowns of the customer's existing places, with "New…" to type one in.
  const NEW = '__new';
  let places = new Map();
  const pickOrNew = (sel, input, list, cur, noun) => {
    const opts = [...list];
    if (cur && !opts.includes(cur)) opts.push(cur);
    sel.innerHTML = `<option value="">Choose ${noun}…</option>${opts.sort((a, b) => a.localeCompare(b)).map((x) => `<option ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('')}<option value="${NEW}">New ${noun}…</option>`;
    input.classList.toggle('hidden', sel.value !== NEW);
  };
  const fillRooms = (cur) => {
    const site = siteVal();
    pickOrNew($('#mdvRoomSel', w), $('#mdvRoomNew', w), places.get(site) || [], cur, 'room');
    if (!site) $('#mdvRoomSel', w).innerHTML = '<option value="">Choose a site first</option>';
    $('#mdvRoomSel', w).disabled = !site;
  };
  const siteVal = () => ($('#mdvSiteSel', w).value === NEW ? $('#mdvSiteNew', w).value.trim() : $('#mdvSiteSel', w).value);
  const roomVal = () => ($('#mdvRoomSel', w).value === NEW ? $('#mdvRoomNew', w).value.trim() : $('#mdvRoomSel', w).value);
  const fillPlaces = async () => {
    const curSite = rec?.site ?? preset.site ?? ''; const curRoom = rec?.room ?? preset.room ?? '';
    try {
      const tree = await api(`/api/tree?customer=${encodeURIComponent(customerId)}`);
      places = new Map(tree.map((x) => [x.site, x.rooms.map((r) => r.room)]));
    } catch { places = new Map(); }
    pickOrNew($('#mdvSiteSel', w), $('#mdvSiteNew', w), [...places.keys()], curSite, 'site');
    fillRooms(curRoom);
  };
  $('#mdvSiteSel', w).addEventListener('change', (e) => {
    $('#mdvSiteNew', w).classList.toggle('hidden', e.target.value !== NEW);
    if (e.target.value === NEW) $('#mdvSiteNew', w).focus();
    fillRooms('');
    if (e.target.value === NEW) { pickOrNew($('#mdvRoomSel', w), $('#mdvRoomNew', w), [], '', 'room'); $('#mdvRoomSel', w).value = NEW; $('#mdvRoomSel', w).disabled = false; $('#mdvRoomNew', w).classList.remove('hidden'); }
  });
  $('#mdvRoomSel', w).addEventListener('change', (e) => { $('#mdvRoomNew', w).classList.toggle('hidden', e.target.value !== NEW); if (e.target.value === NEW) $('#mdvRoomNew', w).focus(); });
  $('#mdvMake', w).addEventListener('change', fillModels);
  $('#mdvModel', w).addEventListener('change', showInfo);
  $('#mdvCust', w)?.addEventListener('change', (e) => { customerId = e.target.value; fillPlaces(); });
  fillModels(); fillPlaces();
  const save = async (again) => {
    const body = {
      customerId, ...(() => {
        const make = $('#mdvMake', w).value; const model = $('#mdvModel', w).value;
        if (make === OTHER || model === OTHER) return { modelId: null, make: make === OTHER ? $('#mdvMakeTxt', w).value.trim() : make, model: $('#mdvModelTxt', w).value.trim(), deviceType: $('#mdvType', w).value };
        return { modelId: model };
      })(), site: siteVal(), room: roomVal(),
      serial: $('#mdvSerial', w).value.trim() || null, mac: $('#mdvMac', w).value.trim() || null, firmware: $('#mdvFw', w).value.trim() || null,
      platform: $('#mdvPlat', w).value, assetTag: $('#mdvAsset', w).value.trim() || null, warrantyExpires: $('#mdvWarr', w).value || null, notes: $('#mdvNotes', w).value.trim() || null,
    };
    try {
      await api(editing ? `/api/manual-devices/${encodeURIComponent(rec.id)}` : '/api/manual-devices', { method: editing ? 'PUT' : 'POST', body });
      toast(ICONS.resolved, editing ? 'Device saved' : 'Device added');
      if (again) openManualDevice(null, { customerId, site: body.site, room: body.room, make: body.modelId ? $('#mdvMake', w).value : undefined, modelId: body.modelId });
      else closeDrawer();
      S.options = await api('/api/filters').catch(() => S.options);
      refreshView();
    } catch (e) { $('#mdvMsg', w).innerHTML = `<div class="notice err">${esc(e.message)}</div>`; w.querySelector('.drawer-body').scrollTop = 0; }
  };
  $('#mdvSave', w).addEventListener('click', () => save(false));
  $('#mdvMore', w)?.addEventListener('click', () => save(true));
}

// ------------------------------------------------------------------ roles and permissions
async function viewRoles(args = []) {
  const [layer, id] = args;
  const q = layer ? `?layer=${encodeURIComponent(layer)}${id ? `&id=${encodeURIComponent(id)}` : ''}` : '';
  const v = await api(`/api/roles${q}`);
  const changes = {};
  hero('Roles & permissions', 'Five levels, each inside the one above. Every level can add users and tune permissions only for the levels below it, and never beyond its own permissions.');
  const roleCard = (r) => `<div class="conn-card role-card ${r.id === S.me.role ? 'mine' : ''}">
      <div class="conn-top"><div class="oem-logo role-rank">${r.rank + 1}</div><div><div class="sync-name">${esc(r.label)}${r.label !== r.builtInLabel ? ` <span class="muted" style="font-weight:500">(${esc(r.builtInLabel)})</span>` : ''}</div><div class="sync-meta">${esc(r.scope)}${r.id === S.me.role ? ' · your role' : ''}</div></div></div>
      <p class="role-sum">${esc(r.summary)}</p>
      <ul class="role-duties">${r.duties.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>`;
  const groups = [...new Set(v.permissions.map((p) => p.group))];
  const cell = (r, p) => {
    const c = v.matrix[r.id][p.key];
    const title = c.inherited !== null && c.overridden ? ` title="Changed here. Inherited: ${c.inherited ? 'on' : 'off'}"` : '';
    if (c.editable) return `<td class="pm-cell${c.overridden ? ' over' : ''}"${title}><input type="checkbox" data-pm="${esc(r.id)}|${esc(p.key)}" ${c.on ? 'checked' : ''} aria-label="${esc(r.label)}: ${esc(p.label)}"></td>`;
    return `<td class="pm-cell${c.overridden ? ' over' : ''}"${title}>${c.on ? '<span class="pm-yes" aria-label="Yes">✓</span>' : '<span class="pm-no" aria-label="No">–</span>'}</td>`;
  };
  $('#view').innerHTML = `
    <div class="conn-grid roles-grid">${v.roles.map(roleCard).join('')}</div>
    <div class="card" style="margin-top:18px"><div class="card-head" style="flex-wrap:wrap;gap:10px"><div><h2>Permissions: ${esc(v.name || '')}</h2>
      <div class="card-sub">${v.layer === 'platform' ? 'Platform defaults for every MSP and customer.' : v.layer === 'msp' ? 'Applies to every customer of this MSP, on top of the platform defaults.' : 'Applies to this customer only, on top of its MSP\'s settings.'} ${v.canEdit ? 'Tick or untick to change a role below yours. A highlighted cell differs from what this level inherits.' : 'Read only.'}</div></div>
      ${v.layers.length > 1 ? `<select id="pmLayer" class="pill" style="font-weight:600">${v.layers.map((l) => `<option value="${esc(l.layer)}|${esc(l.id || '')}" ${l.layer === v.layer && (l.id || null) === v.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>` : ''}</div>
      <div id="pmMsg"></div>
      <div class="table-wrap flat"><table class="pm-table"><thead><tr><th>Permission</th>${v.roles.map((r) => `<th>${esc(r.label)}</th>`).join('')}</tr></thead>
        <tbody>${groups.map((g) => `<tr class="pm-group"><td colspan="${v.roles.length + 1}">${esc(g)}</td></tr>${v.permissions.filter((p) => p.group === g).map((p) => `<tr><td><b>${esc(p.label)}</b>${p.locked ? ' <span class="chip mute">fixed</span>' : ''}<div class="muted" style="font-size:12px">${esc(p.help)}</div></td>${v.roles.map((r) => cell(r, p)).join('')}</tr>`).join('')}`).join('')}</tbody></table></div>
      ${v.canRename ? `<div class="section-title">Role names</div><div class="help block">Rename a role to match your own terms. Responsibilities and permissions stay the same.</div>
        <div class="grid cols-2" style="gap:10px">${v.roles.map((r) => `<div class="field"><label>${esc(r.builtInLabel)}</label><input data-label="${esc(r.id)}" value="${esc(r.label)}" maxlength="40"></div>`).join('')}</div>` : ''}
      ${v.canEdit ? `<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px"><button class="btn btn-outline btn-sm" id="pmReset">Reset to inherited</button><button class="btn btn-primary btn-sm" id="pmSave">Save changes</button></div>` : ''}
    </div>`;
  $('#pmLayer')?.addEventListener('change', (e) => { const [l, i] = e.target.value.split('|'); location.hash = `#/roles/${l}${i ? `/${encodeURIComponent(i)}` : ''}`; });
  document.querySelectorAll('[data-pm]').forEach((b) => b.addEventListener('change', () => {
    const [r, k] = b.dataset.pm.split('|');
    (changes[r] ||= {})[k] = b.checked;
    b.closest('td').classList.add('dirty');
  }));
  const msg = (t, ok) => { $('#pmMsg').innerHTML = `<div class="notice ${ok ? 'ok' : 'err'}">${esc(t)}</div>`; };
  const save = async (body) => {
    try {
      await api('/api/roles', { method: 'PUT', body: { layer: v.layer, id: v.id, ...body } });
      S.me = await api('/api/me');
      toast(ICONS.resolved, 'Permissions saved');
      renderShell(); openEvents(); navigate();
    } catch (e) { msg(e.message); }
  };
  $('#pmSave')?.addEventListener('click', () => {
    const labels = v.canRename ? Object.fromEntries([...document.querySelectorAll('[data-label]')].map((i) => [i.dataset.label, i.value.trim()])) : undefined;
    save({ overrides: changes, ...(labels ? { labels } : {}) });
  });
  $('#pmReset')?.addEventListener('click', (e) => {
    if (!e.target.dataset.confirm) { e.target.dataset.confirm = 1; e.target.textContent = 'Click again to reset'; return; }
    save({ reset: true });
  });
}

// ------------------------------------------------------------------ users
async function viewUsers() {
  const r = await api('/api/users');
  const label = (role) => r.labels[role] || role;
  const where = (u) => [u.mspName && (u.role === 'msp_admin' || isSuper()) ? u.mspName : null, u.customerName].filter(Boolean).join(' › ') || (u.role === 'super_admin' ? 'Platform' : '—');
  hero('Users', `${r.users.length} user${r.users.length === 1 ? '' : 's'}. You can add ${r.creatable.map((x) => label(x).toLowerCase().replace('msp', 'MSP')).join(', ').replace(/, ([^,]*)$/, ' and $1') || 'no one'}.`);
  $('#view').innerHTML = `
    ${r.creatable.length ? '<div class="toolbar"><span class="muted">Each level adds users only below itself, inside its own organisation. Changes are recorded in the audit log.</span><button class="btn btn-grad btn-sm" id="addUser">+ Add user</button></div>' : ''}
    <div class="card"><div class="table-wrap flat"><table><thead><tr><th>User</th><th>Role</th><th>Organisation</th><th>Status</th><th></th></tr></thead><tbody>
      ${r.users.map((u) => `<tr><td><b>${esc(u.name)}</b>${u.self ? ' <span class="chip blue">you</span>' : ''}<div class="muted" style="font-size:12px">${esc(u.email)}</div></td>
        <td>${esc(u.roleLabel)}</td><td>${esc(where(u))}</td><td>${u.disabled ? chip('Disabled', 'crit') : chip('Active', 'good')}</td>
        <td style="white-space:nowrap">${u.manageable ? `<button class="linkbtn" data-edituser="${esc(u.id)}">Manage</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#addUser')?.addEventListener('click', () => openUser(null, r));
  document.querySelectorAll('[data-edituser]').forEach((b) => b.addEventListener('click', () => openUser(r.users.find((u) => u.id === b.dataset.edituser), r)));
}

function openUser(u, r, preset = {}) {
  const label = (role) => r.labels[role] || role;
  const creating = !u;
  const roles = creating ? r.creatable : r.creatable.filter((x) => x !== 'msp_admin');
  const custOpts = (sel) => r.customers.map((c) => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const w = drawer(creating ? 'Add user' : u.name, creating ? 'They sign in with this email and password' : u.email, `
    <div id="uMsg"></div>
    ${creating ? `<div class="field"><label>Email *</label><input id="uEmail" type="email" autocomplete="off"></div>` : ''}
    <div class="field"><label>Name</label><input id="uName" value="${esc(u?.name || '')}"></div>
    ${!creating && u.role === 'msp_admin' ? '' : `<div class="field"><label>Role</label><select id="uRole">${roles.map((x) => `<option value="${x}" ${x === (u?.role || preset.role) ? 'selected' : ''}>${esc(label(x))}</option>`).join('')}</select><div class="help" id="uRoleHelp"></div></div>`}
    ${creating ? `<div class="field" id="uMspF"><label>MSP</label><select id="uMsp">${r.msps.map((m) => `<option value="${esc(m.id)}" ${m.id === preset.mspId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
      <div class="field" id="uCustF"><label>Customer</label><select id="uCust">${custOpts(preset.customerId || r.customers[0]?.id)}</select></div>` : ''}
    <div class="field"><label>${creating ? 'Password *' : 'Set a new password'}</label><input id="uPw" type="password" autocomplete="new-password" placeholder="${creating ? '8 or more characters' : 'Leave blank to keep the current one'}"></div>
    ${creating ? '' : `<label class="inline-chk"><input type="checkbox" id="uDisabled" ${u.disabled ? 'checked' : ''}> Disabled (cannot sign in)</label>`}`,
  `${creating ? '' : '<button class="btn btn-danger" id="uDel" style="margin-right:auto">Remove user</button>'}<button class="btn btn-primary" id="uSave">${creating ? 'Add user' : 'Save'}</button>`);
  const DUTY = { msp_admin: 'Manages the customers of one MSP.', customer_admin: 'Runs one customer: users, sites, estate and approvals.', technical_user: 'Diagnostics and remote actions for one customer.', end_user: 'Read-only room status for one customer, and can report issues.' };
  const paint = () => {
    const role = $('#uRole', w)?.value || u?.role;
    if ($('#uRoleHelp', w)) $('#uRoleHelp', w).textContent = DUTY[role] || '';
    if (creating) { $('#uMspF', w).classList.toggle('hidden', role !== 'msp_admin'); $('#uCustF', w).classList.toggle('hidden', role === 'msp_admin' || r.customers.length < 2); }
  };
  $('#uRole', w)?.addEventListener('change', paint); paint();
  const msg = (t) => { $('#uMsg', w).innerHTML = `<div class="notice err">${esc(t)}</div>`; };
  $('#uSave', w).addEventListener('click', async () => {
    try {
      if (creating) {
        const role = $('#uRole', w).value;
        await api('/api/users', { method: 'POST', body: { email: $('#uEmail', w).value.trim(), name: $('#uName', w).value.trim(), password: $('#uPw', w).value, role, mspId: role === 'msp_admin' ? $('#uMsp', w).value : undefined, customerId: role === 'msp_admin' ? undefined : $('#uCust', w).value } });
      } else {
        const body = { name: $('#uName', w).value.trim(), disabled: $('#uDisabled', w).checked };
        if ($('#uRole', w)) body.role = $('#uRole', w).value;
        if ($('#uPw', w).value) body.password = $('#uPw', w).value;
        await api(`/api/users/${encodeURIComponent(u.id)}`, { method: 'PUT', body });
      }
      closeDrawer(); toast(ICONS.resolved, creating ? 'User added' : 'User saved'); navigate();
    } catch (e) { msg(e.message); }
  });
  $('#uDel', w)?.addEventListener('click', async (e) => {
    if (!e.target.dataset.confirm) { e.target.dataset.confirm = 1; e.target.textContent = `Click again to remove ${u.email}`; return; }
    try { await api(`/api/users/${encodeURIComponent(u.id)}`, { method: 'DELETE' }); closeDrawer(); toast(ICONS.resolved, 'User removed'); navigate(); } catch (err) { msg(err.message); }
  });
}

// ------------------------------------------------------------------ MSPs (super admin)
async function viewMsps() {
  const list = await api('/api/admin/msps');
  hero('MSPs', 'Managed service providers on the platform. Each MSP admin sees only the customers of their own MSP.');
  $('#view').innerHTML = `
    <div class="cta"><div><h3>Add an MSP</h3><p>Create the MSP, then add its admins. They onboard and run their own customers.</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="mspName" placeholder="MSP name" style="min-width:200px"><button class="btn btn-grad" id="mspAdd">Add MSP</button></div></div>
    <div id="mspMsg"></div>
    <div class="conn-grid">${list.map((m) => `<div class="conn-card">
      <div class="conn-top"><div class="oem-logo" style="background:var(--grad)">${esc(m.name.split(/\s+/).map((x) => x[0]).slice(0, 2).join(''))}</div>
        <div><div class="sync-name">${esc(m.name)}</div><div class="sync-meta">${m.customers.length} customers · ${m.admins.length} admins · ${m.deviceCount} devices</div></div></div>
      <div class="muted" style="font-size:12.5px">${m.customers.map((c) => esc(c.name)).join(', ') || 'No customers yet'}</div>
      <div class="muted" style="font-size:12.5px;margin-top:4px">${m.admins.map((a) => esc(a.email)).join(', ') || 'No admins yet'}</div>
      <div class="conn-actions"><button class="btn btn-primary btn-sm" data-mspadmin="${esc(m.id)}">Add admin</button><a class="btn btn-outline btn-sm" href="#/roles/msp/${encodeURIComponent(m.id)}">Permissions</a><button class="btn btn-outline btn-sm" data-msprename="${esc(m.id)}">Rename</button>${m.customers.length ? '' : `<button class="btn btn-danger btn-sm" data-mspdel="${esc(m.id)}">Delete</button>`}</div>
    </div>`).join('')}</div>`;
  const msg = (t) => { $('#mspMsg').innerHTML = `<div class="notice err">${esc(t)}</div>`; };
  $('#mspAdd').addEventListener('click', async () => {
    try { await api('/api/admin/msps', { method: 'POST', body: { name: $('#mspName').value } }); toast(ICONS.resolved, 'MSP added'); viewMsps(); } catch (e) { msg(e.message); }
  });
  document.querySelectorAll('[data-mspadmin]').forEach((b) => b.addEventListener('click', async () => openUser(null, await api('/api/users'), { role: 'msp_admin', mspId: b.dataset.mspadmin })));
  document.querySelectorAll('[data-msprename]').forEach((b) => b.addEventListener('click', () => {
    const m = list.find((x) => x.id === b.dataset.msprename);
    const w = drawer(`Rename ${m.name}`, 'The new name shows everywhere straight away', '<div id="rnMsg"></div><div class="field"><label>MSP name</label><input id="rnName"></div>', '<button class="btn btn-primary" id="rnSave">Save</button>');
    $('#rnName', w).value = m.name;
    $('#rnSave', w).addEventListener('click', async () => {
      try { await api(`/api/admin/msps/${encodeURIComponent(m.id)}`, { method: 'PUT', body: { name: $('#rnName', w).value } }); closeDrawer(); viewMsps(); } catch (e) { $('#rnMsg', w).innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
    });
  }));
  document.querySelectorAll('[data-mspdel]').forEach((b) => b.addEventListener('click', async (e) => {
    if (!e.target.dataset.confirm) { e.target.dataset.confirm = 1; e.target.textContent = 'Click again to delete'; return; }
    try { await api(`/api/admin/msps/${encodeURIComponent(b.dataset.mspdel)}`, { method: 'DELETE' }); toast(ICONS.resolved, 'MSP deleted'); viewMsps(); } catch (err) { msg(err.message); }
  }));
}

// ------------------------------------------------------------------ sites (customer admins)
async function viewSites() {
  const cid = S.me.customerId;
  const c = S.customers.find((x) => x.id === cid);
  hero('Sites', `Sites and map positions for ${esc(c?.name || S.me.customerName)}.${can('contacts.view') && can('inbox.view') ? ` Site and room contacts are under <a href="#/inbox/contacts/${encodeURIComponent(cid)}">Site contacts</a>.` : ''}`);
  const rows = (await api(`/api/customers/${encodeURIComponent(cid)}/sites`)).sites;
  $('#view').innerHTML = `<div class="card"><div id="stMsg"></div>
    <div class="help block">Pick a city preset to fill in the map position. Sites with a position appear on the map.</div>
    <div id="stRows">${rows.map((s, i) => siteRow(s, i)).join('')}</div>
    <div style="display:flex;justify-content:space-between;margin-top:10px"><button class="btn btn-outline btn-sm" id="stAdd">Add site</button><button class="btn btn-primary btn-sm" id="stSave">Save sites</button></div></div>`;
  bindSiteRows($('#stRows'));
  $('#stAdd').addEventListener('click', () => { $('#stRows').insertAdjacentHTML('beforeend', siteRow({}, Date.now())); bindSiteRows($('#stRows')); });
  $('#stSave').addEventListener('click', async () => {
    try {
      await api(`/api/customers/${encodeURIComponent(cid)}/sites`, { method: 'PUT', body: { sites: readSites($('#stRows')) } });
      toast(ICONS.resolved, 'Sites saved'); S.options = await api('/api/filters'); viewSites();
    } catch (e) { $('#stMsg').innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
  });
}

// ------------------------------------------------------------------ report an issue
function reportIssueHTML() {
  return can('issue.report') ? `<div class="section-title">Report an issue</div>
    <div class="field"><input id="riSum" maxlength="200" placeholder="What's wrong? e.g. No picture on the left screen"></div>
    <div class="field"><textarea id="riDet" rows="2" maxlength="2000" placeholder="Details (optional)"></textarea></div>
    <button class="btn btn-outline btn-sm" id="riSend">Send report</button><div id="riMsg"></div>` : '';
}
function bindReportIssue(root, target) {
  $('#riSend', root)?.addEventListener('click', async (e) => {
    try {
      await api('/api/issues', { method: 'POST', body: { ...target, summary: $('#riSum', root).value, details: $('#riDet', root).value } });
      $('#riSum', root).value = ''; $('#riDet', root).value = '';
      $('#riMsg', root).innerHTML = '<div class="notice ok">Reported. Your administrators see it in the alert feed.</div>';
      e.target.disabled = true; setTimeout(() => { e.target.disabled = false; }, 10_000);
    } catch (err) { $('#riMsg', root).innerHTML = `<div class="notice err">${esc(err.message)}</div>`; }
  });
}
// ------------------------------------------------------------------ action inbox
// Proposed actions from the daily checks, per customer. Admins answer Yes or No.
// Yes runs a vendor API action, or emails on-site steps to the site contact (SPOC).
const SEV_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
const ACT_STATUS = { proposed: 'To decide', approved: 'Approved', sent: 'Sent', failed: 'Failed', done: 'Done', declined: 'Declined', resolved: 'Cleared' };
const INBOX_TABS = [['proposed', 'To decide', 'proposed'], ['progress', 'In progress', 'approved,sent,failed'], ['done', 'Done', 'done,resolved'], ['declined', 'Declined', 'declined'], ['all', 'All', '']];
const inboxHash = (cid, sub) => `#/inbox${sub ? `/${sub}` : ''}${cid ? `/${encodeURIComponent(cid)}` : ''}`;
const hourText = (h) => `${String(h).padStart(2, '0')}:00 UTC`;

function execLine(a) {
  const ex = a.execution;
  if (ex.kind === 'api') {
    if (ex.sync) return `<b>Runs now:</b> ${esc(ex.actionLabel)} through ${esc(ex.via)}.`;
    return `<b>Runs through the ${esc(ex.via)} API</b> (${esc(ex.apiSet)}): ${esc(ex.actionLabel)}${ex.target === 'room' ? ' (whole room)' : ''}.${ex.mode !== 'live' ? ' <span class="pill mock" style="padding:1px 7px">Demo connection: simulated</span>' : ''}`;
  }
  if (ex.kind === 'dispatch') return `<b>Field dispatch:</b> emails step-by-step ${ex.runbook === 'inspect' ? 'inspection' : 'power-cycle'} instructions to the local contact at ${esc(a.site)}.${ex.switchedFrom ? ` <span class="muted">(Switched from ${esc(ex.switchedFrom)}.)</span>` : ''}`;
  if (ex.kind === 'task') return `<b>Email request</b> to the customer's ${ex.recipientRole === 'engineer' ? 'engineer or service desk' : 'renewals contact'}, with the device list.`;
  return `<b>You fix it:</b> ${esc(ex.linkLabel || 'configuration change')}.`;
}

function yesLabel(a) {
  const ex = a.execution;
  if (ex.kind === 'api') return `Yes, ${ex.actionLabel.charAt(0).toLowerCase()}${ex.actionLabel.slice(1)}`;
  if (ex.kind === 'dispatch') return 'Yes, send to site';
  if (ex.kind === 'task') return 'Yes, send request';
  return 'Yes, I\'ll fix it';
}

function actionCard(a, showCustomer) {
  const decidable = a.status === 'proposed' || a.status === 'failed';
  const btns = [];
  if (S.inbox?.canDecide) {
    if (decidable) btns.push(`<button class="btn btn-primary btn-sm" data-yes="${esc(a.id)}">${esc(yesLabel(a))}</button>`);
    if (a.status === 'failed' && a.execution.kind === 'api' && ['offline', 'faulty'].includes(a.rule)) btns.push(`<button class="btn btn-outline btn-sm" data-todispatch="${esc(a.id)}">Send to site instead</button>`);
    if (a.status === 'approved' && ['dispatch', 'task'].includes(a.execution.kind)) btns.push(`<button class="btn btn-primary btn-sm" data-yes="${esc(a.id)}">Email again</button>`, `<button class="btn btn-outline btn-sm" data-sent="${esc(a.id)}">Mark as sent</button>`);
    if (['approved', 'sent', 'failed'].includes(a.status)) btns.push(`<button class="btn btn-outline btn-sm" data-done="${esc(a.id)}">Mark done</button>`);
    if (['proposed', 'failed', 'approved'].includes(a.status)) btns.push(`<button class="btn btn-danger btn-sm" data-no="${esc(a.id)}">No</button>`);
  }
  btns.push(`<button class="linkbtn" data-open="${esc(a.id)}">Details</button>`);
  return `<div class="act-card sev-${esc(a.severity)}">
    <div class="act-meta"><span class="sev ${esc(a.severity)}">${SEV_LABEL[a.severity]}</span><span class="pill">${esc(a.ruleLabel)}</span>
      ${showCustomer ? `<span class="pill blue">${esc(a.customerName)}</span>` : ''}<span class="muted mono">${esc(a.ref)}</span>
      <span class="act-st st-${esc(a.status)}">${ACT_STATUS[a.status] || esc(a.status)}</span></div>
    <h3>${esc(a.title)}</h3>
    <p>${esc(a.reason)}</p>
    <div class="act-exec">${execLine(a)}</div>
    <div class="act-foot"><span class="muted">${a.total > 1 ? `${a.count} of ${a.total} still affected · ` : ''}Proposed ${ago(a.createdAt)}${a.status !== 'proposed' ? ` · ${esc(ACT_STATUS[a.status])} ${ago(a.updatedAt)}${a.decidedBy ? ` by ${esc(a.decidedBy)}` : ''}` : ''}${a.status === 'declined' && a.snoozeUntil ? ` · quiet until ${fmtDate(a.snoozeUntil)}` : ''}</span>
      <div class="act-btns">${btns.join('')}</div></div>
  </div>`;
}

async function viewInbox(args = []) {
  if (args[0] === 'contacts') return viewContacts(acting() || args[1] || S.inboxCustomer || S.customers[0]?.id);
  const cid = acting() || args[0] || '';
  S.inboxCustomer = cid || S.inboxCustomer;
  const tab = S.inboxTab || 'proposed';
  const statuses = INBOX_TABS.find((t) => t[0] === tab)?.[2] || '';
  const q = new URLSearchParams({ ...(cid ? { customer: cid } : {}), ...(statuses ? { status: statuses } : {}) });
  const [data, summary] = await Promise.all([api(`/api/actions?${q}`), api('/api/actions/summary')]);
  S.inbox = data;
  updateInboxBadge(summary);
  const c = data.checks;
  const mine = cid ? c.byCustomer?.[cid] : null;
  const custOpts = Object.entries(summary);
  hero('Action inbox', `Proposed actions from the daily estate check. Yes carries out the action (through the vendor API where it can, otherwise by emailing on-site steps to the local contact). No keeps the issue quiet for a while. Every decision is in the audit log.`);
  const counts = data.counts;
  const tabCount = (st) => (st ? st.split(',').reduce((s, k) => s + (counts[k] || 0), 0) : Object.values(counts).reduce((s, n) => s + n, 0));
  $('#view').innerHTML = `
    <div class="card inbox-head">
      <div class="inbox-row">
        ${acting() ? `<div><b>${esc(S.me.actingCustomerName)}</b></div>` : `<select id="ibCust" aria-label="Customer"><option value="">All customers (${custOpts.reduce((s, [, x]) => s + x.proposed, 0)} to decide)</option>${custOpts.map(([id, x]) => `<option value="${esc(id)}" ${id === cid ? 'selected' : ''}>${esc(x.name)} (${x.proposed} to decide)</option>`).join('')}</select>`}
        <div class="inbox-sched muted">${c.enabled ? `Checks run daily at <b>${hourText(c.hourUtc)}</b>${c.nextRunAt ? `, next ${inTime(c.nextRunAt)}` : ''}` : '<b>Daily checks are off</b>'}${mine ? ` · last checked ${ago(mine.at)}${mine.by ? ` by ${esc(mine.by)}` : ''}` : c.lastRunAt ? ` · last run ${ago(c.lastRunAt)}` : ''}
          ${data.canSchedule ? ' · <button class="linkbtn" id="ibSched">Change</button>' : ''}</div>
        <div class="inbox-tools"><a class="btn btn-outline btn-sm" href="${inboxHash(cid || custOpts[0]?.[0], 'contacts')}">Site contacts</a>${S.inbox.canRun ? '<button class="btn btn-grad btn-sm" id="ibRun">Run checks now</button>' : ''}</div>
      </div>
      ${data.mail.configured ? '' : `<div class="notice info" style="margin:12px 0 0">Email sending isn't set up (${esc(data.mail.reason)}). Dispatches open in your own email app instead, with a copy button, and you mark them as sent. See Help › Documentation › Action inbox.</div>`}
      <div id="ibMsg"></div>
    </div>
    <div class="seg inbox-tabs" id="ibTabs">${INBOX_TABS.map(([k, l, st]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l} <span class="muted">${tabCount(st)}</span></button>`).join('')}</div>
    <div class="act-list">${data.items.map((a) => actionCard(a, !cid)).join('') || `<div class="card empty">${tab === 'proposed' ? 'Nothing to decide. The next check runs at the scheduled time, or press Run checks now.' : 'Nothing here.'}</div>`}</div>
    ${data.total > data.items.length ? `<div class="muted" style="padding:10px">Showing ${data.items.length} of ${data.total}.</div>` : ''}`;
  $('#ibCust')?.addEventListener('change', (e) => { location.hash = inboxHash(e.target.value); });
  document.querySelectorAll('#ibTabs button').forEach((b) => b.addEventListener('click', () => { S.inboxTab = b.dataset.t; viewInbox(args); }));
  $('#ibRun')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Checking…';
    try {
      const r = await api('/api/checks/run', { method: 'POST', body: cid ? { customerId: cid } : {} });
      toast(ICONS.resolved, `Checks done: ${r.created} new, ${r.updated} updated, ${r.closed} closed`);
      viewInbox(args);
    } catch (err) { $('#ibMsg').innerHTML = `<div class="notice err">${esc(err.message)}</div>`; e.target.disabled = false; e.target.textContent = 'Run checks now'; }
  });
  $('#ibSched')?.addEventListener('click', () => openCheckSchedule(c, args));
  const byId = (id) => data.items.find((a) => a.id === id);
  document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openAction(b.dataset.open, args)));
  document.querySelectorAll('[data-no]').forEach((b) => b.addEventListener('click', () => openDecline(byId(b.dataset.no), args)));
  document.querySelectorAll('[data-yes]').forEach((b) => b.addEventListener('click', () => approveAction(byId(b.dataset.yes), b, args)));
  document.querySelectorAll('[data-todispatch]').forEach((b) => b.addEventListener('click', async () => {
    try { const r = await api(`/api/actions/${b.dataset.todispatch}/approve`, { method: 'POST', body: { via: 'dispatch' } }); openDispatch(r.action, args); } catch (e) { toast(ICONS.critical, e.message); }
  }));
  document.querySelectorAll('[data-sent]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/actions/${b.dataset.sent}/sent`, { method: 'POST', body: {} }); toast(ICONS.resolved, 'Marked as sent'); viewInbox(args); } catch (e) { toast(ICONS.critical, e.message); }
  }));
  document.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/actions/${b.dataset.done}/done`, { method: 'POST', body: {} }); toast(ICONS.resolved, 'Marked done'); viewInbox(args); } catch (e) { toast(ICONS.critical, e.message); }
  }));
}

async function approveAction(a, btn, args) {
  if (!a) return;
  const ex = a.execution;
  if (ex.kind === 'dispatch' || ex.kind === 'task') return openDispatch(a, args);
  if (ex.kind === 'api' && !btn.dataset.armed) {
    btn.dataset.armed = 1; btn.dataset.label = btn.textContent;
    btn.textContent = `${ex.sync ? 'Retry the sync' : `${ex.actionLabel} on ${a.count} device${a.count === 1 ? '' : 's'}`}? Click to confirm`;
    btn.classList.add('btn-danger');
    setTimeout(() => { if (btn.isConnected && btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; btn.classList.remove('btn-danger'); } }, 6000);
    return;
  }
  btn.disabled = true; btn.textContent = ex.kind === 'api' ? 'Running…' : 'Saving…';
  try {
    const r = await api(`/api/actions/${a.id}/approve`, { method: 'POST', body: {} });
    if (ex.kind === 'config') { toast(ICONS.resolved, 'Accepted. Opening the page to fix it.'); location.hash = r.link; return; }
    const st = r.action.status;
    toast(st === 'done' ? ICONS.resolved : ICONS.critical, st === 'done' ? `${a.ref}: done` : `${a.ref}: some devices failed. See Details.`);
    viewInbox(args);
  } catch (e) { toast(ICONS.critical, e.message); viewInbox(args); }
}

async function openDispatch(a, args) {
  let d;
  try { d = await api(`/api/actions/${a.id}/draft`); } catch (e) { toast(ICONS.critical, e.message); return; }
  const rc = d.recipient || {};
  const w = drawer(a.execution.kind === 'dispatch' ? 'Send on-site steps' : 'Send request', `${esc(a.ref)} · ${esc(a.title)}`, `
    ${rc.missing ? `<div class="notice err">${esc(rc.missing)} <a href="${inboxHash(a.customerId, 'contacts')}">Site contacts</a></div>` : rc.source ? `<div class="notice info">Going to the ${esc(rc.source)}${rc.to?.name ? `, ${esc(rc.to.name)}` : ''}${rc.to?.phone ? ` (${esc(rc.to.phone)})` : ''}.</div>` : ''}
    ${d.mail.configured ? '' : `<div class="notice info">Email sending isn't set up on this server, so this opens in your own email app. Send it from there, then press Mark as sent.</div>`}
    <div class="field"><label for="dsTo">To</label><input id="dsTo" type="email" value="${esc(rc.to?.email || '')}" placeholder="name@company.com"></div>
    <div class="field"><label for="dsCc">Cc</label><input id="dsCc" value="${esc((rc.cc || []).map((x) => x.email).join(', '))}" placeholder="Optional, comma separated"></div>
    <div class="field"><label for="dsSubj">Subject</label><input id="dsSubj" value="${esc(d.subject)}"></div>
    <div class="field"><label for="dsBody">Message</label><textarea id="dsBody" style="min-height:340px">${esc(d.body)}</textarea><div class="help">The steps are generated for each device's type. Edit anything before sending.</div></div>
    <div id="dsMsg"></div>`,
  `<button class="btn btn-outline" id="dsCopy">Copy text</button>${d.mail.configured ? '<button class="btn btn-outline" id="dsOwn">Use my email app</button><button class="btn btn-primary" id="dsSend">Approve and send</button>' : '<button class="btn btn-primary" id="dsOwn">Approve and open email</button>'}`);
  const body = (send) => ({ to: $('#dsTo', w).value.trim(), cc: $('#dsCc', w).value, subject: $('#dsSubj', w).value, body: $('#dsBody', w).value, send });
  $('#dsCopy', w).addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(`To: ${$('#dsTo', w).value}\nSubject: ${$('#dsSubj', w).value}\n\n${$('#dsBody', w).value}`); toast(ICONS.resolved, 'Copied'); } catch { $('#dsBody', w).select(); }
  });
  const go = async (send, btn) => {
    btn.disabled = true;
    try {
      const r = await api(`/api/actions/${a.id}/approve`, { method: 'POST', body: body(send) });
      if (r.sent) { toast(ICONS.resolved, `Emailed to ${$('#dsTo', w).value}`); closeDrawer(); viewInbox(args); return; }
      window.location.href = r.mailto;
      $('#dsMsg', w).innerHTML = `<div class="notice ok">Approved. Your email app should open with the message${r.text.length > 1800 ? ' (shortened: paste the full text with Copy text)' : ''}. When you've sent it, press Mark as sent.</div>`;
      w.querySelector('.drawer-foot').innerHTML = '<button class="btn btn-outline" id="dsCopy2">Copy text</button><button class="btn btn-primary" id="dsMark">Mark as sent</button>';
      $('#dsCopy2', w).addEventListener('click', () => navigator.clipboard.writeText(r.text).then(() => toast(ICONS.resolved, 'Copied')).catch(() => {}));
      $('#dsMark', w).addEventListener('click', async () => { try { await api(`/api/actions/${a.id}/sent`, { method: 'POST', body: {} }); toast(ICONS.resolved, 'Marked as sent'); closeDrawer(); viewInbox(args); } catch (e) { $('#dsMsg', w).innerHTML = `<div class="notice err">${esc(e.message)}</div>`; } });
    } catch (e) { $('#dsMsg', w).innerHTML = `<div class="notice err">${esc(e.message)}</div>`; btn.disabled = false; }
  };
  $('#dsSend', w)?.addEventListener('click', (e) => go(true, e.target));
  $('#dsOwn', w).addEventListener('click', (e) => go(false, e.target));
}

function openDecline(a, args) {
  if (!a) return;
  let days = 30;
  const w = drawer('Decline this action', `${esc(a.ref)} · ${esc(a.title)}`, `
    <p class="muted" style="margin-top:0">The same issue on the same devices won't be proposed again until the quiet period ends. New devices with the same problem are still proposed.</p>
    <div class="field"><label>Don't propose again for</label><div class="seg" id="dcDays">${[7, 30, 90, 365].map((n) => `<button data-d="${n}" class="${n === days ? 'on' : ''}">${n === 365 ? '1 year' : `${n} days`}</button>`).join('')}</div></div>
    <div class="field"><label for="dcWhy">Reason (optional, goes in the audit log)</label><textarea id="dcWhy" style="min-height:70px;font-family:inherit;font-size:13px" placeholder="e.g. Room is being refurbished"></textarea></div><div id="dcMsg"></div>`,
  '<button class="btn btn-outline" data-closedrawer>Cancel</button><button class="btn btn-danger" id="dcGo">Decline</button>');
  w.querySelectorAll('#dcDays button').forEach((b) => b.addEventListener('click', () => { days = Number(b.dataset.d); w.querySelectorAll('#dcDays button').forEach((x) => x.classList.toggle('on', x === b)); }));
  $('#dcGo', w).addEventListener('click', async () => {
    try { await api(`/api/actions/${a.id}/decline`, { method: 'POST', body: { snoozeDays: days, reason: $('#dcWhy', w).value } }); toast(ICONS.resolved, 'Declined'); closeDrawer(); viewInbox(args); } catch (e) { $('#dcMsg', w).innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
  });
}

async function openAction(id) {
  const a = await api(`/api/actions/${id}`);
  const isDev = (i) => !!i.deviceId;
  const rows = a.items.map((i) => {
    if (i.connectionId) return `<tr><td><b>${esc(i.connectionName)}</b><div class="muted">${esc(i.oemName)}</div></td><td colspan="2">${esc(i.error || `Last success ${i.lastSuccessAt ? fmtDateTime(i.lastSuccessAt) : 'never'}`)}</td><td>${i.cleared ? '<span class="st healthy">Cleared</span>' : '<span class="st critical">Open</span>'}</td></tr>`;
    if (!isDev(i)) return `<tr><td colspan="3"><b>${esc(i.room ? `${i.room}, ${i.site}` : i.site)}</b>${i.devices ? ` <span class="muted">${i.devices} devices</span>` : ''}</td><td>${i.cleared ? '<span class="st healthy">Fixed</span>' : '<span class="st warning">Open</span>'}</td></tr>`;
    const detail = a.rule === 'firmware' ? `<span class="mono">${esc(i.firmware)}</span> → <span class="mono">${esc(i.target)}</span>`
      : a.rule === 'warranty' ? `Warranty ${esc(i.warrantyExpires || '—')}` : a.rule === 'lifecycle' ? esc(i.lifecycle?.label || '')
        : a.rule === 'recurring' ? `${i.incidents} incidents in 7 days${i.simulated ? ' <span class="muted">(simulated history)</span>' : ''}` : esc(i.healthReason || i.health);
    return `<tr><td><a href="#" data-dev="${esc(i.deviceId)}"><b>${esc(shortModel(i.make, i.model))}</b></a><div class="muted">${esc(i.deviceType)}${i.serial ? ` · ${esc(i.serial)}` : ''}</div></td><td>${esc(i.room)}<div class="muted">${esc(i.site)}</div></td><td>${detail}${i.repeat ? `<div class="muted">Tried before in ${esc(i.repeat)}</div>` : ''}</td><td>${i.cleared ? '<span class="st healthy">Cleared</span>' : status(i.health && HLABEL[i.health] ? i.health : 'warning')}</td></tr>`;
  }).join('');
  const w = drawer(a.title, `${esc(a.ref)} · ${esc(a.customerName)} · ${esc(ACT_STATUS[a.status])}`, `
    <p style="margin-top:0">${esc(a.reason)}</p>
    <div class="act-exec" style="margin-bottom:14px">${execLine(a)}</div>
    ${a.result?.results?.length ? `<h3 class="dr-h">Result</h3><ul class="act-results">${a.result.results.map((r) => `<li class="${r.ok ? 'ok' : 'bad'}"><b>${esc(r.label)}</b>: ${esc(r.message)}</li>`).join('')}</ul>` : ''}
    ${a.dispatch ? `<h3 class="dr-h">Email</h3><dl class="kv"><dt>To</dt><dd>${esc(a.dispatch.to)}${a.dispatch.cc?.length ? ` (cc ${esc(a.dispatch.cc.join(', '))})` : ''}</dd><dt>Subject</dt><dd>${esc(a.dispatch.subject)}</dd><dt>Sent</dt><dd>${a.dispatch.sentAt ? `${fmtDateTime(a.dispatch.sentAt)} via ${esc(a.dispatch.via)}` : 'Not yet'}</dd></dl>` : ''}
    <h3 class="dr-h">Affected (${a.items.length})</h3>
    <div class="table-wrap flat"><table><thead><tr><th>${a.items.some(isDev) ? 'Device' : 'Item'}</th><th>${a.items.some(isDev) ? 'Room' : ''}</th><th>Detail</th><th>Now</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${a.moreItems ? `<div class="muted">…and ${a.moreItems} more</div>` : ''}
    <h3 class="dr-h">History</h3>
    <ul class="act-history">${a.history.map((h) => `<li><span class="muted">${fmtDateTime(h.at)}</span> <b>${esc(ACT_STATUS[h.status] || h.status)}</b>${h.by ? ` by ${esc(h.by)}` : ''}${h.note ? `: ${esc(h.note)}` : ''}</li>`).join('')}</ul>`);
  w.querySelectorAll('[data-dev]').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); openDevice(el.dataset.dev); }));
}

function openCheckSchedule(c, args) {
  const w = drawer('Daily checks', 'Applies to every customer', `
    <div class="field"><label><input type="checkbox" id="csOn" ${c.enabled ? 'checked' : ''}> Run the checks every day</label></div>
    <div class="field"><label for="csHour">Time (UTC)</label><select id="csHour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === c.hourUtc ? 'selected' : ''}>${hourText(h)} (${new Date(Date.UTC(2026, 0, 1, h)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} your time)</option>`).join('')}</select>
      <div class="help">Admins can also run the checks at any time with Run checks now.</div></div><div id="csMsg"></div>`,
  '<button class="btn btn-outline" data-closedrawer>Cancel</button><button class="btn btn-primary" id="csSave">Save</button>');
  $('#csSave', w).addEventListener('click', async () => {
    try { await api('/api/admin/checks', { method: 'PUT', body: { enabled: $('#csOn', w).checked, hourUtc: Number($('#csHour', w).value) } }); toast(ICONS.resolved, 'Schedule saved'); closeDrawer(); viewInbox(args); } catch (e) { $('#csMsg', w).innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
  });
}

async function viewContacts(cid) {
  if (!cid) { $('#view').innerHTML = '<div class="card empty">No customers yet.</div>'; return; }
  const d = await api(`/api/contacts/${encodeURIComponent(cid)}`);
  const ct = d.contacts;
  const ro = d.canEdit ? '' : 'disabled';
  const row = (attrs, label, sub, c = {}) => `<tr ${attrs}><td><b>${esc(label)}</b>${sub ? `<div class="muted">${esc(sub)}</div>` : ''}</td>
    <td><input data-f="name" value="${esc(c?.name || '')}" placeholder="Name" ${ro}></td><td><input data-f="email" type="email" value="${esc(c?.email || '')}" placeholder="name@company.com" ${ro}></td>
    <td><input data-f="phone" value="${esc(c?.phone || '')}" placeholder="Phone" ${ro}></td><td>${d.canEdit ? '<button class="btn btn-outline btn-sm" data-save>Save</button>' : ''}</td></tr>`;
  const roomRows = Object.entries(ct.rooms || {}).map(([k, c]) => { const [site, room] = k.split('|'); return row(`data-scope="room" data-site="${esc(site)}" data-room="${esc(room)}"`, room, site, c); }).join('');
  hero('Site contacts', `Who receives on-site steps (field dispatches) and requests for ${esc(d.customerName)}.`, `<a href="${inboxHash(cid)}">Action inbox</a>`);
  $('#view').innerHTML = `
    ${acting() ? '' : `<div class="card" style="margin-bottom:14px"><select id="ctCust" aria-label="Customer">${S.customers.map((c) => `<option value="${esc(c.id)}" ${c.id === cid ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>`}
    <div class="card" style="margin-bottom:14px"><div class="card-head"><div><h2>Customer contacts</h2><div class="card-sub">Firmware update tasks go to the engineer or service desk. Warranty renewals and replacements go to the renewals contact.</div></div></div>
      <div class="table-wrap"><table class="ct-table"><tbody>${row('data-scope="engineer"', 'Engineer / service desk', 'Firmware updates', ct.engineer)}${row('data-scope="renewals"', 'Renewals', 'Warranty and replacements', ct.renewals)}</tbody></table></div></div>
    <div class="card" style="margin-bottom:14px"><div class="card-head"><div><h2>Site contacts (SPOC)</h2><div class="card-sub">The local person who gets step-by-step instructions when a device needs someone on site.</div></div></div>
      <div class="table-wrap"><table class="ct-table"><thead><tr><th>Site</th><th>Name</th><th>Email</th><th>Phone</th><th></th></tr></thead><tbody>${d.sites.map((s) => row(`data-scope="site" data-site="${esc(s)}"`, s, '', ct.sites?.[s])).join('') || '<tr><td colspan="5" class="muted">No sites yet</td></tr>'}</tbody></table></div></div>
    <div class="card"><div class="card-head"><div><h2>Room contacts</h2><div class="card-sub">Optional. A room contact gets dispatches for that room, with the site contact in copy.</div></div></div>
      <div class="table-wrap"><table class="ct-table"><tbody id="ctRooms">${roomRows || '<tr class="ct-none"><td colspan="5" class="muted">No room contacts</td></tr>'}</tbody></table></div>
      ${d.canEdit && d.rooms.length ? `<div class="inbox-row" style="margin-top:12px"><select id="ctRoomPick" aria-label="Room">${d.rooms.map((r) => `<option value="${esc(`${r.site}|${r.room}`)}">${esc(r.room)} · ${esc(r.site)}</option>`).join('')}</select><button class="btn btn-outline btn-sm" id="ctAddRoom">Add room contact</button></div>` : ''}
      <div id="ctMsg"></div></div>`;
  $('#ctCust')?.addEventListener('change', (e) => { location.hash = inboxHash(e.target.value, 'contacts'); });
  const bind = (tr) => tr.querySelector('[data-save]')?.addEventListener('click', async () => {
    const v = (f) => tr.querySelector(`[data-f=${f}]`).value.trim();
    const contact = v('name') || v('email') || v('phone') ? { name: v('name'), email: v('email'), phone: v('phone') } : null;
    try { await api(`/api/contacts/${encodeURIComponent(cid)}`, { method: 'PUT', body: { scope: tr.dataset.scope, site: tr.dataset.site, room: tr.dataset.room, contact } }); toast(ICONS.resolved, contact ? 'Contact saved' : 'Contact removed'); } catch (e) { $('#ctMsg').innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
  });
  document.querySelectorAll('.ct-table tr[data-scope]').forEach(bind);
  $('#ctAddRoom')?.addEventListener('click', () => {
    const [site, room] = $('#ctRoomPick').value.split('|');
    if (document.querySelector(`#ctRooms tr[data-site="${CSS.escape(site)}"][data-room="${CSS.escape(room)}"]`)) return;
    $('#ctRooms .ct-none')?.remove();
    const tmp = document.createElement('tbody');
    tmp.innerHTML = row(`data-scope="room" data-site="${esc(site)}" data-room="${esc(room)}"`, room, site, {});
    const tr = tmp.firstElementChild;
    $('#ctRooms').appendChild(tr); bind(tr); tr.querySelector('[data-f=name]').focus();
  });
}

/** Proposed actions waiting for a decision, on the Action inbox nav item. */
function updateInboxBadge(summary) {
  const el = $('#inboxBadge');
  if (!el) return;
  const apply = (s) => { const n = Object.values(s || {}).reduce((t, x) => t + x.proposed, 0); el.hidden = !n; el.textContent = n > 99 ? '99+' : n; el.title = `${n} actions to decide`; };
  if (summary) apply(summary); else api('/api/actions/summary').then(apply).catch(() => {});
}

// ------------------------------------------------------------------ open device UI
function deviceUiHTML(d) {
  if (!can('devices.webui') || d.manualId && !d.webUi && !d.ip) return '';
  const ui = d.webUi;
  if (!ui) return `<div class="section-title">Device web interface</div><div class="muted" style="font-size:12.5px">No IP address is reported for this device.${can('estate.edit') ? ' Set a device UI address under Edit this device.' : ''}</div>`;
  return `<div class="section-title">Device web interface</div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><a class="btn btn-primary btn-sm" id="openUi" href="${esc(ui.url)}" target="_blank" rel="noopener noreferrer">Open device UI</a><span class="mono muted" style="font-size:12px">${esc(ui.url)}</span>${ui.source === 'manual' ? '<span class="chip mute">set by hand</span>' : ''}</div>
    <div class="help">Opens the device's own admin page in a new tab. It works only from a computer on the same network as the device (or over VPN), and you sign in with the device's own admin password. Your browser may warn about the device's self-signed certificate.</div>`;
}
