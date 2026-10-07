import * as fs from 'fs';
import * as path from 'path';
import {
  parseBostaPricing,
  decideSettlement,
  BostaPricing,
} from '../../src/shared/bosta-pricing.util';

/**
 * The automatic Bosta settlement turns these two functions' output straight into vault entries,
 * so every row of the decision table is pinned here.
 *
 * The fixture is order #2638's real `GET /deliveries/:id` body (customer data removed): Bosta's
 * dashboard shows «مستحقات بوسطة 114.00» for it, collected 510.
 */
const FIXTURE = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/bosta-delivery-2638.json'), 'utf8'),
);

const priced = (over: Partial<BostaPricing> = {}): BostaPricing => ({
  priceAfterVat: 114, priceBeforeVat: 100, shippingFee: 95, sizeEffectCost: 5, insurance: 5, vatRate: 0.14,
  sizeName: 'Large', cod: 510, deliveredAt: '2026-09-30T10:26:48.754Z', isDelivered: true, priceChanges: [], ...over,
});

const input = (over: any = {}) => ({
  remaining: 510, billedShip: 120, pricing: priced(), hasOpenConflict: false, hasPriorCollection: false, reviewLimit: 20, ...over,
});

describe('parseBostaPricing — the real #2638 payload', () => {
  const p = parseBostaPricing(FIXTURE)!;

  it('reads the final price Bosta shows on its dashboard', () => {
    expect(p.priceAfterVat).toBe(114);
    expect(p.priceBeforeVat).toBe(100);
    expect(p.shippingFee).toBe(95);
    expect(p.insurance).toBe(5);
    expect(p.vatRate).toBe(0.14);
    expect(p.sizeName).toBe('Large');
  });

  it('reads the COD and the delivery time', () => {
    expect(p.cod).toBe(510);
    expect(p.isDelivered).toBe(true);
    expect(p.deliveredAt).toBe('2026-09-30T10:26:48.754Z');
  });

  it('records why the price moved: the hub reclassified Normal → Large, 108.30 → 114', () => {
    expect(p.priceChanges).toHaveLength(1);
    expect(p.priceChanges[0]).toMatchObject({ byRole: 'HUB_COORDINATOR', priceBefore: 108.3, priceAfter: 114, sizeBefore: 'Normal', sizeAfter: 'Large' });
  });

  it('accepts the REST wrapper as well as the flat webhook body', () => {
    expect(parseBostaPricing({ data: FIXTURE })!.priceAfterVat).toBe(114);
  });

  it('the LAST closing price wins when Bosta writes more than one', () => {
    const early = { time: '2026-09-30T08:00:00Z', takenBy: {}, actionsList: { pricing: { after: { priceAfterVat: 108.3, priceBeforeVat: 95, shippingFee: 90 } } } };
    const p2 = parseBostaPricing({ ...FIXTURE, log: [early, ...FIXTURE.log] })!;
    expect(p2.priceAfterVat).toBe(114);
  });

  it('returns null when no log entry states a price', () => {
    expect(parseBostaPricing({ ...FIXTURE, log: [] })).toBeNull();
    expect(parseBostaPricing(null)).toBeNull();
  });

  it('never reads the plan-level material fee (55 on every order, not a deduction)', () => {
    expect(JSON.stringify(p)).not.toContain('55');
  });
});

