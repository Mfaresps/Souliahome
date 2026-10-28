import { Injectable, Logger, Optional } from '@nestjs/common';
import * as https from 'https';
import { SettingsService } from '../settings/settings.service';
import { ShopifySyncService } from './sync/sync.service';
const { createShopifyTokenProvider } = require('../../scripts/shopify-token.cjs');

export interface ShopifyAdminConfig {
  storeName: string;   // e.g. "soulia-2"
  accessToken: string; // shpat_...
  clientId?: string;
  clientSecret?: string;
}

@Injectable()
export class ShopifyAdminService {
  private readonly logger = new Logger(ShopifyAdminService.name);
  private readonly tokenProvider = createShopifyTokenProvider();

  constructor(@Optional() private readonly settingsService?: SettingsService,
    @Optional() private readonly sync?: ShopifySyncService) {}

  private async getConfig(): Promise<ShopifyAdminConfig | null> {
    const stored = await this.settingsService?.getShopifyConfig();
    const storeName   = stored?.storeName || process.env.SHOPIFY_STORE_NAME || '';
    let accessToken = stored?.accessToken || process.env.SHOPIFY_ACCESS_TOKEN || '';
    const clientId = stored?.clientId || process.env.SHOPIFY_CLIENT_ID || '';
    const clientSecret = stored?.clientSecret || process.env.SHOPIFY_CLIENT_SECRET || '';
    if (clientId || clientSecret) {
      if (!storeName || !clientId || !clientSecret) return null;
      try { accessToken = await this.tokenProvider.getToken({ storeName, clientId, clientSecret }); }
      catch (error) { this.logger.warn(error.message); return null; }
      return { storeName, accessToken, clientId, clientSecret };
    }
    if (!storeName || !accessToken) return null;
    return { storeName, accessToken };
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    config?: ShopifyAdminConfig,
    retried = false,
  ): Promise<T> {
    const cfg = config || await this.getConfig();
    if (!cfg) return Promise.reject(new Error('Shopify Admin API غير مضبوط — أضف SHOPIFY_STORE_NAME و SHOPIFY_ACCESS_TOKEN في .env'));

    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const options: https.RequestOptions = {
        hostname: `${cfg.storeName}.myshopify.com`,
        path: `/admin/api/2024-01${path}`,
        method,
        headers: {
          'Content-Type':         'application/json',
          'X-Shopify-Access-Token': cfg.accessToken,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 401 && !retried && cfg.clientId && cfg.clientSecret) {
            this.tokenProvider.invalidate(cfg, cfg.accessToken);
            this.tokenProvider.getToken(cfg)
              .then((accessToken: string) => this.request<T>(method, path, body, { ...cfg, accessToken }, true))
              .then(resolve, reject);
            return;
          }
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed as T);
            } else {
              const msg = (parsed as any)?.errors
                ? JSON.stringify((parsed as any).errors)
                : `Shopify HTTP ${res.statusCode}`;
              const err: any = new Error(msg);
              err.statusCode = res.statusCode;
              err.shopifyErrors = (parsed as any)?.errors;
              reject(err);
            }
          } catch {
            reject(new Error(`Failed to parse Shopify response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ── Fulfill order with tracking number ─────────────────────────────────────
  // Uses the modern Fulfillment API (2022-07+): requires a fulfillment_order_id.
  // Step 1: GET fulfillment orders → Step 2: POST fulfillments
  async fulfillOrder(
    shopifyOrderId: string,
    trackingNumber: string,
    trackingCompany = 'Bosta',
    trackingUrl = '',
  ): Promise<{ success: boolean; fulfillmentId?: string; error?: string }> {
    // All automatic writes are governed by the persisted sync setting and queue.
    return this.sync ? this.sync.legacyRequest() : { success: false, error: 'Shopify sync is not configured' };
  }

  // ── Cancel order ────────────────────────────────────────────────────────────
  async cancelOrder(
    shopifyOrderId: string,
    reason: 'customer' | 'fraud' | 'inventory' | 'declined' | 'other' = 'other',
    email = false,
  ): Promise<{ success: boolean; error?: string }> {
    // All automatic writes are governed by the persisted sync setting and queue.
    return this.sync ? this.sync.legacyRequest() : { success: false, error: 'Shopify sync is not configured' };
  }

  // ── Update order note and tags ──────────────────────────────────────────────
  async updateOrderMeta(
    shopifyOrderId: string,
    fields: { note?: string; tags?: string },
  ): Promise<{ success: boolean; error?: string }> {
    const cfg = await this.getConfig();
    if (!cfg) {
      this.logger.warn('Shopify Admin API غير مضبوط — تم تخطي تحديث الملاحظات');
      return { success: false, error: 'Shopify Admin API غير مضبوط' };
    }

    if (!fields.note && fields.tags === undefined) return { success: true };

    try {
      const update: any = {};
      if (fields.note !== undefined) update.note = fields.note;
      if (fields.tags !== undefined) update.tags = fields.tags;

      await this.request<any>('PUT', `/orders/${shopifyOrderId}.json`, { order: update }, cfg);
      this.logger.log(`Shopify updated order meta ${shopifyOrderId}: ${JSON.stringify(fields)}`);
      return { success: true };
    } catch (err: any) {
      this.logger.error(`Shopify updateOrderMeta failed for ${shopifyOrderId}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ── Mark order as paid (used after COD collection confirmed) ───────────────
  async markOrderPaid(
    shopifyOrderId: string,
    amount: number,
    currency = 'EGP',
  ): Promise<{ success: boolean; error?: string }> {
    // All automatic writes are governed by the persisted sync setting and queue.
    return this.sync ? this.sync.legacyRequest() : { success: false, error: 'Shopify sync is not configured' };
  }

  // ── List orders from Shopify (for importing old/historical orders) ─────────
  async listOrders(params: {
    limit?: number;
    sinceId?: string;
    status?: 'open' | 'closed' | 'cancelled' | 'any';
    createdAtMin?: string;
    createdAtMax?: string;
    name?: string; // order number/name search e.g. "1023" or "#1023"
  } = {}): Promise<{ success: boolean; orders?: any[]; error?: string }> {
    const cfg = await this.getConfig();
    if (!cfg) {
      return { success: false, error: 'Shopify Admin API غير مضبوط' };
    }

    try {
      const query = new URLSearchParams();
      query.set('limit', String(params.limit || 50));
      query.set('status', params.status || 'any');
      if (params.sinceId) query.set('since_id', params.sinceId);
      if (params.createdAtMin) query.set('created_at_min', params.createdAtMin);
      if (params.createdAtMax) query.set('created_at_max', params.createdAtMax);

      // Shopify order search by name isn't supported on the standard orders.json
      // list endpoint, so when a name/number is given we fetch a larger page and
      // filter client-side.
      if (params.name) query.set('limit', '250');

      const res = await this.request<any>('GET', `/orders.json?${query.toString()}`, undefined, cfg);
      let orders: any[] = res.orders || [];

      if (params.name) {
        const needle = params.name.replace(/^#/, '').trim().toLowerCase();
        orders = orders.filter((o: any) => {
          const name = String(o.name || '').replace(/^#/, '').toLowerCase();
          const num = String(o.order_number || '');
          return name.includes(needle) || num.includes(needle);
        });
      }

      return { success: true, orders };
    } catch (err: any) {
      this.logger.error(`Shopify listOrders failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ── Get a single order by its Shopify ID ────────────────────────────────────
  async getOrder(shopifyOrderId: string): Promise<{ success: boolean; order?: any; error?: string }> {
    const cfg = await this.getConfig();
    if (!cfg) {
      return { success: false, error: 'Shopify Admin API غير مضبوط' };
    }

    try {
      const res = await this.request<any>('GET', `/orders/${shopifyOrderId}.json`, undefined, cfg);
      return { success: true, order: res.order };
    } catch (err: any) {
      this.logger.error(`Shopify getOrder failed for ${shopifyOrderId}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async isConfigured(): Promise<boolean> {
    return !!(await this.getConfig());
  }
}
