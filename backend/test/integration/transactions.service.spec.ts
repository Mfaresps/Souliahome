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
import {
  createMockMongooseModel,
  createMockProductsService,
  createMockVaultService,
} from '../helpers/mocks';
import { mockProducts } from '../fixtures/products.fixture';
import { buildSaleTransaction } from '../fixtures/transactions.fixture';

describe('TransactionsService (integration with mocks)', () => {
  let service: TransactionsService;
  let txModel: ReturnType<typeof createMockMongooseModel>;
  let returnModel: ReturnType<typeof createMockMongooseModel>;
  let productsService: ReturnType<typeof createMockProductsService>;
  let vaultService: ReturnType<typeof createMockVaultService>;

  beforeEach(async () => {
    txModel = createMockMongooseModel();
    returnModel = createMockMongooseModel();
    productsService = createMockProductsService();
    vaultService = createMockVaultService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: getModelToken(Transaction.name), useValue: txModel },
        { provide: getModelToken(ReturnRequest.name), useValue: returnModel },
        { provide: ProductsService, useValue: productsService },
        { provide: VaultService, useValue: vaultService },
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
    it('throws NotFoundException for missing transaction', async () => {
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      await expect(service.findById('missing-id')).rejects.toThrow(/غير موجودة/);
    });

    it('returns transaction when found', async () => {
      const tx = buildSaleTransaction();
      txModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(tx) });
      const result = await service.findById('tx-sale-001');
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
});
