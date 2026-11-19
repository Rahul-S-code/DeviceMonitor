// Shure connector (demo data only for now).
//
// ShureCloud (shure.com/support/shurecloud) manages Shure networked audio (MXA
// microphones, IntelliMix, ANIUSB, MXN speakers) from the browser. Its CloudAPI
// is still in a private feedback group, and the Shure System API is an on-site
// Windows service on the AV network, which a hosted service cannot reach.
// This connector runs on demo data until ShureCloud's API is generally available.
import { BaseConnector } from '../base.js';
import { DemoKitTransport, mapDemoKit } from '../demo-only.js';

export class ShureCloudConnector extends BaseConnector {
  static oem = 'shure-cloud';
  static short = 'SH';
  static displayName = 'ShureCloud';
  static make = 'Shure';
  static nativeHealth = true;
  static liveSupported = false;
  static liveNote = 'ShureCloud\'s API is in a private beta (CloudAPI feedback group), and the Shure System API runs on a Windows server inside your AV network. Neither can be called from a hosted service today, so this connection uses demo data. Add real Shure kit by hand or by CSV, or monitor it on the network with Domotz.';
  static docsUrl = 'https://www.shure.com/support/shurecloud';
  static actionsNote = 'No public ShureCloud API yet. Manage Shure devices in ShureCloud or Shure Designer.';
  static guide = {
    summary: 'ShureCloud is Shure\'s cloud for networked microphones and audio processors (MXA920, MXA910, IntelliMix P300, ANIUSB-MATRIX).',
    needs: ['Today: nothing (demo data)', 'Live: ShureCloud API access once Shure releases it'],
    health: 'Demo data follows the same healthy, warning, critical and offline pattern as the other demo sources.',
    location: 'Demo kit sits in the same rooms as the rest of the demo estate.',
  };
  static apis = [
    { id: 'shure-cloud', name: 'ShureCloud', method: null, url: null, purpose: 'No public API yet (CloudAPI in private beta)', auth: null, availability: 'none' },
  ];
  static setupSteps = ['No setup: this connection runs on demo data. See the note above for live access.'];

  constructor(opts) { super(opts); if (!this.transport) this.transport = new DemoKitTransport(this.connection.customerId, 'shure'); }
  async testConnection() { const n = (await this.transport.list()).length; return { ok: true, message: `Demo data: ${n} Shure devices.` }; }
  async fetchRaw() { return this.transport.list(); }
  mapDevices(rows, now = Date.now()) { return mapDemoKit(this, rows, { now, faultCode: 'EM-PER-002' }); }
}
