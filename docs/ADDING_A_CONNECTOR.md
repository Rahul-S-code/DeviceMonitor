# Adding an OEM connector

Adding a manufacturer (for example Yealink, Neat or Cisco Control Hub) means
adding one folder and one line. Nothing in the dashboard, de-duplication,
alerting or tenancy code changes.

1. Create `server/connectors/<oem>/index.js` with a class that extends
   `BaseConnector` (`server/connectors/base.js`):

   ```js
   export class AcmeConnector extends BaseConnector {
     static oem = 'acme-cloud';           // unique key
     static displayName = 'Acme Cloud';
     static make = 'Acme';
     static nativeHealth = true;          // false if the API has no warning/critical state
     static docsUrl = 'https://…';        // the official API docs you built from
     static settingFields = [{ key: 'tenantId', label: 'Tenant ID', required: true }];
     static credentialFields = [{ key: 'apiKey', label: 'API key', required: true }];

     async testConnection() { /* cheapest authenticated call */ }
     async fetchRaw()       { /* all pages from the API, unmodified */ }
     mapDevices(raw)        { /* return makeDevice({...}) for each device */ }
   }
   ```

2. Give it two transports with the same methods: a live one that calls the
   real API, and a mock one (`mock.js`) that returns data in the same shape,
   built from `server/mock/estate.js`. Choose between them in the constructor
   using `this.isLive`, and accept an injected `transport` for tests.

3. Add the class to `CONNECTORS` in `server/connectors/registry.js`.

4. Add tests in `test/` that map an example response from the official docs.

Rules:

- Build only from the OEM's official documentation or OpenAPI file. Link it in
  `docsUrl` and in the file header. Don't guess endpoints or fields.
- Use `makeDevice()` so the record is validated, and the helpers in
  `lib/device-model.js` for platform names and device types.
- Never log or return credentials. They arrive decrypted in `this.credentials`
  only in live mode.
- Respect the OEM's rate limits; retry 429s with backoff.

## Platform-side connectors

Meeting-platform portals (Zoom Rooms, Webex Control Hub, Teams Rooms, Google
Meet hardware) use the same interface with `static kind = 'platform'` and
`static platform = '<one of PLATFORMS>'`. Set `platform` and
`platformSource: 'device'` on every device; de-duplication merges them with
the manufacturer's record by serial or MAC and keeps the OEM's site and room.

If the vendor has no public API, set `static liveSupported = false` and
explain why in `static liveNote`. The UI then disables Live mode and the API
refuses it. Optional `static setupSteps` are shown in the Link drawer.
