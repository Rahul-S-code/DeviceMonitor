# Estate Monitor

A vendor-neutral monitoring dashboard for meeting-room and UC devices across
Microsoft Teams, Zoom, Cisco Webex and Google Meet estates. Device data comes
from each manufacturer's cloud through plug-in connectors, is converted into one
common device format, de-duplicated, and shown per customer.

Phase 1 connectors: **Poly Lens** and **Logitech Sync**. Both run on built-in
mock data out of the box, so the whole app works without API keys; switch each
connection to *Live API* from the Connections page once you have credentials.

## Run it

Needs Node.js 20 or newer.

```bash
npm install
cp .env.example .env      # optional; set MASTER_KEY for anything beyond a demo
npm start                 # http://localhost:8080
npm test                  # connectors, dedupe, tenancy and roles, encryption, onboarding, schematics, API tracker, models, SLA, inbox, audit
```

Demo sign-ins (password `demo1234`, or whatever `DEMO_PASSWORD` is set to on first run):

| Account | Role | Sees |
|---|---|---|
| `superadmin@provider.example` | Super admin | The whole platform: MSPs, every customer, the model master, platform permissions (password: `SUPERADMIN_PASSWORD`, else `DEMO_PASSWORD`) |
| `admin@provider.example` | MSP admin | The customers of the Default MSP: onboarding, connections and keys, baselines, users |
| `admin@demo.example` | Customer admin | Demo Customer: estate, sites and contacts, inbox decisions, its technical and end users |
| `tech@demo.example` | Technical user | Demo Customer: diagnostics, remote actions, schematics, inbox decisions |
| `it@demo.example` | End user | Demo Customer, read only, plus Report an issue |

The demo customer, its sites and devices are fictional mock data. Each customer has a Mock data switch (Customers > Sites & users, or when onboarding); with it off the customer starts with no devices and only shows devices from live API connections and manual or CSV uploads.

## What's in phase 1

