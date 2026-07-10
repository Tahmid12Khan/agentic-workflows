// Route table wiring — just names/paths, no handler logic to authorize here.
export const ROUTES = [
  { method: 'DELETE', path: '/accounts/:id', handler: 'deleteAccount' },
  { method: 'GET', path: '/accounts/:id', handler: 'getAccount' },
];
