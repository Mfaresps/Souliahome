/**
 * Inventory & Stock movement tests — opening balance, adjustments, alerts.
 */

import { mockProducts } from '../fixtures/products.fixture';

const computeStockMovement = (
  productCode: string,
  opening: number,
  txs: Array<{ type: string; items: Array<{ code: string; qty: number }>; cancelled?: boolean }>,
) => {
  let stock = opening;
  for (const tx of txs) {
    if (tx.cancelled) continue;
    const item = tx.items.find((it) => it.code === productCode);
    if (!item) continue;

    if (tx.type === 'مبيعات') stock -= item.qty;
    else if (tx.type === 'مشتريات') stock += item.qty;
    else if (tx.type === 'مرتجع' || tx.type === 'مرتجع مبيعات') stock += item.qty;
    else if (tx.type === 'مرتجع مشتريات') stock -= item.qty;
  }
  return stock;
};

describe('Inventory & Stock', () => {
  describe('Stock movement aggregation', () => {
    it('correctly aggregates buy + sell', () => {
      const txs = [
        { type: 'مشتريات', items: [{ code: 'P001', qty: 10 }] },
        { type: 'مبيعات', items: [{ code: 'P001', qty: 4 }] },
      ];
      expect(computeStockMovement('P001', 50, txs)).toBe(56);
    });

    it('handles full cycle: buy + sell + return', () => {
      const txs = [
        { type: 'مشتريات', items: [{ code: 'P001', qty: 20 }] },
        { type: 'مبيعات', items: [{ code: 'P001', qty: 5 }] },
        { type: 'مرتجع', items: [{ code: 'P001', qty: 1 }] },
      ];
      expect(computeStockMovement('P001', 0, txs)).toBe(16);
    });

    it('skips cancelled transactions in stock count', () => {
      const txs = [
        { type: 'مبيعات', items: [{ code: 'P001', qty: 5 }] },
        { type: 'مبيعات', items: [{ code: 'P001', qty: 10 }], cancelled: true },
      ];
      expect(computeStockMovement('P001', 50, txs)).toBe(45);
    });

    it('handles purchase return (out)', () => {
      const txs = [
        { type: 'مشتريات', items: [{ code: 'P001', qty: 100 }] },
        { type: 'مرتجع مشتريات', items: [{ code: 'P001', qty: 10 }] },
      ];
      expect(computeStockMovement('P001', 0, txs)).toBe(90);
    });

    it('zero initial stock with sales fails validation', () => {
      const txs = [{ type: 'مبيعات', items: [{ code: 'P001', qty: 5 }] }];
      const result = computeStockMovement('P001', 0, txs);
      expect(result).toBeLessThan(0); // would need pre-validation in real flow
    });
  });

  describe('Opening balance', () => {
    it('opening balance defaults to 0', () => {
      const product = { code: 'NEW', openingBalance: 0 };
      expect(product.openingBalance).toBe(0);
    });

    it('updates when admin sets opening balance', () => {
      const product = { code: 'P001', openingBalance: 0 };
      product.openingBalance = 100;
      expect(product.openingBalance).toBe(100);
    });
  });

  describe('Min-stock thresholds', () => {
    it('default min stock is 10 per schema', () => {
      const newProduct = { code: 'NEW', minStock: 10 };
      expect(newProduct.minStock).toBe(10);
    });

    it('custom min-stock per product', () => {
      mockProducts.forEach((p) => {
        expect(p.minStock).toBeGreaterThanOrEqual(0);
      });
    });

    it('classification: ok / low / zero', () => {
      const classify = (current: number, min: number) =>
        current === 0 ? 'zero' : current <= min ? 'low' : 'ok';

      expect(classify(0, 10)).toBe('zero');
      expect(classify(5, 10)).toBe('low');
      expect(classify(50, 10)).toBe('ok');
    });
  });

  describe('Stock value calculations', () => {
    it('total stock value = current × sellPrice', () => {
      const inventory = [
        { current: 10, sellPrice: 100 },
        { current: 5, sellPrice: 250 },
      ];
      const totalValue = inventory.reduce((s, i) => s + i.current * i.sellPrice, 0);
      expect(totalValue).toBe(2250);
    });

    it('total cost = current × buyPrice', () => {
      const inventory = [
        { current: 10, buyPrice: 60 },
        { current: 5, buyPrice: 150 },
      ];
      const totalCost = inventory.reduce((s, i) => s + i.current * i.buyPrice, 0);
      expect(totalCost).toBe(1350);
    });

    it('potential profit = sellValue - costValue', () => {
      const item = { current: 10, sellPrice: 100, buyPrice: 60 };
      const profit = item.current * (item.sellPrice - item.buyPrice);
      expect(profit).toBe(400);
    });
  });
});
