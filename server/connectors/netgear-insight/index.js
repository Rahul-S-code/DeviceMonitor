// NETGEAR connector (demo data only).
//
// NETGEAR Insight (and Engage for the M4250/M4300 AV line) has no public REST
// API: NETGEAR support confirmed "There is currently no REST APIs available for
// Insight" (community.netgear.com, Insight Network REST API thread). NETGEAR
// switches are monitored live through Domotz (or SNMP), which reports them by
// MAC address so they merge with this record.
import { BaseConnector } from '../base.js';
import { DemoKitTransport, mapDemoKit } from '../demo-only.js';

export class NetgearInsightConnector extends BaseConnector {
  static oem = 'netgear-insight';
  static short = 'NG';
  static displayName = 'NETGEAR Insight';
  static make = 'NETGEAR';
  static nativeHealth = true;
  static liveSupported = false;
  static liveNote = 'NETGEAR Insight has no public API (NETGEAR confirmed this on its community forum). This connection uses demo data. To monitor NETGEAR AV switches live, add a Domotz connection: Domotz reports them by MAC address and they merge with these records.';
  static docsUrl = 'https://community.netgear.com/t5/NETGEAR-Insight-Network/Insight-Network-REST-API/td-p/2341226';
  static actionsNote = 'No NETGEAR API. Use Domotz power actions (PoE power cycle) for devices on a NETGEAR switch.';
  static guide = {
    summary: 'NETGEAR M4250 and M4300 switches carry AV-over-IP and Dante traffic in many meeting rooms.',
    needs: ['Today: nothing (demo data)', 'Live: a Domotz connection, which monitors NETGEAR switches on the network'],
    health: 'Demo data follows the same healthy, warning, critical and offline pattern as the other demo sources.',
    location: 'Demo kit sits in the same rooms as the rest of the demo estate.',
  };
  static apis = [
    { id: 'netgear-insight', name: 'NETGEAR Insight', method: null, url: null, purpose: 'No public API. Use Domotz for live switch monitoring', auth: null, availability: 'none' },
  ];
  static setupSteps = ['No setup: this connection runs on demo data. Add a Domotz connection to monitor NETGEAR switches live.'];

  constructor(opts) { super(opts); if (!this.transport) this.transport = new DemoKitTransport(this.connection.customerId, 'netgear'); }
  async testConnection() { const n = (await this.transport.list()).length; return { ok: true, message: `Demo data: ${n} NETGEAR switches.` }; }
  async fetchRaw() { return this.transport.list(); }
  mapDevices(rows, now = Date.now()) { return mapDemoKit(this, rows, { now }); }
}
