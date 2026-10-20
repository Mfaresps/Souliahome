import { ProductsService } from '../../src/products/products.service';

/** In-memory unique-index stand-in. Real Mongo guarantees are tested separately. */
export function productsSkuFixture() {
  const rows: any[] = [];
  const transactions: any[] = [];
  const query = (value: any) => ({ exec: async () => value, lean: () => ({ exec: async () => value }) });
  const matches = (row: any, filter: any) => Object.entries(filter).every(([key, value]: any) => {
    if (key === '_id' && value?.$ne) return String(row._id) !== String(value.$ne);
    if (value?.$regex) return new RegExp(value.$regex).test(row[key]);
    return row[key] === value;
  });
  let sequence = 1;
  const doc = (data: any) => ({
    _id: (sequence++).toString(16).padStart(24, '0'), ...data,
    save: jest.fn(async function (this: any) { return this; }), markModified: jest.fn(),
  });
  const productModel: any = {
    collection: { indexes: jest.fn(async () => [{ key: { code: 1 }, unique: true }]) },
    findOne: jest.fn((filter: any) => query(rows.find(row => matches(row, filter)) || null)),
    findById: jest.fn((id: string) => query(rows.find(row => String(row._id) === String(id)) || null)),
    find: jest.fn((filter: any = {}) => query(rows.filter(row => matches(row, filter)))),
    create: jest.fn(async (data: any) => {
      await Promise.resolve(); // Let concurrent callers race between allocation and persistence.
      for (const key of ['code', 'name']) if (rows.some(row => row[key] === data[key])) {
        throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { [key]: 1 } });
      }
      const created = doc(data); rows.push(created); return created;
    }),
    findByIdAndUpdate: jest.fn((id: string, patch: any) => {
      const row = rows.find(item => String(item._id) === String(id));
      if (row) {
        for (const [key, value] of Object.entries(patch)) {
          if (key === '$push') for (const [field, entry] of Object.entries(value as any)) (row[field] ||= []).push(entry);
          else row[key] = value;
        }
      }
      return query(row || null);
    }),
    updateMany: jest.fn(() => query({ modifiedCount: 1 })),
    findByIdAndDelete: jest.fn(() => query({})),
    deleteMany: jest.fn(() => query({ deletedCount: 1 })),
  };
  const txModel = { find: jest.fn(() => query(transactions)) };
  const collectionModel = { deleteMany: jest.fn(() => query({})), create: jest.fn(async () => ({})) };
  const presence = { emitEvent: jest.fn() };
  const mentions = { create: jest.fn(async () => ({})) };
  const service = new ProductsService(productModel, txModel as any, collectionModel as any, presence as any, mentions as any);
  const seed = (data: any = {}) => {
    const row = doc({ code: 'ORIGINAL', name: 'Original', openingBalance: 5, ...data }); rows.push(row); return row;
  };
  return { service, rows, transactions, productModel, txModel, collectionModel, presence, seed };
}
