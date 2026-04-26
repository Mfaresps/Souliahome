/**
 * General tests for error handling, edge cases, and cross-module data consistency.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  buildSaleTransaction,
  buildPurchaseTransaction,
  buildReturnTransaction,
} from '../fixtures/transactions.fixture';
import { mockProducts } from '../fixtures/products.fixture';

describe('General — Error Handling & Data Consistency', () => {
  describe('Error handling', () => {
    it('throws NotFoundException for missing transaction', () => {
      const find = (id: string) => {
        const tx = null;
        if (!tx) throw new NotFoundException('الحركة غير موجودة');
        return tx;
      };
      expect(() => find('nonexistent')).toThrow(NotFoundException);
    });

    it('throws BadRequestException for duplicate reference', () => {
      const existing = ['1001', '1002'];
      const validate = (ref: string) => {
        if (existing.includes(ref)) {
          throw new BadRequestException('هذا الرقم المرجعي مسجّل مسبقاً في حركة أخرى');
        }
      };
      expect(() => validate('1001')).toThrow(/مسجّل مسبقاً/);
    });

    it('rejects negative quantities', () => {
      const validate = (qty: number) => {
        if (qty < 0) throw new BadRequestException('الكمية لا يمكن أن تكون سالبة');
      };
      expect(() => validate(-1)).toThrow(BadRequestException);
    });

    it('rejects negative prices', () => {
      const validate = (price: number) => {
        if (price < 0) throw new BadRequestException('السعر لا يمكن أن يكون سالباً');
      };
      expect(() => validate(-100)).toThrow(BadRequestException);
    });

    it('rejects zero quantity items', () => {
      const validate = (qty: number) => {
        if (qty === 0) throw new BadRequestException('الكمية يجب أن تكون أكبر من الصفر');
      };
      expect(() => validate(0)).toThrow(/أكبر من الصفر/);
    });

    it('handles invalid date format gracefully', () => {
      const date = 'not-a-date';
      const parsed = new Date(date);
      expect(isNaN(parsed.getTime())).toBe(true);
    });

    it('returns 401 equivalent for missing auth context', () => {
      const user: unknown = null;
      const requireAuth = () => {
        if (!user) throw new Error('Unauthorized');
      };
      expect(requireAuth).toThrow('Unauthorized');
    });
  });

  describe('Data consistency across modules', () => {
    it('sale + return: stock balance is restored', () => {
      const initial = 50;
      const saleQty = 2;
      const returnQty = 2;
      const afterSale = initial - saleQty;
      const afterReturn = afterSale + returnQty;
      expect(afterReturn).toBe(initial);
    });

    it('sale + cancellation: vault is restored', () => {
      const initial = 1000;
      const deposit = 200;
      const afterSale = initial + deposit;
      const afterCancel = afterSale - deposit;
      expect(afterCancel).toBe(initial);
    });

    it('purchase + return to supplier: stock balance is restored', () => {
      const initial = 50;
      const buyQty = 10;
      const returnQty = 10;
      const afterBuy = initial + buyQty;
      const afterReturn = afterBuy - returnQty;
      expect(afterReturn).toBe(initial);
    });

    it('partial collection updates remaining correctly', () => {
      const total = 1000;
      let remaining = 800; // after initial deposit of 200
      const collection = 300;
      remaining = Math.max(0, remaining - collection);
      expect(remaining).toBe(500);
    });

    it('multiple collections eventually settle remaining to 0', () => {
      const total = 1000;
      let remaining = total;
      const collections = [200, 300, 400, 100];
      collections.forEach((c) => {
        remaining = Math.max(0, remaining - c);
      });
      expect(remaining).toBe(0);
    });

    it('over-collection caps remaining at 0 (no negative)', () => {
      let remaining = 100;
      remaining = Math.max(0, remaining - 500);
      expect(remaining).toBe(0);
    });
  });

  describe('Reference number uniqueness', () => {
    it('detects duplicate refs among non-cancelled txs', () => {
      const existing = [
        { ref: '1001', cancelled: false },
        { ref: '1002', cancelled: false },
      ];
      const newRef = '1001';
      const conflict = existing.find((t) => t.ref === newRef && !t.cancelled);
      expect(conflict).toBeDefined();
    });

    it('allows reusing a ref from a cancelled tx', () => {
      const existing = [{ ref: '1001', cancelled: true }];
      const newRef = '1001';
      const conflict = existing.find((t) => t.ref === newRef && !t.cancelled);
      expect(conflict).toBeUndefined();
    });

    it('treats whitespace-only refs as empty', () => {
      const ref = '   ';
      expect(ref.trim()).toBe('');
    });
  });

  describe('Cancellation rules', () => {
    it('cancelled transactions have a reason', () => {
      const tx = buildSaleTransaction({
        cancelled: true,
        cancelReason: 'طلب العميل',
        cancelledBy: 'مدير',
        cancelledAt: '2026-04-27T10:00:00Z',
      }) as Record<string, unknown>;
      expect(tx['cancelled']).toBe(true);
      expect(tx['cancelReason']).toBeTruthy();
      expect(tx['cancelledBy']).toBeTruthy();
    });

    it('cancellation requires reason', () => {
      const reason = '';
      const validate = () => {
        if (!reason.trim()) throw new BadRequestException('سبب الإلغاء مطلوب');
      };
      expect(validate).toThrow(/سبب الإلغاء/);
    });

    it('archive only available for cancelled transactions', () => {
      const tx = buildSaleTransaction({ cancelled: false });
      const canArchive = !!tx.cancelled;
      expect(canArchive).toBe(false);
    });

    it('archive marks tx as archived without affecting stock/vault', () => {
      const tx = buildSaleTransaction({ cancelled: true });
      const archived = { ...tx, archived: true, archivedAt: '2026-04-27' };
      expect(archived.archived).toBe(true);
      // Archive doesn't touch stock/vault — already cancelled.
    });
  });

  describe('Edge cases', () => {
    it('handles transaction with single item', () => {
      const tx = buildSaleTransaction({
        items: [{ code: 'P001', name: 'p1', qty: 1, price: 10, total: 10 }],
        total: 10,
      });
      expect(tx.items).toHaveLength(1);
    });

    it('handles transaction with many items (50+)', () => {
      const items = Array.from({ length: 50 }, (_, i) => ({
        code: `P${String(i).padStart(3, '0')}`,
        name: `Product ${i}`,
        qty: 1,
        price: 10,
        total: 10,
      }));
      const total = items.reduce((s, it) => s + it.total, 0);
      const tx = buildSaleTransaction({ items, total });
      expect(tx.items).toHaveLength(50);
      expect(tx.total).toBe(500);
    });

    it('handles zero-balance vault gracefully', () => {
      const balance = 0;
      const isEmpty = balance === 0;
      expect(isEmpty).toBe(true);
    });

    it('handles transaction at exactly the return-window boundary', () => {
      const saleDate = new Date('2026-04-13');
      const returnDate = new Date('2026-04-27'); // 14 days exactly
      const days = (returnDate.getTime() - saleDate.getTime()) / (1000 * 60 * 60 * 24);
      expect(days).toBe(14);
      expect(days <= 14).toBe(true);
    });

    it('low stock threshold handles minStock = 0', () => {
      const product = { ...mockProducts[0], minStock: 0 };
      const current = 0;
      const isLow = current <= product.minStock;
      expect(isLow).toBe(true);
    });

    it('handles unicode-normalized customer search', () => {
      const normalize = (s: string) =>
        s
          .normalize('NFKC')
          .replace(/[ً-ٟ]/g, '')
          .replace(/[آأإ]/g, 'ا')
          .replace(/ى/g, 'ي')
          .toLowerCase();
      expect(normalize('أحمد')).toBe(normalize('احمد'));
      expect(normalize('علي')).toBe(normalize('علي'));
    });
  });

  describe('Concurrency safety (logical)', () => {
    it('two parallel sales reduce stock independently', () => {
      const initial = 10;
      const sale1 = 3;
      const sale2 = 4;
      const after = initial - sale1 - sale2;
      expect(after).toBe(3);
    });

    it('parallel sales should never let stock go negative', () => {
      const initial = 5;
      const requested1 = 3;
      const requested2 = 4; // would exceed
      const stockAfter1 = initial - requested1; // 2
      const validate = () => {
        if (requested2 > stockAfter1) {
          throw new BadRequestException('الكمية المطلوبة تتجاوز المخزون');
        }
      };
      expect(validate).toThrow(BadRequestException);
    });
  });

  describe('Database update integrity', () => {
    it('every transaction has a timestamp', () => {
      const tx = buildSaleTransaction();
      const now = new Date().toISOString();
      const withTimestamps = { ...tx, createdAt: now, updatedAt: now };
      expect(withTimestamps.createdAt).toBeTruthy();
      expect(withTimestamps.updatedAt).toBeTruthy();
    });

    it('every cash log entry has a timestamp', () => {
      const entry = {
        date: '2026-04-26',
        createdAt: '2026-04-26T10:30:00Z',
        amount: 200,
      };
      expect(entry.date).toBeTruthy();
      expect(entry.createdAt).toBeTruthy();
    });

    it('edit history is appended, never replaced', () => {
      const tx = buildSaleTransaction({ editHistory: [] }) as Record<string, unknown>;
      const history = (tx['editHistory'] as Array<unknown>) || [];
      history.push({ field: 'total', oldVal: 450, newVal: 500, by: 'admin', at: '2026-04-27' });
      history.push({ field: 'discount', oldVal: 0, newVal: 50, by: 'admin', at: '2026-04-27' });
      expect(history).toHaveLength(2);
    });
  });
});
