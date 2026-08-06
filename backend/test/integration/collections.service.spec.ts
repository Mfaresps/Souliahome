/**
 * Integration-style tests for CollectionsService code generation using mocked Mongoose models.
 *
 * Regression focus: create() used to derive the collection code from countDocuments(),
 * which permanently broke after any delete (count+1 collides with an existing code and
 * `code` is a unique index -> E11000 -> "البيانات موجودة مسبقاً" on every subsequent add).
 *
 * Run with: npm test -- collections.service
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CollectionsService } from '../../src/collections/collections.service';
import { Collection } from '../../src/collections/schemas/collection.schema';
import { Category } from '../../src/collections/schemas/category.schema';
import { CollectionProduct } from '../../src/collections/schemas/collection-product.schema';
import { Product } from '../../src/products/schemas/product.schema';
import { Supplier } from '../../src/suppliers/schemas/supplier.schema';
import { createMockMongooseModel } from '../helpers/mocks';

describe('CollectionsService — code generation', () => {
  let service: CollectionsService;
  let collectionModel: ReturnType<typeof createMockMongooseModel>;
  let categoryModel: ReturnType<typeof createMockMongooseModel>;

  const YEAR = new Date().getFullYear();
  const PREFIX = `COL-${YEAR}-`;

  beforeEach(async () => {
    collectionModel = createMockMongooseModel();
    categoryModel = createMockMongooseModel();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionsService,
        { provide: getModelToken(Collection.name), useValue: collectionModel },
        { provide: getModelToken(Category.name), useValue: categoryModel },
        {
          provide: getModelToken(CollectionProduct.name),
          useValue: createMockMongooseModel(),
        },
        { provide: getModelToken(Product.name), useValue: createMockMongooseModel() },
        { provide: getModelToken(Supplier.name), useValue: createMockMongooseModel() },
      ],
    }).compile();

    service = module.get<CollectionsService>(CollectionsService);
  });

  afterEach(() => jest.clearAllMocks());

  /** No existing collection with this name (the explicit duplicate-name guard passes). */
  function mockNameFree() {
    collectionModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });
  }

  /** The category referenced by the DTO exists. */
  function mockCategoryExists() {
    categoryModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ _id: 'cat-1', name: 'a' }),
    });
  }

  /** Existing codes in the DB, as generateCode()'s find(...).lean().exec() sees them. */
  function mockExistingCodes(codes: string[]) {
    collectionModel.find.mockReturnValue({
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(codes.map((code) => ({ code }))),
      }),
    });
  }

  /** create() succeeds; findById() (the post-create reload) returns the doc. */
  function mockCreateSucceeds() {
    collectionModel.create.mockImplementation((doc: Record<string, unknown>) =>
      Promise.resolve({ ...doc, _id: 'new-1' }),
    );
    collectionModel.findByIdAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue({}),
    });
    collectionModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ _id: 'new-1', name: 'runner larg 3' }),
    });
  }

  function dupKeyError() {
    return Object.assign(new Error('E11000 duplicate key'), {
      code: 11000,
      keyPattern: { code: 1 },
    });
  }

  const DTO = { name: 'runner larg 3', categoryId: 'cat-1' } as never;

  function createdCode(): string {
    return collectionModel.create.mock.calls[0][0].code;
  }

  describe('sequential numbering', () => {
    it('starts at 001 when no collection exists for this year', async () => {
      mockNameFree();
      mockCategoryExists();
      mockExistingCodes([]);
      mockCreateSucceeds();

      await service.create(DTO, 'tester');
      expect(createdCode()).toBe(`${PREFIX}001`);
    });

    it('continues from the highest existing number', async () => {
      mockNameFree();
      mockCategoryExists();
      mockExistingCodes([`${PREFIX}001`, `${PREFIX}002`, `${PREFIX}003`]);
      mockCreateSucceeds();

      await service.create(DTO, 'tester');
      expect(createdCode()).toBe(`${PREFIX}004`);
    });

    it('REGRESSION: skips gaps left by deletes instead of reusing a taken code', async () => {
      // 5 collections were created, then 002 and 004 were deleted. The old
      // count-based logic would produce 004 (count 3 + 1) — already taken.
      mockNameFree();
      mockCategoryExists();
      mockExistingCodes([`${PREFIX}001`, `${PREFIX}003`, `${PREFIX}005`]);
      mockCreateSucceeds();

      await service.create(DTO, 'tester');
      expect(createdCode()).toBe(`${PREFIX}006`);
    });

    it('orders numerically past 999, where padding no longer sorts lexicographically', async () => {
      mockNameFree();
      mockCategoryExists();
      mockExistingCodes([`${PREFIX}999`, `${PREFIX}1000`]);
      mockCreateSucceeds();

      await service.create(DTO, 'tester');
      expect(createdCode()).toBe(`${PREFIX}1001`);
    });

    it('ignores malformed codes rather than producing COL-YYYY-NaN', async () => {
      mockNameFree();
      mockCategoryExists();
      mockExistingCodes([`${PREFIX}abc`, `${PREFIX}002`]);
      mockCreateSucceeds();

      await service.create(DTO, 'tester');
      expect(createdCode()).toBe(`${PREFIX}003`);
    });
  });

  describe('concurrent creates', () => {
    it('retries on a duplicate-code race and eventually succeeds', async () => {
      mockNameFree();
      mockCategoryExists();
      mockExistingCodes([`${PREFIX}001`]);
      collectionModel.findByIdAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({}),
      });
      collectionModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: 'new-1' }),
      });
      // First attempt loses the race, second wins.
      collectionModel.create
        .mockRejectedValueOnce(dupKeyError())
        .mockResolvedValueOnce({ _id: 'new-1', name: 'runner larg 3' });

      await expect(service.create(DTO, 'tester')).resolves.toBeDefined();
      expect(collectionModel.create).toHaveBeenCalledTimes(2);
    });

    it('gives up after 5 attempts if the collision never clears', async () => {
      mockNameFree();
      mockCategoryExists();
      mockExistingCodes([`${PREFIX}001`]);
      collectionModel.create.mockRejectedValue(dupKeyError());

      await expect(service.create(DTO, 'tester')).rejects.toMatchObject({
        code: 11000,
      });
      expect(collectionModel.create).toHaveBeenCalledTimes(5);
    });

    it('does NOT retry a duplicate on some other unique field', async () => {
      mockNameFree();
      mockCategoryExists();
      mockExistingCodes([`${PREFIX}001`]);
      collectionModel.create.mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key'), {
          code: 11000,
          keyPattern: { name: 1 },
        }),
      );

      await expect(service.create(DTO, 'tester')).rejects.toMatchObject({
        code: 11000,
      });
      expect(collectionModel.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('pre-existing guards still apply', () => {
    it('rejects a duplicate name before touching code generation', async () => {
      collectionModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: 'existing', name: 'runner larg 3' }),
      });

      await expect(service.create(DTO, 'tester')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(collectionModel.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown category', async () => {
      mockNameFree();
      categoryModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      await expect(service.create(DTO, 'tester')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(collectionModel.create).not.toHaveBeenCalled();
    });
  });
});
