import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as https from 'https';
import {
  Transaction,
  TransactionDocument,
} from '../transactions/schemas/transaction.schema';
import {
  ShopifyOrder,
  ShopifyOrderDocument,
} from '../shopify/schemas/shopify-order.schema';
import { PresenceGateway } from '../auth/presence.gateway';
import { SettingsService } from '../settings/settings.service';

// ── Bosta status → Arabic label map ────────────────────────────────────────
const BOSTA_STATUS_LABELS: Record<string, string> = {
  CREATED:           'تم الإنشاء',
  PICKED_UP:         'تم الاستلام',
  IN_TRANSIT:        'في الطريق',
  OUT_FOR_DELIVERY:  'خارج للتسليم',
  DELIVERED:         'تم التسليم',
  RETURNED:          'مرتجع',
  CANCELLED:         'ملغي',
  FAILED_ATTEMPT:    'محاولة فاشلة',
};

// Bosta numeric state codes → string status
const BOSTA_STATE_CODE_MAP: Record<number, string> = {
  10: 'CREATED',
  20: 'PICKED_UP',
  30: 'IN_TRANSIT',
  40: 'OUT_FOR_DELIVERY',
  45: 'OUT_FOR_DELIVERY',
  50: 'DELIVERED',
  60: 'RETURNED',
  70: 'CANCELLED',
  80: 'FAILED_ATTEMPT',
};

function resolveBostaStatus(d: any, res: any): string {
  // Prefer string code if available
  const strCode = d.currentStatus?.code || d.state?.code;
  if (typeof strCode === 'string') return strCode;
  // Map numeric code
  const numCode = typeof d.state?.code === 'number' ? d.state.code
    : typeof res.currentStatus?.code === 'number' ? res.currentStatus.code : null;
  if (numCode !== null && BOSTA_STATE_CODE_MAP[numCode]) return BOSTA_STATE_CODE_MAP[numCode];
  return 'CREATED';
}

export interface BostaCreateResult {
  success: boolean;
  bostaOrderId?: string;
  trackingNumber?: string;
  error?: string;
}

export interface BostaTrackResult {
  success: boolean;
  status?: string;
  statusLabel?: string;
  raw?: Record<string, unknown>;
  error?: string;
}

@Injectable()
export class BostaService {
  private readonly logger = new Logger(BostaService.name);
  private readonly BASE_URL = 'https://api.bosta.co/api/v0';

  constructor(
    @InjectModel(Transaction.name)
    private readonly txModel: Model<TransactionDocument>,
    @InjectModel(ShopifyOrder.name)
    private readonly shopifyOrderModel: Model<ShopifyOrderDocument>,
    private readonly presence: PresenceGateway,
    private readonly settingsService: SettingsService,
  ) {}

  private async resolveApiKey(): Promise<string> {
    try {
      const dbKey = await this.settingsService.getBostaApiKey();
      if (dbKey) return dbKey;
    } catch { /* fall through to env */ }
    return process.env.BOSTA_API_KEY || '';
  }

