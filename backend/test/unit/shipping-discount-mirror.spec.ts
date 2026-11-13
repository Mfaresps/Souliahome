/**
 * The browser keeps a hand-written copy of the shipping-discount rule (index.html `_sale*` helpers,
 * invoice-image.js). This reads the SHIPPED files — never a copy — and checks they give exactly the
 * backend's figures (shared/sale-discount.util.ts), and that the screens that must use them do.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  invoiceDiscount, invoiceItemsTotal, invoiceShipCharged, invoiceShippingDiscount,
} from '../../src/shared/sale-discount.util';

export {};

const PUB = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const imageJs = fs.readFileSync(path.join(PUB, 'invoice-image.js'), 'utf8');

function fnSrc(name: string): string {
  const m = new RegExp('\\nfunction ' + name + '\\(').exec(html);
  if (!m) throw new Error('missing ' + name);
  return html.slice(m.index + 1, html.indexOf('\n}\n', m.index + 1) + 3);
}
const fe = new Function(
  ['_saleItemsTotal', '_saleShipDisc', '_saleShipCharged', '_saleProductDiscount', '_saleStoredProductDiscount'].map(fnSrc).join('\n')
  + '; return { _saleItemsTotal, _saleShipDisc, _saleShipCharged, _saleProductDiscount, _saleStoredProductDiscount };',
)();

// Deterministic pseudo-random cases, including legacy rows (no stored discount), over-large
// shipping discounts, string values and missing fields.
function cases(): any[] {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const out: any[] = [
    {}, { itemsTotal: 2470, discount: 120, shipCost: 120, total: 2470 },
    { itemsTotal: 2470, discount: 120, shipCost: 120, total: 2470, shippingDiscount: 120 },
    { itemsTotal: 1000, discount: 0, shipCost: 50, total: 950 },
    { items: [{ total: 500 }, { total: 300 }], discount: 220, shipCost: 120, total: 700, shippingDiscount: 120 },
    { itemsTotal: '1500', discount: '170', shipCost: '120', total: '1450', shippingDiscount: '120' },
    { itemsTotal: 1000, discount: 120, shipCost: 100, total: 980, shippingDiscount: 500 },
    { total: 900, shipCost: 100 },
  ];
  for (let i = 0; i < 400; i++) {
    const items = Math.round(rnd() * 5000);
    const ship = [0, 50, 85, 120][Math.floor(rnd() * 4)];
    const disc = rnd() < 0.3 ? 0 : Math.round(rnd() * (items / 2 + ship));
    const sd = rnd() < 0.5 ? 0 : Math.round(rnd() * 200);
    out.push({ itemsTotal: rnd() < 0.1 ? 0 : items, items: [{ total: items }], discount: disc, shipCost: ship,
      total: Math.max(0, items - disc + ship) + (rnd() < 0.2 ? -Math.round(rnd() * 50) : 0), ...(sd ? { shippingDiscount: sd } : {}) });
  }
  return out;
}

describe('browser shipping-discount rule = server rule', () => {
  it('gives the server figures on 408 cases', () => {
    for (const tx of cases()) {
      expect(fe._saleItemsTotal(tx)).toBeCloseTo(invoiceItemsTotal(tx), 9);
      expect(fe._saleShipDisc(tx)).toBeCloseTo(invoiceShippingDiscount(tx), 9);
      expect(fe._saleShipCharged(tx)).toBeCloseTo(invoiceShipCharged(tx), 9);
      expect(fe._saleProductDiscount(tx)).toBeCloseTo(invoiceDiscount(tx), 9);
      // The display rule (no inference): stored discount minus the shipping part.
      expect(fe._saleStoredProductDiscount(tx)).toBeCloseTo(Math.max(0, (Number(tx.discount) || 0) - invoiceShippingDiscount(tx)), 9);
    }
  });
  it('a row without the field reads exactly as before', () => {
    const tx = { itemsTotal: 2470, discount: 120, shipCost: 120, total: 2470 };
    expect(fe._saleShipDisc(tx)).toBe(0);
    expect(fe._saleShipCharged(tx)).toBe(120);
    expect(fe._saleStoredProductDiscount(tx)).toBe(120);
  });
});

describe('screens use the rule', () => {
  it('refund cap (getRetRefundCeiling) subtracts only the product discount, like returns-validation', () => {
    expect(fnSrc('getRetRefundCeiling')).toContain('const invDiscount = _saleStoredProductDiscount(tx);');
  });
  it('profit analysis subtracts the subsidy, so net profit is unchanged', () => {
    const src = fnSrc('openProfitAnalysis');
    expect(src).toContain('const discount  = _saleStoredProductDiscount(tx);');
    expect(src).toContain('revenue - cost - shipLoss + shipSaving - discount - shipSubsidy');
  });
  it('Movements and the admin briefing subtract the shipping actually charged', () => {
    expect(fnSrc('renderMovementsLegacy')).toContain('Math.max(0, (t.total || 0) - _saleShipCharged(t))');
    expect(fnSrc('renderAdminBriefing')).toContain('(Number(t.total) || 0) - _saleShipCharged(t)');
  });
  it('the invoice edit window keeps the free shipping outside the manual discount', () => {
    for (const fn of ['_syncEditAppliedCodesToInputs', 'removeEditDiscount', 'removeEditSummaryCode', 'removeEditSummaryManualDisc']) {
      expect(fnSrc(fn)).toContain('editShipDiscount');
    }
    expect(html).toContain("editShipDiscount = tx.type === 'مبيعات' ? _saleShipDisc(tx) : 0;");
  });
  it('invoice-image.js applies the same clamp', () => {
    expect(imageJs).toContain('Math.min(Math.max(0, Number(tx.shippingDiscount) || 0), Math.max(0, Number(tx.shipCost) || 0), Math.max(0, Number(tx.discount) || 0))');
  });
  it('every new label exists in Arabic and English', () => {
    const keys = ['sdFreeShipping', 'sdShipDiscount', 'sdShipSubsidy', 'sdShipSubsidyHint', 'sdShipCollected', 'sdProductRevenue', 'sdProductDiscounts',
      'sdActualCarrierCost', 'sdKnownOf', 'sdProfitBeforeShip', 'sdProfitAfterShip', 'sdEffectiveSince', 'sdBeforeEffective', 'sdShipCodesHead', 'sdGroupTitle', 'sdGroupNote'];
    for (const k of keys) expect(html).toMatch(new RegExp(`\\n  ${k}:\\{ar:'[^']+',en:'[^']+'\\}`));
  });
});
