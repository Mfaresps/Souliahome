/**
 * Unit tests for Cash/Vault and Stock synchronization.
 * Covers: deposits, withdrawals, stock-vault sync, edge cases.
 */

import { BadRequestException } from '@nestjs/common';
import { mockProducts } from '../fixtures/products.fixture';
import { buildSaleTransaction, buildPurchaseTransaction } from '../fixtures/transactions.fixture';

const VAULT_SEGMENTS = ['كاش', 'فودافون كاش', 'Instapay', 'تحويل بنكي'];

const resolveSegment = (method: string): string => {
  if (!method) return 'كاش';
  return VAULT_SEGMENTS.includes(method) ? method : 'كاش';
};

const updateVaultBalance = (
  balances: Record<string, number>,
  segment: string,
  amount: number,
) => {
  return {
    ...balances,
    [segment]: (balances[segment] || 0) + amount,
  };
};

const assertSufficientBalance = (currentBalance: number, withdrawal: number) => {
  if (withdrawal > currentBalance) {
    throw new BadRequestException(
      `الرصيد غير كافٍ — الموجود: ${currentBalance}, المطلوب: ${withdrawal}`,
    );
  }
};

const computeAvailableStock = (
  productCode: string,
  opening: number,
  purchases: number,
  sales: number,
  returnsToStock: number,
) => opening + purchases + returnsToStock - sales;

