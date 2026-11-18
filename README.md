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
npm test                  # 16 tests: connectors, dedupe, tenancy, encryption, mTLS
```

Demo sign-ins (password `demo1234`, or whatever `DEMO_PASSWORD` is set to on first run):

| Account | Sees |
|---|---|
| `admin@provider.example` | All customers, can manage connections and credentials |
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
  lib/store.js              JSON-file config store (data/store.json)
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
