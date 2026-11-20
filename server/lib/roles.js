// Five-tier user roles and the configurable permission matrix.
//
//   Super admin (the platform / development company)
//     > MSP admin (a managed service provider; sees only its own customers)
//       > Customer admin > Technical user > End user (one customer each)
//
// Permissions resolve in layers: built-in defaults, then the platform layer
// (super admin), then the MSP layer (super admin or that MSP's admin), then the
// customer layer (super admin, its MSP's admin, or its customer admin). An editor
// can only change rows for roles below their own, and a lower role can never hold
// a permission the role above it lacks, so nobody can grant more than they have.

export const ROLES = ['super_admin', 'msp_admin', 'customer_admin', 'technical_user', 'end_user'];
export const RANK = Object.fromEntries(ROLES.map((r, i) => [r, i]));
export const CUSTOMER_ROLES = ['customer_admin', 'technical_user', 'end_user'];
// Roles from before the five-tier model, and what they become.
export const LEGACY_ROLES = { provider_admin: 'msp_admin', customer_viewer: 'end_user' };

export const ROLE_INFO = {
  super_admin: {
    label: 'Super admin', scope: 'The whole platform',
    summary: 'The company that runs Estate Monitor. Owns the platform and every MSP on it.',
    duties: ['Create and manage MSPs and their admins', 'Maintain the model and firmware master and the advisory baseline', 'Set the platform default permissions for every role', 'Run API health checks and set the default sync interval'],
  },
  msp_admin: {
    label: 'MSP admin', scope: 'Their MSP\'s customers',
    summary: 'A managed service provider\'s administrator. Sees and manages only the customers of their own MSP.',
    duties: ['Onboard customers and manage their sites', 'Set up connectors and API keys', 'Set each customer\'s baseline', 'Create customer admins, technical users and end users', 'Adjust permissions for customer roles within their MSP'],
  },
  customer_admin: {
    label: 'Customer admin', scope: 'Their own organisation',
    summary: 'The customer\'s own administrator, usually the IT or workplace lead.',
    duties: ['Manage their estate: device records, rooms and schematics', 'Maintain sites and site contacts (SPOC)', 'Create technical users and end users', 'Decide actions in the action inbox and keep site contacts current', 'Adjust permissions for technical and end users'],
  },
  technical_user: {
    label: 'Technical user', scope: 'Their own organisation',
    summary: 'Engineers and support staff who look after the rooms day to day.',
    duties: ['See every device and its diagnostics', 'Run remote actions such as a reboot', 'Sync connections on demand and update room schematics', 'Decide and carry out actions in the action inbox'],
  },
  end_user: {
    label: 'End user', scope: 'Their own organisation, read only',
    summary: 'People who use the rooms. They can check room status and report a problem.',
    duties: ['See the status of rooms and devices', 'Report an issue with a room or device'],
  },
};

// min = the lowest role (highest rank) that may ever hold the permission.
// locked = not configurable (always on for roles up to min, always off below).
export const PERMISSIONS = [
  { key: 'estate.view', group: 'Monitoring', label: 'View the estate', help: 'Overview, map, sites and rooms, devices and alerts.', min: 'end_user', locked: true },
  { key: 'service.view', group: 'Monitoring', label: 'View service reports', help: 'Service levels, lifecycle, baselines and error codes.', min: 'end_user' },
  { key: 'issue.report', group: 'Monitoring', label: 'Report an issue', help: 'Raise a problem with a room or device. It appears in the alert feed.', min: 'end_user' },
  { key: 'connections.view', group: 'Monitoring', label: 'See connection status', help: 'The Connections page, without settings or keys.', min: 'end_user' },
  { key: 'devices.actions', group: 'Technical', label: 'Run remote actions', help: 'Reboot and other device actions through the vendor APIs.', min: 'technical_user' },
  { key: 'devices.webui', group: 'Technical', label: 'Open device web UI', help: 'Open a device\'s own web interface (works from the same network or VPN).', min: 'technical_user' },
  { key: 'connections.sync', group: 'Technical', label: 'Sync connections now', help: 'Pull fresh data from a connection on demand.', min: 'technical_user' },
  { key: 'rooms.design', group: 'Technical', label: 'Edit room schematics and drawings', help: 'Cabling schematics and design file uploads.', min: 'technical_user' },
  { key: 'inbox.view', group: 'Technical', label: 'See the action inbox', help: 'Proposed actions from the daily checks.', min: 'technical_user' },
  { key: 'inbox.approve', group: 'Technical', label: 'Decide inbox actions', help: 'Approve or decline proposed actions, send dispatches, mark them done.', min: 'technical_user' },
  { key: 'inbox.run', group: 'Technical', label: 'Run the checks now', help: 'Start the daily checks on demand.', min: 'technical_user' },
  { key: 'contacts.view', group: 'Technical', label: 'See site contacts', help: 'Site and room contacts (SPOC), engineer and renewals contacts.', min: 'technical_user' },
  { key: 'estate.edit', group: 'Technical', label: 'Edit device records', help: 'Bulk edit, add devices by hand or CSV, set room platforms.', min: 'technical_user' },
  { key: 'sites.manage', group: 'Administration', label: 'Manage sites and contacts', help: 'Site details and map positions; site, room, engineer and renewals contacts.', min: 'customer_admin' },
  { key: 'users.manage', group: 'Administration', label: 'Manage users', help: 'Create, change and remove users at lower levels.', min: 'customer_admin' },
  { key: 'roles.manage', group: 'Administration', label: 'Adjust role permissions', help: 'Change what lower roles can do, within your own permissions.', min: 'customer_admin' },
  { key: 'audit.view', group: 'Administration', label: 'View the audit log', help: 'Who did what, for the customers in your scope.', min: 'customer_admin' },
  { key: 'baselines.edit', group: 'Administration', label: 'Edit customer baselines', help: 'Firmware, warranty and lifecycle standards per customer.', min: 'customer_admin' },
  { key: 'connections.manage', group: 'Administration', label: 'Manage connections and API keys', help: 'Add, configure, test and remove connections, and set sync intervals.', min: 'customer_admin' },
  { key: 'customers.manage', group: 'MSP', label: 'Onboard and manage customers', help: 'Create, edit and delete customers in the MSP, and enter a customer\'s view.', min: 'msp_admin' },
  { key: 'apis.view', group: 'MSP', label: 'View the API tracker', help: 'Health of the vendor APIs the connectors use.', min: 'msp_admin' },
  { key: 'platform.manage', group: 'Platform', label: 'Run the platform', help: 'MSPs, model master, advisory baseline, API checks, default sync interval.', min: 'super_admin', locked: true },
];
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
const PERM = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p]));

