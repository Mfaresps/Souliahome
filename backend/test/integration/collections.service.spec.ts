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
import { createMockMongooseModel, createMockPresenceGateway } from '../helpers/mocks';
import { PresenceGateway } from '../../src/auth/presence.gateway';

describe('CollectionsService — code generation', () => {
  let service: CollectionsService;
  let collectionModel: ReturnType<typeof createMockMongooseModel>;
  let categoryModel: ReturnType<typeof createMockMongooseModel>;
  let collectionProductModel: ReturnType<typeof createMockMongooseModel>;
  let productModel: ReturnType<typeof createMockMongooseModel>;
  let presence: ReturnType<typeof createMockPresenceGateway>;

  const YEAR = new Date().getFullYear();
  const PREFIX = `COL-${YEAR}-`;

  beforeEach(async () => {
    collectionModel = createMockMongooseModel();
    categoryModel = createMockMongooseModel();
    collectionProductModel = createMockMongooseModel();
    productModel = createMockMongooseModel();
    presence = createMockPresenceGateway();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionsService,
        { provide: getModelToken(Collection.name), useValue: collectionModel },
        { provide: getModelToken(Category.name), useValue: categoryModel },
        {
          provide: getModelToken(CollectionProduct.name),
          useValue: collectionProductModel,
        },
        { provide: getModelToken(Product.name), useValue: productModel },
        { provide: getModelToken(Supplier.name), useValue: createMockMongooseModel() },
        { provide: PresenceGateway, useValue: presence },
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

  /**
   * REGRESSION: assigning a product to a collection from the Categories page wrote only
   * a CollectionProduct join row — the product's OWN categoryId/collectionId fields
   * (what openProductModal() in index.html reads directly) were never updated, so the
   * product modal kept showing "— None —" for both Category and Collection despite the
   * product genuinely being linked. The product-modal save path already kept these in
   * sync via syncCollectionLink(); assignProducts()/removeProduct() must do the same
   * from the Categories-page side.
   */
  describe('assignProducts — mirrors the join table onto the product\'s own fields', () => {
    const COLLECTION_ID = 'col-1';

    function mockCollectionFound(categoryId: string | null = 'cat-9') {
      collectionModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: COLLECTION_ID, categoryId }),
      });
    }

    function mockProductsFound(ids: string[]) {
      productModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue(ids.map((id) => ({ _id: id }))),
      });
    }

    function mockNoExistingLinks() {
      collectionProductModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([]),
      });
    }

    it('sets categoryId/collectionId on every newly-assigned product', async () => {
      mockCollectionFound('cat-9');
      mockProductsFound(['p1', 'p2']);
      mockNoExistingLinks();
      collectionProductModel.insertMany.mockResolvedValue([]);

      const result = await service.assignProducts(COLLECTION_ID, ['p1', 'p2'], 'tester');

      expect(result).toEqual({ added: 2, skipped: 0 });
      expect(productModel.updateMany).toHaveBeenCalledWith(
        { _id: { $in: ['p1', 'p2'] } },
        { $set: { categoryId: 'cat-9', collectionId: COLLECTION_ID } },
      );
    });

    it('drops any prior link to a DIFFERENT collection — a product belongs to exactly one', async () => {
      mockCollectionFound('cat-9');
      mockProductsFound(['p1']);
      mockNoExistingLinks();
      collectionProductModel.insertMany.mockResolvedValue([]);

      await service.assignProducts(COLLECTION_ID, ['p1'], 'tester');

      expect(collectionProductModel.deleteMany).toHaveBeenCalledWith({
        productId: { $in: ['p1'] },
        collectionId: { $ne: COLLECTION_ID },
      });
    });

    it('emits product:changed so an open product list/modal refetches live', async () => {
      mockCollectionFound('cat-9');
      mockProductsFound(['p1']);
      mockNoExistingLinks();
      collectionProductModel.insertMany.mockResolvedValue([]);

      await service.assignProducts(COLLECTION_ID, ['p1'], 'tester');

      expect(presence.emitEvent).toHaveBeenCalledWith(
        'product:changed',
        expect.objectContaining({ productIds: ['p1'] }),
      );
    });

    it('writes null categoryId when the collection has none, never leaving the old value', async () => {
      mockCollectionFound(null);
      mockProductsFound(['p1']);
      mockNoExistingLinks();
      collectionProductModel.insertMany.mockResolvedValue([]);

      await service.assignProducts(COLLECTION_ID, ['p1'], 'tester');

      expect(productModel.updateMany).toHaveBeenCalledWith(
        { _id: { $in: ['p1'] } },
        { $set: { categoryId: null, collectionId: COLLECTION_ID } },
      );
    });

    it('does not touch product fields for a product already assigned (nothing new to add)', async () => {
      mockCollectionFound('cat-9');
      mockProductsFound(['p1']);
      collectionProductModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue([{ productId: 'p1' }]),
      });

      const result = await service.assignProducts(COLLECTION_ID, ['p1'], 'tester');

      expect(result).toEqual({ added: 0, skipped: 1 });
      expect(productModel.updateMany).not.toHaveBeenCalled();
      expect(presence.emitEvent).not.toHaveBeenCalled();
    });
  });

  describe('removeProduct — clears the product\'s own fields when the link it describes is removed', () => {
    const COLLECTION_ID = 'col-1';
    const PRODUCT_ID = 'p1';

    function mockCollectionFound() {
      collectionModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: COLLECTION_ID }),
      });
    }

    it('clears categoryId/collectionId when the product still points at this collection', async () => {
      mockCollectionFound();
      productModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: PRODUCT_ID, name: 'x', collectionId: COLLECTION_ID }),
      });
      collectionProductModel.findOneAndDelete.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ collectionId: COLLECTION_ID, productId: PRODUCT_ID }),
      });

      await service.removeProduct(COLLECTION_ID, PRODUCT_ID, 'tester');

      expect(productModel.updateOne).toHaveBeenCalledWith(
        { _id: PRODUCT_ID },
        { $set: { categoryId: null, collectionId: null } },
      );
      expect(presence.emitEvent).toHaveBeenCalledWith(
        'product:changed',
        expect.objectContaining({ productIds: [PRODUCT_ID] }),
      );
    });

    it('leaves product fields alone if the product was already reassigned to a different collection', async () => {
      mockCollectionFound();
      productModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: PRODUCT_ID, name: 'x', collectionId: 'some-other-collection' }),
      });
      collectionProductModel.findOneAndDelete.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ collectionId: COLLECTION_ID, productId: PRODUCT_ID }),
      });

      await service.removeProduct(COLLECTION_ID, PRODUCT_ID, 'tester');

      expect(productModel.updateOne).not.toHaveBeenCalled();
      expect(presence.emitEvent).not.toHaveBeenCalled();
    });

    it('throws when the link does not exist', async () => {
      mockCollectionFound();
      productModel.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: PRODUCT_ID, name: 'x', collectionId: COLLECTION_ID }),
      });
      collectionProductModel.findOneAndDelete.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.removeProduct(COLLECTION_ID, PRODUCT_ID, 'tester'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(productModel.updateOne).not.toHaveBeenCalled();
    });
  });
});
