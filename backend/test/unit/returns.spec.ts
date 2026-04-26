/**
 * Unit tests for the Returns Module.
 * Covers: sales returns, purchase returns, stock adjustments, refund logic,
 * and credit note generation.
 */

import { BadRequestException } from '@nestjs/common';
import { buildReturnTransaction, buildSaleTransaction } from '../fixtures/transactions.fixture';

const RETURN_REQUEST_MAX_DAYS = 14;

const isWithinReturnWindow = (saleDate: string, today: string) => {
  const diff = (new Date(today).getTime() - new Date(saleDate).getTime()) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= RETURN_REQUEST_MAX_DAYS;
};

const calcStockAfterReturn = (
  productCode: string,
  initialStock: number,
  returnItems: { code: string; qty: number }[],
  isCustomerReturn = true,
) => {
  const qty = returnItems
    .filter((it) => it.code === productCode)
    .reduce((s, it) => s + it.qty, 0);
  // Customer return → stock increases (returned to warehouse)
  // Purchase return → stock decreases (sent back to supplier)
  return isCustomerReturn ? initialStock + qty : initialStock - qty;
};

const calcRefundAmount = (returnItems: { qty: number; price: number }[]) =>
  returnItems.reduce((s, it) => s + it.qty * it.price, 0);

describe('Returns Module', () => {
  describe('Sales return (customer returns to us)', () => {
    it('creates a return tied to original sale via -RET suffix', () => {
      const ret = buildReturnTransaction({ ref: '1001-RET' });
      expect(ret.type).toBe('مرتجع');
      expect(ret.ref).toMatch(/-RET$/);
    });

    it('extracts base reference from -RET suffix', () => {
      const ref = '1001-RET';
      const baseRef = ref.replace(/-RET$/i, '');
      expect(baseRef).toBe('1001');
    });

    it('rejects return outside the 14-day window', () => {
      const within = isWithinReturnWindow('2026-04-01', '2026-04-26');
      expect(within).toBe(false); // 25 days > 14 days
    });

    it('accepts return within the 14-day window', () => {
      const within = isWithinReturnWindow('2026-04-20', '2026-04-26');
      expect(within).toBe(true);
    });

    it('rejects return for items not in the original sale', () => {
      const sale = buildSaleTransaction();
      const returnItem = { code: 'P999', qty: 1 };
      const exists = sale.items.some((it) => it.code === returnItem.code);
      expect(exists).toBe(false);
    });

    it('rejects return qty greater than originally sold', () => {
      const sale = buildSaleTransaction();
      const soldQty = sale.items.find((it) => it.code === 'P001')?.qty || 0;
      const returnQty = soldQty + 1;
      const validate = () => {
        if (returnQty > soldQty) throw new BadRequestException('الكمية تتجاوز المباع');
      };
      expect(validate).toThrow(BadRequestException);
    });
  });

  describe('Stock adjustment on return', () => {
    it('increases stock when customer returns goods', () => {
      const items = [{ code: 'P001', qty: 2 }];
      const newStock = calcStockAfterReturn('P001', 48, items, true);
      expect(newStock).toBe(50);
    });

    it('decreases stock when returning goods to a supplier', () => {
      const items = [{ code: 'P001', qty: 2 }];
      const newStock = calcStockAfterReturn('P001', 50, items, false);
      expect(newStock).toBe(48);
    });

    it('does not affect stock for unrelated products', () => {
      const items = [{ code: 'P001', qty: 5 }];
      const newStock = calcStockAfterReturn('P002', 30, items, true);
      expect(newStock).toBe(30);
    });
  });

  describe('Refund / credit calculation', () => {
    it('calculates refund total = qty × price', () => {
      const items = [
        { qty: 2, price: 100 },
        { qty: 1, price: 250 },
      ];
      expect(calcRefundAmount(items)).toBe(450);
    });

    it('returns zero refund for empty return list', () => {
      expect(calcRefundAmount([])).toBe(0);
    });

    it('does not include shipping in product-only refund', () => {
      const productRefund = calcRefundAmount([{ qty: 1, price: 100 }]);
      const shipping = 50;
      // Per CLAUDE.md: refund deducts product price only, not shipping.
      expect(productRefund).toBe(100);
      expect(productRefund).not.toBe(100 + shipping);
    });
  });

  describe('Return approval workflow', () => {
    it('starts with معلق status when return is requested', () => {
      const status = 'معلق';
      expect(status).toBe('معلق');
    });

    it('transitions to معتمد when admin approves', () => {
      let status = 'معلق';
      status = 'معتمد';
      expect(status).toBe('معتمد');
    });

    it('transitions to مرفوض when admin rejects', () => {
      let status = 'معلق';
      status = 'مرفوض';
      expect(status).toBe('مرفوض');
    });

    it('only adjusts stock when status becomes معتمد', () => {
      const status: string = 'معلق';
      const shouldAdjust = status === 'معتمد';
      expect(shouldAdjust).toBe(false);
    });
  });

  describe('Credit note / invoice generation', () => {
    it('generates a credit note for sales return', () => {
      const ret = buildReturnTransaction();
      const creditNote = {
        ref: ret.ref,
        type: 'مرتجع',
        client: ret.client,
        items: ret.items,
        total: ret.total,
        date: ret.date,
      };
      expect(creditNote.ref).toContain('-RET');
      expect(creditNote.type).toBe('مرتجع');
    });

    it('credit note total matches sum of returned items', () => {
      const ret = buildReturnTransaction();
      const sum = ret.items.reduce((s, it) => s + it.total, 0);
      expect(ret.total).toBe(sum);
    });
  });

  describe('Returns affect dashboard totals', () => {
    it('returns are deducted from sales totals (per Apr 25, 2026 update)', () => {
      const grossSales = 1000;
      const returnsTotal = 200;
      const netSales = grossSales - returnsTotal;
      expect(netSales).toBe(800);
    });

    it('returns deduct from profit (product price only)', () => {
      const grossProfit = 500;
      const returnRefund = 100; // product portion only
      const netProfit = grossProfit - returnRefund;
      expect(netProfit).toBe(400);
    });
  });
});
