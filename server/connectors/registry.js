// The only place connectors are listed. Add a new OEM or platform here.
import { PolyLensConnector } from './poly-lens/index.js';
import { LogitechSyncConnector } from './logitech-sync/index.js';
import { ZoomRoomsConnector } from './zoom-rooms/index.js';
import { WebexConnector } from './webex/index.js';
import { TeamsRoomsConnector } from './teams-rooms/index.js';
import { GoogleMeetConnector } from './google-meet/index.js';
import { YealinkYmcsConnector } from './yealink-ymcs/index.js';
import { NeatPulseConnector } from './neat-pulse/index.js';
import { CrestronXioConnector } from './crestron-xio/index.js';
import { QsysReflectConnector } from './qsys-reflect/index.js';
import { BiampWorkplaceConnector } from './biamp-workplace/index.js';
import { ShureCloudConnector } from './shure-cloud/index.js';
import { BrightSignBsnConnector } from './brightsign-bsn/index.js';
import { SonyBraviaConnector } from './sony-bravia/index.js';
import { NetgearInsightConnector } from './netgear-insight/index.js';
import { DomotzConnector } from './domotz/index.js';

export const CONNECTORS = [
  PolyLensConnector, LogitechSyncConnector, YealinkYmcsConnector, NeatPulseConnector,
  CrestronXioConnector, QsysReflectConnector, BiampWorkplaceConnector, ShureCloudConnector,
  BrightSignBsnConnector, SonyBraviaConnector, NetgearInsightConnector, DomotzConnector,
  ZoomRoomsConnector, WebexConnector, TeamsRoomsConnector, GoogleMeetConnector,
];

/** Demo connections added to the demo customers for the AV and network sources. */
export const AV_DEMO_OEMS = ['yealink-ymcs', 'neat-pulse', 'crestron-xio', 'qsys-reflect', 'biamp-workplace', 'shure-cloud', 'brightsign-bsn', 'sony-bravia', 'netgear-insight', 'domotz'];

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