- **Overview**: health totals (healthy / warning / critical / offline) with breakdowns by OEM connection, meeting platform, customer, device type, manufacturer and site. Click any row to filter.
- **Sites & rooms**: drill down site → room → device. Admins can set a room's meeting platform.
- **Devices**: sortable table; click a device for the full common record and which sources reported it.
- **Live alert feed**: health changes and connector failures pushed over Server-Sent Events, with toasts for critical alerts.
- **OEM sync status**: per-connection state, device count, last sync time and error.
- **Filters**: customer, region, site, platform, OEM, device type, health, plus free-text search.
- **Multi-customer**: every API call is scoped server-side to the signed-in user's customer, or to their MSP's customers for an MSP admin. See [Users, roles and MSPs](#users-roles-and-msps).
- **Connections page**: "Link Poly Lens" flow to paste a client ID and secret, test the connection, and switch from mock to live. Logitech Sync takes an org ID plus certificate and private key PEMs.

## Phase 2 features

- **Map**: every site on a world map, drawn with open-source Leaflet on OpenStreetMap tiles (switch to a lighter CARTO style using OpenStreetMap data from the layer button, or point `MAP_TILE_URL` at your own tile server). Zoomed out you see regions; zoom in or click for sites, then drill into rooms and devices in the side panel. Marker colour is the worst device health at that site.
- **Super admin and onboarding**: `superadmin@provider.example` gets a Customers page. "Onboard customer" creates the customer, its sites (city presets fill in the map coordinates), its user logins, its OEM connections (starting on mock data) and optional pre-loaded rooms with platforms and schematics. "Enter customer" (also in the top bar for any admin) switches the whole app to that customer's view until you exit.
- **Group devices into rooms and bulk update**: tick devices on the Devices page or in a room, then group them into an existing or new room, set the platform, add tags and notes, or reset them to what the OEM reports. Changes are stored as overrides on top of the OEM data, so the next sync never undoes them. Single devices can be edited from their detail panel.
- **Room schematics**: each room has a cabling diagram showing which device plugs into which, on which port, with which cable (HDMI, USB, USB-C, Ethernet, PoE, DisplayPort, audio, power, wireless). Start from a template (Rally Bar, Rally with PC, Poly Studio X, Poly G7500, USB huddle), add the room's monitored devices, edit items and connections, and import or export it as JSON. Linked devices show their live health on the diagram. Schematics can be loaded per room during onboarding.

## Phase 3 features

- **Model and firmware master** (Models tab; super admin edits, other admins read): the catalogue of make › model › device type, which connectors can monitor it, the approved firmware baseline, end-of-sale, end-of-support and end-of-life dates with a link to the manufacturer's notice, and a release list per model. Releases are tracked two ways: every firmware version first seen in the fleet is added automatically (and logged), and admins add official releases with release-notes links. Lifecycle dates are never invented. A built-in catalogue (`server/lib/lifecycle-catalogue.js`, checked 20 Nov 2026) pre-fills each known model from official vendor and platform pages: the status (dates announced, discontinued with no dates, or not announced), a note, and the source links. Where a vendor has published no date the fields stay blank and show "Not announced". The catalogue only fills models with no lifecycle data, so anything the super admin enters wins. Models seen in the estate but missing from the master are listed for one-click import.
- **Baselines tab** (Service › Baselines): two tiers. The provider's **advisory baseline** is the approved firmware per model in the model master plus an advisory policy (warranty required, warranty notice days, the lifecycle stage at which a device fails), edited by the super admin and versioned. Each customer has its **own baseline**, also versioned: follow the advisory, aim for the highest level (newest known release per model), or set per-model exceptions lower or higher (pin a version, or not enforce). Warranty and lifecycle rules follow the advisory or are the customer's own. Admins save each change as a new version and can view or restore earlier ones (restoring makes a new version); customers see theirs read-only. All changes are in the audit log (`baseline.*`). Devices are judged against their customer's baseline, and drift from the advisory is shown alongside.
- **Lifecycle tab**: compliance against each customer's baseline (with drift from advisory), versions per model, warranty status (in warranty, expiring within the customer's notice period, expired, not recorded), lifecycle stage per model, and a list of devices needing attention. Devices below baseline become a warning for sources with no native health (Poly Lens, Zoom).
- **Warranty capture**: Logitech Sync's `place.device.warranty` (type and expiry, API v0.1.3+) is read automatically. Any device can carry a manual warranty end date, plan, contract reference and purchase date, from its detail panel or in bulk ("Warranty" in the bulk bar).
- **Platform-side connectors** (Connections page, "Meeting-platform portals"): Zoom Rooms (live, Server-to-Server OAuth) and Webex Control Hub (live, admin token). Teams Rooms and Google Meet hardware run on mock data only, because neither has a public device-health API (see API references). Platform devices merge with the OEM record of the same device by serial or MAC, and supply the meeting platform.
- **SLA tab**: availability over 24 hours, 7 days or 30 days by customer, site, room and device, against a per-customer target (default 99.5%, set under Customers › Sites & users), plus incidents, mean time to restore and a trend chart. A device is unavailable while offline or critical. Health is recorded at every sync into `data/history.json` (35 days kept); devices from mock connections use a simulated history so the demo has 30 days of data.
- **Audit log tab** (admins): sign-ins and failed sign-ins, entering customers, device edits, room platform and schematic changes, onboarding, users, connection changes, tests and syncs (only the names of changed credential fields, never values), model master changes, new firmware seen, and audit exports. Filter by activity, user, date and text; export to CSV.

## Schematic designer and room documents

Each room page has a **Room schematic** card. Admins open the **designer**:

- **Building blocks** in the left palette: video bars, codecs, cameras, room PCs, controllers, displays, projectors, microphones, DSPs, amplifiers, HDMI switchers and splitters, HDBaseT transmitters and receivers, USB extenders and hubs, wireless presentation, table boxes, wall plates, network switches, PoE injectors and power strips. The room's own monitored devices are listed first and are added already linked.
- Every block has **typed ports** (HDMI in/out, DisplayPort, HDBaseT, USB, USB-C, LAN/PoE, audio, speaker, fibre, power). Ports can be renamed, added or removed per item.
- **Drag from one port to another** to run a cable (or click one port, then the other). Outputs feed inputs; a port takes one cable. Each cable gets a tag (C-01, C-02...) and can carry a length, a condition (tested OK, suspect, faulty) and a note.
- Templates, JSON import and export, auto-arrange, zoom and undo are on the toolbar.

Outside the designer the same drawing is the **troubleshooting view**: linked devices show live health, the **Room check** panel lists unhealthy devices with every cable and port they depend on and what they affect downstream, flags faulty or suspect cables, and notes devices missing from the drawing. Clicking an item traces its signal path. The **cable schedule** below the drawing exports to CSV.

The **Design documents** card holds uploaded drawings for the room (PDF, PNG, JPEG, Visio .vsdx, AutoCAD .dwg, up to 10 MB each, 20 per room). The file type is checked from the file's content. Images and PDFs open in the browser; Visio and AutoCAD files download. Files are stored under `data/designs/`.

## API tracker