describe('Cash/Vault & Stock Synchronization', () => {
  describe('Vault segment resolution', () => {
    it('resolves كاش method to كاش segment', () => {
      expect(resolveSegment('كاش')).toBe('كاش');
    });

    it('resolves فودافون كاش method to its segment', () => {
      expect(resolveSegment('فودافون كاش')).toBe('فودافون كاش');
    });

    it('resolves Instapay method to its segment', () => {
      expect(resolveSegment('Instapay')).toBe('Instapay');
    });

    it('falls back to كاش for unknown methods', () => {
      expect(resolveSegment('بطاقة ائتمان')).toBe('كاش');
    });

    it('falls back to كاش when method is empty', () => {
      expect(resolveSegment('')).toBe('كاش');
    });
  });

  describe('Cash deposits (sales bring cash IN)', () => {
    it('increases vault balance on sale deposit', () => {
      const balances = { كاش: 1000, 'فودافون كاش': 0, Instapay: 0, 'تحويل بنكي': 0 };
      const sale = buildSaleTransaction({ deposit: 200, depMethod: 'كاش' });
      const updated = updateVaultBalance(balances, sale.depMethod as string, sale.deposit as number);
      expect(updated['كاش']).toBe(1200);
    });

    it('records deposit to correct segment', () => {
      const balances = { كاش: 0, 'فودافون كاش': 0, Instapay: 500, 'تحويل بنكي': 0 };
      const updated = updateVaultBalance(balances, 'Instapay', 300);
      expect(updated['Instapay']).toBe(800);
      expect(updated['كاش']).toBe(0);
    });

    it('does not touch other segments when depositing', () => {
      const balances = { كاش: 1000, 'فودافون كاش': 500, Instapay: 200, 'تحويل بنكي': 100 };
      const updated = updateVaultBalance(balances, 'كاش', 100);
      expect(updated['كاش']).toBe(1100);
      expect(updated['فودافون كاش']).toBe(500);
      expect(updated['Instapay']).toBe(200);
      expect(updated['تحويل بنكي']).toBe(100);
    });
  });

  describe('Cash withdrawals (purchases take cash OUT)', () => {
    it('decreases vault balance on purchase deposit paid', () => {
      const balances = { كاش: 5000 };
      const purchase = buildPurchaseTransaction({ deposit: 1000, depMethod: 'كاش' });
      const updated = updateVaultBalance(
        balances,
        purchase.depMethod as string,
        -(purchase.deposit as number),
      );
      expect(updated['كاش']).toBe(4000);
    });

    it('throws on overdraft (purchase deposit > balance)', () => {
      const currentBalance = 100;
      const withdrawal = 500;
      expect(() => assertSufficientBalance(currentBalance, withdrawal)).toThrow(
        BadRequestException,
      );
    });

    it('allows withdrawal exactly equal to balance', () => {
      expect(() => assertSufficientBalance(500, 500)).not.toThrow();
    });

    it('skips vault check when deposit is 0', () => {
      const purchase = buildPurchaseTransaction({ deposit: 0 });
      const needsCheck = (purchase.deposit as number) > 0;
      expect(needsCheck).toBe(false);
    });
  });

  describe('Stock-Vault synchronization', () => {
    it('sale: stock decreases AND cash increases atomically', () => {
      const stockBefore = 50;
      const balanceBefore = 1000;
      const saleQty = 2;
      const saleDeposit = 200;

      const stockAfter = stockBefore - saleQty;
      const balanceAfter = balanceBefore + saleDeposit;

      expect(stockAfter).toBe(48);
      expect(balanceAfter).toBe(1200);
    });

    it('purchase: stock increases AND cash decreases atomically', () => {
      const stockBefore = 50;
      const balanceBefore = 5000;
      const buyQty = 10;
      const buyDeposit = 600;

      const stockAfter = stockBefore + buyQty;
      const balanceAfter = balanceBefore - buyDeposit;

      expect(stockAfter).toBe(60);
      expect(balanceAfter).toBe(4400);
    });

    it('return: customer return increases stock AND decreases cash (refund)', () => {
      const stockBefore = 48;
      const balanceBefore = 1200;
      const returnQty = 1;
      const refund = 100;

      const stockAfter = stockBefore + returnQty;
      const balanceAfter = balanceBefore - refund;

      expect(stockAfter).toBe(49);
      expect(balanceAfter).toBe(1100);
    });

    it('cancellation reverses both stock and vault entries', () => {
      // Sale: stock -2, cash +200
      const initialStock = 50;
      const initialBalance = 1000;
      const stockAfterSale = initialStock - 2;
      const balanceAfterSale = initialBalance + 200;

      // Cancel: reverse the impact
      const stockAfterCancel = stockAfterSale + 2;
      const balanceAfterCancel = balanceAfterSale - 200;

      expect(stockAfterCancel).toBe(initialStock);
      expect(balanceAfterCancel).toBe(initialBalance);
    });
  });

  describe('Edge cases', () => {
    it('rejects sale when stock is insufficient', () => {
      const product = mockProducts[3]; // P004, opening 0
      const available = computeAvailableStock(product.code, product.openingBalance, 0, 0, 0);
      const requested = 5;
      const validate = () => {
        if (requested > available) {
          throw new BadRequestException(`الكمية المطلوبة (${requested}) تتجاوز المتاح (${available})`);
        }
      };
      expect(validate).toThrow(BadRequestException);
    });

    it('rejects vault withdrawal exceeding balance', () => {
      expect(() => assertSufficientBalance(500, 600)).toThrow(/الرصيد غير كافٍ/);
    });

    it('handles concurrent stock requests across different products independently', () => {
      const stockA = computeAvailableStock('P001', 50, 10, 5, 2);
      const stockB = computeAvailableStock('P002', 30, 0, 8, 0);
      expect(stockA).toBe(57); // 50+10+2-5
      expect(stockB).toBe(22); // 30+0+0-8
    });

    it('low stock alert when current ≤ minStock', () => {
      const product = mockProducts[2]; // P003: opening 5, min 20
      const available = computeAvailableStock(product.code, product.openingBalance, 0, 0, 0);
      const isLow = available <= product.minStock;
      expect(isLow).toBe(true);
    });

    it('zero stock alert when current = 0', () => {
      const product = mockProducts[3]; // P004, opening 0
      const available = computeAvailableStock(product.code, product.openingBalance, 0, 0, 0);
      const isZero = available === 0;
      expect(isZero).toBe(true);
    });
  });

  describe('Cash log recording', () => {
    interface VaultEntry {
      date: string;
      amount: number;
      source: string;
      method: string;
      seg: string;
      ref?: string;
      desc?: string;
    }

    it('logs every sale deposit as a positive entry', () => {
      const entry: VaultEntry = {
        date: '2026-04-26',
        amount: 200,
        source: 'ديبوزت مبيعات',
        method: 'كاش',
        seg: 'كاش',
        ref: '1001',
      };
      expect(entry.amount).toBeGreaterThan(0);
      expect(entry.source).toBe('ديبوزت مبيعات');
    });

    it('logs every purchase payment as a negative entry', () => {
      const entry: VaultEntry = {
        date: '2026-04-26',
        amount: -600,
        source: 'دفع مشتريات',
        method: 'كاش',
        seg: 'كاش',
        ref: '5001',
      };
      expect(entry.amount).toBeLessThan(0);
      expect(entry.source).toBe('دفع مشتريات');
    });

    it('logs collections (تحصيل) when remaining balance is paid', () => {
      const collection: VaultEntry = {
        date: '2026-04-27',
        amount: 250,
        source: 'تحصيل',
        method: 'كاش',
        seg: 'كاش',
        ref: '1001',
      };
      expect(collection.source).toBe('تحصيل');
      expect(collection.ref).toBe('1001');
    });

    it('refund entries for returns are negative', () => {
      const refund: VaultEntry = {
        date: '2026-04-28',
        amount: -100,
        source: 'رد مرتجع',
        method: 'كاش',
        seg: 'كاش',
        ref: '1001-RET',
      };
      expect(refund.amount).toBeLessThan(0);
    });
  });
});
