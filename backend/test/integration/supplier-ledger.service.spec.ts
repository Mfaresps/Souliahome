/**
 * Integration-style tests for SupplierLedgerService using a mocked Mongoose model.
 *
 * Run with: npm test -- supplier-ledger.service
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import { SupplierLedgerService } from '../../src/supplier-ledger/supplier-ledger.service';
import { SupplierLedgerEntry } from '../../src/supplier-ledger/schemas/supplier-ledger-entry.schema';
import { createMockMongooseModel } from '../helpers/mocks';
import { VaultService } from '../../src/vault/vault.service';

describe('SupplierLedgerService', () => {
  let service: SupplierLedgerService;
  let ledgerModel: ReturnType<typeof createMockMongooseModel>;
  let vaultService: { addEntry: jest.Mock; cancelEntry: jest.Mock };

  beforeEach(async () => {
    ledgerModel = createMockMongooseModel();
    vaultService = {
      addEntry: jest.fn().mockResolvedValue({ _id: 'vault-1' }),
      cancelEntry: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupplierLedgerService,
        { provide: getModelToken(SupplierLedgerEntry.name), useValue: ledgerModel },
        { provide: VaultService, useValue: vaultService },
      ],
    }).compile();

    service = module.get<SupplierLedgerService>(SupplierLedgerService);
  });

  afterEach(() => jest.clearAllMocks());

  function mockLatestBalance(balance: number | null) {
    ledgerModel.findOne.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(balance === null ? null : { runningBalance: balance }),
    });
  }

  describe('getCurrentBalance / getBalanceSummary', () => {
    it('returns 0 when the supplier has no ledger entries', async () => {
      mockLatestBalance(null);
      await expect(service.getCurrentBalance('s1')).resolves.toBe(0);
    });

    it('returns the latest runningBalance snapshot', async () => {
      mockLatestBalance(800);
      await expect(service.getCurrentBalance('s1')).resolves.toBe(800);
    });

    it('splits a positive balance into debt only', async () => {
      mockLatestBalance(500);
      await expect(service.getBalanceSummary('s1')).resolves.toEqual({
        balance: 500,
        debt: 500,
        credit: 0,
      });
    });

    it('splits a negative balance into credit only', async () => {
      mockLatestBalance(-200);
      await expect(service.getBalanceSummary('s1')).resolves.toEqual({
        balance: -200,
        debt: 0,
        credit: 200,
      });
    });
  });

  describe('postPurchaseDebt', () => {
    it('posts amount = total - upfrontDeposit and stacks on prior balance', async () => {
      mockLatestBalance(300);
      ledgerModel.create.mockImplementation((doc: any) => Promise.resolve(doc));
      const entry = await service.postPurchaseDebt({
        supplierId: 's1',
        supplierName: 'Supplier A',
        transactionId: 'tx1',
        transactionRef: '9001',
        date: '2026-01-01',
        total: 1000,
        upfrontDeposit: 200,
        employee: 'admin',
      });
      expect(entry).not.toBeNull();
      expect(entry!.amount).toBe(800);
      expect(entry!.runningBalance).toBe(1100);
      expect(entry!.entryType).toBe('purchase-debt');
    });

    it('is a no-op when the purchase was fully paid upfront', async () => {
      mockLatestBalance(0);
      const entry = await service.postPurchaseDebt({
        supplierId: 's1',
        supplierName: 'Supplier A',
        transactionId: 'tx1',
        transactionRef: '9001',
        date: '2026-01-01',
        total: 1000,
        upfrontDeposit: 1000,
        employee: 'admin',
      });
      expect(entry).toBeNull();
      expect(ledgerModel.create).not.toHaveBeenCalled();
    });

    it('skips (returns null) when no supplierId is resolvable', async () => {
      const entry = await service.postPurchaseDebt({
        supplierId: '',
        supplierName: 'Supplier A',
        transactionId: 'tx1',
        transactionRef: '9001',
        date: '2026-01-01',
        total: 1000,
        upfrontDeposit: 0,
        employee: 'admin',
      });
      expect(entry).toBeNull();
      expect(ledgerModel.create).not.toHaveBeenCalled();
    });
  });

  describe('postPayment', () => {
    it('posts a negative amount reducing the balance', async () => {
      mockLatestBalance(1000);
      ledgerModel.create.mockImplementation((doc: any) => Promise.resolve(doc));
      const entry = await service.postPayment({
        supplierId: 's1',
        supplierName: 'Supplier A',
        transactionId: 'tx1',
        transactionRef: '9001',
        date: '2026-01-05',
        amount: 400,
        employee: 'admin',
      });
      expect(entry!.amount).toBe(-400);
      expect(entry!.runningBalance).toBe(600);
    });
  });

  describe('postReturnSettlement', () => {
    it('posts debt-offset, credit, and refund-paid rows and reports the resulting balance', async () => {
      let balance = 800;
      ledgerModel.findOne.mockImplementation(() => ({
        sort: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ runningBalance: balance }),
      }));
      ledgerModel.create.mockImplementation((doc: any) => {
        balance = doc.runningBalance;
        return Promise.resolve(doc);
      });

      const result = await service.postReturnSettlement({
        supplierId: 's1',
        supplierName: 'Supplier A',
        returnId: 'r1',
        returnNumber: 'SR-2026-0001',
        date: '2026-02-01',
        debtOffsetAmount: 800,
        creditAmount: 200,
        refundAmount: 0,
        employee: 'admin',
      });

      expect(result.entries).toHaveLength(2); // debt-offset + credit; no refund row since refundAmount=0
      expect(result.balanceAfter).toBe(-200);
      expect(result.debtOffsetAmount).toBe(800);
      expect(result.creditAmount).toBe(200);
    });

    it('posts a zero-amount refund-paid audit row without moving the balance', async () => {
      let balance = 0;
      ledgerModel.findOne.mockImplementation(() => ({
        sort: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(balance === 0 ? null : { runningBalance: balance }),
      }));
      ledgerModel.create.mockImplementation((doc: any) => {
        balance = doc.runningBalance;
        return Promise.resolve(doc);
      });

      const result = await service.postReturnSettlement({
        supplierId: 's1',
        supplierName: 'Supplier A',
        returnId: 'r1',
        returnNumber: 'SR-2026-0002',
        date: '2026-02-01',
        debtOffsetAmount: 0,
        creditAmount: 0,
        refundAmount: 300,
        employee: 'admin',
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].entryType).toBe('refund-paid');
      expect(result.entries[0].amount).toBe(0);
      expect(result.balanceAfter).toBe(0);
    });
  });

  describe('postManualAdjustment', () => {
    it('throws when reason is missing', async () => {
      await expect(
        service.postManualAdjustment({
          supplierId: 's1',
          supplierName: 'Supplier A',
          date: '2026-01-01',
          amount: 100,
          reason: '',
          employee: 'admin',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when amount is 0', async () => {
      await expect(
        service.postManualAdjustment({
          supplierId: 's1',
          supplierName: 'Supplier A',
          date: '2026-01-01',
          amount: 0,
          reason: 'تصحيح',
          employee: 'admin',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('posts a signed manual entry when valid', async () => {
      mockLatestBalance(100);
      ledgerModel.create.mockImplementation((doc: any) => Promise.resolve(doc));
      const entry = await service.postManualAdjustment({
        supplierId: 's1',
        supplierName: 'Supplier A',
        date: '2026-01-01',
        amount: -50,
        reason: 'تصحيح خطأ إدخال',
        employee: 'admin',
      });
      expect(entry.amount).toBe(-50);
      expect(entry.runningBalance).toBe(50);
      expect(entry.entryType).toBe('manual-adjustment');
    });
  });

  describe('postBalanceAdjustment', () => {
    const deposit = {
      supplierId: 's1',
      supplierName: 'Supplier A',
      kind: 'deposit' as const,
      amount: 300,
      date: '2026-01-01',
      desc: 'عربون مقدم',
      vaultSeg: 'cash',
      employee: 'admin',
    };

    it('withdraws from the vault and posts a negative (credit) ledger entry', async () => {
      mockLatestBalance(100);
      ledgerModel.create.mockImplementation((doc: any) => Promise.resolve(doc));
      const entry = await service.postBalanceAdjustment(deposit);

      expect(vaultService.addEntry).toHaveBeenCalledTimes(1);
      const [vaultDto, employee] = vaultService.addEntry.mock.calls[0];
      expect(vaultDto.amount).toBe(-300); // negative = withdrawal
      expect(vaultDto.seg).toBe('cash');
      expect(employee).toBe('admin');

      expect(entry.entryType).toBe('advance-deposit');
      expect(entry.amount).toBe(-300);
      expect(entry.runningBalance).toBe(-200); // 100 debt fully offset, 200 becomes standing credit
      expect(entry.vaultEntryId).toBe('vault-1');
      expect(entry.vaultSeg).toBe('cash');
    });

    it('turns an advance deposit into available credit on a zero balance', async () => {
      mockLatestBalance(0);
      ledgerModel.create.mockImplementation((doc: any) => Promise.resolve(doc));
      const entry = await service.postBalanceAdjustment(deposit);
      expect(entry.runningBalance).toBe(-300);
      // getBalanceSummary would surface this as credit:300 — what purchase creation can apply.
    });

    it('posts a debit as cash-neutral and never touches the vault', async () => {
      mockLatestBalance(100);
      ledgerModel.create.mockImplementation((doc: any) => Promise.resolve(doc));
      const entry = await service.postBalanceAdjustment({
        ...deposit,
        kind: 'debit',
        vaultSeg: undefined,
        desc: 'رسوم شحن من المورد',
      });
      expect(vaultService.addEntry).not.toHaveBeenCalled();
      expect(entry.entryType).toBe('debit-adjustment');
      expect(entry.amount).toBe(300);
      expect(entry.runningBalance).toBe(400);
      expect(entry.vaultEntryId).toBe('');
      expect(entry.vaultSeg).toBe('');
    });

    it('rejects a deposit with no vault segment', async () => {
      await expect(
        service.postBalanceAdjustment({ ...deposit, vaultSeg: undefined }),
      ).rejects.toThrow(BadRequestException);
      expect(vaultService.addEntry).not.toHaveBeenCalled();
    });

    it.each([0, -5, NaN])('rejects a non-positive amount (%p)', async (amount) => {
      await expect(
        service.postBalanceAdjustment({ ...deposit, amount }),
      ).rejects.toThrow(BadRequestException);
      expect(vaultService.addEntry).not.toHaveBeenCalled();
    });

    it('rejects a blank description', async () => {
      await expect(
        service.postBalanceAdjustment({ ...deposit, desc: '   ' }),
      ).rejects.toThrow(BadRequestException);
      expect(vaultService.addEntry).not.toHaveBeenCalled();
    });

    it('posts no ledger entry when the vault withdrawal fails (insufficient funds)', async () => {
      mockLatestBalance(0);
      vaultService.addEntry.mockRejectedValue(new BadRequestException('رصيد كاش غير كافٍ'));
      await expect(service.postBalanceAdjustment(deposit)).rejects.toThrow(BadRequestException);
      // The critical invariant: no phantom credit when the cash never left.
      expect(ledgerModel.create).not.toHaveBeenCalled();
    });

    it('rolls the vault withdrawal back when the ledger write fails', async () => {
      mockLatestBalance(0);
      ledgerModel.create.mockRejectedValue(new Error('mongo down'));
      await expect(service.postBalanceAdjustment(deposit)).rejects.toThrow('mongo down');
      expect(vaultService.cancelEntry).toHaveBeenCalledWith(
        'vault-1',
        'admin',
        expect.any(String),
      );
    });
  });
});
