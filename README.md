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
npm test                  # 22 tests: connectors, dedupe, tenancy, encryption, mTLS, onboarding, schematics
```

Demo sign-ins (password `demo1234`, or whatever `DEMO_PASSWORD` is set to on first run):

| Account | Sees |
|---|---|
| `superadmin@provider.example` | Everything, plus the Customers page: onboard customers, add their logins, enter any customer (password: `SUPERADMIN_PASSWORD`, else `DEMO_PASSWORD`) |
| `admin@provider.example` | All customers, can manage connections, credentials, rooms and devices |
| `it@helix.example` | Helix Financial only |
| `it@northwind.example` | Northwind Retail only |
| `it@meridian.example` | Meridian Health only |

The three customers, their sites and devices are fictional mock data.

## What's in phase 1

- **Overview**: health totals (healthy / warning / critical / offline) with breakdowns by OEM connection, meeting platform, customer, device type, manufacturer and site. Click any row to filter.
- **Sites & rooms**: drill down site → room → device. Admins can set a room's meeting platform.
- **Devices**: sortable table; click a device for the full common record and which sources reported it.
- **Live alert feed**: health changes and connector failures pushed over Server-Sent Events, with toasts for critical alerts.
- **OEM sync status**: per-connection state, device count, last sync time and error.
- **Filters**: customer, region, site, platform, OEM, device type, health, plus free-text search.
- **Multi-customer**: every API call is scoped server-side to the signed-in user's customer. Provider admins see everything.
- **Connections page**: "Link Poly Lens" flow to paste a client ID and secret, test the connection, and switch from mock to live. Logitech Sync takes an org ID plus certificate and private key PEMs.

## Phase 2 features

- **Map**: every site on a world map (OpenStreetMap data, CARTO tiles). Zoomed out you see regions; zoom in or click for sites, then drill into rooms and devices in the side panel. Marker colour is the worst device health at that site.
- **Super admin and onboarding**: `superadmin@provider.example` gets a Customers page. "Onboard customer" creates the customer, its sites (city presets fill in the map coordinates), its user logins, its OEM connections (starting on mock data) and optional pre-loaded rooms with platforms and schematics. "Enter customer" (also in the top bar for any admin) switches the whole app to that customer's view until you exit.
- **Group devices into rooms and bulk update**: tick devices on the Devices page or in a room, then group them into an existing or new room, set the platform, add tags and notes, or reset them to what the OEM reports. Changes are stored as overrides on top of the OEM data, so the next sync never undoes them. Single devices can be edited from their detail panel.
- **Room schematics**: each room has a cabling diagram showing which device plugs into which, on which port, with which cable (HDMI, USB, USB-C, Ethernet, PoE, DisplayPort, audio, power, wireless). Start from a template (Rally Bar, Rally with PC, Poly Studio X, Poly G7500, USB huddle), add the room's monitored devices, edit items and connections, and import or export it as JSON. Linked devices show their live health on the diagram. Schematics can be loaded per room during onboarding.

## Publish it online (Render)

GitHub stores the code but cannot run a Node server, so the app is hosted on Render, which deploys straight from this repository:

1. Sign in at [render.com](https://render.com) with your GitHub account.
2. Choose **New > Blueprint**, pick this repository and the `main` branch.
3. Render reads `render.yaml`. Enter a `SUPERADMIN_PASSWORD` and a `DEMO_PASSWORD` when asked (use strong ones: the site is public).
4. Press **Apply**. After the build you get a public `https://estate-monitor-….onrender.com` address. Every push to `main` redeploys it.

On the free plan the service sleeps after 15 minutes without visitors (the first visit then takes about a minute), and its disk is temporary, so onboarded customers, schematics and saved API keys are reset when it restarts. For real use, add a Render persistent disk mounted at `/opt/render/project/src/data` (paid plan) or move the store to a database.

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
  lib/store.js              JSON-file config store (data/store.json): customers, users, connections,
                            site directory (with map coordinates), device overrides, room schematics
  lib/schematic.js          Room schematic validation and templates
  lib/auth.js               scrypt passwords, HttpOnly sessions, customer scoping
  services/dedupe.js        Merge devices reported by several sources
  services/inventory.js     Enrichment, filtering, aggregates, drill-down tree
  services/sync.js          Scheduler, per-connection status, alert generation
  mock/estate.js            Shared fictional estate used by all mock transports
public/                     Front end (plain ES modules, no build step)
test/                       node:test suites
```

Each connector has a **live transport** and a **mock transport** with the same
interface. The mock returns data in exactly the shape the real API returns, so
the connector's paging and mapping code is identical in both modes.

### Common device format

`site, room, deviceType, make, model, serial, firmware, health (healthy|warning|critical|offline), lastSeen`,
plus `customerId, region, platform, ip, mac, sources[]`. See `server/lib/device-model.js`.

### How OEM data is mapped

| | Poly Lens | Logitech Sync |
|---|---|---|
| Site | `site.name` | last segment of the room `group` path |
| Room | `room.name` | place `name` |
| Model / serial / firmware | `hardwareModel` / `serialNumber` / `softwareVersion` | `name` / `serial` / `version` |
| Health | `connected=false` → offline, otherwise healthy. A firmware version older than the newest seen for that model becomes a warning, because the API has no native warning state | `status=Offline` → offline, `healthStatus=Error` → critical, `Warning` → warning, `NoIssues` → healthy. Missing peripherals (e.g. "Mic Pod: 1 of 2 connected") become the reason |
| Last seen | `lastDetected` | sync time if online, else `lastSeen` (last disconnection) |
| Platform | `activeApplicationName` | not in the API: set per room on the room page, or inferred from other devices in the room |
| Region | site directory | first segment of `group` if it is a region code, else site directory |

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
- Logitech Sync: [API quick start guide](https://hub.sync.logitech.com/syncguides/post/1-8-getting-started---api-quick-start-guide-QOU16rRoLmzBP9F) and the Sync Cloud API OpenAPI definition v0.1.4 (download it from Sync Portal › Settings › Sync Cloud API)

Things to confirm against a real tenant when going live:

- Poly Lens: tenants in a different region may need a regional API host; set the Token URL and GraphQL URL on the connection if so.
- Logitech Sync: use the exact "API Server" from your portal; the API only returns licensed rooms (Select, Essential or Sync Plus).

## Later phases

Alert rules, ServiceNow ticket creation, uptime reports, and Microsoft Entra ID
sign-in. The alert generator in `services/sync.js` and the session layer in
`lib/auth.js` are the hooks for these.

## Adding an OEM

See [docs/ADDING_A_CONNECTOR.md](docs/ADDING_A_CONNECTOR.md).
