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
export function docSections({ connectors = [], role = 'end_user', perms = null, status = (h) => h } = {}) {
  role = { provider_admin: 'msp_admin', customer_viewer: 'end_user' }[role] || role;
  // Platform and MSP admins see the setup chapters; customer roles see what applies to them.
  const admin = role === 'super_admin' || role === 'msp_admin';
  const RANKS = { super_admin: 0, msp_admin: 1, customer_admin: 2, technical_user: 3, end_user: 4 };
  const has = (k, uptoRole) => (perms ? perms.includes(k) : RANKS[role] <= RANKS[uptoRole]);
  const editor = has('estate.edit', 'customer_admin');
  const designer = has('rooms.design', 'technical_user');
  const actor = has('devices.actions', 'technical_user');
  const inbox = has('inbox.view', 'technical_user');
  const oems = connectors.filter((c) => c.kind !== 'platform');
  const platforms = connectors.filter((c) => c.kind === 'platform');
  return [
    {
      id: 'start', title: 'Getting started',
      html: `<p>Estate Monitor shows the health of every meeting-room and AV device across your customers' estates in one place. It reads each manufacturer's cloud (Poly Lens, Logitech Sync, Yealink, Neat, Crestron, Q-SYS and more), the meeting-platform portals (Zoom, Cisco Control Hub) and network monitors (Domotz), merges the same device reported by several sources into one record, and turns their states into one health scale with error codes, likely causes and what to check.</p>
      <h4>Who can do what</h4>
      <p>There are five levels, each inside the one above. These are the defaults; see ${link('roles', 'Roles and permissions')} for what your organisation has changed.</p>
      ${table(['Role', 'Sees', 'Can change'], [
        ['<b>Super admin</b>', 'The whole platform: every MSP and customer', 'Everything: MSPs and their admins, the model master, the advisory baseline, platform default permissions, API checks and the default sync interval'],
        ['<b>MSP admin</b>', 'The customers of their own MSP (or one, after <b>Enter customer</b>)', 'Onboarding customers, connections and API keys, customer baselines, everything a customer admin can, users below them, permissions for customer roles in their MSP'],
        ['<b>Customer admin</b>', 'Their own organisation', 'Devices, rooms and schematics, sites and site contacts, Action inbox decisions, technical users and end users, permissions for those two roles; reads the audit log'],
        ['<b>Technical user</b>', 'Their own organisation', 'Diagnostics, remote actions (reboot, restart), syncing a connection now, room schematics and drawings, deciding and running Action inbox actions'],
        ['<b>End user</b>', 'Their own organisation, read only', 'Nothing in the estate; they see room and device status and can <b>report an issue</b>'],
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
        editor ? '<b>Edit</b>: move the device to another room, set its platform, tags, notes and warranty. Edits are stored on top of what the source reports, so the next sync keeps them. <b>Reset</b> returns to the source values.' : null,
        has('devices.webui', 'technical_user') ? '<b>Open device UI</b>: opens the device\'s own web interface in a new tab, at <span class="mono">https://&lt;IP the vendor reports&gt;/</span> or at a <b>Device UI address</b> set under Edit (another port, or http). Your browser goes straight to the device, so it only works from a computer on the same network as the device or over VPN, and you sign in with the device\'s own admin password. Each open is recorded in the audit log. Technical users and above by default (permission <b>Open device web UI</b>).' : null,
        actor ? '<b>Remote actions</b>: reboot, restart or standby through the API that reports the device. The panel names the API set (OEM cloud, meeting platform or network monitor), the exact endpoint, and the permission it needs. You confirm with a second click, a device can take one action a minute, and every action is in the audit log. On demo connections nothing is sent.' : null,
      ].filter(Boolean))}`,
    },
    {
      id: 'rooms', title: 'Rooms, schematics and documents',
      html: `<p>Each room page has a <b>Room schematic</b> card.${designer ? ' Open the designer to draw how the room is wired:' : ''}</p>
      ${designer ? list([
        'Drag building blocks (video bars, codecs, cameras, displays, DSPs, switchers, HDBaseT extenders, USB hubs, network switches, power) onto the canvas. The room\'s own monitored devices are at the top of the palette and are added already linked to their live health.',
        'Every block has typed ports (HDMI in and out, USB, LAN/PoE, audio, power and so on). Drag from one port to another, or click one then the other, to run a cable. A port takes one cable.',
        'Give each cable a tag, length, condition (tested OK, suspect, faulty) and a note.',
        'Start from a template, import or export JSON, auto-arrange, zoom and undo from the toolbar.',
      ]) : ''}
      <p>Outside the designer the drawing is the troubleshooting view: <b>Room check</b> lists every unhealthy device with the cables and ports it depends on and what it affects downstream. Click an item to trace its signal path. The <b>cable schedule</b> below exports to CSV.</p>
      <p>The <b>Design documents</b> card holds uploaded drawings for the room: PDF, PNG, JPEG, Visio (.vsdx) or AutoCAD (.dwg), up to 10 MB each and 20 per room.</p>
      ${editor ? '<p>Set a room\'s meeting platform on its page when no source reports it (Logitech Sync, for example, has no platform field).</p>' : ''}`,
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
      <h4>${link('baselines', 'Baselines')}</h4><p>Two tiers. The <b>advisory baseline</b> is our recommendation: the approved firmware per model in the model master, plus a policy for warranty (required or not, how many days' notice) and lifecycle (the stage at which a device fails: end of sale, support or life). The super admin maintains it, and every change is a new version. Each customer then has its <b>own baseline</b>, also versioned: follow the advisory, aim for the highest level (newest known release of every model), or set individual models lower or higher, pin a version or not enforce one. Warranty and lifecycle rules can follow the advisory or be the customer's own. Admins save a change as a new version and can view or restore any earlier one; customers see theirs read-only. Every device is judged against its customer's baseline, and drift from the advisory is shown beside it.</p>
      <h4>${link('lifecycle', 'Lifecycle')}</h4><p>Firmware compliance against each customer's baseline (and how far it drifts from the advisory), the versions in use, warranty status (in warranty, expiring within 90 days, expired, not recorded) and each model's end-of-sale, end-of-support and end-of-life dates from the model master.</p>
      <h4>${link('errors', 'Error codes')}</h4><p>The reference for every Estate Monitor code: what it means, likely causes and checks. Codes are the same whichever vendor reported the fault, so one runbook covers every make.</p>`,
    },
    {
      id: 'roles', title: 'Roles, users and permissions',
      html: `<p>Estate Monitor has five levels of user. Each level sits inside the one above, can add users only at the levels below it and only in its own organisation, and can never give anyone a permission it doesn't hold itself.</p>
      ${table(['Level', 'Who it is for', 'Responsibilities by default'], [
        ['1. <b>Super admin</b>', 'The company that runs the platform', 'Creates MSPs and their admins; maintains the model master and the advisory baseline; sets the platform default permissions and role names; runs API checks; sets the default sync interval and the daily check schedule.'],
        ['2. <b>MSP admin</b>', 'A managed service provider', 'Sees only its own MSP\'s customers. Onboards customers, sets up connectors and API keys, sets each customer\'s baseline, adds customer admins, technical users and end users, and adjusts permissions for those roles across its customers.'],
        ['3. <b>Customer admin</b>', 'The customer\'s IT or workplace lead', 'Runs their own estate: device records, rooms, schematics, sites and site contacts; decides Action inbox actions; adds technical users and end users; adjusts permissions for those two roles; reads their audit log.'],
        ['4. <b>Technical user</b>', 'Engineers and support staff', 'Sees every device with its diagnostics, runs remote actions such as a reboot, syncs a connection now, edits room schematics and drawings, decides and runs Action inbox actions.'],
        ['5. <b>End user</b>', 'People who use the rooms', 'Read-only status of rooms and devices, and <b>Report an issue</b> on a room or device. Reports appear in the alert feed (filter <b>Reported</b>).'],
      ])}
      <h4>${link('roles', 'Roles and permissions')}</h4>
      <p>Everyone can open this page to see each role's responsibilities and the permission matrix that applies to them. Permissions are set in layers: the built-in defaults, then the <b>platform</b> layer (super admin), then each <b>MSP</b> (super admin or that MSP's admin), then each <b>customer</b> (super admin, its MSP admin or its customer admin). Each layer changes only the roles below the editor's own. A highlighted cell differs from what the layer inherits; <b>Reset to inherited</b> clears the layer. A lower role never keeps a permission the role above it has lost. <b>View the estate</b> is always on and <b>Run the platform</b> is always super admin only. The super admin can also rename the roles, for example "Field engineer" for technical user.</p>
      ${admin || has('users.manage', 'customer_admin') ? `<h4>${link('users', 'Users')}</h4>
      <p>Lists the users you look after. <b>Add user</b> offers only the roles below yours and the customers (or, for the super admin, MSPs) in your scope. <b>Manage</b> changes a user's name or role (between customer roles), sets a new password, disables the account (it can't sign in until enabled again) or removes it. You can't change your own account here or anyone at your level.</p>` : ''}
      ${role === 'super_admin' ? `<h4>${link('msps', 'MSPs')}</h4><p>Create an MSP, add its admins and open its permission layer. An MSP can be deleted only when it has no customers; move a customer to another MSP from <b>Customers › Sites &amp; users</b>. Existing installations put every customer and every former provider admin in a <b>Default MSP</b> (rename it here, or set <span class="mono">DEFAULT_MSP_NAME</span> before the first start).</p>` : ''}
      ${has('sites.manage', 'customer_admin') && !admin ? `<h4>${link('sites', 'Sites')}</h4><p>Customer admins keep their own site list and map positions here. Site, room, engineer and renewals contacts are under <b>Site contacts</b> in the Action inbox.</p>` : ''}
      <p>Every sign-in, user change, role change and permission change is recorded in the ${link('audit', 'audit log')}. MSP admins see the entries for their own customers and MSP; customer admins see their own customer's.</p>`,
    },
    ...(inbox ? [{
      id: 'inbox', title: 'Action inbox',
      html: `<p>Every day the ${link('inbox', 'Action inbox')} checks each customer's estate and proposes actions. You answer <b>Yes</b> or <b>No</b>. Pick a customer at the top, or look at all customers at once.</p>
      <h4>What the daily check looks for</h4>
      ${table(['Check', 'Proposed action', 'How Yes is carried out'], [
        ['Device <b>offline</b> for 15 minutes or more', 'Power-cycle', 'Through Domotz (PoE or PDU power-cycle) when it reports the device. An offline device can\'t receive a cloud reboot, so otherwise the steps are emailed to the site contact.'],
        ['Device <b>critical</b> (online, with a fault)', 'Restart', 'Through the vendor API that reports it (Poly Lens, Webex, Zoom Rooms, Neat Pulse, Yealink, Sony BRAVIA, Domotz). Otherwise emailed to the site contact.'],
        ['Device that <b>keeps dropping off</b> (3 or more incidents in 7 days)', 'Inspect on site', 'Emails inspection steps (cables, power, network port, heat) to the site contact.'],
        ['<b>Firmware below the customer\'s baseline</b>, per model', 'Update firmware', 'Emails a task to the customer\'s engineer or service desk, with where to update in each vendor portal (no connected API pushes firmware).'],
        ['<b>Warranty</b> expired or ending within the notice period (when the baseline requires warranty)', 'Renew warranty', 'Emails the device list to the renewals contact.'],
        ['Model past the customer\'s <b>lifecycle limit</b> (end of sale, support or life)', 'Plan replacement', 'Emails the device list to the renewals contact.'],
        ['<b>Connection</b> failing to sync, or not synced for a long time', 'Retry the sync', 'Runs the sync now.'],
        ['Connection <b>rejecting its credentials</b>', 'Renew credentials', 'Opens Connections to enter new ones.'],
        ['Site with <b>no local contact</b>, room with <b>no meeting platform</b>, devices with <b>no warranty date</b>', 'Fix the configuration', 'Opens the page where you fix it.'],
      ])}
      <h4>Yes and No</h4>
      ${list([
        '<b>Yes</b> on an API action asks you to confirm with a second click, then runs it on each affected device (up to 50 per action) and shows the result per device. On demo connections nothing is sent. If it fails for an offline or faulty device, <b>Send to site instead</b> turns it into a field dispatch.',
        '<b>Yes</b> on a dispatch or request opens the email: the site contact (or the engineer or renewals contact) is filled in, and the step-by-step instructions are written for each device\'s type and include the room, serial number, MAC and what the monitoring shows. Edit anything, then send. Devices at one site go in one email.',
        'When email sending is not set up on the server, the page says so: <b>Approve and open email</b> opens your own email app with the message (and <b>Copy text</b> copies it). Press <b>Mark as sent</b> once you have sent it.',
        '<b>No</b> declines the action, with an optional reason. The same issue on the same devices is not proposed again for 7, 30 (default), 90 days or a year. New devices with the same problem are still proposed.',
        '<b>Mark done</b> closes an approved or sent action by hand. A sent dispatch also closes itself as <b>Done</b> when a later check finds every device on it healthy again.',
      ])}
      <h4>Status and duplicates</h4>
      <p>Actions move through <b>To decide</b> (proposed), <b>Approved</b>, <b>Sent</b>, <b>Failed</b>, <b>Done</b>, <b>Declined</b> and <b>Cleared</b> (the issue went away before anyone decided). An issue already in an open action is never proposed again; new devices with the same problem at the same site join the open proposal instead of creating another. A remote fix that didn't hold within 7 days is proposed again as a site dispatch. Each action has a reference (for example EM-1042) that is in the email subject, so replies can be matched. Every decision, email and API call is in the ${link('audit', 'audit log')}. Closed actions are kept for 180 days.</p>
      <h4>Site contacts</h4>
      <p><b>Site contacts</b> on the inbox page holds, per customer: a local contact (SPOC) for each site with name, email and phone; optional room contacts (a room contact gets that room's dispatches, with the site contact in copy); an engineer or service desk contact for firmware tasks; and a renewals contact for warranty and replacements.</p>
      <h4>Schedule</h4>
      <p>The checks run every day at 06:00 UTC by default. The super admin changes the time or switches them off with <b>Change</b> beside the schedule. Anyone who can decide actions can press <b>Run checks now</b> for the customers they look after.</p>
      ${note('By default MSP admins, customer admins and technical users see the Action inbox and decide its actions; end users don\'t. Site contacts are edited by admins. The checks schedule is set by the super admin. An admin who has entered a customer sees and decides only that customer\'s actions.')}`,
    }] : []),
    ...(has('connections.manage', 'msp_admin') ? [{
      id: 'servicenow', title: 'ServiceNow incidents',
      html: `<p>Estate Monitor can raise incidents in ServiceNow for each customer, so faults reach the service desk without anyone retyping them. Each customer has its own settings (its own instance, group and rules) under ${link('servicenow', 'Configure › ServiceNow')}.</p>
      <h4>What raises an incident</h4>
      ${table(['Event', 'Default', 'What happens next'], [
        ['A device <b>offline</b> for longer than the wait (default 10 minutes)', 'On, P2', 'Updated with a work note if it changes (for example critical to offline). Resolved when the device recovers.'],
        ['A device <b>critical</b> for longer than the wait', 'On, P3', 'The same.'],
        ['A device <b>warning</b> (amber) for longer than the wait', 'Off, P4', 'The same.'],
        ['An issue <b>reported by a user</b>', 'On, P3', 'Raised straight away. Resolved in ServiceNow by the service desk.'],
        ['An Action inbox <b>dispatch or task approved</b>', 'On, P3', 'Resolved when the action is marked done, or clears.'],
        ['<b>Raise incident</b> on the device panel', 'Technical users and above', 'Raised straight away, with an optional note.'],
      ])}
      ${list([
        'One fault gets one incident. Estate Monitor tags each incident with a correlation ID, so after a restart it finds the open incident again instead of raising another.',
        'If someone resolves or closes the incident in ServiceNow while the device is still faulty, no new incident is raised until the device recovers and fails again.',
        'Faults that are already open when you switch it on are skipped, unless you tick <b>also raise incidents for faults that are already open</b>.',
        'At most 20 new incidents per customer per minute, so a site outage can\'t flood the queue.',
        'If ServiceNow can\'t be reached, the incident shows <b>Not raised yet</b> with the reason and is retried after 1, 5, 15 and then every 60 minutes. <b>Retry now</b> tries straight away.',
        'Incident numbers show in the alert feed, on the device panel and on Action inbox items. In live mode they link to the incident in ServiceNow.',
      ])}
      <h4>Set up ServiceNow</h4>
      ${list([
        'Use your company instance, or a free Personal Developer Instance from developer.servicenow.com for testing (it sleeps after about 10 days without use; wake it there).',
        'In ServiceNow open <b>User Administration › Users</b> (or go to <span class="mono">/sys_user.do?sys_id=-1</span> on your instance) and create a user such as <span class="mono">estate.monitor</span>. Tick <b>Web service access only</b> (called <b>Internal Integration User</b> on newer releases), save, press <b>Set Password</b>, and on the <b>Roles</b> tab add <b>itil</b>.',
        'Optional: note the assignment group that should get the incidents (for example <b>Service Desk</b>).',
        `In Estate Monitor open ${link('servicenow', 'Configure › ServiceNow')}, pick the customer, choose <b>Live ServiceNow</b>, enter the instance URL (<span class="mono">https://yourcompany.service-now.com</span>), the user name and password, the assignment group and the rules, press <b>Test connection</b>, tick <b>Raise ServiceNow incidents for this customer</b> and <b>Save</b>.`,
      ], 'ol')}
      ${table(['Field', 'Notes'], [
        ['Instance URL', 'Just the address of the instance. Anything after it is ignored.'],
        ['User name and password', 'HTTP Basic authentication. The password is encrypted at rest and never shown again. Changing the instance or user name needs the password again.'],
        ['Assignment group, category, caller', 'Sent as names (display values). Test connection checks that the group exists. Caller is a user\'s full name.'],
        ['Resolution code', 'Used when an incident is resolved automatically. It must be one of your instance\'s resolution codes (out of the box: <b>Solution provided</b>). If ServiceNow refuses it, the incident gets a work note instead and the page shows why.'],
        ['Priorities', 'P1 to P5 are sent as impact and urgency on ServiceNow\'s default priority matrix: P1 = 1/1, P2 = 1/2, P3 = 2/2, P4 = 2/3, P5 = 3/3.'],
      ])}
      <h4>API calls</h4>
      ${table(['Call', 'Used for'], [
        ['<span class="mono">GET /api/now/table/incident?sysparm_limit=1</span>', 'Test connection'],
        ['<span class="mono">GET /api/now/table/sys_user_group?sysparm_query=name=…</span>', 'Checks the assignment group'],
        ['<span class="mono">GET /api/now/table/incident?sysparm_query=correlation_id=…^active=true</span>', 'Finds an incident it raised before'],
        ['<span class="mono">POST /api/now/table/incident?sysparm_input_display_value=true</span>', 'Raises the incident'],
        ['<span class="mono">PATCH /api/now/table/incident/{sys_id}</span>', 'Work notes and resolving'],
        ['<span class="mono">GET /api/now/table/incident?sysparm_query=sys_idIN…</span>', 'Every 5 minutes: notices incidents resolved or closed in ServiceNow'],
      ])}
      ${note('Mock mode simulates incidents inside Estate Monitor (numbers like INC0010001) and sends nothing, so you can see the flow before connecting an instance. By default MSP admins configure ServiceNow; give customer admins <b>Manage connections and API keys</b> under Roles if they should set it up themselves. Every settings change, test and incident is in the audit log, never the password.')}`,
    }] : []),
    ...(admin ? [{
      id: 'configure', title: 'Configuration',
      html: `<h4>${link('connections', 'Connections')}</h4>
      <p>A connection links one customer to one source. Each starts on <b>Mock data</b> (built-in demo data in the same format as the real API, no keys needed). To go live: <b>Configure</b>, choose <b>Live API</b>, paste the settings and secrets, press <b>Test connection</b>, then <b>Save</b>. Secrets are encrypted (AES-256-GCM) before they are stored and are never shown again; to change one, paste a new value. <b>Sync now</b> runs a sync straight away; otherwise every connection syncs on a schedule: every 5 minutes by default, changed under <b>Configure › Sync schedule</b> (a default for all connections, and an interval per connection).</p>
      <h4>${link('models', 'Model master')}</h4><p>The catalogue of make, model and device type, which connectors can monitor each model, the approved firmware baseline, lifecycle dates and known releases. Every firmware version first seen in the fleet is added automatically. Only the super admin edits it.</p>
      <h4>${link('customers', 'Customers')}</h4><p><b>Onboard customer</b> creates the customer, its sites (city presets fill in map positions), its first user logins with a role each (customer admin by default), connections (on demo data to start) and optionally pre-loaded rooms and schematics. MSP admins onboard into their own MSP; the super admin picks the MSP. Set each customer's SLA target under Sites and users.</p><p><b>Details</b> on a customer card opens everything about that customer on one page: devices and health by source, 30-day availability against the SLA target, every connection with its mode, sync status, interval, device count and live settings (secrets are never shown), ServiceNow settings and latest incidents, sites with their local contacts, engineer and renewals contacts, users and roles, the customer baseline and lifecycle rules, Action inbox status and recent changes from the audit log. Each section links to the page where you change it.</p>
      <h4>${link('apis', 'API tracker')}</h4><p>Every external API the app uses, which customers and connections use it, live call counts and errors, and the result of reachability checks (a 401 or 403 counts as up because the service answered). The super admin runs <b>Check all APIs</b>, which also tests each connection with its own credentials. Checks also run every 30 minutes.</p>
      <h4>${link('audit', 'Audit log')}</h4><p>Sign-ins, customer views, device edits and imports, actions, Action inbox decisions and dispatch emails, site contacts, room and schematic changes, onboarding, MSPs, users, role changes and permission changes, reported issues, connection changes and tests (never secret values), model master changes and API checks. Filter and export to CSV.</p>`,
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
        ['<span class="mono">DEFAULT_MSP_NAME</span>', 'Name of the MSP that existing customers and provider admins move into when upgrading to five-tier roles (default "Default MSP"; rename it later under MSPs).'],
        ['<span class="mono">SHOW_DEMO_ACCOUNTS</span>', 'Shows the demo logins on the sign-in page.'],
        ['<span class="mono">SYNC_INTERVAL_SECONDS</span>', 'Starting default for how often connections sync (default 300 seconds). Configure › Sync schedule overrides it.'],
        ['<span class="mono">SYNC_CONCURRENCY</span>, <span class="mono">SYNC_TIMEOUT_SECONDS</span>', 'Connections that may sync at once (default 4) and how long one sync may take (default 120 s).'],
        ['<span class="mono">DATABASE_URL</span>', 'Keep everything in Postgres instead of files (recommended for large estates). Existing files are imported on the first start.'],
        ['<span class="mono">ALERT_MAX</span>, <span class="mono">ALERT_RETENTION_DAYS</span>, <span class="mono">HISTORY_RETENTION_DAYS</span>', 'How many alerts are kept (10,000), for how long (30 days), and days of health history (35).'],
        ['<span class="mono">API_CHECK_MINUTES</span>', 'Minutes between automatic API checks (default 30, 0 turns them off).'],
        ['<span class="mono">MAIL_FROM</span>', 'Sender for Action inbox emails, e.g. <span class="mono">Estate Monitor &lt;noreply@yourdomain.com&gt;</span>. Needed with one of the three below.'],
        ['<span class="mono">RESEND_API_KEY</span>, <span class="mono">SENDGRID_API_KEY</span> or <span class="mono">SMTP_URL</span>', 'How Action inbox emails are sent: Resend or SendGrid over HTTPS (best on Railway, which blocks outbound SMTP on its lower plans), or SMTP (<span class="mono">smtps://user:pass@host:465</span>, or <span class="mono">smtp://…:587</span> with STARTTLS). Without one, emails open in the admin\'s own email app.'],
        ['<span class="mono">MAIL_REPLY_TO</span>, <span class="mono">DISPATCH_SIGNATURE</span>', 'Optional Reply-To address for dispatch emails, and the sign-off name (default "The IT support team").'],
        ['<span class="mono">ACTION_RETENTION_DAYS</span>', 'Days closed Action inbox actions are kept (default 180).'],
        ['<span class="mono">PUBLIC_URL</span>', 'The app\'s own address, put in ServiceNow incident descriptions as a link back (on Railway the public domain is used automatically).'],
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
        ${admin ? '<dt>The Action inbox says email sending isn\'t set up</dt><dd>Set <span class="mono">MAIL_FROM</span> and one of <span class="mono">RESEND_API_KEY</span>, <span class="mono">SENDGRID_API_KEY</span> or <span class="mono">SMTP_URL</span> on the server (see Hosting and settings) and restart. Until then, dispatches open in your own email app.</dd><dt>An offline device is not offered a remote reboot</dt><dd>A device that is offline can\'t receive a command from its cloud. Only a power-cycle of its switch port or PDU outlet (through Domotz) can reach it; otherwise the steps go to the site contact.</dd>' : ''}
        <dt>Everything reset</dt><dd>The free hosting plan has a temporary disk; see Hosting and settings.</dd>
      </dl>`,
    },
  ];
}
