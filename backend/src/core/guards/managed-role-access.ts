/** Additional module boundary for accounts assigned to a managed RBAC role.
 * Existing per-action guards still make the final decision for write actions.
 * Legacy accounts without a roleId keep their existing access contract.
 */
export function managedRoleRequiredPermissions(path: string, method: string, body?: {type?: string}): string[] | null {
  const route = '/' + String(path || '').replace(/^\/+/, '').replace(/^api\//, '');
  const starts = (prefix: string) => route === prefix || route.startsWith(prefix + '/');
  if (starts('/transactions')) {
    if (route.startsWith('/transactions/carrier-statement/')) return ['carrier-import'];
    if (route.startsWith('/transactions/deposit-receipts/')) return ['transaction','shopify-deposit-upload'];
    if (route.startsWith('/transactions/inventory')) return ['inventory'];
    if (route.startsWith('/transactions/reports')) return ['reports'];
    if (route.startsWith('/transactions/movements-page') || route.startsWith('/transactions/summary-page') || route.startsWith('/transactions/archived')) return ['movements'];
    if (route.startsWith('/transactions/startup-overview') || route.startsWith('/transactions/dashboard-overview')) return ['dashboard','movements'];
    if (route.includes('/pickup-')) return ['pickup-orders'];
    if (route === '/transactions' && method === 'POST') return body?.type === 'مشتريات' ? ['purchase-create'] : ['transaction'];
    return ['movements','transaction','shopify-orders','pickup-orders'];
  }
  if (starts('/products')) {
    if (route.endsWith('/request-edit')) return ['products','inventory'];
    if (method === 'DELETE' || route.endsWith('/bulk-delete') || route.endsWith('/batch-delete')) return ['products-delete'];
    if (method === 'PUT' || method === 'PATCH' || route.endsWith('/bulk-update')) return ['products-edit'];
    if (method === 'POST') return ['products-create'];
    return ['products','inventory'];
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
    ['/vault',['vault']], ['/expenses',['expenses']], ['/complaints',['complaints']],
    ['/followups',['complaints']], ['/shopify',['shopify-orders']],
    ['/carrier-settlements',['carrier-settle-view']],
  ];
  return boundaries.find(([prefix]) => starts(prefix))?.[1] || null;
}
