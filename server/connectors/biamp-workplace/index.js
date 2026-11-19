// Biamp Workplace connector (demo data only for now).
//
// Biamp Workplace has an API (support.biamp.com > Integrations for Biamp Workplace >
// Biamp Workplace API): GraphQL at https://api.evoko.app/graphql (EU:
// https://euapi.evoko.app/graphql), signed in with OAuth 2.0 Authorization Code +
// PKCE through https://iam.workplace.biamp.app/oauth/v2/. Biamp documents only a
// user sign-in flow (no service account or client credentials) and publishes the
// schema only through introspection, so a hosted service cannot sync it unattended.
// This connector runs on demo data until Biamp offers machine credentials.
import { BaseConnector } from '../base.js';
import { DemoKitTransport, mapDemoKit } from '../demo-only.js';

export class BiampWorkplaceConnector extends BaseConnector {
  static oem = 'biamp-workplace';
  static short = 'BW';
  static displayName = 'Biamp Workplace';
  static make = 'Biamp';
  static nativeHealth = true;
  static liveSupported = false;
  static liveNote = 'Biamp Workplace\'s API (GraphQL) signs in with a person\'s Biamp account in a browser (OAuth with PKCE). There is no service account or API key yet, so Estate Monitor cannot sync it unattended. This connection uses demo data. Add real Biamp kit by hand or by CSV, or ask Biamp (support@biamp.com) for machine-to-machine API access.';
  static docsUrl = 'https://support.biamp.com/Biamp_Workplace/Integrations_for_Biamp_Workplace/Biamp_Workplace_API';
  static actionsNote = 'No unattended Biamp Workplace API yet. Manage Tesira and Parlé devices in Biamp Workplace or SageVue.';
  static guide = {
    summary: 'Biamp Workplace is Biamp\'s cloud for Tesira DSPs, Parlé microphones, EX-UBT bars and the Evoko booking panels.',
    needs: ['Today: nothing (demo data)', 'Live: machine-to-machine API access from Biamp, when it is offered'],
    health: 'Demo data follows the same healthy, warning, critical and offline pattern as the other demo sources.',
    location: 'Demo kit sits in the same rooms as the rest of the demo estate.',
  };
  static apis = [
    { id: 'biamp-graphql', name: 'Biamp Workplace GraphQL', method: 'POST', url: 'https://api.evoko.app/graphql', purpose: 'Not used yet: needs a signed-in user (OAuth PKCE)', auth: 'OAuth 2.0 PKCE (user sign-in)' },
  ];
  static setupSteps = ['No setup: this connection runs on demo data. See the note above for live access.'];

  constructor(opts) { super(opts); if (!this.transport) this.transport = new DemoKitTransport(this.connection.customerId, 'biamp'); }
  async testConnection() { const n = (await this.transport.list()).length; return { ok: true, message: `Demo data: ${n} Biamp devices.` }; }
  async fetchRaw() { return this.transport.list(); }
  mapDevices(rows, now = Date.now()) { return mapDemoKit(this, rows, { now, faultCode: 'EM-PER-002' }); }
}
