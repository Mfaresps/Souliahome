import { CarrierBatchPayoutService } from '../../src/transactions/carrier-batch-payout.service';
import { TransactionsService } from '../../src/transactions/transactions.service';

const copy = (v: any) => v == null ? v : JSON.parse(JSON.stringify(v));
const get = (row: any, key: string) => key.split('.').reduce((v, k) => v?.[k], row);
const set = (row: any, key: string, value: any) => {
  const parts = key.split('.');
  let target = row;
  for (const k of parts.slice(0, -1)) target = target[k] ||= {};
  target[parts[parts.length - 1]] = copy(value);
};
function matches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, test]: any) => {
    if (key === '$or') return test.some((q: any) => matches(row, q));
    if (key === '$and') return test.every((q: any) => matches(row, q));
    const value = get(row, key);
    if (test === null) return value == null;
    if (test && typeof test === 'object') return Object.entries(test).every(([op, v]: any) => {
      switch (op) {
        case '$exists': return (value !== undefined) === v;
        case '$ne': return value !== v;
        case '$in': return v.includes(value);
        case '$nin': return !v.includes(value);
        case '$lt': return value < v;
        case '$lte': return value <= v;
        case '$gte': return value >= v;
        case '$gt': return value > v;
        case '$regex': return new RegExp(v).test(value || '');
        default: throw new Error(op);
      }
    });
    return value === test;
  });
}
function memoryModel(rows: any[]) {
  const query = (fn: () => any): any => ({ lean() { return this; }, select() { return this; }, exec: async () => copy(fn()) });
  const update = (row: any, change: any) => {
    for (const [key, value] of Object.entries(change.$set || {})) set(row, key, value);
    for (const key of Object.keys(change.$unset || {})) {
      const parts = key.split('.');
      const parent = get(row, parts.slice(0, -1).join('.'));
      if (parent) delete parent[parts[parts.length - 1]];
    }
    for (const [key, value] of Object.entries(change.$inc || {})) set(row, key, (get(row, key) || 0) + Number(value));
    for (const [key, value] of Object.entries(change.$push || {})) set(row, key, [...(get(row, key) || []), value]);
  };
  return {
    find: jest.fn((q: any) => query(() => rows.filter(r => matches(r, q)))),
    findOne: jest.fn((q: any) => query(() => rows.find(r => matches(r, q)) || null)),
    findById: jest.fn((id: string) => query(() => rows.find(r => r._id === id) || null)),
    exists: jest.fn(async (q: any) => rows.some(r => matches(r, q))),
    create: jest.fn(async (data: any) => {
      if (rows.some(r => r.batchKey === data.batchKey)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      const row = { _id: `p${rows.length + 1}`, transactionIds: [], returnTransactionIds: [], lockAt: '', ...copy(data) };
      rows.push(row);
      return { toObject: () => copy(row) };
    }),
    findOneAndUpdate: jest.fn((q: any, change: any) => query(() => {
      const row = rows.find(r => matches(r, q));
      if (row) update(row, change);
      return row || null;
    })),
    updateOne: jest.fn((q: any, change: any) => query(() => {
      const row = rows.find(r => matches(r, q));
      if (row) update(row, change);
      return { modifiedCount: row ? 1 : 0 };
    })),
    updateMany: jest.fn((q: any, change: any) => query(() => {
      const selected = rows.filter(r => matches(r, q));
      selected.forEach(r => update(r, change));
      return { modifiedCount: selected.length };
    })),
    deleteOne: jest.fn((q: any) => query(() => {
      const i = rows.findIndex(r => matches(r, q));
      if (i >= 0) rows.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    })),
  };
}

describe('Bosta grouped bank payout', () => {
  let rows: any[], payouts: any[], entries: any[], txModel: any, payoutModel: any, vault: any, transactions: any, service: CarrierBatchPayoutService;
  const method = 'تحويل بنكي';
  const dueAt = '2026-10-21T09:00:00.000Z';
  const order = (id: string, cod: number, fees: number, due: string = dueAt) => ({
    _id: id, ref: id, type: 'مبيعات', remaining: cod, deposit: cod ? 0 : 1000,
    payStatus: cod ? 'معلق' : 'مكتمل', payments: cod ? [] : [{ id: 'prepaid', amount: 1000 }],
    bostaOrderId: id, actualShipCost: 0, shipLoss: 0, shipSaving: 0,
    carrierSettlement: { status: 'pending', phase: 'wallet', remaining: cod, carrierCod: cod,
      fees: { priceAfterVat: fees }, net: cod - fees, shipLossAdd: 0, shipSavingAdd: 0,
      walletDepositedAt: '2026-10-10T12:00:00Z', cashoutDueAt: due, vaultMethod: method },
  });
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(dueAt));
    rows = [order('cod1', 1000, 100), order('cod2', 500, 50), order('prepaid', 0, 120),
      { _id: 'return', type: 'مبيعات', bostaOrderId: 'r', failedDelivery: { returnShipCost: 30, closedAt: '2026-10-12T12:00:00Z' } }];
    payouts = []; entries = [];
    txModel = memoryModel(rows); payoutModel = memoryModel(payouts);
    vault = {
      findLatestByRef: jest.fn(async (ref: string) => entries.find(e => e.ref === ref) || null),
      addSystemEntry: jest.fn(async (amount: number, vaultMethod: string, _desc: string, date: string, source: string, ref: string) => {
        const entry = { _id: `v${entries.length + 1}`, amount, vaultMethod, date, source, ref };
        entries.push(entry); return entry;
      }),
    };
    const owner = { transactionModel: txModel, emit: jest.fn() };
    transactions = { finalizeCarrierPayoutOrder: jest.fn((...args: any[]) =>
      (TransactionsService.prototype.finalizeCarrierPayoutOrder as any).apply(owner, args)) };
    service = new CarrierBatchPayoutService(txModel, payoutModel, transactions,
      { getSettings: async () => ({ carrierTransferFee: 25, autoSettleSince: '2026-10-01' }) } as any,
      vault, { emitEvent: jest.fn() } as any);
  });
  afterEach(() => jest.useRealTimers());

  it('credits exactly one net transfer for COD, prepaid fees, return fees and one transfer fee', async () => {
    const p = await service.post(dueAt, method, 'system');
    expect(entries).toEqual([expect.objectContaining({ amount: 1175, date: '2026-10-21', source: 'تحصيل' })]);
    expect(p).toMatchObject({ state: 'completed', expected: 1200, amount: 1175, fee: 25, returnFeesBooked: 30 });
    expect(p.transactionIds).toHaveLength(3);
    expect(rows[0]).toMatchObject({ remaining: 0, deposit: 1000, payStatus: 'مكتمل' });
    expect(rows[0].payments[0]).toMatchObject({ amount: 1000, vaultDelta: 0, carrierPayoutId: p._id });
    expect(rows[2]).toMatchObject({ remaining: 0, deposit: 1000, actualShipCost: 120 });
    expect(rows[2].payments).toHaveLength(1); // Original prepayment is preserved, no fake COD payment.
  });

  it('waits until Cairo noon and rejects early manual posting too', async () => {
    jest.setSystemTime(new Date('2026-10-21T08:59:59Z'));
    await expect(service.post(dueAt, method, 'system')).rejects.toThrow('لم يحن');
    expect(entries).toHaveLength(0);
    expect(payouts).toHaveLength(0);
  });

  it('does not credit a duplicate automated run or manual confirmation', async () => {
    await service.post(dueAt, method, 'system');
    await service.post(dueAt, method, 'system');
    await service.post(dueAt, method, 'admin', { amount: 1175, fee: 25 });
    expect(entries).toHaveLength(1);
    expect(rows[0].payments).toHaveLength(1);
    await expect(service.post(dueAt, method, 'admin', { amount: 1500, fee: 25 })).rejects.toThrow('مختلف');
  });

  it('resumes after an order update fails without repeating the bank credit', async () => {
    transactions.finalizeCarrierPayoutOrder.mockRejectedValueOnce(new Error('temporary write failure'));
    await expect(service.post(dueAt, method, 'system')).rejects.toThrow('temporary');
    expect(payouts[0].state).toBe('posted');
    expect(entries).toHaveLength(1);
    await service.post(dueAt, method, 'system');
    expect(payouts[0].state).toBe('completed');
    expect(entries).toHaveLength(1);
  });

  it('keeps a fee-only balance in the wallet and nets it against the next positive batch', async () => {
    rows.splice(0, 2);
    await service.post(dueAt, method, 'system');
    expect(entries).toHaveLength(0);
    expect(rows[0].deposit).toBe(1000);
    expect(rows[0].carrierSettlement.payoutId).toBeUndefined();
    const nextDue = '2026-10-22T09:00:00.000Z';
    rows.push(order('next', 500, 50, nextDue));
    jest.setSystemTime(new Date(nextDue));
    await service.post(nextDue, method, 'system');
    expect(entries[0].amount).toBe(275); // 500 - 50 - 120 - 30 - 25.
    expect(entries).toHaveLength(1);
  });

  it('deducts return fees once across successive transfers', async () => {
    await service.post(dueAt, method, 'system');
    const nextDue = '2026-10-22T09:00:00.000Z';
    rows.push(order('next', 500, 50, nextDue));
    jest.setSystemTime(new Date(nextDue));
    await service.post(nextDue, method, 'system');
    expect(entries.map(e => e.amount)).toEqual([1175, 425]);
  });

  it('blocks a batch awaiting a fee review', async () => {
    rows[2].carrierSettlement.status = 'review';
    await expect(service.post(dueAt, method, 'system')).rejects.toThrow('مراجعة');
    expect(entries).toHaveLength(0);
  });

  it('recovers a bank entry written before payout state could be saved', async () => {
    const original = payoutModel.updateOne.getMockImplementation();
    let fail = true;
    payoutModel.updateOne.mockImplementation((q: any, change: any) => {
      if (fail && change.$set?.state === 'posted') {
        fail = false;
        return { exec: async () => { throw new Error('state write failed'); } };
      }
      return original(q, change);
    });
    await expect(service.post(dueAt, method, 'system')).rejects.toThrow('state write');
    expect(payouts[0]).toMatchObject({ state: 'ready', amount: 1175 });
    expect(entries).toHaveLength(1);
    await service.post(dueAt, method, 'system');
    expect(entries).toHaveLength(1);
    expect(payouts[0].state).toBe('completed');
  });

  it('reserves the same batch across competing workers', async () => {
    await Promise.allSettled([service.post(dueAt, method, 'worker1'), service.post(dueAt, method, 'worker2')]);
    expect(payouts).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(rows[0].payments).toHaveLength(1);
  });

  it('waits for a locked order rather than posting an incomplete group', async () => {
    rows[0].carrierSettleLock = dueAt;
    await expect(service.post(dueAt, method, 'system')).rejects.toThrow('قيد تجهيز');
    expect(entries).toHaveLength(0);
    rows[0].carrierSettleLock = '';
    await service.post(dueAt, method, 'system');
    expect(entries[0].amount).toBe(1175);
  });
});
