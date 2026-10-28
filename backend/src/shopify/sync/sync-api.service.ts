import { Injectable } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.service';
import { digest, SyncAction } from './sync-plan';
const { createShopifyTokenProvider } = require('../../../scripts/shopify-token.cjs');

export class SyncApiError extends Error {
  constructor(message: string, public transient = false, public uncertain = false) { super(message); }
}
export const ORDER_QUERY = `query SyncOrder($id: ID!) {
  shop { id myshopifyDomain }
  order(id: $id) {
    id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus canMarkAsPaid
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    totalOutstandingSet { shopMoney { amount currencyCode } }
    totalRefundedSet { shopMoney { amount currencyCode } }
    transactions(first: 100) { id kind status }
    erpStatus: metafield(namespace: "soulia", key: "erp_sync") { value compareDigest }
    lineItems(first: 100) { nodes { id currentQuantity } pageInfo { hasNextPage } }
    fulfillments { id status displayStatus deliveredAt trackingInfo { number company url }
      fulfillmentLineItems(first: 100) { nodes { quantity lineItem { id } } pageInfo { hasNextPage } }
      events(first: 100, reverse: true) { nodes { id status happenedAt } pageInfo { hasNextPage } }
    }
    fulfillmentOrders(first: 100) { nodes { id status supportedActions { action }
      lineItems(first: 100) { nodes { id remainingQuantity lineItem { id } } pageInfo { hasNextPage } }
    } pageInfo { hasNextPage } }
  }
}`;

@Injectable()
export class ShopifySyncApiService {
  private tokens = createShopifyTokenProvider();
  constructor(private readonly settings: SettingsService) {}
  async identity() {
    const cfg = await this.settings.getShopifyConfig();
    return { store: cfg.storeName, appKey: digest([cfg.storeName, cfg.clientId || cfg.accessToken]) };
  }
  async query(query: string, variables: any = {}, mutation = false, renewed = false): Promise<any> {
    const c = await this.settings.getShopifyConfig();
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(c.storeName || '') || !(c.clientId && c.clientSecret || c.accessToken)) throw new SyncApiError('بيانات Shopify Admin API غير مكتملة.');
    let token: string;
    try { token = await this.tokens.getToken(c); } catch { throw new SyncApiError('تعذر تجديد اتصال Shopify. راجع بيانات التطبيق أو الاتصال.', true); }
    let res: Response;
    try {
      res = await fetch(`https://${c.storeName}.myshopify.com/admin/api/2026-10/graphql.json`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }),
      });
    } catch { throw new SyncApiError('انقطع الاتصال بـ Shopify؛ ستُراجع النتيجة قبل أي إعادة إرسال.', true, mutation); }
    if (res.status === 401 && !renewed && c.clientId) {
      this.tokens.invalidate(c, token);
      return this.query(query, variables, mutation, true);
    }
    if (!res.ok) throw new SyncApiError(res.status === 403 ? 'صلاحيات التطبيق لا تسمح بهذه العملية.' : `تعذر الاتصال بـ Shopify (${res.status}).`, res.status === 429 || res.status >= 500, mutation && res.status >= 500);
    let result: any;
    try { result = await res.json(); } catch { throw new SyncApiError('رد Shopify غير مكتمل؛ يلزم التحقق من النتيجة.', true, mutation); }
    if (result.errors?.length) {
      const throttled = result.errors.every((e: any) => e.extensions?.code === 'THROTTLED');
      const denied = result.errors.some((e: any) => e.extensions?.code === 'ACCESS_DENIED');
      throw new SyncApiError(throttled ? 'حد استخدام Shopify؛ ستتم إعادة المحاولة.' : denied ? 'صلاحية Shopify المطلوبة غير ممنوحة.' : 'تعذر تنفيذ طلب Shopify؛ راجع توافق بيانات العملية.', throttled, mutation && !throttled && !denied);
    }
    return result.data;
  }
  async connection() {
    const data = await this.query('query { shop { id myshopifyDomain } currentAppInstallation { accessScopes { handle } } }');
    const scopes = data.currentAppInstallation.accessScopes.map((s: any) => s.handle);
    return { ...await this.identity(), shopId: data.shop.id, domain: data.shop.myshopifyDomain, scopes,
      missing: ['write_orders', 'write_fulfillments', 'write_merchant_managed_fulfillment_orders'].filter(s => !scopes.includes(s)) };
  }
  async read(orderId: string, shopId: string) {
    if (!/^\d+$/.test(orderId)) throw new SyncApiError('معرّف Shopify غير صالح.');
    const data = await this.query(ORDER_QUERY, { id: `gid://shopify/Order/${orderId}` });
    if (data.shop.id !== shopId) throw new SyncApiError('تغير المتجر المتصل؛ أعد المعاينة.');
    return data.order;
  }
  async apply(action: SyncAction): Promise<void> {
    let data: any;
    if (action.kind === 'fulfill') data = await this.query('mutation($input: FulfillmentInput!) { fulfillmentCreate(fulfillment: $input) { fulfillment { id } userErrors { message } } }', { input: action.input }, true);
    if (action.kind === 'event') data = await this.query('mutation($input: FulfillmentEventInput!) { fulfillmentEventCreate(fulfillmentEvent: $input) { fulfillmentEvent { id } userErrors { message } } }', { input: action.input }, true);
    if (action.kind === 'tracking') data = await this.query('mutation($id: ID!, $input: FulfillmentTrackingInput!) { fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $input, notifyCustomer: false) { fulfillment { id } userErrors { message } } }', {
      id: action.input.fulfillmentId, input: { company: 'Bosta', number: action.input.tracking, url: `https://bosta.co/tracking/${encodeURIComponent(action.input.tracking)}` },
    }, true);
    if (action.kind === 'payment') data = await this.query('mutation($input: OrderMarkAsPaidInput!) { orderMarkAsPaid(input: $input) { order { id } userErrors { message } } }', { input: { id: action.input.id } }, true);
    if (action.kind === 'metadata') data = await this.query('mutation($input: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $input) { metafields { id } userErrors { message } } }', { input: [action.input] }, true);
    const payload: any = Object.values(data || {})[0];
    if (!payload) throw new SyncApiError('تعذر تأكيد نتيجة Shopify.', true, true);
    if (payload.userErrors?.length) throw new SyncApiError('Shopify رفض العملية؛ أعد المعاينة لمراجعة الحالة أو الصلاحيات.');
  }
}
