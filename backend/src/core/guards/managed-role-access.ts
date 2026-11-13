/** Additional module boundary for accounts assigned to a managed RBAC role.
 * Existing per-action guards still make the final decision for write actions.
 * Legacy accounts without a roleId keep their existing access contract.
 */
/**
 * Reads the app makes at startup for EVERY account are shared reference data, not a module:
 * the product catalogue, stock and the transactions overview feed the sale form, Pick-Up,
 * Shopify, complaints and the dashboard alike. Refusing them broke the whole app for an account
 * on a role (Nov 13, 2026, measured: three employees moved onto roles lost the product list and
 * the startup overview). The lists the app loads only for some screens name every screen that
 * reads them (MANAGED_READERS) and the frontend skips them for a role that holds none of those.
 * ⚠ Keep READERS in step with `_bootMayLoad` in index.html.
 */
export const MANAGED_READERS: Record<string, string[]> = {
  '/suppliers': ['suppliers','products','purchase-create','purchase-view','categories-link-suppliers','approvals'],
  '/expenses': ['expenses','reports','approvals'],
  '/purchase-orders': ['purchase-view','purchase-create','suppliers-tab-pos'],
  '/supplier-returns': ['suppliers-returns','suppliers-tab-sreturns','approvals'],
};

export function managedRoleRequiredPermissions(path: string, method: string, body?: {type?: string}): string[] | null {
  const route = '/' + String(path || '').replace(/^\/+/, '').replace(/^api\//, '');
  const starts = (prefix: string) => route === prefix || route.startsWith(prefix + '/');
  const read = method === 'GET' || method === 'HEAD';
  if (read) {
    const readers = Object.entries(MANAGED_READERS).find(([prefix]) => route === prefix || route === prefix + '/');
    if (readers) return readers[1];
  }
  if (starts('/transactions')) {
    if (route.startsWith('/transactions/carrier-statement/')) return ['carrier-import'];
    if (route.startsWith('/transactions/deposit-receipts/')) return ['transaction','shopify-deposit-upload'];
    if (route.startsWith('/transactions/inventory')) return read ? null : ['inventory'];
    if (route.startsWith('/transactions/reports')) return ['reports'];
    if (route.startsWith('/transactions/movements-page') || route.startsWith('/transactions/summary-page') || route.startsWith('/transactions/archived')) return ['movements'];
    if (route.startsWith('/transactions/startup-overview')) return null; // startup data for every account
    if (route.startsWith('/transactions/dashboard-overview')) return ['dashboard','movements'];
    if (route.includes('/pickup-')) return ['pickup-orders'];
    if (route === '/transactions' && method === 'POST') return body?.type === 'مشتريات' ? ['purchase-create'] : ['transaction'];
    return ['movements','transaction','shopify-orders','pickup-orders'];
  }
  // Price offers belong to the promotions page, not to product editing: a managed role with
  // promotions-offers but no products-edit must still be able to start or stop an offer.
  if (route === '/products/offers/all') return ['promotions-view','promotions-offers','promotions-codes','promotions-bundles','promotions-tags','promotions-audit'];
  if (/^\/products\/[^/]+\/offers(?:\/|$)/.test(route)) return method === 'GET' ? ['products','inventory','promotions-view','promotions-offers'] : ['promotions-offers'];
  if (starts('/products')) {
    if (route.endsWith('/request-edit')) return ['products','inventory'];
    if (method === 'DELETE' || route.endsWith('/bulk-delete') || route.endsWith('/batch-delete')) return ['products-delete'];
    if (method === 'PUT' || method === 'PATCH' || route.endsWith('/bulk-update')) return ['products-edit'];
    if (method === 'POST') return ['products-create'];
    return read ? null : ['products','inventory']; // the catalogue is read by every order screen
  }
  if (starts('/suppliers')) {
    if (method === 'DELETE') return ['suppliers-delete'];
    if (method === 'PUT' || method === 'PATCH' || route.endsWith('/log')) return ['suppliers-edit'];
    if (method === 'POST') return ['suppliers-create'];
    return ['suppliers'];
  }
  if (starts('/categories')) {
    if (method === 'POST') return ['categories-create'];
    if (method === 'PUT' || method === 'PATCH') return ['categories-edit'];
    if (method === 'DELETE') return ['categories-delete'];
    return ['categories-view'];
  }
  if (starts('/customer-service-playbook')) {
    if (route.includes('/export')) return ['csp-export'];
    if (route.includes('/import')) return ['csp-import'];
    if (route.includes('/folders') && method !== 'GET') return ['csp-manage-folders'];
    if (route.includes('/analytics')) return ['csp-analytics'];
    if (method === 'POST') return ['csp-create'];
    if (method === 'PUT' || method === 'PATCH') return ['csp-edit'];
    if (method === 'DELETE') return ['csp-delete'];
    return ['csp-view'];
  }
  const boundaries: Array<[string,string[]]> = [
    ['/inventory-units',['inventory-units-view']],
    ['/inventory-packs',['inventory-units-view']], ['/inventory-movements',['inventory','movements']],
    ['/supplier-ledger',['suppliers']],
    ['/purchase-orders',['purchase-view','purchase-create']], ['/supplier-returns',['suppliers-returns']],
    ['/supplier-return-statements',['suppliers-rs-view','suppliers-rs-create','suppliers-rs-edit','suppliers-rs-status','suppliers-rs-delete','suppliers-rs-export']],
    ['/vault',['vault']], ['/expenses',['expenses']], ['/complaints',['complaints']],
    ['/followups',['complaints']], ['/shopify',['shopify-orders']],
    ['/carrier-settlements',['carrier-settle-view']],
  ];
  return boundaries.find(([prefix]) => starts(prefix))?.[1] || null;
}
