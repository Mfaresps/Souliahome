/**
 * Integration-style tests for TransactionsService using mocked dependencies.
 * Demonstrates service-level testing with NestJS's Test module.
 *
 * Run with: npm test -- transactions.service
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { Transaction } from '../../src/transactions/schemas/transaction.schema';
import { ReturnRequest } from '../../src/returns/schemas/return-request.schema';
import { SupplierReturnOrder } from '../../src/supplier-returns/schemas/supplier-return.schema';
import { ShopifyOrder } from '../../src/shopify/schemas/shopify-order.schema';
import { CarrierImport } from '../../src/transactions/schemas/carrier-import.schema';
import { ProductsService } from '../../src/products/products.service';
import { VaultService } from '../../src/vault/vault.service';
import { PresenceGateway } from '../../src/auth/presence.gateway';
import { MentionsService } from '../../src/mentions/mentions.service';
import { DiscountOtpService } from '../../src/discount-otp/discount-otp.service';
import { SettingsService } from '../../src/settings/settings.service';
import { ShopifyAdminService } from '../../src/shopify/shopify-admin.service';
import { DepositReceiptsService } from '../../src/shopify/deposit-receipts.service';
import { SupplierLedgerService } from '../../src/supplier-ledger/supplier-ledger.service';
import { SuppliersService } from '../../src/suppliers/suppliers.service';
import { InventoryMovementsService } from '../../src/inventory-movements/inventory-movements.service';
import { FollowUpsService } from '../../src/followups/followups.service';
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
  createMockFollowUpsService,
} from '../helpers/mocks';
import { mockProducts } from '../fixtures/products.fixture';
import { buildSaleTransaction } from '../fixtures/transactions.fixture';

describe('TransactionsService (integration with mocks)', () => {
  let service: TransactionsService;
  let txModel: ReturnType<typeof createMockMongooseModel>;
  let returnModel: ReturnType<typeof createMockMongooseModel>;
  let supplierReturnModel: ReturnType<typeof createMockMongooseModel>;
  // Read-only in the service (the cancellations report). ⚠ Must be provided here or the whole
  // module fails to compile — see the FollowUpsService note in CLAUDE.md.
  let shopifyOrderModel: ReturnType<typeof createMockMongooseModel>;
  // ⚠ TransactionsService now injects this for the shipping report. A dependency added to the
  // service and NOT registered here makes EVERY test in this file fail to compile a module —
  // the FollowUpsService trap documented in CLAUDE.md.
  let carrierImportModel: ReturnType<typeof createMockMongooseModel>;
  let productsService: ReturnType<typeof createMockProductsService>;
  let vaultService: ReturnType<typeof createMockVaultService>;
  let supplierLedgerService: ReturnType<typeof createMockSupplierLedgerService>;
  let suppliersService: ReturnType<typeof createMockSuppliersService>;
  let inventoryMovementsService: ReturnType<
    typeof createMockInventoryMovementsService
  >;
  let receiptService: { claimManualReceipt: jest.Mock; releaseManualReceipt: jest.Mock; consumeManualReceipt: jest.Mock };

  beforeEach(async () => {
    txModel = createMockMongooseModel();
    returnModel = createMockMongooseModel();
    supplierReturnModel = createMockMongooseModel();
    shopifyOrderModel = createMockMongooseModel();
    carrierImportModel = createMockMongooseModel();
    productsService = createMockProductsService();
    vaultService = createMockVaultService();
    supplierLedgerService = createMockSupplierLedgerService();
    suppliersService = createMockSuppliersService();
    inventoryMovementsService = createMockInventoryMovementsService();
    receiptService = { claimManualReceipt: jest.fn(), releaseManualReceipt: jest.fn(), consumeManualReceipt: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: DepositReceiptsService, useValue: receiptService },
        { provide: getModelToken(Transaction.name), useValue: txModel },
        { provide: getModelToken(ReturnRequest.name), useValue: returnModel },
        {
          provide: getModelToken(SupplierReturnOrder.name),
          useValue: supplierReturnModel,
        },
        {
          provide: getModelToken(ShopifyOrder.name),
          useValue: shopifyOrderModel,
        },
        {
          provide: getModelToken(CarrierImport.name),
          useValue: carrierImportModel,
        },
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
        { provide: FollowUpsService, useValue: createMockFollowUpsService() },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('manual receipt creation', () => {
    const actor = { id: 'staff1', name: 'Tester', username: 'tester', isAdmin: false };
    const draftId = 'dr_manual';
    const receipt = { id: 'dr_manual', amount: 50, method: 'Instapay', imageKey: 'deposit-receipts/manual.jpg', imageDeleted: false };
    const dto = { type: 'مبيعات', ref: '90001', items: [{ code: 'P001', name: 'Test', qty: 1, price: 100, total: 100 }], date: '2026-10-10', employee: 'Tester',
      client: 'Customer', total: 100, deposit: 50, depMethod: 'Instapay', remaining: 50, payStatus: 'معلق' } as any;

    beforeEach(() => {
      txModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      receiptService.claimManualReceipt.mockResolvedValue(receipt);
      productsService.findAll.mockResolvedValue(mockProducts);
      jest.spyOn(service, 'getInventory').mockResolvedValue([]);
    });

    it('persists the image with the sale and books its deposit exactly once', async () => {
      const tx: any = { ...dto, _id: 'tx-manual', depositReceipts: [receipt], deposits: [], save: jest.fn() };
      tx.save.mockResolvedValue(tx);
      txModel.create.mockResolvedValue(tx);
      vaultService.addSystemEntry.mockResolvedValue({ _id: 'vault-1', txNo: 'SAL-001' });
      await service.create(dto, 'admin', { draftId, actor });
      expect(txModel.create).toHaveBeenCalledWith(expect.objectContaining({ depositReceipts: [receipt] }));
      expect(vaultService.addSystemEntry).toHaveBeenCalledTimes(1);
      expect(vaultService.addSystemEntry.mock.calls[0].slice(0, 2)).toEqual([50, 'Instapay']);
      expect(tx.deposits[0]).toMatchObject({ id: receipt.id, source: 'deposit-receipt', receiptId: receipt.id, vaultTxNo: 'SAL-001' });
      expect(tx.depositReceipts[0].vaultTxNo).toBe('SAL-001');
    });

    it('does not create or book the sale if the image upload fails', async () => {
      receiptService.claimManualReceipt.mockRejectedValue(new BadRequestException('Receipt not confirmed'));
      await expect(service.create(dto, 'admin', { draftId, actor })).rejects.toThrow('Receipt not confirmed');
      expect(txModel.create).not.toHaveBeenCalled();
      expect(vaultService.addSystemEntry).not.toHaveBeenCalled();
    });

    it('releases the confirmed receipt for retry if transaction persistence fails', async () => {
      txModel.create.mockRejectedValue(new Error('Database failed'));
      await expect(service.create(dto, 'admin', { draftId, actor })).rejects.toThrow('Database failed');
      expect(receiptService.releaseManualReceipt).toHaveBeenCalledWith(receipt.id);
      expect(vaultService.addSystemEntry).not.toHaveBeenCalled();
    });
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
      const selectFn = jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(txs) }),
      });
      txModel.find.mockReturnValue({ select: selectFn });
      const result = await service.findAll();
      expect(result).toHaveLength(2);
      expect(txModel.find).toHaveBeenCalledWith({ archived: { $ne: true } });
      // ⚠ الحقول التقيلة لازم تتشال من القوائم — كانت ٨٢٪ من حمولة الإقلاع.
      expect(selectFn).toHaveBeenCalledWith(
        expect.objectContaining({ bostaRawResponse: 0 }),
      );
    });

    /* ⚠ القفل الحقيقي على الإصلاح: القايمة **بتشيل** `bostaRawResponse` (٧.٢٦ ميجا
       من ٩.٤٥ على بيانات حقيقية)، لكن `findById` **بيرجّعه** — صفحة الفاتورة
       بتقراه في «مسار الطلب». لو حد شال الـprojection أو حطها على findById،
       واحد من دول هيقع. */
    it('excludes heavy raw fields from list reads but not from findById', async () => {
      const selectFn = jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
      });
      txModel.find.mockReturnValue({ select: selectFn });
      await service.findAll();
      const projection = selectFn.mock.calls[0][0];
      expect(projection).toEqual({
        bostaRawResponse: 0,
        bostaStatusIgnoredEvents: 0,
      });

      const tx = buildSaleTransaction();
      const execFn = jest.fn().mockResolvedValue(tx);
      txModel.findById.mockReturnValue({ exec: execFn, select: selectFn });
      await service.findById('507f1f77bcf86cd799439011');
      // مفيش projection على القراءة المفردة — الفاتورة محتاجة السجل كامل.
      expect(execFn).toHaveBeenCalled();
      expect(selectFn).toHaveBeenCalledTimes(1);
    });

    it('applies pagination when page and limit are provided', async () => {
      const skipFn = jest.fn().mockReturnThis();
      const limitFn = jest.fn().mockReturnThis();
      txModel.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          sort: jest.fn().mockReturnValue({
            skip: skipFn,
            limit: limitFn,
            exec: jest.fn().mockResolvedValue([]),
          }),
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

  /**
   * A Shopify sale confirmed with deposit receipts carries one deposit line per receipt, each in
   * the segment its money came into. Refunding the whole deposit from `depMethod` (what cancel did)
   * would take 800 out of Instapay when only 500 ever went in there.
   */
  describe('cancel() — a receipt deposit is refunded per vault', () => {
    function saleWithReceipts(overrides: Record<string, unknown> = {}) {
      const tx: any = buildSaleTransaction({
        _id: 'tx-dep-1',
        type: 'مبيعات',
        ref: '2719',
        client: 'هالة محمد',
        total: 1350,
        deposit: 800,
        remaining: 550,
        depMethod: 'Instapay',
        payment: 'Instapay',
        cancelled: false,
        deposits: [
          { id: 'r1', amount: 500, method: 'Instapay', note: '', date: '', by: 'أحمد', source: 'deposit-receipt', receiptId: 'r1' },
          { id: 'r2', amount: 300, method: 'كاش', note: '', date: '', by: 'رنا', source: 'deposit-receipt', receiptId: 'r2' },
        ],
        ...overrides,
      });
      tx.save = jest.fn().mockImplementation(async function (this: any) {
        return this;
      });
      return tx;
    }

    it('posts one refund per vault, never the whole deposit from depMethod', async () => {
      const tx = saleWithReceipts();
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      await service.cancel('tx-dep-1', { cancelReason: 'x', cancelledBy: 'admin' });
      const calls = vaultService.addSystemEntry.mock.calls.map((c: any[]) => [c[0], c[1]]);
      expect(calls).toEqual([
        [-500, 'Instapay'],
        [-300, 'كاش'],
      ]);
    });

    it('a deposit edited down after confirmation falls back to the single refund', async () => {
      const tx = saleWithReceipts({ deposit: 600, remaining: 750 });
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      await service.cancel('tx-dep-1', { cancelReason: 'x', cancelledBy: 'admin' });
      const calls = vaultService.addSystemEntry.mock.calls.map((c: any[]) => [c[0], c[1]]);
      expect(calls).toEqual([[-600, 'Instapay']]);
    });

    it('keeps a receipt sale live after a partial refund failure and resumes only the unpaid vault', async () => {
      const tx = saleWithReceipts();
      txModel.findById.mockReturnValue({exec:jest.fn().mockResolvedValue(tx)});
      vaultService.addSystemEntry.mockResolvedValueOnce({_id:'refund-1'} as any)
        .mockRejectedValueOnce(new Error('second vault failed'));
      await expect(service.cancel('tx-dep-1',{cancelReason:'x',cancelledBy:'admin'})).rejects.toThrow('second vault failed');
      expect(tx.cancelled).toBe(false);
      expect(tx.cancellationDepositRefunds).toEqual([expect.objectContaining({method:'Instapay',amount:500,vaultEntryId:'refund-1'})]);
      vaultService.addSystemEntry.mockClear();
      await service.cancel('tx-dep-1',{cancelReason:'x',cancelledBy:'admin'});
      expect(vaultService.addSystemEntry.mock.calls.map((c:any[])=>[c[0],c[1]])).toEqual([[-300,'كاش']]);
      expect(tx.cancelled).toBe(true);
    });

    it('a reversed receipt line is not refunded twice', async () => {
      const tx = saleWithReceipts({ deposit: 300, remaining: 1050 });
      tx.deposits[0].reversed = true;
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      await service.cancel('tx-dep-1', { cancelReason: 'x', cancelledBy: 'admin' });
      const calls = vaultService.addSystemEntry.mock.calls.map((c: any[]) => [c[0], c[1]]);
      expect(calls).toEqual([[-300, 'كاش']]);
    });
  });

  /**
   * The shipping carrier used to be a free-text NAME, and the three paths that create a sale
   * disagreed completely: the manual form required one, Shopify's approveOrder never wrote one at
   * all, and Bosta never read it — so an order labelled «Mylerz» could ship through Bosta with
   * nothing disagreeing, and the whole Shopify volume fell into the «غير محدد» bucket of the
   * shipping report. resolveCarrierForWrite is now the single place a carrier is validated and its
   * tariff frozen, so all three paths agree by construction.
   */
  describe('create() — carrier code and frozen tariff', () => {
    const saleDto = (over: Record<string, unknown> = {}) =>
      ({
        type: 'مبيعات',
        ref: '7100',
        items: [{ code: 'P001', name: 'p', qty: 1, price: 100, total: 100 }],
        date: '2026-08-28',
        employee: 'e',
        client: 'عميل',
        total: 100,
        deposit: 0,
        ...over,
      }) as any;

    const runCreate = async (dto: any) => {
      txModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      productsService.findAll.mockResolvedValue(mockProducts);
      txModel.create.mockImplementation((doc: any) =>
        Promise.resolve({ ...doc, _id: 'tx1', save: jest.fn() }),
      );
      try {
        await service.create(dto);
      } catch {
        // secondary side effects (vault, ledger) are not what these cases assert
      }
      return txModel.create.mock.calls.at(-1)?.[0];
    };

    it('stores the carrier code and derives shipCo from it', async () => {
      const written = await runCreate(saleDto({ carrierCode: 'bosta', shipZone: 'cairo', shipCost: 110 }));
      expect(written.carrierCode).toBe('bosta');
      // shipCo stays populated so every consumer that renders it verbatim keeps working.
      expect(written.shipCo).toBe('Bosta');
    });

    it('freezes the tariff with the zone, the price and when it was taken', async () => {
      const written = await runCreate(saleDto({ carrierCode: 'bosta', shipZone: 'cairo', shipCost: 110 }));
      expect(written.shipTariff).toMatchObject({ zone: 'cairo', price: 110, source: 'settings' });
      expect(typeof written.shipTariff.at).toBe('string');
    });

    // The point of `source`: an operator override must be visible in reports rather than being
    // indistinguishable from the configured tariff.
    it('marks an off-tariff amount as a manual override', async () => {
      const written = await runCreate(saleDto({ carrierCode: 'bosta', shipZone: 'cairo', shipCost: 400 }));
      expect(written.shipTariff).toMatchObject({ price: 400, source: 'manual' });
    });

    it('reads the price for the zone actually being shipped to', async () => {
      const written = await runCreate(saleDto({ carrierCode: 'mylerz', shipZone: 'gov', shipCost: 130 }));
      expect(written.shipTariff).toMatchObject({ zone: 'gov', price: 130, source: 'settings' });
    });

    // Additive, not a migration: a caller that still sends only the legacy free-text name keeps
    // working and gets a code resolved for it.
    it('resolves a legacy free-text company name to a code', async () => {
      const written = await runCreate(saleDto({ shipCo: 'Bosta', shipZone: 'cairo', shipCost: 110 }));
      expect(written.carrierCode).toBe('bosta');
    });

    // Dropping it would file the shipment under «غير محدد» with nobody aware; rejecting leaves the
    // operator on screen to fix it.
    it('rejects an unknown carrier code rather than silently dropping it', async () => {
      txModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      productsService.findAll.mockResolvedValue(mockProducts);
      await expect(service.create(saleDto({ carrierCode: 'aramex' }))).rejects.toThrow(
        BadRequestException,
      );
    });

    // An unrecognised NAME is different from an unrecognised code: the name is legacy data we
    // cannot reject, so the row is kept and bucketed as unspecified instead.
    it('keeps a sale whose legacy name matches nothing, with no code and no tariff', async () => {
      const written = await runCreate(saleDto({ shipCo: 'شركة قديمة', shipCost: 90 }));
      expect(written.carrierCode).toBe('');
      expect(written.shipTariff).toBeNull();
      expect(written.shipCo).toBe('شركة قديمة');
    });

    // A purchase has no outbound shipment; carrying a carrier would put supplier invoices into
    // the shipping report.
    it('never assigns a carrier to a purchase', async () => {
      const written = await runCreate(
        saleDto({ type: 'مشتريات', ref: '7200', carrierCode: 'bosta', shipCost: 110 }),
      );
      expect(written.carrierCode).toBe('');
      expect(written.shipTariff).toBeNull();
    });
  });

  /**
   * A Shopify order's shipping amount is what the CUSTOMER paid at checkout — it is not drawn
   * from any carrier tariff. Re-running the on/off-tariff comparison against it on every edit
   * would relabel it as an operator override and destroy the one signal reports use to spot
   * genuine off-tariff pricing.
   */
  describe('update() — the origin of a shipping price survives an edit', () => {
    const buildShopifySale = (over: Record<string, unknown> = {}): any => {
      const tx: any = buildSaleTransaction({
        _id: 'tx-ship-origin',
        type: 'مبيعات',
        ref: '7300',
        client: 'عميل',
        source: 'shopify',
        carrierCode: 'bosta',
        shipCo: 'Bosta',
        shipZone: 'cairo',
        // 120 from Shopify, against a configured Bosta/cairo tariff of 110.
        shipCost: 120,
        cancelled: false,
        editHistory: [],
        ...over,
      });
      tx.save = jest.fn().mockImplementation(async function (this: any) {
        return this;
      });
      tx.markModified = jest.fn();
      return tx;
    };

    const runUpdate = async (tx: any, dto: any) => {
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      txModel.findByIdAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      productsService.findAll.mockResolvedValue(mockProducts);
      try {
        await service.update(tx._id, dto, 'admin', '', 'admin');
      } catch {
        // secondary side effects are not what this asserts
      }
      return txModel.findByIdAndUpdate.mock.calls.at(-1)?.[1];
    };

    it('keeps source shopify when an unrelated field is edited', async () => {
      const written = await runUpdate(buildShopifySale(), { client: 'اسم جديد' } as any);
      expect(written.shipTariff).toMatchObject({ price: 120, source: 'shopify' });
    });

    it('does not invent a manual override for a Shopify price that differs from the tariff', async () => {
      const written = await runUpdate(buildShopifySale(), { notes: 'ملاحظة' } as any);
      expect(written.shipTariff.source).not.toBe('manual');
    });

    // The guard is scoped to Shopify orders — a manually entered sale must still report a genuine
    // override, or the signal disappears entirely.
    it('still flags a real override on a manually entered sale', async () => {
      const tx = buildShopifySale({ _id: 'tx-manual-origin', source: '', shipCost: 110 });
      const written = await runUpdate(tx, { shipCost: 400 } as any);
      expect(written.shipTariff).toMatchObject({ price: 400, source: 'manual' });
    });

    it('reports an on-tariff manual sale as settings', async () => {
      const tx = buildShopifySale({ _id: 'tx-manual-ok', source: '', shipCost: 110 });
      const written = await runUpdate(tx, { shipCost: 110 } as any);
      expect(written.shipTariff).toMatchObject({ price: 110, source: 'settings' });
    });
  });

  /**
   * The reports page answered "what isn't selling?" from `productProfits`, which is built only
   * from sold line items — so a product with zero sales could never appear in it, and the panel
   * silently showed the least-sold-but-still-sold products instead. `stagnantStock` starts from
   * inventory so that the invisible case is the one it reports.
   */
  describe('getReports — stagnant stock', () => {
    const REPORT_FROM = '2026-08-01';
    const REPORT_TO = '2026-08-08';

    const saleTx = (date: string, code: string, name: string, qty: number) =>
      ({
        type: 'مبيعات',
        ref: '9000',
        date,
        client: 'c',
        items: [{ code, name, qty, price: 100, total: 100 * qty }],
        itemsTotal: 100 * qty,
        total: 100 * qty,
        deposit: 0,
        remaining: 0,
        shipCost: 0,
        shipLoss: 0,
      }) as any;

    const runReports = async () => {
      productsService.findAll.mockResolvedValue(mockProducts);
      // One exec() mock backs both the getReports query and getInventory's own query, which is
      // what we want: they read the same collection.
      txModel.exec.mockResolvedValue([
        saleTx('2026-08-05', 'P001', 'منتج اختبار 1', 2),  // inside the period
        saleTx('2026-01-10', 'P003', 'منتج منخفض', 1),      // long before it
      ]);
      const r: any = await service.getReports(REPORT_FROM, REPORT_TO, 0);
      return r.stagnantStock;
    };

    it('reports a product with stock that has never been sold at all', async () => {
      const s = await runReports();
      const never = s.items.find((i: any) => i.code === 'P002');
      // P002 has no sales anywhere, so it is absent from productProfits by construction —
      // this is the row the old chart could not draw.
      expect(never).toBeDefined();
      expect(never.daysSinceSale).toBeNull();
      expect(never.lastSale).toBe('');
      expect(never.stock).toBe(30);
      expect(never.frozenValue).toBe(30 * 150);
      expect(s.neverSold).toBe(1);
    });

    it('excludes a product that moved inside the period', async () => {
      const s = await runReports();
      expect(s.items.some((i: any) => i.code === 'P001')).toBe(false);
    });

    it('includes a product whose only sale predates the period, dated from its lifetime history', async () => {
      const s = await runReports();
      const cold = s.items.find((i: any) => i.code === 'P003');
      expect(cold).toBeDefined();
      // «آخر بيع» must survive the from/to filter — scoping it to the period would report every
      // product as never-sold whenever the user picks a short range.
      expect(cold.lastSale).toBe('2026-01-10');
      expect(cold.daysSinceSale).toBeGreaterThan(150);
      expect(cold.stock).toBe(5 - 1);
    });

    it('excludes products holding no stock — they tie up no capital', async () => {
      const s = await runReports();
      expect(s.items.some((i: any) => i.code === 'P004')).toBe(false);
    });

    it('orders by capital at risk and totals every stagnant row', async () => {
      const s = await runReports();
      expect(s.items.map((i: any) => i.code)).toEqual(['P002', 'P003']);
      expect(s.count).toBe(2);
      expect(s.totalValue).toBe(30 * 150 + 4 * 300);
    });
  });

  /**
   * Cancelling a customer-return transaction used to leave its ReturnRequest at status 'معتمد'
   * forever, so getDashboard()/getReports() kept subtracting its value from net sales even though
   * the stock and the cash had both been given back. The supplier-return side has always guarded
   * against exactly this via `reversal`; the customer side had no equivalent.
   */
  describe('cancel() — customer return marks its ReturnRequest reversed', () => {
    function buildCustomerReturnTx(overrides: Record<string, unknown> = {}) {
      const tx: any = buildSaleTransaction({
        _id: 'tx-cust-ret-1',
        type: 'مرتجع',
        ref: '2254-RET',
        client: 'مريم أحمد',
        total: 100,
        deposit: 0,
        remaining: 0,
        depMethod: 'كاش',
        payment: 'كاش',
        cancelled: false,
        ...overrides,
      });
      tx.save = jest.fn().mockImplementation(async function (this: any) {
        return this;
      });
      return tx;
    }

    it('sets reversedAt on the linked request, matching by id or by ref', async () => {
      const tx = buildCustomerReturnTx();
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      returnModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: 'ret-1' }),
      });

      await service.cancel('tx-cust-ret-1', {
        cancelReason: 'خطأ في التسجيل',
        cancelledBy: 'admin',
      });

      expect(returnModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'معتمد',
          reversedAt: null,
          $or: [{ returnTxId: 'tx-cust-ret-1' }, { returnTxRef: '2254-RET' }],
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            reversedBy: 'admin',
            reversalReason: 'خطأ في التسجيل',
            reversedAt: expect.any(String),
          }),
        }),
      );
    });

    it('recognises a sequenced return ref (-RET-2) as a customer return', async () => {
      const tx = buildCustomerReturnTx({
        _id: 'tx-cust-ret-2',
        type: 'مشتريات',
        ref: '2254-RET-2',
      });
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      returnModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: 'ret-2' }),
      });

      await service.cancel('tx-cust-ret-2', {
        cancelReason: 'إلغاء',
        cancelledBy: 'admin',
      });

      expect(returnModel.findOneAndUpdate).toHaveBeenCalled();
    });

    it('does not touch ReturnRequest when cancelling an ordinary sale', async () => {
      const tx = buildCustomerReturnTx({
        _id: 'tx-sale-9',
        type: 'مبيعات',
        ref: '2255',
      });
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });

      await service.cancel('tx-sale-9', {
        cancelReason: 'إلغاء',
        cancelledBy: 'admin',
      });

      expect(returnModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('still completes the cancellation when flagging the request fails', async () => {
      const tx = buildCustomerReturnTx();
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      returnModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockRejectedValue(new Error('mongo down')),
      });

      // The money has already moved by this point — a failed back-reference update must not abort
      // the cancellation and leave the transaction half-cancelled.
      await expect(
        service.cancel('tx-cust-ret-1', { cancelReason: 'x', cancelledBy: 'admin' }),
      ).resolves.toBeDefined();
      expect(tx.cancelled).toBe(true);
    });
  });

  /**
   * A تالف unit is refunded to the customer but must never become sellable again. Both
   * derived-stock loops go through returnedItemQtyForStock; if they ever disagree, the oversell
   * guard and the inventory screen report different on-hand figures for the same product.
   */
  describe('getInventory() — damaged returns do not re-enter sellable stock', () => {
    beforeEach(() => {
      productsService.findAll.mockResolvedValue([
        { _id: 'p1', code: 'P001', name: 'سجادة', sellPrice: 100, buyPrice: 60, minStock: 5, openingBalance: 10 },
      ]);
    });

    function stubTxs(rows: any[]) {
      txModel.find.mockReturnValue({ exec: jest.fn().mockResolvedValue(rows) });
    }

    it('adds a سليم return back to stock', async () => {
      stubTxs([
        { type: 'مبيعات', ref: '2254', date: '2026-08-01', items: [{ code: 'P001', qty: 4 }] },
        {
          type: 'مرتجع',
          ref: '2254-RET',
          date: '2026-08-02',
          items: [{ code: 'P001', qty: 2, condition: 'سليم' }],
        },
      ]);
      const inv = await service.getInventory();
      // 10 opening − 4 sold + 2 returned
      expect(inv[0].current).toBe(8);
      expect(inv[0].returnsToStock).toBe(2);
    });

    it('does NOT add a تالف return back to stock', async () => {
      stubTxs([
        { type: 'مبيعات', ref: '2254', date: '2026-08-01', items: [{ code: 'P001', qty: 4 }] },
        {
          type: 'مرتجع',
          ref: '2254-RET',
          date: '2026-08-02',
          items: [{ code: 'P001', qty: 2, condition: 'تالف' }],
        },
      ]);
      const inv = await service.getInventory();
      expect(inv[0].current).toBe(6);
      expect(inv[0].returnsToStock).toBe(0);
    });

    it('counts only the سليم units of a mixed-condition return', async () => {
      stubTxs([
        { type: 'مبيعات', ref: '2254', date: '2026-08-01', items: [{ code: 'P001', qty: 5 }] },
        {
          type: 'مرتجع',
          ref: '2254-RET',
          date: '2026-08-02',
          items: [
            { code: 'P001', qty: 2, condition: 'سليم' },
            { code: 'P001', qty: 1, condition: 'تالف' },
          ],
        },
      ]);
      const inv = await service.getInventory();
      expect(inv[0].returnsToStock).toBe(2);
      expect(inv[0].current).toBe(7);
    });

    it('treats a missing condition as سليم, so pre-existing returns keep their behaviour', async () => {
      stubTxs([
        { type: 'مبيعات', ref: '2254', date: '2026-08-01', items: [{ code: 'P001', qty: 3 }] },
        {
          type: 'مرتجع',
          ref: '2254-RET',
          date: '2026-08-02',
          items: [{ code: 'P001', qty: 3 }],
        },
      ]);
      const inv = await service.getInventory();
      expect(inv[0].returnsToStock).toBe(3);
      expect(inv[0].current).toBe(10);
    });
  });

  /**
   * Guards the query shape rather than the arithmetic: the defect was that `status: 'معتمد'` alone
   * kept reversed returns in the aggregate, because a reversed return keeps that status.
   */
  describe('report queries exclude reversed returns', () => {
    it('filters getDashboard() approved returns on reversedAt', async () => {
      productsService.findAll.mockResolvedValue([]);
      // getDashboard() also does .find().sort().limit().exec() for recent transactions, so this
      // stub has to stay chainable — returning a bare { exec } breaks that second call.
      const chain: any = { exec: jest.fn().mockResolvedValue([]) };
      chain.sort = jest.fn().mockReturnValue(chain);
      chain.limit = jest.fn().mockReturnValue(chain);
      txModel.find.mockReturnValue(chain);
      returnModel.find.mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });
      supplierReturnModel.find.mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });

      await service.getDashboard();

      expect(returnModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'معتمد',
          $or: [{ reversedAt: null }, { reversedAt: { $exists: false } }],
        }),
      );
    });
  });

  /**
   * Undoing a purchase payment must reverse BOTH sides — the vault entry and the supplier-ledger
   * 'payment' entry. Reversing only the vault (the original behaviour) left the payment deducted
   * from the supplier balance forever, understating the payable. That defect produced a real
   * 2,862 ج discrepancy against a supplier statement which had to be corrected by hand.
   */
  describe('undoSpecificPayment — supplier ledger reversal', () => {
    function buildPaidPurchase(overrides: Record<string, unknown> = {}): any {
      const tx: any = buildSaleTransaction({
        _id: 'tx-purchase-undo',
        type: 'مشتريات',
        ref: '010',
        client: 'Talla Home',
        supplierId: 's1',
        total: 38440,
        deposit: 38440,
        remaining: 0,
        payStatus: 'مكتمل',
        cancelled: false,
        payments: [
          { id: 'pay_1', amount: 14882, method: 'instapay', reversed: false },
        ],
        deposits: [],
        ...overrides,
      });
      tx.__v = 0;
      tx.set = jest.fn();
      tx.markModified = jest.fn();
      tx.save = jest.fn().mockImplementation(async function (this: any) {
        return this;
      });
      return tx;
    }

    /**
     * findById is consumed twice with different shapes: `.exec()` by undoSpecificPayment itself,
     * and `.select('__v').lean().exec()` by saveWithVersion's optimistic-lock check. Return a
     * matching __v so the lock passes and the undo reaches the ledger reversal under test.
     */
    function mockFindByIdFor(tx: any) {
      txModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(tx),
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue({ __v: tx.__v }),
          }),
        }),
      });
    }

    it('reverses the matching supplier-ledger payment entry when a purchase payment is undone', async () => {
      const tx = buildPaidPurchase();
      mockFindByIdFor(tx);
      supplierLedgerService.findBySupplier.mockResolvedValue([
        {
          _id: 'led-1',
          sourceType: 'transaction',
          sourceId: 'tx-purchase-undo',
          entryType: 'payment',
          reversed: false,
        },
      ]);

      await service.undoSpecificPayment('tx-purchase-undo', 'pay_1', 'admin', 'تم بالخطأ', 'admin');

      expect(supplierLedgerService.reverseEntry).toHaveBeenCalledWith(
        'led-1',
        'admin',
        expect.stringContaining('تراجع عن دفعة'),
      );
    });

    it('skips ledger entries already reversed, so a re-undo cannot double-reverse', async () => {
      const tx = buildPaidPurchase();
      mockFindByIdFor(tx);
      supplierLedgerService.findBySupplier.mockResolvedValue([
        {
          _id: 'led-1',
          sourceType: 'transaction',
          sourceId: 'tx-purchase-undo',
          entryType: 'payment',
          reversed: true,
        },
      ]);

      await service.undoSpecificPayment('tx-purchase-undo', 'pay_1', 'admin', undefined, 'admin');

      expect(supplierLedgerService.reverseEntry).not.toHaveBeenCalled();
    });

    it('does not touch the supplier ledger when undoing a SALES payment', async () => {
      const tx = buildPaidPurchase({ type: 'مبيعات', client: 'عميل' });
      mockFindByIdFor(tx);

      await service.undoSpecificPayment('tx-purchase-undo', 'pay_1', 'admin', undefined, 'admin');

      expect(supplierLedgerService.reverseEntry).not.toHaveBeenCalled();
    });

    it('still completes the undo when the ledger reversal throws (vault must not roll back)', async () => {
      const tx = buildPaidPurchase();
      mockFindByIdFor(tx);
      supplierLedgerService.findBySupplier.mockResolvedValue([
        {
          _id: 'led-1',
          sourceType: 'transaction',
          sourceId: 'tx-purchase-undo',
          entryType: 'payment',
          reversed: false,
        },
      ]);
      supplierLedgerService.reverseEntry.mockRejectedValue(new Error('ledger down'));

      await expect(
        service.undoSpecificPayment('tx-purchase-undo', 'pay_1', 'admin', undefined, 'admin'),
      ).resolves.toEqual(expect.objectContaining({ reversedAmount: 14882 }));
    });

    /* Authorization split (Aug 7, 2026). Reversing a PURCHASE payment is delegable via
       `suppliers-reverse`; a sales collection reversal stays admin-only. Both halves are asserted
       because the route decorator alone cannot tell the two apart — it sees no transaction. */
    it('rejects a purchase-payment undo from a caller without suppliers-reverse', async () => {
      mockFindByIdFor(buildPaidPurchase());
      await expect(
        service.undoSpecificPayment('tx-purchase-undo', 'pay_1', 'staff', undefined, 'staff', []),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows a purchase-payment undo when the caller holds suppliers-reverse', async () => {
      mockFindByIdFor(buildPaidPurchase());
      await expect(
        service.undoSpecificPayment('tx-purchase-undo', 'pay_1', 'staff', undefined, 'staff', [
          'suppliers-reverse',
        ]),
      ).resolves.toEqual(expect.objectContaining({ reversedAmount: 14882 }));
    });

    it('still refuses a SALES collection undo to a suppliers-reverse holder', async () => {
      mockFindByIdFor(buildPaidPurchase({ type: 'مبيعات', supplierId: undefined }));
      await expect(
        service.undoSpecificPayment('tx-purchase-undo', 'pay_1', 'staff', undefined, 'staff', [
          'suppliers-reverse',
        ]),
      ).rejects.toThrow(ForbiddenException);
    });
  });
  /**
   * collect() authorization (Aug 7, 2026). Paying a supplier moves cash out of a vault and this
   * endpoint had NO authorization check of any kind — any authenticated user could settle any
   * purchase invoice. It cannot be a route-level @RequirePerms because the same endpoint collects
   * from CUSTOMERS; only the loaded transaction distinguishes the two, so the rule lives here.
   */
  describe('collect() — supplier payment authorization', () => {
    function buildOpenPurchase(overrides: Record<string, unknown> = {}): any {
      const tx: any = buildSaleTransaction({
        _id: 'tx-collect-perm',
        type: 'مشتريات',
        ref: '900',
        supplierId: 's1',
        total: 5000,
        deposit: 0,
        remaining: 5000,
        payStatus: 'معلق',
        cancelled: false,
        payments: [],
        deposits: [],
        ...overrides,
      });
      tx.__v = 0;
      tx.set = jest.fn();
      tx.markModified = jest.fn();
      tx.save = jest.fn().mockImplementation(async function (this: any) { return this; });
      return tx;
    }
    function mockFindById(tx: any) {
      txModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(tx),
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ __v: tx.__v }) }),
        }),
      });
    }
    const dto: any = { collectMethod: 'كاش', collectAmount: 1000 };

    it('refuses a purchase collection from a caller without suppliers-pay', async () => {
      mockFindById(buildOpenPurchase());
      await expect(
        service.collect('tx-collect-perm', dto, 'staff', 'staff', []),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses before touching the vault', async () => {
      mockFindById(buildOpenPurchase());
      await service.collect('tx-collect-perm', dto, 'staff', 'staff', []).catch(() => undefined);
      expect(vaultService.assertSufficientBalance).not.toHaveBeenCalled();
    });

    it('lets an admin through unchanged', async () => {
      mockFindById(buildOpenPurchase());
      await expect(
        service.collect('tx-collect-perm', dto, 'admin', 'admin', []),
      ).resolves.toBeDefined();
    });
  });

  /**
   * The edit lock is a fulfillment rule, not a payment one. A prepaid sale is
   * payStatus 'مكتمل' from the first minute; if that blocked editing, the orders
   * most likely to still need a correction would be the ones locked.
   */
  describe('update() — edit lock follows fulfillment, not payment status', () => {
    function buildPaidSale(overrides: Record<string, unknown> = {}): any {
      const tx: any = buildSaleTransaction({
        _id: 'tx-edit-gate',
        type: 'مبيعات',
        ref: '2254',
        total: 1000,
        deposit: 1000,
        remaining: 0,
        payStatus: 'مكتمل', // مدفوعة بالكامل
        cancelled: false,
        pickupStatus: 'Pending',
        bostaStatus: '',
        deliverySource: '',
        items: [],
        editHistory: [],
        ...overrides,
      });
      tx.save = jest.fn().mockImplementation(async function (this: any) { return this; });
      tx.markModified = jest.fn();
      return tx;
    }
    function mockUpdatable(tx: any) {
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      txModel.findByIdAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(tx),
      });
    }

    it('allows editing a fully-paid sale that has not shipped yet', async () => {
      mockUpdatable(buildPaidSale());
      await expect(
        service.update('tx-edit-gate', { notes: 'تعديل' } as any, 'staff', '', 'staff'),
      ).resolves.toBeDefined();
    });

    it('allows editing when a Bosta shipment exists but is only CREATED', async () => {
      // الشحنة اتسجلت بس البضاعة لسه في المخزن
      mockUpdatable(buildPaidSale({ bostaStatus: 'CREATED' }));
      await expect(
        service.update('tx-edit-gate', { notes: 'تعديل' } as any, 'staff', '', 'staff'),
      ).resolves.toBeDefined();
    });

    it('blocks staff once the order is out with the courier', async () => {
      mockUpdatable(buildPaidSale({ bostaStatus: 'IN_TRANSIT' }));
      await expect(
        service.update('tx-edit-gate', { notes: 'تعديل' } as any, 'staff', '', 'staff'),
      ).rejects.toThrow(BadRequestException);
    });

    it('lets an admin edit an in-transit order', async () => {
      mockUpdatable(buildPaidSale({ bostaStatus: 'OUT_FOR_DELIVERY' }));
      await expect(
        service.update('tx-edit-gate', { notes: 'تعديل' } as any, 'admin', '', 'admin'),
      ).resolves.toBeDefined();
    });

    it('blocks a delivered order even for an admin', async () => {
      mockUpdatable(buildPaidSale({ bostaStatus: 'DELIVERED' }));
      await expect(
        service.update('tx-edit-gate', { notes: 'تعديل' } as any, 'admin', '', 'admin'),
      ).rejects.toThrow(BadRequestException);
    });

    it('blocks a pickup order handed to the courier (Picked-Up) even for an admin', async () => {
      // 'Picked-Up' هنا = خرجت من إيدنا — عكس Bosta PICKED_UP
      mockUpdatable(buildPaidSale({ pickupStatus: 'Picked-Up' }));
      await expect(
        service.update('tx-edit-gate', { notes: 'تعديل' } as any, 'admin', '', 'admin'),
      ).rejects.toThrow(BadRequestException);
    });

    it('blocks a pickup order already delivered, for an admin too', async () => {
      mockUpdatable(buildPaidSale({ pickupStatus: 'Delivered' }));
      await expect(
        service.update('tx-edit-gate', { notes: 'تعديل' } as any, 'admin', '', 'admin'),
      ).rejects.toThrow(BadRequestException);
    });

    /**
     * Regression — invoice #33223. Every edit row was stamped type 'مبيعات', including the
     * ones that RETURN stock (a removed line), producing «بيع +1» — a sale that increased
     * stock. The quantities were always right; only the label contradicted them.
     */
    describe('inventory movement log — edit rows are stock adjustments', () => {
      async function editLinesAndGetEntries(
        before: Array<{ code: string; qty: number }>,
        after: Array<{ code: string; qty: number }>,
        stockAfterEdit: Record<string, number>,
        txOverrides: Record<string, unknown> = {},
      ) {
        const tx = buildPaidSale({
          items: before.map((i) => ({ ...i, name: i.code, price: 10, total: i.qty * 10 })),
          ...txOverrides,
        });
        mockUpdatable(tx);
        // getInventory() runs AFTER the write, so it reports post-edit stock.
        jest.spyOn(service, 'getInventory').mockResolvedValue(
          Object.entries(stockAfterEdit).map(([code, current]) => ({
            _id: 'p-' + code, code, name: code, current,
          })) as any,
        );
        // The oversell guard runs before the log; give it ample stock so it never fires.
        jest
          .spyOn(service as any, 'getAvailableQtyByProductCode')
          .mockResolvedValue(
            new Map([...before, ...after].map((i) => [i.code, 9999] as [string, number])),
          );
        inventoryMovementsService.record.mockClear();
        await service.update(
          'tx-edit-gate',
          { items: after.map((i) => ({ ...i, name: i.code, price: 10, total: i.qty * 10 })) } as any,
          'FARES',
          '',
          'admin',
        );
        return (inventoryMovementsService.record.mock.calls[0]?.[0] || []) as any[];
      }

      // بند ثابت (KEEP) قبل وبعد — الفاتورة لا تصبح بلا أصناف، و lineDelta له = 0 فلا يُسجَّل.
      const removedLine = () =>
        editLinesAndGetEntries(
          [{ code: 'Code 06', qty: 1 }, { code: 'KEEP', qty: 1 }],
          [{ code: 'KEEP', qty: 1 }],
          { 'Code 06': 3, KEEP: 1 },
        );

      it("never labels an edit row 'مبيعات' — a removed line would read as a sale that ADDED stock", async () => {
        const rows = await removedLine();
        const row = rows.find((e) => e.productCode === 'Code 06');
        expect(row.qtyDelta).toBeGreaterThan(0); // البضاعة رجعت للمخزن
        expect(row.type).not.toBe('مبيعات');
        expect(row.type).toBe('تسوية مخزون');
      });

      it('labels an added line as a stock adjustment too, so one filter finds both halves', async () => {
        const rows = await editLinesAndGetEntries(
          [{ code: 'KEEP', qty: 1 }],
          [{ code: 'KEEP', qty: 1 }, { code: 'BAG-COC2', qty: 5 }],
          { 'BAG-COC2': 0, KEEP: 1 },
        );
        const row = rows.find((e) => e.productCode === 'BAG-COC2');
        expect(row.qtyDelta).toBe(-5); // 5 قطع خرجت من المخزن
        expect(row.type).toBe('تسوية مخزون');
      });

      it('uses the adjustment type for purchases as well, not مشتريات', async () => {
        const rows = await editLinesAndGetEntries(
          [{ code: 'KEEP', qty: 1 }],
          [{ code: 'KEEP', qty: 1 }, { code: 'Code 06', qty: 4 }],
          { 'Code 06': 9, KEEP: 1 },
          { type: 'مشتريات', ref: '901', supplierId: 's1' },
        );
        const row = rows.find((e) => e.productCode === 'Code 06');
        expect(row.qtyDelta).toBe(4); // شراء إضافي يزيد المخزون
        expect(row.type).toBe('تسوية مخزون');
      });

      it('keeps the direction of every quantity unchanged', async () => {
        const rows = await removedLine();
        const row = rows.find((e) => e.productCode === 'Code 06');
        expect(row.qtyDelta).toBe(1);
        expect(row.qtyBefore).toBe(2);
        expect(row.qtyAfter).toBe(3);
      });

      it('stores the note as old ← new; RTL ordering is a display concern, not a data one', async () => {
        const rows = await removedLine();
        const row = rows.find((e) => e.productCode === 'Code 06');
        expect(row.notes).toBe('تعديل بنود المعاملة: 1 ← 0');
      });

      it('keeps qtyBefore/qtyAfter consistent with qtyDelta', async () => {
        const rows = await removedLine();
        for (const e of rows) expect(e.qtyBefore + e.qtyDelta).toBe(e.qtyAfter);
      });
    });

    it('does not apply the shipping rule to purchases', async () => {
      // المشتريات ليس لها مسار شحن للعميل — القاعدة لا تخصها
      mockUpdatable(
        buildPaidSale({ type: 'مشتريات', ref: '901', bostaStatus: 'DELIVERED' }),
      );
      await expect(
        service.update('tx-edit-gate', { notes: 'تعديل' } as any, 'staff', '', 'staff'),
      ).resolves.toBeDefined();
    });
  });

  /**
   * تسوية المخزون اليدوية — الحركة يجب أن تُحرّك المخزون فعلاً.
   *
   * قبل هذا الإصلاح كان adjustStock يكتب صفاً في سجل الحركات فقط، والمخزون مشتقّ من
   * المعاملات ولا يقرأ ذلك السجل — فلا يتغيّر الرقم إطلاقاً. الحالة التراكمية أدناه هي
   * التي تكشف العيب: التسوية الأولى وحدها تبدو صحيحة في الصف المكتوب، والثانية هي التي
   * تفضح أن الأولى لم تصل إلى الرصيد.
   */
  describe('getInventory — manual stock adjustments (تسوية مخزون)', () => {
    beforeEach(() => {
      productsService.findAll.mockResolvedValue([
        { _id: 'p1', code: 'P001', name: 'سجادة', sellPrice: 100, buyPrice: 60, minStock: 5, openingBalance: 10 },
      ]);
      txModel.find.mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });
    });

    it('adds a positive adjustment to current stock', async () => {
      inventoryMovementsService.getManualAdjustmentQtyByProductCode.mockResolvedValue(
        new Map([['P001', 3]]),
      );
      const inv = await service.getInventory();
      expect(inv[0].current).toBe(13); // 10 افتتاحي + 3 تسوية
      expect(inv[0].adjustments).toBe(3);
    });

    it('subtracts a negative adjustment (stock written down)', async () => {
      inventoryMovementsService.getManualAdjustmentQtyByProductCode.mockResolvedValue(
        new Map([['P001', -4]]),
      );
      const inv = await service.getInventory();
      expect(inv[0].current).toBe(6);
      expect(inv[0].adjustments).toBe(-4);
    });

    it('accumulates successive adjustments — the case the old code silently erased', async () => {
      // مجموع التسويات هو ما يُقرأ، لا آخر صف: +3 ثم −5 = −2
      inventoryMovementsService.getManualAdjustmentQtyByProductCode.mockResolvedValue(
        new Map([['P001', -2]]),
      );
      const inv = await service.getInventory();
      expect(inv[0].current).toBe(8);
    });

    it('combines adjustments with transaction-derived movement', async () => {
      txModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          { type: 'مبيعات', ref: '2254', date: '2026-08-01', items: [{ code: 'P001', qty: 4 }] },
        ]),
      });
      inventoryMovementsService.getManualAdjustmentQtyByProductCode.mockResolvedValue(
        new Map([['P001', 2]]),
      );
      const inv = await service.getInventory();
      expect(inv[0].current).toBe(8); // 10 − 4 مبيعات + 2 تسوية
    });

    it('leaves products with no adjustment untouched', async () => {
      inventoryMovementsService.getManualAdjustmentQtyByProductCode.mockResolvedValue(
        new Map([['P999', 99]]),
      );
      const inv = await service.getInventory();
      expect(inv[0].current).toBe(10);
      expect(inv[0].adjustments).toBe(0);
    });
  });

  /**
   * انحدار — مشتريات #900001 (12–13 أغسطس 2026).
   *
   * فاتورة أُنشئت بإجمالي 0، فحُفظت `payStatus: 'مكتمل'` لأن
   * `remaining = max(0, 0 - 0) = 0` — لا لأن أحداً دفع. ثم عُدِّل إجماليها
   * إلى 7,940 فخصم النظام 7,940 من الخزنة مقابل دفعة **لم تحدث**، بينما ظلّت
   * الفاتورة نفسها تقول `deposit = 0` و`remaining = 7,940` أي دَيْن كامل للمورد.
   *
   * القاعدة المثبَّتة هنا: الخزنة تتحرك بمقدار فرق **السداد الفعلي** (`deposit`)،
   * لا فرق الإجمالي، ولا استناداً إلى `payStatus`.
   */
  describe('update() — vault follows cash actually settled, never payStatus', () => {
    function buildInvoice(overrides: Record<string, unknown> = {}): any {
      const tx: any = buildSaleTransaction({
        _id: 'tx-cash-rule',
        type: 'مشتريات',
        ref: '900001',
        client: 'Talla Home',
        supplierId: 'sup-talla', // صريح: يجعل قيد سجل المديونية قابلاً للتحقق دون مطابقة بالاسم
        total: 0,
        deposit: 0,
        remaining: 0,
        payStatus: 'مكتمل',
        depMethod: 'كاش',
        payment: 'كاش',
        cancelled: false,
        pickupStatus: 'Pending',
        bostaStatus: '',
        items: [],
        editHistory: [],
        ...overrides,
      });
      tx.save = jest.fn().mockImplementation(async function (this: any) {
        return this;
      });
      tx.markModified = jest.fn();
      return tx;
    }
    function mockUpdatable(tx: any) {
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      txModel.findByIdAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(tx),
      });
    }
    /** القيود المكتوبة على الخزنة من هذا التعديل فقط. */
    function vaultAmounts(): number[] {
      return vaultService.addSystemEntry.mock.calls.map(
        (c: unknown[]) => c[0] as number,
      );
    }

    it('الحادثة نفسها: إجمالي 0 ← 7,940 بلا سداد لا يمس الخزنة إطلاقاً', async () => {
      mockUpdatable(buildInvoice());
      await service.update(
        'tx-cash-rule',
        { total: 7940, deposit: 0 } as any,
        'Fares',
        '',
        'admin',
      );
      expect(vaultService.addSystemEntry).not.toHaveBeenCalled();
    });

    it('يقيّد الفرق كدَيْن على المورد لا كنقد خارج من الخزنة', async () => {
      mockUpdatable(buildInvoice());
      await service.update(
        'tx-cash-rule',
        { total: 7940, deposit: 0 } as any,
        'Fares',
        '',
        'admin',
      );
      // 7,940 بالكامل تذهب إلى سجل المديونية — وهي القيمة الصحيحة محاسبياً.
      expect(supplierLedgerService.postManualAdjustment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 7940 }),
      );
    });

    it('يصحّح payStatus المضلِّل فيصبح «معلق» بعد التعديل', async () => {
      const tx = buildInvoice();
      mockUpdatable(tx);
      await service.update(
        'tx-cash-rule',
        { total: 7940, deposit: 0 } as any,
        'Fares',
        '',
        'admin',
      );
      expect(tx.remaining).toBe(7940);
      expect(tx.payStatus).toBe('معلق');
    });

    it('السداد الفعلي وحده هو ما يخرج من الخزنة (0 ← 3,000 على إجمالي 7,940)', async () => {
      mockUpdatable(buildInvoice());
      await service.update(
        'tx-cash-rule',
        { total: 7940, deposit: 3000 } as any,
        'Fares',
        '',
        'admin',
      );
      expect(vaultAmounts()).toEqual([-3000]); // سالب = خروج نقد للمورد
    });

    it('رفع إجمالي فاتورة مسدَّدة بالكامل دون سداد جديد لا يخصم شيئاً', async () => {
      // 5,000 مدفوعة فعلاً؛ الإجمالي يرتفع إلى 6,000 — الفرق دَيْن، لا نقد.
      mockUpdatable(
        buildInvoice({ total: 5000, deposit: 5000, remaining: 0, payStatus: 'مكتمل' }),
      );
      await service.update(
        'tx-cash-rule',
        { total: 6000, deposit: 5000 } as any,
        'Fares',
        '',
        'admin',
      );
      expect(vaultService.addSystemEntry).not.toHaveBeenCalled();
      expect(supplierLedgerService.postManualAdjustment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 1000 }),
      );
    });

    it('تخفيض إجمالي فاتورة مسدَّدة بالكامل يرد الفائض للخزنة', async () => {
      // دُفع 5,000 ثم صار الإجمالي 4,000 → 1,000 تعود فعلاً إلى الخزنة.
      mockUpdatable(
        buildInvoice({ total: 5000, deposit: 5000, remaining: 0, payStatus: 'مكتمل' }),
      );
      await service.update(
        'tx-cash-rule',
        { total: 4000, deposit: 5000 } as any,
        'Fares',
        '',
        'admin',
      );
      expect(vaultAmounts()).toEqual([1000]); // موجب = رجوع نقد للخزنة
    });

    it('المبيعات: إجمالي 0 ← 5,000 بلا تحصيل لا يضيف نقداً وهمياً', async () => {
      mockUpdatable(buildInvoice({ type: 'مبيعات', ref: '2254' }));
      await service.update(
        'tx-cash-rule',
        { total: 5000, deposit: 0 } as any,
        'Fares',
        '',
        'admin',
      );
      expect(vaultService.addSystemEntry).not.toHaveBeenCalled();
    });

    it('المبيعات: التحصيل الفعلي يدخل الخزنة بإشارة موجبة', async () => {
      mockUpdatable(buildInvoice({ type: 'مبيعات', ref: '2254' }));
      await service.update(
        'tx-cash-rule',
        { total: 5000, deposit: 2000 } as any,
        'Fares',
        '',
        'admin',
      );
      expect(vaultAmounts()).toEqual([2000]);
    });

    it('تعديل لا يمس المال (ملاحظات فقط) لا يكتب أي قيد', async () => {
      mockUpdatable(
        buildInvoice({ total: 7940, deposit: 7940, remaining: 0, payStatus: 'مكتمل' }),
      );
      await service.update(
        'tx-cash-rule',
        { notes: 'تعديل وصف فقط' } as any,
        'Fares',
        '',
        'admin',
      );
      expect(vaultService.addSystemEntry).not.toHaveBeenCalled();
    });

    /**
     * تصحيح خزنة العربون: العربون سُجِّل على خزنة خاطئة والمبلغ نفسه لم يتغير.
     * قبل الإصلاح كان `depositDelta === 0` يُسقط أي قيد، فتبقى الخزنة الأولى
     * مدينة بمال ليس فيها والثانية ناقصة — بلا أي أثر في الواجهة.
     */
    function buildSale(overrides: Record<string, unknown> = {}): any {
      const tx: any = buildInvoice({
        type: 'مبيعات',
        ref: '2408',
        client: 'Ghadeer Alnajjar',
        supplierId: '',
        total: 1650,
        deposit: 500,
        remaining: 1150,
        payStatus: 'معلق',
        depMethod: 'Instapay',
        payment: 'Instapay',
        deposits: [{ id: 'd1', amount: 500, method: 'Instapay', note: 'ديبوزت أول' }],
        ...overrides,
      });
      return tx;
    }
    /** [amount, method] لكل قيد خزنة. */
    function vaultMoves(): Array<[number, string]> {
      return vaultService.addSystemEntry.mock.calls.map(
        (c: unknown[]) => [c[0] as number, c[1] as string],
      );
    }

    function receiptSale() {
      return buildSale({total:2450,deposit:1300,remaining:1150,depMethod:'فودافون كاش',
        deposits:[{id:'r1',amount:500,method:'Instapay',source:'deposit-receipt'},
          {id:'r2',amount:800,method:'فودافون كاش',source:'deposit-receipt'}],
        depositReceipts:[{id:'r1',amount:500,method:'Instapay',imageKey:'receipts/one',vaultTxNo:'V1'},
          {id:'r2',amount:800,method:'فودافون كاش',imageKey:'receipts/two',vaultTxNo:'V2'}]});
    }
    function mockReceiptCorrection(tx: any, failPersist=false) {
      mockUpdatable(tx);
      txModel.findOneAndUpdate.mockImplementation((_filter: any, update: any)=>({exec:jest.fn(async()=>{
        if(failPersist) return null;
        Object.assign(tx,update);return tx;
      })}) as any);
    }
    it('corrects only the selected receipt vault and preserves both amounts and receipt images', async()=>{
      const tx=receiptSale();mockReceiptCorrection(tx);
      await service.update('tx-cash-rule',{depositVaultCorrections:[{id:'r1',method:'كاش'}]} as any,'Tester','','admin');
      expect(vaultMoves()).toEqual([[-500,'Instapay'],[500,'كاش']]);
      expect(tx.deposit).toBe(1300);expect(tx.remaining).toBe(1150);
      expect(tx.deposits.map((d: any)=>[d.amount,d.method])).toEqual([[500,'كاش'],[800,'فودافون كاش']]);
      expect(tx.depositReceipts[0]).toMatchObject({amount:500,method:'كاش',imageKey:'receipts/one',vaultTxNo:'V1'});
      expect(tx.depMethod).toBe('فودافون كاش');
      expect(tx.editHistory.at(-1).changes.join(' ')).toContain('r1');
      expect(txModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });
    it('corrects multiple receipt vaults independently',async()=>{
      const tx=receiptSale();mockReceiptCorrection(tx);
      await service.update('tx-cash-rule',{depositVaultCorrections:[{id:'r1',method:'كاش'},{id:'r2',method:'تحويل بنكي'}]} as any,'Tester','','admin');
      expect(vaultMoves()).toEqual([[-500,'Instapay'],[500,'كاش'],[-800,'فودافون كاش'],[800,'تحويل بنكي']]);
      expect(tx.depMethod).toBe('تحويل بنكي');expect(tx.deposit).toBe(1300);
    });
    it.each([
      {deposit:1400}, {depMethod:'كاش'},
      {depositVaultCorrections:[{id:'missing',method:'كاش'}]},
      {depositVaultCorrections:[{id:'r1',method:'unknown'}]},
      {depositVaultCorrections:[{id:'r1',method:'كاش'},{id:'r1',method:'كاش'}]},
      {total:2600,depositVaultCorrections:[{id:'r1',method:'كاش'}]},
    ])('rejects invalid receipt corrections before any ledger change: %j',async dto=>{
      mockReceiptCorrection(receiptSale());
      await expect(service.update('tx-cash-rule',dto as any,'Tester','','admin')).rejects.toThrow(BadRequestException);
      expect(vaultMoves()).toEqual([]);expect(txModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
    it('does not transfer funds when receipt vault is unchanged',async()=>{
      mockReceiptCorrection(receiptSale());
      await service.update('tx-cash-rule',{depositVaultCorrections:[{id:'r1',method:'Instapay'}]} as any,'Tester','','admin');
      expect(vaultMoves()).toEqual([]);
    });
    it('restores the original vault if the destination credit fails',async()=>{
      const tx=receiptSale();mockReceiptCorrection(tx);
      vaultService.addSystemEntry.mockResolvedValueOnce({} as any).mockRejectedValueOnce(new Error('credit failed')).mockResolvedValueOnce({} as any);
      await expect(service.update('tx-cash-rule',{depositVaultCorrections:[{id:'r1',method:'كاش'}]} as any,'Tester','','admin')).rejects.toThrow('credit failed');
      expect(vaultMoves()).toEqual([[-500,'Instapay'],[500,'كاش'],[500,'Instapay']]);
      expect(tx.deposits[0].method).toBe('Instapay');expect(txModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
    it('reverses ledger transfers when the invoice changes concurrently',async()=>{
      const tx=receiptSale();mockReceiptCorrection(tx,true);
      await expect(service.update('tx-cash-rule',{depositVaultCorrections:[{id:'r1',method:'كاش'}]} as any,'Tester','','admin')).rejects.toThrow('تغيّرت الفاتورة');
      expect(vaultMoves()).toEqual([[-500,'Instapay'],[500,'كاش'],[-500,'كاش'],[500,'Instapay']]);
      expect(tx.deposits[0].method).toBe('Instapay');
    });

    it('تغيير خزنة العربون وحده ينقل المال بقيدين متقابلين', async () => {
      mockUpdatable(buildSale());
      await service.update(
        'tx-cash-rule',
        { depMethod: 'فودافون كاش' } as any,
        'Fares',
        '',
        'admin',
      );
      expect(vaultMoves()).toEqual([
        [-500, 'Instapay'],
        [500, 'فودافون كاش'],
      ]);
    });

    it('السحب من الخزنة القديمة يسبق الإيداع — وإلا تضاعف المال عند فشل السحب', async () => {
      mockUpdatable(buildSale());
      await service.update(
        'tx-cash-rule',
        { depMethod: 'فودافون كاش' } as any,
        'Fares',
        '',
        'admin',
      );
      const [first] = vaultMoves();
      expect(first[0]).toBeLessThan(0);
      expect(first[1]).toBe('Instapay');
    });

    it('سجل المدفوعات يتبع الخزنة المصححة', async () => {
      const tx = buildSale();
      mockUpdatable(tx);
      await service.update(
        'tx-cash-rule',
        { depMethod: 'فودافون كاش' } as any,
        'Fares',
        '',
        'admin',
      );
      expect(tx.deposits[0].method).toBe('فودافون كاش');
    });

    it('اسمان مختلفان لنفس القطاع لا يحركان مالاً', async () => {
      mockUpdatable(buildSale({ depMethod: 'فودافون كاش' }));
      await service.update(
        'tx-cash-rule',
        { depMethod: 'فودافون' } as any, // كلاهما يُحلّ إلى vodafone
        'Fares',
        '',
        'admin',
      );
      expect(vaultService.addSystemEntry).not.toHaveBeenCalled();
    });

    it('بلا عربون مدفوع لا يوجد قيد خزنة يُصحَّح', async () => {
      mockUpdatable(buildSale({ deposit: 0, remaining: 1650, deposits: [] }));
      await service.update(
        'tx-cash-rule',
        { depMethod: 'فودافون كاش' } as any,
        'Fares',
        '',
        'admin',
      );
      expect(vaultService.addSystemEntry).not.toHaveBeenCalled();
    });

    it('تغيير الخزنة والمبلغ معاً: التحويل بالمبلغ القديم ثم الفرق على الخزنة الجديدة', async () => {
      mockUpdatable(buildSale());
      await service.update(
        'tx-cash-rule',
        { depMethod: 'فودافون كاش', deposit: 800 } as any,
        'Fares',
        '',
        'admin',
      );
      // ينتقل الـ500 الأصلية أولاً، ثم تُقيَّد الـ300 الإضافية على الخزنة الجديدة.
      expect(vaultMoves()).toEqual([
        [-500, 'Instapay'],
        [500, 'فودافون كاش'],
        [300, 'فودافون كاش'],
      ]);
    });

    it('يسجّل تغيير الخزنة في سجل التعديلات', async () => {
      const tx = buildSale();
      mockUpdatable(tx);
      await service.update(
        'tx-cash-rule',
        { depMethod: 'فودافون كاش' } as any,
        'Fares',
        '',
        'admin',
      );
      const entry = txModel.findByIdAndUpdate.mock.calls[0][1].editHistory.at(-1);
      expect(entry.before.depMethod).toBe('Instapay');
      expect(entry.after.depMethod).toBe('فودافون كاش');
    });

    /**
     * معاملات شوبيفاي تُكتَب عبر `txModel.create` مباشرة (تتجاوز `create()`)،
     * لكنها تُعدَّل عبر `update()` نفسها وتحمل نفس حقول `depMethod`/`deposits`.
     */
    it('يعمل على معاملة من شوبيفاي تماماً كالمانيول', async () => {
      const tx = buildSale({
        source: 'shopify',
        shopifyOrderId: 'gid://shopify/Order/123',
        employee: 'Shopify (Fares)',
      });
      mockUpdatable(tx);
      await service.update(
        'tx-cash-rule',
        { depMethod: 'فودافون كاش' } as any,
        'Fares',
        '',
        'admin',
      );
      expect(vaultMoves()).toEqual([
        [-500, 'Instapay'],
        [500, 'فودافون كاش'],
      ]);
      expect(tx.deposits[0].method).toBe('فودافون كاش');
    });

    /**
     * إسناد (لا تحويل): معاملة بلا عربون يُضاف لها عربون الآن مع تحديد خزنته.
     * لا يوجد قيد سابق يُعكَس، فالمطلوب قيد واحد موجب على الخزنة المختارة.
     */
    it('إضافة عربون على معاملة بلا عربون تقيّده على الخزنة المختارة بقيد واحد', async () => {
      mockUpdatable(
        buildSale({ deposit: 0, remaining: 1650, depMethod: '', payment: '', deposits: [] }),
      );
      await service.update(
        'tx-cash-rule',
        { deposit: 500, depMethod: 'فودافون كاش' } as any,
        'Fares',
        '',
        'admin',
      );
      expect(vaultMoves()).toEqual([[500, 'فودافون كاش']]);
    });

    it('تصفير العربون يعيد المال من خزنته ولا يُنشئ تحويلاً', async () => {
      mockUpdatable(buildSale());
      await service.update(
        'tx-cash-rule',
        { deposit: 0 } as any,
        'Fares',
        '',
        'admin',
      );
      expect(vaultMoves()).toEqual([[-500, 'Instapay']]);
    });
  });

  /**
   * ── نظام الإلغاءات المنظّم ────────────────────────────────────────────────
   * The reason used to be unconstrained free text on both cancellation paths, so
   * «العميل غير مستجيب» / «عميل مش راد» / «لا يرد» were three distinct rows in any
   * report that tried to group them. These lock in the code-based replacement:
   * validation at the boundary, the derived summary that keeps every legacy reader
   * working, and the carry-through from request→approve that stops the approval
   * flow from losing the reason it was given.
   */
  describe('cancel() — structured cancellation reasons', () => {
    function buildCancellable(overrides: Record<string, unknown> = {}): any {
      const tx: any = buildSaleTransaction({
        _id: 'tx-cx',
        type: 'مبيعات',
        ref: '3001',
        total: 1000,
        deposit: 0,
        remaining: 1000,
        payStatus: 'معلق',
        cancelled: false,
        items: [],
        ...overrides,
      });
      tx.save = jest.fn().mockImplementation(async function (this: any) { return this; });
      tx.markModified = jest.fn();
      return tx;
    }
    function mockCancellable(tx: any) {
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      txModel.findByIdAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(tx),
      });
    }

    it('stores the code, the note and a derived human summary', async () => {
      const tx = buildCancellable();
      mockCancellable(tx);
      await service.cancel('tx-cx', {
        cancelReasonCode: 'customer-unreachable',
        cancelReasonNote: 'اتصلنا ٣ مرات',
        cancelledBy: 'admin',
      } as any);
      expect(tx.cancelReasonCode).toBe('customer-unreachable');
      expect(tx.cancelReasonNote).toBe('اتصلنا ٣ مرات');
      // The free-text field every legacy consumer reads (invoice view, archive export,
      // vault note) stays populated — that is what makes this additive, not a migration.
      expect(tx.cancelReason).toBe('تعذّر الوصول للعميل — اتصلنا ٣ مرات');
      expect(tx.cancelStage).toBe('transaction');
      expect(tx.cancelled).toBe(true);
    });

    it('rejects a code that is not in the shared list', async () => {
      mockCancellable(buildCancellable());
      await expect(
        service.cancel('tx-cx', {
          cancelReasonCode: 'because-i-said-so',
          cancelledBy: 'admin',
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    /**
     * `test-order` is shopify-only: by the time an order is a transaction it has moved
     * cash and stock, and calling that a test is how a real loss gets filed as noise.
     */
    it('rejects a shopify-only reason on a transaction cancellation', async () => {
      mockCancellable(buildCancellable());
      await expect(
        service.cancel('tx-cx', {
          cancelReasonCode: 'test-order',
          cancelledBy: 'admin',
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('requires a note when the reason is «سبب آخر»', async () => {
      mockCancellable(buildCancellable());
      await expect(
        service.cancel('tx-cx', {
          cancelReasonCode: 'other',
          cancelReasonNote: '   ',
          cancelledBy: 'admin',
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts «سبب آخر» once it carries a note', async () => {
      const tx = buildCancellable();
      mockCancellable(tx);
      await service.cancel('tx-cx', {
        cancelReasonCode: 'other',
        cancelReasonNote: 'الفرع أغلق',
        cancelledBy: 'admin',
      } as any);
      expect(tx.cancelReason).toBe('سبب آخر — الفرع أغلق');
    });

    it('rejects a cancellation carrying neither a code nor free text', async () => {
      mockCancellable(buildCancellable());
      await expect(
        service.cancel('tx-cx', { cancelledBy: 'admin' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    /**
     * Back-compat: an un-migrated caller that sends only free text still works and simply
     * lands with an empty code — the reports bucket it under «غير محدد» rather than
     * dropping it, so the totals keep matching reality.
     */
    it('still accepts a free-text-only cancellation and leaves the code empty', async () => {
      const tx = buildCancellable();
      mockCancellable(tx);
      await service.cancel('tx-cx', {
        cancelReason: 'سبب قديم مكتوب يدوياً',
        cancelledBy: 'admin',
      } as any);
      expect(tx.cancelReason).toBe('سبب قديم مكتوب يدوياً');
      expect(tx.cancelReasonCode).toBe('');
    });

    it('validates the reason at request time, not only at approval', async () => {
      mockCancellable(buildCancellable());
      await expect(
        service.requestCancel('tx-cx', '', 'موظف', '', '', 'other', ''),
      ).rejects.toThrow(BadRequestException);
    });

    it('records the code on the pending request', async () => {
      const tx = buildCancellable();
      mockCancellable(tx);
      await service.requestCancel(
        'tx-cx', '', 'موظف', 'u1', 'mohamed', 'out-of-stock', '',
      );
      const written = txModel.findByIdAndUpdate.mock.calls[0][1].cancelRequest;
      expect(written.cancelReasonCode).toBe('out-of-stock');
      expect(written.reason).toBe('الصنف غير متوفر');
    });

    /**
     * The approver decides WHETHER a cancellation happens, not WHY. Losing the requester's
     * code here would send every request→approve cancellation to «غير محدد» and make the
     * report a measure of which path was used rather than of what went wrong.
     */

    /**
     * The table paginates and sorts client-side, so a truncated payload would make page 2 and
     * every sort silently wrong — they would reorder an arbitrary 25 rows rather than the
     * period's actual cancellations. The cap exists only to bound the response, and when it
     * bites the UI says so rather than presenting a partial list as complete.
     */
    it('returns every cancellation for the table, not a top-25 slice', async () => {
      const many = Array.from({ length: 40 }, (_, i) => ({
        _id: 'c' + i,
        ref: String(4000 + i),
        type: 'مبيعات',
        client: 'عميل',
        total: 100,
        deposit: 0,
        date: '2026-08-01',
        cancelled: true,
        cancelledAt: '2026-08-0' + ((i % 9) + 1) + 'T10:00:00.000Z',
        cancelledBy: 'admin',
        cancelReason: 'الصنف غير متوفر',
        cancelReasonCode: 'out-of-stock',
        cancelReasonNote: '',
        cancelStage: 'transaction',
      }));
      txModel.find.mockReturnValue({ exec: jest.fn().mockResolvedValue(many) });
      shopifyOrderModel.find.mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });

      const out: any = await (service as any).buildCancellationsReport('2026-08-01', '2026-08-31');
      expect(out.total).toBe(40);
      expect(out.recent).toHaveLength(40);
      expect(out.recentTruncated).toBe(false);
    });

    it('carries the requester code through approval onto the transaction', async () => {
      const tx = buildCancellable({
        cancelRequest: {
          requestedBy: 'موظف',
          requestedById: '',
          requestedByUsername: '',
          reason: 'الصنف غير متوفر',
          cancelReasonCode: 'out-of-stock',
          cancelReasonNote: '',
          requestedAt: '2026-08-28T00:00:00.000Z',
          status: 'معلق',
        },
      });
      mockCancellable(tx);
      await service.approveCancel('tx-cx', 'مدير');
      expect(tx.cancelReasonCode).toBe('out-of-stock');
      expect(tx.cancelStage).toBe('transaction');
    });
  });


  /* ══════════════════════════════════════════════════════════════════════
     setPickupPreparing — a group's identity belongs to the group
     ══════════════════════════════════════════════════════════════════════
     The prep group's note / shipCo / createdAt / createdBy are denormalised
     onto every member row, and the Pick-Up board reads them off the first
     member it finds. So an order JOINING a group must inherit them, never
     overwrite them.

     This is what the Shopify confirm dialog's "add to this card" option does
     on every order it sends: it has no note to pass and a fresh timestamp, so
     writing the caller's meta unconditionally would rename an existing card to
     «» and reset its creation time to now. */
  describe('setPickupPreparing — joining a group must not rewrite its identity', () => {
    const GROUP_META = {
      prepNote: 'مجموعة الأحمدي — شحن سريع',
      prepShipCo: 'Bosta',
      prepCreatedAt: '2026-09-08T09:00:00.000Z',
      prepCreatedBy: 'سارة',
    };

    /** Make findOne(...).select(...).lean() resolve to `doc`. */
    const mockExistingMember = (doc: any) => {
      txModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(doc),
        }),
      });
    };

    beforeEach(() => {
      txModel.updateMany = jest.fn().mockImplementation((filter: any) =>
        Promise.resolve({ modifiedCount: filter._id.$in.length }),
      );
      txModel.find.mockImplementation((filter: any) => ({
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue((filter._id.$in || []).map((_id: string) => ({ _id }))),
        }),
      }));
    });

    /** The $set the service handed to Mongo. */
    const writtenSet = () => txModel.updateMany.mock.calls[0][1].$set;

    const ID_A = '507f1f77bcf86cd799439011';
    const ID_B = '507f1f77bcf86cd799439012';

    it('inherits the existing group note/shipCo/createdAt instead of blanking them', async () => {
      mockExistingMember(GROUP_META);

      // Exactly what the confirm dialog sends when adding to an existing card:
      // a ref and nothing else.
      await service.setPickupPreparing([ID_A], 'أحمد', '104-08SEP', {
        createdAt: '2026-09-08T17:30:00.000Z',
      });

      const set = writtenSet();
      expect(set.prepNote).toBe(GROUP_META.prepNote);
      expect(set.prepShipCo).toBe(GROUP_META.prepShipCo);
      // The card keeps the time it was actually opened, not the moment the
      // newest order joined it.
      expect(set.prepCreatedAt).toBe(GROUP_META.prepCreatedAt);
      expect(set.prepCreatedBy).toBe(GROUP_META.prepCreatedBy);
      // And the order does land in that group, in Preparing.
      expect(set.pickupRef).toBe('104-08SEP');
      expect(set.pickupStatus).toBe('Preparing');
    });

    it('uses the caller meta when the group does not exist yet', async () => {
      mockExistingMember(null);

      await service.setPickupPreparing([ID_A, ID_B], 'أحمد', '777-08SEP', {
        note: 'دفعة المساء',
        shipCo: 'Mylerz',
        createdAt: '2026-09-08T17:30:00.000Z',
      });

      const set = writtenSet();
      expect(set.prepNote).toBe('دفعة المساء');
      expect(set.prepShipCo).toBe('Mylerz');
      expect(set.prepCreatedAt).toBe('2026-09-08T17:30:00.000Z');
      expect(set.prepCreatedBy).toBe('أحمد');
    });

    it('only ever pulls identity from a member still in Preparing', async () => {
      mockExistingMember(GROUP_META);
      await service.setPickupPreparing([ID_A], 'أحمد', '104-08SEP', {});

      // A group already moved to Ready/Shipped is not the same batch: its rows
      // must not be treated as the identity of a group being filled now.
      expect(txModel.findOne).toHaveBeenCalledWith({
        pickupRef: '104-08SEP',
        pickupStatus: 'Preparing',
      });
    });

    it('never touches an order that is not a live pending sale', async () => {
      mockExistingMember(null);
      await service.setPickupPreparing([ID_A], 'أحمد', '104-08SEP', {});

      // Guards the sale itself: confirming from Shopify must not drag a
      // cancelled row, a purchase, or an already-shipped order into a batch.
      const filter = txModel.updateMany.mock.calls[0][0];
      expect(filter.type).toBe('مبيعات');
      expect(filter.cancelled).toEqual({ $ne: true });
      expect(filter.pickupStatus).toEqual({ $in: ['Pending', null] });
    });

    it('writes nothing when every id is invalid', async () => {
      await service.setPickupPreparing(['not-an-id'], 'أحمد', '104-08SEP', {});
      expect(txModel.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('pickup handoff guards', () => {
    const ID_A = '507f1f77bcf86cd799439011';
    const ID_B = '507f1f77bcf86cd799439012';
    const mockSourceOrders = (rows: any[]) => {
      txModel.find.mockReturnValue({
        select: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(rows) }),
      });
    };

    it('moves only fully prepared orders and reuses the open ticket for the chosen date', async () => {
      mockSourceOrders([
        { _id: ID_A, pickupStatus: 'Preparing', prepChecked: true },
        { _id: ID_B, pickupStatus: 'Preparing', prepChecked: true },
      ]);
      txModel.findOne.mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ pickupRef: 'RUN-OPEN' }),
      });
      txModel.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 2 });

      const result = await service.confirmPickup([ID_A, ID_B], 'أحمد', '2026-10-04', true);

      expect(result).toEqual({ updated: 2, pickupRef: 'RUN-OPEN' });
      expect(txModel.findOne).toHaveBeenCalledWith(expect.objectContaining({
        type: 'مبيعات', pickupDate: '2026-10-04', pickupStatus: { $in: ['Ready', 'Picked-Up'] },
      }));
      expect(txModel.updateMany.mock.calls[0][0]).toEqual(expect.objectContaining({
        pickupStatus: 'Preparing', prepChecked: true,
      }));
    });

    it('rejects Pending or incompletely prepared orders from skipping straight to Ready', async () => {
      mockSourceOrders([{ _id: ID_A, pickupStatus: 'Pending', prepChecked: false }]);
      txModel.updateMany = jest.fn();

      await expect(service.confirmPickup([ID_A], 'أحمد', '2026-10-04', true))
        .rejects.toThrow('لا يمكن نقل الطلب إلى الجاهز قبل نقله للتحضير وإكمال تحضيره');
      expect(txModel.updateMany).not.toHaveBeenCalled();
    });
  });

});
