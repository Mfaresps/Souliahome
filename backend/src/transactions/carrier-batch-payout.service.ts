import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CarrierPayout, CarrierPayoutDocument } from './schemas/carrier-payout.schema';
import { Transaction, TransactionDocument } from './schemas/transaction.schema';
import { TransactionsService } from './transactions.service';
import { SettingsService } from '../settings/settings.service';
import { VaultService } from '../vault/vault.service';
import { PresenceGateway } from '../auth/presence.gateway';
import { r2 } from '../shared/bosta-pricing.util';
import { bostaCashoutDueAt } from '../shared/bosta-cashout.util';

/** One bank credit per cashout day/account. Order fees never create individual vault debits. */
@Injectable()
export class CarrierBatchPayoutService {
  private readonly logger = new Logger(CarrierBatchPayoutService.name);

  constructor(
    @InjectModel(Transaction.name) private readonly txModel: Model<TransactionDocument>,
    @InjectModel(CarrierPayout.name) private readonly payoutModel: Model<CarrierPayoutDocument>,
    private readonly transactions: TransactionsService,
    private readonly settings: SettingsService,
    private readonly vault: VaultService,
    private readonly presence: PresenceGateway,
  ) {}

  async runDue(): Promise<void> {
    // A scheduled cashout date is not proof that Bosta paid that amount. New batches stay in
    // the wallet until the actual bank transfer is entered. Only resume confirmed/posted work.
    const unfinished: any[] = await this.payoutModel.find({ mode: 'batch', $or: [
      { state: 'posted' },
      { state: { $in: ['preparing', 'ready'] }, actualConfirmedAt: { $exists: true, $nin: ['', null] } },
    ] }).lean().exec();
    for (const p of unfinished) {
      try { await this.post(`${p.date}T00:00:00.000Z`, p.vaultMethod, p.by || 'system:auto'); }
      catch (error: any) { this.logger.error(`Bosta payout: ${error.message}`); }
    }
  }

  /** Compare a scheduled batch with Bosta's invoice before recording actual bank cash. */
  async preview(date: string, method: string): Promise<any | null> {
    const batchKey = `${date}:${method}`;
    const p: any = await this.payoutModel.findOne({ batchKey }).lean().exec();
    if (p && ['ready', 'posted', 'completed'].includes(p.state)) {
      return { mode: 'batch', state: p.state, expected: p.expected, amount: p.amount,
        pendingOrders: p.transactionIds?.length || 0, returnFees: p.returnFeesBooked || 0,
        transferFee: p.fee, bostaRef: p.bostaRef || '' };
    }
    const now = new Date().toISOString();
    const rows: any[] = await this.txModel.find({ type: 'مبيعات', cancelled: { $ne: true },
      'carrierSettlement.status': 'pending', 'carrierSettlement.phase': 'wallet',
      'carrierSettlement.vaultMethod': method,
      'carrierSettlement.walletDepositedAt': { $exists: true, $nin: ['', null], $lt: `${date}T23:59:59.999Z` },
      $or: [{ 'carrierSettlement.cashoutDueAt': { $regex: `^${date}` } },
        { 'carrierSettlement.carrierCod': 0, 'carrierSettlement.cashoutDueAt': { $lte: now } }],
    }).select('carrierSettlement').lean().exec();
    const settings: any = await this.settings.getSettings();
    const legacy: any[] = await this.payoutModel.find({ mode: { $ne: 'batch' } }).select('date').lean().exec();
    const legacyDate = legacy.map(x => x.date).sort().pop();
    const returnFilter: any = { type: 'مبيعات', bostaOrderId: { $exists: true, $nin: ['', null] },
      'failedDelivery.returnShipCost': { $gt: 0 },
      'failedDelivery.closedAt': { ...(settings.autoSettleSince ? { $gte: settings.autoSettleSince } : {}), $lt: `${date}T23:59:59.999Z` },
      $or: [{ 'failedDelivery.carrierPayoutId': { $exists: false } },
        ...(p ? [{ 'failedDelivery.carrierPayoutId': String(p._id) }] : [])],
    };
    if (legacyDate) returnFilter['failedDelivery.closedAt'].$gte = `${legacyDate}T23:59:59.999Z`;
    const returns: any[] = await this.txModel.find(returnFilter).select('failedDelivery.returnShipCost').lean().exec();
    const returnFees = r2(returns.reduce((sum, t) => sum + Number(t.failedDelivery.returnShipCost || 0), 0));
    const expected = r2(rows.reduce((sum, t) => sum + Number(t.carrierSettlement.net || 0), 0) - returnFees);
    const blocked = await this.txModel.exists({ 'carrierSettlement.cashoutDueAt': { $regex: `^${date}` },
      'carrierSettlement.vaultMethod': method, 'carrierSettlement.status': { $in: ['review', 'disputed'] } });
    return { mode: 'batch', state: p?.state || 'awaiting-confirmation', expected,
      pendingOrders: rows.length, returnFees, transferFee: p?.fee ?? Number(settings.carrierTransferFee ?? 25),
      blocked: !!blocked };
  }

