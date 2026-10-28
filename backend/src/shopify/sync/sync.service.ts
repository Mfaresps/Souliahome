import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { Transaction } from '../../transactions/schemas/transaction.schema';
import { ShopifyOrder } from '../schemas/shopify-order.schema';
import { ShopifySyncApiService, SyncApiError } from './sync-api.service';
import { digest, planSync, syncSource, shippingEvent, SyncAction, SyncReview } from './sync-plan';

const TX_FIELDS = 'ref shopifyOrderId type deliverySource deliveryAuditLog bostaOrderId cancelled total deposit remaining codReversedAt cancellationDepositRefunds codCollectionStatus codCollectedAmount bostaOriginalCod carrierSettlement bostaStatus bostaRawResponse bostaTrackingNumber deliveredAt items updatedAt';
const BUSY = ['pending', 'running', 'error'];

@Injectable()
export class ShopifySyncService implements OnModuleInit {
  private readonly logger = new Logger(ShopifySyncService.name);
  private working = false;
  constructor(@InjectModel(Transaction.name) private readonly tx: Model<any>,
    @InjectModel(ShopifyOrder.name) private readonly orders: Model<any>, private readonly api: ShopifySyncApiService) {}
  private get jobs(): any { return this.tx.db.collection('shopifysyncjobs'); }
  private get configs(): any { return this.tx.db.collection('shopifysyncconfigs'); }
  private get previews(): any { return this.tx.db.collection('shopifysyncpreviews'); }
  async onModuleInit() {
    await this.jobs.createIndex({ target: 1, transactionId: 1 }, { unique: true });
    await this.jobs.createIndex({ status: 1, nextAttemptAt: 1 });
    await this.previews.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // Earlier builds called metadata-only updates a complete sync. Correct the result, preserving its audit trail.
    await this.jobs.updateMany({ status: 'synced', 'source.shipmentType': 'UNKNOWN',
      'source.state': { $in: ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_ATTEMPT', 'CUSTOMER_POSTPONED'] } },
      { $set: { status: 'review', error: 'تم تحديث البيانات التشغيلية فقط؛ حالة الشحن لم تُزامَن. أعد المعاينة.' } });
  }
  private async config(): Promise<any> { return await this.configs.findOne({ _id: 'default' }) || { enabled: false, includePayments: false }; }
  private target(connection: any) { return digest([connection.store, connection.appKey, connection.shopId]); }
  private async assertIdentity(record: any) {
    const current = await this.api.identity();
    if (current.store !== record.store || current.appKey !== record.appKey) throw new SyncReview('بيانات التطبيق أو المتجر تغيرت؛ أعد فحص الاتصال والمعاينة.');
  }
  async status() {
    const config = await this.config();
    const identity = await this.api.identity();
    const matches = config.store === identity.store && config.appKey === identity.appKey;
    const filter = { store: identity.store, appKey: identity.appKey };
    const counts = await this.jobs.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]).toArray();
    const last = await this.jobs.find({ ...filter, lastSuccessAt: { $exists: true } }).sort({ lastSuccessAt: -1 }).limit(1).toArray();
    return { enabled: !!config.enabled && matches, configuredEnabled: !!config.enabled, identityChanged: !!config.enabled && !matches,
      includePayments: !!config.includePayments, domain: config.domain || '', enabledAt: config.enabledAt || null,
      lastSuccessAt: last[0]?.lastSuccessAt || null, counts: Object.fromEntries(counts.map((r: any) => [r._id, r.count])),
      lastScanError: config.lastScanError || '', lastScanAt: config.lastScanAt || null };
  }
  async configure(enabled: boolean, includePayments: boolean, by: string) {
    if (!enabled) {
      await this.configs.updateOne({ _id: 'default' }, { $set: { enabled: false, includePayments, changedBy: by, changedAt: new Date() } }, { upsert: true });
      return this.status();
    }
    const connection = await this.api.connection();
    if (connection.missing.length) throw new BadRequestException('صلاحيات ناقصة: ' + connection.missing.join(', '));
    const previous = await this.config();
    const same = previous.store === connection.store && previous.appKey === connection.appKey;
    // First enable or a new store starts now. Re-enable resumes the persisted cursor.
    const start = same && previous.scanAt ? previous.scanAt : new Date();
    await this.configs.updateOne({ _id: 'default' }, { $set: { ...connection, target: this.target(connection), enabled: true,
      includePayments, enabledAt: same && previous.enabledAt ? previous.enabledAt : start,
      scanAt: start, scanId: same ? previous.scanId || '' : '', lastScanError: '', changedBy: by, changedAt: new Date() } }, { upsert: true });
    return this.status();
  }
  private async source(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new SyncReview('معرّف الطلب المحلي غير صالح.');
    const tx: any = await this.tx.findById(id).select(TX_FIELDS).lean();
    if (!tx?.shopifyOrderId) throw new SyncReview('هذا الطلب غير مربوط بـ Shopify.');
    const duplicate = await this.tx.countDocuments({ shopifyOrderId: tx.shopifyOrderId });
    if (duplicate !== 1) throw new SyncReview('أكثر من حركة مرتبطة بنفس طلب Shopify؛ يلزم مراجعة.');
    const order = await this.orders.findOne({ shopifyId: tx.shopifyOrderId }).select('rawData').lean();
    const identity = await this.api.identity();
    const reconciliation = await this.tx.db.collection('shopifysyncreconciliations').findOne({
      ...identity, transactionId: id, orderId: String(tx.shopifyOrderId),
    });
    return syncSource(tx, order, reconciliation?.unitMappings || []);
  }
  async list(ref = '', cursor = '', state = '') {
    const identity = await this.api.identity();
    const query: any = { shopifyOrderId: { $exists: true, $nin: ['', null] } };
    if (ref) query.ref = ref.replace(/^#+/, '');
    if (cursor) {
      if (!Types.ObjectId.isValid(cursor)) throw new BadRequestException('مؤشر الصفحة غير صالح');
      query._id = { $lt: new Types.ObjectId(cursor) };
    }
    if (state) {
      const matches = await this.jobs.find({ ...identity, status: state }).project({ transactionId: 1 }).toArray();
      query._id = { ...(query._id || {}), $in: matches.map((j: any) => new Types.ObjectId(j.transactionId)) };
    }
    const rows: any[] = await this.tx.find(query).select('ref shopifyOrderId bostaStatus total deposit remaining').sort({ _id: -1 }).limit(21).lean();
    const page = rows.slice(0, 20);
    const jobs = await this.jobs.find({ ...identity, transactionId: { $in: page.map(r => String(r._id)) } }).toArray();
    return { rows: page.map(r => ({ id: String(r._id), ref: r.ref, orderId: r.shopifyOrderId, shipping: r.bostaStatus || '',
      total: r.total, deposit: r.deposit, remaining: r.remaining, sync: this.publicJob(jobs.find((j: any) => j.transactionId === String(r._id))) })),
      nextCursor: rows.length > 20 ? String(page[page.length - 1]._id) : null };
  }
  private publicJob(job: any) {
    return job ? { id: String(job._id), status: job.status, error: job.error || '', warnings: job.warnings || [],
      attempts: job.attempts, lastSuccessAt: job.lastSuccessAt || null, nextAttemptAt: job.nextAttemptAt || null,
      updatedAt: job.updatedAt, log: (job.log || []).slice(-10) } : null;
  }
  async orderStatus(transactionId: string) {
    await this.source(transactionId);
    const identity = await this.api.identity();
    return this.publicJob(await this.jobs.findOne({ ...identity, transactionId }));
  }
  async preview(ids: string[], includePayments: boolean, by: string) {
    const connection = await this.api.connection();
    if (connection.missing.length) throw new BadRequestException('صلاحيات ناقصة: ' + connection.missing.join(', '));
    const target = this.target(connection), results: any[] = [];
    for (const transactionId of [...new Set(ids)]) {
      try {
        const source = await this.source(transactionId);
        const old = await this.jobs.findOne({ target, transactionId });
        const remote = await this.api.read(source.orderId, connection.shopId);
        const plan = planSync(source, remote, includePayments, old?.known);
        if (old?.intent && !this.satisfied(old.intent, remote, source)) plan.issues.push('هناك إرسال سابق غير مؤكد؛ أعد التحقق من النتيجة قبل السماح بإرسال جديد.');
        const token = randomUUID(), expiresAt = new Date(Date.now() + 15 * 60000);
        await this.previews.insertOne({ _id: token, ...connection, target, transactionId, source, includePayments,
          sourceHash: plan.sourceHash, remoteHash: plan.remoteHash, allowed: plan.actions.map(a => a.kind),
          executable: !plan.issues.length && plan.actions.length > 0, expiresAt, by });
        results.push({ token, transactionId, ref: source.ref, actions: plan.actions.map(a => a.label), issues: plan.issues,
          warnings: plan.warnings, expiresAt, matched: !plan.actions.length && !plan.issues.length });
      } catch (error: any) { results.push({ transactionId, issues: [this.errorText(error)], actions: [], warnings: [] }); }
    }
    return { domain: connection.domain, results };
  }
  async execute(tokens: string[], by: string) {
    const results: any[] = [];
    for (const token of [...new Set(tokens)]) {
      try {
        const p = await this.previews.findOne({ _id: token, by });
        if (!p || p.expiresAt < new Date() || !p.executable) throw new SyncReview('المعاينة منتهية أو تحتاج مراجعة.');
        await this.assertIdentity(p);
        const source = await this.source(p.transactionId);
        if (digest(source) !== p.sourceHash) throw new SyncReview('الطلب تغير بعد المعاينة؛ اعرض الفروقات من جديد.');
        const old = await this.jobs.findOne({ target: p.target, transactionId: p.transactionId });
        if (old?.generation === token) { results.push({ transactionId: p.transactionId, status: old.status }); continue; }
        if (old && BUSY.includes(old.status)) throw new SyncReview('هناك مزامنة قائمة لهذا الطلب.');
        if (old?.intent) throw new SyncReview('راجع نتيجة الإرسال السابق باستخدام إعادة التحقق أولًا.');
        const remote = await this.api.read(source.orderId, p.shopId);
        if (digest(remote) !== p.remoteHash) throw new SyncReview('Shopify تغير بعد المعاينة؛ أعد المعاينة.');
        const job = { ...p, _id: undefined, by, source, generation: token, origin: 'manual', status: 'pending',
          attempts: 0, begun: false, manualRetry: false, error: '', warnings: [], nextAttemptAt: new Date(), updatedAt: new Date(), intent: null };
        delete job._id; delete job.expiresAt;
        await this.putJob(old, job);
        results.push({ transactionId: p.transactionId, status: 'pending' });
      } catch (error: any) { results.push({ token, error: this.errorText(error) }); }
    }
    return { results };
  }
  private async putJob(old: any, job: any) {
    if (old) {
      const result = await this.jobs.updateOne({ _id: old._id, generation: old.generation, status: { $nin: BUSY } }, { $set: job });
      if (!result.modifiedCount) throw new SyncReview('تغيرت حالة المهمة؛ حدّث الصفحة.');
    } else {
      try { await this.jobs.insertOne(job); } catch { throw new SyncReview('تم إنشاء مهمة لهذا الطلب؛ حدّث الصفحة.'); }
    }
  }
  async retry(id: string, by: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف المحاولة غير صالح');
    const job = await this.jobs.findOne({ _id: new Types.ObjectId(id) });
    if (!job || !['error', 'review', 'paused'].includes(job.status)) throw new BadRequestException('المحاولة غير متاحة للإعادة');
    await this.assertIdentity(job);
    if (digest(await this.source(job.transactionId)) !== job.sourceHash) throw new BadRequestException('البيانات تغيرت؛ استخدم معاينة جديدة.');
    // Retry preserves the exact approved source and any uncertain mutation marker.
    await this.jobs.updateOne({ _id: job._id, status: job.status, generation: job.generation }, { $set: {
      status: 'pending', attempts: 0, manualRetry: true, nextAttemptAt: new Date(), updatedAt: new Date(), by,
    } });
    return { queued: true };
  }
  /** Replaces legacy direct writes; the scheduled scanner owns enqueueing and coalescing. */
  async legacyRequest(): Promise<{ success: boolean; error?: string }> {
    const c = await this.config();
    return { success: false, error: c.enabled ? 'سيتم إرسال التحديث عبر طابور المزامنة بعد التحقق.' : 'الإرسال التلقائي متوقف؛ استخدم معاينة المزامنة.' };
  }
  private async enqueueChanged(config: any, transactionId: string) {
    const old = await this.jobs.findOne({ target: config.target, transactionId });
    if (old && BUSY.includes(old.status)) {
      // A delayed retry must not block unrelated orders. Persist the need to inspect this order again.
      await this.jobs.updateOne({ _id: old._id }, { $set: { rescan: true } });
      return;
    }
    try {
      const source = await this.source(transactionId);
      const sourceHash = digest(source);
      if (old?.sourceHash !== sourceHash && !old?.intent) await this.putJob(old, {
        store: config.store, appKey: config.appKey, shopId: config.shopId, domain: config.domain, target: config.target,
        transactionId, source, sourceHash, includePayments: config.includePayments,
        generation: randomUUID(), origin: 'auto', status: 'pending', begun: false, manualRetry: false, rescan: false, attempts: 0,
        nextAttemptAt: new Date(), updatedAt: new Date(), error: '', warnings: [], intent: null,
      });
      else if (old) await this.jobs.updateOne({ _id: old._id, generation: old.generation }, { $set: { rescan: false } });
    } catch (error: any) {
      if (!(error instanceof SyncReview)) throw error;
      if (!old?.intent) await this.putJob(old, {
        store: config.store, appKey: config.appKey, shopId: config.shopId, target: config.target,
        transactionId, generation: randomUUID(), origin: 'auto', manualRetry: false, rescan: false,
        status: 'review', attempts: 0, error: this.errorText(error), updatedAt: new Date(),
      });
    }
  }
  private async scan(config: any) {
    await this.assertIdentity(config);
    const deferred = await this.jobs.find({ target: config.target, rescan: true, status: { $nin: BUSY } }).limit(30).toArray();
    for (const job of deferred) await this.enqueueChanged(config, job.transactionId);
    const boundary: any = { updatedAt: { $gt: config.scanAt } };
    const cursor = config.scanId && Types.ObjectId.isValid(config.scanId)
      ? { $or: [boundary, { updatedAt: config.scanAt, _id: { $gt: new Types.ObjectId(config.scanId) } }] } : { updatedAt: { $gte: config.scanAt } };
    const rows: any[] = await this.tx.find({ ...cursor, shopifyOrderId: { $exists: true, $nin: ['', null] } })
      .select('_id updatedAt').sort({ updatedAt: 1, _id: 1 }).limit(30).lean();
    for (const row of rows) {
      await this.enqueueChanged(config, String(row._id));
      await this.configs.updateOne({ _id: 'default', target: config.target, enabled: true }, { $set: { scanAt: row.updatedAt, scanId: String(row._id) } });
    }
    await this.configs.updateOne({ _id: 'default', target: config.target }, { $set: { lastScanAt: new Date(), lastScanError: '' } });
  }
  private satisfied(action: SyncAction, remote: any, source: any): boolean {
    if (!remote) return false;
    if (action.kind === 'metadata') return remote.erpStatus?.value === action.input.value;
    if (action.kind === 'payment') return remote.displayFinancialStatus === 'PAID' && Number(remote.totalOutstandingSet.shopMoney.amount) === 0;
    const fs = remote.fulfillments.filter((f: any) => this.matchesFulfillment(f, source));
    if (action.kind === 'fulfill') return fs.length === 1;
    if (action.kind === 'tracking') return fs.some((f: any) => f.id === action.input.fulfillmentId);
    return fs.some((f: any) => f.id === action.input.fulfillmentId && f.events.nodes.some((e: any) =>
      e.status === action.input.status && Math.abs(Date.parse(e.happenedAt) - Date.parse(action.input.happenedAt)) < 1000));
  }
  private matchesFulfillment(f: any, source: any) {
    const trackingMatches = source.tracking ? f.trackingInfo.some((t: any) => t.number === source.tracking)
      : source.manualDelivery && source.shipmentType === 'MANUAL_SEND' && f.trackingInfo.length === 0;
    return f.status === 'SUCCESS' && trackingMatches && !f.fulfillmentLineItems.pageInfo.hasNextPage
      && f.fulfillmentLineItems.nodes.length === source.original.length && source.original.every((line: any) =>
        f.fulfillmentLineItems.nodes.some((l: any) => l.lineItem.id === `gid://shopify/LineItem/${line.id}` && l.quantity === line.qty));
  }
  private async allowed(job: any) {
    await this.assertIdentity(job);
    let includePayments = !!job.includePayments;
    if (job.origin === 'auto') {
      const config = await this.config();
      if ((!config.enabled && !job.manualRetry) || config.target !== job.target) throw new SyncReview('الإرسال التلقائي متوقف.');
      includePayments = includePayments && !!config.includePayments;
    }
    if (digest(await this.source(job.transactionId)) !== job.sourceHash) throw new SyncReview('بيانات الطلب تغيرت أثناء الانتظار؛ أعد المعاينة.');
    return includePayments;
  }
  private async process(job: any) {
    const lock = { _id: job._id, lease: job.lease, generation: job.generation, status: 'running' };
    const update = async (set: any, log?: string) => {
      const result = await this.jobs.updateOne(lock, { $set: { ...set, updatedAt: new Date(), leaseUntil: new Date(Date.now() + 90000) },
        ...(log ? { $push: { log: { $each: [{ at: new Date(), message: log }], $slice: -30 } } } : {}) });
      if (!result.matchedCount) throw new SyncReview('انتهت ملكية المحاولة؛ يلزم إعادة التحقق.');
    };
    try {
      await this.allowed(job);
      let remote = await this.api.read(job.source.orderId, job.shopId);
      if (job.intent) {
        if (!this.satisfied(job.intent, remote, job.source)) throw new SyncReview('نتيجة الإرسال السابق غير مؤكدة. لم تتم إعادته لتجنب التكرار؛ راجع Shopify.');
        await update({ intent: null }, 'تم التحقق من نجاح الإرسال السابق بدون تكراره.'); job.intent = null;
      }
      if (!job.begun && job.origin === 'manual' && digest(remote) !== job.remoteHash) throw new SyncReview('Shopify تغير بعد الموافقة؛ أعد المعاينة.');
      await update({ begun: true });
      for (let step = 0; step < 7; step++) {
        const includePayments = await this.allowed(job);
        const plan = planSync(job.source, remote, includePayments, job.known);
        if (plan.issues.length) throw new SyncReview(plan.issues.join(' '));
        if (!plan.actions.length) {
          const f = remote.fulfillments.find((r: any) => this.matchesFulfillment(r, job.source));
          const shipping = !!shippingEvent(job.source);
          await update({ status: shipping ? 'synced' : 'metadata_only', lastSuccessAt: new Date(), error: '', warnings: plan.warnings, intent: null,
            known: f ? { fulfillmentId: f.id, tracking: job.source.tracking } : job.known || null },
            shipping ? 'تمت قراءة Shopify وتأكيد حالة الشحن المطلوبة.' : 'تم تحديث البيانات التشغيلية فقط؛ لا يشمل ذلك حالة الشحن أو الإلغاء في Shopify.');
          return;
        }
        const action = plan.actions[0];
        if (job.origin === 'manual' && !job.allowed.includes(action.kind)) throw new SyncReview('ظهر تغيير إضافي لم يكن في المعاينة؛ راجع الطلب.');
        await update({ intent: action }, `بدء: ${action.label}`);
        try { await this.api.apply(action); }
        catch (error: any) {
          if (error instanceof SyncApiError && !error.uncertain) await update({ intent: null });
          throw error;
        }
        // Keep the durable intent until read-back proves the operation was applied.
        remote = await this.api.read(job.source.orderId, job.shopId);
        if (!this.satisfied(action, remote, job.source)) throw new SyncReview('لم تؤكد قراءة Shopify نتيجة الإرسال؛ تمت إحالته للمراجعة.');
        await update({ intent: null }, `نجح: ${action.label}`);
      }
      throw new SyncReview('لم تكتمل مطابقة الحالة؛ أعد المعاينة.');
    } catch (error: any) {
      const retry = error instanceof SyncApiError && error.transient && job.attempts < 6;
      await update({ status: retry ? 'error' : 'review', error: this.errorText(error),
        nextAttemptAt: retry ? new Date(Date.now() + Math.min(30, 2 ** job.attempts) * 60000) : null }, this.errorText(error)).catch(() => undefined);
    }
  }
  @Cron('*/15 * * * * *')
  async tick() {
    if (this.working) return;
    this.working = true;
    try {
      const config = await this.config();
      if (config.enabled) {
        try { await this.scan(config); }
        catch (error: any) { await this.configs.updateOne({ _id: 'default' }, { $set: { lastScanError: this.errorText(error) } }); }
      }
      const identity = await this.api.identity();
      for (let i = 0; i < 3; i++) {
        const now = new Date(), lease = randomUUID();
        const origin = config.enabled && config.store === identity.store && config.appKey === identity.appKey ? {} : { $or: [{ origin: 'manual' }, { manualRetry: true }] };
        const job = await this.jobs.findOneAndUpdate({ ...identity, $and: [origin, { $or: [
          { status: 'pending', nextAttemptAt: { $lte: now } }, { status: 'error', nextAttemptAt: { $lte: now }, attempts: { $lt: 6 } },
          { status: 'running', leaseUntil: { $lt: now } },
        ] }] }, { $set: { status: 'running', lease, leaseUntil: new Date(Date.now() + 90000) }, $inc: { attempts: 1 } },
        { sort: { nextAttemptAt: 1 }, returnDocument: 'after', includeResultMetadata: false });
        if (!job) break;
        await this.process(job);
      }
    } catch (error: any) { this.logger.warn(this.errorText(error)); }
    finally { this.working = false; }
  }
  private errorText(error: any) { return error instanceof SyncReview || error instanceof SyncApiError ? error.message : 'تعذر إكمال المزامنة؛ حاول مجددًا أو راجع الاتصال.'; }
}
