// Shared interface every OEM connector implements.
//
// To add an OEM: create server/connectors/<oem>/index.js exporting a class
// that extends BaseConnector, then add it to registry.js. Nothing else in
// the app needs to change. See docs/ADDING_A_CONNECTOR.md.

export class BaseConnector {
  /** Unique key, e.g. "poly-lens". */
  static oem = 'base';
  /** Name shown in the UI. */
  static displayName = 'Base';
  /** Manufacturer name written to device.make. */
  static make = 'Unknown';
  /** Link to the official API documentation the connector was built from. */
  static docsUrl = '';
  /** 'oem' = manufacturer device cloud, 'platform' = meeting-platform admin portal. */
  static kind = 'oem';
  /** False when no supported public API exists, so only mock data can be used. */
  static liveSupported = true;
  /** Shown in the UI to explain the live-mode situation (e.g. a retired API). */
  static liveNote = '';
  /**
   * External API endpoints this connector calls, for the API tracker.
   * availability: 'retired' | 'none' when there is nothing live to call.
   * @type {Array<{id:string,name:string,method:string|null,url:string|null,probe?:string,purpose:string,auth:string|null,availability?:string}>}
   */
  static apis = [];
  /** Steps shown when linking credentials. */
  static setupSteps = [];
  /**
   * Non-secret settings (stored in plain text), e.g. tenant or org id.
   * @type {Array<{key:string,label:string,required?:boolean,placeholder?:string,help?:string,default?:string}>}
   */
  static settingFields = [];
  /**
   * Secret fields (stored encrypted, never returned to the browser).
   * @type {Array<{key:string,label:string,multiline?:boolean,required?:boolean,help?:string}>}
   */
  static credentialFields = [];

  /**
   * @param {object} opts
   * @param {object} opts.connection   Connection record (id, customerId, mode, settings)
   * @param {object} opts.credentials  Decrypted secrets (live mode only)
   * @param {object} [opts.transport]  Injectable HTTP layer, used by tests
   */
  constructor({ connection, credentials = {}, transport } = {}) {
    this.connection = connection;
    this.credentials = credentials;
    this.transport = transport;
  }

  get isLive() {
    return this.connection.mode === 'live';
  }

  /** Validate credentials against the OEM API. @returns {Promise<{ok:boolean,message:string}>} */
  async testConnection() {
    throw new Error('testConnection() not implemented');
  }

  /** Fetch raw OEM data (live API or mock) and return it unmodified. */
  async fetchRaw() {
    throw new Error('fetchRaw() not implemented');
  }

  /** Convert raw OEM data to CommonDevice[] (see lib/device-model.js). */
  // eslint-disable-next-line no-unused-vars
  mapDevices(raw) {
    throw new Error('mapDevices() not implemented');
  }

  /** Full sync: fetch then map. Connectors rarely need to override this. */
  async sync() {
    const raw = await this.fetchRaw();
    return this.mapDevices(raw);
  }

  /** Throws a helpful error if required live settings or secrets are missing. */
  assertLiveConfig() {
    const C = this.constructor;
    const missing = [
      ...C.settingFields.filter((f) => f.required && !this.connection.settings?.[f.key]).map((f) => f.label),
      ...C.credentialFields.filter((f) => f.required && !this.credentials?.[f.key]).map((f) => f.label),
    ];
    if (missing.length) throw new Error(`Missing ${missing.join(', ')}`);
  }

  static describe() {
    return {
      oem: this.oem,
      displayName: this.displayName,
      make: this.make,
      docsUrl: this.docsUrl,
      kind: this.kind,
      liveSupported: this.liveSupported,
      liveNote: this.liveNote,
      setupSteps: this.setupSteps,
      settingFields: this.settingFields,
      credentialFields: this.credentialFields.map(({ key, label, multiline, required, help }) => ({ key, label, multiline, required, help })),
    };
  }
}
