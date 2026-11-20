// can(user, permission) for routes that take only the user (the Action inbox and
// site contacts). Permissions come from the five-tier role model and the
// configurable role matrix (lib/roles.js): the app attaches each signed-in user's
// effective permissions per request with setPermissions().
const granted = new WeakMap();

// Inbox names that map onto a permission of the role matrix.
const ALIAS = {
  'inbox.decide': 'inbox.approve', // approve / decline / mark sent or done
  'contacts.edit': 'sites.manage', // site / room SPOCs, engineer and renewals contacts
  'checks.schedule': 'platform.manage', // daily run time, on/off (all customers)
};

export const PERMISSIONS = ['inbox.view', 'inbox.decide', 'inbox.run', 'contacts.view', 'contacts.edit', 'checks.schedule'];

/** Remember a user's effective permissions (a Set of role-matrix keys) for this request. */
export function setPermissions(user, perms) { if (user) granted.set(user, perms); }

/** Can this user do that? Customer scope is checked separately (allowedCustomers). */
export function can(user, permission) {
  const p = user && granted.get(user);
  return !!(p && p.has(ALIAS[permission] || permission));
}

/** Express middleware: 403 unless can(user, permission). */
export const requirePermission = (permission) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  return can(req.user, permission) ? next() : res.status(403).json({ error: 'Your role does not allow this' });
};