  async post(dueAt: string, method: string, by: string,
    actual?: { amount: number; fee: number; note?: string; bostaRef?: string; bookDifference?: boolean }): Promise<any> {
    const date = dueAt.slice(0, 10);
    const scheduled = bostaCashoutDueAt({ wallet: { cashout: { next_cashout_date: date } } });
    if (!scheduled || Date.now() < Date.parse(scheduled)) throw new BadRequestException('موعد تحويل هذه الدفعة لم يحن بعد');
    const batchKey = `${date}:${method}`;
    const settings: any = await this.settings.getSettings();
    const now = new Date().toISOString();
    if (actual && (!(Number.isFinite(actual.amount) && actual.amount > 0) || !(Number.isFinite(actual.fee) && actual.fee >= 0))) {
      throw new BadRequestException('مبلغ التحويل أو رسومه غير صالحة');
    }
    if (actual) actual = { ...actual, bostaRef: String(actual.bostaRef || '').trim() };
    if (actual && !actual.bostaRef) throw new BadRequestException('اكتب رقم فاتورة تحويل بوسطة');
    if (actual && await this.payoutModel.exists({ bostaRef: actual.bostaRef, batchKey: { $ne: batchKey } })) {
      throw new BadRequestException('رقم فاتورة بوسطة مرتبط بتحويل آخر');
    }
    let p: any = await this.payoutModel.findOne({ batchKey }).lean().exec();
    if (!p) {
      if (!actual) return null;
      const blocked = await this.txModel.exists({ 'carrierSettlement.cashoutDueAt': { $regex: `^${date}` },
        'carrierSettlement.vaultMethod': method, 'carrierSettlement.status': { $in: ['review', 'disputed'] } });
      if (blocked) throw new BadRequestException('دفعة بوسطة بها طلبات تحتاج مراجعة قبل التحويل');
      try {
        p = (await this.payoutModel.create({ batchKey, mode: 'batch', state: 'preparing',
          payoutNo: `PAY-B-${date.replace(/-/g, '')}-${['كاش', 'فودافون كاش', 'Instapay', 'تحويل بنكي'].indexOf(method)}`,
          date, amount: r2(actual.amount), fee: r2(actual.fee), vaultMethod: method,
          actualConfirmedAt: now, by, bostaRef: actual.bostaRef || '', note: actual.note || '' })).toObject();
      } catch (error: any) {
        if (error.code !== 11000) throw error;
        p = await this.payoutModel.findOne({ batchKey }).lean().exec();
      }
    }
    if (p.state === 'completed') {
      if (actual && (r2(actual.amount) !== r2(p.amount) || r2(actual.fee) !== r2(p.fee))) {
        throw new BadRequestException('تم تسجيل هذه الدفعة بالفعل بمبلغ مختلف — راجع التحويل المسجل');
      }
      return p;
    }
    if (p.state === 'reversed') throw new BadRequestException('هذه الدفعة تم التراجع عنها وتحتاج مراجعة');
    if (actual && ['ready', 'posted'].includes(p.state) && p.actualConfirmedAt
      && (r2(actual.amount) !== r2(p.amount) || r2(actual.fee) !== r2(p.fee))) {
      throw new BadRequestException('تم تأكيد هذه الدفعة بالفعل بمبلغ مختلف');
    }
    if (!actual && p.state !== 'posted' && !p.actualConfirmedAt) return null;
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const locked: any = await this.payoutModel.findOneAndUpdate({ _id: p._id,
      state: { $in: ['preparing', 'ready', 'posted'] }, $or: [{ lockAt: '' }, { lockAt: { $exists: false } }, { lockAt: { $lt: stale } }],
    }, { $set: { lockAt: now } }, { new: true }).lean().exec();
    if (!locked) throw new BadRequestException('دفعة بوسطة قيد التسجيل حاليًا');
    p = locked;
    const payoutId = String(p._id);
    try {
      if (p.state === 'preparing') {
        if (actual) {
          p.amount = r2(actual.amount);
          p.fee = r2(actual.fee);
          p.actualConfirmedAt = p.actualConfirmedAt || now;
          await this.payoutModel.updateOne({ _id: p._id }, { $set: { amount: p.amount, fee: p.fee,
            actualConfirmedAt: p.actualConfirmedAt, note: actual.note || '', bostaRef: actual.bostaRef || '', by } }).exec();
        }
        const candidates: any[] = await this.txModel.find({ type: 'مبيعات', cancelled: { $ne: true },
          'carrierSettlement.status': 'pending', 'carrierSettlement.phase': 'wallet',
          'carrierSettlement.vaultMethod': method,
          'carrierSettlement.walletDepositedAt': { $exists: true, $nin: ['', null], $lt: `${date}T23:59:59.999Z` },
          $and: [
            { $or: [{ 'carrierSettlement.payoutId': { $exists: false } }, { 'carrierSettlement.payoutId': '' }, { 'carrierSettlement.payoutId': payoutId }] },
            { $or: [{ 'carrierSettlement.cashoutDueAt': { $regex: `^${date}` } },
              { 'carrierSettlement.carrierCod': 0, 'carrierSettlement.cashoutDueAt': { $lte: now } }] },
          ],
        }).lean().exec();
        if (!candidates.length && !p.actualConfirmedAt) {
          await this.payoutModel.deleteOne({ _id: p._id, state: 'preparing' }).exec();
          return null;
        }
        // Persist ownership before the vault write; interrupted runs discover the same claims.
        for (const row of candidates) {
          await this.txModel.updateOne({ _id: row._id, 'carrierSettlement.status': 'pending',
            $and: [
              { $or: [{ 'carrierSettlement.payoutId': { $exists: false } }, { 'carrierSettlement.payoutId': '' }, { 'carrierSettlement.payoutId': payoutId }] },
              { $or: [{ carrierSettleLock: { $in: ['', null] } }, { carrierSettleLock: { $exists: false } }, { carrierSettleLock: { $lt: stale } }] },
            ],
          }, { $set: { 'carrierSettlement.payoutId': payoutId } }).exec();
        }
        const incomplete = await this.txModel.exists({
          'carrierSettlement.cashoutDueAt': { $regex: `^${date}` }, 'carrierSettlement.vaultMethod': method,
          $or: [
            { 'carrierSettlement.status': { $in: ['review', 'disputed'] } },
            { 'carrierSettlement.status': 'pending', 'carrierSettlement.payoutId': { $ne: payoutId } },
          ],
        });
        if (incomplete) throw new BadRequestException('دفعة بوسطة ما زالت قيد تجهيز أو مراجعة بعض الطلبات');
        const claimed: any[] = await this.txModel.find({ 'carrierSettlement.payoutId': payoutId }).lean().exec();
        const returnFilter: any = { type: 'مبيعات', bostaOrderId: { $exists: true, $nin: ['', null] },
          'failedDelivery.returnShipCost': { $gt: 0 },
          'failedDelivery.closedAt': { ...(settings.autoSettleSince ? { $gte: settings.autoSettleSince } : {}), $lt: `${date}T23:59:59.999Z` },
          $or: [{ 'failedDelivery.carrierPayoutId': { $exists: false } }, { 'failedDelivery.carrierPayoutId': payoutId }],
        };
        // Legacy payout deductions have already reached the vault and must not be charged again.
        const legacy: any[] = await this.payoutModel.find({ mode: { $ne: 'batch' } }).select('date').lean().exec();
        const legacyDate = legacy.map(x => x.date).sort().pop();
        if (legacyDate) returnFilter['failedDelivery.closedAt'].$gte = `${legacyDate}T23:59:59.999Z`;
        await this.txModel.updateMany(returnFilter, { $set: { 'failedDelivery.carrierPayoutId': payoutId } }).exec();
        const returns: any[] = await this.txModel.find({ 'failedDelivery.carrierPayoutId': payoutId }).lean().exec();
        const returnFees = r2(returns.reduce((sum, t) => sum + Number(t.failedDelivery.returnShipCost || 0), 0));
        const expected = r2(claimed.reduce((sum, t) => sum + Number(t.carrierSettlement.net || 0), 0) - returnFees);
        const amount = r2(p.amount);
        if (!(amount > 0)) {
          // Carry fee-only liabilities into the next positive transfer, without charging a fee today.
          await this.txModel.updateMany({ 'carrierSettlement.payoutId': payoutId }, { $unset: { 'carrierSettlement.payoutId': '' } }).exec();
          await this.txModel.updateMany({ 'failedDelivery.carrierPayoutId': payoutId }, { $unset: { 'failedDelivery.carrierPayoutId': '' } }).exec();
          await this.payoutModel.deleteOne({ _id: p._id, state: 'preparing' }).exec();
          return null;
        }
        // Keep the unexplained difference visible in Bosta's statement. It is not a second
        // vault movement: only the confirmed bank amount is credited to the vault.
        const difference = r2(expected - amount - p.fee);
        await this.payoutModel.updateOne({ _id: p._id }, { $set: { state: 'ready', amount, expected, difference,
          adjustment: 0, returnFeesBooked: returnFees,
          transactionIds: claimed.map(t => String(t._id)), returnTransactionIds: returns.map(t => String(t._id)),
        } }).exec();
        p = { ...p, state: 'ready', amount, expected, difference, transactionIds: claimed.map(t => String(t._id)) };
      }
      if (p.state === 'ready' && actual && !p.actualConfirmedAt) {
        // A pre-upgrade run may have prepared an estimated amount but not written the bank entry.
        const amount = r2(actual.amount);
        const fee = r2(actual.fee);
        await this.payoutModel.updateOne({ _id: p._id }, { $set: { amount, fee,
          difference: r2(p.expected - amount - fee), adjustment: 0, actualConfirmedAt: now,
          bostaRef: actual.bostaRef || '', note: actual.note || '', by } }).exec();
        p = { ...p, amount, fee, actualConfirmedAt: now };
      }
      if (p.state === 'ready') {
        const entry = await this.vault.findLatestByRef(p.payoutNo, 'تحصيل');
        const saved = entry || await this.vault.addSystemEntry(p.amount, method,
          `تحويل بوسطة المجمع ${p.payoutNo} — ${p.transactionIds.length} طلب، صافي بعد مستحقاتها ورسوم التحويل والرجوع`,
          date, 'تحصيل', p.payoutNo, {}, by, { carrierPayout: payoutId });
        await this.payoutModel.updateOne({ _id: p._id }, { $set: { state: 'posted', vaultEntryId: String(saved._id) } }).exec();
        p.state = 'posted';
      }
      for (const id of p.transactionIds) await this.transactions.finalizeCarrierPayoutOrder(id, payoutId, date, by);
      await this.payoutModel.updateOne({ _id: p._id }, { $set: { state: 'completed', error: '' } }).exec();
      this.presence?.emitEvent('settlement:changed', { payoutNo: p.payoutNo });
      return await this.payoutModel.findById(p._id).lean().exec();
    } catch (error: any) {
      await this.payoutModel.updateOne({ _id: p._id }, { $set: { error: error.message } }).exec();
      throw error;
    } finally {
      await this.payoutModel.updateOne({ _id: p._id }, { $set: { lockAt: '' } }).exec();
    }
  }

