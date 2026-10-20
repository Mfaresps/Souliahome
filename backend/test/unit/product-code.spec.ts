import mongoose from 'mongoose';
import { nextProductCode, isDuplicateProductKey } from '../../src/products/product-code.util';
import { ProductSchema } from '../../src/products/schemas/product.schema';

describe('SKU allocation and schema defense', () => {
  it('keeps existing suffix format and skips deletion gaps', () => {
    expect(nextProductCode('ALBA-GRN', ['ALBA-GRN-001', 'ALBA-GRN-003'])).toBe('ALBA-GRN-004');
    expect(nextProductCode('ALBA-GRN', [])).toBe('ALBA-GRN-001');
  });
  it('compares suffixes numerically after 999 and ignores unrelated/malformed codes', () => {
    expect(nextProductCode('A', ['A-999', 'A-1000', 'A-manual', 'AA-9000', 'A-2-extra'])).toBe('A-1001');
  });
  it('escapes prefixes and refuses unsafe sequence arithmetic', () => {
    expect(nextProductCode('A.+', ['A.+-005', 'ABC-100'])).toBe('A.+-006');
    expect(() => nextProductCode('A', ['A-9007199254740991'])).toThrow();
  });
  it('retries only structured duplicate-code errors, never names or arbitrary errors', () => {
    expect(isDuplicateProductKey({ code: 11000, keyValue: { code: 'A' } }, 'code')).toBe(true);
    expect(isDuplicateProductKey({ code: 11000, keyPattern: { name: 1 } }, 'code')).toBe(false);
    expect(isDuplicateProductKey(new Error('code_1 duplicate'), 'code')).toBe(false);
  });
  it('keeps persisted SKU immutable while names, attributes and prices remain editable', () => {
    const Model = mongoose.model('Phase2SkuSchemaTest', ProductSchema);
    const product = Model.hydrate({ _id: new mongoose.Types.ObjectId(), code: 'LEGACY', name: 'Old', colors: ['Blue'], sellPrice: 50 });
    product.code = 'NEW';
    product.name = 'New'; product.colors = ['Red']; product.size = 'Large'; product.sellPrice = 75;
    expect(product.code).toBe('LEGACY');
    expect(product.toObject()).toMatchObject({ name: 'New', colors: ['Red'], size: 'Large', sellPrice: 75 });
  });
});
