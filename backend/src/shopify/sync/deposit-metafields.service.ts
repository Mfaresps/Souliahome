import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { Transaction } from '../../transactions/schemas/transaction.schema';
import { ShopifyOrder } from '../schemas/shopify-order.schema';
import { ShopifySyncApiService, SyncApiError } from './sync-api.service';
import {
  DEPOSIT_METAFIELD_DEFS,
  DEPOSIT_METAFIELD_NAMESPACE,
  DepositMetafieldReview,
  checkDefinitions,
  depositBookingInFlight,
  depositMetafieldChanges,
  depositStateFromOrder,
  depositStateFromTransaction,
  desiredDepositMetafields,
} from './deposit-metafields.util';

const CONFIG_ID = 'deposit-metafields';
const LEASE_MS = 90_000;
const MAX_ATTEMPTS = 8;
const DEFINITIONS_TTL_MS = 10 * 60_000;

/** Shopify refused a compare-and-set: the field changed after we read it. Re-read and re-send. */
class StaleDepositWrite extends Error {}
class LeaseLost extends Error {}
/** A receipt's vault booking or refund is not finished; retried with backoff, never guessed. */
class BookingInFlight extends Error {}
const looksStale = (errors: any[]) => errors.some((e) => /STALE|DIGEST/i.test(String(e?.code || '')) || /digest|stale|changed since/i.test(String(e?.message || '')));

const aliases = DEPOSIT_METAFIELD_DEFS
  .map((d) => `${d.key}: metafield(namespace: "${DEPOSIT_METAFIELD_NAMESPACE}", key: "${d.key}") { value compareDigest }`).join(' ');
const ORDER_QUERY = `query DepositOrder($id: ID!) { order(id: $id) { id currentTotalPriceSet { shopMoney { amount currencyCode } } ${aliases} } }`;
const DEFINITIONS_QUERY = `query { metafieldDefinitions(first: 100, ownerType: ORDER, namespace: "${DEPOSIT_METAFIELD_NAMESPACE}") { nodes { key type { name } } } }`;
const SET_MUTATION = `mutation DepositSet($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { key } userErrors { field message code } } }`;
const DELETE_MUTATION = `mutation DepositDelete($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { deletedMetafields { key } userErrors { field message } } }`;

/**
 * Mirrors the ERP deposit onto four existing Shopify order metafields (see deposit-metafields.util).
 *
 * One job per Shopify order (`_id` = Shopify order id), so any number of events coalesce into one
 * send. A payment event only bumps `seq`; the worker recomputes everything from the database when
 * it runs and, if `seq` moved while it was sending, runs once more. Two workers can never hold the
 * same order (atomic claim + lease), which is what keeps an older value from landing last.
 *
 * ⚠ Off by default, like the shipping sync: a local copy with live Shopify credentials must not
 *   write to the store. Enabling verifies the definitions and the write_orders scope first.
 * ⚠ Events still queue while it is off; enabling then sends the latest figure for each of them.
 */
@Injectable()
export class ShopifyDepositMetafieldsService implements OnModuleInit {
  private readonly logger = new Logger(ShopifyDepositMetafieldsService.name);
  private working = false;
  private definitions: { at: number; problems: string[] } | null = null;

  constructor(
    @InjectModel(Transaction.name) private readonly tx: Model<any>,
    @InjectModel(ShopifyOrder.name) private readonly orders: Model<any>,
    private readonly api: ShopifySyncApiService,
  ) {}

  private get jobs(): any { return this.tx.db.collection('shopifydepositmetafieldjobs'); }
  private get configs(): any { return this.tx.db.collection('shopifysyncconfigs'); }

  async onModuleInit() {
    await this.jobs.createIndex({ status: 1, nextAttemptAt: 1 });
  }

  private async config(): Promise<{ enabled: boolean }> {
    return (await this.configs.findOne({ _id: CONFIG_ID })) || { enabled: false };
  }

  // ── Triggers ─────────────────────────────────────────────────────────────

