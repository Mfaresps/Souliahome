// Existing, server-enforced SOULIA permission keys. Do not add a UI-only action here.
export const ACCESS_ROLE_PERMISSIONS = new Set([
  'dashboard','transaction','inventory','movements','clients','products','suppliers','expenses',
  'complaints','approvals','reports','reports-kpis','reports-charts','reports-discounts',
  'reports-orderaudit','reports-cancellations','reports-shipping','reports-export','carrier-import',
  'vault','users','settings','shopify-orders','shopify-prepare-ship','shopify-reassign',
  'shopify-cancel','shopify-cancel-request','shopify-deposit-upload','shopify-deposit-no-image','shopify-deposit-no-image-otp','shopify-edit-direct',
  'csp-view','csp-create','csp-edit','csp-delete','csp-manage-folders','csp-analytics',
  'csp-export','csp-import','delivery-manual-confirm','delivery-view-audit',
  'purchase-create','purchase-view','purchase-edit-price','categories-view','categories-create',
  'categories-edit','categories-delete','categories-assign-products','categories-link-suppliers',
  'pickup-orders','pickup-orders-edit','suppliers-tab-invoices','suppliers-tab-pos',
  'suppliers-tab-sreturns','suppliers-tab-payments','suppliers-tab-ledger','suppliers-tab-activity',
  'suppliers-pay','suppliers-deposit','suppliers-ledger-adjust','suppliers-write-off',
  'suppliers-reverse','suppliers-returns','carrier-settle-view','carrier-settle-run',
  'carrier-settle-approve','carrier-settle-reverse','products-sku-manage',
  'inventory-units-view','inventory-units-register','inventory-units-receive',
  'inventory-units-allocate','inventory-units-condition','inventory-units-reconcile',
  'inventory-units-reconcile-approve','inventory-units-print','inventory-units-manual-select',
  // Managed-role action keys. Legacy per-user grants remain unchanged.
  'products-create','products-edit','products-delete',
  'suppliers-create','suppliers-edit','suppliers-delete',
  // Promotions page (Nov 12, 2026) — see promotions/promotion-perms.ts.
  'promotions-view','promotions-offers','promotions-codes','promotions-bundles','promotions-tags','promotions-audit',
  // «بيانات المرتجعات» (Nov 13, 2026) — documentation only, see supplier-return-statements/.
  'suppliers-rs-view','suppliers-rs-create','suppliers-rs-edit','suppliers-rs-status','suppliers-rs-delete','suppliers-rs-export',
]);

// These routes use the legacy admin guard rather than a delegable permission.
export const NON_DELEGABLE_PERMISSIONS = new Set(['users', 'settings']);
export const VIEWER_PERMISSIONS = new Set([
  'dashboard','inventory','products','movements','clients','suppliers','complaints','reports',
  'reports-kpis','reports-charts','reports-discounts','reports-orderaudit',
  'reports-cancellations','reports-shipping','categories-view','pickup-orders',
  'shopify-orders','csp-view','purchase-view','inventory-units-view',
  'suppliers-tab-invoices','suppliers-tab-pos','suppliers-tab-sreturns',
  'suppliers-tab-payments','suppliers-tab-ledger','suppliers-tab-activity',
  'carrier-settle-view','delivery-view-audit','promotions-view','suppliers-rs-view',
]);

export function validateRolePermissionTier(baseRole: 'staff' | 'viewer', perms: string[]) {
  if (perms.some(key => NON_DELEGABLE_PERMISSIONS.has(key)
    || (baseRole === 'viewer' && !VIEWER_PERMISSIONS.has(key)))) {
    throw new Error('Permission is restricted for this access tier');
  }
}

export function normalizeRolePermissions(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !ACCESS_ROLE_PERMISSIONS.has(item))) {
    throw new Error('Unknown permission');
  }
  const perms = [...new Set(value as string[])];
  if (perms.includes('pickup-orders-edit') && !perms.includes('pickup-orders')) perms.push('pickup-orders');
  if (perms.includes('shopify-prepare-ship') && !perms.includes('shopify-orders')) perms.push('shopify-orders');
  // The no-image entry opens from the deposit-upload dialog, so it implies that perm.
  if (perms.some(key => key === 'shopify-deposit-no-image' || key === 'shopify-deposit-no-image-otp')) {
    if (!perms.includes('shopify-deposit-upload')) perms.push('shopify-deposit-upload');
    if (!perms.includes('shopify-orders')) perms.push('shopify-orders');
  }
  if (perms.some(key => ['products-create','products-edit','products-delete'].includes(key)) && !perms.includes('products')) perms.push('products');
  if (perms.some(key => ['products-create','products-delete'].includes(key)) && !perms.includes('products-sku-manage')) perms.push('products-sku-manage');
  if (perms.some(key => ['suppliers-create','suppliers-edit','suppliers-delete'].includes(key)) && !perms.includes('suppliers')) perms.push('suppliers');
  if (perms.some(key => key.startsWith('reports-')) && !perms.includes('reports')) perms.push('reports');
  // Every promotions action is done on the promotions page, so it implies opening it.
  if (perms.some(key => key.startsWith('promotions-') && key !== 'promotions-view') && !perms.includes('promotions-view')) perms.push('promotions-view');
  return perms;
}
