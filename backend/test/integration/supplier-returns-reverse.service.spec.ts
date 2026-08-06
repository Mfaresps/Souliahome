/**
 * Tests for SupplierReturnsService.reverseReturn() — undoing a completed return's
 * inventory/ledger/vault effects without deleting the original record.
 *
 * Run with: npm test -- supplier-returns-reverse
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

function buildCompletedReturn(overrides: Record<string, unknown> = {}) {
  const base: any = {
    _id: 'r1',
    supplierId: 's1',
    supplierName: 'Supplier A',
    returnNumber: 'SR-2026-0001',
    linkedInvoices: [{ transactionId: 'tx1', ref: '9001', date: '2026-01-01', allocatedTotal: 200 }],
    allocationMethod: 'single-invoice',
    reason: 'تلف المنتج',
    items: [{ code: 'X1', name: 'X1', qty: 2, price: 100, total: 200, allocations: [] }],
    itemsTotal: 200,
    total: 200,
    status: 'مكتمل',
    vaultRefundAccount: 'كاش',
    createdBy: 'admin',
    linkedTransactionId: 'tx-return-1',
    settlement: {
      debtBalanceBeforeApplied: 1000,
      returnValue: 200,
      debtOffsetAmount: 200,
      creditAmount: 0,
      refundAmount: 0,
      settlementType: 'debt-offset',
      debtBalanceAfter: 800,
      decidedBy: 'admin',
      decidedAt: '2026-01-05T00:00:00.000Z',
    },
    reversal: null,
    statusHistory: [],
  };
  const merged = { ...base, ...overrides };
  merged.save = jest.fn().mockImplementation(async () => merged);
  return merged;
}

describe('SupplierReturnsService.reverseReturn()', () => {
  let service: SupplierReturnsService;
  let srModel: ReturnType<typeof createMockMongooseModel>;
  let transactionsService: { create: jest.Mock; findById: jest.Mock; cancel: jest.Mock };
  let suppliersService: ReturnType<typeof createMockSuppliersService>;
  let supplierLedgerService: ReturnType<typeof createMockSupplierLedgerService>;

  beforeEach(async () => {
    srModel = createMockMongooseModel();
    transactionsService = {
      create: jest.fn(),
      findById: jest.fn().mockResolvedValue({ _id: 'tx-return-1', cancelled: false, ref: '9001-SRET' }),
      cancel: jest.fn().mockImplementation(async (id: string) => ({ _id: id, ref: '9001-SRET', cancelled: true })),
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
  });

  afterEach(() => jest.clearAllMocks());

  it('rejects reversing a return that is not مكتمل', async () => {
    const order = buildCompletedReturn({ status: 'معتمد' });
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    await expect(service.reverseReturn('r1', 'admin', 'خطأ في الإدخال')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects reversing an already-reversed return', async () => {
    const order = buildCompletedReturn({
      reversal: {
        reversedBy: 'admin',
        reversedAt: '2026-01-06T00:00:00.000Z',
        reason: 'سابقاً',
        reversalTransactionId: 'tx-return-1',
        reversedLedgerEntryIds: [],
        balanceBeforeReversal: 800,
        balanceAfterReversal: 1000,
      },
    });
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    await expect(service.reverseReturn('r1', 'admin', 'مرة أخرى')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects when the linked transaction is already independently cancelled', async () => {
    const order = buildCompletedReturn();
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    transactionsService.findById.mockResolvedValue({ _id: 'tx-return-1', cancelled: true });
    await expect(service.reverseReturn('r1', 'admin', 'سبب')).rejects.toThrow(BadRequestException);
    expect(supplierLedgerService.reverseReturnSettlement).not.toHaveBeenCalled();
  });

  it('reverses ledger before cancelling the linked transaction, and records full audit info', async () => {
    const order = buildCompletedReturn();
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: 800, debt: 800, credit: 0 });
    supplierLedgerService.reverseReturnSettlement.mockResolvedValue({
      reversedEntries: [{ _id: 'led1' }, { _id: 'led2' }],
      balanceAfter: 1000,
      supplierId: 's1',
    });

    const callOrder: string[] = [];
    supplierLedgerService.reverseReturnSettlement.mockImplementation(async () => {
      callOrder.push('ledger');
      return { reversedEntries: [{ _id: 'led1' }], balanceAfter: 1000, supplierId: 's1' };
    });
    transactionsService.cancel.mockImplementation(async (id: string) => {
      callOrder.push('cancel');
      return { _id: id, ref: '9001-SRET', cancelled: true };
    });

    const saved = await service.reverseReturn('r1', 'admin', 'تم تسجيل المرتجع بالخطأ');

    expect(callOrder).toEqual(['ledger', 'cancel']);
    expect(transactionsService.cancel).toHaveBeenCalledWith(
      'tx-return-1',
      expect.objectContaining({ cancelledBy: 'admin' }),
    );
    expect(saved.status).toBe('مكتمل'); // status unchanged — reversal is additive, not a new status
    expect(saved.reversal).toEqual(
      expect.objectContaining({
        reversedBy: 'admin',
        reason: 'تم تسجيل المرتجع بالخطأ',
        reversalTransactionId: 'tx-return-1',
        reversedLedgerEntryIds: ['led1'],
        balanceBeforeReversal: 800,
        balanceAfterReversal: 1000,
      }),
    );
    expect(saved.statusHistory).toHaveLength(1);
    expect(suppliersService.addLog).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ action: 'عكس مرتجع مورد' }),
    );
  });

  it('rejects reversing when there is no linked transaction', async () => {
    const order = buildCompletedReturn({ linkedTransactionId: '' });
    srModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(order) });
    await expect(service.reverseReturn('r1', 'admin', 'سبب')).rejects.toThrow(BadRequestException);
  });
});
