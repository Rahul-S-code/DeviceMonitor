// One place for "who can do what" on the Action inbox and its settings, so the
// role model can change (e.g. MSP, customer admin, technical user, end user)
// without touching the routes. Today's roles: super_admin, provider_admin, customer_viewer.
import { isAdminRole, isSuperAdmin } from './auth.js';

const RULES = {
  'inbox.view': (u) => isAdminRole(u), // see proposed actions for customers in scope
  'inbox.decide': (u) => isAdminRole(u), // approve / decline / mark sent or done
  'inbox.run': (u) => isAdminRole(u), // run the checks now
  'contacts.view': (u) => isAdminRole(u),
  'contacts.edit': (u) => isAdminRole(u), // site / room SPOCs, engineer and renewals contacts
  'checks.schedule': (u) => isSuperAdmin(u), // daily run time, on/off (all customers)
};

export const PERMISSIONS = Object.keys(RULES);

/** Can this user do that? Customer scope is checked separately (allowedCustomers). */
export function can(user, permission) {
  const rule = RULES[permission];
  return !!(user && rule && rule(user));
}

/** Express middleware: 403 unless can(user, permission). */
export const requirePermission = (permission) => (req, res, next) => (can(req.user, permission) ? next() : res.status(403).json({ error: 'Not allowed' }));