  /**
   * Called AFTER the ERP write that changed the deposit has been committed. Never throws and
   * never calls Shopify — the deposit workflow must not wait on, or fail because of, the store.
   */
  async requestSync(shopifyOrderId: unknown, reason = ''): Promise<void> {
    const id = String(shopifyOrderId || '').trim();
    if (!/^\d+$/.test(id)) return;
    try {
      const now = new Date();
      await this.jobs.updateOne(
        { _id: id },
        { $inc: { seq: 1 }, $set: { requestedAt: now, lastReason: reason },
          $setOnInsert: { status: 'pending', attempts: 0, nextAttemptAt: now, createdAt: now } },
        { upsert: true },
      );
      // A running job is never flipped: its worker sees the new seq and runs again itself.
      await this.jobs.updateOne(
        { _id: id, status: { $in: ['synced', 'error', 'review'] } },
        { $set: { status: 'pending', attempts: 0, nextAttemptAt: now, error: '' } },
      );
    } catch (err: any) {
      this.logger.error(`deposit metafield enqueue failed for ${id}: ${err?.message || err}`);
    }
  }

  /** For changes that only matter when a deposit was already sent (e.g. a Shopify total edit). */
  async requestSyncIfTracked(shopifyOrderId: unknown, reason = ''): Promise<void> {
    const id = String(shopifyOrderId || '').trim();
    if (!/^\d+$/.test(id)) return;
    try {
      if (await this.jobs.countDocuments({ _id: id }, { limit: 1 })) await this.requestSync(id, reason);
    } catch (err: any) {
      this.logger.error(`deposit metafield enqueue failed for ${id}: ${err?.message || err}`);
    }
  }

