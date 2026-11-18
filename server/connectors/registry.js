// The only place connectors are listed. Add a new OEM here.
import { PolyLensConnector } from './poly-lens/index.js';
import { LogitechSyncConnector } from './logitech-sync/index.js';

export const CONNECTORS = [PolyLensConnector, LogitechSyncConnector];

export function getConnectorClass(oem) {
  const C = CONNECTORS.find((c) => c.oem === oem);
  if (!C) throw new Error(`Unknown connector "${oem}"`);
  return C;
}

export function createConnector(connection, credentials, transport) {
  const C = getConnectorClass(connection.oem);
  return new C({ connection, credentials, transport });
}
