import { projectAfterSalesShipment } from '../after-sales/after-sales-shipment';
import { recordComplaintExecution } from '../complaints/complaint-workflow';
import { NotificationsService } from '../notifications/notifications.service';
import { Optional as PushOptional, Inject as PushInject } from '@nestjs/common';
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
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
import { EmployeeScoringService } from '../employee-performance/employee-scoring.service';
import { FollowUpsService } from '../followups/followups.service';
import { BostaPickup, BostaPickupDocument } from './schemas/bosta-pickup.schema';
import { CreatePickupDto } from './dto/create-pickup.dto';
import { ExtendPickupDto } from './dto/extend-pickup.dto';
import { pickupSchedule, pickupDateReason, pickupReasonMessage, pickupCarrierReason, pickupClock } from './pickup-schedule.util';

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

// ── Bosta numeric state codes → our internal status ────────────────────────
// SINGLE SOURCE OF TRUTH — used by BOTH the REST sync (GET /deliveries/:id)
// and the inbound webhook. Bosta emits the same numeric state codes on both
// channels, so they must never be interpreted by two different tables.
// Per https://docs.bosta.co/docs/how-to/get-delivery-status-via-webhook/
//
// NOTE: code 45 is DELIVERED (not "out for delivery") and 41 is the real
// OUT_FOR_DELIVERY — an earlier duplicate table had these inverted, which
// left every delivered order stuck on "خارج للتسليم" forever.
const BOSTA_STATE_CODE_MAP: Record<number, string> = {
  10:  'CREATED',          // Pickup requested
  11:  'CREATED',          // Waiting for route (cash collection)
  20:  'CREATED',          // Route assigned
  21:  'PICKED_UP',        // Picked up from business
  22:  'IN_TRANSIT',       // Picking up from consignee (CRP/Exchange)
  23:  'PICKED_UP',        // Picked up from consignee (CRP/Exchange)
  24:  'IN_TRANSIT',       // Received at warehouse
  25:  'IN_TRANSIT',       // Fulfilled
  30:  'IN_TRANSIT',       // In transit between hubs
  40:  'IN_TRANSIT',       // Picking up (cash collection)
  41:  'OUT_FOR_DELIVERY', // Out for delivery — heading to customer
  45:  'DELIVERED',        // Delivered
  46:  'RETURNED',         // Returned to business
  47:  'FAILED_ATTEMPT',   // Exception (NDR)
  48:  'CANCELLED',        // Terminated
  49:  'CANCELLED',        // Canceled
  60:  'RETURNED',         // Returned to stock
  100: 'FAILED_ATTEMPT',   // Lost
  101: 'FAILED_ATTEMPT',   // Damaged
  102: 'FAILED_ATTEMPT',   // Investigation
  103: 'FAILED_ATTEMPT',   // Awaiting your action
  104: 'CANCELLED',        // Archived
  105: 'IN_TRANSIT',       // On hold
};

// Free-text / legacy string states Bosta may return on the REST endpoint,
// normalized to our internal status vocabulary. Keys are lowercased with all
// non-alphanumerics stripped, so "Out for delivery", "OUT_FOR_DELIVERY" and
// "out-for-delivery" all collapse to the same key.
const BOSTA_TEXT_STATUS_MAP: Record<string, string> = {
  created:                  'CREATED',
  pickuprequested:          'CREATED',
  waitingforroute:          'CREATED',
  routeassigned:            'CREATED',
  pickedup:                 'PICKED_UP',
  pickedupfrombusiness:     'PICKED_UP',
  pickedupfromconsignee:    'PICKED_UP',
  intransit:                'IN_TRANSIT',
  receivedatwarehouse:      'IN_TRANSIT',
  fulfilled:                'IN_TRANSIT',
  onhold:                   'IN_TRANSIT',
  outfordelivery:           'OUT_FOR_DELIVERY',
  delivered:                'DELIVERED',
  completed:                'DELIVERED',
  returned:                 'RETURNED',
  returnedtobusiness:       'RETURNED',
  returnedtostock:          'RETURNED',
  cancelled:                'CANCELLED',
  canceled:                 'CANCELLED',
  terminated:               'CANCELLED',
  archived:                 'CANCELLED',
  failedattempt:            'FAILED_ATTEMPT',
  exception:                'FAILED_ATTEMPT',
  lost:                     'FAILED_ATTEMPT',
  damaged:                  'FAILED_ATTEMPT',
  investigation:            'FAILED_ATTEMPT',
  awaitingyouraction:       'FAILED_ATTEMPT',
  deleted:                  'DELETED',
  validationerror:          'VALIDATION_ERROR',
  unknown:                  'UNKNOWN',
};

/** Normalizes any Bosta status representation (numeric code or free text). */
function normalizeBostaStatus(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  // Numeric code — either a real number or a numeric string like "45"
  const asNum = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isNaN(asNum) && String(raw).trim() !== '') {
    const mapped = BOSTA_STATE_CODE_MAP[asNum];
    if (mapped) return mapped;
  }

  // Text status — normalize then look up
  const key = String(raw).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key) return null;
  if (BOSTA_TEXT_STATUS_MAP[key]) return BOSTA_TEXT_STATUS_MAP[key];

  // Already one of our internal codes (e.g. "OUT_FOR_DELIVERY")
  const upper = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (BOSTA_STATUS_LABELS[upper]) return upper;

  return null;
}

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


/**
 * Resolves the status from a REST GET /deliveries/:id response.
 *
 * Every plausible field Bosta uses to carry state is tried in order of
 * specificity and run through normalizeBostaStatus, so numeric codes and
 * free-text values are handled identically.
 *
 * IMPORTANT: an unrecognized payload returns UNKNOWN, never CREATED. The old
 * `if (d._id) return 'CREATED'` fallback silently rewrote in-transit orders
 * back to "تم الإنشاء" whenever a state code wasn't in the (incomplete) map;
 * UNKNOWN is rank 0 and is therefore discarded rather than applied.
 */
function resolveBostaStatus(d: any, res: any): string {
  const candidates = [
    d?.state?.code,
    d?.state?.value,
    d?.state,
    d?.currentStatus?.code,
    d?.currentStatus?.value,
    d?.currentStatus,
    res?.currentStatus?.code,
    res?.currentStatus?.value,
    res?.state?.code,
    d?.status,
  ];

  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    // Skip objects — their inner .code/.value are already listed above
    if (typeof c === 'object') continue;
    const resolved = normalizeBostaStatus(c);
    if (resolved) return resolved;
  }

  return 'UNKNOWN';
}

/**
 * Resolves the status from an inbound webhook payload.
 *
 * The webhook body is FLAT (no `res.data` wrapper) and `state` is normally a
 * numeric code, but some Bosta payloads mirror the REST delivery object and
 * send it as `{ code: 45, value: "Delivered" }` — both shapes are handled.
 *
 * Uses the SAME BOSTA_STATE_CODE_MAP as the REST sync path: Bosta emits one
 * set of state codes, so there is exactly one table to interpret them.
 */
function resolveWebhookStatus(payload: any): string {
  const raw = payload?.state;
  const candidates = typeof raw === 'object' && raw !== null
    ? [raw.code, raw.value]
    : [raw];

  // Fall back to the same fields the REST path inspects, in case a webhook
  // variant carries the status elsewhere.
  candidates.push(
    payload?.currentStatus?.code,
    payload?.currentStatus?.value,
    payload?.currentStatus,
    payload?.status,
  );

  for (const c of candidates) {
    if (c === null || c === undefined || typeof c === 'object') continue;
    const resolved = normalizeBostaStatus(c);
    if (resolved) return resolved;
  }

  return 'UNKNOWN';
}

// Ordering used only to detect that an update moves the status backwards.
// Bosta is the source of truth, so a backwards move from a REAL Bosta status
// is still APPLIED (and recorded in deliveryAuditLog) — the rank exists to
// flag the change for audit, not to block it. The single exception is
// UNKNOWN (rank 0), which means "we could not read this payload" rather than
// a genuine state, and is therefore never written over a known status.
const BOSTA_STATUS_RANK: Record<string, number> = {
  UNKNOWN:           0,
  CREATED:           1,
  PICKED_UP:         2,
  IN_TRANSIT:        3,
  OUT_FOR_DELIVERY:  4,
  FAILED_ATTEMPT:    4,
  DELIVERED:         5,
  RETURNED:          5,
  CANCELLED:         5,
};

/**
 * Courier statuses that end an open shipping issue on their own.
 *
 * DELIVERED is the obvious one. The three in-transit codes matter just as much:
 * Bosta reports FAILED_ATTEMPT and then simply tries again, so an order can
 * spend days back on the road while our card still asks somebody to "handle"
 * a problem the courier already moved past.
 *
 * ⚠ RETURNED and CANCELLED are deliberately absent — those END a delivery, they
 * do not resolve it, and they need the human decision `closeFailedDelivery`
 * records (goods back? refund? who pays the return leg?).
 */
const SHIP_ISSUE_RESOLVING_STATUSES = [
  'DELIVERED',
];

export interface BostaCreateResult {
  success: boolean;
  bostaOrderId?: string;
  trackingNumber?: string;
  error?: string;
  code?: string;
}

export interface BostaTrackResult {
  trackingNumber?: string;
  success: boolean;
  status?: string;
  statusLabel?: string;
  raw?: Record<string, unknown>;
  error?: string;
  code?: string;
}

/** Stable ticket key for orders collected by a courier on the same day. */
function shippingReceivedRef(shipCo: unknown, date: string): string {
  const carrier = String(shipCo || 'Bosta');
  let hash = 0;
  for (let i = 0; i < carrier.length; i++) hash = ((hash * 31) + carrier.charCodeAt(i)) & 0xffff;
  return `SH-${date}-${hash.toString(36).toUpperCase().padStart(4, '0')}`;
}

