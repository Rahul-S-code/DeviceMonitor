// Mock Domotz: one collector per site, reporting the network-attached kit
// (NETGEAR switches, Sony displays, BrightSign players, Crestron processors) by MAC.
import { simulatedState, hash } from '../../mock/estate.js';
import { networkedKit } from '../../mock/av-estate.js';

const VENDOR = { netgear: 'NETGEAR', sony: 'Sony', brightsign: 'BrightSign', crestron: 'Crestron' };
const TYPE = { netgear: 'Network Switch', sony: 'TV', brightsign: 'Media Player', crestron: 'Home Automation' };

export class DomotzMockTransport {
  constructor(customerId, { now = () => Date.now() } = {}) { this.customerId = customerId; this.now = now; }

  sites() {
    const bySite = new Map();
    for (const x of networkedKit(this.customerId)) {
      if (!bySite.has(x.room.site)) bySite.set(x.room.site, []);
      bySite.get(x.room.site).push(x);
    }
    return bySite;
  }

  agentId(site) { return Math.floor(hash(`${this.customerId}/${site}`) * 900000) + 100000; }

  async get(path) {
    const sites = this.sites();
    if (path === '/agent') return [...sites.keys()].map((s) => ({ id: this.agentId(s), display_name: s, status: { value: 'ONLINE' }, team: { name: 'Service desk' } }));
    const m = path.match(/^\/agent\/(\d+)\/device$/);
    if (m) {
      const site = [...sites.keys()].find((s) => String(this.agentId(s)) === m[1]);
      if (!site) throw new Error('Domotz returned 404: check the account, organisation or ID in the settings.');
      const t = this.now();
      return sites.get(site).map(({ room, d }, i) => {
        const st = simulatedState(d.key, t).state;
        return {
          id: 1000 + i, display_name: `${room.room} ${d.model}`, protocol: 'IP',
          status: st === 'offline' ? 'DOWN' : 'ONLINE', importance: d.vendor === 'netgear' ? 'VITAL' : 'FLOATING',
          hw_address: d.mac, ip_addresses: [d.ip], vendor: VENDOR[d.vendor], model: d.model,
          type: { id: 1, label: TYPE[d.vendor] }, user_data: { model: d.model, vendor: VENDOR[d.vendor] },
          details: { room: room.room, zone: `Floor ${room.floor}`, serial: d.serial, firmware_version: d.firmware },
          last_status_change: new Date(t - 3_600_000).toISOString(),
        };
      });
    }
    throw new Error(`Mock Domotz: unsupported GET ${path}`);
  }

  async post() { return {}; }
}
