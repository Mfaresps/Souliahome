import { SHOPIFY_REPORT_RANGE_KEYS, SHOPIFY_REPORT_SHARE } from '../shared/shopify-report-access.util';

// Existing, server-enforced SOULIA permission keys. Do not add a UI-only action here.
export const ACCESS_ROLE_PERMISSIONS = new Set([
  'dashboard','assistant','transaction','inventory','movements','clients','products','suppliers','expenses',
  'complaints','approvals','reports','reports-kpis','reports-charts','reports-discounts',
  'reports-orderaudit','reports-cancellations','reports-shipping','reports-export','carrier-import',
  'vault','users','settings','shopify-orders','shopify-prepare-ship','shopify-reassign',
  'shopify-cancel','shopify-cancel-request','shopify-deposit-upload','shopify-deposit-no-image','shopify-deposit-no-image-otp','shopify-edit-direct','shopify-bundle-discount-override',
  'csp-view','csp-create','csp-edit','csp-delete','csp-manage-folders','csp-analytics',
  'csp-export','csp-import','delivery-manual-confirm','delivery-view-audit',
  'purchase-create','purchase-view','purchase-edit-price','categories-view','categories-create',
  'categories-edit','categories-delete','categories-assign-products','categories-link-suppliers',
  'products-supplier-view','products-analytics','products-specs-view','products-specs-manage','approvals-history','approvals-otp-log','data-export','clients-browse','movements-filters','sales-collect','movements-browse','movements-collections','inventory-log-browse','customers-phone-view',
  'delivery-issues-follow','delivery-issues-close','products-cost-view','products-edit-otp','products-price-sell','categories-edit-otp',
  'pickup-orders','pickup-orders-prepare','pickup-orders-move','pickup-orders-cancel','pickup-orders-bosta','pickup-orders-bosta-cancel','suppliers-tab-invoices','suppliers-tab-pos',
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
  // Shopify page reports (Nov 26, 2026) — see shared/shopify-report-access.util.ts.
  ...SHOPIFY_REPORT_RANGE_KEYS, SHOPIFY_REPORT_SHARE,
]);

// These routes use the legacy admin guard rather than a delegable permission.
export const NON_DELEGABLE_PERMISSIONS = new Set(['users', 'settings']);
/** Pick-Up / preparation actions (Nov 24, 2026) — they replaced the single `pickup-orders-edit`.
 *  prepare = scan + approve preparation · move = create/move/merge/split cards, to Ready and back ·
 *  cancel = send a card back to Pending · bosta = send to Bosta, labels, pickup requests ·
 *  bosta-cancel = cancel a shipment at Bosta. */
export const PICKUP_ACTION_PERMISSIONS = ['pickup-orders-prepare','pickup-orders-move','pickup-orders-cancel','pickup-orders-bosta','pickup-orders-bosta-cancel'];
export const LEGACY_PICKUP_EDIT = 'pickup-orders-edit';

export const VIEWER_PERMISSIONS = new Set([
  'dashboard','assistant','inventory','products','movements','clients','suppliers','complaints','reports',
  'reports-kpis','reports-charts','reports-discounts','reports-orderaudit',
  'reports-cancellations','reports-shipping','categories-view','pickup-orders',
  'shopify-orders','csp-view','purchase-view','inventory-units-view',
  'suppliers-tab-invoices','suppliers-tab-pos','suppliers-tab-sreturns',
  'suppliers-tab-payments','suppliers-tab-ledger','suppliers-tab-activity',
  'carrier-settle-view','delivery-view-audit','promotions-view','suppliers-rs-view',
  ...SHOPIFY_REPORT_RANGE_KEYS,
]);

export function validateRolePermissionTier(baseRole: 'staff' | 'viewer', perms: string[]) {
  if (perms.some(key => NON_DELEGABLE_PERMISSIONS.has(key)
    || (baseRole === 'viewer' && !VIEWER_PERMISSIONS.has(key)))) {
    throw new Error('Permission is restricted for this access tier');
  }
}

