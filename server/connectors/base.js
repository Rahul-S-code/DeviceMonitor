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
  /** Two-letter badge shown beside devices and connections. */
  static short = '?';
  /** Product documentation shown on the Documentation page: summary, needs[], health, location. */
  static guide = null;
  /** Overrides the "OEM device cloud API" label on device actions (e.g. a network monitor). */
  static apiSetLabel = '';
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
  /**
   * Remote actions this connector can run through its vendor API (reboot...).
   * api.set says whose API it is: 'OEM' (manufacturer cloud) or 'Platform'
   * (meeting-platform admin portal). Empty when the API is read-only.
   * @type {Array<{id:string,label:string,description:string,confirm:string,api:{set:string,name:string,method:string,endpoint:string},scope:string,target:'device'|'room'}>}
   */
  static actions = [];
  /** Why there are no actions, shown in the device panel. */
  static actionsNote = '';
  /** Can this action run on that device? Override to limit by make or source data. */
  static actionApplies(_action, _device, _source) { return true; }
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

  /**
   * Run a remote action. Demo (mock) connections never call anything and say
   * what a live connection would call.
   */
  async runAction(actionId, source, device) {
    const C = this.constructor;
    const a = C.actions.find((x) => x.id === actionId);
    if (!a) throw new Error(`${C.displayName} cannot run that action`);
    if (!this.isLive) return { ok: true, simulated: true, message: `Demo connection, so nothing was sent to ${C.displayName}. On a live connection this calls ${a.api.method} ${a.api.endpoint}.` };
    this.assertLiveConfig();
    return this.performAction(a, source, device);
  }

  // eslint-disable-next-line no-unused-vars
  async performAction(action, source, device) {
    throw new Error('performAction() not implemented');
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
      short: this.short,
      guide: this.guide,
      make: this.make,
      docsUrl: this.docsUrl,
      kind: this.kind,
      liveSupported: this.liveSupported,
      liveNote: this.liveNote,
      setupSteps: this.setupSteps,
      actions: this.actions,
      actionsNote: this.actionsNote,
      apis: this.apis.map(({ id, name, method, url, purpose, auth, availability }) => ({ id, name, method, url, purpose, auth, availability })),
      settingFields: this.settingFields,
      credentialFields: this.credentialFields.map(({ key, label, multiline, required, help }) => ({ key, label, multiline, required, help })),
    };
  }
}
