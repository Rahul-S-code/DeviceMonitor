// The only place connectors are listed. Add a new OEM or platform here.
import { PolyLensConnector } from './poly-lens/index.js';
import { LogitechSyncConnector } from './logitech-sync/index.js';
import { ZoomRoomsConnector } from './zoom-rooms/index.js';
import { WebexConnector } from './webex/index.js';
import { TeamsRoomsConnector } from './teams-rooms/index.js';
import { GoogleMeetConnector } from './google-meet/index.js';

export const CONNECTORS = [PolyLensConnector, LogitechSyncConnector, ZoomRoomsConnector, WebexConnector, TeamsRoomsConnector, GoogleMeetConnector];

/** Which platform connector covers each meeting platform. */
export const PLATFORM_CONNECTOR = Object.fromEntries(CONNECTORS.filter((C) => C.kind === 'platform').map((C) => [C.platform, C.oem]));

/** Pseudo-source for devices added by hand (no API, so no live health). */
export const MANUAL_SOURCE = Object.freeze({ oem: 'manual', displayName: 'Manual entry', make: null, kind: 'manual', nativeHealth: true, liveSupported: false });

export function getConnectorClass(oem) {
  if (oem === 'manual') return MANUAL_SOURCE;
  const C = CONNECTORS.find((c) => c.oem === oem);
  if (!C) throw new Error(`Unknown connector "${oem}"`);
  return C;
}

export function createConnector(connection, credentials, transport) {
  const C = getConnectorClass(connection.oem);
  return new C({ connection, credentials, transport });
}