export function normalizeRolePermissions(value: unknown): string[] {
  // A save carrying the pre-split key (a page opened before Nov 24, 2026) becomes the five new keys.
  if (Array.isArray(value) && value.includes(LEGACY_PICKUP_EDIT)) {
    value = [...value.filter(key => key !== LEGACY_PICKUP_EDIT), ...PICKUP_ACTION_PERMISSIONS];
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !ACCESS_ROLE_PERMISSIONS.has(item))) {
    throw new Error('Unknown permission');
  }
  const perms = [...new Set(value as string[])];
  // Every Pick-Up action is done on the Pick-Up page, so it implies viewing it.
  if (perms.some(key => PICKUP_ACTION_PERMISSIONS.includes(key)) && !perms.includes('pickup-orders')) perms.push('pickup-orders');
  if (perms.includes('shopify-prepare-ship') && !perms.includes('shopify-orders')) perms.push('shopify-orders');
  // The no-image entry opens from the deposit-upload dialog, so it implies that perm.
  if (perms.some(key => key === 'shopify-deposit-no-image' || key === 'shopify-deposit-no-image-otp')) {
    if (!perms.includes('shopify-deposit-upload')) perms.push('shopify-deposit-upload');
    if (!perms.includes('shopify-orders')) perms.push('shopify-orders');
  }
  // Shopify reports live on the Shopify page. Sharing a report needs a window to read it in —
  // the narrowest one (today) when no range was chosen.
  if (perms.includes(SHOPIFY_REPORT_SHARE) && !perms.some(key => SHOPIFY_REPORT_RANGE_KEYS.includes(key))) perms.push('shopify-reports-today');
  if (perms.some(key => key === SHOPIFY_REPORT_SHARE || SHOPIFY_REPORT_RANGE_KEYS.includes(key))
    && !perms.includes('shopify-orders')) perms.push('shopify-orders');
  if (perms.some(key => ['products-create','products-edit','products-delete','products-edit-otp','products-price-sell','products-cost-view','products-supplier-view','products-analytics'].includes(key)) && !perms.includes('products')) perms.push('products');
  // Editing the purchase price means seeing it.
  if (perms.includes('purchase-edit-price') && !perms.includes('products-cost-view')) perms.push('products-cost-view');
  if (perms.includes('categories-edit-otp') && !perms.includes('categories-view')) perms.push('categories-view');
  // Tech packs live on the products page; managing them means seeing them.
  if (perms.includes('products-specs-manage') && !perms.includes('products-specs-view')) perms.push('products-specs-view');
  if (perms.includes('products-specs-view') && !perms.includes('products')) perms.push('products');
  // Both approvals-page tabs open from the approvals page.
  if (perms.some(key => key === 'approvals-history' || key === 'approvals-otp-log') && !perms.includes('approvals')) perms.push('approvals');
  if (perms.includes('clients-browse') && !perms.includes('clients')) perms.push('clients');
  if (perms.includes('movements-filters') && !perms.includes('movements')) perms.push('movements');
  if (perms.includes('movements-browse') && !perms.includes('movements')) perms.push('movements');
  if (perms.includes('movements-collections') && !perms.includes('movements')) perms.push('movements');
  if (perms.includes('inventory-log-browse') && !perms.includes('inventory')) perms.push('inventory');
  if (perms.some(key => ['products-create','products-delete'].includes(key)) && !perms.includes('products-sku-manage')) perms.push('products-sku-manage');
  if (perms.some(key => ['suppliers-create','suppliers-edit','suppliers-delete'].includes(key)) && !perms.includes('suppliers')) perms.push('suppliers');
  if (perms.some(key => key.startsWith('reports-')) && !perms.includes('reports')) perms.push('reports');
  // Every promotions action is done on the promotions page, so it implies opening it.
  if (perms.some(key => key.startsWith('promotions-') && key !== 'promotions-view') && !perms.includes('promotions-view')) perms.push('promotions-view');
  return perms;
}
