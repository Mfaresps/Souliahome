/**
 * Tests for SrAllocationService (FIFO / average-cost / manual allocation logic).
 *
 * Run with: npm test -- sr-allocation.service
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import { SrAllocationService } from '../../src/supplier-returns/allocation.service';
import { SupplierReturnOrder } from '../../src/supplier-returns/schemas/supplier-return.schema';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { createMockMongooseModel } from '../helpers/mocks';

function purchaseTx(id: string, ref: string, date: string, code: string, qty: number, price: number) {
  return {
    _id: id,
    ref,
    date,
    items: [{ code, qty, price }],
  } as any;
}

describe('SrAllocationService', () => {
  let service: SrAllocationService;
  let srModel: ReturnType<typeof createMockMongooseModel>;
  let transactionsService: { findPurchasesBySupplierForCode: jest.Mock };

  beforeEach(async () => {
    srModel = createMockMongooseModel();
    transactionsService = { findPurchasesBySupplierForCode: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SrAllocationService,
        { provide: getModelToken(SupplierReturnOrder.name), useValue: srModel },
        { provide: TransactionsService, useValue: transactionsService },
      ],
    }).compile();

    service = module.get<SrAllocationService>(SrAllocationService);
    srModel.find.mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });
  });

  afterEach(() => jest.clearAllMocks());

  describe('allocateFifo', () => {
    it('consumes the oldest invoice first, then the next, splitting across both', async () => {
      transactionsService.findPurchasesBySupplierForCode.mockResolvedValue([
        purchaseTx('p1', '9002', '2026-06-01', 'X2', 5, 50),
        purchaseTx('p2', '9003', '2026-07-01', 'X2', 5, 60),
      ]);

      const result = await service.allocateFifo('s1', 'Supplier A', 'X2', 7);

      expect(result.allocations).toEqual([
        { code: 'X2', qty: 5, unitCost: 50, sourceTransactionId: 'p1', sourceRef: '9002' },
        { code: 'X2', qty: 2, unitCost: 60, sourceTransactionId: 'p2', sourceRef: '9003' },
      ]);
      expect(result.totalAllocatedQty).toBe(7);
      // (5*50 + 2*60) / 7 = 52.857...
      expect(result.blendedUnitPrice).toBeCloseTo(52.8571429, 5);
    });

    it('throws BadRequestException when requested qty exceeds total purchase history', async () => {
      transactionsService.findPurchasesBySupplierForCode.mockResolvedValue([
        purchaseTx('p1', '9002', '2026-06-01', 'X2', 5, 50),
        purchaseTx('p2', '9003', '2026-07-01', 'X2', 5, 60),
      ]);

      await expect(
        service.allocateFifo('s1', 'Supplier A', 'X2', 11, undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it('respects qty already consumed by prior returns on the same invoice', async () => {
      transactionsService.findPurchasesBySupplierForCode.mockResolvedValue([
        purchaseTx('p1', '9002', '2026-06-01', 'X2', 5, 50),
      ]);
      // Prior return already took 3 of the 5 units from p1.
      srModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          {
            items: [
              {
                allocations: [
                  { code: 'X2', qty: 3, sourceTransactionId: 'p1' },
                ],
              },
            ],
          },
        ]),
      });

      await expect(
        service.allocateFifo('s1', 'Supplier A', 'X2', 3),
      ).rejects.toThrow(BadRequestException); // only 2 remain, 3 requested
    });
  });

  describe('allocateAverage', () => {
    it('computes a single weighted-average price across all contributing invoices', async () => {
      transactionsService.findPurchasesBySupplierForCode.mockResolvedValue([
        purchaseTx('p1', '9002', '2026-06-01', 'X2', 5, 50),
        purchaseTx('p2', '9003', '2026-07-01', 'X2', 5, 60),
      ]);

      const result = await service.allocateAverage('s1', 'Supplier A', 'X2', 6);

      // weighted avg over the FULL available pool (5@50 + 5@60) = 55
      expect(result.blendedUnitPrice).toBe(55);
      expect(result.totalAllocatedQty).toBe(6);
      const sumQty = result.allocations.reduce((s, a) => s + a.qty, 0);
      expect(sumQty).toBe(6);
      expect(result.allocations.every((a) => a.unitCost === 55)).toBe(true);
    });

    it('throws when requested qty exceeds total available', async () => {
      transactionsService.findPurchasesBySupplierForCode.mockResolvedValue([
        purchaseTx('p1', '9002', '2026-06-01', 'X2', 5, 50),
      ]);
      await expect(
        service.allocateAverage('s1', 'Supplier A', 'X2', 10),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('validateManualAllocation', () => {
    it('accepts a valid manual split within invoice ceilings', async () => {
      transactionsService.findPurchasesBySupplierForCode.mockResolvedValue([
        purchaseTx('p1', '9002', '2026-06-01', 'X2', 5, 50),
      ]);

      const result = await service.validateManualAllocation('s1', 'Supplier A', 'X2', 3, [
        { code: 'X2', qty: 3, unitCost: 40, sourceTransactionId: 'p1', sourceRef: '9002' },
      ]);
      expect(result.totalAllocatedQty).toBe(3);
      expect(result.blendedUnitPrice).toBe(40);
    });

    it('rejects when qty sums do not match the requested return qty', async () => {
      transactionsService.findPurchasesBySupplierForCode.mockResolvedValue([
        purchaseTx('p1', '9002', '2026-06-01', 'X2', 5, 50),
      ]);
      await expect(
        service.validateManualAllocation('s1', 'Supplier A', 'X2', 3, [
          { code: 'X2', qty: 2, unitCost: 40, sourceTransactionId: 'p1', sourceRef: '9002' },
        ]),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when unitCost exceeds the original purchase price', async () => {
      transactionsService.findPurchasesBySupplierForCode.mockResolvedValue([
        purchaseTx('p1', '9002', '2026-06-01', 'X2', 5, 50),
      ]);
      await expect(
        service.validateManualAllocation('s1', 'Supplier A', 'X2', 3, [
          { code: 'X2', qty: 3, unitCost: 60, sourceTransactionId: 'p1', sourceRef: '9002' },
        ]),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when cumulative qty from one invoice exceeds its remaining-returnable qty', async () => {
      transactionsService.findPurchasesBySupplierForCode.mockResolvedValue([
        purchaseTx('p1', '9002', '2026-06-01', 'X2', 5, 50),
      ]);
      await expect(
        service.validateManualAllocation('s1', 'Supplier A', 'X2', 6, [
          { code: 'X2', qty: 6, unitCost: 50, sourceTransactionId: 'p1', sourceRef: '9002' },
        ]),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