  /**
   * orders/updated fires ~4× per order. Remaining depends on Shopify's total, so re-send only for an
   * order already in the queue whose total differs from both the last total SENT and the last total
   * QUEUED — one _id read, no API call.
   * ⚠ Not "whenever the job is not synced": that reset a failing job to "retry now" on every webhook
   *   and defeated the backoff during a Shopify outage. Each distinct total queues at most once.
   */
  async requestSyncIfTotalChanged(shopifyOrderId: unknown, shopifyTotal: unknown): Promise<void> {
    const id = String(shopifyOrderId || '').trim();
    const total = Number(shopifyTotal);
    if (!/^\d+$/.test(id) || !Number.isFinite(total)) return;
    try {
      const job = await this.jobs.findOne({ _id: id }, { projection: { lastSent: 1, queuedTotalCents: 1 } });
      if (!job) return;
      const t = Math.round(total * 100);
      if (job.lastSent && Math.round(Number(job.lastSent.total) * 100) === t) return;
      if (job.queuedTotalCents === t) return;
      await this.jobs.updateOne({ _id: id }, { $set: { queuedTotalCents: t } });
      await this.requestSync(id, 'shopify-total');
    } catch (err: any) {
      this.logger.error(`deposit metafield enqueue failed for ${id}: ${err?.message || err}`);
    }
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  async status() {
    const config = await this.config();
    const counts = await this.jobs.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray();
    const problems = await this.jobs.find({ status: { $in: ['error', 'review'] } })
      .sort({ updatedAt: -1 }).limit(20).project({ status: 1, error: 1, ref: 1, updatedAt: 1, attempts: 1 }).toArray();
    const last = await this.jobs.find({ lastSuccessAt: { $exists: true } }).sort({ lastSuccessAt: -1 }).limit(1).toArray();
    return {
      enabled: !!config.enabled,
      counts: Object.fromEntries(counts.map((r: any) => [r._id, r.count])),
      lastSuccessAt: last[0]?.lastSuccessAt || null,
      problems: problems.map((p: any) => ({ orderId: String(p._id), ref: p.ref || '', status: p.status, error: p.error || '', attempts: p.attempts || 0, updatedAt: p.updatedAt })),
    };
  }

  async configure(enabled: boolean, by: string) {
    if (enabled) {
      const connection = await this.api.connection();
      if (!connection.scopes.includes('write_orders')) throw new BadRequestException('صلاحية write_orders غير ممنوحة لتطبيق Shopify.');
      this.definitions = null;
      const problems = await this.definitionProblems();
      if (problems.length) throw new BadRequestException('حقول العربون في Shopify غير مطابقة: ' + problems.join('، '));
    }
    await this.configs.updateOne({ _id: CONFIG_ID }, { $set: { enabled, changedBy: by, changedAt: new Date() } }, { upsert: true });
    return this.status();
  }

  async retry(shopifyOrderId: string) {
    const res = await this.jobs.updateOne(
      { _id: String(shopifyOrderId), status: { $in: ['error', 'review'] } },
      { $set: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), error: '' } },
    );
    if (!res.matchedCount) throw new BadRequestException('لا توجد محاولة متوقفة لهذا الطلب');
    return { queued: true };
  }

  // ── Worker ───────────────────────────────────────────────────────────────

  private async definitionProblems(): Promise<string[]> {
    if (this.definitions && Date.now() - this.definitions.at < DEFINITIONS_TTL_MS) return this.definitions.problems;
    const data = await this.api.query(DEFINITIONS_QUERY);
    const problems = checkDefinitions(data?.metafieldDefinitions?.nodes || []);
    this.definitions = { at: Date.now(), problems };
    return problems;
  }

  /** The ERP side, read fresh: the confirmed sale if there is one, otherwise the pending order. */
  private async erpState(shopifyOrderId: string) {
    const sales: any[] = await this.tx.find({ shopifyOrderId, type: 'مبيعات' })
      .select('ref cancelled deposit deposits depositReceipts cancellationDepositRefunds').lean();
    const live = sales.filter((s) => !s.cancelled);
    if (live.length > 1) throw new DepositMetafieldReview('أكثر من حركة مبيعات مرتبطة بنفس طلب Shopify؛ يلزم مراجعة.');
    const sale = live[0] || sales[0];
    if (sale) return { ref: sale.ref || '', state: depositStateFromTransaction(sale) };
    const order: any = await this.orders.findOne({ shopifyId: shopifyOrderId }).select('ref depositReceipts').lean();
    if (!order) throw new DepositMetafieldReview('الطلب غير موجود في النظام.');
    if (depositBookingInFlight(order)) throw new BookingInFlight('تسجيل عربون أو رده في الخزنة لم يكتمل بعد؛ سيُعاد الإرسال بعد اكتماله.');
    return { ref: String(order.ref || '').replace(/^#+/, ''), state: depositStateFromOrder(order) };
  }

  /**
   * `assertOwned` is called right before each mutation: a worker whose lease was taken over must
   * not write. compareDigest (atomic in metafieldsSet since 2024-07) closes the remaining window —
   * a write based on a read that is no longer current is refused by Shopify, not applied.
   */
  private async send(shopifyOrderId: string, assertOwned: () => Promise<void> = async () => undefined) {
    const problems = await this.definitionProblems();
    if (problems.length) throw new DepositMetafieldReview(problems.join('، '));
    const { ref, state } = await this.erpState(shopifyOrderId);
    const ownerId = `gid://shopify/Order/${shopifyOrderId}`;
    const data = await this.api.query(ORDER_QUERY, { id: ownerId });
    const remote = data?.order;
    if (!remote || remote.id !== ownerId) throw new DepositMetafieldReview('الطلب غير موجود في Shopify.');
    const desired = desiredDepositMetafields(state, remote);
    const changes = depositMetafieldChanges(desired, remote);
    // Absolute values, not increments: re-sending after an uncertain result cannot double anything.
    if (changes.set.length) {
      await assertOwned();
      const res = await this.api.query(SET_MUTATION, { m: changes.set.map((m) => ({
        ownerId, namespace: DEPOSIT_METAFIELD_NAMESPACE, key: m.key, type: m.type, value: m.value,
        compareDigest: remote?.[m.key]?.compareDigest ?? null,
      })) }, true);
      const errors = res?.metafieldsSet?.userErrors || [];
      if (!res?.metafieldsSet) throw new SyncApiError('تعذر تأكيد نتيجة Shopify.', true);
      if (errors.length && looksStale(errors)) throw new StaleDepositWrite('تغيّرت قيم Shopify أثناء الإرسال؛ ستُعاد القراءة.');
      if (errors.length) throw new DepositMetafieldReview('Shopify رفض القيم: ' + errors.map((e: any) => e.message).join('، '));
    }
    if (changes.remove.length) {
      await assertOwned();
      const res = await this.api.query(DELETE_MUTATION, { m: changes.remove.map((key) => ({
        ownerId, namespace: DEPOSIT_METAFIELD_NAMESPACE, key,
      })) }, true);
      const errors = res?.metafieldsDelete?.userErrors || [];
      if (!res?.metafieldsDelete) throw new SyncApiError('تعذر تأكيد نتيجة Shopify.', true);
      if (errors.length) throw new DepositMetafieldReview('Shopify رفض الحذف: ' + errors.map((e: any) => e.message).join('، '));
    }
    return { ref, summary: desired.summary, wrote: changes.set.length + changes.remove.length > 0 };
  }

  private async process(job: any) {
    const lock = { _id: job._id, lease: job.lease };
    try {
      const result = await this.send(String(job._id), async () => {
        const owned = await this.jobs.updateOne(lock, { $set: { leaseUntil: new Date(Date.now() + LEASE_MS) } });
        if (!owned.matchedCount) throw new LeaseLost();
      });
      const done = { status: 'synced', error: '', lastSuccessAt: new Date(), updatedAt: new Date(), ref: result.ref, lastSent: result.summary };
      const settled = await this.jobs.updateOne({ ...lock, seq: job.seq }, { $set: done, $unset: { lease: '', leaseUntil: '' } });
      // A payment event arrived while sending: what was sent may already be outdated — run again.
      if (!settled.matchedCount) {
        await this.jobs.updateOne(lock, { $set: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), updatedAt: new Date(), ref: result.ref }, $unset: { lease: '', leaseUntil: '' } });
      }
    } catch (error: any) {
      if (error instanceof LeaseLost) return; // another worker owns the job now; it reports the result
      const stale = error instanceof StaleDepositWrite;
      const inFlight = error instanceof BookingInFlight;
      const transient = stale || inFlight || (error instanceof SyncApiError && error.transient);
      const retry = transient && (job.attempts || 0) < MAX_ATTEMPTS;
      const message = error instanceof DepositMetafieldReview || error instanceof SyncApiError || stale || inFlight
        ? error.message : 'تعذر إرسال العربون إلى Shopify.';
      if (!(error instanceof DepositMetafieldReview) && !(error instanceof SyncApiError) && !stale && !inFlight) {
        this.logger.error(`deposit metafield sync ${job._id}: ${error?.message || error}`);
      }
      await this.jobs.updateOne(lock, {
        $set: { status: retry ? 'error' : 'review', error: message, updatedAt: new Date(),
          nextAttemptAt: retry ? new Date(stale ? Date.now() : Date.now() + Math.min(30, 2 ** (job.attempts || 0)) * 60_000) : null },
        $unset: { lease: '', leaseUntil: '' },
      }).catch(() => undefined);
    }
  }

  @Cron('*/10 * * * * *', { name: 'shopify-deposit-metafields' })
  async tick() {
    if (this.working) return;
    this.working = true;
    try {
      if (!(await this.config()).enabled) return;
      for (let i = 0; i < 10; i++) {
        const now = new Date(), lease = randomUUID();
        const job = await this.jobs.findOneAndUpdate(
          { $or: [
            { status: 'pending', nextAttemptAt: { $lte: now } },
            { status: 'error', nextAttemptAt: { $lte: now } },
            { status: 'running', leaseUntil: { $lt: now } },
          ] },
          { $set: { status: 'running', lease, leaseUntil: new Date(Date.now() + LEASE_MS) }, $inc: { attempts: 1 } },
          { sort: { nextAttemptAt: 1 }, returnDocument: 'after', includeResultMetadata: false },
        );
        if (!job) break;
        await this.process(job);
      }
    } catch (error: any) {
      this.logger.warn(`deposit metafield worker: ${error?.message || error}`);
    } finally {
      this.working = false;
    }
  }
}
