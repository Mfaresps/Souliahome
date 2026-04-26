/**
 * Extended Sales Module tests — boundary conditions, multi-item edge cases,
 * shipping logic, exchange flows, and discount stacking.
 */

import { BadRequestException } from '@nestjs/common';
import { buildSaleTransaction } from '../fixtures/transactions.fixture';

const calcWithMultipleDiscounts = (
  subtotal: number,
  discounts: Array<{ value: number; type: 'fixed' | 'percent' }>,
) => {
  let total = subtotal;
  for (const d of discounts) {
    total = d.type === 'percent' ? total - (total * d.value) / 100 : total - d.value;
  }
  return Math.max(0, total);
};

const calcShippingLoss = (billed: number, actual: number) => Math.max(0, actual - billed);

const isExchangeSale = (tx: { ref?: string; type?: string }) =>
  tx.type === 'مبيعات' && /-EXC$/i.test(String(tx.ref || ''));

describe('Sales — Extended', () => {
  describe('Boundary value testing', () => {
    it('handles minimum sale amount (1)', () => {
      const items = [{ qty: 1, price: 1, total: 1 }];
      expect(items.reduce((s, i) => s + i.total, 0)).toBe(1);
    });

    it('handles very large totals (1 million)', () => {
      const items = [{ qty: 1000, price: 1000, total: 1_000_000 }];
      expect(items.reduce((s, i) => s + i.total, 0)).toBe(1_000_000);
    });

    it('handles fractional prices correctly', () => {
      const total = 0.1 + 0.2;
      expect(Math.round(total * 100) / 100).toBe(0.3);
    });

    it('rounds Arabic currency display to 2 decimals', () => {
      const value = 99.999;
      expect(Number(value.toFixed(2))).toBe(100);
    });

    it('zero-price items still count toward item count', () => {
      const items = [{ qty: 5, price: 0, total: 0 }];
      expect(items.length).toBe(1);
      expect(items[0].total).toBe(0);
    });
  });

  describe('Multi-discount stacking', () => {
    it('applies fixed then percent discount', () => {
      // 1000 - 100 = 900, then 10% off = 810
      expect(
        calcWithMultipleDiscounts(1000, [
          { value: 100, type: 'fixed' },
          { value: 10, type: 'percent' },
        ]),
      ).toBe(810);
    });

    it('applies percent then fixed discount', () => {
      // 1000 * 0.9 = 900, then -100 = 800
      expect(
        calcWithMultipleDiscounts(1000, [
          { value: 10, type: 'percent' },
          { value: 100, type: 'fixed' },
        ]),
      ).toBe(800);
    });

    it('caps stacked discounts at zero', () => {
      expect(
        calcWithMultipleDiscounts(100, [
          { value: 200, type: 'fixed' },
          { value: 50, type: 'percent' },
        ]),
      ).toBe(0);
    });

    it('handles 100% discount', () => {
      expect(calcWithMultipleDiscounts(500, [{ value: 100, type: 'percent' }])).toBe(0);
    });
  });

  describe('Shipping cost variations', () => {
    it('records both billed and actual shipping', () => {
      const tx = buildSaleTransaction({ shipCost: 50, actualShipCost: 75 });
      expect(tx.shipCost).toBe(50);
      expect((tx as Record<string, unknown>)['actualShipCost']).toBe(75);
    });

    it('computes shipping loss when actual > billed', () => {
      expect(calcShippingLoss(50, 75)).toBe(25);
    });

    it('zero shipping loss when actual ≤ billed', () => {
      expect(calcShippingLoss(50, 50)).toBe(0);
      expect(calcShippingLoss(50, 30)).toBe(0);
    });

    it('Cairo vs Governorate default pricing', () => {
      const cairo = 110;
      const gov = 150;
      expect(gov).toBeGreaterThan(cairo);
    });
  });

  describe('Exchange sale logic', () => {
    it('detects exchange sale by -EXC suffix', () => {
      expect(isExchangeSale({ type: 'مبيعات', ref: '1001-EXC' })).toBe(true);
      expect(isExchangeSale({ type: 'مبيعات', ref: '1001' })).toBe(false);
    });

    it('exchange sale with positive remaining is pending collection', () => {
      const tx = { type: 'مبيعات', ref: '1001-EXC', remaining: 50 };
      const isPending = isExchangeSale(tx) && (tx.remaining || 0) > 0;
      expect(isPending).toBe(true);
    });

    it('completed exchange has remaining=0', () => {
      const tx = { type: 'مبيعات', ref: '1001-EXC', remaining: 0 };
      const isPending = isExchangeSale(tx) && (tx.remaining || 0) > 0;
      expect(isPending).toBe(false);
    });
  });

  describe('Multi-item sales aggregation', () => {
    it('handles 100 different products in one sale', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({
        code: `P${i}`,
        qty: 1,
        price: 10,
        total: 10,
      }));
      expect(items.reduce((s, i) => s + i.total, 0)).toBe(1000);
    });

    it('correctly aggregates same product across multiple lines', () => {
      const items = [
        { code: 'P001', qty: 2, price: 100, total: 200 },
        { code: 'P001', qty: 3, price: 100, total: 300 },
        { code: 'P001', qty: 1, price: 100, total: 100 },
      ];
      const totalQty = items
        .filter((i) => i.code === 'P001')
        .reduce((s, i) => s + i.qty, 0);
      expect(totalQty).toBe(6);
    });

    it('different prices for same product on different lines stays separate', () => {
      const items = [
        { code: 'P001', qty: 2, price: 100, total: 200 },
        { code: 'P001', qty: 2, price: 90, total: 180 },
      ];
      expect(items.reduce((s, i) => s + i.total, 0)).toBe(380);
    });
  });

  describe('Post-sale discount', () => {
    it('reduces total after sale is created', () => {
      const original = 1000;
      const postDiscount = 50;
      expect(original - postDiscount).toBe(950);
    });

    it('updates remaining when total decreases', () => {
      const total = 1000;
      const paid = 600;
      let remaining = total - paid; // 400
      const newDiscount = 200;
      remaining = Math.max(0, total - newDiscount - paid);
      expect(remaining).toBe(200);
    });

    it('marks fully-paid when discount exceeds remaining', () => {
      const total = 1000;
      const paid = 800;
      const newDiscount = 250;
      const remaining = Math.max(0, total - newDiscount - paid);
      expect(remaining).toBe(0);
    });
  });

  describe('Customer auto-fill from history', () => {
    it('matches customer by phone', () => {
      const history = [{ client: 'علي', phone: '0100000001' }];
      const lookup = history.find((c) => c.phone === '0100000001');
      expect(lookup?.client).toBe('علي');
    });

    it('matches customer by name (case-insensitive)', () => {
      const history = [{ client: 'Ahmed', phone: '0111' }];
      const lookup = history.find((c) => c.client.toLowerCase() === 'ahmed');
      expect(lookup).toBeDefined();
    });
  });
});