describe('decideSettlement — the decision table', () => {
  it('#2638: Bosta took 114 against a 120 tariff → settle 396, saving 6', () => {
    const d = decideSettlement(input());
    expect(d).toMatchObject({ outcome: 'settle', fees: 114, net: 396, collectNet: 396, shortfall: 0, variance: -6, varianceKind: 'saving', shipSavingAdd: 6, shipLossAdd: 0 });
  });

  it('a variance under 1 EGP is a match, settled on the exact figures', () => {
    const d = decideSettlement(input({ remaining: 470, pricing: priced({ priceAfterVat: 119.7, cod: 470 }) }));
    expect(d).toMatchObject({ outcome: 'settle', varianceKind: 'match', net: 350.3, shipSavingAdd: 0.3 });
  });

  it('a small overcharge settles and books the excess as shipping loss', () => {
    const d = decideSettlement(input({ remaining: 870, pricing: priced({ priceAfterVat: 125.4, cod: 870 }) }));
    expect(d).toMatchObject({ outcome: 'settle', varianceKind: 'over-small', shipLossAdd: 5.4, net: 744.6 });
  });

  it('an overcharge above the limit stops for review and books nothing', () => {
    const d = decideSettlement(input({ remaining: 990, billedShip: 145, pricing: priced({ priceAfterVat: 193.8, cod: 990 }) }));
    expect(d).toMatchObject({ outcome: 'review', reason: 'variance-over-limit', varianceKind: 'over-large' });
  });

  it('the limit is inclusive: exactly 20 over still settles', () => {
    expect(decideSettlement(input({ pricing: priced({ priceAfterVat: 140 }) })).outcome).toBe('settle');
  });

  it('an approver may settle an over-limit order', () => {
    const d = decideSettlement(input({ remaining: 990, billedShip: 145, pricing: priced({ priceAfterVat: 193.8, cod: 990 }), allowOverLimit: true }));
    expect(d).toMatchObject({ outcome: 'settle', net: 796.2, shipLossAdd: 48.8 });
  });

  it('#2022: fees exceed what Bosta collected → nothing collected, the gap leaves the vault', () => {
    const d = decideSettlement(input({ remaining: 120, pricing: priced({ priceAfterVat: 135.66, cod: 120 }) }));
    expect(d).toMatchObject({ outcome: 'settle', net: -15.66, collectNet: 0, shortfall: 15.66, shipLossAdd: 15.66 });
  });

  it('a prepaid order is a pure shipping outflow', () => {
    const d = decideSettlement(input({ remaining: 0, pricing: priced({ cod: 0 }) }));
    expect(d).toMatchObject({ outcome: 'settle', net: -114, collectNet: 0, shortfall: 114, shipSavingAdd: 6 });
  });

  it('free shipping (no billed tariff) settles without a comparison and books the whole fee as loss', () => {
    const d = decideSettlement(input({ billedShip: 0, pricing: priced({ priceAfterVat: 140 }) }));
    expect(d).toMatchObject({ outcome: 'settle', varianceKind: 'not-billed', shipLossAdd: 140, shipSavingAdd: 0 });
  });

  it('a COD that disagrees with our remaining stops before any price judgement', () => {
    const d = decideSettlement(input({ pricing: priced({ cod: 650 }) }));
    expect(d).toMatchObject({ outcome: 'review', reason: 'cod-mismatch' });
  });

  it('an open conflict stops the settlement', () => {
    expect(decideSettlement(input({ hasOpenConflict: true })).reason).toBe('open-conflict');
  });

  it('a prior collection stops the settlement (netting assumes none)', () => {
    expect(decideSettlement(input({ hasPriorCollection: true })).reason).toBe('prior-payment');
  });

  it('no pricing → skipped, left to manual collection', () => {
    expect(decideSettlement(input({ pricing: null }))).toMatchObject({ outcome: 'skip', reason: 'no-pricing' });
  });

  it('a delivery Bosta does not report as delivered is skipped', () => {
    expect(decideSettlement(input({ pricing: priced({ isDelivered: false }) }))).toMatchObject({ outcome: 'skip', reason: 'not-delivered' });
  });

  it('rounds float noise to piastres before comparing', () => {
    const d = decideSettlement(input({ remaining: 2440, billedShip: 145, pricing: priced({ priceAfterVat: 156.63600000000002, cod: 2440 }) }));
    expect(d).toMatchObject({ fees: 156.64, variance: 11.64, net: 2283.36 });
  });
});
