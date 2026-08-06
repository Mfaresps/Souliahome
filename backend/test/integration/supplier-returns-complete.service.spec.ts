/**
 * Tests for SupplierReturnsService.complete() — debt-offset / refund / credit settlement logic.
 *
 * Run with: npm test -- supplier-returns-complete
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import { SupplierReturnsService } from '../../src/supplier-returns/supplier-returns.service';
import { SupplierReturnOrder } from '../../src/supplier-returns/schemas/supplier-return.schema';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { SuppliersService } from '../../src/suppliers/suppliers.service';
import { SupplierLedgerService } from '../../src/supplier-ledger/supplier-ledger.service';
import { SrAllocationService } from '../../src/supplier-returns/allocation.service';
import {
  createMockMongooseModel,
  createMockSuppliersService,
  createMockSupplierLedgerService,
} from '../helpers/mocks';

function buildReturnOrder(overrides: Record<string, unknown> = {}) {
  const base: any = {
    _id: 'r1',
    supplierId: 's1',
    supplierName: 'Supplier A',
    returnNumber: 'SR-2026-0001',
    originalTransactionId: 'tx1',
    originalRef: '9001',
    linkedInvoices: [{ transactionId: 'tx1', ref: '9001', date: '2026-01-01', allocatedTotal: 200 }],
    allocationMethod: 'single-invoice',
    reason: 'تلف المنتج',
    reasonDetails: '',
    items: [{ code: 'X1', name: 'X1', qty: 2, price: 100, total: 200, allocations: [] }],
    itemsTotal: 200,
    total: 200,
    status: 'معتمد',
    vaultRefundAccount: 'كاش',
    createdBy: 'admin',
    linkedTransactionId: '',
    settlement: null,
    statusHistory: [],
  };
  const merged = { ...base, ...overrides };
  merged.save = jest.fn().mockImplementation(async () => merged);
  return merged;
}

describe('SupplierReturnsService.complete()', () => {
  let service: SupplierReturnsService;
  let srModel: ReturnType<typeof createMockMongooseModel>;
  let transactionsService: { create: jest.Mock; findById: jest.Mock };
  let suppliersService: ReturnType<typeof createMockSuppliersService>;
  let supplierLedgerService: ReturnType<typeof createMockSupplierLedgerService>;
  let allocationService: SrAllocationService;

  beforeEach(async () => {
    srModel = createMockMongooseModel();
    transactionsService = {
      create: jest.fn().mockImplementation(async (dto: any) => ({ _id: 'tx-return-1', ref: dto.ref, total: dto.total })),
      findById: jest.fn(),
    };
    suppliersService = createMockSuppliersService();
    supplierLedgerService = createMockSupplierLedgerService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupplierReturnsService,
        { provide: getModelToken(SupplierReturnOrder.name), useValue: srModel },
        { provide: TransactionsService, useValue: transactionsService },
        { provide: SuppliersService, useValue: suppliersService },
        { provide: SupplierLedgerService, useValue: supplierLedgerService },
        { provide: SrAllocationService, useValue: {} },
      ],
    }).compile();

    service = module.get<SupplierReturnsService>(SupplierReturnsService);
    allocationService = module.get<SrAllocationService>(SrAllocationService);
  });

  afterEach(() => jest.clearAllMocks());

  it('rejects completing a return that is not معتمد', async () => {
    const order = buildReturnOrder({ status: 'معلق' });
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    await expect(service.complete('r1', 'admin')).rejects.toThrow(BadRequestException);
  });

  it('degrades to today\'s behavior when there is no pre-existing debt (full cash refund)', async () => {
    const order = buildReturnOrder();
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: 0, debt: 0, credit: 0 });
    supplierLedgerService.postReturnSettlement.mockResolvedValue({
      entries: [],
      debtOffsetAmount: 0,
      creditAmount: 0,
      refundAmount: 200,
      balanceAfter: 0,
    });

    const saved = await service.complete('r1', 'admin');

    expect(transactionsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ total: 200, depMethod: 'كاش', payment: 'كاش' }),
    );
    expect(saved.settlement!.settlementType).toBe('refund');
    expect(saved.settlement!.refundAmount).toBe(200);
    expect(saved.settlement!.debtOffsetAmount).toBe(0);
  });

  it('applies the full return value against outstanding debt when debt >= return value', async () => {
    const order = buildReturnOrder();
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: 1000, debt: 1000, credit: 0 });
    supplierLedgerService.postReturnSettlement.mockResolvedValue({
      entries: [],
      debtOffsetAmount: 200,
      creditAmount: 0,
      refundAmount: 0,
      balanceAfter: 800,
    });

    const saved = await service.complete('r1', 'admin');

    // The linked مرتجع مشتريات transaction should carry total:0 — no cash left the vault.
    expect(transactionsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ total: 0, depMethod: '', payment: '' }),
    );
    expect(saved.settlement!.settlementType).toBe('debt-offset');
    expect(saved.settlement!.debtOffsetAmount).toBe(200);
    expect(saved.settlement!.refundAmount).toBe(0);
    expect(saved.settlement!.debtBalanceAfter).toBe(800);
  });

  it('splits debt-offset + credit when settlementMode=debt-offset and remainderMode=credit', async () => {
    const order = buildReturnOrder({ total: 1000, itemsTotal: 1000 });
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: 800, debt: 800, credit: 0 });
    supplierLedgerService.postReturnSettlement.mockResolvedValue({
      entries: [],
      debtOffsetAmount: 800,
      creditAmount: 200,
      refundAmount: 0,
      balanceAfter: -200,
    });

    const saved = await service.complete('r1', 'admin', 'debt-offset', 'credit');

    expect(supplierLedgerService.postReturnSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ debtOffsetAmount: 800, creditAmount: 200, refundAmount: 0 }),
    );
    expect(saved.settlement!.settlementType).toBe('mixed-debt-credit');
    expect(saved.settlement!.debtBalanceAfter).toBe(-200);
  });

  // The three-way settlement choice: 'refund'/'credit' deliberately BYPASS outstanding debt, so an
  // admin can take a return's value as cash (or hold it as credit) even while the supplier is owed
  // money. Only 'debt-offset' touches the debt.
  it('refunds the FULL value and leaves debt untouched when settlementMode=refund', async () => {
    const order = buildReturnOrder({ total: 1000, itemsTotal: 1000 });
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: 800, debt: 800, credit: 0 });
    supplierLedgerService.postReturnSettlement.mockResolvedValue({
      entries: [],
      debtOffsetAmount: 0,
      creditAmount: 0,
      refundAmount: 1000,
      balanceAfter: 800,
    });

    const saved = await service.complete('r1', 'admin', 'refund');

    expect(supplierLedgerService.postReturnSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ debtOffsetAmount: 0, creditAmount: 0, refundAmount: 1000 }),
    );
    expect(transactionsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ total: 1000 }),
    );
    expect(saved.settlement!.settlementType).toBe('refund');
    expect(saved.settlement!.debtBalanceAfter).toBe(800);
  });

  it('credits the FULL value and leaves debt untouched when settlementMode=credit', async () => {
    const order = buildReturnOrder({ total: 1000, itemsTotal: 1000 });
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: 800, debt: 800, credit: 0 });
    supplierLedgerService.postReturnSettlement.mockResolvedValue({
      entries: [],
      debtOffsetAmount: 0,
      creditAmount: 1000,
      refundAmount: 0,
      balanceAfter: -200,
    });

    const saved = await service.complete('r1', 'admin', 'credit');

    expect(supplierLedgerService.postReturnSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ debtOffsetAmount: 0, creditAmount: 1000, refundAmount: 0 }),
    );
    // No cash leaves the vault on a pure-credit settlement.
    expect(transactionsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ total: 0, depMethod: '', payment: '' }),
    );
    expect(saved.settlement!.settlementType).toBe('credit');
  });

  it('splits debt-offset + refund when the return exceeds debt and no credit mode is chosen', async () => {
    const order = buildReturnOrder({ total: 1000, itemsTotal: 1000 });
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: 800, debt: 800, credit: 0 });
    supplierLedgerService.postReturnSettlement.mockResolvedValue({
      entries: [],
      debtOffsetAmount: 800,
      creditAmount: 0,
      refundAmount: 200,
      balanceAfter: 0,
    });

    const saved = await service.complete('r1', 'admin');

    // Key regression check: only the REMAINDER (200), not the full return value (1000), hits the vault.
    expect(transactionsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ total: 200 }),
    );
    expect(saved.settlement!.settlementType).toBe('mixed-debt-refund');
    expect(saved.settlement!.refundAmount).toBe(200);
  });

  it('requires vaultRefundAccount when a refund portion exists', async () => {
    const order = buildReturnOrder({ total: 1000, itemsTotal: 1000, vaultRefundAccount: '' });
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: 0, debt: 0, credit: 0 });

    await expect(service.complete('r1', 'admin')).rejects.toThrow(BadRequestException);
  });

  // The vault segment is now chosen at completion, not at creation — a return created without one
  // completes fine as long as the segment is supplied here when cash actually moves.
  it('accepts a vaultRefundAccount supplied at completion time', async () => {
    const order = buildReturnOrder({ total: 1000, itemsTotal: 1000, vaultRefundAccount: '' });
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: 0, debt: 0, credit: 0 });
    supplierLedgerService.postReturnSettlement.mockResolvedValue({
      entries: [], debtOffsetAmount: 0, creditAmount: 0, refundAmount: 1000, balanceAfter: 0,
    });

    const saved = await service.complete('r1', 'admin', 'refund', undefined, 'كاش');

    expect(saved.vaultRefundAccount).toBe('كاش');
    expect(transactionsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ total: 1000, depMethod: 'كاش' }),
    );
  });

  it('completes without any vault account when no cash moves (pure credit)', async () => {
    const order = buildReturnOrder({ total: 1000, itemsTotal: 1000, vaultRefundAccount: '' });
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: 0, debt: 0, credit: 0 });
    supplierLedgerService.postReturnSettlement.mockResolvedValue({
      entries: [], debtOffsetAmount: 0, creditAmount: 1000, refundAmount: 0, balanceAfter: -1000,
    });

    const saved = await service.complete('r1', 'admin', 'credit');

    expect(saved.settlement!.settlementType).toBe('credit');
    expect(transactionsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ total: 0, depMethod: '' }),
    );
  });

  it('rejects an invalid vault account label supplied at completion', async () => {
    const order = buildReturnOrder({ total: 1000, itemsTotal: 1000, vaultRefundAccount: '' });
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: 0, debt: 0, credit: 0 });

    await expect(
      service.complete('r1', 'admin', 'refund', undefined, 'not-a-vault'),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects completing with a non-positive return total', async () => {
    const order = buildReturnOrder({ total: 0, itemsTotal: 0 });
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    await expect(service.complete('r1', 'admin')).rejects.toThrow(BadRequestException);
  });
});
