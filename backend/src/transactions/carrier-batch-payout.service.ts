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
    const now = new Date().toISOString();
    // Finish reading all due orders before forming a batch, even when the reader has a run limit.
    if (await this.txModel.exists({ 'carrierSettlement.status': 'pending',
      'carrierSettlement.phase': { $ne: 'wallet' }, 'carrierSettlement.dueAt': { $lte: now } })) return;
    const rows: any[] = await this.txModel.find({ 'carrierSettlement.status': 'pending',
      'carrierSettlement.phase': 'wallet', 'carrierSettlement.cashoutDueAt': { $ne: '', $lte: now },
      'carrierSettlement.walletDepositedAt': { $exists: true, $nin: ['', null] },
    }).select('carrierSettlement').lean().exec();
    const groups = new Map<string, { dueAt: string; method: string }>();
    for (const row of rows) {
      const cs = row.carrierSettlement;
      groups.set(`${cs.cashoutDueAt.slice(0, 10)}:${cs.vaultMethod}`, { dueAt: cs.cashoutDueAt, method: cs.vaultMethod });
    }
    // A crash after the bank credit is resumed from the persisted payout, without a second credit.
    const unfinished: any[] = await this.payoutModel.find({ mode: 'batch', state: { $in: ['preparing', 'ready', 'posted'] } }).lean().exec();
    for (const p of unfinished) groups.set(p.batchKey, { dueAt: p.date + 'T00:00:00.000Z', method: p.vaultMethod });
    for (const group of groups.values()) {
      try { await this.post(group.dueAt, group.method, 'system:auto'); }
      catch (error: any) { this.logger.error(`Bosta payout: ${error.message}`); }
    }
  }

  async post(dueAt: string, method: string, by: string,
    actual?: { amount: number; fee: number; note?: string; bostaRef?: string; bookDifference?: boolean }): Promise<any> {
    const date = dueAt.slice(0, 10);
    const scheduled = bostaCashoutDueAt({ wallet: { cashout: { next_cashout_date: date } } });
    if (!scheduled || Date.now() < Date.parse(scheduled)) throw new BadRequestException('موعد تحويل هذه الدفعة لم يحن بعد');
    const batchKey = `${date}:${method}`;
    const settings: any = await this.settings.getSettings();
    const now = new Date().toISOString();
    let p: any = await this.payoutModel.findOne({ batchKey }).lean().exec();
    if (!p) {
      const blocked = await this.txModel.exists({ 'carrierSettlement.cashoutDueAt': { $regex: `^${date}` },
        'carrierSettlement.vaultMethod': method, 'carrierSettlement.status': { $in: ['review', 'disputed'] } });
      if (blocked) throw new BadRequestException('دفعة بوسطة بها طلبات تحتاج مراجعة قبل التحويل');
      try {
        p = (await this.payoutModel.create({ batchKey, mode: 'batch', state: 'preparing',
          payoutNo: `PAY-B-${date.replace(/-/g, '')}-${['كاش', 'فودافون كاش', 'Instapay', 'تحويل بنكي'].indexOf(method)}`,
          date, amount: 0, fee: actual?.fee ?? Number(settings.carrierTransferFee ?? 25), vaultMethod: method,
          by, bostaRef: actual?.bostaRef || '', note: actual?.note || '' })).toObject();
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
          p.fee = r2(actual.fee);
          await this.payoutModel.updateOne({ _id: p._id }, { $set: { fee: p.fee,
            note: actual.note || '', bostaRef: actual.bostaRef || '', by } }).exec();
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
        if (!candidates.length) {
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
        const amount = actual ? r2(actual.amount) : r2(expected - p.fee);
        if (!(amount > 0)) {
          // Carry fee-only liabilities into the next positive transfer, without charging a fee today.
          await this.txModel.updateMany({ 'carrierSettlement.payoutId': payoutId }, { $unset: { 'carrierSettlement.payoutId': '' } }).exec();
          await this.txModel.updateMany({ 'failedDelivery.carrierPayoutId': payoutId }, { $unset: { 'failedDelivery.carrierPayoutId': '' } }).exec();
          await this.payoutModel.deleteOne({ _id: p._id, state: 'preparing' }).exec();
          return null;
        }
        const difference = r2(expected - amount - p.fee);
        if (actual && Math.abs(difference) > 0.01 && !actual.bookDifference) {
          throw new BadRequestException('المبلغ الفعلي يختلف عن صافي الدفعة — راجع الفرق أو اعتمده');
        }
        await this.payoutModel.updateOne({ _id: p._id }, { $set: { state: 'ready', amount, expected, difference,
          adjustment: actual?.bookDifference ? r2(-difference) : 0, returnFeesBooked: returnFees,
          transactionIds: claimed.map(t => String(t._id)), returnTransactionIds: returns.map(t => String(t._id)),
        } }).exec();
        p = { ...p, state: 'ready', amount, expected, difference, transactionIds: claimed.map(t => String(t._id)) };
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
}
