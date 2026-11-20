// ServiceNow client for incident tickets (Table API).
//
// Built from ServiceNow's REST Table API documentation:
//   https://www.servicenow.com/docs/bundle/zurich-api-reference/page/integrate/inbound-rest/concept/c_TableAPI.html
//
// Auth:    HTTP Basic with an integration user (role: itil). Tick "Web service
//          access only" on that user so it cannot sign in to the web UI.
// Test:    GET  /api/now/table/incident?sysparm_limit=1
// Group:   GET  /api/now/table/sys_user_group?sysparm_query=name=<group>
// Create:  POST /api/now/table/incident?sysparm_input_display_value=true
//          { short_description, description, impact, urgency, category,
//            assignment_group, caller_id, correlation_id, correlation_display }
// Update:  PATCH /api/now/table/incident/{sys_id}  { work_notes }
// Resolve: PATCH /api/now/table/incident/{sys_id}  { state: 6, close_code, close_notes }
// Read:    GET  /api/now/table/incident?sysparm_query=sys_idIN<a,b,c>
//
// Incident states (out of the box): 1 New, 2 In Progress, 3 On Hold, 6 Resolved,
// 7 Closed, 8 Canceled. correlation_id lets a restart find an incident it
// already raised instead of opening a second one.
import crypto from 'node:crypto';
import { trackedFetch } from './api-calls.js';

export const SN_FIELDS = 'sys_id,number,state,active,priority,short_description';
export const CLOSED_STATES = new Set(['6', '7', '8']);
export const STATE_LABEL = { 1: 'New', 2: 'In Progress', 3: 'On Hold', 6: 'Resolved', 7: 'Closed', 8: 'Canceled' };
/** Priority in Estate Monitor terms -> impact and urgency on the default ServiceNow priority matrix. */
export const PRIORITY_MAP = { 1: { impact: 1, urgency: 1 }, 2: { impact: 1, urgency: 2 }, 3: { impact: 2, urgency: 2 }, 4: { impact: 2, urgency: 3 }, 5: { impact: 3, urgency: 3 } };

