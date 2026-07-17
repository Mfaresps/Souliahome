import { Injectable, Logger, BadRequestException } from '@nestjs/common';
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
import { VaultService } from '../vault/vault.service';
import { ShopifyAdminService } from '../shopify/shopify-admin.service';
import { normalizeCity } from '../shared/normalize-city.util';

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
  DELETED:           'محذوف من Bosta',
  VALIDATION_ERROR:  'خطأ في البيانات',
  UNKNOWN:           'غير معروف',
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

// Bosta API status → granular bostaShippingStatus stored on Transaction
const BOSTA_TO_SHIPPING_STATUS: Record<string, string> = {
  CREATED:           'Created',
  PICKED_UP:         'PickedUp',
  IN_TRANSIT:        'InTransit',
  OUT_FOR_DELIVERY:  'OutForDelivery',
  DELIVERED:         'Delivered',
  RETURNED:          'Returned',
  CANCELLED:         'Cancelled',
  FAILED_ATTEMPT:    'InTransit',  // stays in transit on failed attempt
};


function resolveBostaStatus(d: any, res: any): string {
  // Prefer string code if available
  const strCode = d.currentStatus?.code || d.state?.code;
  if (typeof strCode === 'string') return strCode;
  // Map numeric code
  const numCode = typeof d.state?.code === 'number' ? d.state.code
    : typeof res.currentStatus?.code === 'number' ? res.currentStatus.code : null;
  if (numCode !== null && BOSTA_STATE_CODE_MAP[numCode]) return BOSTA_STATE_CODE_MAP[numCode];
  // Only return CREATED if the delivery data actually exists and has a valid id
  if (d._id || d.id || d.deliveryId) return 'CREATED';
  return 'UNKNOWN';
}

export interface BostaCreateResult {
  success: boolean;
  bostaOrderId?: string;
  trackingNumber?: string;
  error?: string;
  code?: string;
}

export interface BostaTrackResult {
  success: boolean;
  status?: string;
  statusLabel?: string;
  raw?: Record<string, unknown>;
  error?: string;
  code?: string;
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
    private readonly vaultService: VaultService,
    private readonly shopifyAdmin: ShopifyAdminService,
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
              const msg = parsed?.message || parsed?.error || `HTTP ${res.statusCode}`;
              const err: any = new Error(msg);
              err.statusCode = res.statusCode;
              // Bosta returns 422 for validation errors
              if (res.statusCode === 422 || (parsed?.validationErrors)) {
                err.code = 'VALIDATION_ERROR';
                err.details = parsed?.validationErrors || parsed?.details || msg;
              } else if (res.statusCode === 404) {
                err.code = 'NOT_FOUND';
              }
              reject(err);
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
    const resendableStatuses = ['VALIDATION_ERROR', 'DELETED'];
    const isResendable = resendableStatuses.includes(tx.bostaStatus || '');
    if (tx.bostaOrderId && !isResendable) {
      return { success: false, error: 'تم إرسال هذا الطلب إلى Bosta مسبقاً' };
    }
    // Clear previous failed/deleted state before resending
    if (isResendable || tx.bostaOrderId) {
      await this.txModel.findByIdAndUpdate(txId, {
        bostaOrderId: '',
        bostaStatus: '',
        bostaStatusLabel: '',
      });
    }

    const phoneClean = (tx.phone || '').replace(/\D/g, '');

    // Resolve address — try tx.shippingAddress first, then fallback to shopify rawData
    let firstLine = ((tx as any).shippingAddress || '').replace(/^العنوان:\s*/, '').trim();

    // shippingBostaCity = Bosta-accepted English name saved directly by city picker (most reliable)
    // shippingGov = Arabic governorate name from city picker
    // shippingCity = full display value e.g. "البحيرة — كفر الدوار"
    const rawBostaCity = ((tx as any).shippingBostaCity || '').trim();
    const rawGov       = ((tx as any).shippingGov || '').trim();
    const rawCity      = ((tx as any).shippingCity || '').trim();
    // Extract governorate part before dash separator (handles "البحيرة — كفر الدوار")
    const cityPart     = rawCity.split(/\s*[—–\-]\s*/)[0].trim();

