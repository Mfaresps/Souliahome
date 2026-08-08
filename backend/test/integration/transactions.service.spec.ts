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
  let supplierReturnModel: ReturnType<typeof createMockMongooseModel>;
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
    supplierReturnModel = createMockMongooseModel();
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
        {
          provide: getModelToken(SupplierReturnOrder.name),
          useValue: supplierReturnModel,
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
});
