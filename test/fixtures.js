// A second mock customer for tests that check one customer can't see another.
// The app itself seeds only "Demo Customer".
import { hashPassword } from '../server/lib/auth.js';

export const SECOND = {
  id: 'cust-northwind', name: 'Northwind Retail',
  sites: [
    { name: 'Chicago', region: 'AMER', country: 'United States', lat: 41.8826, lng: -87.6233, city: 'Chicago', mockRooms: 6 },
    { name: 'Toronto', region: 'AMER', country: 'Canada', lat: 43.6481, lng: -79.3815, city: 'Toronto', mockRooms: 4 },
    { name: 'Manchester', region: 'EMEA', country: 'United Kingdom', lat: 53.4794, lng: -2.2453, city: 'Manchester', mockRooms: 5 },
  ],
  platforms: ['Zoom', 'Google Meet'],
};

export function addSecondCustomer(store, password = 'demo1234') {
  store.seedDemoCustomer(SECOND, hashPassword(password));
  store.registerMocks();
  store.seedMockRoomPlatforms(SECOND.id);
}
