import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { productsSkuFixture } from '../helpers/products-sku.fixture';

describe('ProductsService immutable SKU workflows', () => {
  it('creates 20 concurrent products sharing a prefix with unique codes', async () => {
    const { service, rows } = productsSkuFixture();
    const result = await Promise.all(Array.from({ length: 20 }, (_, i) => service.create({ name: `Alba Cushion ${i}`, colors: ['Green'], size: 'Medium' }, 'Manager')));
    expect(rows).toHaveLength(20);
    expect(new Set(result.map(row => row.code)).size).toBe(20);
    expect(result.every(row => row.code.startsWith('ALBA-CUSHION-GRN-M-'))).toBe(true);
    expect(result.every(row => row.createdBy === 'Manager')).toBe(true);
  });
  it('allocates after the highest suffix rather than filling deletion gaps', async () => {
    const { service, seed } = productsSkuFixture();
    seed({ code: 'ALBA-CUSHION-001', name: 'one' }); seed({ code: 'ALBA-CUSHION-003', name: 'three' });
    expect((await service.create({ name: 'Alba Cushion' })).code).toBe('ALBA-CUSHION-004');
  });
  it('returns a conflict for concurrent manual-code creation without silently changing the SKU', async () => {
    const { service, rows } = productsSkuFixture();
    const result = await Promise.allSettled([service.create({ code: 'MANUAL', name: 'One' }), service.create({ code: 'MANUAL', name: 'Two' })]);
    expect(rows).toHaveLength(1);
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect((result.find(row => row.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
  });
  it.each([
    { indexes: [] }, { indexes: [{ key: { code: 1 }, unique: false }] },
    { indexes: [{ key: { code: 1 }, unique: true, sparse: true }] },
    { indexes: [{ key: { code: 1 }, unique: true, partialFilterExpression: { isActive: true } }] },
  ])('fails closed without a verified full unique index ($indexes)', async ({ indexes }) => {
    const { service, productModel } = productsSkuFixture();
    productModel.collection.indexes.mockResolvedValue(indexes);
    await expect(service.create({ name: 'New' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(productModel.create).not.toHaveBeenCalled();
  });
  it('does not retry unrelated database failures', async () => {
    const { service, productModel } = productsSkuFixture();
    productModel.create.mockRejectedValue(new Error('database unavailable'));
    await expect(service.create({ name: 'New' })).rejects.toThrow('database unavailable');
    expect(productModel.create).toHaveBeenCalledTimes(1);
  });
  it.each(['NEW', '', null, ' ORIGINAL '])('rejects SKU edit %j before any write or transaction sync', async code => {
    const { service, productModel, txModel, seed } = productsSkuFixture(); const p = seed();
    await expect(service.update(p._id, { code, name: 'Changed' } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(productModel.findByIdAndUpdate).not.toHaveBeenCalled(); expect(txModel.find).not.toHaveBeenCalled();
    expect(p.name).toBe('Original');
  });
  it('accepts an unchanged echoed SKU and preserves all ordinary editable fields', async () => {
    const { service, seed, productModel } = productsSkuFixture(); const p = seed();
    const fields = { code: p.code, colors: ['Red'], size: 'Large', sellPrice: 90, buyPrice: 20,
      material: 'Cotton', features: ['Waterproof'], description: 'description', minStock: 4, openingBalance: 7 };
    expect(await service.update(p._id, fields)).toMatchObject(fields);
    expect(productModel.findByIdAndUpdate.mock.calls[0][1]).not.toHaveProperty('code');
  });
  it('does not normalize legacy codes during unrelated edits', async () => {
    const { service, seed } = productsSkuFixture(); const p = seed({ code: ' legacy ' });
    await service.update(p._id, { sellPrice: 42 }); expect(p.code).toBe(' legacy ');
  });
  it('renames the product and invoice display without rewriting historical identifiers or money', async () => {
    const { service, seed, transactions } = productsSkuFixture(); const p = seed();
    const tx: any = { items: [{ productId: '', code: 'HISTORICAL', name: p.name, qty: 2, price: 35, total: 70 }], markModified: jest.fn(), save: jest.fn(async () => tx) };
    transactions.push(tx);
    await service.update(p._id, { name: 'Renamed' });
    expect(tx.items).toEqual([{ productId: '', code: 'HISTORICAL', name: 'Renamed', qty: 2, price: 35, total: 70 }]);
  });
  it('rejects SKU edit requests, while ordinary staff requests still work', async () => {
    const { service, seed } = productsSkuFixture(); const p = seed();
    await expect(service.requestProductEdit(p._id, { requestedBy: 'Staff', changes: { code: 'NEW', colors: ['Red'] } })).rejects.toBeInstanceOf(BadRequestException);
    expect(p.save).not.toHaveBeenCalled();
    await service.requestProductEdit(p._id, { requestedBy: 'Staff', changes: { code: p.code, colors: ['Red'] } });
    expect(p.editRequest.changes.map((row: any) => row.field)).toEqual(['colors']);
  });
  it('rejects old pending SKU approvals before applying any other changes', async () => {
    const { service, seed } = productsSkuFixture(); const p = seed({ editRequest: { status: 'معلق', changes: [{ field: 'colors', newValue: ['Red'] }, { field: 'code', newValue: 'NEW' }] } });
    await expect(service.approveProductEdit(p._id, 'Admin')).rejects.toBeInstanceOf(BadRequestException);
    expect(p.editRequest.status).toBe('معلق'); expect(p.save).not.toHaveBeenCalled(); expect(p.code).toBe('ORIGINAL');
  });
  it('still approves non-SKU product fields and attributes the review', async () => {
    const { service, seed } = productsSkuFixture(); const p = seed({ editRequest: { status: 'معلق', changes: [{ field: 'size', newValue: 'Large' }, { field: 'buyPrice', newValue: 44 }] } });
    await service.approveProductEdit(p._id, 'Admin');
    expect(p).toMatchObject({ code: 'ORIGINAL', size: 'Large', buyPrice: 44, editRequest: { status: 'معتمد', reviewedBy: 'Admin' } });
  });
  it('rejects bulk SKU writes and preserves normal bulk updates', async () => {
    const { service, productModel } = productsSkuFixture();
    await expect(service.bulkUpdate(['id'], { code: 'NEW', sellPrice: 10 } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(productModel.updateMany).not.toHaveBeenCalled();
    await service.bulkUpdate(['id'], { sellPrice: 10, minStock: 3 });
    expect(productModel.updateMany).toHaveBeenCalledWith({ _id: { $in: ['id'] } }, { sellPrice: 10, minStock: 3 });
  });
  it('imports matching SKUs as ordinary updates and creates genuinely new SKUs', async () => {
    const { service, seed, rows, productModel, txModel } = productsSkuFixture(); const p = seed();
    expect(await service.importProducts([{ code: p.code, name: p.name, colors: ['Red'], size: 'Large', sellPrice: 50, buyPrice: 15, openingBalance: 5 }, { code: 'SECOND', name: 'Second' }], 'Admin')).toEqual({ created: 1, updated: 1 });
    expect(p).toMatchObject({ code: 'ORIGINAL', colors: ['Red'], size: 'Large', sellPrice: 50, buyPrice: 15 });
    expect(productModel.findByIdAndUpdate.mock.calls[0][1]).not.toHaveProperty('code');
    expect(rows.find(row => row.code === 'SECOND').createdBy).toBe('Admin');
    expect(txModel.find).not.toHaveBeenCalled();
  });
  it('rejects a renamed SKU anywhere in the import before writing earlier rows', async () => {
    const { service, seed, productModel } = productsSkuFixture(); const p = seed();
    await expect(service.importProducts([{ code: 'OTHER', name: 'Other' }, { code: 'RENAMED', name: p.name }])).rejects.toBeInstanceOf(ConflictException);
    expect(productModel.create).not.toHaveBeenCalled(); expect(productModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });
  it('rejects blank import SKUs without generating a replacement', async () => {
    const { service, productModel } = productsSkuFixture();
    await expect(service.importProducts([{ code: ' ', name: 'New' }])).rejects.toBeInstanceOf(BadRequestException);
    expect(productModel.create).not.toHaveBeenCalled();
  });
});
