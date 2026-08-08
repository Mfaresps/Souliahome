/**
 * Tests for ReturnsService + ReturnsValidationService — the real services, not a local
 * re-implementation of their logic.
 *
 * The pre-existing test/unit/returns.spec.ts and returns-extended.spec.ts define their own local
 * helper functions and assert on those, so they pass whether or not the service does anything. Every
 * case below locks in a defect that shipped:
 *
 *   - items fabricated in the payload were accepted and added to stock
 *   - the refund amount was unbounded (only `> 0` was checked)
 *   - a second partial return on an invoice was blocked forever
 *   - two returns on one invoice would both take ref `{ref}-RET`
 *   - a تالف unit went back into sellable stock
 *   - a failed transaction create left the request 'معتمد' with nothing behind it
 *
 * Run with: npm test -- returns.service
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ReturnsService } from '../../src/returns/returns.service';
import { ReturnsValidationService } from '../../src/returns/returns-validation.service';
import { ReturnRequest } from '../../src/returns/schemas/return-request.schema';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { VaultService } from '../../src/vault/vault.service';
import { createMockMongooseModel, createMockVaultService } from '../helpers/mocks';

/** A fully-paid two-line sale: 3× P001 @100 and 2× P002 @50, no discount. */
function buildOriginalSale(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'tx-sale-1',
    type: 'مبيعات',
    ref: '2254',
    date: new Date().toISOString(),
    client: 'مريم أحمد',
    phone: '01000000000',
    items: [
      { code: 'P001', name: 'سجادة', qty: 3, price: 100, total: 300 },
      { code: 'P002', name: 'وسادة', qty: 2, price: 50, total: 100 },
    ],
    itemsTotal: 400,
    total: 400,
    remaining: 0,
    discount: 0,
    depMethod: 'كاش',
    cancelled: false,
    ...overrides,
  };
}

function buildReturnDoc(overrides: Record<string, unknown> = {}) {
  const base: any = {
    _id: 'ret-1',
    originalTransactionId: 'tx-sale-1',
    originalRef: '2254',
    originalDate: '2026-08-01',
    client: 'مريم أحمد',
    phone: '01000000000',
    items: [
      { code: 'P001', name: 'سجادة', qty: 1, price: 100, total: 100, condition: 'سليم' },
    ],
    total: 100,
    itemsTotal: 100,
    reason: 'شحنة خاطئة',
    reasonDetails: '',
    requestKind: 'return',
    status: 'معلق',
    vaultRefundAccount: 'كاش',
    returnShipCo: '',
    returnTrackingNumber: '',
    sequence: 1,
    returnTxRef: '2254-RET',
    returnTxId: '',
    maxRefundable: 100,
    damagedValue: 0,
    reversedAt: null,
    approvedBy: '',
    approvedAt: '',
  };
  const merged = { ...base, ...overrides };
  merged.save = jest.fn().mockImplementation(async () => merged);
  return merged;
}

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    originalTransactionId: 'tx-sale-1',
    originalRef: '2254',
    originalDate: '2026-08-01',
    client: 'مريم أحمد',
    phone: '01000000000',
    items: [{ code: 'P001', name: 'سجادة', qty: 1, price: 100, total: 100 }],
    total: 100,
    reason: 'شحنة خاطئة',
    vaultRefundAccount: 'كاش',
    ...overrides,
  };
}