**Configure › API tracker** (admins) lists every external API the tool uses: each OEM and platform endpoint, the map tile servers and Google Fonts, with the customers and connections that use it. The super admin's **Check all APIs** (or **Check** on one row) calls each endpoint without credentials and times the answer (a 401 or 403 counts as up, since it means the service answered), and tests every customer connection with its own credentials. Results keep the last 48 checks per API (response time chart, average, p95, uptime). Live connector traffic is also counted per endpoint (calls, errors, average time) since the server started. Checks run automatically every `API_CHECK_MINUTES` (default 30, 0 turns it off).

## Open device UI

The device panel has **Open device UI**, a link to the device's own web interface: `https://<IP the vendor reports>/` by default, or a **Device UI address** set under Edit this device (stored as a device override, http or https only, no credentials). The browser opens the device directly, so it works only from a computer on the same network as the device or over VPN; Estate Monitor never proxies to customer networks. Opens are audited (`device.open_ui`). Permission `devices.webui` (Technical user and above by default). Code: `server/lib/device-ui.js`.

## Remote device actions

Admins see **Remote actions** in a device's panel. Every action runs through the API of one named service, and the panel says which: the **OEM device cloud API** (the manufacturer, e.g. Poly Lens) or the **meeting platform API** (e.g. Webex Control Hub, Zoom). When both report a device, both are listed and you pick one. Each action shows the exact endpoint and the permission the credentials need.

| Service | API set | Actions | Endpoint | Permission needed |
| --- | --- | --- | --- | --- |
| Poly Lens | OEM | Reboot device | GraphQL `rebootDevice(deviceId)` | API client allowed to control devices |
| Webex Control Hub | Platform | Restart, wake from standby, put into standby (Cisco RoomOS devices) | `POST /v1/xapi/command/SystemUnit.Boot`, `Standby.Deactivate`, `Standby.Activate` | `spark:xapi_commands` |
| Zoom Rooms | Platform | Restart Zoom Room (whole room) | `PATCH /v2/rooms/{roomId}/events` with `zoomroom.restart` | `room:write:admin` |
| Logitech Sync | OEM | None: the API is read-only | | |
| Teams Rooms, Google Meet | Platform | None: no supported public API | | |

Actions are confirmed with a second click, limited to one per device per minute, and written to the audit log (who, which action, which API, result). On demo (mock) connections nothing is sent; the panel says what a live connection would call. The read-only scopes used for monitoring are not enough: add the write permission above to the live credentials to enable actions.

## Users, roles and MSPs

Five levels, each inside the one above. Each level can add users only below itself and only in its own organisation, and can never give a permission it doesn't hold.

| Level | Scope | Default responsibilities |
|---|---|---|
| **Super admin** | The platform (the development company) | MSPs and their admins, model master, advisory baseline, platform default permissions and role names, API checks, default sync interval, inbox schedule |
| **MSP admin** | Their own MSP's customers | Onboard customers, connections and API keys, customer baselines, customer users, permissions for customer roles in their MSP |
| **Customer admin** | Their own organisation | Device records, rooms and schematics, sites and site contacts, inbox decisions, technical and end users, permissions for those two roles, audit log |
| **Technical user** | Their own organisation | Diagnostics, remote actions, sync now, schematics and drawings, inbox decisions and **Run checks now** |
| **End user** | Their own organisation, read only | Room and device status, **Report an issue** (shows in the alert feed under Reported) |

