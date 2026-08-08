/**
 * Product specs & features persistence.
 *
 * The global pipe in main.ts runs with `whitelist: true`, which SILENTLY DROPS any
 * property missing from the DTO — a field can be in the schema, the UI and the request
 * body and still never reach Mongo. These tests pin the whole chain: request body →
 * DTO (through a pipe configured exactly like the real one) → Mongoose document.
 */
import { ValidationPipe, ArgumentMetadata } from '@nestjs/common';
import mongoose from 'mongoose';
import {
  CreateProductDto,
  UpdateProductDto,
  ImportProductItemDto,
} from '../../src/products/dto/product.dto';
import { ProductSchema } from '../../src/products/schemas/product.schema';

// Same options as main.ts — if those change, this test must change with them.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: false,
  transform: true,
});
const asBody = (metatype: unknown): ArgumentMetadata =>
  ({ type: 'body', metatype } as ArgumentMetadata);

const SPECS = {
  colors: ['Burgundy', 'Off White', 'Baby Blue'],
  features: ['Waterproof', 'Anti Slip', 'Machine Washable', 'Eco Friendly'],
  material: 'Cotton',
  sizeType: 'standard',
  size: 'Medium',
  isPattern: true,
  pattern: 'مقلم',
};

describe('Product specs & features — DTO layer', () => {
  it('CreateProductDto carries colors, features and every spec field through the whitelist', async () => {
    const out = await pipe.transform(
      { name: 'Alba Cushion', code: 'ALBA-BRG-M-001', ...SPECS },
      asBody(CreateProductDto),
    );
    expect(out.features).toEqual(SPECS.features);
    expect(out.colors).toEqual(SPECS.colors);
    expect(out.material).toBe('Cotton');
    expect(out.size).toBe('Medium');
    expect(out.sizeType).toBe('standard');
    expect(out.isPattern).toBe(true);
    expect(out.pattern).toBe('مقلم');
  });

  it('strips a property that has no DTO field — why `features` had to be declared', async () => {
    const out = await pipe.transform(
      { name: 'X', features: ['Waterproof'], notADeclaredField: 'dropped' },
      asBody(CreateProductDto),
    );
    expect(out.features).toEqual(['Waterproof']);
    expect((out as Record<string, unknown>).notADeclaredField).toBeUndefined();
  });

  it('UpdateProductDto (edit an existing product) keeps features', async () => {
    const out = await pipe.transform(
      { features: ['Outdoor Use'], colors: ['Olive'] },
      asBody(UpdateProductDto),
    );
    expect(out.features).toEqual(['Outdoor Use']);
    expect(out.colors).toEqual(['Olive']);
  });

  it('ImportProductItemDto (Excel import) keeps features', async () => {
    const out = await pipe.transform(
      { code: 'C1', name: 'N1', features: ['Handmade', 'Recycled Material'] },
      asBody(ImportProductItemDto),
    );
    expect(out.features).toEqual(['Handmade', 'Recycled Material']);
  });

  it('clearing every feature is a real value, not a no-op', async () => {
    const out = await pipe.transform({ features: [] }, asBody(UpdateProductDto));
    expect(out.features).toEqual([]);
  });

  it('rejects a non-string feature and still caps colors at 3', async () => {
    await expect(
      pipe.transform({ name: 'X', features: [{ bad: 1 }] }, asBody(CreateProductDto)),
    ).rejects.toThrow();
    await expect(
      pipe.transform(
        { name: 'X', colors: ['Black', 'White', 'Beige', 'Olive'] },
        asBody(CreateProductDto),
      ),
    ).rejects.toThrow();
  });
});

describe('Product specs & features — Mongoose layer', () => {
  const Product = mongoose.model('ProductFeatureSpec', ProductSchema);

  it('persists features on the document and defaults to []', () => {
    const doc = new Product({ code: 'C', name: 'N', ...SPECS });
    expect(doc.toObject().features).toEqual(SPECS.features);
    expect(new Product({ code: 'C2', name: 'N2' }).toObject().features).toEqual([]);
  });

  it('features survives a full round-trip through toObject/toJSON (what GET /products returns)', () => {
    const doc = new Product({ code: 'C3', name: 'N3', ...SPECS });
    const json = JSON.parse(JSON.stringify(doc.toJSON()));
    expect(json.features).toEqual(SPECS.features);
    expect(json.colors).toEqual(SPECS.colors);
    expect(json.material).toBe('Cotton');
  });

  it('validates without a connection — no required field blocks a spec-only product', async () => {
    const doc = new Product({ code: 'C4', name: 'N4', features: ['Waterproof'] });
    await expect(doc.validate()).resolves.toBeUndefined();
  });
});
