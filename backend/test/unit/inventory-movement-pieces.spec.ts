import { Types } from 'mongoose';
import { InventoryMovementsService } from '../../src/inventory-movements/inventory-movements.service';
import { InventoryMovementsController } from '../../src/inventory-movements/inventory-movements.controller';
import { PERMS_KEY } from '../../src/core/decorators/perms.decorator';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext, Script } from 'vm';
const sift = require('sift').default;
const id = (n: number) => String(n).padStart(24, '0');
const oid = (n: number) => new Types.ObjectId(id(n));

function setup(extra: any = {}) {
  const movement = { _id: oid(1), productId: id(2), sourceTransactionId: id(3), unitIds: [], ...extra };
  const tables: any = {
    inventoryunits: [
      { _id: oid(4), productId: id(2), barcode: 'SU-PIECE', status: 'prepared',
        assignment: { transactionId: id(3) }, origin: { kind: 'purchase', purchaseTransactionId: id(5), reconciliationRef: 'receipt:purchase' } },
      { _id: oid(6), productId: id(2), barcode: 'UNRELATED', assignment: { transactionId: id(9) } },
    ],
    transactions: [{ _id: oid(5), type: 'مشتريات', ref: '900016', date: '2026-10-20' }],
    inventoryunitcodes: [{ _id: oid(4), code: '000000017' }],
    inventoryunitevents: [
      { unitId: id(4), action: 'registered', sequence: 1, createdAt: '2026-10-20T01:10:00Z', details: { warehouseCode: 'MAIN' } },
      { unitId: id(4), transactionId: id(3), action: 'shipped', sequence: 2, createdAt: '2026-10-24T10:40:00Z', details: { fromWarehouseCode: 'MAIN' } },
    ],
  };
  const collection = (name: string) => ({
    find(filter: any) {
      let rows = (tables[name] || []).filter(sift(filter));
      const cursor: any = {
        sort: () => cursor, skip: (n: number) => { rows = rows.slice(n); return cursor; },
        limit: (n: number) => { rows = rows.slice(0, n); return cursor; }, toArray: async () => rows,
      };
      return cursor;
    },
    countDocuments: async (filter: any) => (tables[name] || []).filter(sift(filter)).length,
  });
  const model: any = { findById: () => ({ lean: async () => movement }), db: { collection } };
  return { service: new InventoryMovementsService(model, null as any, null as any), tables, model };
}

describe('Movement piece provenance', () => {
  it('requires the existing identity viewing permission', () => {
    expect(Reflect.getMetadata(PERMS_KEY, InventoryMovementsController.prototype.pieces)).toEqual(['inventory-units-view']);
  });
  it('returns the exact identity, source purchase invoice and recorded custody dates', async () => {
    const { service } = setup();
    const result = await service.movementPieces(id(1));
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ unitId: id(4), manualCode: 'U-0000-0001-7',
      registeredAtReceipt: true, purchase: { id: id(5), ref: '900016', date: '2026-10-20' },
      history: [{ action: 'registered', date: '2026-10-20T01:10:00Z' }, { action: 'shipped', date: '2026-10-24T10:40:00Z' }] });
  });
  it('retains historical dispatched pieces after reassignment', async () => {
    const { service, tables } = setup();
    tables.inventoryunits[0].assignment = { transactionId: id(9) };
    expect((await service.movementPieces(id(1))).total).toBe(1);
  });
  it('does not infer identities from matching product codes or undone picks', async () => {
    const { service, tables } = setup();
    tables.inventoryunits[0].assignment = null;
    tables.inventoryunitevents[1].action = 'picking-undone';
    expect((await service.movementPieces(id(1))).items).toEqual([]);
  });
  it('uses explicit movement membership instead of every piece on the invoice', async () => {
    const { service } = setup({ unitIds: [id(6)] });
    const result = await service.movementPieces(id(1));
    expect(result.items.map(piece => piece.unitId)).toEqual([id(6)]);
    expect(result.items[0]).toMatchObject({ purchase: null, history: [] });
  });
  it('finds purchase units without inventing warehouse entry dates from invoice dates', async () => {
    const { service, tables } = setup({ sourceTransactionId: id(5) });
    tables.inventoryunitevents = [];
    tables.inventoryunits[0].origin.reconciliationRef = 'post-invoice';
    const result = await service.movementPieces(id(1));
    expect(result.items[0]).toMatchObject({ registeredAtReceipt: false, history: [], purchase: { ref: '900016' } });
  });
  it('rejects malformed and missing movement IDs', async () => {
    const { service, model } = setup();
    await expect(service.movementPieces('bad')).rejects.toThrow('Invalid movement ID');
    model.findById = () => ({ lean: async () => null });
    await expect(service.movementPieces(id(1))).rejects.toThrow('Inventory movement not found');
  });
  it('filters other invoice products and paginates large purchase receipts', async () => {
    const { service, tables } = setup({ sourceTransactionId: id(5) });
    for (let n = 10; n < 45; n++) tables.inventoryunits.push({ _id: oid(n), productId: id(2),
      origin: { kind: 'purchase', purchaseTransactionId: id(5) } });
    tables.inventoryunits.push({ _id: oid(99), productId: id(90), origin: { purchaseTransactionId: id(5) } });
    const first = await service.movementPieces(id(1));
    const second = await service.movementPieces(id(1), 2);
    expect(first.total).toBe(36); expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(6);
    expect(second.items.every(piece => !first.items.some(row => row.unitId === piece.unitId))).toBe(true);
  });
});

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const loader = html.match(/async function loadInventoryMovementPieces\([^]*?\n\}/)![0];
describe('Movement piece details UI', () => {
  it('keeps inline scripts syntactically valid', () => {
    for (const match of html.matchAll(/<script\b([^>]*)>([^]*?)<\/script>/gi)) {
      if (/\bsrc\s*=|application\/ld\+json|application\/json/.test(match[1])) continue;
      expect(() => new Script(match[2])).not.toThrow();
    }
  });
  it('renders bilingual empty and retry states and ignores a replaced modal', async () => {
    let host: any = {};
    const context: any = { qs: () => host, currentLang: 'en', api: jest.fn().mockResolvedValue({ total: 0, items: [] }),
      fmtN: String, esc: String, _invLogDateTime: String, window: {} };
    runInNewContext(loader, context);
    await context.loadInventoryMovementPieces(id(1));
    expect(host.innerHTML).toContain('No piece identities linked');
    context.currentLang = 'ar';
    context.api.mockRejectedValueOnce(new Error('offline'));
    await context.loadInventoryMovementPieces(id(1));
    expect(host.innerHTML).toContain('إعادة المحاولة');
    context.api.mockImplementationOnce(async () => { host = { innerHTML: 'another modal' }; return { total: 0, items: [] }; });
    await context.loadInventoryMovementPieces(id(1));
    expect(host.innerHTML).toBe('another modal');
  });
});
