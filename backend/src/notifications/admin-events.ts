import { createHash } from 'crypto';
import type { NotificationsService, NotificationDetails } from './notifications.service';

export async function notifyApproval(push: NotificationsService | undefined, eventId: string, ref: string, record: string, details: NotificationDetails) {
  try { await push?.enqueue('approval', eventId, ref, record, undefined, undefined, details); }
  catch { /* Business state is committed; push is best effort. */ }
}

// Labels are controlled by the server; never copy passwords, addresses or audit details into push.
export const ADMIN_TYPES = ['deposit', 'otp', 'approval', 'shopifyChange', 'security'] as const;
export const ACTIONS: Record<string, [string, string]> = {
  discount: ['طلب خصم', 'Discount request'], purchase: ['اعتماد مشتريات', 'Purchase approval'],
  'import-products': ['استيراد منتجات', 'Import products'], 'delete-product': ['حذف منتج', 'Delete product'],
  'delete-supplier': ['حذف مورد', 'Delete supplier'], 'supplier-pay': ['دفع لمورد', 'Supplier payment'],
  'vault-access': ['فتح الخزنة', 'Open cash register'], 'add-product': ['إضافة منتج', 'Add product'],
  'export-excel': ['تصدير بيانات', 'Export data'], 'edit-tx': ['تعديل فاتورة', 'Modify invoice'],
  cancel: ['إلغاء طلب', 'Cancel order'], deposit: ['اعتماد عربون', 'Deposit approval'],
  order: ['تحضير وشحن', 'Prepare & Ship'], return: ['طلب استرجاع', 'Return request'],
  vault: ['اعتماد حركة خزنة', 'Cash register approval'],
  product: ['تعديل منتج', 'Modify product'], expense: ['اعتماد مصروف', 'Expense approval'],
  'supplier-return': ['مرتجع مورد', 'Supplier return approval'],
  'edit-shopify': ['تعديل طلب شوبيفاي', 'Shopify order edit'],
  failed_login: ['فشل تسجيل الدخول', 'Failed login'], account_locked: ['قفل حساب', 'Account locked'],
  otp_violation: ['فشل التحقق من OTP', 'OTP verification failed'], vault_violation: ['محاولة دخول الخزنة', 'Cash register access violation'],
  unauthorized_access: ['محاولة وصول غير مصرح', 'Unauthorized access'], settings_tampering: ['محاولة تعديل إعدادات', 'Settings access violation'],
  account_unlocked: ['إلغاء قفل حساب', 'Account unlocked'], export_excel: ['تصدير بيانات', 'Data export'],
};
export function actionLabel(key: string | undefined, language: 'ar' | 'en') {
  return (ACTIONS[key || ''] || ['إجراء بالنظام', 'System action'])[language === 'en' ? 1 : 0];
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value ?? null;
}
export function shopifySnapshot(order: any): Record<string, any> {
  const lines = (order?.line_items || []).map((line: any) => ({
    id: String(line.id || line.variant_id || line.product_id || line.sku || ''),
    product: [String(line.product_id || ''), String(line.variant_id || ''), String(line.sku || ''), String(line.title || '')],
    quantity: Number(line.quantity || 0), price: Number(line.price || 0),
  })).sort((a: any, b: any) => a.id.localeCompare(b.id));
  const address = order?.shipping_address || {};
  return {
    address: ['first_name', 'last_name', 'address1', 'address2', 'city', 'province', 'zip', 'country', 'phone'].map(key => String(address[key] || '').trim()),
    products: lines.map(({ id, product }: any) => ({ id, product })),
    quantity: lines.map(({ id, quantity }: any) => ({ id, quantity })),
    price: { total: Number(order?.total_price || 0), lines: lines.map(({ id, price }: any) => ({ id, price })) },
    shipping: (order?.shipping_lines || []).map((line: any) => Number(line.price || 0)).sort(),
    discount: Number(order?.total_discounts || 0), notes: String(order?.note || ''),
    tags: String(order?.tags || '').split(',').map((tag: string) => tag.trim()).filter(Boolean).sort(),
    payment: String(order?.financial_status || ''), fulfillment: String(order?.fulfillment_status || ''),
    cancelled: String(order?.cancelled_at || ''),
    customer: [String(order?.email || ''), String(order?.phone || ''), canonical(order?.customer || null)],
    billingAddress: canonical(order?.billing_address || null), currency: String(order?.currency || ''),
    // Additional Shopify business fields still alert; transport metadata and timestamps do not.
    other: canonical(Object.fromEntries(Object.entries(order || {}).filter(([key]) => ![
      'id', 'updated_at', 'created_at', 'processed_at', 'admin_graphql_api_id', 'app_id', 'browser_ip',
      'checkout_id', 'checkout_token', 'client_details', 'confirmation_number', 'token', 'order_status_url',
      'source_identifier', 'source_name', 'source_url', 'landing_site', 'landing_site_ref', 'referring_site',
      'user_id', 'test', 'number', 'order_number', 'name', 'line_items', 'shipping_address', 'shipping_lines',
      'total_price', 'total_discounts', 'note', 'tags', 'financial_status', 'fulfillment_status', 'cancelled_at',
      'email', 'phone', 'customer', 'billing_address', 'currency',
    ].includes(key)))),
  };
}
export function shopifyChangeEvent(previous: any, next: any) {
  if (!previous) return { fields: [], fingerprint: '' };
  const before = shopifySnapshot(previous), after = shopifySnapshot(next);
  const fields = Object.keys(after).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  return { fields, fingerprint: createHash('sha256').update(JSON.stringify([next.id, next.updated_at || '', before, after])).digest('hex') };
}
export const FIELD_LABELS: Record<string, [string, string]> = {
  address: ['العنوان', 'Address'], products: ['المنتجات', 'Products'], quantity: ['الكمية', 'Quantity'], price: ['السعر', 'Price'],
  shipping: ['الشحن', 'Shipping'], discount: ['الخصم', 'Discount'], notes: ['الملاحظات', 'Notes'], tags: ['الوسوم', 'Tags'],
  payment: ['حالة الدفع', 'Payment status'], fulfillment: ['حالة التنفيذ', 'Fulfillment status'], cancelled: ['الإلغاء', 'Cancellation'],
  customer: ['بيانات العميل', 'Customer details'], billingAddress: ['عنوان الفاتورة', 'Billing address'], currency: ['العملة', 'Currency'], other: ['بيانات الطلب الأخرى', 'Other order details'],
};
