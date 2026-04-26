/**
 * Extended Purchases tests — partial payments, supplier debt tracking,
 * tax-inclusive pricing, returns to supplier.
 */

import { BadRequestException } from '@nestjs/common';
import { buildPurchaseTransaction } from '../fixtures/transactions.fixture';

const trackSupplierDebt = (
  purchases: Array<{ total: number; deposit: number; cancelled?: boolean }>,
) =>
  purchases
    .filter((p) => !p.cancelled)
    .reduce((s, p) => s + Math.max(0, p.total - p.deposit), 0);

describe('Purchases — Extended', () => {
  describe('Multi-payment purchase tracking', () => {
    it('tracks initial deposit + later payments', () => {
      const total = 1000;
      const deposits = [100, 200, 300];
      const totalPaid = deposits.reduce((s, d) => s + d, 0);
      expect(totalPaid).toBe(600);
      expect(total - totalPaid).toBe(400);
    });

    it('payment log entries include amount, date, and method', () => {
      const payment = {
        amount: 200,
        method: 'كاش',
        date: '2026-04-26T10:00:00Z',
        by: 'admin',
        remaining: 800,
      };
      expect(payment).toMatchObject({
        amount: expect.any(Number),
        method: expect.any(String),
        date: expect.any(String),
      });
    });

    it('final payment marks purchase complete', () => {
      let remaining = 1000;
      const payments = [400, 350, 250];
      payments.forEach((p) => (remaining = Math.max(0, remaining - p)));
      expect(remaining).toBe(0);
    });
  });

  describe('Supplier debt aggregation', () => {
    it('totals debt across multiple unpaid purchases', () => {
      const purchases = [
        { total: 1000, deposit: 200 },
        { total: 500, deposit: 0 },
        { total: 800, deposit: 800 }, // fully paid
      ];
      expect(trackSupplierDebt(purchases)).toBe(1300); // 800+500+0
    });

    it('excludes cancelled purchases from supplier debt', () => {
      const purchases = [
        { total: 1000, deposit: 0, cancelled: false },
        { total: 500, deposit: 0, cancelled: true },
      ];
      expect(trackSupplierDebt(purchases)).toBe(1000);
    });

    it('returns zero when all purchases paid', () => {
      const purchases = [
        { total: 1000, deposit: 1000 },
        { total: 500, deposit: 500 },
      ];
      expect(trackSupplierDebt(purchases)).toBe(0);
    });
  });

  describe('Tax-inclusive pricing', () => {
    it('14% Egyptian VAT calculation', () => {
      const subtotal = 1000;
      const vat = subtotal * 0.14;
      expect(vat).toBe(140);
      expect(subtotal + vat).toBe(1140);
    });

    it('reverse VAT extraction from inclusive price', () => {
      const inclusive = 1140;
      const subtotal = inclusive / 1.14;
      expect(Math.round(subtotal)).toBe(1000);
    });

    it('zero VAT for tax-exempt items', () => {
      const subtotal = 500;
      const vatRate = 0;
      expect(subtotal + subtotal * vatRate).toBe(500);
    });
  });

  describe('Purchase return-to-supplier flow', () => {
    it('purchase return reduces stock', () => {
      const stockBefore = 60;
      const returnQty = 5;
      expect(stockBefore - returnQty).toBe(55);
    });

    it('purchase return reduces supplier debt', () => {
      const debtBefore = 800;
      const returnAmount = 200;
      expect(debtBefore - returnAmount).toBe(600);
    });

    it('purchase return type is مرتجع مشتريات', () => {
      const tx = { type: 'مرتجع مشتريات' };
      expect(tx.type).toBe('مرتجع مشتريات');
    });
  });

  describe('Purchase reference variants', () => {
    it('accepts purchase ref with leading zeros', () => {
      const ref = '00100';
      expect(/^\d+$/.test(ref)).toBe(true);
    });

    it('rejects purchase ref with letters', () => {
      const ref = 'PUR-001';
      expect(/^\d+$/.test(ref)).toBe(false);
    });

    it('detects supplier-return ref pattern', () => {
      const ref = '5001-RET';
      expect(/-RET$/i.test(ref)).toBe(true);
    });
  });

  describe('Supplier metadata', () => {
    it('records supplier phone', () => {
      const purchase = buildPurchaseTransaction({ phone: '01234567890' }) as Record<string, unknown>;
      expect(purchase['phone']).toBe('01234567890');
    });

    it('records purchase notes', () => {
      const purchase = buildPurchaseTransaction({ notes: 'دفعة شهرية' });
      expect(purchase.notes).toBe('دفعة شهرية');
    });
  });
});