    let city: string;
    if (rawBostaCity) {
      // Most reliable: English name saved directly by city picker — no translation needed
      city = rawBostaCity;
      this.logger.log(`Bosta city from shippingBostaCity="${city}"`);
    } else {
      // Fallback: translate Arabic governorate name — use only gov/city fields, NOT address text
      // cityPart is extracted from shippingCity (e.g. "الغربية" from "الغربية — المحلة الكبرى")
      // rawGov is the saved governorate — both are safe short strings, not full address text
      const arabicCity = rawGov || cityPart;
      city = arabicCity ? normalizeCity(arabicCity) : '';
      this.logger.log(`Bosta city via normalizeCity("${arabicCity}") → "${city}"`);
      // Auto-fix: persist shippingGov if it was missing (legacy records)
      if (!rawGov && cityPart) {
        await this.txModel.findByIdAndUpdate(txId, { shippingGov: cityPart });
      }
    }

    // When city or address is missing, pull from Shopify rawData
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
          // ONLY use province/city fields — NEVER address1/address2 (they contain street text with city names)
          const shopifyProvince = addr?.province || '';
          const shopifyCity     = addr?.city || '';
          city = normalizeCity(shopifyProvince) || normalizeCity(shopifyCity) || '';
        }
        // Only persist address — never overwrite shippingCity/shippingBostaCity with address text
        if (firstLine) {
          await this.txModel.findByIdAndUpdate(txId, { shippingAddress: firstLine });
        }
      }
    }

    this.logger.log(`Bosta address resolve — txId=${txId} firstLine="${firstLine}" city="${city}" shopifyOrderId="${(tx as any).shopifyOrderId || ''}"`);

    if (!city) {
      this.logger.error(`Bosta city missing — tx=${txId} shippingCity="${rawCity}" shippingGov="${rawGov}" shippingBostaCity="${rawBostaCity}"`);
      return { success: false, error: 'لم يتم تحديد المحافظة — افتح الحركة وحدد المحافظة من القائمة ثم أعد الإرسال', code: 'VALIDATION_ERROR' };
    }

    // وصف المنتج — يظهر في حقل "وصف المنتج" في Bosta
    this.logger.log(`Bosta items raw — txId=${txId} items=${JSON.stringify(tx.items)}`);
    const itemLines = (tx.items as any[] || [])
      .map((it: any) => {
        const name = (
          it.name || it.shopifyName || it.productName || it.title || it.itemName ||
          it.itemTitle || it.product_name || it.variant_title || it.description || ''
        ).trim();
        const qty  = it.qty || it.quantity || 1;
        const code = it.code || it.productCode || it.sku || it.variantSku || '';
        // Include item even if name missing — use code as fallback label
        const label = name || code || 'صنف';
        return `${label} x ${qty}`;
      });
    const packageDescription = itemLines.join(' | ') || `طلب #${tx.ref || String(tx._id).slice(-6)}`;
    this.logger.log(`Bosta packageDescription built — "${packageDescription}"`);
    this.logger.log(`Bosta packageDescription — "${packageDescription}"`);

    // Business reference
    const businessRef = tx.ref ? tx.ref : String(tx._id);

    const payload: Record<string, unknown> = {
      type: 10, // SEND (deliver to customer)
      specs: {
        packageType: 'Parcel',
        size: 'MEDIUM',
        weight: this.calcWeight(tx.items as any[]),
        packageDetails: {
          itemsCount: (tx.items as any[] || []).reduce((s: number, it: any) => s + (it.qty || it.quantity || 1), 0) || 1,
          description: packageDescription,
          goodsValue: 1000,
        },
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

      // Determine initial COD collection status based on whether order has a COD amount
      const hasCod = (tx.remaining || 0) > 0;
      const initialCodStatus = hasCod ? 'PendingPayment' : '';

      await this.txModel.findByIdAndUpdate(txId, {
        bostaOrderId,
        bostaTrackingNumber: trackingNumber,
        bostaStatus: statusCode,
        bostaStatusLabel: statusLabel,
        bostaShippingStatus: BOSTA_TO_SHIPPING_STATUS[statusCode] || 'Created',
        codCollectionStatus: initialCodStatus,
        // Snapshot the COD amount at creation — immutable reference for collection
        ...(hasCod ? { bostaOriginalCod: tx.remaining } : {}),
        bostaLastSync: new Date().toISOString(),
        bostaRawResponse: res,
        pickupStatus: 'Shipped',
        shippedAt: new Date().toISOString(),
      });

      this.logger.log(`Bosta order created: tx=${txId} bostaId=${bostaOrderId} tracking=${trackingNumber}`);
      this.emit('tx:updated', { _id: txId });
      this.emit('pickup:shipped', { _id: txId });

      // ── إرسال Fulfillment + رقم التتبع لشوبيفاي تلقائياً ──────────────────
      const shopifyOrderId = (tx as any).shopifyOrderId || '';
      if (shopifyOrderId) {
        const trackNum = trackingNumber || bostaOrderId;
        this.shopifyAdmin.fulfillOrder(shopifyOrderId, trackNum, 'Bosta')
          .then(r => {
            if (r.success) {
              this.logger.log(`Shopify fulfilled order ${shopifyOrderId} fulfillmentId=${r.fulfillmentId}`);
            } else {
              this.logger.warn(`Shopify fulfillment skipped for ${shopifyOrderId}: ${r.error}`);
            }
          })
          .catch(e => this.logger.error(`Shopify fulfillment error for ${shopifyOrderId}: ${e.message}`));
      }

      return { success: true, bostaOrderId, trackingNumber };
    } catch (err: any) {
      this.logger.error(`Bosta createOrder failed tx=${txId}: ${err.message} | stack: ${err.stack}`);
      if (err.code === 'VALIDATION_ERROR') {
        // Mark transaction so employee knows to fix data before resending
        await this.txModel.findByIdAndUpdate(txId, {
          bostaStatus: 'VALIDATION_ERROR',
          bostaStatusLabel: 'خطأ في البيانات — راجع العنوان والهاتف',
          bostaLastSync: new Date().toISOString(),
        });
        this.emit('tx:updated', { _id: txId });
        return { success: false, error: `خطأ في بيانات الشحنة: ${typeof err.details === 'string' ? err.details : JSON.stringify(err.details)}`, code: 'VALIDATION_ERROR' };
      }
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
      return await this.applyDeliveryUpdate(String(tx._id), tx, res);
    } catch (err: any) {
      this.logger.error(`Bosta syncStatus failed tx=${txId}: ${err.message}`);
      // Order deleted or not found in Bosta — mark accordingly
      const notFoundMsg = typeof err.message === 'string' && (
        err.message.toLowerCase().includes('not found') ||
        err.message.toLowerCase().includes('delivery not found') ||
        err.message.includes('غير موجود')
      );
      if (err.code === 'NOT_FOUND' || err.statusCode === 404 || notFoundMsg) {
        await this.txModel.findByIdAndUpdate(txId, {
          bostaStatus: 'DELETED',
          bostaStatusLabel: 'محذوف من Bosta',
          bostaOrderId: '',
          bostaLastSync: new Date().toISOString(),
          pickupStatus: 'Ready',
          shippedAt: null,
        });
        this.emit('tx:updated', { _id: txId });
        this.emit('pickup:unshipped', { _id: txId });
        return { success: true, status: 'DELETED', statusLabel: 'محذوف من Bosta — يمكنك إعادة الإرسال' };
      }
      return { success: false, error: err.message };
    }
  }

  /**
   * Shared status-application logic used by both the polling sync (syncStatus)
   * and the inbound Bosta webhook. `res` is either a full `{ data: {...} }`
   * API response (from sync) or the raw webhook body (Bosta posts the
   * delivery object directly) — resolveBostaStatus/`d` handle both shapes.
   */
  private async applyDeliveryUpdate(txId: string, tx: any, res: any): Promise<BostaTrackResult> {
    const d = res.data || res;

    if (d.isDeleted === true || d.deletedAt) {
      await this.txModel.findByIdAndUpdate(txId, {
        bostaStatus: 'DELETED',
        bostaStatusLabel: 'محذوف من Bosta',
        bostaOrderId: '',
        bostaLastSync: new Date().toISOString(),
        pickupStatus: 'Ready',
        shippedAt: null,
      });
      this.emit('tx:updated', { _id: txId });
      this.emit('pickup:unshipped', { _id: txId });
      return { success: true, status: 'DELETED', statusLabel: 'محذوف من Bosta — يمكنك إعادة الإرسال' };
    }

    const statusCode     = resolveBostaStatus(d, res);
    const statusLabel    = BOSTA_STATUS_LABELS[statusCode] || statusCode;
    const shippingStatus = BOSTA_TO_SHIPPING_STATUS[statusCode] || '';

    // Compute the new codCollectionStatus — only advance, never regress
    const codUpdate = this.resolveCodStatusUpdate(tx, statusCode);

    await this.txModel.findByIdAndUpdate(txId, {
      bostaStatus: statusCode,
      bostaStatusLabel: statusLabel,
      bostaShippingStatus: shippingStatus,
      bostaLastSync: new Date().toISOString(),
      bostaRawResponse: res,
      ...codUpdate,
    });

    this.emit('tx:updated', { _id: txId });
    return { success: true, status: statusCode, statusLabel, raw: res };
  }

  // ── Inbound Bosta webhook — pushes status updates in real time ────────

  /**
   * Handles a webhook payload pushed by Bosta when a delivery's status changes.
   *
   * Two cases:
   *  1. The order was created via our own "create-order" button — the
   *     transaction already has bostaOrderId/bostaTrackingNumber saved, so we
   *     match directly.
   *  2. The order was shipped straight from Shopify to Bosta, bypassing our
   *     system entirely — the transaction exists (synced from Shopify) but has
   *     no Bosta fields yet. Bosta's businessReference in that case carries
   *     whatever reference Shopify sent (its order name/number or numeric id),
   *     so we fall back to matching on tx.ref or tx.shopifyOrderId and
   *     auto-link the Bosta fields onto that transaction the first time we see it.
   */
  async processWebhook(payload: any): Promise<BostaTrackResult> {
    const d = payload?.data || payload || {};
    const bostaOrderId   = String(d._id || d.id || d.deliveryId || '');
    const trackingNumber = String(d.trackingNumber || d.waybillNumber || d.TrackingNumber || '');
    const businessRef    = String(d.businessReference || d.orderReference || '').trim();

    if (!bostaOrderId && !trackingNumber) {
      return { success: false, error: 'Webhook payload missing delivery id/tracking number', code: 'VALIDATION_ERROR' };
    }

    let tx = await this.txModel.findOne(
      bostaOrderId
        ? { bostaOrderId }
        : { bostaTrackingNumber: trackingNumber },
    ).lean();

    // Fallback: not linked yet — try to match by our own ref or the Shopify
    // order id/name Bosta was given as businessReference, then auto-link.
    if (!tx && businessRef) {
      const refDigits = businessRef.replace(/^#/, '');
      tx = await this.txModel.findOne({
        bostaOrderId: { $in: ['', null] },
        $or: [
          { ref: businessRef },
          { ref: refDigits },
          { shopifyOrderId: businessRef },
          { shopifyOrderId: refDigits },
        ],
      }).lean();

      if (tx) {
        this.logger.log(`Bosta webhook auto-link — tx=${tx._id} matched via businessReference="${businessRef}" (order shipped directly from Shopify to Bosta)`);
        await this.txModel.findByIdAndUpdate(tx._id, {
          bostaOrderId,
          bostaTrackingNumber: trackingNumber,
        });
      }
    }

    if (!tx) {
      this.logger.warn(`Bosta webhook: no matching transaction for bostaOrderId=${bostaOrderId} tracking=${trackingNumber} businessReference=${businessRef}`);
      return { success: false, error: 'لا توجد حركة مطابقة لهذا الطلب', code: 'NOT_FOUND' };
    }

    this.logger.log(`Bosta webhook received — tx=${tx._id} bostaOrderId=${bostaOrderId} tracking=${trackingNumber}`);
    return this.applyDeliveryUpdate(String(tx._id), tx, payload);
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

  // ── Force-mark as DELETED so order can be re-sent ─────────────────────

  async markAsDeleted(txId: string): Promise<{ success: boolean; error?: string }> {
    const tx = await this.txModel.findById(txId).lean();
    if (!tx) return { success: false, error: 'الحركة غير موجودة' };
    await this.txModel.findByIdAndUpdate(txId, {
      bostaStatus: 'DELETED',
      bostaStatusLabel: 'محذوف من Bosta',
      bostaOrderId: '',
      bostaLastSync: new Date().toISOString(),
    });
    this.emit('tx:updated', { _id: txId });
    return { success: true };
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

  // ── Inspect & fix city data for a transaction by ref ─────────────────

  async fixCityByRef(ref: string): Promise<any> {
    const tx = await this.txModel.findOne({ ref }).lean() as any;
    if (!tx) return { error: `لم يتم العثور على حركة بالمرجع ${ref}` };
    const info = {
      _id: String(tx._id),
      ref: tx.ref,
      client: tx.client,
      shippingCity: tx.shippingCity || '',
      shippingGov: tx.shippingGov || '',
      shippingBostaCity: tx.shippingBostaCity || '',
      shippingAddress: tx.shippingAddress || '',
      bostaStatus: tx.bostaStatus || '',
      bostaOrderId: tx.bostaOrderId || '',
    };
    this.logger.log(`fixCityByRef ref=${ref} data=${JSON.stringify(info)} items=${JSON.stringify((tx as any).items?.slice(0,3))}`);
    (info as any)['items'] = ((tx as any).items || []).map((it: any) => ({ name: it.name, shopifyName: it.shopifyName, productName: it.productName, title: it.title, qty: it.qty }));

    // إصلاح: استخرج المحافظة من shippingCity وأعد حساب shippingBostaCity
    const cityPart = (tx.shippingCity || '').split(/\s*[—–\-]\s*/)[0].trim();
    const { normalizeCity } = await import('../shared/normalize-city.util');
    const bostaEn = normalizeCity(cityPart);
    if (bostaEn && !tx.shippingBostaCity) {
      await this.txModel.findByIdAndUpdate(tx._id, {
        shippingGov: cityPart,
        shippingBostaCity: bostaEn,
        // مسح bostaOrderId حتى يمكن إعادة الإرسال
        bostaOrderId: '',
        bostaStatus: 'DELETED',
        bostaStatusLabel: 'محذوف من Bosta',
      });
      return { success: true, tx: info, fixed: { shippingGov: cityPart, shippingBostaCity: bostaEn, note: 'تم مسح bostaOrderId — يمكنك إعادة الإرسال' } };
    }
    return { success: true, tx: info };
  }

  // ── COD threshold guard ───────────────────────────────────────────────────

  async getCodThreshold(): Promise<number> {
    try {
      const s = await this.settingsService.getSettings();
      return (s as any).codCollectionThreshold ?? 5000;
    } catch {
      return 5000;
    }
  }

  // ── COD collection status state machine ──────────────────────────────────

  /**
   * Returns a partial update object for codCollectionStatus.
   * Rules:
   *  - Only COD orders (remaining > 0) get a codCollectionStatus.
   *  - DELIVERED → CODWaitingCollection (never auto-collect into vault).
   *  - RETURNED/CANCELLED → FailedCollection (money never arrived).
   *  - Terminal states (Collected, FailedCollection) are never overwritten by sync.
   */
  private resolveCodStatusUpdate(
    tx: any,
    newBostaStatus: string,
  ): Record<string, string> {
    const current = tx.codCollectionStatus || '';
    const hasCod  = (tx.remaining || 0) > 0;

    // Already finalized — do not regress
    if (current === 'Collected' || current === 'FailedCollection') return {};
    // Non-COD orders carry no collection status
    if (!hasCod) return {};

    if (newBostaStatus === 'DELIVERED' && current !== 'Collected') {
      return { codCollectionStatus: 'CODWaitingCollection' };
    }
    if ((newBostaStatus === 'RETURNED' || newBostaStatus === 'CANCELLED') && current !== 'Collected') {
      return { codCollectionStatus: 'FailedCollection' };
    }
    return {};
  }

  // ── Confirm COD cash receipt from Bosta courier ───────────────────────────

  /**
   * Called when an employee physically receives the COD cash from Bosta.
   * Creates a vault income entry and stamps the transaction as Collected.
   * Does NOT auto-run on DELIVERED — requires explicit employee action.
   *
   * Concurrency safety:
   *  1. Atomically CAS codCollectionStatus to 'CollectionProcessing' — only one
   *     concurrent caller can succeed; the rest get null back and are rejected.
   *  2. Use bostaOriginalCod (immutable snapshot) as the canonical amount.
   *  3. If vault creation fails, revert the status so the employee can retry.
   */
  async confirmCodCollection(
    txId: string,
    operator: string,
    method: string,
    note: string,
    largeAmountConfirmed = false,
  ): Promise<{ success: boolean; vaultEntryId?: string; transaction?: any; error?: string; requiresConfirmation?: boolean; threshold?: number }> {
    // ── Step 1: Atomic lock — only advance from CODWaitingCollection ──────────
    const locked = await this.txModel.findOneAndUpdate(
      {
        _id: txId,
        type: 'مبيعات',
        bostaStatus: 'DELIVERED',
        codCollectionStatus: { $nin: ['Collected', 'CollectionProcessing', 'FailedCollection'] },
        $or: [{ bostaOriginalCod: { $gt: 0 } }, { remaining: { $gt: 0 } }],
      },
      { $set: { codCollectionStatus: 'CollectionProcessing' } },
      { new: false }, // return the pre-update doc so we read the original values
    ).lean() as any;

    if (!locked) {
      // Distinguish "not found / wrong type" from "already processing / collected"
      const tx = await this.txModel.findById(txId).lean() as any;
      if (!tx) return { success: false, error: 'الحركة غير موجودة' };
      if (tx.type !== 'مبيعات') return { success: false, error: 'تحصيل COD متاح للمبيعات فقط' };
      if (tx.bostaStatus !== 'DELIVERED') return { success: false, error: 'لا يمكن تأكيد التحصيل قبل أن تُسلَّم الشحنة من Bosta' };
      if (tx.codCollectionStatus === 'Collected') return { success: false, error: 'تم تسجيل التحصيل مسبقاً لهذه الحركة' };
      if (tx.codCollectionStatus === 'CollectionProcessing') return { success: false, error: 'جاري تسجيل التحصيل بالفعل — انتظر لحظة ثم أعد المحاولة' };
      return { success: false, error: 'لا يوجد مبلغ COD معلق على هذه الحركة' };
    }

    // Use the immutable original COD amount if available, else fall back to remaining
    const codAmount = (locked.bostaOriginalCod && locked.bostaOriginalCod > 0)
      ? locked.bostaOriginalCod
      : (locked.remaining || 0);

    if (codAmount <= 0) {
      // Revert lock — amount was zero somehow
      await this.txModel.findByIdAndUpdate(txId, { $set: { codCollectionStatus: locked.codCollectionStatus || 'CODWaitingCollection' } });
      return { success: false, error: 'لا يوجد مبلغ COD معلق على هذه الحركة' };
    }

    // ── Threshold guard — large-amount must be explicitly confirmed ───────────
    const threshold = await this.getCodThreshold();
    if (threshold > 0 && codAmount >= threshold && !largeAmountConfirmed) {
      // Revert lock so the employee can re-confirm with the flag set
      await this.txModel.findByIdAndUpdate(txId, { $set: { codCollectionStatus: 'CODWaitingCollection' } });
      return {
        success: false,
        requiresConfirmation: true,
        threshold,
        error: `المبلغ ${codAmount} يتجاوز الحد المسموح (${threshold}) — يجب تأكيد استلام المبلغ الكبير`,
      };
    }

    const now = new Date().toISOString();
    const bostaRef = locked.bostaTrackingNumber || locked.bostaOrderId || '';

    // ── Step 2: Create vault entry ────────────────────────────────────────────
    let vaultEntry: any;
    try {
      vaultEntry = await this.vaultService.addSystemEntry(
        codAmount,
        method,
        `تحصيل COD — طلب #${locked.ref || txId}${bostaRef ? ` | Bosta: ${bostaRef}` : ''}`,
        now.split('T')[0],
        'تحصيل',
        locked.ref || '',
        { customer: locked.client || '' },
        operator,
        { linkedTransactionId: String(locked._id), bostaRef },
      );
    } catch (err: any) {
      this.logger.error(`COD vault entry failed tx=${txId}: ${err.message}`);
      // Revert lock so employee can retry
      await this.txModel.findByIdAndUpdate(txId, {
        $set: { codCollectionStatus: 'CODWaitingCollection' },
        $push: {
          codCollectionHistory: {
            action: 'vault_error',
            by: operator,
            at: now,
            amount: codAmount,
            method,
            note: `فشل قيد الخزنة: ${err.message}`,
            bostaRef,
          },
        },
      });
      return { success: false, error: err.message };
    }

    // ── Step 3: Finalize transaction ──────────────────────────────────────────
    const historyEntry = {
      action: 'confirmed',
      by: operator,
      at: now,
      amount: codAmount,
      method,
      note: note || '',
      vaultEntryId: String(vaultEntry._id),
      bostaRef,
    };

    await this.txModel.findByIdAndUpdate(txId, {
      $set: {
        codCollectionStatus: 'Collected',
        codCollectedAt: now,
        codCollectedBy: operator,
        codCollectionMethod: method,
        codVaultEntryId: String(vaultEntry._id),
        codCollectedAmount: codAmount,
        payStatus: 'مكتمل',
        remaining: 0,
      },
      $push: { codCollectionHistory: historyEntry },
    });

    this.emit('tx:updated', { _id: txId });
    this.logger.log(`COD collected: tx=${txId} amount=${codAmount} method=${method} by=${operator} vault=${vaultEntry._id}`);

    // ── تحديث حالة الدفع في شوبيفاي بعد تأكيد استلام COD ──────────────────
    const shopifyOrderId = (locked as any).shopifyOrderId || '';
    if (shopifyOrderId) {
      this.shopifyAdmin.markOrderPaid(shopifyOrderId, codAmount)
        .then(r => {
          if (r.success) {
            this.logger.log(`Shopify order ${shopifyOrderId} marked paid — COD collected`);
          } else {
            this.logger.warn(`Shopify markOrderPaid skipped for ${shopifyOrderId}: ${r.error}`);
          }
        })
        .catch(e => this.logger.error(`Shopify markOrderPaid error for ${shopifyOrderId}: ${e.message}`));
    }

    // Return the updated transaction so the caller can relay fresh state to the frontend
    const updatedTx = await this.txModel.findById(txId).lean();
    return { success: true, vaultEntryId: String(vaultEntry._id), transaction: updatedTx };
  }

  // ── Helper: estimate total weight from items ───────────────────────────

  private calcWeight(items: Array<{ qty: number; weight?: number }>): number {
    const total = (items || []).reduce((s, i) => s + (i.qty || 1) * (i.weight || 0.5), 0);
    return Math.max(0.5, Math.round(total * 10) / 10);
  }
}
