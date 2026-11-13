import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Transaction, TransactionDocument } from './schemas/transaction.schema';
import { VaultService } from '../vault/vault.service';
import { PresenceGateway } from '../auth/presence.gateway';
import {
  CreditMove, RECON_TOLERANCE, customerKeyOf, hasLiveShipment, reconcile, round2,
} from '../shared/payment-reconciliation.util';

/**
 * Overpayment resolution on SALES — keep as customer credit, refund, transfer to another order of
 * the same customer, or leave open. Every figure is derived from the order's money logs
 * (shared/payment-reconciliation.util.ts); nothing here edits a deposit or a payment.
 *
 * ⚠ Cash moves ONLY when a refund is COMPLETED (one vault outflow, source «رد زيادة دفع»).
 *   Requesting a refund, keeping credit and transferring between orders move no cash.
 * ⚠ Every write is conditional on the order's money state (`overpayRevision`, deposit, payment and
 *   deposit counts) being what was read; a concurrent payment, edit or credit move makes it fail
 *   instead of computing a balance from stale data. A repeated `requestKey` returns the same move.
 */
export const OVERPAY_REFUND_SOURCE = 'رد زيادة دفع';
const SALE = 'مبيعات';

export interface CreditActor { name: string; role: string }

@Injectable()
export class OrderCreditService {
  constructor(
    @InjectModel(Transaction.name) private readonly txModel: Model<TransactionDocument>,
    private readonly vault: VaultService,
    @Optional() private readonly presence?: PresenceGateway,
  ) {}

  private assertAdmin(actor: CreditActor) {
    if (actor.role !== 'admin') throw new ForbiddenException('معالجة زيادة الدفع للمدير فقط');
  }