- **Permission matrix** (Configure › Roles, `server/lib/roles.js`): 22 permissions in five groups. Defaults per role, then three override layers: platform (super admin), MSP (super admin or that MSP's admin), customer (super admin, its MSP admin or its customer admin). An editor changes only rows below their own role, a lower role never holds a permission the role above it has lost, *View the estate* is always on and *Run the platform* is super admin only. The super admin can rename roles. API: `GET /api/roles?layer=platform|msp|customer&id=`, `PUT /api/roles { layer, id, overrides: { role: { perm: true|false|null } }, reset, labels }`.
- **Enforcement**: every API route checks a permission server-side (`requirePerm(...)` in `server/index.js`; the Action inbox routes use `can(user, ...)` from `server/lib/permissions.js`, which reads the same matrix). Tenant scope comes from `allowedCustomers` (`server/lib/auth.js`). The UI hides what a role can't do.
- **Users** (Configure › Users; `GET/POST /api/users`, `PUT/DELETE /api/users/:id`): add, rename, change role (between customer roles), reset password, disable, remove. Nobody edits their own account or anyone at their own level.
- **MSPs** (Configure › MSPs, super admin; `/api/admin/msps`): create, rename, add admins, open the MSP's permission layer, delete when empty. Customers move between MSPs from Customers › Sites & users.
- **Sites** (Configure › Sites, customer admins; `PUT /api/customers/:id/sites`): their own site list and map positions. Contacts live under Action inbox › Site contacts.
- **Audit**: user, role, permission and MSP changes and reported issues are logged (`user.*`, `roles.update`, `msp.*`, `issue.report`). Entries are tagged with their MSP, so MSP admins see only their own; customer admins see their customer's.
- **Upgrading** (phase 7 migration, runs once on the file store and on Postgres): a **Default MSP** is created (name from `DEFAULT_MSP_NAME`, rename it later), every existing customer joins it, provider admins become its MSP admins and customer viewers become end users (the same read-only access). The demo customer gets `admin@` and `tech@` logins.
- Tests: `test/roles.test.js` covers MSP-to-MSP isolation, user management limits, default permissions, the configurable matrix, inbox permissions and the migration; `test/postgres.test.js` checks the migration on Postgres.

## Action inbox (proactive checks)

Monitor › **Action inbox** (MSP admins, customer admins and technical users by default; end users don't see it). Every day (06:00 UTC by default; the super admin changes the hour or turns it off, and anyone who can decide actions can press **Run checks now**) each customer's estate is checked with deterministic rules, and each finding becomes a proposed action with a reason, the affected devices, a severity and how it will be carried out. The admin answers **Yes** or **No**.

| Check | Yes does |
| --- | --- |
| Device offline 15+ minutes | Domotz PoE/PDU power-cycle when Domotz reports it; otherwise emails power-cycle steps to the site contact (an offline device can't take a cloud reboot) |
| Device critical (online, faulty) | Restart through the vendor API that reports it (Poly Lens, Webex, Zoom Rooms, Neat, Yealink, Sony, Domotz); otherwise emails the steps to the site contact |
| 3+ incidents in 7 days | Emails on-site inspection steps (cables, power, port, heat) to the site contact |
| Firmware below the customer's baseline (per model) | Emails a task to the customer's engineer / service desk, with where to update in each vendor portal |
| Warranty expired or expiring; model past the lifecycle limit | Emails the device list to the customer's renewals contact |
| Connection failing or stale; credentials rejected | Retries the sync; or opens Connections to renew credentials |
| Site with no contact, room with no platform, no warranty date | Opens the page to fix it |

- **Field dispatch**: instructions are generated per device type (`server/lib/runbooks.js`) with the room, serial, MAC and what monitoring shows, grouped into one email per site. The admin can edit before sending.
- **Contacts**: Action inbox › **Site contacts**: a SPOC (name, email, phone) per site, optional per-room contacts (room contact gets the email, site contact in Cc), an engineer contact and a renewals contact per customer.
- **Email**: set `MAIL_FROM` plus `RESEND_API_KEY`, `SENDGRID_API_KEY` or `SMTP_URL` (`smtps://user:pass@host:465`, or `smtp://…:587` with STARTTLS). Railway blocks outbound SMTP on lower plans, so use Resend or SendGrid there. Without a provider the page says so and offers a mailto link and **Copy text**; the admin then presses **Mark as sent**.
- **Status**: proposed › approved › sent / failed › done, or declined / cleared. An issue in an open action is never proposed twice; new devices with the same problem join the open proposal. **No** keeps those items quiet for 7/30/90/365 days. A sent dispatch closes itself when the next check finds the devices healthy; a remote fix that didn't hold is re-proposed as a site dispatch. Every decision, email and API call is audited; closed actions are kept `ACTION_RETENTION_DAYS` (180).
- **Access**: scoped like every other page (an MSP admin sees only its customers; an admin inside one customer sees only that customer). `server/lib/permissions.js` maps the inbox checks onto the role matrix: `inbox.view`, `inbox.decide` (matrix *Decide inbox actions*), `inbox.run`, `contacts.view`, `contacts.edit` (*Manage sites and contacts*), `checks.schedule` (super admin).
- **Code**: rules and dedupe in `server/services/checks.js`, routes in `server/routes/inbox.js`, email in `server/lib/mailer.js`. No AI is needed; an AI summary or ranking can be added on top later.

## Customer page

Configure › Customers › **Details** (`#/customers/<id>`, MSP admins and the super admin) shows one customer in full from `GET /api/admin/customers/:id/profile`: devices and health by source, firmware and warranty status, 30-day availability against the SLA target, every connection (mode, sync status, last good sync, interval, devices, live settings; secrets masked), ServiceNow settings and latest incidents, sites with SPOCs, engineer and renewals contacts, users and roles, baseline and lifecycle rules, role overrides, Action inbox status, email sending status and recent audit entries. Each section links to the page that edits it.

## ServiceNow incidents (per customer)

Configure › **ServiceNow** (MSP admins by default; give customer admins *Manage connections and API keys* to let them set it up). Each customer has its own settings: on/off, **Mock** (simulated incidents, nothing sent) or **Live**, instance URL, integration user and password (encrypted), assignment group, category, caller, resolution code, which events raise incidents and their priority, the wait before raising, and auto-resolve.

| Event | Default | Then |
| --- | --- | --- |
| Device offline / critical for longer than the wait (10 min) | On, P2 / P3 | Work note when it changes; resolved when the device recovers |
| Device warning | Off, P4 | Same |
| Issue reported by a user | On, P3 | Raised at once |
| Action inbox dispatch or task approved | On, P3 | Resolved when the action is done or clears |
| **Raise incident** on the device panel (technical users and up) | | Raised at once, with an optional note |

- One fault, one incident: each incident carries `correlation_id` `estate-monitor:<key>`, so a restart finds the open one instead of raising another. An incident resolved or closed in ServiceNow while the device is still down is respected until the device recovers. Faults already open when it's switched on are skipped unless *include existing faults* is ticked. At most 20 new incidents per customer per minute.
- Failures (instance asleep, wrong password, unreachable) are shown with the reason and retried after 1, 5, 15, then every 60 minutes; **Retry now** on the page. Incident numbers show in the alert feed, on the device panel and on inbox items, linking to ServiceNow in live mode.
- ServiceNow side: an integration user with the **itil** role and *Web service access only*. A free Personal Developer Instance (developer.servicenow.com) works for testing.
- Table API calls: `GET /api/now/table/incident` (test, find by correlation id, state poll every 5 min), `GET /api/now/table/sys_user_group` (group check), `POST /api/now/table/incident?sysparm_input_display_value=true` (create), `PATCH /api/now/table/incident/{sys_id}` (work notes, resolve with `state=6`, `close_code`, `close_notes`). Priority P1–P5 maps to impact/urgency on the default matrix.
- Code: client in `server/lib/servicenow.js`, logic in `server/services/tickets.js`, routes in `server/routes/itsm.js`, tests in `test/servicenow.test.js`. Settings in `data.itsm[customerId]`, incidents in `data.tickets`.

## Adding devices by hand

Admins can add devices that no API reports (Devices › **+ Add device**, or **+ Add device** on a room page). Make and model are picked from the model master; for kit the master doesn't list, choose **Other** and type the manufacturer, model and device type. Devices with no API connector for their model (including everything entered under Other) are tagged **Not monitored**, and typed-in models appear on the Models tab for the super admin to catalogue. All manual devices show health **Not monitored**: they count in the inventory, lifecycle and warranty views but not in health alerts or SLA. If a connected API later reports the same serial number or MAC address, the records merge: live health and the OEM's location take over, and the asset tag, notes and warranty you entered are kept. 

**Bulk add from CSV**: Devices › **Bulk add (CSV)**. Download the template (columns `customer, site, room, make, model, device_type, serial, mac, firmware, platform, asset_tag, warranty_end, warranty_type, notes`, plus every make and model in the model master as `#` comment lines), fill it, and choose the file. The preview checks every row with the same rules as a single add (required fields, model master match, MAC and date formats, serials already used for that customer or earlier in the file) and shows each row's error. **Import** adds the valid rows and skips the rest; the import is audited. Up to 2,000 rows and 2 MB per file. Make and model must be in the model master unless "Allow models that are not in the model master" is ticked.

## AV and network connectors

| Connector | Live API | Auth | Data | Actions |
| --- | --- | --- | --- | --- |
| Yealink YMCS | Yes | AccessKey ID/Secret → `POST /v2/token` (Basic), Bearer, `timestamp` + `nonce` headers | `POST /v2/dm/listDevices`, `listSites`, `listAlarms`, `GET /v2/dm/models` | Reboot (`POST /v2/dm/device/reboot`) |
| Neat Pulse | Yes | Bearer API key + org ID | `GET /v1/orgs/{orgId}/endpoints`, `rooms`, `locations`, `endpoints/apps` | Reboot |
| Crestron XiO Cloud | Yes | `XiO-subscription-key` header + account ID | `GET /v2/device/accountid/{id}/pageno/{n}/pagesize/{s}/status`, `GET /v1/group/accountid/{id}/groups` | None (read-only API) |
| Q-SYS Reflect | Yes | Bearer API token (US, EMEA or APAC server) | `GET /systems`, `GET /systems/{id}/items` | None (read-only API) |
| Domotz | Yes | `X-Api-Key` + regional endpoint | `GET /agent`, `GET /agent/{id}/device` | Software reboot, PoE/PDU power cycle |
| BrightSign BSN.cloud | Yes | Client credentials token, `PUT /Self/Session/Network` | `GET /2022/06/REST/Devices/` (marker paging) | None yet |
| Sony BRAVIA Cloud | Yes | API key + access key | `GET /devices`, `GET /devices/{id}/online-status` | Reboot, screen on/off |
| Biamp Workplace | Demo only | GraphQL needs a user sign-in (OAuth PKCE); no machine credentials yet | | |
| ShureCloud | Demo only | CloudAPI is in private beta | | |
| NETGEAR Insight | Demo only | No REST API (NETGEAR confirmed); monitor switches live through Domotz | | |

Cisco Control Hub is the Webex admin portal and is covered by the **Cisco Control Hub (Webex)** connector. Domotz reports network-attached kit by MAC address, so it merges with the vendor record of the same device (a Sony display, a NETGEAR switch). Every connector has a demo (mock) mode returning its API's own JSON shape. The in-app **Documentation** page (Help › Documentation) has the full setup guide for each connector, built from the connectors' own metadata.

## Publish it online (Railway)

`railway.json` sets the start command and health check. In Railway: New Project > Deploy from GitHub repo > pick this repository, then:

1. Right-click the service > Attach volume, mount path `/data`. The app stores its data on the volume automatically (it reads `RAILWAY_VOLUME_MOUNT_PATH`; `DATA_DIR` overrides it). Without a volume, data is lost on every redeploy.
2. Variables: `NODE_ENV=production`, `MASTER_KEY` (keep the same value when moving hosts, or saved API keys can't be decrypted), `SUPERADMIN_PASSWORD`, `DEMO_PASSWORD`, `SHOW_DEMO_ACCOUNTS=false`. Optional `DEFAULT_MSP_NAME` names the MSP existing customers move into on upgrade. For Action inbox emails: `MAIL_FROM` and `RESEND_API_KEY` or `SENDGRID_API_KEY` (Railway blocks outbound SMTP on lower plans). Optional: `HOME_LINK_URL` / `HOME_LINK_NAME` (the "Back to UC Order Hub" link, defaults to https://rahul-s-code.github.io/L2O/; set it empty to hide), `SYNC_INTERVAL_SECONDS` (starting default 300; change it later under Configure > Sync schedule).
3. Settings > Networking > Generate Domain for a public https link.
4. Set a usage limit under Workspace > Usage so a runaway service can't run up the bill.

For a large estate, add a Railway Postgres to the same project and set this service's `DATABASE_URL` variable to reference it (`${{Postgres.DATABASE_URL}}`). On the first start with Postgres the app imports what is already on the volume, then keeps everything in the database. Keep the volume for uploaded room documents.

## Publish it online (Render)

GitHub stores the code but cannot run a Node server, so the app is hosted on Render, which deploys straight from this repository:

1. Sign in at [render.com](https://render.com) with your GitHub account.
2. Choose **New > Blueprint**, pick this repository and the `main` branch.
3. Render reads `render.yaml`. Enter a `SUPERADMIN_PASSWORD` and a `DEMO_PASSWORD` when asked (use strong ones: the site is public).
4. Press **Apply**. After the build you get a public `https://estate-monitor-….onrender.com` address. Every push to `main` redeploys it.

On the free plan the service sleeps after 15 minutes without visitors (the first visit then takes about a minute), and its disk is temporary, so onboarded customers, schematics, uploaded design documents and saved API keys are reset when it restarts. For real use, add a Render persistent disk mounted at `/opt/render/project/src/data` (paid plan) or move the store to a database.

## Large estates (tens of thousands of devices)

The app is sized for estates of 50,000+ devices on one instance. `npm run loadtest` builds a synthetic estate (50,000 devices, 100 customers, 400 connections; `LOAD_DEVICES=100000` for more) and prints the timings; `test/scale.test.js` runs the same estate in `npm test` with time and size limits. Typical results:

| Step | Time |
|---|---|
| Full build (de-duplicate and enrich every customer) | ~0.6 s |
| One connection changed (rebuild that customer only) | ~30 ms |
| Identical sync result | nothing rebuilt |
| First page of 100 devices, sorted on the server | ~20 ms (59 KB) |
| Next page | cached, under 1 ms |

How it is built:

- **Inventory per customer.** Each connection's latest sync is kept as a snapshot. De-duplication only happens within a customer, so a changed snapshot rebuilds only that customer, and an identical one rebuilds nothing. Rebuilds after a burst of syncs are coalesced (at most one a second).
- **Reads are paged and cached on the server.** `GET /api/devices?limit=100&offset=0&sort=health&dir=desc` (plus the usual filters and `q`) returns `{ items, total, offset, limit }` with light list rows; the full record comes from `/api/devices/:id`. Without paging parameters the old array form is still served, capped at 5,000 rows (`X-Total-Count` has the real count). Summaries, filters and sorted lists are cached until the inventory changes.
- **The map and site list carry counts, not devices.** `/api/map` returns sites only and the browser clusters nearby pins; rooms and devices for one site come from `/api/tree?customer=…&site=…&devices=1` when it is opened.
- **Sync scheduler.** Each connection syncs on its own interval (default 5 minutes, minimum 1 minute, maximum 24 hours; set under Configure > Sync schedule). First runs are spread over 30 seconds, at most `SYNC_CONCURRENCY` (4) run at once, a sync that runs past `SYNC_TIMEOUT_SECONDS` (120) is abandoned, and a failing connection backs off (2x, 4x… up to hourly) while keeping its last good data. A connector can declare `static minSyncSeconds` when its vendor needs a slower rate.
- **Storage.** With `DATABASE_URL` set, configuration is stored per section in Postgres (only changed sections are written), health history one row per device (only changed devices are written), and the latest snapshot per connection, so a restart shows the estate straight away instead of calling every vendor API at once. Without it, JSON files in `DATA_DIR` are used. Writes never block requests.
- **Retention.** Alerts: newest 10,000, none older than 30 days (`ALERT_MAX`, `ALERT_RETENTION_DAYS`). Health history: transitions only, 35 days (`HISTORY_RETENTION_DAYS`), at most 2,000 transitions per device.

Still single-instance: sessions and the inventory live in the server's memory, so run one instance (vertical scaling). Running several web instances behind a load balancer would need shared sessions and a separate sync worker; the snapshot table is the hand-off point for that.

## Architecture

```
server/
  connectors/
    base.js                 Shared connector interface (BaseConnector)
    registry.js             The only list of connectors
    poly-lens/              Poly Lens: OAuth client credentials + GraphQL
    logitech-sync/          Logitech Sync: mutual TLS + REST
  lib/device-model.js       Common device format, health/platform normalisation
  lib/vault.js              AES-256-GCM encryption for credentials
  lib/store.js              Config store: customers, users, connections, settings, site directory
                            (with map coordinates), device overrides, room schematics, alerts
  lib/persistence.js        Storage backends: JSON files in DATA_DIR, or Postgres when DATABASE_URL is set
  lib/schematic.js          Room schematic building blocks, validation and templates
  lib/designs.js            Uploaded room design documents (type checks)
  lib/api-calls.js          Counts live connector API calls per endpoint
  services/api-tracker.js   API catalogue, reachability checks and performance
  lib/auth.js               scrypt passwords, HttpOnly sessions, customer scoping
  services/dedupe.js        Merge devices reported by several sources
  services/inventory.js     Per-customer incremental build, paging, cached aggregates, drill-down tree
  services/sync.js          Scheduler (per-connection intervals, staggering, concurrency, back-off), alerts
  services/history.js       Health transitions for SLA reports
  mock/estate.js            Shared fictional estate used by all mock transports
public/                     Front end (plain ES modules, no build step)
test/                       node:test suites (scale.test.js = 50,000-device load test)
test/load/                  Synthetic estate generator and `npm run loadtest`
```

Each connector has a **live transport** and a **mock transport** with the same
interface. The mock returns data in exactly the shape the real API returns, so
the connector's paging and mapping code is identical in both modes.

### Common device format

`site, room, deviceType, make, model, serial, firmware, health (healthy|warning|critical|offline), lastSeen`,
plus `customerId, region, platform, ip, mac, sources[]`. See `server/lib/device-model.js`.

### How OEM and platform data is mapped

| | Poly Lens | Logitech Sync |
|---|---|---|
| Site | `site.name` | last segment of the room `group` path |
| Room | `room.name` | place `name` |
| Model / serial / firmware | `hardwareModel` / `serialNumber` / `softwareVersion` | `name` / `serial` / `version` |
| Health | `connected=false` → offline, otherwise healthy. A firmware version older than the newest seen for that model becomes a warning, because the API has no native warning state | `status=Offline` → offline, `healthStatus=Error` → critical, `Warning` → warning, `NoIssues` → healthy. Missing peripherals (e.g. "Mic Pod: 1 of 2 connected") become the reason |
| Last seen | `lastDetected` | sync time if online, else `lastSeen` (last disconnection) |
| Platform | `activeApplicationName` | not in the API: set per room on the room page, or inferred from other devices in the room |
| Region | site directory | first segment of `group` if it is a region code, else site directory |

Platform portals:

| | Zoom Rooms | Webex Control Hub |
|---|---|---|
| Calls | `GET /rooms`, `GET /rooms/{id}/devices`, `GET /rooms/locations` | `GET /devices`, `GET /workspaces`, `GET /locations` |
| Site / room | building location / room `name` | workspace location / workspace `displayName` |
| Make / model / serial | `device_manufacturer` / `device_model` / `serial_number` | `product` / `product` / `serial` |
| Health | device `status` Offline → offline, else healthy | `connectionStatus`: connected → healthy, connected_with_issues → warning (with `errorCodes`), disconnected/offline_* → offline |

### De-duplication

Within one customer, devices are merged when they share a serial number or MAC
address, or when a device with no hardware identity (a Logitech Sync "Generic"
peripheral) has the same model in the same site and room as another device.
The manufacturer's own cloud provides the primary record; health is the most
severe state any source reports. The mock estate includes rooms where a Poly
Studio USB bar is plugged into a Logitech-managed room PC, so it is reported
by both clouds and shown once.

### Credentials

API secrets are encrypted with AES-256-GCM before they are written to
`data/store.json`. The key comes from `MASTER_KEY` (64 hex characters) or, if
unset, is generated once into `data/master.key` with 0600 permissions. Secrets
are never returned by the API; the UI only shows "stored". `data/` and `.env`
are git-ignored.

## API references used

- Poly Lens: [How to get started](https://lensapidocsdev.z19.web.core.windows.net/docs/graphql/how-to-get-started), [Getting started](https://lensapidocsdev.z19.web.core.windows.net/docs/graphql/getting-started), [Inventory reporting](https://lensapidocsdev.z19.web.core.windows.net/docs/graphql/Example%20Queries/inventory-reporting)
- ServiceNow: [Table API](https://www.servicenow.com/docs/bundle/zurich-api-reference/page/integrate/inbound-rest/concept/c_TableAPI.html)
- Logitech Sync: [API quick start guide](https://hub.sync.logitech.com/syncguides/post/1-8-getting-started---api-quick-start-guide-QOU16rRoLmzBP9F) and the Sync Cloud API OpenAPI definition v0.1.4 (download it from Sync Portal › Settings › Sync Cloud API)

- Zoom Rooms: [Rooms API](https://developers.zoom.us/docs/api/rooms/), [Server-to-Server OAuth](https://developers.zoom.us/docs/internal-apps/s2s-oauth/). Scope `room:read:admin`.
- Webex: [Devices](https://developer.webex.com/docs/api/v1/devices), [Workspaces](https://developer.webex.com/docs/api/v1/workspaces), [Locations](https://developer.webex.com/docs/api/v1/locations). Scopes `spark-admin:devices_read`, `spark-admin:workspaces_read`, `spark-admin:locations_read`.
- Teams Rooms: Microsoft retired the Graph beta `teamworkDevice` API (Message Center MC1183294) and has [not published a replacement](https://learn.microsoft.com/en-us/answers/questions/5569164/what-is-replacing-the-teamworkdevice-endpoint-on-g). The connector keeps the retired resource's field names in its mock so a future API can be mapped quickly.
- Google Meet hardware: status is only in the [Admin console](https://knowledge.workspace.google.com/admin/meet-hardware/check-for-offline-meet-hardware); there is no public API for it.

Things to confirm against a real tenant when going live:

- Poly Lens: tenants in a different region may need a regional API host; set the Token URL and GraphQL URL on the connection if so.
- Logitech Sync: use the exact "API Server" from your portal; the API only returns licensed rooms (Select, Essential or Sync Plus).
- Zoom: the room location tree is read best effort; without the locations scope rooms land in "Unassigned site" until grouped.
- Webex: service-app tokens expire; replace the token on the connection before it lapses.

## Later phases

Alert rules, scheduled uptime reports and Microsoft Entra ID sign-in. (ServiceNow incidents and bulk device upload are built; see above.) The alert generator in `services/sync.js` and the session layer in
`lib/auth.js` are the hooks for these.

## Adding an OEM

See [docs/ADDING_A_CONNECTOR.md](docs/ADDING_A_CONNECTOR.md).
