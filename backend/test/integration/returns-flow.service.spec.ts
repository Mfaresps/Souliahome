/**
 * Cumulative end-to-end flow for customer returns, against a stateful in-memory ReturnRequest
 * store. Distinct from returns.service.spec.ts, which asserts each rule in isolation with fresh
 * mocks — this one makes the steps depend on each other: the second return sees the first one's
 * units as consumed, and the reversal acts on a request really approved earlier in the run.
 *
 * That difference is not academic. The discount basis of `damagedValue` was wrong (gross while the
 * refund cap was net) and every isolated test passed, because none of them combined an
 * invoice-level discount with a تالف unit. This spec caught it.
 *
 * Run with: npm test -- returns-flow
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ReturnsService } from '../../src/returns/returns.service';
import { ReturnsValidationService } from '../../src/returns/returns-validation.service';
import { ReturnRequest } from '../../src/returns/schemas/return-request.schema';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { VaultService } from '../../src/vault/vault.service';
import { createMockVaultService } from '../helpers/mocks';

// 3× سجادة @100 = 300 ; 2× وسادة @50 = 100 → itemsTotal 400
// discount 40 (10%) ; shipping 50 → total 410, fully collected.
// The 10% ratio is the point: every returned unit is worth 90/45, not 100/50.
const INVOICE: any = {
  _id: 'tx-sale-2254',
  type: 'مبيعات',
  ref: '2254',
  date: new Date(Date.now() - 3 * 86400000).toISOString(),
  client: 'مريم أحمد',
  phone: '01012345678',
  items: [
    { code: 'P001', name: 'سجادة قطن', qty: 3, price: 100, total: 300 },
    { code: 'P002', name: 'وسادة', qty: 2, price: 50, total: 100 },
  ],
  itemsTotal: 400,
  discount: 40,
  shipCost: 50,
  total: 410,
  remaining: 0,
  depMethod: 'كاش',
  cancelled: false,
};

/** In-memory ReturnRequest model covering only the query shapes these services issue. */
function createReturnStore() {
  const docs: any[] = [];
  let seq = 0;

  const matches = (d: any, q: any): boolean => {
    for (const [k, v] of Object.entries(q || {})) {
      if (k === '$or') {
        if (!(v as any[]).some((sub) => matches(d, sub))) return false;
        continue;
      }
      const dv = d[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if ('$in' in (v as any)) {
          if (!(v as any).$in.includes(dv)) return false;
          continue;
        }
        if ('$exists' in (v as any)) {
          const present = dv !== undefined && dv !== null;
          if ((v as any).$exists !== present) return false;
          continue;
        }
      }
      if (v === null) {
        if (dv !== null && dv !== undefined) return false;
        continue;
      }
      if (String(dv) !== String(v)) return false;
    }
    return true;
  };

  return {
    docs,
    create: jest.fn().mockImplementation(async (doc: any) => {
      const d: any = { _id: 'ret-' + ++seq, reversedAt: null, ...doc };
      d.save = jest.fn().mockImplementation(async () => d);
      docs.push(d);
      return d;
    }),
    find: jest.fn().mockImplementation((q: any = {}) => ({
      exec: async () => docs.filter((d) => matches(d, q)),
      sort: () => ({ exec: async () => docs.filter((d) => matches(d, q)) }),
    })),
    findById: jest.fn().mockImplementation((id: string) => ({
      exec: async () => docs.find((d) => String(d._id) === String(id)) || null,
    })),
    findOne: jest.fn().mockImplementation((q: any = {}) => ({
      exec: async () => docs.find((d) => matches(d, q)) || null,
    })),
    findOneAndUpdate: jest.fn().mockImplementation((q: any, upd: any) => ({
      exec: async () => {
        const d = docs.find((x) => matches(x, q));
        if (!d) return null;
        Object.assign(d, upd.$set || {});
        return d;
      },
    })),
  };
}

