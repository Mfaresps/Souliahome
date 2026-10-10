import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Transaction, TransactionDocument } from './schemas/transaction.schema';
import { CarrierPayout, CarrierPayoutDocument } from './schemas/carrier-payout.schema';
import { TransactionsService } from './transactions.service';
import { BostaService } from '../bosta/bosta.service';
import { SettingsService } from '../settings/settings.service';
import { VaultService } from '../vault/vault.service';
import { ExpensesService } from '../expenses/expenses.service';
import { PresenceGateway } from '../auth/presence.gateway';
import { parseBostaPricing, parseBostaSettlementPricing, decideSettlement, r2, BostaPricing, SettleDecision } from '../shared/bosta-pricing.util';
import { CarrierBatchPayoutService } from './carrier-batch-payout.service';
import { bostaCashoutDueAt } from '../shared/bosta-cashout.util';
import { dateOnly, inDateWindow, dateWindowQuery } from '../shared/date-window.util';

/**
 * Automatic settlement of Bosta deliveries — the sibling of carrier-settlement.service.ts (which
 * settles from an uploaded file and is untouched by this one).
 *
 * Each order records remaining − Bosta's fees in the carrier wallet. Prepaid orders contribute
 * only their fees. CarrierBatchPayoutService posts one net bank credit for the scheduled group,
 * and TransactionsService owns the order/payment updates without individual vault movements.
 *
 * ⚠ SINGLE-FLIGHT. `carrierSettleLock` is taken with one atomic findOneAndUpdate. Bosta repeats
 *   DELIVERED webhooks and users double-click; the second attempt finds nothing to lock.
 *
 * Delivered funds wait in the carrier wallet until noon Cairo on the scheduled bank day.
 * The legacy recordPayout() reconciles transfers for orders already posted by the old flow.
 */

export const SETTLE_VAULTS = ['كاش', 'فودافون كاش', 'Instapay', 'تحويل بنكي'];
const LOCK_STALE_MS = 10 * 60 * 1000;
const MAX_BATCH = 100;
const DUE_PER_RUN = 25;

export type SettleTrigger = 'auto' | 'manual-select' | 'approve';

export interface SettleOneResult {
  txId: string;
  ref: string;
  outcome: 'settled' | 'wallet' | 'review' | 'skipped' | 'failed' | 'locked';
  reason: string;
  error?: string;
  net?: number;
  fees?: number;
  variance?: number;
}

const LIGHT_FIELDS =
  'ref client phone date deliveredAt total remaining deposit shipCost payStatus codCollectionStatus ' +
  'carrierSettlement bostaTrackingNumber bostaOrderId bostaStatus deliverySource shopifyOrderId cancelled type';

@Injectable()
export class CarrierAutoSettleService {
  private readonly logger = new Logger(CarrierAutoSettleService.name);
  private running = false;

  constructor(
    @InjectModel(Transaction.name) private readonly txModel: Model<TransactionDocument>,
    @InjectModel(CarrierPayout.name) private readonly payoutModel: Model<CarrierPayoutDocument>,
    private readonly transactionsService: TransactionsService,
    private readonly bostaService: BostaService,
    private readonly settingsService: SettingsService,
    private readonly vaultService: VaultService,
    private readonly expensesService: ExpensesService,
    private readonly presence: PresenceGateway,
    private readonly batchPayout: CarrierBatchPayoutService,
  ) {}

  private emit(event: string, payload: unknown): void {
    try { this.presence?.emitEvent(event, payload); } catch { /* swallow */ }
  }

  // ── Eligibility ─────────────────────────────────────────────────────────────────────────────

  /** Why this order cannot be settled at all, or '' when it can. Pure. */
  static ineligibleReason(tx: any): string {
    if (!tx) return 'not-found';
    if (tx.type !== 'مبيعات') return 'not-sale';
    if (tx.cancelled) return 'cancelled';
    if (!tx.bostaOrderId) return 'no-shipment';
    if (tx.deliverySource === 'MANUAL') return 'manual-delivery';
    if (tx.bostaStatus !== 'DELIVERED') return 'not-delivered';
    const cs = tx.carrierSettlement;
    if (cs?.status === 'settled') return 'already-settled';
    if (Number(tx.remaining || 0) > 0 && tx.codCollectionStatus === 'Collected') return 'already-collected';
    // Something was collected through the ordinary path and the order is closed.
    const livePays = (tx.payments || []).filter((p: any) => p && !p.reversed);
    if (Number(tx.remaining || 0) > 0 && tx.payStatus === 'مكتمل' && livePays.length > 0) return 'already-collected';
    return '';
  }

  private static hasOpenConflict(tx: any): boolean {
    const open = (c: any) => !!c && !c.resolved;
    return ['open', 'awaiting'].includes(tx.shipIssueState || '')
      || open(tx.addressChangeConflict)
      || open(tx.shopifyCancelConflict)
      || open(tx.externalFulfillment);
  }

  // ── Lock ────────────────────────────────────────────────────────────────────────────────────

  private async lock(txId: string): Promise<any | null> {
    const now = new Date();
    const stale = new Date(now.getTime() - LOCK_STALE_MS).toISOString();
    return this.txModel.findOneAndUpdate(
      {
        _id: txId,
        $or: [
          { carrierSettleLock: { $in: ['', null] } },
          { carrierSettleLock: { $exists: false } },
          { carrierSettleLock: { $lt: stale } },
        ],
      },
      { $set: { carrierSettleLock: now.toISOString() } },
      { new: true },
    ).lean().exec();
  }