const ALL = PERMISSION_KEYS;
export const DEFAULTS = {
  super_admin: ALL,
  msp_admin: ALL.filter((k) => k !== 'platform.manage'),
  customer_admin: ['estate.view', 'service.view', 'issue.report', 'connections.view', 'devices.actions', 'devices.webui', 'connections.sync', 'rooms.design', 'inbox.view', 'inbox.approve', 'inbox.run', 'contacts.view', 'estate.edit', 'sites.manage', 'users.manage', 'roles.manage', 'audit.view'],
  technical_user: ['estate.view', 'service.view', 'issue.report', 'connections.view', 'devices.actions', 'devices.webui', 'connections.sync', 'rooms.design', 'inbox.view', 'inbox.approve', 'inbox.run', 'contacts.view'],
  end_user: ['estate.view', 'service.view', 'issue.report'],
};

export const normalizeRole = (role) => LEGACY_ROLES[role] || role;
export const isRole = (r) => ROLES.includes(r);
/** May a role ever hold this permission? */
export const allowedFor = (role, key) => !!PERM[key] && RANK[role] <= RANK[PERM[key].min];

/** The first layer a role's row can be changed at: platform (0), MSP (1) or customer (2). */
const LAYER_RANK = { platform: 0, msp: 1, customer: 2 };

/**
 * Effective permissions per role at a layer of the chain.
 * layers: [{ overrides }] from platform down to the target layer.
 * Each override: { [role]: { [permKey]: boolean } }.
 */
export function resolveMatrix(layers = []) {
  const out = {};
  let above = null;
  for (const role of ROLES) {
    const set = new Set(DEFAULTS[role]);
    if (role !== 'super_admin') {
      for (const l of layers) for (const [k, v] of Object.entries(l?.[role] || {})) { if (v) set.add(k); else set.delete(k); }
    }
    const perms = new Set();
    for (const k of PERMISSION_KEYS) {
      const p = PERM[k];
      if (!allowedFor(role, k)) continue;
      if (p.locked) { perms.add(k); continue; }
      if (!set.has(k)) continue;
      if (above && !above.has(k)) continue; // a lower role never exceeds the one above
      perms.add(k);
    }
    out[role] = perms;
    above = perms;
  }
  return out;
}

/**
 * Apply an editor's changes to a layer's overrides. `input` holds only the cells to
 * change: true or false sets a cell, null puts it back to what the layer inherits.
 * Rows the editor can't change are ignored; giving a permission the editor doesn't
 * hold, or one the role can never have, is refused. Cells equal to `inherited` are dropped.
 */
export function cleanOverrides(input, { layer, editorRole, editorPerms, current = {}, inherited = null }) {
  const out = structuredClone(current || {});
  if (!input || typeof input !== 'object') return out;
  for (const [role, row] of Object.entries(input)) {
    if (!editableRow(role, layer, editorRole)) continue;
    const next = { ...(out[role] || {}) };
    for (const [k, v] of Object.entries(row || {})) {
      if (!PERM[k] || PERM[k].locked) continue;
      if (v === null) { delete next[k]; continue; }
      if (v !== true && v !== false) continue;
      if (v === true && !allowedFor(role, k)) throw new Error(`"${PERM[k].label}" can't be given to the ${ROLE_INFO[role].label} role`);
      if (v === true && !editorPerms.has(k)) throw new Error(`You can't give "${PERM[k].label}" because you don't have it yourself`);
      if (!allowedFor(role, k)) { delete next[k]; continue; }
      if (inherited && inherited[role]?.has(k) === v) delete next[k]; else next[k] = v;
    }
    if (Object.keys(next).length) out[role] = next; else delete out[role];
  }
  return out;
}

export function editableRow(role, layer, editorRole) {
  return isRole(role) && role !== 'super_admin' && RANK[role] > RANK[editorRole] && RANK[role] >= Math.max(1, LAYER_RANK[layer] ?? 9);
}

/** Display labels: built-in names, with the super admin's renames applied. */
export function roleLabels(custom = {}) {
  return Object.fromEntries(ROLES.map((r) => [r, String(custom?.[r] || '').trim() || ROLE_INFO[r].label]));
}
