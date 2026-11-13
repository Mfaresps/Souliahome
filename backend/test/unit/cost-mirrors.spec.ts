import * as fs from 'fs';
import * as path from 'path';
import { LINE_COST_SOURCES, LINE_COST_SOURCE_KEYS } from '../../src/shared/line-cost.util';
import { currentUnitCost } from '../../src/shared/avg-cost.util';
import { effectiveSellPrice } from '../../src/shared/price-offer.util';
import { ProductCostEventSchema } from '../../src/products/schemas/product-cost-event.schema';
import { ProductSupplierSchema } from '../../src/suppliers/schemas/product-supplier.schema';

export {};

/**
 * The frontend keeps hand-written copies of the cost rules. Each copy is read from the SHIPPED
 * index.html (never re-typed here), so a change on one side only fails this suite.
 */
// Line endings depend on the checkout (core.autocrlf) — compare the text, not the bytes.
const html = fs.readFileSync(path.join(__dirname, '../../../frontend/public/index.html'), 'utf8').replace(/\r\n/g, '\n');

function extract(re: RegExp, what: string): string {
  const m = html.match(re);
  if (!m) throw new Error(`not found in index.html: ${what}`);
  return m[1];
}
const enumOf = (schema: any, p: string): string[] => schema.path(p).enumValues;

describe('frontend cost mirrors match the backend', () => {
  it('profit analysis trusts exactly LINE_COST_SOURCES', () => {
    const list = extract(/Same list as LINE_COST_SOURCES[^\n]*\n\s*const frozen = (\[[^\]]+\])\.includes/, 'frozen list');
    expect(JSON.parse(list.replace(/'/g, '"'))).toEqual([...LINE_COST_SOURCES]);
  });

  it('cost-source panel has one row per backend key, in the same order', () => {
    const block = extract(/const _REP_COST_SRC = \[([\s\S]*?)\n\];/, '_REP_COST_SRC');
    const keys = [...block.matchAll(/key: '([^']+)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...LINE_COST_SOURCE_KEYS]);
  });

  it('cost history labels every event kind', () => {
    const block = extract(/const _AC_KIND_KEY = \{([\s\S]*?)\};/, '_AC_KIND_KEY');
    const kinds = [...block.matchAll(/'?([a-z-]+)'?\s*:\s*'ac/g)].map((m) => m[1]);
    expect(kinds.sort()).toEqual([...enumOf(ProductCostEventSchema, 'kind')].sort());
    for (const key of [...block.matchAll(/:\s*'(ac[A-Za-z]+)'/g)].map((m) => m[1])) {
      expect(html).toMatch(new RegExp(`\\b${key}:\\{ar:'[^']+',en:'[^']+'\\}`));
    }
  });

  it('supplier-price labels cover every priceSource', () => {
    expect(enumOf(ProductSupplierSchema, 'priceSource')).toEqual(['purchase', 'manual']);
    // A purchase price names its invoice (or «فاتورة شراء» without one); anything else is manual.
    const row = extract(/(function _psRowHtml\(r, low\) \{[\s\S]*?\n\})/, '_psRowHtml');
    expect(row).toMatch(/const source = r\.priceSource === 'purchase'/);
    for (const key of ['psFromInvoice', 'psFromPurchase', 'psManual']) expect(row).toContain(`t('${key}'`);
  });

  it('_effectiveSellPrice gives the same price as the server (offers)', () => {
    const src = extract(/(function _offerActiveOn\(o, day\) \{[\s\S]*?\n\}\nfunction _effectiveSellPrice\(p, day\) \{[\s\S]*?\n\})/, '_effectiveSellPrice');
    // eslint-disable-next-line no-new-func
    const fe = new Function(`${src}; return _effectiveSellPrice;`)();
    const p = { sellPrice: 1000, priceOffers: [
      { id: 'a', price: 800, from: '2026-11-10', to: '2026-11-20' },
      { id: 'b', price: 700, from: '2026-12-01', to: '2026-12-05', cancelled: true },
      { id: 'c', price: 900, from: '2026-11-25', to: '2026-11-30', endedOn: '2026-11-27' },
    ] };
    for (const day of ['2026-11-09', '2026-11-10', '2026-11-20', '2026-11-21', '2026-11-26', '2026-11-27', '2026-12-02', 'bad']) {
      const a = fe(p, day), b = effectiveSellPrice(p, day);
      expect([a.price, a.listPrice, a.offer?.id ?? null]).toEqual([b.price, b.listPrice, b.offer?.id ?? null]);
    }
  });

  it('_unitCostOf gives the same cost as currentUnitCost', () => {
    const src = extract(/(function _unitCostOf\(r\) \{[\s\S]*?\n\})/, '_unitCostOf');
    // eslint-disable-next-line no-new-func
    const fe = new Function(`${src}; return _unitCostOf;`)();
    const cases = [
      { avgCost: null, buyPrice: 300 }, { buyPrice: 300 }, { avgCost: 0, buyPrice: 300 }, { avgCost: 117.5, buyPrice: 300 },
      { avgCost: null, buyPrice: 0 }, { avgCost: null, buyPrice: -5 }, { avgCost: -1, buyPrice: 40 }, { avgCost: 'x', buyPrice: 40 }, {},
    ];
    for (const c of cases) expect(fe(c)).toBe(currentUnitCost(c as any));
  });
});