  private emit(event: string, payload: unknown): void {
    try { this.presence?.emitEvent(event, payload); } catch { /* swallow */ }
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────

  private request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    apiKey?: string,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const url = new URL(`${this.BASE_URL}${path}`);
      const options: https.RequestOptions = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': apiKey || '',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed as T);
            } else {
              reject(new Error(parsed?.message || parsed?.error || `HTTP ${res.statusCode}`));
            }
          } catch {
            reject(new Error(`Failed to parse Bosta response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ── Create Bosta order from a transaction ──────────────────────────────

  async createOrder(txId: string, operatorName: string): Promise<BostaCreateResult> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) {
      return { success: false, error: 'Bosta API Key غير مضبوط — أضفه من الإعدادات > الشحن' };
    }

    const tx = await this.txModel.findById(txId).lean();
    if (!tx) return { success: false, error: 'الحركة غير موجودة' };
    if (tx.type !== 'مبيعات') return { success: false, error: 'الشحن متاح للمبيعات فقط' };
    if (tx.bostaOrderId) return { success: false, error: 'تم إرسال هذا الطلب إلى Bosta مسبقاً' };

    const phoneClean = (tx.phone || '').replace(/\D/g, '');

    // Resolve address — try tx.shippingAddress first, then fallback to shopify rawData
    let firstLine = ((tx as any).shippingAddress || '').replace(/^العنوان:\s*/, '').trim();
    let city      = ((tx as any).shippingCity || tx.shipZone || '').trim();

    if ((!firstLine || !city) && (tx as any).shopifyOrderId) {
      const shopifyOrder = await this.shopifyOrderModel
        .findOne({ shopifyId: (tx as any).shopifyOrderId })
        .lean() as any;
      if (shopifyOrder) {
        const addr = shopifyOrder.rawData?.shipping_address as any;
        if (!firstLine) {
          firstLine = [addr?.address1, addr?.address2].filter(Boolean).join('، ');
        }
        if (!city) {
          city = addr?.city || addr?.province || '';
        }
        // also patch tx for future calls
        if (firstLine || city) {
          await this.txModel.findByIdAndUpdate(txId, {
            shippingAddress: firstLine,
            shippingCity: city,
          });
        }
      }
    }

    this.logger.log(`Bosta address resolve — txId=${txId} firstLine="${firstLine}" city="${city}" shopifyOrderId="${(tx as any).shopifyOrderId || ''}"`);

    if (!city) city = 'Cairo';

    // وصف المنتج — يظهر في حقل "وصف المنتج" في Bosta
    this.logger.log(`Bosta items raw — txId=${txId} items=${JSON.stringify(tx.items)}`);
    const packageDescription = (tx.items as any[] || [])
      .map((it: any) => {
        const name = it.name || it.productName || it.title || it.itemName || '';
        const code = it.code || it.productCode || it.sku || '';
        const qty  = it.qty  || it.quantity    || 1;
        return `${name}${code ? ` (${code})` : ''} × ${qty}`;
      })
      .join(' | ');

    // Business reference
    const businessRef = tx.ref ? tx.ref : String(tx._id);

    const payload: Record<string, unknown> = {
      type: 10, // SEND (deliver to customer)
      specs: {
        packageType: 'Parcel',
        size: 'MEDIUM',
        weight: this.calcWeight(tx.items as any[]),
        packageDescription,
      },
      notes: tx.notes || '',
      cod: tx.remaining || 0,
      dropOffAddress: {
        city,
        firstLine,
        phone: phoneClean || '01000000000',
      },
      receiver: {
        firstName: (tx.client || 'عميل').split(' ')[0],
        lastName: (tx.client || '').split(' ').slice(1).join(' ') || '-',
        phone: phoneClean || '01000000000',
      },
      businessReference: businessRef,
    };

    try {
      this.logger.log(`Bosta sending payload — ${JSON.stringify(payload)}`);
      const res = await this.request<any>('POST', '/deliveries', payload, apiKey);
      this.logger.log(`Bosta createOrder raw response — ${JSON.stringify(res)}`);
      this.logger.log(`Bosta createOrder response keys — top: [${Object.keys(res).join(',')}] data: [${Object.keys(res.data || {}).join(',')}]`);

      const d = res.data || res;
      // Bosta returns internal _id (MongoDB ObjectId ~24 chars) used in GET /deliveries/:id
      // trackingNumber is a separate short alphanumeric for customer-facing tracking
      const bostaOrderId     = String(d._id || d.id || d.deliveryId || d.orderId || '');
      const trackingNumber   = String(d.trackingNumber || d.waybillNumber || d.TrackingNumber || '');
      this.logger.log(`Bosta createOrder extracted — bostaOrderId="${bostaOrderId}" trackingNumber="${trackingNumber}"`);
      const statusCode  = resolveBostaStatus(d, res);
      const statusLabel = BOSTA_STATUS_LABELS[statusCode] || statusCode;

      await this.txModel.findByIdAndUpdate(txId, {
        bostaOrderId,
        bostaTrackingNumber: trackingNumber,
        bostaStatus: statusCode,
        bostaStatusLabel: statusLabel,
        bostaLastSync: new Date().toISOString(),
        bostaRawResponse: res,
      });

      this.logger.log(`Bosta order created: tx=${txId} bostaId=${bostaOrderId} tracking=${trackingNumber}`);
      this.emit('tx:updated', { _id: txId });

      return { success: true, bostaOrderId, trackingNumber };
    } catch (err: any) {
      this.logger.error(`Bosta createOrder failed tx=${txId}: ${err.message} | stack: ${err.stack}`);
      return { success: false, error: err.message };
    }
  }

  // ── Sync status for a single transaction ──────────────────────────────

  async syncStatus(txId: string): Promise<BostaTrackResult> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) return { success: false, error: 'Bosta API Key غير مضبوط' };

    const tx = await this.txModel.findById(txId).lean();
    if (!tx) return { success: false, error: 'الحركة غير موجودة' };
    if (!tx.bostaOrderId) return { success: false, error: 'لم يتم ربط هذا الطلب بـ Bosta بعد' };

    try {
      this.logger.log(`Bosta syncStatus — bostaOrderId=${tx.bostaOrderId}`);
      const res = await this.request<any>('GET', `/deliveries/${tx.bostaOrderId}`, undefined, apiKey);
      this.logger.log(`Bosta syncStatus raw response — ${JSON.stringify(res)}`);
      const d = res.data || res;
      const statusCode  = resolveBostaStatus(d, res);
      const statusLabel = BOSTA_STATUS_LABELS[statusCode] || statusCode;

      await this.txModel.findByIdAndUpdate(txId, {
        bostaStatus: statusCode,
        bostaStatusLabel: statusLabel,
        bostaLastSync: new Date().toISOString(),
        bostaRawResponse: res,
      });

      this.emit('tx:updated', { _id: txId });
      return { success: true, status: statusCode, statusLabel, raw: res };
    } catch (err: any) {
      this.logger.error(`Bosta syncStatus failed tx=${txId}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ── Bulk sync all unfinished Bosta orders ──────────────────────────────

  async syncAll(): Promise<{ synced: number; errors: number }> {
    const TERMINAL = ['DELIVERED', 'RETURNED', 'CANCELLED'];
    const txList = await this.txModel
      .find({
        bostaOrderId: { $exists: true, $ne: '' },
        bostaStatus: { $nin: TERMINAL },
      })
      .lean();

    let synced = 0;
    let errors = 0;

    for (const tx of txList) {
      const result = await this.syncStatus(String(tx._id));
      if (result.success) synced++; else errors++;
    }

    this.logger.log(`Bosta bulk sync complete: synced=${synced} errors=${errors}`);
    return { synced, errors };
  }

  // ── Cancel a Bosta order ───────────────────────────────────────────────

  async cancelOrder(txId: string): Promise<{ success: boolean; error?: string }> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) return { success: false, error: 'Bosta API Key غير مضبوط' };

    const tx = await this.txModel.findById(txId).lean();
    if (!tx?.bostaOrderId) return { success: false, error: 'لا يوجد طلب Bosta مرتبط' };

    try {
      await this.request('PUT', `/deliveries/${tx.bostaOrderId}/terminate`, {}, apiKey);

      await this.txModel.findByIdAndUpdate(txId, {
        bostaStatus: 'CANCELLED',
        bostaStatusLabel: 'ملغي',
        bostaLastSync: new Date().toISOString(),
      });

      this.emit('tx:updated', { _id: txId });
      return { success: true };
    } catch (err: any) {
      this.logger.error(`Bosta cancelOrder failed tx=${txId}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ── Fix corrupted status values (e.g. numeric "10" saved as status) ──────

  async fixCorruptedStatuses(): Promise<{ fixed: number }> {
    const result = await this.txModel.updateMany(
      { bostaOrderId: { $exists: true, $ne: '' }, bostaStatus: { $not: /^[A-Z_]+$/ } },
      { $set: { bostaStatus: 'CREATED', bostaStatusLabel: 'تم الإنشاء' } },
    );
    this.logger.log(`fixCorruptedStatuses: fixed ${result.modifiedCount} records`);
    return { fixed: result.modifiedCount };
  }

  // ── Helper: estimate total weight from items ───────────────────────────

  private calcWeight(items: Array<{ qty: number; weight?: number }>): number {
    const total = (items || []).reduce((s, i) => s + (i.qty || 1) * (i.weight || 0.5), 0);
    return Math.max(0.5, Math.round(total * 10) / 10);
  }
}
