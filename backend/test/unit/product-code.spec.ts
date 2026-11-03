import mongoose from 'mongoose';
import { productCodePrefix, isDuplicateProductKey } from '../../src/products/product-code.util';
import { ProductSchema } from '../../src/products/schemas/product.schema';

describe('SKU allocation and schema defense', () => {
  it('uses the first three characters of every word, including Arabic and punctuation-separated words', () => {
    expect(productCodePrefix('Blanket darkgreen Knitted')).toBe('BLA-DAR-KNI');
    expect(productCodePrefix('Alba-Soft cushions Beige')).toBe('ALB-SOF-CUS-BEI');
    expect(productCodePrefix('بطانية خضراء محبوكة')).toBe('بطا-خضر-محب');
    expect(productCodePrefix('   !!!   ')).toBe('');
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
