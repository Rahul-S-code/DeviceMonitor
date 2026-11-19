// Documentation tab: how to use Estate Monitor and how to set up each connector.
// The connector chapters are built from the connectors' own metadata
// (/api/connectors), so the setup steps, fields, endpoints and actions shown
// here are the ones the app actually uses.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const list = (items, tag = 'ul') => `<${tag}>${items.map((x) => `<li>${x}</li>`).join('')}</${tag}>`;
const table = (head, rows) => `<div class="table-wrap flat"><table class="doc-tbl"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const link = (route, text) => `<a href="#/${route}">${text}</a>`;
const note = (text, kind = '') => `<div class="doc-note ${kind}">${text}</div>`;

export const BULK_COLUMNS_DOC = [
  ['customer', 'No', 'Customer name or ID. Leave empty to use the customer picked in the import panel.'],
  ['site', 'Yes', 'Site name, e.g. London HQ. A new name creates the site.'],
  ['room', 'Yes', 'Room name, e.g. Atlas 4.01.'],
  ['make', 'Yes', 'Manufacturer exactly as in the model master, e.g. Poly.'],
  ['model', 'Yes', 'Model exactly as in the model master, e.g. Poly Studio X50.'],
  ['device_type', 'No', 'Only used for models not in the master (allowed with the "Allow unlisted models" box).'],
  ['serial', 'No', 'Serial number. Must be unique per customer. Used to merge with an API record later.'],
  ['mac', 'No', 'MAC address, 12 hex digits in any format (00:e0:db:12:34:56).'],
  ['firmware', 'No', 'Firmware version, compared with the model\'s approved baseline.'],
  ['platform', 'No', 'Microsoft Teams, Zoom, Cisco Webex or Google Meet.'],
  ['asset_tag', 'No', 'Your asset number.'],
  ['warranty_end', 'No', 'Warranty end date as YYYY-MM-DD.'],
  ['warranty_type', 'No', 'Warranty plan, e.g. Standard, Poly+ or Select.'],
  ['notes', 'No', 'Free text, up to 500 characters.'],
];

function connectorChapter(c) {
  const g = c.guide || {};
  const live = c.liveSupported !== false;
  const kind = c.kind === 'platform' ? 'Meeting-platform portal' : c.oem === 'domotz' ? 'Network monitor' : 'Manufacturer (OEM) cloud';
  return `<section class="doc-conn" id="doc-conn-${esc(c.oem)}">
    <h3><span class="oem-logo oem-${esc(c.oem)}">${esc(c.short || '')}</span>${esc(c.displayName)}<span class="pill ${live ? 'live' : 'mock'}">${live ? 'Live API' : 'Demo data only'}</span></h3>
    <p>${esc(g.summary || '')} <span class="muted">${esc(kind)}.</span></p>
    ${!live && c.liveNote ? note(esc(c.liveNote), 'warn') : ''}
    <div class="doc-grid">
      <div><h4>What you need</h4>${list((g.needs || []).map(esc))}</div>
      <div><h4>How health is worked out</h4><p>${esc(g.health || '')}</p><h4>Where devices are placed</h4><p>${esc(g.location || '')}</p></div>
    </div>
    <h4>Set it up</h4>${list((c.setupSteps || []).map(esc), 'ol')}
    ${live ? `<p>Then go to ${link('connections', 'Connections')}, press <b>Add connection</b> (or <b>Configure</b> on the customer's demo connection), choose <b>${esc(c.displayName)}</b>, pick <b>Live API</b> and fill in:</p>
    ${table(['Field', 'Kind', 'Required', 'Notes'], [
      ...(c.settingFields || []).map((f) => [esc(f.label), 'Setting (stored as plain text)', f.required ? 'Yes' : 'No', esc([f.help, f.default ? `Default: ${f.default}` : ''].filter(Boolean).join('. '))]),
      ...(c.credentialFields || []).map((f) => [esc(f.label), 'Secret (encrypted, never shown again)', f.required ? 'Yes' : 'No', esc(f.help || '')]),
    ])}` : ''}
    <h4>API calls</h4>
    ${table(['Call', 'Method and URL', 'Used for', 'Auth'], (c.apis || []).map((a) => [esc(a.name), a.url ? `<span class="mono">${esc(a.method || '')} ${esc(a.url)}</span>` : '<span class="muted">None</span>', esc(a.purpose), esc(a.auth || '')]))}
    <h4>Remote actions</h4>
    ${c.actions?.length ? table(['Action', 'API set', 'Endpoint', 'Permission'], c.actions.map((a) => [`<b>${esc(a.label)}</b><div class="muted">${esc(a.description)}</div>`, esc(a.api.set), `<span class="mono">${esc(a.api.method)} ${esc(a.api.endpoint)}</span>`, esc(a.scope)])) : `<p class="muted">${esc(c.actionsNote || 'None.')}</p>`}
    ${c.docsUrl ? `<p class="muted">Vendor reference: <a href="${esc(c.docsUrl)}" target="_blank" rel="noopener noreferrer">${esc(c.docsUrl)}</a></p>` : ''}
  </section>`;
}

/** Sections of the Documentation page: [{ id, title, html }]. */
export function docSections({ connectors = [], role = 'customer_viewer', status = (h) => h } = {}) {
  const admin = role !== 'customer_viewer';
  const oems = connectors.filter((c) => c.kind !== 'platform');
  const platforms = connectors.filter((c) => c.kind === 'platform');
  return [
    {
      id: 'start', title: 'Getting started',
      html: `<p>Estate Monitor shows the health of every meeting-room and AV device across your customers' estates in one place. It reads each manufacturer's cloud (Poly Lens, Logitech Sync, Yealink, Neat, Crestron, Q-SYS and more), the meeting-platform portals (Zoom, Cisco Control Hub) and network monitors (Domotz), merges the same device reported by several sources into one record, and turns their states into one health scale with error codes, likely causes and what to check.</p>
      <h4>Who can do what</h4>
      ${table(['Role', 'Sees', 'Can change'], [
        ['<b>Super admin</b>', 'Every customer', 'Everything a provider admin can, plus onboarding and deleting customers, users, the model master, and running API checks'],
        ['<b>Provider admin</b>', 'Every customer (or one, after <b>Enter customer</b>)', 'Connections and keys, rooms, schematics, adding and editing devices (one at a time or by CSV), remote actions; reads the audit log and API tracker'],
        ['<b>Customer</b>', 'Their own estate only', 'Nothing: read-only views of health, alerts, SLA, lifecycle and error codes'],
      ])}
      <h4>Health colours</h4>
      ${table(['State', 'Meaning'], [
        [status('healthy'), 'Every source reports the device working.'],
        [status('warning'), 'Working, but something needs attention: a missing non-critical peripheral, firmware below baseline, an open vendor alarm.'],
        [status('critical'), 'A fault that stops the room working properly: camera or microphone missing, temperature, a vendor error.'],
        [status('offline'), 'The source has lost contact with the device.'],
        [status('unmonitored'), 'Added by hand (or by CSV) and no API reports it yet. Counts in inventory and lifecycle, not in alerts or SLA.'],
      ])}
      <p>When sources disagree the most severe state wins, so a problem seen by any source is never hidden. A <span class="mock-tag">Mock</span> tag beside a device means every source for it is a demo connection, not a live API.</p>
      ${admin ? `<h4>Enter a customer</h4><p>Pick a customer in the top bar to see the whole app exactly as that customer does. <b>Exit customer</b> takes you back to all customers.</p>` : ''}`,
    },
    {
      id: 'monitor', title: 'Monitoring pages',
      html: `<h4>${link('overview', 'Overview')}</h4><p>Totals by health, with breakdowns by source, platform, customer, device type, manufacturer and site. Click any row to filter the whole app by it.</p>
      <h4>${link('map', 'Map')}</h4><p>Every site on a world map. Zoomed out you see regions; click a site to drill into its rooms and devices. A marker takes the colour of the worst device at that site. The layer button switches the map style.</p>
      <h4>${link('estate', 'Sites and rooms')}</h4><p>Drill from site to room to device. A room page shows its devices, its meeting platform, the room schematic with live health, and its design documents.</p>
      <h4>${link('devices', 'Devices')}</h4><p>Every device in one sortable table. The filter bar (customer, region, site, platform, source, device type, health, firmware and warranty status) and the search box apply to every page. Search matches model, room, serial, MAC, IP, tags and error codes (try <span class="mono">EM-PER-001</span>). Click a device for its panel.</p>
      <h4>${link('alerts', 'Alerts')}</h4><p>Health changes and connector failures as they happen, with the error codes for each. Critical alerts also pop up as a notice. The red number on the Alerts menu item counts devices critical or offline now.</p>`,
    },
    {
      id: 'device', title: 'The device panel',
      html: `<p>Click any device to open its panel.</p>
      ${list([
        '<b>Error codes and likely causes</b>: every red or amber device carries an Estate Monitor code (for example EM-NET-001 Device offline), what it means, the likely causes with the most likely first, what to check, and the vendor\'s own value (such as Webex <span class="mono">cameraNotDetected</span>) so it can be looked up with the vendor.',
        '<b>Cables to check</b>: if the room has a schematic, the device\'s cables and ports are listed, with any marked faulty or suspect.',
        '<b>Sources</b>: each cloud or portal that reports the device and its ID there.',
        admin ? '<b>Edit</b>: move the device to another room, set its platform, tags, notes and warranty. Edits are stored on top of what the source reports, so the next sync keeps them. <b>Reset</b> returns to the source values.' : null,
        admin ? '<b>Remote actions</b>: reboot, restart or standby through the API that reports the device. The panel names the API set (OEM cloud, meeting platform or network monitor), the exact endpoint, and the permission it needs. You confirm with a second click, a device can take one action a minute, and every action is in the audit log. On demo connections nothing is sent.' : null,
      ].filter(Boolean))}`,
    },
    {
      id: 'rooms', title: 'Rooms, schematics and documents',
      html: `<p>Each room page has a <b>Room schematic</b> card.${admin ? ' Admins open the designer to draw how the room is wired:' : ''}</p>
      ${admin ? list([
        'Drag building blocks (video bars, codecs, cameras, displays, DSPs, switchers, HDBaseT extenders, USB hubs, network switches, power) onto the canvas. The room\'s own monitored devices are at the top of the palette and are added already linked to their live health.',
        'Every block has typed ports (HDMI in and out, USB, LAN/PoE, audio, power and so on). Drag from one port to another, or click one then the other, to run a cable. A port takes one cable.',
        'Give each cable a tag, length, condition (tested OK, suspect, faulty) and a note.',
        'Start from a template, import or export JSON, auto-arrange, zoom and undo from the toolbar.',
      ]) : ''}
      <p>Outside the designer the drawing is the troubleshooting view: <b>Room check</b> lists every unhealthy device with the cables and ports it depends on and what it affects downstream. Click an item to trace its signal path. The <b>cable schedule</b> below exports to CSV.</p>
      <p>The <b>Design documents</b> card holds uploaded drawings for the room: PDF, PNG, JPEG, Visio (.vsdx) or AutoCAD (.dwg), up to 10 MB each and 20 per room.</p>
      ${admin ? '<p>Set a room\'s meeting platform on its page when no source reports it (Logitech Sync, for example, has no platform field).</p>' : ''}`,
    },
    ...(admin ? [{
      id: 'adding', title: 'Adding devices by hand or by CSV',
      html: `<p>Kit that no API reports (or that is not connected yet) can still be in the inventory. Manual devices show <b>Not monitored</b>. If a connected API later reports the same serial or MAC, the records merge: live health and location take over and your asset tag, notes and warranty are kept.</p>
      <h4>One device</h4><p>${link('devices', 'Devices')} › <b>+ Add device</b>, or <b>+ Add device</b> on a room page. Pick make and model from the model master, or choose <b>Other</b> and type them.</p>
      <h4>Many devices from a CSV file</h4>
      ${list([
        `${link('devices', 'Devices')} › <b>Bulk add (CSV)</b> › <b>Download the CSV template</b>. It has the columns below, an example row and, at the bottom, every make and model in the model master (lines starting with # are ignored).`,
        'Fill one row per device in Excel or any spreadsheet and save as <b>CSV UTF-8</b>.',
        'Pick the customer (or fill the customer column), choose the file and check the preview. Every row is checked with the same rules as a single add: required fields, the model master, MAC format, dates, and serials already used for that customer or earlier in the file.',
        'Press <b>Import</b>. Valid rows are added and rows with errors are skipped, so you can fix those and import them again. The import is in the audit log.',
      ], 'ol')}
      ${table(['Column', 'Required', 'What to put'], BULK_COLUMNS_DOC.map(([c, r, t]) => [`<span class="mono">${c}</span>`, r, esc(t)]))}
      ${note('Up to 2,000 rows and 2 MB per file. Make and model must match the model master unless you tick <b>Allow models that are not in the model master</b>; those rows are added as Other and tagged Not monitored.')}`,
    }] : []),
    {
      id: 'service', title: 'Service levels, lifecycle and error codes',
      html: `<h4>${link('sla', 'SLA')}</h4><p>Availability over 24 hours, 7 days or 30 days by customer, site, room and device, against each customer's target (default 99.5%). A device is unavailable while it is offline or critical. Health is recorded at every sync and kept for 35 days. Demo devices use a simulated history.</p>
      <h4>${link('lifecycle', 'Lifecycle')}</h4><p>Firmware compliance against each model's approved baseline, the versions in use, warranty status (in warranty, expiring within 90 days, expired, not recorded) and each model's end-of-sale, end-of-support and end-of-life dates from the model master.</p>
      <h4>${link('errors', 'Error codes')}</h4><p>The reference for every Estate Monitor code: what it means, likely causes and checks. Codes are the same whichever vendor reported the fault, so one runbook covers every make.</p>`,
    },
    ...(admin ? [{
      id: 'configure', title: 'Configuration',
      html: `<h4>${link('connections', 'Connections')}</h4>
      <p>A connection links one customer to one source. Each starts on <b>Mock data</b> (built-in demo data in the same format as the real API, no keys needed). To go live: <b>Configure</b>, choose <b>Live API</b>, paste the settings and secrets, press <b>Test connection</b>, then <b>Save</b>. Secrets are encrypted (AES-256-GCM) before they are stored and are never shown again; to change one, paste a new value. <b>Sync now</b> runs a sync straight away; otherwise every connection syncs every 30 seconds by default.</p>
      <h4>${link('models', 'Model master')}</h4><p>The catalogue of make, model and device type, which connectors can monitor each model, the approved firmware baseline, lifecycle dates and known releases. Every firmware version first seen in the fleet is added automatically. Only the super admin edits it.</p>
      ${role === 'super_admin' ? `<h4>${link('customers', 'Customers')}</h4><p><b>Onboard customer</b> creates the customer, its sites (city presets fill in map positions), user logins, connections (on demo data to start) and optionally pre-loaded rooms and schematics. Set each customer's SLA target under Sites and users.</p>` : ''}
      <h4>${link('apis', 'API tracker')}</h4><p>Every external API the app uses, which customers and connections use it, live call counts and errors, and the result of reachability checks (a 401 or 403 counts as up because the service answered). The super admin runs <b>Check all APIs</b>, which also tests each connection with its own credentials. Checks also run every 30 minutes.</p>
      <h4>${link('audit', 'Audit log')}</h4><p>Sign-ins, customer views, device edits and imports, actions, room and schematic changes, onboarding, users, connection changes and tests (never secret values), model master changes and API checks. Filter and export to CSV.</p>`,
    }] : []),
    {
      id: 'connectors', title: 'Connectors',
      html: `<p>Each source is a connector. Manufacturer clouds give the richest health; meeting-platform portals add the meeting platform and room names; Domotz adds anything on the network. When two sources report the same device (same serial or MAC), it is shown once.</p>
      ${table(['Source', 'Type', 'Data', 'Auth', 'Actions'], connectors.map((c) => [
        `<a href="#/docs/conn-${esc(c.oem)}" data-doc="doc-conn-${esc(c.oem)}"><span class="oem-logo oem-${esc(c.oem)} sm">${esc(c.short || '')}</span>${esc(c.displayName)}</a>`,
        c.kind === 'platform' ? 'Platform' : c.oem === 'domotz' ? 'Network' : 'OEM',
        c.liveSupported === false ? '<span class="muted">Demo only</span>' : 'Live',
        esc([...new Set((c.apis || []).map((a) => a.auth).filter(Boolean))][0] || '-'),
        c.actions?.length ? esc(c.actions.map((a) => a.label).join(', ')) : '<span class="muted">None</span>',
      ]))}
      ${note('<b>Cisco Control Hub</b> is the Webex admin portal: Cisco Room, Board and Desk devices are monitored (and restarted) through the <b>Cisco Control Hub (Webex)</b> connector below.')}
      ${note('<b>No public API yet</b> for Biamp Workplace (user sign-in only), ShureCloud (API in private beta) and NETGEAR Insight (no REST API). These run on demo data. Put the real kit in by hand or CSV, and monitor network-attached kit (including NETGEAR AV switches) live through Domotz.', 'warn')}
      <h3 class="doc-h3">Manufacturer and network clouds</h3>${oems.map(connectorChapter).join('')}
      <h3 class="doc-h3">Meeting-platform portals</h3>${platforms.map(connectorChapter).join('')}`,
    },
    {
      id: 'merge', title: 'How sources are combined',
      html: `${list([
        'Within one customer, devices are merged when they share a serial number or MAC address, or when a device with no hardware identity (a USB peripheral reported by a room PC) has the same model in the same room as another device.',
        'The manufacturer\'s own cloud supplies the main record (a Sony display\'s model comes from Sony, not from Domotz). Other sources fill gaps: the meeting platform from Zoom or Control Hub, the room from Domotz.',
        'Health is the most severe state any source reports, and every source\'s error codes are kept.',
        'Edits you make (room, platform, tags) are stored on top and survive every sync.',
        'Firmware older than the model\'s baseline (or the newest version seen in the estate) adds an EM-FW-001 warning for sources with no native health.',
      ])}`,
    },
    ...(admin ? [{
      id: 'hosting', title: 'Hosting and settings',
      html: `<p>The app runs on Render from the GitHub repository; every push to <span class="mono">main</span> redeploys it. On the free plan the service sleeps after 15 minutes without visitors and its disk is temporary, so customers, keys, schematics and uploaded documents reset on each redeploy. For real use, add a persistent disk mounted at <span class="mono">/opt/render/project/src/data</span> (paid plan) or move the store to a database.</p>
      ${table(['Setting', 'What it does'], [
        ['<span class="mono">MASTER_KEY</span>', 'Encrypts API secrets. 64 hex characters. Generated into data/master.key if not set.'],
        ['<span class="mono">SUPERADMIN_PASSWORD</span>, <span class="mono">DEMO_PASSWORD</span>', 'Passwords for the super admin and the demo users.'],
        ['<span class="mono">SHOW_DEMO_ACCOUNTS</span>', 'Shows the demo logins on the sign-in page.'],
        ['<span class="mono">SYNC_INTERVAL_SECONDS</span>', 'Seconds between syncs (default 30).'],
        ['<span class="mono">API_CHECK_MINUTES</span>', 'Minutes between automatic API checks (default 30, 0 turns them off).'],
        ['<span class="mono">MAP_TILE_URL</span>, <span class="mono">MAP_TILE_NAME</span>, <span class="mono">MAP_TILE_ATTRIBUTION</span>', 'Your own map tile server.'],
        ['<span class="mono">DATA_DIR</span>', 'Where the store, history and documents are kept (default ./data).'],
      ])}`,
    }] : []),
    {
      id: 'faq', title: 'Troubleshooting',
      html: `<dl class="doc-faq">
        <dt>A connection shows an error after going live</dt><dd>Open it and press <b>Test connection</b>; the message says what to fix (wrong key, missing permission or scope, wrong region or organisation ID). The ${admin ? link('apis', 'API tracker') : 'API tracker'} shows whether the vendor's service itself is reachable.</dd>
        <dt>A device appears twice</dt><dd>The two sources report different serials and MACs. Edit one and move it, or add the serial to the manual record so they merge.</dd>
        <dt>A device has no site or the wrong room</dt><dd>Fix it in the vendor's portal (site, group, location or Room field), or edit it here; edits survive syncs.</dd>
        <dt>Remote action says permission denied</dt><dd>The read-only scope used for monitoring is not enough. Add the permission listed for the action to the live credentials.</dd>
        <dt>The CSV import rejects every row</dt><dd>Check the header row matches the template, the file is saved as CSV UTF-8, and make and model match the model master exactly (copy them from the bottom of the template).</dd>
        <dt>Everything reset</dt><dd>The free hosting plan has a temporary disk; see Hosting and settings.</dd>
      </dl>`,
    },
  ];
}
