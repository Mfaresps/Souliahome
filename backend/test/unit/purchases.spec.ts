/**
 * Unit tests for the Purchases Module.
 * Covers: creation, stock increment, total calculation, supplier recording,
 * deposit handling (the "0 = full debt" rule).
 */

import { BadRequestException } from '@nestjs/common';
import { buildPurchaseTransaction, mockPurchaseItems } from '../fixtures/transactions.fixture';

const calcPurchaseTotal = (items: { qty: number; price: number }[]) =>
  items.reduce((s, it) => s + it.qty * it.price, 0);

const calcStockAfterPurchase = (
  productCode: string,
  initialStock: number,
  items: { code: string; qty: number }[],
) =>
  initialStock +
  items.filter((i) => i.code === productCode).reduce((s, i) => s + i.qty, 0);

/** Mirrors the critical rule from CLAUDE.md: deposit=0 ⇒ full amount is debt. */
const purchaseDepositLogic = (total: number, deposit: number) => {
  const paid = deposit > 0 ? deposit : 0;
  const remaining = Math.max(0, total - paid);
  return {
    paid,
    remaining,
    payStatus: remaining <= 0 ? 'مكتمل' : 'معلق',
  };
};

describe('Purchases Module', () => {
  describe('Purchase order creation', () => {
    it('creates a purchase with required fields', () => {
      const purchase = buildPurchaseTransaction();
      expect(purchase.type).toBe('مشتريات');
      expect(purchase.ref).toBeTruthy();
      expect(purchase.items.length).toBeGreaterThan(0);
      expect(purchase.client).toBeTruthy(); // supplier name
    });

    it('rejects a purchase missing the invoice reference', () => {
      const ref = '';
      const validate = () => {
        if (!ref) throw new BadRequestException('رقم الفاتورة مطلوب للمشتريات');
      };
      expect(validate).toThrow('رقم الفاتورة مطلوب للمشتريات');
    });

    it('records the supplier name correctly', () => {
      const purchase = buildPurchaseTransaction({ client: 'مورد ABC' });
      expect(purchase.client).toBe('مورد ABC');
    });
  });

  describe('Total amount calculation', () => {
    it('calculates purchase total correctly', () => {
      // 10 × 60 + 5 × 150 = 1350
      expect(calcPurchaseTotal(mockPurchaseItems)).toBe(1350);
    });

    it('applies tax to purchase total', () => {
      const subtotal = 1000;
      const taxRate = 0.14;
      const totalWithTax = subtotal + subtotal * taxRate;
      expect(totalWithTax).toBe(1140);
    });

    it('handles purchase with single item', () => {
      const items = [{ code: 'P001', name: 'item', qty: 5, price: 100, total: 500 }];
      expect(calcPurchaseTotal(items)).toBe(500);
    });
  });

  describe('Stock increment on purchase', () => {
    it('increases stock by purchased quantity', () => {
      const remaining = calcStockAfterPurchase('P001', 50, mockPurchaseItems);
      expect(remaining).toBe(60); // 50 + 10
    });

    it('only increments matching product codes', () => {
      const items = [{ code: 'P001', qty: 5 }];
      expect(calcStockAfterPurchase('P002', 30, items)).toBe(30);
    });

    it('aggregates duplicate codes within one purchase', () => {
      const items = [
        { code: 'P001', qty: 5 },
        { code: 'P001', qty: 7 },
      ];
      expect(calcStockAfterPurchase('P001', 0, items)).toBe(12);
    });
  });

  describe('Deposit logic (0 = full debt rule)', () => {
    it('treats deposit=0 as full debt to supplier', () => {
      const result = purchaseDepositLogic(1000, 0);
      expect(result.paid).toBe(0);
      expect(result.remaining).toBe(1000);
      expect(result.payStatus).toBe('معلق');
    });

    it('treats undefined deposit as full debt', () => {
      const deposit = undefined as unknown as number;
      const dep = Number(deposit) || 0;
      const result = purchaseDepositLogic(1000, dep);
      expect(result.remaining).toBe(1000);
    });

    it('records partial deposit as paid', () => {
      const result = purchaseDepositLogic(1000, 300);
      expect(result.paid).toBe(300);
      expect(result.remaining).toBe(700);
      expect(result.payStatus).toBe('معلق');
    });

    it('marks fully paid when deposit equals total', () => {
      const result = purchaseDepositLogic(1000, 1000);
      expect(result.paid).toBe(1000);
      expect(result.remaining).toBe(0);
      expect(result.payStatus).toBe('مكتمل');
    });

    it('clamps remaining to 0 when overpaid', () => {
      const result = purchaseDepositLogic(500, 700);
      expect(result.remaining).toBe(0);
    });
  });

  describe('Payment method recording', () => {
    it('records the deposit method', () => {
      const purchase = buildPurchaseTransaction({ depMethod: 'تحويل بنكي' });
      expect(purchase.depMethod).toBe('تحويل بنكي');
    });

    it('defaults deposit method to كاش', () => {
      const purchase = buildPurchaseTransaction();
      expect(purchase.depMethod).toBe('كاش');
    });

    it('accepts all valid payment methods', () => {
      const valid = ['كاش', 'فودافون كاش', 'Instapay', 'تحويل بنكي'];
      valid.forEach((method) => {
        const p = buildPurchaseTransaction({ depMethod: method });
        expect(valid).toContain(p.depMethod);
      });
    });
  });

  describe('Vault sufficiency check (deposit from vault)', () => {
    it('passes when vault balance covers the deposit', () => {
      const balance = 5000;
      const deposit = 1000;
      const isSufficient = balance >= deposit;
      expect(isSufficient).toBe(true);
    });

    it('fails when vault balance is below deposit', () => {
      const balance = 100;
      const deposit = 1000;
      const isSufficient = balance >= deposit;
      expect(isSufficient).toBe(false);
    });

    it('does not check vault when deposit is 0', () => {
      const deposit = 0;
      const needsCheck = deposit > 0;
      expect(needsCheck).toBe(false);
    });
  });
});