/** https://name.service-now.com (no path), or throws a readable error. */
export function cleanInstanceUrl(v) {
  let s = String(v ?? '').trim();
  if (!s) return '';
  if (/^[a-z0-9-]+$/i.test(s)) s = `https://${s}.service-now.com`; // just the instance name
  let u;
  try { u = new URL(s); } catch { throw new Error('Instance URL must look like https://yourcompany.service-now.com'); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new Error('Instance URL must be an https:// address with no user name in it');
  return `https://${u.host}`;
}

/** correlation_id is at most 100 characters in ServiceNow. */
export const correlationId = (key) => {
  const s = `estate-monitor:${key}`;
  return s.length <= 100 ? s : `estate-monitor:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
};

export const incidentUrl = (instanceUrl, sysId) => (instanceUrl && sysId ? `${instanceUrl}/nav_to.do?uri=${encodeURIComponent(`incident.do?sys_id=${sysId}`)}` : null);

export class ServiceNowClient {
  constructor({ instanceUrl, username, password, fetchImpl = trackedFetch }) {
    Object.assign(this, { instanceUrl: cleanInstanceUrl(instanceUrl), username: String(username || '').trim(), password: String(password || ''), fetchImpl });
    this.mode = 'live';
  }

  async call(method, path, body) {
    if (!this.instanceUrl) throw new Error('Set the ServiceNow instance URL');
    if (!this.username || !this.password) throw new Error('Set the ServiceNow user name and password');
    let res;
    try {
      res = await this.fetchImpl(`${this.instanceUrl}${path}`, {
        method,
        headers: { accept: 'application/json', authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new Error(`Could not reach ${this.instanceUrl}: ${e.cause?.code || e.message}`);
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.ok && json) return json;
    if (res.ok && /^\s*</.test(text)) throw new Error('ServiceNow returned a web page instead of data. A developer instance that is asleep does this: wake it at developer.servicenow.com, then try again.');
    const said = json?.error?.message ? `${json.error.message}${json.error.detail ? ` (${json.error.detail})` : ''}` : '';
    const hint = {
      401: 'The user name or password is wrong, or the user is locked out.',
      403: 'The user may not do this. Give it the itil role.',
      404: 'Nothing there. Check the instance URL.',
      429: 'ServiceNow is rate limiting. It will retry later.',
    }[res.status] || (res.status >= 500 ? 'ServiceNow had a problem. It will retry later.' : '');
    throw Object.assign(new Error(`ServiceNow HTTP ${res.status}${said ? `: ${said}` : ''}. ${hint}`.trim()), { status: res.status });
  }

  async test({ assignmentGroup } = {}) {
    await this.call('GET', '/api/now/table/incident?sysparm_limit=1&sysparm_fields=number');
    let group = null;
    if (assignmentGroup) {
      const r = await this.call('GET', `/api/now/table/sys_user_group?sysparm_limit=1&sysparm_fields=sys_id,name&sysparm_query=${encodeURIComponent(`name=${assignmentGroup}`)}`);
      group = r.result?.[0] || null;
      if (!group) return { ok: false, message: `Connected to ${this.instanceUrl}, but there is no assignment group called "${assignmentGroup}". Check the spelling in ServiceNow (User Administration › Groups).` };
    }
    return { ok: true, message: `Connected to ${this.instanceUrl} as ${this.username}. It can read incidents${group ? ` and found the group "${group.name}"` : ''}.` };
  }

  async findOpen(correlation) {
    const q = encodeURIComponent(`correlation_id=${correlation}^active=true`);
    const r = await this.call('GET', `/api/now/table/incident?sysparm_limit=1&sysparm_fields=${SN_FIELDS}&sysparm_query=${q}`);
    return r.result?.[0] || null;
  }

  async create(fields) {
    const r = await this.call('POST', `/api/now/table/incident?sysparm_input_display_value=true&sysparm_fields=${SN_FIELDS}`, fields);
    if (!r.result?.sys_id) throw new Error('ServiceNow did not return the new incident');
    return r.result;
  }

  async update(sysId, fields) {
    const r = await this.call('PATCH', `/api/now/table/incident/${encodeURIComponent(sysId)}?sysparm_input_display_value=true&sysparm_fields=${SN_FIELDS}`, fields);
    return r.result;
  }

  async states(sysIds) {
    if (!sysIds.length) return [];
    const q = encodeURIComponent(`sys_idIN${sysIds.join(',')}`);
    const r = await this.call('GET', `/api/now/table/incident?sysparm_limit=${sysIds.length}&sysparm_fields=${SN_FIELDS}&sysparm_query=${q}`);
    return r.result || [];
  }
}

/** Mock mode: an in-memory ServiceNow per customer, so the flow can be tried without an instance. */
const mockInstances = new Map();
export class MockServiceNowClient {
  constructor(customerId) {
    this.mode = 'mock';
    this.instanceUrl = null;
    if (!mockInstances.has(customerId)) mockInstances.set(customerId, { n: 10000, rows: new Map() });
    this.db = mockInstances.get(customerId);
  }
  async test() { return { ok: true, message: 'Mock mode: incidents are simulated inside Estate Monitor and nothing is sent to ServiceNow.' }; }
  async findOpen(correlation) { return [...this.db.rows.values()].find((r) => r.correlation_id === correlation && r.active === 'true') || null; }
  async create(fields) {
    const row = { sys_id: crypto.randomUUID().replace(/-/g, ''), number: `INC${String(++this.db.n).padStart(7, '0')}`, state: '1', active: 'true', priority: String(fields.priority || ''), short_description: fields.short_description, correlation_id: fields.correlation_id };
    this.db.rows.set(row.sys_id, row);
    return row;
  }
  async update(sysId, fields) {
    const row = this.db.rows.get(sysId);
    if (!row) throw Object.assign(new Error('ServiceNow HTTP 404: No Record found'), { status: 404 });
    if (fields.state) { row.state = String(fields.state); row.active = CLOSED_STATES.has(row.state) ? 'false' : 'true'; }
    return row;
  }
  async states(ids) { return ids.map((id) => this.db.rows.get(id)).filter(Boolean); }
}