  private async unlock(txId: string): Promise<void> {
    await this.txModel.updateOne({ _id: txId }, { $set: { carrierSettleLock: '' } }).exec();
  }

  private async writeStatement(txId: string, cs: Record<string, unknown>, history?: Record<string, unknown>): Promise<void> {
    await this.txModel.updateOne(
      { _id: txId },
      { $set: { carrierSettlement: cs }, ...(history ? { $push: { codCollectionHistory: history } } : {}) },
    ).exec();
    this.emit('tx:updated', { _id: txId });
    this.emit('settlement:changed', { txId, status: cs.status });
  }

  private statementBase(tx: any, p: BostaPricing | null, d: SettleDecision | null, trigger: SettleTrigger, vaultMethod: string, limit: number) {
    return {
      ...(tx.carrierSettlement || {}),
      trigger,
      carrier: 'bosta',
      deliveryId: tx.bostaOrderId || '',
      trackingNumber: tx.bostaTrackingNumber || '',
      deliveredAt: p?.deliveredAt || tx.deliveredAt || '',
      readAt: new Date().toISOString(),
      carrierCod: p ? p.cod : null,
      remaining: r2(tx.remaining || 0),
      billedShip: r2(tx.shipCost || 0),
      fees: p ? {
        priceAfterVat: p.priceAfterVat, priceBeforeVat: p.priceBeforeVat, shippingFee: p.shippingFee,
        sizeEffectCost: p.sizeEffectCost, insurance: p.insurance, vatRate: p.vatRate, sizeName: p.sizeName,
      } : null,
      priceChanges: p ? p.priceChanges : [],
      variance: d ? d.variance : 0,
      varianceKind: d ? d.varianceKind : '',
      net: d ? d.net : 0,
      collectNet: d ? d.collectNet : 0,
      shortfall: d ? d.shortfall : 0,
      shipLossAdd: d ? d.shipLossAdd : 0,
      shipSavingAdd: d ? d.shipSavingAdd : 0,
      limitUsed: limit,
      vaultMethod,
    };
  }

  // ── Settle one ──────────────────────────────────────────────────────────────────────────────

  async settleOne(
    txId: string,
    ctx: { trigger: SettleTrigger; by: string; vaultMethod?: string },
  ): Promise<SettleOneResult> {
    const tx = await this.lock(txId);
    if (!tx) {
      const exists = await this.txModel.exists({ _id: txId });
      return { txId, ref: '', outcome: exists ? 'locked' : 'failed', reason: exists ? 'locked' : 'not-found' };
    }
    const ref = tx.ref || String(tx._id);
    const res = (outcome: SettleOneResult['outcome'], reason: string, extra: Partial<SettleOneResult> = {}): SettleOneResult =>
      ({ txId, ref, outcome, reason, ...extra });

    try {
      const cs = tx.carrierSettlement;
      if (cs?.payoutId) return res('skipped', 'payout-in-progress');
      const settings: any = await this.settingsService.getSettings();
      const limit = Number(settings.autoSettleReviewLimit ?? 20);
      const vaultMethod = ctx.vaultMethod || cs?.vaultMethod || settings.autoSettleVaultMethod || 'تحويل بنكي';
      if (!SETTLE_VAULTS.includes(vaultMethod)) return res('failed', 'bad-vault');

      // A review/dispute is decided by an approver, never re-run by the cron or a selection.
      if (ctx.trigger !== 'approve' && ['review', 'disputed'].includes(cs?.status)) return res('skipped', 'in-review');
      if (ctx.trigger === 'approve' && !['review', 'disputed'].includes(cs?.status)) return res('skipped', 'not-in-review');

      const why = CarrierAutoSettleService.ineligibleReason(tx);
      if (why) {
        if (cs?.status === 'pending') {
          await this.writeStatement(txId, { ...cs, status: 'skipped', reason: why, readAt: new Date().toISOString() });
        }
        return res('skipped', why);
      }

      let raw: any;
      try {
        raw = await this.bostaService.fetchDelivery(tx.bostaOrderId);
      } catch (err: any) {
        // A transient outage must not release carrier-held funds to manual collection.
        await this.writeStatement(txId, { ...(cs || {}), trigger: ctx.trigger,
          status: cs?.phase === 'wallet' ? 'pending' : 'skipped',
          ...(cs?.phase === 'wallet' ? { dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() } : {}),
          reason: 'fetch-failed', error: String(err?.message || err), readAt: new Date().toISOString() });
        return res('failed', 'fetch-failed', { error: String(err?.message || err) });
      }

      const pricing = parseBostaSettlementPricing(raw);
      const livePays = (tx.payments || []).filter((p: any) => p && !p.reversed);
      const decision = decideSettlement({
        remaining: tx.remaining || 0,
        billedShip: tx.shipCost || 0,
        pricing,
        hasOpenConflict: CarrierAutoSettleService.hasOpenConflict(tx),
        hasPriorCollection: Number(tx.remaining || 0) > 0 && livePays.length > 0,
        reviewLimit: limit,
        allowOverLimit: ctx.trigger === 'approve' || cs?.approvedFees === pricing?.priceAfterVat,
      });
      const base: Record<string, any> = this.statementBase(tx, pricing, decision, ctx.trigger, vaultMethod, limit);
      // Review rows still belong to their scheduled batch, so it cannot post around them.
      base.cashoutDueAt = bostaCashoutDueAt(raw);
      if (pricing?.isDelivered) base.phase = 'wallet';
      const nums = { net: decision.net, fees: decision.fees, variance: decision.variance };

      if (decision.outcome === 'skip') {
        await this.writeStatement(txId, { ...base,
          status: cs?.phase === 'wallet' ? 'pending' : 'skipped', reason: decision.reason,
          ...(cs?.phase === 'wallet' ? { dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() } : {}),
        });
        return res('skipped', decision.reason, nums);
      }
      if (decision.outcome === 'review') {
        await this.writeStatement(txId, { ...base, status: 'review', reason: decision.reason });
        this.emit('settlement:review', { txId, ref, reason: decision.reason, variance: decision.variance });
        return res('review', decision.reason, nums);
      }

      // Order settlement only records Bosta's wallet. A batch owns the bank credit.
      const dueAt = bostaCashoutDueAt(raw);
      const delivery = raw?.data || raw;
      const feeOnly = Number(tx.remaining || 0) === 0;
      const depositedAt = delivery?.wallet?.cashCycle?.deposited_at || cs?.walletDepositedAt
        || (feeOnly ? pricing?.deliveredAt || tx.deliveredAt || new Date().toISOString() : '');
      await this.writeStatement(txId, {
        ...base, status: 'pending', phase: 'wallet', error: '',
        reason: !dueAt ? 'cashout-date-missing' : !depositedAt ? 'wallet-not-deposited' : 'awaiting-cashout',
        walletDepositedAt: depositedAt, cashoutDueAt: dueAt,
        dueAt: dueAt && Date.parse(dueAt) > Date.now() ? dueAt : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        approvedFees: ctx.trigger === 'approve' ? decision.fees : cs?.approvedFees,
      });
      return res('wallet', 'awaiting-cashout', nums);
    } catch (err: any) {
      this.logger.error(`carrier-settle failed tx=${ref}: ${err?.message || err}`);
      return res('failed', 'error', { error: String(err?.message || err) });
    } finally {
      await this.unlock(txId).catch(() => undefined);
    }
  }