  /** Correct a pre-existing estimated credit once, with an auditable delta in the same vault. */
  async reconcileCompleted(id: string, amount: number, fee: number, bostaRef: string, note: string, by: string): Promise<any> {
    amount = r2(Number(amount));
    fee = r2(Number(fee));
    bostaRef = String(bostaRef || '').trim();
    if (!(Number.isFinite(amount) && amount > 0) || !(Number.isFinite(fee) && fee >= 0)) {
      throw new BadRequestException('مبلغ التحويل أو رسومه غير صالحة');
    }
    if (!bostaRef) throw new BadRequestException('اكتب رقم فاتورة تحويل بوسطة');
    let p: any = await this.payoutModel.findById(id).lean().exec();
    if (!p || p.mode !== 'batch' || p.state !== 'completed') throw new BadRequestException('اختر دفعة بوسطة مكتملة');
    if (await this.payoutModel.exists({ bostaRef, _id: { $ne: p._id } })) {
      throw new BadRequestException('رقم فاتورة بوسطة مرتبط بتحويل آخر');
    }
    if (p.correctedAt) {
      if (r2(p.amount) === amount && r2(p.fee) === fee && p.bostaRef === bostaRef) return p;
      throw new BadRequestException('تم تصحيح هذه الدفعة بالفعل بمبلغ مختلف');
    }
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const locked: any = await this.payoutModel.findOneAndUpdate({ _id: p._id, mode: 'batch', state: 'completed',
      $or: [{ lockAt: '' }, { lockAt: { $exists: false } }, { lockAt: { $lt: stale } }],
      correctedAt: { $in: ['', null] },
    }, { $set: { lockAt: now } }, { new: true }).lean().exec();
    if (!locked) throw new BadRequestException('دفعة بوسطة قيد التصحيح حاليًا');
    p = locked;
    try {
      const original = r2(p.amount);
      const delta = r2(amount - original);
      const correctionRef = `${p.payoutNo}-CORR`;
      const cairo = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
      const bookedDate = `${cairo.year}-${cairo.month}-${cairo.day}`;
      const existing: any = delta ? await this.vault.findLatestByRef(correctionRef) : null;
      if (existing && (r2(existing.amount) !== delta || existing.method !== p.vaultMethod)) {
        throw new BadRequestException('قيد تصحيح الدفعة لا يطابق المبلغ المطلوب');
      }
      const entry = existing || (delta ? await this.vault.addSystemEntry(delta, p.vaultMethod,
        `تصحيح تحويل بوسطة ${p.payoutNo} حسب فاتورة ${bostaRef} — الفرق عن القيد السابق`,
        bookedDate, delta < 0 ? 'مصروف' : 'تحصيل', correctionRef, {}, by,
        { carrierPayout: String(p._id), correctionOf: p.payoutNo }) : null);
      await this.payoutModel.updateOne({ _id: p._id, state: 'completed' }, { $set: {
        correctedFromAmount: original, correctedAt: now, correctionBookedDate: bookedDate,
        correctionVaultEntryId: entry ? String(entry._id) : '',
        actualConfirmedAt: now, amount, fee, difference: r2(p.expected - amount - fee),
        bostaRef, note: String(note || ''), by,
      } }).exec();
      this.presence?.emitEvent('settlement:changed', { payoutNo: p.payoutNo });
      return await this.payoutModel.findById(p._id).lean().exec();
    } finally {
      await this.payoutModel.updateOne({ _id: p._id }, { $set: { lockAt: '' } }).exec();
    }
  }
}
