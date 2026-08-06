/**
 * Integration-style tests for TransactionsService using mocked dependencies.
 * Demonstrates service-level testing with NestJS's Test module.
 *
 * Run with: npm test -- transactions.service
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { Transaction } from '../../src/transactions/schemas/transaction.schema';
import { ReturnRequest } from '../../src/returns/schemas/return-request.schema';
import { ProductsService } from '../../src/products/products.service';
import { VaultService } from '../../src/vault/vault.service';
import { PresenceGateway } from '../../src/auth/presence.gateway';
import { MentionsService } from '../../src/mentions/mentions.service';
import { DiscountOtpService } from '../../src/discount-otp/discount-otp.service';
import { SettingsService } from '../../src/settings/settings.service';
import { ShopifyAdminService } from '../../src/shopify/shopify-admin.service';
import { SupplierLedgerService } from '../../src/supplier-ledger/supplier-ledger.service';
import { SuppliersService } from '../../src/suppliers/suppliers.service';
import { InventoryMovementsService } from '../../src/inventory-movements/inventory-movements.service';
import {
  createMockMongooseModel,
  createMockProductsService,
  createMockVaultService,
  createMockPresenceGateway,
  createMockMentionsService,
  createMockDiscountOtpService,
  createMockSettingsService,
  createMockShopifyAdminService,
  createMockSupplierLedgerService,
  createMockSuppliersService,
  createMockInventoryMovementsService,
} from '../helpers/mocks';
import { mockProducts } from '../fixtures/products.fixture';
import { buildSaleTransaction } from '../fixtures/transactions.fixture';

describe('TransactionsService (integration with mocks)', () => {
  let service: TransactionsService;
  let txModel: ReturnType<typeof createMockMongooseModel>;
  let returnModel: ReturnType<typeof createMockMongooseModel>;
  let productsService: ReturnType<typeof createMockProductsService>;
  let vaultService: ReturnType<typeof createMockVaultService>;
  let supplierLedgerService: ReturnType<typeof createMockSupplierLedgerService>;
  let suppliersService: ReturnType<typeof createMockSuppliersService>;
  let inventoryMovementsService: ReturnType<
    typeof createMockInventoryMovementsService
  >;

  beforeEach(async () => {
    txModel = createMockMongooseModel();
    returnModel = createMockMongooseModel();
    productsService = createMockProductsService();
    vaultService = createMockVaultService();
    supplierLedgerService = createMockSupplierLedgerService();
    suppliersService = createMockSuppliersService();
    inventoryMovementsService = createMockInventoryMovementsService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: getModelToken(Transaction.name), useValue: txModel },
        { provide: getModelToken(ReturnRequest.name), useValue: returnModel },
        { provide: ProductsService, useValue: productsService },
        { provide: VaultService, useValue: vaultService },
        { provide: PresenceGateway, useValue: createMockPresenceGateway() },
        { provide: MentionsService, useValue: createMockMentionsService() },
        { provide: DiscountOtpService, useValue: createMockDiscountOtpService() },
        { provide: SettingsService, useValue: createMockSettingsService() },
        { provide: ShopifyAdminService, useValue: createMockShopifyAdminService() },
        { provide: SupplierLedgerService, useValue: supplierLedgerService },
        { provide: SuppliersService, useValue: suppliersService },
        {
          provide: InventoryMovementsService,
          useValue: inventoryMovementsService,
        },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Reference validation', () => {
    it('rejects sale without reference', async () => {
      const dto = { type: 'مبيعات', ref: '', items: [], date: '2026-04-26', employee: 'e' } as any;
      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('rejects sale with non-numeric reference', async () => {
      txModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      productsService.findAll.mockResolvedValue(mockProducts);
      const dto = {
        type: 'مبيعات',
        ref: 'INV-001',
        items: [{ code: 'P001', name: 'p', qty: 1, price: 100, total: 100 }],
        date: '2026-04-26',
        employee: 'e',
        client: 'c',
        total: 100,
      } as any;
      await expect(service.create(dto)).rejects.toThrow(/أرقاماً فقط/);
    });

    it('rejects duplicate reference among non-cancelled', async () => {
      txModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(buildSaleTransaction({ ref: '1001' })),
      });
      productsService.findAll.mockResolvedValue(mockProducts);
      const dto = {
        type: 'مبيعات',
        ref: '1001',
        items: [{ code: 'P001', name: 'p', qty: 1, price: 100, total: 100 }],
        date: '2026-04-26',
        employee: 'e',
        client: 'c',
        total: 100,
      } as any;
      await expect(service.create(dto)).rejects.toThrow(/مسجّل مسبقاً/);
    });
  });

  describe('findById', () => {
    // findById() guards with isValidObjectId() before hitting the DB, so these must use
    // real ObjectId-shaped ids — a placeholder like 'missing-id' fails the guard instead.
    const VALID_ID = '507f1f77bcf86cd799439011';

    it('rejects a malformed transaction id before querying', async () => {
      await expect(service.findById('missing-id')).rejects.toThrow(/غير صالح/);
      expect(txModel.findById).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for missing transaction', async () => {
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      await expect(service.findById(VALID_ID)).rejects.toThrow(/غير موجودة/);
    });

    it('returns transaction when found', async () => {
      const tx = buildSaleTransaction();
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      const result = await service.findById(VALID_ID);
      expect(result).toEqual(tx);
    });
  });

  describe('findAll', () => {
    it('returns all non-archived transactions', async () => {
      const txs = [buildSaleTransaction(), buildSaleTransaction({ _id: 't2' })];
      txModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(txs) }),
      });
      const result = await service.findAll();
      expect(result).toHaveLength(2);
      expect(txModel.find).toHaveBeenCalledWith({ archived: { $ne: true } });
    });

    it('applies pagination when page and limit are provided', async () => {
      const skipFn = jest.fn().mockReturnThis();
      const limitFn = jest.fn().mockReturnThis();
      txModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: skipFn,
          limit: limitFn,
          exec: jest.fn().mockResolvedValue([]),
        }),
      });
      await service.findAll(2, 10);
      expect(skipFn).toHaveBeenCalledWith(10);
      expect(limitFn).toHaveBeenCalledWith(10);
    });
  });

  describe('Vault integration on create', () => {
    it('checks vault balance for purchase deposits', async () => {
      txModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      productsService.findAll.mockResolvedValue(mockProducts);
      txModel.create.mockResolvedValue({
        ...buildSaleTransaction(),
        type: 'مشتريات',
        save: jest.fn(),
      });
      vaultService.assertSufficientBalance.mockResolvedValue(undefined);

      const dto = {
        type: 'مشتريات',
        ref: '5001',
        items: [{ code: 'P001', name: 'p', qty: 5, price: 60, total: 300 }],
        date: '2026-04-26',
        employee: 'e',
        client: 'supplier',
        total: 300,
        deposit: 100,
        depMethod: 'كاش',
      } as any;

      try {
        await service.create(dto);
      } catch (e) {
        // ignore secondary failures — we just assert the balance check fired
      }
      expect(vaultService.assertSufficientBalance).toHaveBeenCalledWith('كاش', 100);
    });

    it('skips vault check when purchase deposit is 0', async () => {
      txModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      productsService.findAll.mockResolvedValue(mockProducts);
      txModel.create.mockResolvedValue({
        ...buildSaleTransaction(),
        type: 'مشتريات',
        save: jest.fn(),
      });

      const dto = {
        type: 'مشتريات',
        ref: '5002',
        items: [{ code: 'P001', name: 'p', qty: 5, price: 60, total: 300 }],
        date: '2026-04-26',
        employee: 'e',
        client: 'supplier',
        total: 300,
        deposit: 0,
      } as any;

      try {
        await service.create(dto);
      } catch (e) {
        // ignore
      }
      expect(vaultService.assertSufficientBalance).not.toHaveBeenCalled();
    });
  });

  describe('Supplier credit usage on purchase create()', () => {
    function purchaseDto(overrides: Record<string, unknown> = {}) {
      return {
        type: 'مشتريات',
        ref: '6001',
        items: [{ code: 'P001', name: 'p', qty: 5, price: 4000, total: 20000 }],
        date: '2026-04-26',
        employee: 'e',
        client: 'Supplier A',
        supplierId: 's1',
        total: 20000,
        deposit: 0,
        ...overrides,
      } as any;
    }

    beforeEach(() => {
      txModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      productsService.findAll.mockResolvedValue(mockProducts);
      txModel.create.mockImplementation(async (dto: any) => ({
        ...buildSaleTransaction(),
        ...dto,
        type: 'مشتريات',
        _id: 'tx-purchase-1',
        save: jest.fn(),
      }));
    });

    it('rejects applying more credit than available, before creating the transaction', async () => {
      supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: -7000, debt: 0, credit: 7000 });
      const dto = purchaseDto({ creditApplied: 9000 });
      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
      expect(txModel.create).not.toHaveBeenCalled();
    });

    it('rejects applying credit when no supplierId is resolvable', async () => {
      supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: -7000, debt: 0, credit: 7000 });
      suppliersService.findAll.mockResolvedValue([]);
      const dto = purchaseDto({ creditApplied: 1000, supplierId: undefined, client: 'Unknown Supplier' });
      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
      expect(txModel.create).not.toHaveBeenCalled();
    });

    it('posts purchase-debt net of credit AND a separate credit-used entry (worked example: 20000 total, 7000 credit, 0 deposit)', async () => {
      supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: -7000, debt: 0, credit: 7000 });
      const dto = purchaseDto({ creditApplied: 7000 });

      await service.create(dto);

      expect(supplierLedgerService.postPurchaseDebt).toHaveBeenCalledWith(
        expect.objectContaining({ total: 20000, upfrontDeposit: 7000, supplierId: 's1' }),
      );
      expect(supplierLedgerService.postCreditUsed).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 7000, supplierId: 's1' }),
      );
    });

    it('combines deposit AND credit: net debt reflects both reductions (deposit 3000, credit 7000, total 20000)', async () => {
      supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: -7000, debt: 0, credit: 7000 });
      const dto = purchaseDto({ creditApplied: 7000, deposit: 3000, depMethod: 'كاش' });

      await service.create(dto);

      expect(supplierLedgerService.postPurchaseDebt).toHaveBeenCalledWith(
        expect.objectContaining({ total: 20000, upfrontDeposit: 10000 }), // 3000 deposit + 7000 credit
      );
      expect(supplierLedgerService.postCreditUsed).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 7000 }),
      );
    });

    it('does not call postCreditUsed when creditApplied is 0 or omitted', async () => {
      supplierLedgerService.getBalanceSummary.mockResolvedValue({ balance: 0, debt: 0, credit: 0 });
      const dto = purchaseDto();

      await service.create(dto);

      expect(supplierLedgerService.postCreditUsed).not.toHaveBeenCalled();
      expect(supplierLedgerService.postPurchaseDebt).toHaveBeenCalledWith(
        expect.objectContaining({ total: 20000, upfrontDeposit: 0 }),
      );
    });
  });

  describe('getInventory — مرتجع مشتريات stock impact', () => {
    it('subtracts مرتجع مشتريات quantities from current stock, same as مبيعات', async () => {
      productsService.findAll.mockResolvedValue([mockProducts[0]]); // P001, openingBalance:50
      txModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          buildSaleTransaction({
            type: 'مرتجع مشتريات',
            items: [{ code: 'P001', name: 'p', qty: 5, price: 60, total: 300 }],
          }),
        ]),
      });
      const inventory = await service.getInventory();
      const row = inventory.find((r) => r.code === 'P001');
      expect(row!.sales).toBe(5);
      expect(row!.current).toBe(45); // openingBalance(50) - 5, mirrors doesTransactionTypeConsumeStock()
    });
  });

  describe('cancel() — مرتجع مشتريات vault reversal (supplier-return reversal support)', () => {
    it('posts a compensating negative vault entry equal to the original refund amount', async () => {
      const tx: any = buildSaleTransaction({
        _id: 'tx-return-1',
        type: 'مرتجع مشتريات',
        ref: '9001-SRET',
        client: 'Supplier A',
        total: 350,
        deposit: 0,
        remaining: 0,
        depMethod: 'كاش',
        payment: 'كاش',
        cancelled: false,
      });
      tx.save = jest.fn().mockImplementation(async function (this: any) {
        return this;
      });
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });

      await service.cancel('tx-return-1', { cancelReason: 'عكس مرتجع مورد', cancelledBy: 'admin' });

      expect(vaultService.addSystemEntry).toHaveBeenCalledWith(
        -350,
        'كاش',
        expect.stringContaining('عكس مرتجع مشتريات'),
        expect.any(String),
        'إلغاء',
        '9001-SRET',
      );
    });

    it('does not post a vault entry when the original مرتجع مشتريات had no cash refund (total:0)', async () => {
      const tx: any = buildSaleTransaction({
        _id: 'tx-return-2',
        type: 'مرتجع مشتريات',
        ref: '9002-SRET',
        client: 'Supplier A',
        total: 0,
        deposit: 0,
        remaining: 0,
        depMethod: '',
        payment: '',
        cancelled: false,
      });
      tx.save = jest.fn().mockImplementation(async function (this: any) {
        return this;
      });
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });

      await service.cancel('tx-return-2', { cancelReason: 'عكس مرتجع مورد', cancelledBy: 'admin' });

      expect(vaultService.addSystemEntry).not.toHaveBeenCalled();
    });

    it('rejects cancelling an already-cancelled transaction', async () => {
      const tx = buildSaleTransaction({ type: 'مرتجع مشتريات', cancelled: true });
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      await expect(
        service.cancel('tx-return-3', { cancelReason: 'x', cancelledBy: 'admin' }),
      ).rejects.toThrow(BadRequestException);
      expect(vaultService.addSystemEntry).not.toHaveBeenCalled();
    });
  });
});