  private async loadSale(id: string): Promise<TransactionDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('الطلب غير موجود');
    const tx = await this.txModel.findById(id).exec();
    if (!tx) throw new NotFoundException('الطلب غير موجود');
    if (tx.type !== SALE) throw new BadRequestException('زيادة الدفع تخص فواتير البيع فقط');
    return tx;
  }

  /** The money state a write is conditional on. */
  private guardOf(tx: any): Record<string, any> {
    return {
      _id: tx._id, cancelled: { $ne: true },
      $expr: { $and: [
        { $eq: [{ $ifNull: ['$overpayRevision', 0] }, Number(tx.overpayRevision) || 0] },
        { $eq: [{ $ifNull: ['$deposit', 0] }, Number(tx.deposit) || 0] },
        { $eq: [{ $ifNull: ['$total', 0] }, Number(tx.total) || 0] },
        { $eq: [{ $size: { $ifNull: ['$payments', []] } }, (tx.payments || []).length] },
        { $eq: [{ $size: { $ifNull: ['$deposits', []] } }, (tx.deposits || []).length] },
      ] },
    };
  }

  /** remaining / payStatus / mode after `moves`, plus the audit row — written with the move. */
  private derived(tx: any, moves: any[], mode: string | undefined, log: Record<string, any>) {
    const before = reconcile(tx);
    const after = reconcile({ ...tx, creditMoves: moves, ...(mode !== undefined ? { overpaymentMode: mode } : {}) });
    const finalMode = after.overpayment > RECON_TOLERANCE ? after.mode : '';
    return {
      after,
      set: {
        creditMoves: moves,
        remaining: after.remaining,
        payStatus: after.remaining <= RECON_TOLERANCE ? 'مكتمل' : 'معلق',
        overpaymentMode: finalMode,
        reconciliationLog: [...(tx.reconciliationLog || []), {
          at: new Date().toISOString(), ref: tx.ref || '', total: after.total, totalPaid: after.netPaid,
          previousRemaining: before.remaining, newRemaining: after.remaining,
          previousOverpayment: before.overpayment, overpayment: after.overpayment,
          resolution: finalMode || (after.overpayment > RECON_TOLERANCE ? 'pending' : ''), ...log,
        }],
      },
    };
  }

  private async write(tx: any, set: Record<string, any>): Promise<TransactionDocument> {
    const saved = await this.txModel.findOneAndUpdate(this.guardOf(tx), { $set: set, $inc: { overpayRevision: 1 } }, { new: true }).exec();
    if (!saved) throw new BadRequestException('تغيّرت مدفوعات الطلب أثناء العملية — حدّث الصفحة وأعد المحاولة');
    try { this.presence?.emitEvent('tx:updated', { _id: String(saved._id) }); } catch { /* live refresh only */ }
    return saved;
  }

  private present(tx: any) {
    const o = typeof tx?.toObject === 'function' ? tx.toObject() : tx;
    return {
      _id: String(o._id), ref: o.ref || '', client: o.client || '', phone: o.phone || '',
      cancelled: !!o.cancelled, liveShipment: hasLiveShipment(o),
      reconciliation: reconcile(o), creditMoves: o.creditMoves || [], reconciliationLog: o.reconciliationLog || [],
    };
  }

  async summary(id: string) {
    const tx = await this.loadSale(id);
    const credits = await this.customerCredits({ txId: String(tx._id) });
    return { ...this.present(tx), customerCredits: { ...credits, orders: credits.orders.filter(o => o._id !== String(tx._id)) } };
  }

  /** All sales of one customer that carry an overpayment or a credit move. */
  async customerCredits(q: { txId?: string; phone?: string; client?: string }) {
    let key = '';
    if (q.txId) key = customerKeyOf(await this.loadSale(q.txId));
    else key = customerKeyOf({ phone: q.phone, client: q.client });
    if (!key) return { key: '', available: 0, pendingRefunds: 0, refunded: 0, used: 0, unresolved: 0, orders: [] as any[] };
    const filter: Record<string, any> = { type: SALE, cancelled: { $ne: true } };
    if (key.startsWith('p:')) filter.phone = { $regex: key.slice(-9).split('').join('\\D*') };
    else filter.client = { $regex: '^\\s*' + key.slice(2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+') + '\\s*$', $options: 'i' };
    const rows = await this.txModel.find(filter, {
      ref: 1, client: 1, phone: 1, total: 1, deposit: 1, deposits: 1, payments: 1, creditMoves: 1,
      overpaymentMode: 1, date: 1, cancelled: 1, bostaOrderId: 1, bostaStatus: 1,
    }).lean().exec();
    const orders = rows.filter(r => customerKeyOf(r) === key).map(r => this.present(r))
      .filter(o => o.reconciliation.overpayment > RECON_TOLERANCE || o.creditMoves.length);
    const sum = (fn: (o: any) => number) => round2(orders.reduce((s, o) => s + fn(o), 0));
    return {
      key,
      available: sum(o => (o.reconciliation.state === 'credit' ? o.reconciliation.available : 0)),
      unresolved: sum(o => (o.reconciliation.state === 'pending-resolution' ? o.reconciliation.available : 0)),
      pendingRefunds: sum(o => o.reconciliation.refundPending),
      refunded: sum(o => o.reconciliation.refunded),
      used: sum(o => o.reconciliation.creditOut),
      orders,
    };
  }

  async setMode(id: string, mode: string, note: string, actor: CreditActor) {
    this.assertAdmin(actor);
    if (!['credit', 'unresolved'].includes(mode)) throw new BadRequestException('اختر: رصيد للعميل أو تركها معلّقة');
    const tx = await this.loadSale(id);
    if (tx.cancelled) throw new BadRequestException('الطلب ملغي');
    const o = tx.toObject();
    if (reconcile(o).overpayment <= RECON_TOLERANCE) throw new BadRequestException('لا توجد زيادة دفع على هذا الطلب');
    if (o.overpaymentMode === mode) return this.present(tx);
    const { set } = this.derived(o, o.creditMoves || [], mode, { kind: 'mode', mode, note: String(note || '').trim().slice(0, 300), by: actor.name });
    return this.present(await this.write(o, set));
  }

  async requestRefund(id: string, body: { amount: number; method?: string; reason: string; requestKey?: string }, actor: CreditActor) {
    this.assertAdmin(actor);
    const tx = await this.loadSale(id);
    const o = tx.toObject();
    const key = String(body.requestKey || '').trim().slice(0, 100);
    if (key && (o.creditMoves || []).some((m: any) => m.requestKey === key)) return this.present(tx);
    if (tx.cancelled) throw new BadRequestException('الطلب ملغي');
    const amount = round2(Number(body.amount));
    const reason = String(body.reason || '').trim();
    if (!(amount > 0)) throw new BadRequestException('أدخل مبلغ الاسترداد');
    if (reason.length < 3) throw new BadRequestException('اكتب سبب الاسترداد');
    const r = reconcile(o);
    if (amount > r.available + RECON_TOLERANCE) {
      throw new BadRequestException(`المتاح للاسترداد ${r.available} ج فقط${r.refundPending > 0 ? ` (يوجد استرداد معلّق بـ ${r.refundPending} ج)` : ''}`);
    }
    const move: CreditMove = {
      id: randomUUID(), kind: 'refund', amount, status: 'pending', method: String(body.method || '').trim(),
      reason: reason.slice(0, 300), requestKey: key || undefined, by: actor.name, at: new Date().toISOString(),
    };
    const { set } = this.derived(o, [...(o.creditMoves || []), move], undefined, { kind: 'refund-requested', moveId: move.id, amount, by: actor.name });
    return this.present(await this.write(o, set));
  }

  async completeRefund(id: string, moveId: string, body: { method: string; date?: string; reference?: string }, actor: CreditActor) {
    this.assertAdmin(actor);
    const method = String(body.method || '').trim();
    if (!['كاش', 'فودافون كاش', 'Instapay', 'تحويل بنكي'].includes(method)) throw new BadRequestException('اختر الخزنة التي خرج منها المبلغ');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : new Date().toISOString().slice(0, 10);
    const tx = await this.loadSale(id);
    const o = tx.toObject();
    const move = (o.creditMoves || []).find((m: any) => m.id === moveId && m.kind === 'refund');
    if (!move) throw new NotFoundException('طلب الاسترداد غير موجود');
    if (move.status === 'completed') return this.present(tx);
    if (move.status !== 'pending') throw new BadRequestException('طلب الاسترداد ليس معلّقاً');
    // 1) claim — a second click / tab sees «completing» and cannot pay the same refund again.
    const claiming = (o.creditMoves || []).map((m: any) => (m.id === moveId ? { ...m, status: 'completing' } : m));
    const claimed = await this.write(o, { creditMoves: claiming });
    const c = claimed.toObject();
    // 2) the money leaves the vault (fails on an insufficient balance → release the claim)
    let entry: any;
    try {
      entry = await this.vault.addSystemEntry(-move.amount, method,
        `رد زيادة دفع فاتورة #${o.ref || o._id} — ${o.client || ''}${body.reference ? ` | مرجع: ${String(body.reference).slice(0, 80)}` : ''} | بواسطة: ${actor.name}`,
        date, OVERPAY_REFUND_SOURCE, o.ref || String(o._id), { customer: o.client || '' }, actor.name);
    } catch (error) {
      const release = (c.creditMoves || []).map((m: any) => (m.id === moveId ? { ...m, status: 'pending' } : m));
      await this.write(c, { creditMoves: release }).catch(() => undefined);
      throw error;
    }
    // 3) completed — now (and only now) the refund counts as money returned.
    const done = (c.creditMoves || []).map((m: any) => (m.id === moveId ? {
      ...m, status: 'completed', method, date, reference: String(body.reference || '').slice(0, 80),
      vaultEntryId: String(entry?._id || ''), vaultTxNo: entry?.txNo || '', completedBy: actor.name, completedAt: new Date().toISOString(),
    } : m));
    const { set } = this.derived(c, done, undefined, { kind: 'refund-completed', moveId, amount: move.amount, method, vaultTxNo: entry?.txNo || '', by: actor.name });
    return this.present(await this.write(c, set));
  }

  async cancelRefund(id: string, moveId: string, reason: string, actor: CreditActor) {
    this.assertAdmin(actor);
    const tx = await this.loadSale(id);
    const o = tx.toObject();
    const move = (o.creditMoves || []).find((m: any) => m.id === moveId && m.kind === 'refund');
    if (!move) throw new NotFoundException('طلب الاسترداد غير موجود');
    if (move.status !== 'pending') throw new BadRequestException('يمكن إلغاء طلب استرداد معلّق فقط');
    const moves = (o.creditMoves || []).map((m: any) => (m.id === moveId ? {
      ...m, status: 'cancelled', cancelledBy: actor.name, cancelledAt: new Date().toISOString(), cancelReason: String(reason || '').slice(0, 300),
    } : m));
    const { set } = this.derived(o, moves, undefined, { kind: 'refund-cancelled', moveId, amount: move.amount, by: actor.name });
    return this.present(await this.write(o, set));
  }

  /**
   * Moves part of one order's overpayment onto another order of the SAME customer (customer
   * approval required). Both orders record the move; the source first, so a failure on the target
   * is compensated by cancelling the source row — the amount can never exist on both.
   */
  async transfer(id: string, body: { targetTxId: string; amount: number; customerApproved?: boolean; reason?: string; requestKey?: string }, actor: CreditActor) {
    this.assertAdmin(actor);
    if (body.customerApproved !== true) throw new BadRequestException('التحويل يحتاج موافقة العميل الصريحة');
    const amount = round2(Number(body.amount));
    if (!(amount > 0)) throw new BadRequestException('أدخل المبلغ المُحوَّل');
    const key = String(body.requestKey || '').trim().slice(0, 100);
    const src = await this.loadSale(id);
    const s = src.toObject();
    if (key && (s.creditMoves || []).some((m: any) => m.requestKey === key)) return this.present(src);
    if (String(body.targetTxId) === String(s._id)) throw new BadRequestException('اختر طلباً آخر');
    if (src.cancelled) throw new BadRequestException('الطلب المصدر ملغي');
    const tgt = await this.loadSale(String(body.targetTxId || ''));
    const t = tgt.toObject();
    if (tgt.cancelled) throw new BadRequestException('الطلب المحوَّل إليه ملغي');
    if (!customerKeyOf(s) || customerKeyOf(s) !== customerKeyOf(t)) throw new BadRequestException('يمكن التحويل بين طلبات نفس العميل فقط');
    if (hasLiveShipment(t) || ['pending', 'processing', 'review'].includes(t.carrierSettlement?.status || '') || t.carrierSettlement?.payoutId) {
      throw new BadRequestException('الطلب المحوَّل إليه شُحن ببوليصة تحصيل ثابتة — لا يمكن تغيير المطلوب منه الآن');
    }
    const rs = reconcile(s);
    const rt = reconcile(t);
    if (amount > rs.available + RECON_TOLERANCE) throw new BadRequestException(`المتاح للتحويل ${rs.available} ج فقط`);
    if (amount > rt.remaining + RECON_TOLERANCE) throw new BadRequestException(`المتبقي على الطلب #${t.ref} ${rt.remaining} ج فقط`);
    const pairId = randomUUID();
    const now = new Date().toISOString();
    const reason = String(body.reason || '').trim().slice(0, 300);
    const out: CreditMove = { id: pairId, kind: 'transfer-out', amount, status: 'completed', counterpartTxId: String(t._id),
      counterpartRef: t.ref || '', customerApproved: true, reason, requestKey: key || undefined, by: actor.name, at: now };
    const { set: srcSet } = this.derived(s, [...(s.creditMoves || []), out], undefined, { kind: 'transfer-out', moveId: pairId, amount, targetRef: t.ref || '', by: actor.name });
    const savedSrc = await this.write(s, srcSet);
    const inMove: CreditMove = { id: pairId, kind: 'transfer-in', amount, status: 'completed', counterpartTxId: String(s._id),
      counterpartRef: s.ref || '', customerApproved: true, reason, by: actor.name, at: now };
    try {
      let target = t;
      for (let attempt = 0; ; attempt++) {
        if (amount > reconcile(target).remaining + RECON_TOLERANCE) throw new BadRequestException(`تغيّر المتبقي على الطلب #${target.ref} — أعد المحاولة`);
        const { set } = this.derived(target, [...(target.creditMoves || []), inMove], undefined, { kind: 'transfer-in', moveId: pairId, amount, sourceRef: s.ref || '', by: actor.name });
        try { await this.write(target, set); break; } catch (e) {
          if (attempt >= 2) throw e;
          target = (await this.loadSale(String(t._id))).toObject();
          if (target.cancelled) throw e;
        }
      }
    } catch (error) {
      // compensate: the source row is cancelled (kept for the audit), so the amount is back on it.
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = (await this.loadSale(String(s._id))).toObject();
        const moves = (cur.creditMoves || []).map((m: any) => (m.id === pairId && m.kind === 'transfer-out'
          ? { ...m, status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: actor.name, cancelReason: 'تعذّر تسجيله على الطلب المحوَّل إليه' } : m));
        const { set } = this.derived(cur, moves, undefined, { kind: 'transfer-rolled-back', moveId: pairId, amount, by: actor.name });
        if (await this.write(cur, set).then(() => true, () => false)) break;
      }
      throw error;
    }
    return this.present(savedSrc);
  }
}