  // ── The scheduled run ───────────────────────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE, { name: 'carrier-auto-settle' })
  async runDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const nowIso = new Date().toISOString();
      const settings: any = await this.settingsService.getSettings();
      if (settings?.autoSettleEnabled) {
        // Prepaid deliveries also incur fees, even though there is no customer COD to collect.
        await this.txModel.updateMany({ type: 'مبيعات', cancelled: { $ne: true }, bostaStatus: 'DELIVERED',
          bostaOrderId: { $exists: true, $nin: ['', null] }, deliverySource: { $ne: 'MANUAL' },
          remaining: { $lte: 0 }, carrierSettlement: null,
          deliveredAt: { $gte: settings.autoSettleSince || nowIso.slice(0, 10) },
        }, { $set: { carrierSettlement: { status: 'pending', trigger: 'auto', scheduledAt: nowIso, dueAt: nowIso } } }).exec();
      }
      if (!settings?.autoSettleEnabled) {
        // Switched off while orders were queued: release them to manual collection rather than
        // leave them blocking the ordinary collect button forever.
        await this.txModel.updateMany(
          { 'carrierSettlement.status': 'pending', 'carrierSettlement.phase': { $ne: 'wallet' } },
          { $set: { 'carrierSettlement.status': 'skipped', 'carrierSettlement.reason': 'disabled' } },
        ).exec();
      }
      const due = await this.txModel
        .find({ 'carrierSettlement.status': 'pending', 'carrierSettlement.dueAt': { $lte: nowIso },
          ...(!settings?.autoSettleEnabled ? { 'carrierSettlement.phase': 'wallet' } : {}) })
        .select('_id').limit(DUE_PER_RUN).lean().exec();
      for (const d of due) {
        await this.settleOne(String(d._id), { trigger: 'auto', by: 'system:auto' });
      }
      await this.batchPayout.runDue();
    } catch (err: any) {
      this.logger.error(`carrier-auto-settle run failed: ${err?.message || err}`);
    } finally {
      this.running = false;
    }
  }

  // ── Selection: preview then settle ──────────────────────────────────────────────────────────

  private async mapLimited<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    });
    await Promise.all(workers);
    return out;
  }

  private cleanIds(ids: unknown): string[] {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((s) => /^[a-f0-9]{24}$/i.test(s)))];
    if (!list.length) throw new BadRequestException('لم يتم اختيار أي طلب');
    if (list.length > MAX_BATCH) throw new BadRequestException(`الحد الأقصى ${MAX_BATCH} طلب في المرة الواحدة`);
    return list;
  }

  /** Reads Bosta for each order and says what settling would do. Writes nothing. */
  async preview(ids: unknown, isAdmin: boolean) {
    const list = this.cleanIds(ids);
    const settings: any = await this.settingsService.getSettings();
    const limit = Number(settings.autoSettleReviewLimit ?? 20);
    const txs: any[] = await this.txModel.find({ _id: { $in: list } })
      .select(LIGHT_FIELDS + ' payments shipIssueState addressChangeConflict shopifyCancelConflict externalFulfillment actualShipCost shipLoss shipSaving')
      .lean().exec();
    const byId = new Map(txs.map((t) => [String(t._id), t]));

    const rows = await this.mapLimited(list, 5, async (id) => {
      const tx = byId.get(id);
      const base = { txId: id, ref: tx?.ref || '', client: tx?.client || '', remaining: r2(tx?.remaining || 0), billedShip: r2(tx?.shipCost || 0), deliveredAt: tx?.deliveredAt || '' };
      const why = CarrierAutoSettleService.ineligibleReason(tx);
      if (why) return { ...base, outcome: 'ineligible', reason: why };
      if (['review', 'disputed'].includes(tx.carrierSettlement?.status)) return { ...base, outcome: 'ineligible', reason: 'in-review' };
      try {
        const raw = await this.bostaService.fetchDelivery(tx.bostaOrderId);
        const pricing = parseBostaPricing(raw);
        const cashoutDueAt = bostaCashoutDueAt(raw);
        const delivery = raw?.data || raw;
        const awaitsCashout = !cashoutDueAt || Date.now() < Date.parse(cashoutDueAt)
          || !delivery?.wallet?.cashCycle?.deposited_at;
        const livePays = (tx.payments || []).filter((p: any) => p && !p.reversed);
        const d = decideSettlement({
          remaining: tx.remaining || 0, billedShip: tx.shipCost || 0, pricing,
          hasOpenConflict: CarrierAutoSettleService.hasOpenConflict(tx), hasPriorCollection: Number(tx.remaining || 0) > 0 && livePays.length > 0, reviewLimit: limit,
        });
        return {
          ...base, outcome: d.outcome, reason: d.reason, fees: d.fees, variance: d.variance, varianceKind: d.varianceKind,
          net: d.net, carrierCod: pricing?.cod ?? null, deliveredAt: pricing?.deliveredAt || base.deliveredAt,
          priceChanges: pricing?.priceChanges || [], cashoutDueAt, awaitsCashout,
        };
      } catch (err: any) {
        return { ...base, outcome: 'failed', reason: 'fetch-failed', error: String(err?.message || err) };
      }
    });

    const settleRows = rows.filter((r: any) => r.outcome === 'settle');
    return {
      rows,
      totals: {
        settle: settleRows.length,
        review: rows.filter((r: any) => r.outcome === 'review').length,
        skip: rows.filter((r: any) => ['skip', 'ineligible', 'failed'].includes(r.outcome)).length,
        net: r2(settleRows.reduce((s: number, r: any) => s + (r.net || 0), 0)),
        vaultNet: 0, // Selection only records wallet rows; the batch creates the bank credit.
        fees: r2(settleRows.reduce((s: number, r: any) => s + (r.fees || 0), 0)),
      },
      defaultVault: settings.autoSettleVaultMethod || 'تحويل بنكي',
      reviewLimit: limit,
      // Segment balances are admin-only everywhere else in the app; the same rule holds here.
      balances: isAdmin ? {
        'كاش': settings.vaultCash || 0, 'فودافون كاش': settings.vaultVodafone || 0,
        'Instapay': settings.vaultInstapay || 0, 'تحويل بنكي': settings.vaultBank || 0,
      } : null,
    };
  }

  /** Settles each selected order on its own — one failure never stops the rest. */
  async settleMany(ids: unknown, vaultMethod: string, by: string) {
    const list = this.cleanIds(ids);
    if (!SETTLE_VAULTS.includes(vaultMethod)) throw new BadRequestException('اختر الخزنة');
    const results: SettleOneResult[] = [];
    for (const id of list) results.push(await this.settleOne(id, { trigger: 'manual-select', by, vaultMethod }));
    const settled = results.filter((r) => r.outcome === 'settled');
    return {
      results,
      settled: settled.length,
      wallet: results.filter((r) => r.outcome === 'wallet').length,
      review: results.filter((r) => r.outcome === 'review').length,
      skipped: results.filter((r) => r.outcome === 'skipped' || r.outcome === 'locked').length,
      failed: results.filter((r) => r.outcome === 'failed').length,
      net: r2(settled.reduce((s, r) => s + (r.net || 0), 0)),
      vaultMethod,
    };
  }

  // ── Review decisions ────────────────────────────────────────────────────────────────────────

  async approve(txId: string, vaultMethod: string, by: string) {
    const r = await this.settleOne(txId, { trigger: 'approve', by, vaultMethod });
    if (r.outcome === 'skipped' && r.reason === 'not-in-review') throw new BadRequestException('هذا الطلب ليس قيد المراجعة');
    return r;
  }

  async dispute(txId: string, note: string, by: string) {
    const tx: any = await this.txModel.findById(txId).select('carrierSettlement ref').lean().exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    if (tx.carrierSettlement?.status !== 'review') throw new BadRequestException('يمكن فتح نزاع على طلب قيد المراجعة فقط');
    if (!String(note || '').trim()) throw new BadRequestException('اكتب سبب النزاع');
    await this.writeStatement(txId, { ...tx.carrierSettlement, status: 'disputed', disputeNote: String(note).trim(), disputedBy: by, disputedAt: new Date().toISOString() });
    return { success: true };
  }

  async reverse(txId: string, by: string) {
    return this.transactionsService.reverseCarrierSettlement(txId, by, 'undo');
  }

  // ── Lists and figures ───────────────────────────────────────────────────────────────────────

  private baseFilter(): Record<string, unknown> {
    return {
      type: 'مبيعات',
      cancelled: { $ne: true },
      bostaOrderId: { $nin: [null, ''] },
      bostaStatus: 'DELIVERED',
      deliverySource: { $ne: 'MANUAL' },
    };
  }

  private statusFilter(status: string): Record<string, unknown> {
    switch (status) {
      case 'settled': return { 'carrierSettlement.status': 'settled' };
      case 'review': return { 'carrierSettlement.status': 'review' };
      case 'disputed': return { 'carrierSettlement.status': 'disputed' };
      case 'pending': return { 'carrierSettlement.status': 'pending' };
      case 'unsettled': return {
        $and: [
          { $or: [{ carrierSettlement: null }, { 'carrierSettlement.status': { $in: ['skipped', 'reversed'] } }] },
          { $or: [{ remaining: { $lte: 0 } }, { codCollectionStatus: { $ne: 'Collected' } }] },
          { $or: [
            { remaining: { $gt: 0 }, payStatus: { $ne: 'مكتمل' } },
            { remaining: { $lte: 0 } },
          ] },
        ],
      };
      default: return {};
    }
  }

  async list(q: { status?: string; from?: string; to?: string; search?: string; page?: string; limit?: string }) {
    const status = String(q.status || 'all');
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const filter: Record<string, unknown> = { ...this.baseFilter(), ...this.statusFilter(status) };
    const win = dateWindowQuery(q.from, q.to);
    if (win) filter.deliveredAt = win;
    const s = String(q.search || '').trim();
    if (s) {
      const rx = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ ref: rx }, { client: rx }, { bostaTrackingNumber: rx }];
    }
    const [rows, total, counts] = await Promise.all([
      this.txModel.find(filter).select(LIGHT_FIELDS).sort({ deliveredAt: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.txModel.countDocuments(filter).exec(),
      this.counts(),
    ]);
    return { rows, total, page, limit, counts };
  }

  private async counts() {
    const base = this.baseFilter();
    const [all, settled, review, disputed, unsettled, pending] = await Promise.all(
      ['all', 'settled', 'review', 'disputed', 'unsettled', 'pending'].map((st) =>
        this.txModel.countDocuments({ ...base, ...this.statusFilter(st) }).exec()),
    );
    return { all, settled, review, disputed, unsettled, pending };
  }

  async summary(from?: string, to?: string) {
    const settled: any[] = await this.txModel
      .find({ ...this.baseFilter(), 'carrierSettlement.status': 'settled' })
      .select('carrierSettlement').lean().exec();
    // By SETTLEMENT date, like the vault entries: an old delivery settled today is this month's
    // booking. (The statement, by contrast, dates lines by delivery — that is when Bosta collected.)
    const inWin = settled.filter((t) => inDateWindow(t.carrierSettlement?.settledAt || t.carrierSettlement?.deliveredAt, from, to));
    const sum = (f: (cs: any) => number) => r2(inWin.reduce((s, t) => s + (f(t.carrierSettlement) || 0), 0));
    const stmt = await this.statement();
    const batchPayouts: any[] = await this.payoutModel.find({ mode: 'batch', state: { $in: ['posted', 'completed'] } }).lean().exec();
    const batchNet = r2(batchPayouts.filter(p => inDateWindow(p.date, from, to)).reduce((s, p) => s + p.amount, 0));
    const counts = await this.counts();
    const settings: any = await this.settingsService.getSettings();
    return {
      count: inWin.length,
      fees: sum((cs) => cs.fees?.priceAfterVat),
      netIn: r2(batchNet + sum((cs) => (!cs.payoutId && cs.net > 0 ? cs.net : 0))),
      netOut: sum((cs) => (!cs.payoutId && cs.net < 0 ? -cs.net : 0)),
      over: sum((cs) => cs.shipLossAdd),
      saving: sum((cs) => cs.shipSavingAdd),
      bostaBalance: stmt.balance,
      counts,
      enabled: !!settings.autoSettleEnabled,
      since: settings.autoSettleSince || '',
      defaultVault: settings.autoSettleVaultMethod || 'تحويل بنكي',
      reviewLimit: Number(settings.autoSettleReviewLimit ?? 20),
      transferFee: Number(settings.carrierTransferFee ?? 25),
    };
  }

  // ── كشف حساب بوسطة ──────────────────────────────────────────────────────────────────────────

  /**
   * Every line between us and Bosta, oldest first, with what Bosta holds for us after each one.
   * Derived on request — nothing here is stored twice.
   *   in : cash Bosta collected for us
   *   out: its delivery fees, return-leg fees, transfers to us, transfer fees, booked differences
   */
  async statement(from?: string, to?: string) {
    const settings: any = await this.settingsService.getSettings();
    const since = settings.autoSettleSince || '';

    const [settledTx, failedTx, payouts] = await Promise.all([
      this.txModel.find({ type: 'مبيعات', $or: [
        { 'carrierSettlement.status': 'settled' },
        { 'carrierSettlement.status': { $in: ['pending', 'review', 'disputed'] }, 'carrierSettlement.phase': 'wallet', 'carrierSettlement.walletDepositedAt': { $exists: true, $nin: ['', null] } },
      ] })
        .select('ref client carrierSettlement').lean().exec(),
      since
        ? this.txModel.find({ type: 'مبيعات', 'failedDelivery.returnShipCost': { $gt: 0 }, 'failedDelivery.closedAt': { $gte: since } })
          .select('ref client failedDelivery').lean().exec()
        : Promise.resolve([] as any[]),
      this.payoutModel.find({}).lean().exec(),
    ]);

    type Line = { date: string; at: string; kind: string; ref: string; txId?: string; party?: string; in: number; out: number; payoutId?: string; note?: string; batch?: boolean };
    const lines: Line[] = [];
    for (const t of settledTx as any[]) {
      const cs = t.carrierSettlement;
      const at = String(cs.walletDepositedAt || cs.deliveredAt || cs.settledAt || '');
      const date = dateOnly(at);
      if (Number(cs.carrierCod) > 0) lines.push({ date, at, kind: 'collection', ref: t.ref, txId: String(t._id), party: t.client, in: r2(cs.carrierCod), out: 0 });
      lines.push({ date, at, kind: 'fees', ref: t.ref, txId: String(t._id), party: t.client, in: 0, out: r2(cs.fees?.priceAfterVat || 0), note: cs.fees?.sizeName || '' });
      if (cs.phase === 'bank' && cs.cashoutDueAt && !cs.payoutId) {
        lines.push({ date: dateOnly(cs.cashoutDueAt), at: cs.cashoutDueAt, kind: 'bank-transfer', ref: t.ref, txId: String(t._id), in: 0, out: r2(cs.net), note: cs.vaultMethod });
      }
    }
    for (const t of failedTx as any[]) {
      const at = String(t.failedDelivery.closedAt || '');
      lines.push({ date: dateOnly(at), at, kind: 'return-fee', ref: t.ref, txId: String(t._id), party: t.client, in: 0, out: r2(t.failedDelivery.returnShipCost) });
    }
    for (const p of payouts as any[]) {
      if (p.mode === 'batch' && !['posted', 'completed'].includes(p.state)) continue;
      const at = `${p.date}T23:59:58`;
      lines.push({ date: p.date, at, kind: 'payout', ref: p.payoutNo, payoutId: String(p._id), in: 0, out: r2(p.amount), note: p.vaultMethod, ...(p.mode === 'batch' ? { batch: true } : {}) });
      if (p.fee > 0) lines.push({ date: p.date, at: `${p.date}T23:59:59`, kind: 'transfer-fee', ref: p.payoutNo, payoutId: String(p._id), in: 0, out: r2(p.fee) });
      if (p.adjustment) lines.push({ date: p.date, at: `${p.date}T23:59:59.5`, kind: 'adjustment', ref: p.payoutNo, payoutId: String(p._id), in: 0, out: r2(-p.adjustment) });
    }
    lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    let bal = 0;
    let opening = 0;
    const shown: Array<Line & { balance: number }> = [];
    for (const l of lines) {
      bal = r2(bal + l.in - l.out);
      if (from && l.date < dateOnly(from)) { opening = bal; continue; }
      if (to && l.date > dateOnly(to)) continue;
      shown.push({ ...l, balance: bal });
    }
    const totalReturnFees = r2(lines.filter((l) => l.kind === 'return-fee').reduce((s, l) => s + l.out, 0));
    const booked = r2((payouts as any[]).reduce((s, p) => s + (Number(p.returnFeesBooked) || 0), 0));
    return {
      opening,
      lines: shown,
      balance: bal,
      totals: {
        in: r2(shown.reduce((s, l) => s + l.in, 0)),
        out: r2(shown.reduce((s, l) => s + l.out, 0)),
      },
      unbookedReturnFees: r2(Math.max(0, totalReturnFees - booked)),
      transferFee: Number(settings.carrierTransferFee ?? 25),
      defaultVault: settings.autoSettleVaultMethod || 'تحويل بنكي',
    };
  }

  private async nextPayoutNo(): Promise<string> {
    const last: any = await this.payoutModel.findOne({}).sort({ createdAt: -1 }).select('payoutNo').lean().exec();
    const n = last ? Number(String(last.payoutNo).replace(/\D/g, '')) || 0 : 0;
    return `PAY-${String(n + 1).padStart(3, '0')}`;
  }

  /** Expected figure for a transfer about to be recorded — the dialog shows it before the click. */
  async payoutPreview(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new BadRequestException('تاريخ غير صالح');
    const upTo = await this.statement(undefined, date);
    const lastLine = upTo.lines[upTo.lines.length - 1];
    return {
      expected: lastLine ? lastLine.balance : upTo.opening,
      unbookedReturnFees: upTo.unbookedReturnFees,
      transferFee: upTo.transferFee,
      defaultVault: upTo.defaultVault,
    };
  }

  async recordPayout(
    dto: { date: string; amount: number; fee?: number; vaultMethod: string; bostaRef?: string; note?: string; bookDifference?: boolean },
    by: string,
  ) {
    const date = String(dto.date || '');
    const amount = r2(Number(dto.amount));
    const fee = r2(Math.max(0, Number(dto.fee ?? 0)));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('تاريخ التحويل غير صالح');
    if (!(amount > 0)) throw new BadRequestException('اكتب المبلغ الذي وصل');
    if (!SETTLE_VAULTS.includes(dto.vaultMethod)) throw new BadRequestException('اختر الخزنة التي وصل لها التحويل');

    const batch: any = await this.payoutModel.findOne({ batchKey: date + ':' + dto.vaultMethod }).lean().exec();
    const queued: any = await this.txModel.findOne({ 'carrierSettlement.phase': 'wallet',
      'carrierSettlement.status': 'pending', 'carrierSettlement.cashoutDueAt': { $regex: '^' + date },
      'carrierSettlement.vaultMethod': dto.vaultMethod }).lean().exec();
    if (batch || queued) {
      const dueAt = queued?.carrierSettlement?.cashoutDueAt || bostaCashoutDueAt({ wallet: { cashout: { next_cashout_date: date } } });
      if (Date.now() < Date.parse(dueAt)) throw new BadRequestException('موعد تحويل هذه الدفعة لم يحن بعد');
      return this.batchPayout.post(dueAt, dto.vaultMethod, by, { amount, fee,
        note: dto.note, bostaRef: dto.bostaRef, bookDifference: dto.bookDifference });
    }
    const pv = await this.payoutPreview(date);
    const difference = r2(pv.expected - amount - fee);
    const payoutNo = await this.nextPayoutNo();

    let feeExpenseId = '';
    if (fee > 0) {
      const exp: any = await this.expensesService.createApproved(
        {
          date,
          desc: `رسوم تحويل بوسطة ${payoutNo}`,
          category: 'رسوم تحويل',
          amount: fee,
          employee: by,
          account: dto.vaultMethod,
          notes: dto.bostaRef ? `مرجع بوسطة: ${dto.bostaRef}` : '',
        } as any,
        by,
      );
      feeExpenseId = String(exp._id);
    }

    // Return-leg fees reach the vault only here (closeFailedDelivery books none), plus the
    // difference when the user chose to book it.
    const adjustment = dto.bookDifference ? r2(-difference) : 0;
    const vaultDelta = r2(-pv.unbookedReturnFees + adjustment);
    let adjustmentVaultEntryId = '';
    if (vaultDelta !== 0) {
      try {
        const e = await this.vaultService.addSystemEntry(
          vaultDelta,
          dto.vaultMethod,
          `تسوية تحويل بوسطة ${payoutNo}${pv.unbookedReturnFees ? ` — رسوم رجوع ${pv.unbookedReturnFees} ج` : ''}${adjustment ? ` — فرق ${r2(-adjustment)} ج` : ''}`,
          date,
          vaultDelta < 0 ? 'مصروف' : 'تحصيل',
          payoutNo,
          {},
          by,
          { carrierPayout: payoutNo },
        );
        adjustmentVaultEntryId = String(e._id);
      } catch (err) {
        if (feeExpenseId) await this.expensesService.remove(feeExpenseId, true).catch(() => undefined);
        throw err;
      }
    }

    const doc = await this.payoutModel.create({
      payoutNo, carrier: 'bosta', date, amount, fee, feeExpenseId, vaultMethod: dto.vaultMethod,
      expected: pv.expected, difference, returnFeesBooked: pv.unbookedReturnFees, adjustment, adjustmentVaultEntryId,
      bostaRef: String(dto.bostaRef || ''), note: String(dto.note || ''), by,
    });
    this.emit('settlement:changed', { payoutNo });
    return doc.toObject();
  }

  async deletePayout(id: string) {
    const p: any = await this.payoutModel.findById(id).exec();
    if (!p) throw new NotFoundException('التحويل غير موجود');
    if (p.mode === 'batch') throw new BadRequestException('لا يمكن حذف التحويل المجمع منفردًا؛ يلزم مراجعة وتسوية جميع الطلبات المرتبطة به');
    if (p.adjustmentVaultEntryId) await this.vaultService.removeSystemEntryById(p.adjustmentVaultEntryId);
    if (p.feeExpenseId) await this.expensesService.remove(p.feeExpenseId, true).catch(() => undefined);
    await p.deleteOne();
    this.emit('settlement:changed', { payoutNo: p.payoutNo, deleted: true });
    return { success: true };
  }

  // ── Live Bosta details for the invoice page ─────────────────────────────────────────────────

  private detailsCache = new Map<string, { at: number; data: any }>();

  /**
   * What Bosta knows about one shipment, read live and trimmed to what the invoice shows.
   * ⚠ Read-only and never stored: the copy in `bostaRawResponse` is a snapshot from the last sync
   *   (delivered orders are not re-synced), so its `wallet` block is missing on most orders.
   * ⚠ No customer data leaves here — no phones, no addresses. The courier is named, not dialled.
   * Cached 2 minutes per order so reopening an invoice does not call Bosta again.
   */
  async bostaDetails(txId: string, fresh = false) {
    const hit = this.detailsCache.get(txId);
    if (!fresh && hit && Date.now() - hit.at < 120000) return hit.data;
    const tx: any = await this.txModel.findById(txId).select('bostaOrderId bostaTrackingNumber shipCost').lean().exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    if (!tx.bostaOrderId) return { available: false };
    const raw = await this.bostaService.fetchDelivery(tx.bostaOrderId);
    const d = raw?.data && typeof raw.data === 'object' ? raw.data : raw || {};
    const n = (v: any) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : r2(Number(v)));
    const cc = d.wallet?.cashCycle || null;
    const pricing = parseBostaPricing(d);
    const data = {
      available: true,
      fetchedAt: new Date().toISOString(),
      trackingNumber: d.trackingNumber || tx.bostaTrackingNumber || '',
      state: { code: d.state?.code ?? null, value: d.state?.value || d.maskedState || '', deliveryTime: d.state?.deliveryTime || '' },
      specs: {
        itemsCount: d.specs?.packageDetails?.itemsCount ?? null,
        description: d.specs?.packageDetails?.description || '',
        packageType: d.specs?.packageType || '',
        weight: n(d.specs?.weight),
      },
      allowToOpenPackage: d.allowToOpenPackage === true,
      counts: {
        deliveryAttempts: d.deliveryAttemptsLength ?? d.attemptsCount ?? null,
        returnAttempts: d.returnAttemptsLength ?? null,
        pickupAttempts: d.pickupAttemptsLength ?? null,
        calls: d.callsNumber ?? null,
        sms: d.smsNumber ?? null,
        lastCallTime: d.lastCallTime || '',
      },
      isConfirmedDelivery: d.isConfirmedDelivery === true,
      isDelayed: d.isDelayed === true,
      sla: {
        orderDeadline: d.sla?.orderSla?.orderSlaTimestamp || '',
        orderExceeded: d.sla?.orderSla?.isExceededOrderSla === true,
      },
      attempts: (Array.isArray(d.attempts) ? d.attempts : []).map((a: any) => ({
        type: a.type || '',
        date: a.attemptDate || a.createdAt || '',
        succeededAt: a.succeededAt || '',
        codAmount: n(a.codAmount),
        courier: a.star?.name || '',
        hub: a.warehouse?.name || '',
        // A failed attempt carries Bosta's reason in `exception.reason` (e.g. «the customer changed
        // the address»). `consignee` holds the customer's phone and is deliberately not copied.
        reason: a.exception?.reason || '',
        rescheduledFor: a.exception?.scheduledAt || '',
      })),
      firstHub: d.firstHub ? { name: d.firstHub.warehouse?.nameAr || d.firstHub.warehouse?.name || '', at: d.firstHub.time || '' } : null,
      assignedHub: d.assignedHub ? { name: d.assignedHub.nameAr || d.assignedHub.name || '' } : null,
      sizeChanges: pricing ? pricing.priceChanges.filter((c) => c.sizeBefore && c.sizeAfter && c.sizeBefore !== c.sizeAfter) : [],
      wallet: cc ? {
        cod: n(cc.cod),
        bostaFees: n(cc.bosta_fees),
        depositedAmount: n(cc.deposited_amt),
        depositedAt: cc.deposited_at || '',
        size: cc.size || '',
        shippingFees: n(cc.shipping_fees),
        insuranceFees: n(cc.insurance_fees),
        // ⚠ cashCycle rounds the rate to 2dp (0.005 → "0.01" = 1%), so the plan's own figure is used.
        insurancePct: d.insurancePlanInfo?.orderValueFeePercentage ?? d.pricing?.insuranceFee?.percentage ?? null,
        insuranceMin: n(d.insurancePlanInfo?.orderMinimumFees),
        vat: n(cc.vat),
        extraFees: {
          collection: n(cc.collection_fees), cod: n(cc.cod_fees), pos: n(cc.pos_fees), expedite: n(cc.expedite_fees),
          openingPackage: n(cc.opening_package_fees), testingPackage: n(cc.testing_package_fees), flexShip: n(cc.flex_ship_fees),
          fulfillment: n(cc.fulfillment_fees), escrow: n(cc.escrow_fees), zeroDiscount: n(cc.zero_discount_fees),
        },
        discounts: {
          rto: n(cc.rto_discount), bundle: n(cc.bundle_discount), promotion: n(cc.promotion_discount_amount),
          credits: n(cc.bosta_credits_consumed),
        },
        nextCashoutDate: d.wallet?.cashout?.next_cashout_date || '',
        compensation: d.wallet?.compensation ?? null,
      } : null,
      // When the wallet record is not there yet, the log price is the best figure available.
      logFees: pricing ? { priceAfterVat: pricing.priceAfterVat, shippingFee: pricing.shippingFee, insurance: pricing.insurance, vatRate: pricing.vatRate, sizeName: pricing.sizeName } : null,
      billedShip: r2(tx.shipCost || 0),
    };
    this.detailsCache.set(txId, { at: Date.now(), data });
    if (this.detailsCache.size > 500) this.detailsCache.delete(this.detailsCache.keys().next().value as string);
    return data;
  }

  /** What Bosta charged on a failed shipment — pre-fills «تكلفة رحلة الرجوع». Never writes. */
  async returnFees(txId: string) {
    const tx: any = await this.txModel.findById(txId).select('bostaOrderId shipmentAttempts').lean().exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    const id = tx.bostaOrderId || (tx.shipmentAttempts || []).slice(-1)[0]?.bostaOrderId || '';
    if (!id) return { fees: null };
    try {
      const p = parseBostaPricing(await this.bostaService.fetchDelivery(id));
      return { fees: p ? p.priceAfterVat : null };
    } catch {
      return { fees: null };
    }
  }
}