@Injectable()
export class BostaService {
  @PushOptional() @PushInject(NotificationsService) private readonly notifications?: NotificationsService;

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
    private readonly employeeScoringService: EmployeeScoringService,
    private readonly followUpsService: FollowUpsService,
    @PushOptional() @InjectModel(BostaPickup.name)
    private readonly pickupModel?: Model<BostaPickupDocument>,
  ) {}

  private async resolveApiKey(): Promise<string> {
    try {
      const dbKey = await this.settingsService.getBostaApiKey();
      if (dbKey) return dbKey;
    } catch { /* fall through to env */ }
    return process.env.BOSTA_API_KEY || '';
  }

  async pickupLocations() {
    return this.getPickupLocations();
  }

  async afterSalesCities() {
    const response: any = await this.request('GET', '/cities', undefined, '', 'https://app.bosta.co/api/v2');
    const rows = response?.data?.list || response?.data;
    if (!Array.isArray(rows)) throw new BadRequestException('تعذر تحميل محافظات بوسطة');
    return rows.map(c => ({ id: String(c._id), name: String(c.name || ''), nameAr: String(c.nameAr || c.name || '') }));
  }
  async afterSalesDistricts(cityId: string) {
    if (!/^[\w-]{3,100}$/.test(cityId)) throw new BadRequestException('اختر المحافظة أولًا');
    const response: any = await this.request('GET', `/cities/${encodeURIComponent(cityId)}/districts`, undefined, '', 'https://app.bosta.co/api/v2');
    const rows = response?.data?.list || response?.data;
    if (!Array.isArray(rows)) throw new BadRequestException('تعذر تحميل مناطق بوسطة');
    return rows.filter(d => d.districtId).map(d => ({ id: String(d.districtId), name: String(d.districtName || ''), nameAr: String(d.districtOtherName || d.districtName || ''),
      pickupAvailability: d.pickupAvailability, dropOffAvailability: d.dropOffAvailability }));
  }
  async createAfterSalesShipment(row: any) {
    const apiKey = await this.resolveApiKey();
    const tx: any = await this.txModel.findById(row.originalTransactionId).lean();
    const selected = row.workflow.customerAddress;
    let city = tx?.shippingBostaCity || normalizeCity(tx?.shippingGov || String(tx?.shippingCity || '').split(/[—–]/)[0]);
    const firstLine = String(selected?.firstLine || tx?.shippingAddress || '').trim();
    const phone = String(selected?.phone || tx?.phone || row.phone || '').replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 1632)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 1776)).replace(/\D/g, '');
    const names = String(selected?.customerName || tx?.client || row.client || '').trim().split(/\s+/);
    const missing: string[] = [];
    if (!apiKey) missing.push('مفتاح بوسطة غير مضبوط؛ راجع إعدادات شركة الشحن');
    if (!city && !selected?.cityId) missing.push('اختر محافظة العميل');
    if (firstLine.length < 6) missing.push('أدخل عنوان العميل بالتفصيل (6 أحرف على الأقل)');
    if (phone.length < 10 || phone.length > 15) missing.push('أدخل رقم هاتف العميل الصحيح (10 إلى 15 رقمًا)');
    if (!names[0]) missing.push('أدخل اسم العميل');
    if (missing.length) {
      const error: any = new BadRequestException(missing.join(' — '));
      error.beforeSend = true; throw error;
    }
    const w = row.workflow, exchange = row.requestKind === 'exchange';
    const spec = (items: any[]) => ({ size: 'MEDIUM', packageType: 'Parcel', packageDetails: {
      itemsCount: items.reduce((n, i) => n + Number(i.qty), 0), description: items.map(i => `${i.name || i.code} × ${i.qty}`).join(' | '),
    } });
    const replacement: any = exchange ? await this.txModel.findById(w.replacementTxId).lean() : null;
    // V2 requires the customer's district. Reuse the original delivery destination,
    // never the business pickup address or a district guessed from the governorate.
    let originalDeliveryId = tx.bostaOrderId;
    if (!originalDeliveryId && tx.afterSales?.caseId) {
      const parent: any = await this.txModel.db.collection('returnrequests').findOne({ _id: new Types.ObjectId(tx.afterSales.caseId) });
      originalDeliveryId = parent?.workflow?.shipment?.deliveryId;
    }
    let originalAddress: any;
    try {
      if (selected?.cityId && selected?.districtId) {
        const cities = await this.afterSalesCities();
        const pickedCity = cities.find(c => c.id === selected.cityId);
        if (!pickedCity) throw new Error('Invalid city');
        const districts = await this.afterSalesDistricts(selected.cityId);
        const district = districts.find(d => d.id === selected.districtId);
        if (!district || (exchange ? district.dropOffAvailability === false : district.pickupAvailability === false)) throw new Error('District unavailable');
        city = pickedCity.name;
        originalAddress = { districtId: district.id, cityId: pickedCity.id };
      } else if (originalDeliveryId) {
        const original: any = await this.fetchDelivery(originalDeliveryId);
        originalAddress = (original?.data || original)?.dropOffAddress;
      }
    } catch {
      const error: any = new BadRequestException(selected?.cityId ? 'تعذر التحقق من المنطقة المختارة أو الخدمة غير متاحة بها. أعد تحميل المناطق واختر منطقة متاحة؛ لم يتم إرسال شحنة.' : 'تعذر قراءة عنوان البوليصة القديمة. اختر المحافظة والمنطقة في هذه النافذة لإرسال الشحنة مباشرة؛ لم يتم إنشاء شحنة.');
      error.beforeSend = true; throw error;
    }
    const enteredDistrict = selected?.districtId ? '' : String(w.customerDistrictName || '').trim();
    const districtId = enteredDistrict ? '' : String(originalAddress?.districtId || originalAddress?.district?._id || '').trim();
    const districtName = enteredDistrict || String(originalAddress?.districtName || originalAddress?.district?.name || '').trim();
    const cityId = String(originalAddress?.cityId || originalAddress?.city?._id || '').trim();
    if (!districtId && !(districtName && cityId)) {
      const error: any = new BadRequestException(cityId ? 'منطقة العميل غير موجودة في البوليصة الأصلية. اكتب اسم منطقة العميل في خانة المنطقة ثم أعد المحاولة؛ لم يتم إنشاء شحنة.' : 'بيانات منطقة ومحافظة العميل غير مكتملة في بوليصة بوسطة الأصلية. راجع عنوان التسليم في بوسطة؛ لم يتم إنشاء شحنة.');
      error.beforeSend = true; throw error;
    }
    const address: any = { city, firstLine, ...(districtId ? { districtId } : { districtName, cityId }) };
    for (const key of ['secondLine', 'buildingNumber', 'floor', 'apartment']) {
      if (originalAddress?.[key] != null) address[key] = String(originalAddress[key]);
    }
    const payload: any = { type: exchange ? 30 : 25, cod: exchange ? w.quote.collectDue : 0,
      businessReference: w.ref, receiver: { firstName: names[0], lastName: names.slice(1).join(' ') || '-', phone },
      specs: spec(exchange ? replacement.items : w.selectedLines), returnSpecs: spec(w.selectedLines),
      goodsInfo: { amount: exchange ? w.quote.replacement : w.quote.credit }, notes: w.ref, returnNotes: row.notes || '',
      escrowInfo: { isExcluded: true }, [exchange ? 'dropOffAddress' : 'pickupAddress']: address };
    if (w.policy?.businessLocationId) payload.businessLocationId = w.policy.businessLocationId;
    let response: any;
    try { response = await this.request('POST', '/deliveries?apiVersion=1', payload, apiKey, 'https://app.bosta.co/api/v2'); }
    catch (error: any) {
      // An explicit validation/auth rejection created no delivery. Timeouts and server failures remain ambiguous.
      if ([400, 401, 403, 422].includes(error.statusCode)) error.beforeSend = true;
      throw error;
    }
    const data = response.data || response;
    if (response.success === false || !data._id || !data.trackingNumber) throw new Error('لم تؤكد بوسطة رقم البوليصة؛ يلزم مطابقة الطلب');
    return { deliveryId: String(data._id), trackingNumber: String(data.trackingNumber) };
  }

  async fetchAfterSalesShipment(id: string) {
    if (!/^[\w-]{3,100}$/.test(id)) throw new BadRequestException('رقم بوليصة غير صالح');
    return this.fetchDelivery(id);
  }

  async applyAfterSalesUpdate(payload: any): Promise<boolean> {
    const d = payload?.data || payload || {}, alternatives: any[] = [];
    const id = String(d._id || d.id || d.deliveryId || '');
    const tracking = String(d.trackingNumber || '');
    const reference = String(d.businessReference || '');
    if (id) alternatives.push({ 'workflow.shipment.deliveryId': id });
    if (tracking) alternatives.push({ 'workflow.shipment.trackingNumber': tracking });
    if (reference.startsWith('AS-')) alternatives.push({ 'workflow.ref': reference, 'workflow.shipment.status': { $in: ['creating', 'reconcile'] } });
    if (!alternatives.length || !this.txModel.db?.collection) return false;
    const collection = this.txModel.db.collection('returnrequests');
    const row: any = await collection.findOne({ 'workflow.version': 2, $or: alternatives });
    if (!row) return false;
    const code = Number(d.state?.code ?? d.state ?? d.status?.code ?? d.status);
    const status = normalizeBostaStatus(code) || resolveBostaStatus(d, payload);
    // Carrier custody never creates stock, refunds, or proof of replacement delivery.
    const stamp = new Date(d.updatedAt || d.timestamp || Date.now());
    if (Number.isNaN(stamp.getTime())) return true;
    const previous = row.workflow.shipment;
    if (previous.lastEventAt && new Date(previous.lastEventAt) > stamp) return true;
    if (previous.carrierCode === code && previous.carrierStatus === status) {
      const syncSession = await this.txModel.db.startSession();
      try {
        await syncSession.withTransaction(async () => {
          await collection.updateOne({ _id: row._id }, { $set: { 'workflow.shipment.lastSyncAt': new Date().toISOString() } }, { session: syncSession });
          const current = await collection.findOne({ _id: row._id }, { session: syncSession });
          await projectAfterSalesShipment(this.txModel.db, current, syncSession);
        });
      } finally { await syncSession.endSession(); }
      for (const txId of [row.originalTransactionId, row.workflow.replacementTxId, row.returnTxId].filter(Boolean)) this.presence?.emitEvent('tx:updated', { _id: String(txId) });
      return true;
    }
    if (![d.updatedAt, d.timestamp].some(Boolean) && [45, 46, 48, 49].includes(previous.carrierCode) && code < previous.carrierCode) return true;
    const set: any = { 'workflow.shipment.carrierCode': Number.isFinite(code) ? code : null,
      'workflow.shipment.carrierStatus': status, 'workflow.shipment.carrierLabel': BOSTA_STATUS_LABELS[status] || status,
      'workflow.shipment.lastEventAt': stamp.toISOString(), 'workflow.shipment.lastSyncAt': new Date().toISOString() };
    if (id) set['workflow.shipment.deliveryId'] = id;
    if (tracking) { set['workflow.shipment.trackingNumber'] = tracking; set.returnTrackingNumber = tracking; }
    if ([47, 48, 49, 100, 101, 102, 103].includes(code) && !row.workflow.exception) set['workflow.exception'] = `بوسطة: ${d.state?.value || status}`;
    const event = { action: 'carrier-status', by: 'Bosta', at: stamp.toISOString(), note: set['workflow.shipment.carrierLabel'],
      eventId: `carrier:${row._id}:${stamp.toISOString()}:${code}:${status}`, caseId: String(row._id), caseRef: row.workflow.ref, kind: row.requestKind,
      originalRef: row.originalRef, replacementRef: row.workflow.replacementRef || '', returnRef: row.returnTxRef || '' };
    const session = await this.txModel.db.startSession(); let changed = false;
    try {
      await session.withTransaction(async () => {
        const result = await collection.updateOne({ _id: row._id, 'workflow.shipment.lastEventAt': previous.lastEventAt || { $exists: false } },
          { $set: set, $push: { 'workflow.history': event } } as any, { session });
        changed = !!result.modifiedCount;
        if (!changed) return;
        const updated = await collection.findOne({ _id: row._id }, { session });
        await projectAfterSalesShipment(this.txModel.db, updated, session);
        await recordComplaintExecution(this.txModel.db, updated, event, session);
        const ids = [row.originalTransactionId, row.workflow.replacementTxId, row.returnTxId].filter(Boolean).map(value => new Types.ObjectId(value));
        await this.txModel.db.collection('transactions').updateMany({ _id: { $in: ids }, 'afterSalesEvents.eventId': { $ne: event.eventId } },
          { $push: { afterSalesEvents: event } } as any, { session });
      });
    } finally { await session.endSession(); }
    if (changed) {
      for (const txId of [row.originalTransactionId, row.workflow.replacementTxId, row.returnTxId].filter(Boolean)) this.presence?.emitEvent('tx:updated', { _id: String(txId) });
      this.presence?.emitEvent('after-sales:updated', { id: String(row._id), originalTransactionId: row.originalTransactionId });
      await this.notifications?.enqueue('order', event.eventId, row.workflow.ref, `after-sales:${row._id}`, undefined, undefined,
        { afterSalesAction: 'carrier-status', actorName: 'Bosta' });
    }
    return true;
  }

  private afterSalesSyncRunning = false;
  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncAfterSalesShipments() {
    if (this.afterSalesSyncRunning || !this.txModel.db?.collection) return;
    this.afterSalesSyncRunning = true;
    try {
      const cases = await this.txModel.db.collection('returnrequests').find({ 'workflow.version': 2,
        'workflow.stage': { $nin: ['closed', 'cancelled'] }, 'workflow.shipment.deliveryId': { $exists: true, $nin: ['', null] } })
        .sort({ 'workflow.shipment.lastSyncAt': 1 }).limit(100).toArray();
      for (const row of cases) {
        try { await this.applyAfterSalesUpdate(await this.fetchAfterSalesShipment(row.workflow.shipment.deliveryId)); }
        catch { this.logger.warn(`After-sales shipment sync deferred: ${row._id}`); }
      }
    } finally { this.afterSalesSyncRunning = false; }
  }

  private async getPickupLocations() {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) throw new BadRequestException('أضف مفتاح بوسطة من إعدادات الشحن');
    try {
      const response = await this.request<any>('GET', '/pickup-locations', undefined, apiKey, 'https://app.bosta.co/api/v2');
      if (response?.success === false || response?.success === 'false') throw new Error(response.message);
      const data = response.data;
      const locations = Array.isArray(data) ? data : data?.list || data?.pickupLocations || data?.locations;
      if (!Array.isArray(locations)) throw new Error('تعذر قراءة مخازن الاستلام من بوسطة');
      return locations.filter(l => l._id || l.id).map(l => ({
        id: String(l._id || l.id), name: String(l.locationName || l.name || l.address?.firstLine || l._id || l.id),
        contactName: String(l.contactPerson?.name || l.contact?.name || ''),
        contactPhone: String(l.contactPerson?.phone || l.contact?.phone || ''),
      }));
    } catch (e) { throw new BadRequestException(e.message); }
  }

  async pickupPreview() {
    const requests = await this.pickupModel!.find({}).lean();
    const policy = await this.settingsService.getBostaPickupPolicy();
    const reserved = new Set(requests.filter(r => ['pending', 'created'].includes(r.status)).flatMap(r => r.orderIds));
    const ready = await this.txModel.find({
      type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true },
      pickupStatus: { $in: ['Ready', 'Picked-Up'] },
      bostaOrderId: { $exists: true, $nin: ['', null] }, bostaStatus: 'CREATED',
    }).select('_id ref pickupRef').lean();
    const orders = ready.filter(o => !reserved.has(String(o._id)));
    return { orders: orders.map(o => ({ id: String(o._id), ref: o.ref, group: o.pickupRef })), numberOfParcels: orders.length,
      requests: requests.sort((a: any, b: any) => new Date(b.createdAt || b.scheduledDate).getTime() - new Date(a.createdAt || a.scheduledDate).getTime()).map((r: any) => ({
        id: String(r._id), orderIds: r.orderIds.filter((id: string) => !(r.pendingOrderIds || []).includes(id)), requestedBy: r.requestedBy || '', createdAt: r.createdAt,
        pendingOrderIds: r.pendingOrderIds || [], updateState: r.updateState || 'idle', pendingNumberOfParcels: r.pendingNumberOfParcels || 0,
        bostaPickupId: r.bostaPickupId || '', businessLocationId: r.businessLocationId,
        scheduledDate: r.scheduledDate, numberOfParcels: r.numberOfParcels, status: r.status,
        canExtend: r.status === 'created' && !!r.bostaPickupId && !['pending', 'uncertain'].includes(r.updateState) && !pickupDateReason(r.scheduledDate, new Date(), policy),
      })) };
  }

  private async pickupSchedulingContext(businessLocationId: string) {
    const [policy, records] = await Promise.all([
      this.settingsService.getBostaPickupPolicy(),
      this.pickupModel!.find({ businessLocationId }).lean(),
    ]);
    const blocked = records.flatMap(r => {
      const reason = r.status === 'created' ? 'duplicate' : r.status === 'pending' ? 'uncertain' : pickupCarrierReason(r.bostaErrorCode);
      return reason ? [{ date: r.scheduledDate, reason }] : [];
    });
    return { policy, blocked };
  }

  async getPickupSchedule(businessLocationId: string) {
    const { policy, blocked } = await this.pickupSchedulingContext(businessLocationId);
    return pickupSchedule(new Date(), policy, blocked);
  }

  private async assertPickupDate(date: string, businessLocationId: string) {
    const { policy, blocked } = await this.pickupSchedulingContext(businessLocationId);
    const reason = pickupDateReason(date, new Date(), policy, blocked);
    if (reason) throw new BadRequestException({ message: pickupReasonMessage(reason), pickupReason: reason });
    return policy;
  }

  async createPickup(dto: CreatePickupDto, operator: string) {
    await this.assertPickupDate(dto.scheduledDate, dto.businessLocationId);
    const apiKey = await this.resolveApiKey();
    if (!apiKey) throw new BadRequestException('أضف مفتاح بوسطة من إعدادات الشحن');
    const locations = await this.pickupLocations();
    if (!locations.some(l => l.id === dto.businessLocationId)) throw new BadRequestException('اختر مخزن استلام مسجلًا في حساب بوسطة');
    const preview = await this.pickupPreview();
    const expected = new Set(dto.orderIds);
    if (!preview.orders.length || expected.size !== preview.orders.length || preview.orders.some(o => !expected.has(o.id))) {
      throw new BadRequestException('تغيرت الأوردرات الجاهزة — أغلق النافذة وافتح طلب الاستلام مجددًا لمراجعة العدد');
    }
    const identity = { scheduledDate: dto.scheduledDate, businessLocationId: dto.businessLocationId };
    const values = { ...identity, orderIds: preview.orders.map(o => o.id), numberOfParcels: preview.numberOfParcels, requestedBy: operator, status: 'pending', active: true, error: '', bostaErrorCode: 0 };
    let record: BostaPickupDocument;
    await this.pickupModel!.init(); // Ensure unique indexes exist before reserving orders.
    const policy = await this.assertPickupDate(dto.scheduledDate, dto.businessLocationId);
    try {
      record = await this.pickupModel!.findOneAndUpdate({ ...identity, status: 'rejected' }, { $set: values }, { new: true })
        || await this.pickupModel!.create(values);
    } catch (e: any) {
      if (e.code === 11000) throw new BadRequestException('يوجد طلب استلام مسجل لهذا المخزن في نفس اليوم أو لهذه الأوردرات — راجعه في بوسطة');
      throw e;
    }
    // Keep an uncertain request reserved: a timeout can occur after Bosta accepts it.
    let response: any;
    try {
      // The cutoff can pass while warehouse details and indexes are loading.
      const reason = pickupDateReason(dto.scheduledDate, new Date(), policy);
      if (reason) {
        const err: any = new Error(pickupReasonMessage(reason));
        err.rejectedByBosta = true;
        err.bostaErrorCode = reason === 'cutoff' ? 1081 : reason === 'past' ? 1083 : 0;
        throw err;
      }
      response = await this.request<any>('POST', '/pickups', {
        ...identity, numberOfParcels: preview.numberOfParcels, packageType: 'Normal',
        contactPerson: { name: dto.contactName.trim(), phone: dto.contactPhone },
        notes: `SOULIA: ${[...new Set(preview.orders.map(o => o.group).filter(Boolean))].join(', ')}`,
      }, apiKey, 'https://app.bosta.co/api/v2');
      if (response?.success !== true && response?.success !== 'true') {
        const err: any = new Error(response?.message || 'بوسطة لم تؤكد طلب الاستلام');
        err.rejectedByBosta = response?.success === false || response?.success === 'false';
        err.bostaErrorCode = Number(response?.errorCode || 0);
        throw err;
      }
    } catch (e: any) {
      const carrierCode = Number(e.bostaErrorCode || 0);
      const reason = pickupCarrierReason(carrierCode);
      const rejected = e.rejectedByBosta || !!reason || (e.statusCode >= 400 && e.statusCode < 500);
      await this.pickupModel!.updateOne({ _id: record._id }, { $set: { status: rejected ? 'rejected' : 'pending', active: !rejected, error: e.message, bostaErrorCode: carrierCode } });
      throw new BadRequestException({
        message: rejected ? (reason ? pickupReasonMessage(reason) : e.message) : 'لم نتمكن من تأكيد نتيجة الطلب — راجع طلبات الاستلام في بوسطة قبل إعادة المحاولة',
        pickupReason: reason || (rejected ? '' : 'uncertain'),
      });
    }
    const bostaPickupId = String(response.data?._id || response.data?.id || response.data?.pickupRequestId || '');
    await this.pickupModel!.updateOne({ _id: record._id }, { $set: { status: 'created', bostaPickupId } });
    return { success: true, numberOfParcels: preview.numberOfParcels, scheduledDate: dto.scheduledDate, bostaPickupId };
  }

  private async readCarrierPickup(record: BostaPickupDocument, apiKey: string) {
    const reply = await this.request<any>('GET', '/pickups/' + encodeURIComponent(record.bostaPickupId), undefined, apiKey, 'https://app.bosta.co/api/v2');
    const data = reply?.data;
    if (![true, 'true'].includes(reply?.success) || !data || String(data._id) !== record.bostaPickupId || String(data.businessLocationId) !== record.businessLocationId) {
      throw new BadRequestException('تعذر التحقق من طلب الاستلام ومخزنه في بوسطة — راجع الطلب في بوسطة');
    }
    const rawDate = String(data.scheduledDate || '');
    const parsed = new Date(rawDate);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : Number.isFinite(parsed.getTime()) ? pickupClock(parsed).today : '';
    if (date !== record.scheduledDate || !Number.isInteger(data.numberOfParcels) || data.numberOfParcels < 1) {
      throw new BadRequestException('بوسطة لم توفر عدد الطرود أو موعدًا مطابقًا يمكن التحقق منه — راجع الطلب في لوحة بوسطة');
    }
    return data;
  }

  private async confirmPickupAddition(record: BostaPickupDocument) {
    const result = await this.pickupModel!.updateOne(
      { _id: record._id, updateState: { $in: ['pending', 'uncertain'] }, pendingNumberOfParcels: record.pendingNumberOfParcels, pendingOrderIds: record.pendingOrderIds },
      { $set: { numberOfParcels: record.pendingNumberOfParcels, updateState: 'idle', pendingOrderIds: [], pendingNumberOfParcels: 0, error: '' },
        $push: { updateHistory: { at: new Date(), by: record.updateRequestedBy, from: record.numberOfParcels, to: record.pendingNumberOfParcels, orderIds: record.pendingOrderIds, outcome: 'confirmed' } } },
    );
    if (!result.modifiedCount) throw new BadRequestException('تغير طلب الاستلام أثناء التحقق — أعد فتح النافذة لمراجعة حالته');
    return { success: true, id: String(record._id), bostaPickupId: record.bostaPickupId, scheduledDate: record.scheduledDate, numberOfParcels: record.pendingNumberOfParcels };
  }

  async extendPickup(id: string, dto: ExtendPickupDto, operator: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('طلب الاستلام غير موجود');
    const existing = await this.pickupModel!.findById(id);
    if (!existing || existing.status !== 'created' || !existing.bostaPickupId) throw new BadRequestException('اختر طلب استلام مؤكدًا من بوسطة');
    if (['pending', 'uncertain'].includes(existing.updateState)) throw new BadRequestException('يوجد تعديل قيد التأكيد — تحقق من بوسطة قبل أي محاولة أخرى');
    if (existing.numberOfParcels !== dto.expectedNumberOfParcels) throw new BadRequestException('تغير العدد — أعد فتح النافذة لمراجعة الإجمالي');
    const policy = await this.settingsService.getBostaPickupPolicy();
    const reason = pickupDateReason(existing.scheduledDate, new Date(), policy);
    if (reason) throw new BadRequestException(pickupReasonMessage(reason));
    const apiKey = await this.resolveApiKey();
    if (!apiKey) throw new BadRequestException('أضف مفتاح بوسطة من إعدادات الشحن');
    const preview = await this.pickupPreview();
    const expected = new Set(dto.orderIds);
    if (!preview.orders.length || expected.size !== preview.orders.length || preview.orders.some(o => !expected.has(o.id))) throw new BadRequestException('تغيرت الأوردرات الجاهزة — أعد فتح النافذة لمراجعة العدد');
    const total = existing.numberOfParcels + preview.numberOfParcels;
    let record: BostaPickupDocument | null;
    await this.pickupModel!.init();
    try {
      // Atomic reservation also arbitrates against creation and updates on other devices.
      record = await this.pickupModel!.findOneAndUpdate(
        { _id: id, status: 'created', numberOfParcels: existing.numberOfParcels, updateState: { $nin: ['pending', 'uncertain'] } },
        { $set: { updateState: 'pending', pendingOrderIds: dto.orderIds, pendingNumberOfParcels: total, updateRequestedBy: operator, updateRequestedAt: new Date(), error: '' },
          $addToSet: { orderIds: { $each: dto.orderIds } } }, { new: true },
      );
    } catch (e: any) {
      if (e.code === 11000) throw new BadRequestException('الأوردرات محجوزة لطلب استلام آخر — أعد فتح النافذة');
      throw e;
    }
    if (!record) throw new BadRequestException('يوجد تعديل آخر أو تغير العدد — أعد فتح النافذة');
    let sent = false, accepted = false;
    try {
      const carrier = await this.readCarrierPickup(record, apiKey);
      if (carrier.state !== 'Requested') throw new BadRequestException('طلب بوسطة بدأ تنفيذه أو لم يعد قابلًا للتعديل — راجع بوسطة');
      if (carrier.numberOfParcels !== existing.numberOfParcels) throw new BadRequestException('عدد الطرود في بوسطة مختلف عن المسجل — راجع الطلب قبل الإضافة');
      const latestReason = pickupDateReason(record.scheduledDate, new Date(), policy);
      if (latestReason) throw new BadRequestException(pickupReasonMessage(latestReason));
      sent = true;
      const reply = await this.request<any>('PUT', '/pickups/' + encodeURIComponent(record.bostaPickupId), { numberOfParcels: total }, apiKey, 'https://app.bosta.co/api/v2');
      if (![true, 'true'].includes(reply?.success)) {
        const err: any = new Error(reply?.message || 'بوسطة لم تؤكد تعديل طلب الاستلام');
        err.rejectedByBosta = reply?.success === false || reply?.success === 'false';
        throw err;
      }
      accepted = true;
      const verified = await this.readCarrierPickup(record, apiKey);
      if (verified.numberOfParcels !== total || verified.state !== 'Requested') throw new Error('لم يتم التحقق من العدد الجديد وحالة الطلب في بوسطة');
      return await this.confirmPickupAddition(record);
    } catch (e: any) {
      const rejected = !sent || (!accepted && (e.rejectedByBosta || (e.statusCode >= 400 && e.statusCode < 500 && ![408, 429].includes(e.statusCode))));
      if (rejected) {
        await this.pickupModel!.updateOne({ _id: id, updateState: 'pending', pendingNumberOfParcels: total }, {
          $pull: { orderIds: { $in: dto.orderIds } },
          $set: { updateState: 'idle', pendingOrderIds: [], pendingNumberOfParcels: 0, error: e.message },
          $push: { updateHistory: { at: new Date(), by: operator, from: existing.numberOfParcels, to: total, orderIds: dto.orderIds, outcome: 'rejected', error: e.message } },
        });
        throw new BadRequestException(e.message);
      }
      await this.pickupModel!.updateOne({ _id: id, updateState: 'pending', pendingNumberOfParcels: total }, { $set: { updateState: 'uncertain', error: e.message } });
      throw new BadRequestException('نتيجة التعديل غير مؤكدة — الطلبات الجديدة محجوزة لحين التحقق من بوسطة. لا تعِد الإرسال');
    }
  }

  async verifyPickupUpdate(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('طلب الاستلام غير موجود');
    const record = await this.pickupModel!.findById(id);
    if (!record || record.status !== 'created' || !['pending', 'uncertain'].includes(record.updateState) || !record.pendingOrderIds.length) throw new BadRequestException('لا يوجد تعديل يحتاج التحقق');
    // Never reconcile while a live PUT may still be in flight. A crashed worker's reservation remains reviewable.
    if (record.updateState === 'pending' && Date.now() - new Date(record.updateRequestedAt || 0).getTime() < 120000) throw new BadRequestException('التعديل جارٍ — انتظر انتهاء المحاولة قبل التحقق');
    const apiKey = await this.resolveApiKey();
    if (!apiKey) throw new BadRequestException('أضف مفتاح بوسطة من إعدادات الشحن');
    const carrier = await this.readCarrierPickup(record, apiKey);
    const validStates = ['Requested', 'Route Assigned', 'Accepted', 'Picking up', 'Arrived at business', 'Receiving', 'Picked up', 'En route to warehouse', 'Arrived at warehouse', 'Done'];
    if (!validStates.includes(carrier.state) || carrier.numberOfParcels !== record.pendingNumberOfParcels) throw new BadRequestException('لم تؤكد بوسطة العدد المطلوب بعد — راجع الطلب في بوسطة. لم تتم إعادة الإرسال');
    return this.confirmPickupAddition(record);
  }

  /** Request one printable AWB from Bosta's v2 API. The carrier returns a
   * base64-encoded PDF for requests of 50 AWBs or fewer.
   *
   * Per Bosta's docs, `requestedAwbType` is "A6" (the Zebra / thermal label)
   * or "A4" (the original sheet), and `lang` is "ar" or "en". A6 is tried
   * first; if Bosta refuses it the next format is tried so the order can still
   * be printed, and the type actually received is cached with the PDF.
   * ⚠ Every Bosta failure must leave here as an HttpException — a plain Error
   * reaches the global filter as a 500 and the user sees «خطأ غير متوقع»
   * instead of Bosta's own reason. */
  async getAwb(txId: string): Promise<{ success: true; pdfBase64: string; awbType: string }> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) throw new BadRequestException('Bosta API Key غير مضبوط');
    const tx = await this.txModel.findById(txId).select('+bostaAwbBase64 +bostaAwbType').lean();
    if (!tx) throw new BadRequestException('المعاملة غير موجودة');
    if (!tx.bostaOrderId && !tx.bostaTrackingNumber) throw new BadRequestException('لم يتم إنشاء شحنة Bosta لهذا الطلب');
    if (['DELIVERED', 'RETURNED', 'CANCELLED', 'DELETED'].includes(tx.bostaStatus || '')) {
      throw new BadRequestException('بوليصة هذا الطلب غير قابلة للطباعة حسب حالة الشحنة');
    }
    if (tx.bostaAwbBase64 && tx.bostaAwbType === 'A6') return { success: true, pdfBase64: tx.bostaAwbBase64, awbType: 'A6' };

    const attempts: Array<[string, string]> = [['A6', 'ar'], ['A6', 'en'], ['A4', 'ar']];
    const errors: string[] = [];
    for (const [awbType, lang] of attempts) {
      try {
        const pdfBase64 = await this.requestAwbPdf(apiKey, tx, awbType, lang);
        await this.txModel.findByIdAndUpdate(txId, { bostaAwbBase64: pdfBase64, bostaAwbType: awbType });
        if (awbType !== 'A6') this.logger.warn(`Bosta AWB tx=${txId}: A6 refused, printed ${awbType} instead`);
        return { success: true, pdfBase64, awbType };
      } catch (e: any) {
        const msg = e?.message || String(e);
        errors.push(`${awbType}/${lang}: ${msg}`);
        this.logger.error(`Bosta AWB failed tx=${txId} type=${awbType} lang=${lang} — ${msg}`);
      }
    }
    // A stale-but-real label beats no label: an old A4 copy is still valid.
    if (tx.bostaAwbBase64) return { success: true, pdfBase64: tx.bostaAwbBase64, awbType: tx.bostaAwbType || 'A4' };
    const first = errors[0]?.replace(/^[^:]+:\s*/, '') || '';
    throw new BadRequestException(`بوسطة رفضت طلب البوليصة${first ? ': ' + first : ''}`);
  }

  /** One shipment-history entry. `deleted` is pushed only on the transition INTO
   * DELETED (see deletedEventPush), so a repeated sync never duplicates it. */
  private shipEvent(type: 'sent' | 'resent' | 'deleted' | 'cancelled' | 'printed', tx: any, extra: Record<string, unknown> = {}) {
    return {
      type,
      at: new Date().toISOString(),
      ...(tx?.bostaTrackingNumber ? { trackingNumber: String(tx.bostaTrackingNumber) } : {}),
      ...(tx?.bostaOrderId ? { bostaOrderId: String(tx.bostaOrderId) } : {}),
      ...extra,
    };
  }
  private deletedEventPush(tx: any, source: string, by?: string): Record<string, unknown> {
    if ((tx?.bostaStatus || '') === 'DELETED') return {};
    return { $push: { shipmentEvents: this.shipEvent('deleted', tx, { source, ...(by ? { by } : {}) }) } };
  }

  /** Append one print to the order's AWB print log and return the whole log. */
  async recordAwbPrint(txId: string, by: string, byId: string): Promise<{ success: true; prints: { at: string; by: string; byId?: string }[] }> {
    const cur = await this.txModel.findById(txId).select('bostaTrackingNumber bostaOrderId').lean();
    if (!cur) throw new BadRequestException('المعاملة غير موجودة');
    const trackingNumber = String((cur as any).bostaTrackingNumber || '');
    const entry = { at: new Date().toISOString(), by: by || 'مستخدم', ...(byId ? { byId } : {}), ...(trackingNumber ? { trackingNumber } : {}) };
    const tx = await this.txModel.findByIdAndUpdate(
      txId,
      { $push: { bostaAwbPrints: entry, shipmentEvents: this.shipEvent('printed', cur, { by: entry.by }) } },
      { new: true, projection: { bostaAwbPrints: 1 } },
    ).lean();
    if (!tx) throw new BadRequestException('المعاملة غير موجودة');
    this.emit('tx:updated', { _id: txId });
    return { success: true, prints: (tx as any).bostaAwbPrints || [] };
  }

  /** One mass-awb call. Throws a plain Error carrying Bosta's message (or the
   * HTTP status and the start of the body) — getAwb converts it. */
  private requestAwbPdf(apiKey: string, tx: any, awbType: string, lang: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const payload = JSON.stringify({
        ...(tx.bostaTrackingNumber ? { trackingNumbers: String(tx.bostaTrackingNumber) } : { ids: String(tx.bostaOrderId) }),
        requestedAwbType: awbType,
        lang,
      });
      const req = https.request({
        hostname: 'app.bosta.co',
        path: '/api/v2/deliveries/mass-awb',
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const ok = !!res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
          const body = data.trim();
          let parsed: any = null;
          try { parsed = JSON.parse(body); } catch { /* not JSON */ }
          if (!ok) {
            const m = parsed?.message || parsed?.error?.message || parsed?.error || body.slice(0, 200);
            reject(new Error(`HTTP ${res.statusCode}${m ? ' — ' + (typeof m === 'string' ? m : JSON.stringify(m)) : ''}`));
            return;
          }
          if (parsed === null) {
            // Some responses are the bare base64 string.
            if (/^[A-Za-z0-9+/=\r\n]+$/.test(body) && body.length > 100) resolve(body.replace(/\s+/g, ''));
            else reject(new Error(`رد غير مفهوم (${body.slice(0, 120)})`));
            return;
          }
          if (typeof parsed === 'string') { resolve(parsed); return; }
          if (parsed?.success === false) { reject(new Error(parsed?.message || 'success:false')); return; }
          const d = parsed?.data;
          const candidate = [d?.pdf, d?.file, d?.base64, d?.awb, d?.data, d, parsed?.pdf, parsed?.file, parsed?.base64]
            .find(v => typeof v === 'string' && v.length > 100);
          if (candidate) { resolve(String(candidate).replace(/^data:application\/pdf;base64,/i, '')); return; }
          reject(new Error(parsed?.message || `لم تُرجع ملف PDF (${body.slice(0, 120)})`));
        });
      });
      req.on('timeout', () => req.destroy(new Error('انتهت مهلة الاتصال ببوسطة')));
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  private emit(event: string, payload: unknown): void {
    try { this.presence?.emitEvent(event, payload); } catch { /* swallow */ }
  }

  /**
   * One delivery's full record from Bosta — the only source of the price it charged (`log[]`).
   * Public for the settlement service. A webhook body is NOT a substitute: it may not carry `log`.
   * Bounded at 20s so a hung connection cannot stall the settlement cron.
   */
  async fetchDelivery(bostaOrderId: string): Promise<any> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) throw new BadRequestException('Bosta API Key غير مضبوط');
    return Promise.race([
      this.request<any>('GET', `/deliveries/${encodeURIComponent(bostaOrderId)}`, undefined, apiKey),
      new Promise((_, reject) => setTimeout(() => reject(new Error('انتهت مهلة الاتصال ببوسطة')), 20000)),
    ]);
  }

  /** The `$set` fragment that queues an automatic settlement, or {} when none is due. */
  private async autoSettleScheduleFor(tx: any, from: string, to: string, now: string): Promise<Record<string, unknown>> {
    if (tx.afterSales?.caseId) return {};
    if (from === 'DELIVERED' || to !== 'DELIVERED') return {};
    if (tx.type !== 'مبيعات' || tx.cancelled || tx.carrierSettlement) return {};
    try {
      const s: any = await this.settingsService.getSettings();
      if (!s?.autoSettleEnabled) return {};
      const delaySec = Math.max(0, Number(s.autoSettleReadDelaySec ?? 60) || 0);
      return {
        carrierSettlement: {
          status: 'pending',
          trigger: 'auto',
          scheduledAt: now,
          dueAt: new Date(Date.now() + delaySec * 1000).toISOString(),
        },
      };
    } catch {
      // Queuing is a convenience: an order that misses it is still settled by selection.
      return {};
    }
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────

  private request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    apiKey?: string,
    baseUrl = this.BASE_URL,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const url = new URL(`${baseUrl}${path}`);
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
              err.bostaErrorCode = Number(parsed?.errorCode || 0);
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
      if (baseUrl !== this.BASE_URL) req.setTimeout(30000, () => req.destroy(new Error('Bosta request timed out')));
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
    if (!tx) return { success: false, error: 'المعاملة غير موجودة' };
    if (tx.type !== 'مبيعات') return { success: false, error: 'الشحن متاح للمبيعات فقط' };
    if (tx.afterSales?.caseId) return { success: false, error: 'أنشئ بوليصة الاستبدال من ملف الاسترجاع والاستبدال المرتبط' };
    const resendableStatuses = ['VALIDATION_ERROR', 'DELETED'];
    const isResendable = resendableStatuses.includes(tx.bostaStatus || '');
    if (tx.bostaOrderId && !isResendable) {
      return { success: false, error: 'تم إرسال هذا الطلب إلى Bosta مسبقاً' };
    }
    if (!['Preparing', 'Ready', 'Picked-Up'].includes(tx.pickupStatus)) return { success: false, error: 'يجب نقل الطلب إلى قيد التجهيز قبل إنشاء بوليصة Bosta' };
    // Edited names may contain leading spaces, repeated spaces or line breaks.
    // Split the saved name into nonempty parts before building the receiver.
    const nameParts = String(tx.client || '').trim().split(/\s+/).filter(Boolean);
    if (!nameParts.length) {
      return { success: false, error: 'اسم العميل فارغ — افتح المعاملة وأدخل اسم العميل ثم أعد الإرسال إلى بوسطة', code: 'VALIDATION_ERROR' };
    }
    // Was there a shipment before? Read BEFORE the fields below are cleared.
    const prevTracking = String(tx.bostaTrackingNumber || '');
    const isResend = !!(tx.bostaOrderId || prevTracking
      || ((tx as any).shipmentEvents || []).some((e: any) => e?.type === 'sent' || e?.type === 'resent'));
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
      return { success: false, error: 'لم يتم تحديد المحافظة — افتح المعاملة وحدد المحافظة من القائمة ثم أعد الإرسال', code: 'VALIDATION_ERROR' };
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
        firstName: nameParts[0],
        lastName: nameParts.slice(1).join(' ') || '-',
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
        bostaAwbBase64: '',
        bostaAwbType: '',
        bostaStatus: statusCode,
        bostaStatusLabel: statusLabel,
        bostaShippingStatus: BOSTA_TO_SHIPPING_STATUS[statusCode] || 'Created',
        codCollectionStatus: initialCodStatus,
        // Snapshot the COD amount at creation — immutable reference for collection
        ...(hasCod ? { bostaOriginalCod: tx.remaining } : {}),
        bostaLastSync: new Date().toISOString(),
        bostaRawResponse: res,
        // تجميد العنوان الذي شُحنت عليه الشحنة فعلاً — هذه القيم هي ما استلمته Bosta،
        // ولا تتغير بعدها أبداً. بدونها لا يمكن اكتشاف أن شوبيفاي عدّلت العنوان لاحقاً.
        bostaShippedAddress: {
          firstLine,
          city,
          phone: phoneClean || '',
          sentAt: new Date().toISOString(),
        },
        // Registering a label does not move a preparation group. The picker explicitly
        // transfers completed orders after checking and printing their labels.
        pickupStatus: tx.pickupStatus === 'Preparing' ? 'Preparing' : 'Ready',
        shippedByName: operatorName || '',
        $push: {
          shipmentEvents: this.shipEvent(isResend ? 'resent' : 'sent',
            { bostaTrackingNumber: trackingNumber, bostaOrderId },
            { by: operatorName || '', ...(isResend && prevTracking && prevTracking !== trackingNumber ? { prevTrackingNumber: prevTracking } : {}) }),
        },
      });

      this.logger.log(`Bosta order created: tx=${txId} bostaId=${bostaOrderId} tracking=${trackingNumber}`);
      this.emit('tx:updated', { _id: txId });
      this.emit('pickup:shipped', { _id: txId });

      // Pre-fetch the A6 label in the background so the FIRST print is served
      // from the cache instead of waiting ~0.6s on Bosta. A few seconds' delay
      // gives Bosta time to make the new shipment printable. Never awaited and
      // never throws — a failed prefetch just means the print fetches it.
      setTimeout(() => {
        this.getAwb(txId).catch(e => this.logger.warn(`Bosta AWB prefetch skipped tx=${txId}: ${e?.message || e}`));
      }, 4000);

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
    if (!tx) return { success: false, error: 'المعاملة غير موجودة' };
    if (tx.afterSales?.caseId) {
      const row: any = await this.txModel.db.collection('returnrequests').findOne({ _id: new Types.ObjectId(tx.afterSales.caseId) });
      if (!row?.workflow?.shipment?.deliveryId) return { success: false, error: 'لم يتم إنشاء بوليصة لهذا الطلب بعد' };
      try {
        await this.applyAfterSalesUpdate(await this.fetchAfterSalesShipment(row.workflow.shipment.deliveryId));
        const updated: any = await this.txModel.findById(txId).lean();
        return { success: true, status: updated.bostaStatus, statusLabel: updated.bostaStatusLabel, trackingNumber: updated.bostaTrackingNumber };
      } catch (error: any) { return { success: false, error: error.message }; }
    }
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
          ...this.deletedEventPush(tx, 'sync'),
        });
        this.emit('tx:updated', { _id: txId });
        this.emit('pickup:unshipped', { _id: txId });
        return { success: true, status: 'DELETED', statusLabel: 'محذوف من Bosta — يمكنك إعادة الإرسال' };
      }
      return { success: false, error: err.message };
    }
  }

  // ── Manual delivery confirmation (legacy orders) ───────────────────────

  /**
   * Confirms delivery for a sales order that never received a Bosta
   * DELIVERED status — e.g. orders delivered before the Bosta integration
   * existed, or delivered outside Bosta entirely. Sets bostaStatus to
   * DELIVERED (mirroring what a real Bosta webhook would set) and locks the
   * order via deliverySource='MANUAL' so no later Bosta webhook/sync can
   * change it (see the guard at the top of applyDeliveryUpdate).
   *
   * Deliberately does NOT touch VaultService, inventory, deposits, or
   * payments — only resolveCodStatusUpdate is reused so a legacy COD order
   * becomes collectible via the existing confirm-collection endpoint,
   * exactly like a normal Bosta DELIVERED event would allow.
   */
  async markDeliveredManually(
    txId: string,
    operator: string,
    reason: string,
    note: string,
  ): Promise<{ success: boolean; error?: string; transaction?: any }> {
    const tx = await this.txModel.findById(txId).lean();
    if (!tx) return { success: false, error: 'المعاملة غير موجودة' };
    if (tx.type !== 'مبيعات') return { success: false, error: 'هذا الإجراء متاح فقط لمعاملات المبيعات' };
    if (tx.bostaStatus === 'DELIVERED') return { success: false, error: 'الطلب مُسجل بالفعل كـ "تم التسليم"' };

    // ⚠ A shipment the courier sent back was, by definition, delivered to nobody.
    // Stamping it DELIVERED here is not just a wrong record: `deliveredAt` is
    // exactly what closeFailedDelivery() refuses to act on (an order that
    // reached the customer belongs to the returns module, not this path), so a
    // single mis-click would strand the order with no exit at all — closable
    // neither as a failed delivery nor as a customer return.
    const shipIssueState = (tx as any).shipIssueState || '';
    if (shipIssueState === 'open' || shipIssueState === 'awaiting') {
      return {
        success: false,
        error: 'شركة الشحن رجّعت هذا الطلب — لا يمكن تأكيد تسليمه. أنهِ معالجة فشل التوصيل من الفاتورة أولاً',
      };
    }

    const now = new Date().toISOString();
    const previousStatus = tx.bostaStatus || '';
    const previousStatusLabel = tx.bostaStatusLabel || '';
    const previousShippingStatus = tx.bostaShippingStatus || '';
    const previousCodCollectionStatus = tx.codCollectionStatus || '';
    const previousPickupStatus = tx.pickupStatus || '';
    const codUpdate = this.resolveCodStatusUpdate(tx, 'DELIVERED');

    const updated = await this.txModel.findByIdAndUpdate(
      txId,
      {
        $set: {
          bostaStatus: 'DELIVERED',
          bostaStatusLabel: 'تم التسليم',
          bostaShippingStatus: 'Delivered',
          pickupStatus: 'Delivered',
          deliverySource: 'MANUAL',
          deliveredAt: now,
          deliveredBy: operator,
          ...codUpdate,
        },
        $push: {
          deliveryAuditLog: {
            action: 'MANUAL_DELIVERY_CONFIRMATION',
            previousStatus,
            newStatus: 'DELIVERED',
            reason,
            note: note || '',
            by: operator,
            at: now,
            previousStatusLabel,
            previousShippingStatus,
            previousCodCollectionStatus,
            previousPickupStatus,
          },
        },
      },
      { new: true },
    ).lean();

    await this.followUpsService?.closeShippingIssueFollowUp?.(txId, 'تم تأكيد تسليم الطلب للعميل', operator);
    this.emit('tx:updated', { _id: txId });
    this.logger.log(`Manual delivery confirmed — tx=${txId} by=${operator} reason="${reason}"`);

    if (updated?.shopifyOrderId) {
      this.employeeScoringService.scoreDelivery(updated as any).catch((err) =>
        this.logger.error(`Delivery scoring failed for tx ${txId}: ${(err as Error).message}`),
      );
    }

    return { success: true, transaction: updated };
  }

  /**
   * Reverts a manual delivery confirmation, restoring bostaStatus and
   * codCollectionStatus to what they were right before the confirmation
   * (snapshotted on the MANUAL_DELIVERY_CONFIRMATION audit entry), and
   * clears deliverySource so Bosta webhooks/sync can update the order again.
   */
  async undoManualDelivery(
    txId: string,
    operator: string,
  ): Promise<{ success: boolean; error?: string; transaction?: any }> {
    const tx = await this.txModel.findById(txId).lean();
    if (!tx) return { success: false, error: 'المعاملة غير موجودة' };
    if (tx.deliverySource !== 'MANUAL') return { success: false, error: 'لا يوجد تأكيد تسليم يدوي لهذه المعاملة' };

    const log = (tx.deliveryAuditLog || []) as any[];
    const lastConfirmation = [...log].reverse().find((e) => e.action === 'MANUAL_DELIVERY_CONFIRMATION');
    if (!lastConfirmation) return { success: false, error: 'لا يمكن العثور على سجل التأكيد الأصلي' };

    const now = new Date().toISOString();
    const restoredStatus = lastConfirmation.previousStatus || '';

    const updated = await this.txModel.findByIdAndUpdate(
      txId,
      {
        $set: {
          bostaStatus: restoredStatus,
          bostaStatusLabel: lastConfirmation.previousStatusLabel || '',
          bostaShippingStatus: lastConfirmation.previousShippingStatus || '',
          codCollectionStatus: lastConfirmation.previousCodCollectionStatus || '',
          pickupStatus: lastConfirmation.previousPickupStatus || 'Pending',
          deliverySource: '',
          deliveredAt: '',
          deliveredBy: '',
        },
        $push: {
          deliveryAuditLog: {
            action: 'MANUAL_DELIVERY_UNDO',
            previousStatus: 'DELIVERED',
            newStatus: restoredStatus,
            reason: '',
            note: '',
            by: operator,
            at: now,
          },
        },
      },
      { new: true },
    ).lean();

    this.emit('tx:updated', { _id: txId });
    this.logger.log(`Manual delivery undone — tx=${txId} by=${operator} restoredStatus="${restoredStatus}"`);
    return { success: true, transaction: updated };
  }

  /**
   * Shared status-application logic used by both the polling sync (syncStatus)
   * and the inbound Bosta webhook. These two sources have DIFFERENT shapes:
   *  - REST sync (GET /deliveries/:id): `res` is `{ data: {...} }`, status comes
   *    from `d.currentStatus.code` / `d.state.code` (string code) — resolved
   *    via resolveBostaStatus().
   *  - Webhook: `res` is the flat delivery object itself, `state` is a numeric
   *    code per Bosta's webhook state table — resolved via resolveWebhookStatus().
   */
  private async applyDeliveryUpdate(
    txId: string,
    tx: any,
    res: any,
    source: 'sync' | 'webhook' = 'sync',
  ): Promise<BostaTrackResult> {
    // Once a delivery has been manually confirmed, no Bosta-driven update
    // (webhook or sync) may ever change bostaStatus again — not even other
    // terminal statuses at the same rank (e.g. RETURNED after MANUAL DELIVERED).
    if (tx.deliverySource === 'MANUAL') {
      const d0 = source === 'webhook' ? res : (res.data || res);
      const incoming = source === 'webhook' ? resolveWebhookStatus(d0) : resolveBostaStatus(d0, res);
      this.logger.warn(`Bosta ${source} update ignored (manual delivery lock) — tx=${txId} incoming=${incoming}`);
      await this.txModel.findByIdAndUpdate(txId, {
        $push: {
          bostaStatusIgnoredEvents: {
            at: new Date().toISOString(),
            source,
            currentStatus: tx.bostaStatus,
            incomingStatus: incoming,
          },
        },
      });
      return { success: true, status: tx.bostaStatus, statusLabel: tx.bostaStatusLabel, raw: res };
    }

    const d = source === 'webhook' ? res : (res.data || res);

    if (d.isDeleted === true || d.deletedAt) {
      await this.txModel.findByIdAndUpdate(txId, {
        bostaStatus: 'DELETED',
        bostaStatusLabel: 'محذوف من Bosta',
        bostaOrderId: '',
        bostaLastSync: new Date().toISOString(),
        pickupStatus: 'Ready',
        shippedAt: null,
        ...this.deletedEventPush(tx, source),
      });
      this.emit('tx:updated', { _id: txId });
      this.emit('pickup:unshipped', { _id: txId });
      return { success: true, status: 'DELETED', statusLabel: 'محذوف من Bosta — يمكنك إعادة الإرسال' };
    }

    const incomingStatus = source === 'webhook' ? resolveWebhookStatus(d) : resolveBostaStatus(d, res);
    const now = new Date().toISOString();
    const currentStatus = tx.bostaStatus || '';

    // UNKNOWN means the payload could not be interpreted — it is not a real
    // Bosta state, so it must never overwrite a status we already know.
    // (Writing it would also erase the shipping status and strand COD orders.)
    if (incomingStatus === 'UNKNOWN') {
      this.logger.warn(
        `Bosta ${source} update unreadable — tx=${txId} kept=${currentStatus || '(none)'} payload=${JSON.stringify(d)?.slice(0, 500)}`,
      );
      await this.txModel.findByIdAndUpdate(txId, {
        $set: { bostaLastSync: now, bostaRawResponse: res },
        $push: {
          bostaStatusIgnoredEvents: {
            at: now,
            source,
            currentStatus,
            incomingStatus: 'UNKNOWN',
          },
        },
      });
      return { success: true, status: currentStatus, statusLabel: tx.bostaStatusLabel, raw: res };
    }

    // Bosta is the source of truth: a real status is always applied, even when
    // it moves backwards relative to what we had recorded. A backwards move is
    // logged to deliveryAuditLog so the change is reviewable — this is what
    // lets an order wrongly stuck on a later status be corrected automatically.
    const currentRank = BOSTA_STATUS_RANK[currentStatus] ?? 0;
    const newRank     = BOSTA_STATUS_RANK[incomingStatus] ?? 0;
    const regressed   = currentStatus !== '' && newRank < currentRank;
    const statusCode  = incomingStatus;

    if (regressed) {
      this.logger.warn(`Bosta ${source} status moved backwards (applied — Bosta is source of truth) — tx=${txId} ${currentStatus} → ${incomingStatus}`);
    }

    const statusLabel    = BOSTA_STATUS_LABELS[statusCode] || statusCode;
    const shippingStatus = BOSTA_TO_SHIPPING_STATUS[statusCode] || '';

    // Compute the new codCollectionStatus — only advance, never regress
    const codUpdate = this.resolveCodStatusUpdate(tx, statusCode);

    // Creating the Bosta order leaves pickupStatus 'Ready' (registered, not collected). The
    // courier picking it up is what makes it genuinely shipped, so promote it here — and only
    // from 'Ready', so a later 'Delivered' is never dragged back to 'Shipped'.
    const courierCollected = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(statusCode) && tx.pickupStatus === 'Ready';
    // Once the courier has the parcel, move it out of its preparation ticket and
    // into one deterministic shipping ticket per carrier and calendar day. This
    // keeps orders received in separate ready tickets together after refresh.
    const pickupUpdate = courierCollected
      ? {
          pickupStatus: 'Shipped',
          shippedAt: (tx as any).shippedAt || now,
          pickupRef: shippingReceivedRef((tx as any).shipCo, now.slice(0, 10)),
          pickupDate: now.slice(0, 10),
        }
      : {};

    // First arrival at DELIVERED queues the automatic settlement. Only a marker is written here —
    // the price is read a minute later (see CarrierAutoSettleService), because Bosta writes the
    // final price a fraction of a second AFTER the delivery event this update may be carrying.
    const settleSchedule = await this.autoSettleScheduleFor(tx, currentStatus, statusCode, now);

    await this.txModel.findByIdAndUpdate(txId, {
      $set: {
        ...settleSchedule,
        bostaStatus: statusCode,
        bostaStatusLabel: statusLabel,
        bostaShippingStatus: shippingStatus,
        bostaLastSync: now,
        bostaRawResponse: res,
        // Stamp delivery provenance so DELIVERED orders are attributable
        ...(statusCode === 'DELIVERED' ? { deliverySource: 'BOSTA', deliveredAt: tx.deliveredAt || now } : {}),
        ...pickupUpdate,
        ...codUpdate,
      },
      ...(regressed ? {
        $push: {
          deliveryAuditLog: {
            action: 'BOSTA_STATUS_REGRESSION',
            previousStatus: currentStatus,
            newStatus: incomingStatus,
            reason: `تحديث من Bosta (${source}) أرجع الحالة للخلف — طُبِّق لأن Bosta هي المصدر الموثوق`,
            note: '',
            by: `bosta:${source}`,
            at: now,
          },
        },
      } : {}),
    });

    if (statusCode === 'DELIVERED' && currentStatus !== 'DELIVERED') await this.notifications?.enqueue('delivered', 'delivered:' + txId + ':' + (tx.bostaOrderId || ''), tx.ref, 'tx:' + txId);
    if (currentStatus !== statusCode) {
      this.logger.log(`Bosta ${source} status change — tx=${txId} ${currentStatus || '(none)'} → ${statusCode}`);
    }

    this.emit('tx:updated', { _id: txId });

    if (currentStatus !== 'DELIVERED' && statusCode === 'DELIVERED' && tx.shopifyOrderId) {
      const updatedTx = await this.txModel.findById(txId).lean();
      if (updatedTx) {
        this.employeeScoringService.scoreDelivery(updatedTx as any).catch((err) =>
          this.logger.error(`Delivery scoring failed for tx ${txId}: ${(err as Error).message}`),
        );
      }
    }

    // ── A shipment that just entered a delivery-problem state ────────────────
    //
    // Two things happen, and they are separate on purpose:
    //   1. `shipIssueState` opens on the transaction. THIS is what the dashboard
    //      card reads. It is not derived from bostaStatus, because Bosta never
    //      changes RETURNED once it settles and a derived card could never empty.
    //   2. A follow-up ticket opens so somebody actually calls the customer.
    //
    // Only on the *transition* — a repeated webhook carrying the same failed
    // status must not re-fire.
    //
    // ⚠ A shipment that was DELIVERED and only afterwards came back is NOT a
    // failed delivery — it is a customer return, and it belongs to the returns
    // module (refund ceiling, approval, condition). Sending it down this path
    // would refund nothing and cancel a sale the customer actually completed.
    // The test is delivery, not money: with cash-on-delivery the two coincide,
    // but a prepaid order can be paid and never delivered.
    if (currentStatus !== statusCode && FollowUpsService.isShippingIssueStatus(statusCode)) {
      const wasDelivered = !!tx.deliveredAt || currentStatus === 'DELIVERED';
      if (wasDelivered) {
        this.logger.log(
          `Bosta ${statusCode} on an already-delivered order — tx=${txId} treated as a customer return, not a failed delivery`,
        );
      } else {
        // Reopens a previously closed issue too: a re-shipped order that fails
        // again is a live problem, and its old closing decision no longer holds.
        await this.txModel.findByIdAndUpdate(txId, {
          $set: {
            shipIssueState: 'open',
            shipIssueTrigger: statusCode,
            shipIssueOpenedAt: tx.shipIssueOpenedAt || now,
            ...(tx.shipIssueState === 'closed' ? { failedDelivery: null } : {}),
          },
        });
        if (tx.shipIssueState !== 'open' && tx.shipIssueState !== 'awaiting') await this.notifications?.enqueue('deliveryProblem', 'problem:' + txId + ':' + (tx.bostaOrderId || '') + ':' + (tx.failedDelivery?.closedAt || 'initial') + ':' + (tx.shipmentAttempts?.length || 0), tx.ref, 'tx:' + txId, undefined, statusCode);
        this.emit('tx:updated', { _id: txId });

        // Fire-and-forget: status ingestion never waits on, or fails because
        // of, follow-up creation.
        this.followUpsService
          .openShippingIssueFollowUp(tx as any, statusCode)
          .catch((err) =>
            this.logger.error(`Auto follow-up failed for tx ${txId}: ${(err as Error).message}`),
          );
      }
    }

    // ── The courier resolved the problem itself ──────────────────────────────
    //
    // The block above only ever *opens* `shipIssueState`. Nothing closed it
    // except a human pressing a button, so an order Bosta reported as RETURNED
    // and then delivered anyway kept its open issue forever: the dashboard row
    // showed a green `Delivered` badge next to a red "معالجة الطلب" button, and
    // `assertNoOpenShipIssue` went on blocking actions on a completed order.
    //
    // The rule mirrors the one above, in the opposite direction: there, an order
    // already delivered can never enter a delivery problem; here, an order that
    // reaches the customer is resolved. Resumed movement alone leaves the issue
    // open; employees can schedule the next check while waiting for an outcome.
    //
    // ⚠ Only 'open'/'awaiting' are touched. 'reshipped' and 'closed' are human
    // decisions and stay untouched; '' means there was never a problem.
    if (SHIP_ISSUE_RESOLVING_STATUSES.includes(statusCode)) {
      const openState = (tx as any).shipIssueState || '';
      if (openState === 'open' || openState === 'awaiting') {
        const delivered = statusCode === 'DELIVERED';
        await this.txModel.findByIdAndUpdate(txId, {
          $set: {
            shipIssueState: 'closed',
            // The trail is kept deliberately: `shipIssueTrigger` and
            // `shipIssueOpenedAt` stay as written, and the outcome below records
            // that this order did fail an attempt before it succeeded. Nulling
            // it would make the courier look perfect in hindsight.
            failedDelivery: {
              outcome: delivered ? 'delivered-after-issue' : 'back-in-transit',
              goodsBack: false,
              returnShipCost: 0,
              refundAmount: 0,
              shipRetained: 0,
              note: delivered
                ? `أبلغت شركة الشحن عن مشكلة (${(tx as any).shipIssueTrigger || currentStatus || '—'}) ثم سلّمت الطلب — أُغلقت المعالجة تلقائياً`
                : `أبلغت شركة الشحن عن مشكلة (${(tx as any).shipIssueTrigger || currentStatus || '—'}) ثم عادت الشحنة للطريق (${statusLabel}) — أُغلقت المعالجة تلقائياً`,
              closedAt: now,
              closedBy: `bosta:${source}`,
            },
          },
        });
        this.emit('tx:updated', { _id: txId });
        this.logger.log(
          `Shipping issue auto-closed by courier update — tx=${txId} ${openState} → closed (${statusCode})`,
        );
      }
      // A closed transaction must not leave an open employee alert behind.
      // Also reconcile repeated syncs for issues closed before this link existed.
      if (openState || tx.shipIssueTrigger || tx.failedDelivery) {
        await this.followUpsService?.closeShippingIssueFollowUp?.(
          txId,
          statusCode === 'DELIVERED' ? 'تم تسليم الطلب للعميل' : `استؤنفت حركة الشحنة: ${statusLabel}`,
          `bosta:${source}`,
        );
      }
    }

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
    if (await this.applyAfterSalesUpdate(payload)) return { success: true, code: 'AFTER_SALES' };
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
      return { success: false, error: 'لا توجد معاملة مطابقة لهذا الطلب', code: 'NOT_FOUND' };
    }

    this.logger.log(`Bosta webhook received — tx=${tx._id} bostaOrderId=${bostaOrderId} tracking=${trackingNumber} state=${d.state}`);
    return this.applyDeliveryUpdate(String(tx._id), tx, d, 'webhook');
  }

  // ── Bulk sync all unfinished Bosta orders ──────────────────────────────

  /**
   * Reconciles Bosta status for all in-progress orders on a timer, so a
   * missed/dropped webhook (network blip, Bosta not configured to retry,
   * etc.) doesn't leave a transaction stuck on a stale status forever.
   * Webhooks remain the primary, real-time path — this is just the backstop.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduledSyncAll(): Promise<void> {
    try {
      const result = await this.syncAll();
      if (result.synced || result.errors) {
        this.logger.log(`Bosta scheduled sync — synced=${result.synced} errors=${result.errors}`);
      }
    } catch (err: any) {
      this.logger.error(`Bosta scheduled sync failed: ${err.message}`);
    }
  }

  /**
   * Reconciles in-progress Bosta orders.
   *
   * `includeTerminal` re-checks orders already sitting on a terminal status
   * (DELIVERED/RETURNED/CANCELLED). The scheduled run leaves those alone — a
   * terminal state does not change, so re-polling them every 10 minutes is
   * wasted API calls. The admin-triggered run passes true so orders whose
   * terminal status was recorded WRONGLY can be re-read from Bosta and fixed.
   * Manually-confirmed deliveries stay locked either way (see applyDeliveryUpdate).
   */
  async syncAll(includeTerminal = false): Promise<{ synced: number; errors: number; changed: number }> {
    const TERMINAL = ['DELIVERED', 'RETURNED', 'CANCELLED'];
    const txList = await this.txModel
      .find({
        bostaOrderId: { $exists: true, $ne: '' },
        ...(includeTerminal ? {} : { bostaStatus: { $nin: TERMINAL } }),
      })
      .lean();

    let synced = 0;
    let errors = 0;
    let changed = 0;

    for (const tx of txList) {
      const before = tx.bostaStatus || '';
      const result = await this.syncStatus(String(tx._id));
      if (result.success) {
        synced++;
        if (result.status && result.status !== before) changed++;
      } else {
        errors++;
      }
    }

    this.logger.log(`Bosta bulk sync complete: synced=${synced} changed=${changed} errors=${errors} includeTerminal=${includeTerminal}`);
    return { synced, errors, changed };
  }

  // ── Cancel a Bosta order ───────────────────────────────────────────────

  async cancelOrder(txId: string, by = ''): Promise<{ success: boolean; error?: string }> {
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
        $push: { shipmentEvents: this.shipEvent('cancelled', tx, by ? { by } : {}) },
      });

      this.emit('tx:updated', { _id: txId });
      return { success: true };
    } catch (err: any) {
      this.logger.error(`Bosta cancelOrder failed tx=${txId}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ── Force-mark as DELETED so order can be re-sent ─────────────────────

  async markAsDeleted(txId: string, by = ''): Promise<{ success: boolean; error?: string }> {
    const tx = await this.txModel.findById(txId).lean();
    if (!tx) return { success: false, error: 'المعاملة غير موجودة' };
    await this.txModel.findByIdAndUpdate(txId, {
      bostaStatus: 'DELETED',
      bostaStatusLabel: 'محذوف من Bosta',
      bostaOrderId: '',
      bostaLastSync: new Date().toISOString(),
      ...this.deletedEventPush(tx, 'manual', by),
    });
    this.emit('tx:updated', { _id: txId });
    return { success: true };
  }

  // ── Fix corrupted status values (e.g. numeric "10" saved as status) ──────

  /**
   * Repairs transactions whose bostaStatus is not one of our internal codes
   * (e.g. a raw numeric "45" or free text "Out for delivery" written by an
   * older build), by NORMALIZING the stored value through the same table the
   * live paths use.
   *
   * It deliberately does NOT force unrecognized values to CREATED — the old
   * behaviour did exactly that and silently rewrote delivered/in-transit
   * orders back to "تم الإنشاء". Anything that cannot be normalized is left
   * untouched and reported so it can be re-synced from Bosta instead.
   */
  async fixCorruptedStatuses(): Promise<{ fixed: number; unresolved: number; details: any[] }> {
    const candidates = await this.txModel
      .find({
        bostaOrderId: { $exists: true, $ne: '' },
        bostaStatus: { $nin: Object.keys(BOSTA_STATUS_LABELS).concat(['', 'DELETED', 'VALIDATION_ERROR']) },
      })
      .lean();

    let fixed = 0;
    const details: any[] = [];

    for (const tx of candidates) {
      const raw = (tx as any).bostaStatus;
      const normalized = normalizeBostaStatus(raw);
      if (!normalized || normalized === 'UNKNOWN') {
        details.push({ _id: String(tx._id), ref: tx.ref, rawStatus: raw, action: 'left-for-resync' });
        continue;
      }
      await this.txModel.findByIdAndUpdate(tx._id, {
        $set: {
          bostaStatus: normalized,
          bostaStatusLabel: BOSTA_STATUS_LABELS[normalized] || normalized,
          bostaShippingStatus: BOSTA_TO_SHIPPING_STATUS[normalized] || '',
        },
      });
      fixed++;
      details.push({ _id: String(tx._id), ref: tx.ref, rawStatus: raw, action: 'normalized', to: normalized });
    }

    const unresolved = details.length - fixed;
    this.logger.log(`fixCorruptedStatuses: normalized=${fixed} unresolved=${unresolved}`);
    return { fixed, unresolved, details };
  }

  // ── Inspect & fix city data for a transaction by ref ─────────────────

  async fixCityByRef(ref: string): Promise<any> {
    const tx = await this.txModel.findOne({ ref }).lean() as any;
    if (!tx) return { error: `لم يتم العثور على معاملة بالمرجع ${ref}` };
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
        ...(tx.bostaOrderId ? this.deletedEventPush(tx, 'fix-city') : {}),
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
        'afterSales.caseId': { $exists: false },
        $or: [{ bostaOriginalCod: { $gt: 0 } }, { remaining: { $gt: 0 } }],
        // An automatic settlement queued, under review or done owns this order's cash — confirming
        // it here as well would book the same COD twice (and this path books the gross COD).
        'carrierSettlement.status': { $nin: ['pending', 'review', 'disputed', 'settled'] },
      },
      { $set: { codCollectionStatus: 'CollectionProcessing' } },
      { new: false }, // return the pre-update doc so we read the original values
    ).lean() as any;

    if (!locked) {
      // Distinguish "not found / wrong type" from "already processing / collected"
      const tx = await this.txModel.findById(txId).lean() as any;
      if (!tx) return { success: false, error: 'المعاملة غير موجودة' };
      if (tx.type !== 'مبيعات') return { success: false, error: 'تحصيل COD متاح للمبيعات فقط' };
      if (tx.bostaStatus !== 'DELIVERED') return { success: false, error: 'لا يمكن تأكيد التحصيل قبل أن تُسلَّم الشحنة من Bosta' };
      if (tx.codCollectionStatus === 'Collected') return { success: false, error: 'تم تسجيل التحصيل مسبقاً لهذه المعاملة' };
      if (tx.codCollectionStatus === 'CollectionProcessing') return { success: false, error: 'جاري تسجيل التحصيل بالفعل — انتظر لحظة ثم أعد المحاولة' };
      return { success: false, error: 'لا يوجد مبلغ COD معلق على هذه المعاملة' };
    }

    // Use the immutable original COD amount if available, else fall back to remaining
    const codAmount = (locked.bostaOriginalCod && locked.bostaOriginalCod > 0)
      ? locked.bostaOriginalCod
      : (locked.remaining || 0);

    if (codAmount <= 0) {
      // Revert lock — amount was zero somehow
      await this.txModel.findByIdAndUpdate(txId, { $set: { codCollectionStatus: locked.codCollectionStatus || 'CODWaitingCollection' } });
      return { success: false, error: 'لا يوجد مبلغ COD معلق على هذه المعاملة' };
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