describe('Customer return — cumulative flow on one invoice', () => {
  let returns: ReturnsService;
  let store: ReturnType<typeof createReturnStore>;
  let vault: ReturnType<typeof createMockVaultService>;
  let createdTxs: any[];

  const body = (over: any = {}) => ({
    originalTransactionId: INVOICE._id,
    originalRef: INVOICE.ref,
    originalDate: INVOICE.date,
    client: INVOICE.client,
    phone: INVOICE.phone,
    reason: 'شحنة خاطئة',
    vaultRefundAccount: 'كاش',
    ...over,
  });

  const activeApproved = async () =>
    (await store
      .find({
        status: 'معتمد',
        $or: [{ reversedAt: null }, { reversedAt: { $exists: false } }],
      })
      .exec()) as any[];

  beforeEach(async () => {
    store = createReturnStore();
    vault = createMockVaultService();
    createdTxs = [];

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        ReturnsValidationService,
        { provide: getModelToken(ReturnRequest.name), useValue: store },
        {
          provide: TransactionsService,
          useValue: {
            findById: jest.fn().mockResolvedValue(INVOICE),
            create: jest.fn().mockImplementation(async (dto: any) => {
              const t = { _id: 'tx-' + (createdTxs.length + 1), ...dto };
              createdTxs.push(t);
              return t;
            }),
          },
        },
        { provide: VaultService, useValue: vault },
      ],
    }).compile();

    returns = mod.get(ReturnsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('runs two partial returns then a reversal, keeping every ceiling consistent', async () => {
    // ── first return: 1 سجادة سليم. Cap is 90 (100 less the 10% invoice discount), not 100.
    await expect(
      returns.create(
        body({
          items: [{ code: 'P001', name: 'سجادة قطن', qty: 1, price: 100, total: 100 }],
          total: 100,
        }),
        'موظف',
      ),
    ).rejects.toThrow(/يتجاوز الحد المسموح 90/);

    const r1: any = await returns.create(
      body({
        items: [
          { code: 'P001', name: 'سجادة قطن', qty: 1, price: 100, total: 100, condition: 'سليم' },
        ],
        total: 90,
        actualShipCost: 35,
      }),
      'موظف',
    );
    expect(r1).toMatchObject({
      status: 'معلق',
      sequence: 1,
      returnTxRef: '2254-RET',
      maxRefundable: 90,
      damagedValue: 0,
      actualShipCost: 35,
    });

    await returns.approve(String(r1._id), 'مدير');
    expect(vault.assertSufficientBalance).toHaveBeenCalledWith('كاش', 90);
    expect(createdTxs[0]).toMatchObject({ type: 'مرتجع', ref: '2254-RET', total: 90 });
    expect(r1.status).toBe('معتمد');

    // ── second return on the SAME invoice — impossible before Phase 0.
    const r2: any = await returns.create(
      body({
        reason: 'تلف الشحنة',
        items: [
          { code: 'P001', name: 'سجادة قطن', qty: 1, price: 100, total: 100, condition: 'تالف' },
          { code: 'P002', name: 'وسادة', qty: 1, price: 50, total: 50, condition: 'سليم' },
        ],
        total: 135,
      }),
      'موظف',
    );
    // -RET-2, not a second -RET: type 'مرتجع' skips the uniqueness check entirely.
    expect(r2.sequence).toBe(2);
    expect(r2.returnTxRef).toBe('2254-RET-2');
    expect(r2.maxRefundable).toBe(135);
    // The regression this spec exists for: on the same basis as the refund (90), never gross (100).
    expect(r2.damagedValue).toBe(90);

    await returns.approve(String(r2._id), 'مدير');
    expect(createdTxs[1]).toMatchObject({ ref: '2254-RET-2', total: 135 });
    // Condition survives onto the transaction — that is what keeps تالف out of derived stock.
    expect(createdTxs[1].items.map((i: any) => i.condition)).toEqual(['تالف', 'سليم']);

    // ── 2 of 3 سجادة are now gone, so 2 more cannot be returned.
    await expect(
      returns.create(
        body({
          items: [{ code: 'P001', name: 'سجادة قطن', qty: 2, price: 100, total: 200 }],
          total: 180,
        }),
        'موظف',
      ),
    ).rejects.toThrow(/المُسترجَع مسبقاً 2، المتاح 1/);

    const before = await returns.getReturnableQuantities(INVOICE._id);
    expect(before.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'P001', sold: 3, returned: 2, remaining: 1 }),
        expect.objectContaining({ code: 'P002', sold: 2, returned: 1, remaining: 1 }),
      ]),
    );
    expect(before.alreadyRefunded).toBe(225);
    expect(before.refundableCash).toBe(185); // 410 paid − 225 refunded

    // ── reversal: cancelling the first return transaction must drop it out of the aggregate.
    expect((await activeApproved()).reduce((s, r) => s + r.total, 0)).toBe(225);

    await store
      .findOneAndUpdate(
        { status: 'معتمد', reversedAt: null, $or: [{ returnTxRef: '2254-RET' }] },
        {
          $set: {
            reversedAt: new Date().toISOString(),
            reversedBy: 'مدير',
            reversalReason: 'خطأ في التسجيل',
          },
        },
      )
      .exec();

    // Status deliberately stays 'معتمد' — reversedAt is the discriminator.
    expect(r1.status).toBe('معتمد');
    expect(r1.reversedAt).toBeTruthy();
    expect((await activeApproved()).reduce((s, r) => s + r.total, 0)).toBe(135);

    // And the reversed units become returnable again.
    const after = await returns.getReturnableQuantities(INVOICE._id);
    expect(after.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'P001', sold: 3, returned: 1, remaining: 2 }),
      ]),
    );
    expect(after.refundableCash).toBe(275); // the 90 is no longer held against the invoice
  });

  it('leaves the request معلق when the vault cannot cover the refund at approval', async () => {
    const r: any = await returns.create(
      body({
        items: [{ code: 'P002', name: 'وسادة', qty: 1, price: 50, total: 50 }],
        total: 45,
      }),
      'موظف',
    );
    vault.assertSufficientBalance.mockRejectedValueOnce(new Error('رصيد كاش غير كافٍ'));

    await expect(returns.approve(String(r._id), 'مدير')).rejects.toThrow(/رصيد الخزنة غير كافٍ/);
    expect(r.status).toBe('معلق');
    expect(createdTxs).toHaveLength(0);
  });
});