describe('ReturnsService', () => {
  let service: ReturnsService;
  let returnModel: ReturnType<typeof createMockMongooseModel>;
  let transactionsService: { create: jest.Mock; findById: jest.Mock };
  let vaultService: ReturnType<typeof createMockVaultService>;

  /** No prior returns on the invoice unless a test says otherwise. */
  function stubExistingReturns(rows: any[]) {
    returnModel.find.mockReturnValue({ exec: jest.fn().mockResolvedValue(rows) });
  }

  beforeEach(async () => {
    returnModel = createMockMongooseModel();
    transactionsService = {
      create: jest
        .fn()
        .mockImplementation(async (dto: any) => ({ _id: 'tx-ret-1', ref: dto.ref })),
      findById: jest.fn().mockResolvedValue(buildOriginalSale()),
    };
    vaultService = createMockVaultService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        ReturnsValidationService,
        { provide: getModelToken(ReturnRequest.name), useValue: returnModel },
        { provide: TransactionsService, useValue: transactionsService },
        { provide: VaultService, useValue: vaultService },
      ],
    }).compile();

    service = module.get<ReturnsService>(ReturnsService);
    stubExistingReturns([]);
    returnModel.create.mockImplementation(async (doc: any) => ({ _id: 'ret-new', ...doc }));
  });

  afterEach(() => jest.clearAllMocks());

  // ───────────────────────── fabricated items (🔴 stock inflation) ─────────────────────────

  it('rejects an item that is not on the original invoice', async () => {
    const body = baseBody({
      items: [{ code: 'P999', name: 'صنف وهمي', qty: 5, price: 900, total: 4500 }],
      total: 4500,
    });
    await expect(service.create(body, 'staff')).rejects.toThrow(ConflictException);
    expect(returnModel.create).not.toHaveBeenCalled();
  });

  it('rejects a quantity greater than the quantity sold', async () => {
    const body = baseBody({
      items: [{ code: 'P001', name: 'سجادة', qty: 4, price: 100, total: 400 }],
      total: 400,
    });
    await expect(service.create(body, 'staff')).rejects.toThrow(ConflictException);
  });

  it('rejects a tampered price even when the code is real', async () => {
    const body = baseBody({
      items: [{ code: 'P001', name: 'سجادة', qty: 1, price: 900, total: 900 }],
      total: 900,
    });
    await expect(service.create(body, 'staff')).rejects.toThrow(ConflictException);
  });

  // ───────────────────────── refund ceiling (🔴 unbounded refund) ─────────────────────────

  it('rejects a refund larger than the value of the returned items', async () => {
    const body = baseBody({ total: 50000 });
    await expect(service.create(body, 'staff')).rejects.toThrow(BadRequestException);
  });

  it('accepts a refund equal to the returned items value', async () => {
    await expect(service.create(baseBody({ total: 100 }), 'staff')).resolves.toBeDefined();
    expect(returnModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ total: 100, maxRefundable: 100, status: 'معلق' }),
    );
  });

  it('caps the refund at what the customer actually paid on a part-paid invoice', async () => {
    // Paid 120 of 400 — refunding the full 300 value of 3 returned units would hand back cash
    // that was never collected.
    transactionsService.findById.mockResolvedValue(
      buildOriginalSale({ remaining: 280 }),
    );
    const body = baseBody({
      items: [{ code: 'P001', name: 'سجادة', qty: 3, price: 100, total: 300 }],
      total: 300,
    });
    await expect(service.create(body, 'staff')).rejects.toThrow(/يتجاوز الحد المسموح/);
  });

  it('allocates an invoice-level discount proportionally to the refund ceiling', async () => {
    // 400 of goods sold for 320 after a 80 discount → each 100 line is worth 80 on return.
    transactionsService.findById.mockResolvedValue(
      buildOriginalSale({ discount: 80, total: 320 }),
    );
    await expect(service.create(baseBody({ total: 100 }), 'staff')).rejects.toThrow(
      /يتجاوز الحد المسموح/,
    );
    await expect(service.create(baseBody({ total: 80 }), 'staff')).resolves.toBeDefined();
  });

  it('subtracts an earlier refund from the cash still refundable', async () => {
    stubExistingReturns([
      buildReturnDoc({
        _id: 'ret-old',
        status: 'معتمد',
        items: [{ code: 'P002', name: 'وسادة', qty: 2, price: 50, total: 100 }],
        total: 350,
      }),
    ]);
    // 400 paid, 350 already refunded → only 50 left, so a 100 refund must fail.
    await expect(service.create(baseBody({ total: 100 }), 'staff')).rejects.toThrow(
      /يتجاوز الحد المسموح/,
    );
  });

  // ───────────────────────── partial returns (🟠 one-per-invoice) ─────────────────────────

  it('allows a second return for a different item on the same invoice', async () => {
    stubExistingReturns([
      buildReturnDoc({
        _id: 'ret-old',
        status: 'معتمد',
        items: [{ code: 'P001', name: 'سجادة', qty: 1, price: 100, total: 100 }],
        total: 100,
      }),
    ]);
    const body = baseBody({
      items: [{ code: 'P002', name: 'وسادة', qty: 1, price: 50, total: 50 }],
      total: 50,
    });
    await expect(service.create(body, 'staff')).resolves.toBeDefined();
  });

  it('allows returning the remaining units of a partially returned line', async () => {
    stubExistingReturns([
      buildReturnDoc({
        _id: 'ret-old',
        status: 'معتمد',
        items: [{ code: 'P001', name: 'سجادة', qty: 1, price: 100, total: 100 }],
        total: 100,
      }),
    ]);
    const body = baseBody({
      items: [{ code: 'P001', name: 'سجادة', qty: 2, price: 100, total: 200 }],
      total: 200,
    });
    await expect(service.create(body, 'staff')).resolves.toBeDefined();
  });

  it('rejects returning more units than are left after an earlier return', async () => {
    stubExistingReturns([
      buildReturnDoc({
        _id: 'ret-old',
        status: 'معتمد',
        items: [{ code: 'P001', name: 'سجادة', qty: 2, price: 100, total: 200 }],
        total: 200,
      }),
    ]);
    const body = baseBody({
      items: [{ code: 'P001', name: 'سجادة', qty: 2, price: 100, total: 200 }],
      total: 200,
    });
    await expect(service.create(body, 'staff')).rejects.toThrow(/تتجاوز المتاح/);
  });

  // ───────────────────────── ref sequencing (🟠 duplicate -RET) ─────────────────────────

  it('gives the first return {ref}-RET', async () => {
    await service.create(baseBody(), 'staff');
    expect(returnModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 1, returnTxRef: '2254-RET' }),
    );
  });

  it('gives a second return {ref}-RET-2 rather than colliding on {ref}-RET', async () => {
    stubExistingReturns([
      buildReturnDoc({
        _id: 'ret-old',
        status: 'معتمد',
        items: [{ code: 'P002', name: 'وسادة', qty: 1, price: 50, total: 50 }],
        total: 50,
      }),
    ]);
    await service.create(baseBody({ total: 100 }), 'staff');
    expect(returnModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 2, returnTxRef: '2254-RET-2' }),
    );
  });

  // ───────────────────────── damaged units (🟠 damaged back to stock) ─────────────────────────

  it('records damaged value and carries the condition onto the return transaction', async () => {
    const body = baseBody({
      items: [
        { code: 'P001', name: 'سجادة', qty: 1, price: 100, total: 100, condition: 'تالف' },
      ],
      total: 100,
    });
    await service.create(body, 'staff');
    expect(returnModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        damagedValue: 100,
        items: [expect.objectContaining({ condition: 'تالف' })],
      }),
    );
  });

  it('defaults a missing condition to سليم rather than leaving it undefined', async () => {
    await service.create(baseBody(), 'staff');
    expect(returnModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ items: [expect.objectContaining({ condition: 'سليم' })] }),
    );
  });

  // ───────────────────────── approval atomicity (🟠) ─────────────────────────

  it('creates the return transaction and links it back on approval', async () => {
    const ret = buildReturnDoc();
    returnModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(ret) });
    stubExistingReturns([]);

    await service.approve('ret-1', 'admin');

    expect(vaultService.assertSufficientBalance).toHaveBeenCalledWith('كاش', 100);
    expect(transactionsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'مرتجع', ref: '2254-RET', total: 100 }),
    );
    expect(ret.status).toBe('معتمد');
    expect(ret.returnTxId).toBe('tx-ret-1');
  });

  it('reverts the request to معلق when creating the return transaction fails', async () => {
    const ret = buildReturnDoc();
    returnModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(ret) });
    stubExistingReturns([]);
    transactionsService.create.mockRejectedValue(new Error('DB down'));

    await expect(service.approve('ret-1', 'admin')).rejects.toThrow('DB down');
    // Previously this left the request 'معتمد' with no transaction — counted by the reports,
    // backed by no cash movement and no stock movement.
    expect(ret.status).toBe('معلق');
    expect(ret.approvedBy).toBe('');
  });

  it('refuses to approve when the vault cannot cover the refund', async () => {
    const ret = buildReturnDoc();
    returnModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(ret) });
    stubExistingReturns([]);
    vaultService.assertSufficientBalance.mockRejectedValue(
      new BadRequestException('رصيد كاش غير كافٍ'),
    );

    await expect(service.approve('ret-1', 'admin')).rejects.toThrow(BadRequestException);
    expect(transactionsService.create).not.toHaveBeenCalled();
  });

  it('re-validates at approval time, catching units consumed by another return since', async () => {
    const ret = buildReturnDoc({
      items: [{ code: 'P001', name: 'سجادة', qty: 3, price: 100, total: 300 }],
      total: 300,
    });
    returnModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(ret) });
    // Another approved return took 2 of the 3 units while this one sat pending.
    stubExistingReturns([
      buildReturnDoc({
        _id: 'ret-other',
        status: 'معتمد',
        items: [{ code: 'P001', name: 'سجادة', qty: 2, price: 100, total: 200 }],
        total: 200,
      }),
    ]);
    await expect(service.approve('ret-1', 'admin')).rejects.toThrow(ConflictException);
    expect(transactionsService.create).not.toHaveBeenCalled();
  });

  it('refuses to approve a return whose original invoice was cancelled', async () => {
    const ret = buildReturnDoc();
    returnModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(ret) });
    transactionsService.findById.mockResolvedValue(
      buildOriginalSale({ cancelled: true }),
    );
    await expect(service.approve('ret-1', 'admin')).rejects.toThrow(BadRequestException);
  });

  it('refuses to approve a request that is not معلق', async () => {
    const ret = buildReturnDoc({ status: 'معتمد' });
    returnModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(ret) });
    await expect(service.approve('ret-1', 'admin')).rejects.toThrow(BadRequestException);
  });

  // Reversal itself is exercised in transactions.service.spec.ts — the flag is written by
  // TransactionsService.performCancellation, which owns the cancellation path.

  it('stores the transaction ref at creation so a reversal can find the request by ref alone', async () => {
    await service.create(baseBody(), 'staff');
    // returnTxId is only written after the transaction exists; the ref is the fallback the
    // reversal lookup depends on when that second save did not land.
    expect(returnModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ returnTxRef: '2254-RET' }),
    );
  });

  // ───────────────────────── misc guards ─────────────────────────

  it('rejects an exchange request explicitly instead of silently filing a refund', async () => {
    const body = baseBody({ requestKind: 'exchange', reason: 'مقاس أو لون مختلف' });
    await expect(service.create(body, 'staff')).rejects.toThrow(/الاستبدال غير متاح/);
  });

  it('rejects an exchange-only reason on a plain return', async () => {
    await expect(
      service.create(baseBody({ reason: 'عيب مصنع' }), 'staff'),
    ).rejects.toThrow(/سبب الاسترجاع غير صالح/);
  });

  it('rejects a return against a cancelled invoice', async () => {
    transactionsService.findById.mockResolvedValue(
      buildOriginalSale({ cancelled: true }),
    );
    await expect(service.create(baseBody(), 'staff')).rejects.toThrow(
      /معاملة ملغية/,
    );
  });

  it('rejects a return against a non-sales transaction', async () => {
    transactionsService.findById.mockResolvedValue(
      buildOriginalSale({ type: 'مشتريات' }),
    );
    await expect(service.create(baseBody(), 'staff')).rejects.toThrow(
      /فواتير المبيعات فقط/,
    );
  });

  it('records the reverse-shipment cost that used to be dropped', async () => {
    await service.create(baseBody({ actualShipCost: 45 }), 'staff');
    expect(returnModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ actualShipCost: 45 }),
    );
  });

  it('reports returnable quantities net of what already went back', async () => {
    stubExistingReturns([
      buildReturnDoc({
        status: 'معتمد',
        items: [{ code: 'P001', name: 'سجادة', qty: 1, price: 100, total: 100 }],
        total: 100,
      }),
    ]);
    const res = await service.getReturnableQuantities('tx-sale-1');
    expect(res.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'P001', sold: 3, returned: 1, remaining: 2 }),
        expect.objectContaining({ code: 'P002', sold: 2, returned: 0, remaining: 2 }),
      ]),
    );
    expect(res.amountPaid).toBe(400);
    expect(res.alreadyRefunded).toBe(100);
    expect(res.refundableCash).toBe(300);
  });

  it('throws NotFoundException for a missing request', async () => {
    returnModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    await expect(service.findById('nope')).rejects.toThrow(NotFoundException);
  });
});
