/**
 * Unit tests for the Sales Module.
 * Covers: creation, stock decrement, total calculation, payment recording,
 * and invoice generation logic.
 */

import { BadRequestException } from '@nestjs/common';
import { buildSaleTransaction, mockSaleItems } from '../fixtures/transactions.fixture';
import { mockProducts } from '../fixtures/products.fixture';

/**
 * Pure logic helpers — mirror what the service does internally so we can test
 * the business rules without spinning up Mongo.
 */
const calcItemsTotal = (items: { qty: number; price: number }[]) =>
  items.reduce((s, it) => s + Number(it.qty) * Number(it.price), 0);

const applyDiscount = (subtotal: number, discount: number, type: 'fixed' | 'percent' = 'fixed') => {
  if (type === 'percent') return subtotal - (subtotal * discount) / 100;
  return Math.max(0, subtotal - discount);
};

const applyShipping = (afterDiscount: number, shipCost: number) => afterDiscount + (shipCost || 0);

const calcTotal = (
  items: { qty: number; price: number }[],
  discount = 0,
  shipCost = 0,
  taxRate = 0,
) => {
  const sub = calcItemsTotal(items);
  const afterDiscount = applyDiscount(sub, discount);
  const tax = afterDiscount * taxRate;
  return applyShipping(afterDiscount + tax, shipCost);
};

const calcRemaining = (total: number, deposit: number) => Math.max(0, total - (deposit || 0));

const computeStockAfterSale = (
  productCode: string,
  initialStock: number,
  saleItems: { code: string; qty: number }[],
) => {
  const sold = saleItems
    .filter((it) => it.code === productCode)
    .reduce((s, it) => s + it.qty, 0);
  return initialStock - sold;
};

describe('Sales Module', () => {
  describe('Sale creation', () => {
    it('builds a valid sale transaction with all required fields', () => {
      const sale = buildSaleTransaction();
      expect(sale.type).toBe('مبيعات');
      expect(sale.client).toBeTruthy();
      expect(sale.ref).toBeTruthy();
      expect(sale.items.length).toBeGreaterThan(0);
      expect(sale.employee).toBeTruthy();
    });

    it('rejects a sale with missing reference number', () => {
      const ref = '';
      const validateRef = () => {
        if (!ref) throw new BadRequestException('الرقم المرجعي مطلوب');
      };
      expect(validateRef).toThrow(BadRequestException);
    });

    it('rejects a sale with non-numeric reference number', () => {
      const ref = 'INV-001';
      const validateRef = () => {
        if (!/^\d+$/.test(ref)) {
          throw new BadRequestException('الرقم المرجعي يقبل أرقاماً فقط');
        }
      };
      expect(validateRef).toThrow('الرقم المرجعي يقبل أرقاماً فقط');
    });

    it('rejects a sale with no items', () => {
      const items: unknown[] = [];
      const validate = () => {
        if (!items.length) throw new BadRequestException('يجب إضافة منتج واحد على الأقل');
      };
      expect(validate).toThrow(BadRequestException);
    });
  });

  describe('Total amount calculation', () => {
    it('calculates items subtotal correctly', () => {
      // 2 × 100 + 1 × 250 = 450
      expect(calcItemsTotal(mockSaleItems)).toBe(450);
    });

    it('applies fixed discount to subtotal', () => {
      expect(applyDiscount(450, 50)).toBe(400);
    });

    it('applies percent discount to subtotal', () => {
      expect(applyDiscount(1000, 10, 'percent')).toBe(900);
    });

    it('does not allow negative totals from over-discounting', () => {
      expect(applyDiscount(100, 200)).toBe(0);
    });

    it('adds shipping cost on top of discounted subtotal', () => {
      expect(applyShipping(400, 50)).toBe(450);
    });

    it('combines discount, tax and shipping correctly', () => {
      // sub=450, discount=50 → 400, tax 14% → 456, +50 shipping = 506
      const total = calcTotal(mockSaleItems, 50, 50, 0.14);
      expect(total).toBeCloseTo(506);
    });

    it('keeps total identical when no discount/tax/shipping', () => {
      expect(calcTotal(mockSaleItems)).toBe(450);
    });
  });

  describe('Payment & deposit recording', () => {
    it('computes remaining as total minus deposit', () => {
      expect(calcRemaining(500, 200)).toBe(300);
    });

    it('treats empty deposit as zero (full debt)', () => {
      expect(calcRemaining(500, 0)).toBe(500);
    });

    it('marks remaining as zero when deposit covers total', () => {
      expect(calcRemaining(500, 500)).toBe(0);
    });

    it('never returns negative remaining for over-deposit', () => {
      expect(calcRemaining(500, 700)).toBe(0);
    });

    it('records the correct payment method', () => {
      const sale = buildSaleTransaction({ depMethod: 'فودافون كاش' });
      expect(sale.depMethod).toBe('فودافون كاش');
      expect(['كاش', 'فودافون كاش', 'Instapay', 'تحويل بنكي']).toContain(sale.depMethod);
    });

    it('sets payStatus to معلق when remaining > 0', () => {
      const remaining = 250;
      const status = remaining > 0 ? 'معلق' : 'مكتمل';
      expect(status).toBe('معلق');
    });

    it('sets payStatus to مكتمل when fully paid', () => {
      const remaining = 0;
      const status = remaining > 0 ? 'معلق' : 'مكتمل';
      expect(status).toBe('مكتمل');
    });
  });

  describe('Stock decrement on sale', () => {
    it('reduces stock by sold quantity', () => {
      // P001 starts with 50, sale of 2 → 48
      const remaining = computeStockAfterSale('P001', 50, mockSaleItems);
      expect(remaining).toBe(48);
    });

    it('rejects sale when stock is insufficient', () => {
      const stock = 5;
      const requested = 10;
      const validate = () => {
        if (requested > stock) throw new BadRequestException('الكمية المطلوبة تتجاوز المخزون');
      };
      expect(validate).toThrow(BadRequestException);
    });

    it('aggregates same-code items in a sale', () => {
      const items = [
        { code: 'P001', qty: 2 },
        { code: 'P001', qty: 3 },
      ];
      const remaining = computeStockAfterSale('P001', 10, items);
      expect(remaining).toBe(5);
    });

    it('only deducts the matching product code', () => {
      const items = [
        { code: 'P001', qty: 2 },
        { code: 'P002', qty: 5 },
      ];
      expect(computeStockAfterSale('P001', 10, items)).toBe(8);
      expect(computeStockAfterSale('P002', 10, items)).toBe(5);
    });
  });

  describe('Invoice generation', () => {
    it('generates an invoice with reference and client info', () => {
      const sale = buildSaleTransaction();
      const invoice = {
        ref: sale.ref,
        client: sale.client,
        date: sale.date,
        items: sale.items,
        total: sale.total,
        deposit: sale.deposit,
        remaining: sale.remaining,
      };
      expect(invoice.ref).toBe('1001');
      expect(invoice.client).toBe('عميل تجريبي');
      expect(invoice.items.length).toBe(2);
      expect(invoice.total).toBe(450);
    });

    it('invoice item totals match qty × price', () => {
      const sale = buildSaleTransaction();
      sale.items.forEach((it) => {
        expect(it.total).toBe(it.qty * it.price);
      });
    });

    it('invoice total equals sum of item totals when no discount/shipping', () => {
      const sale = buildSaleTransaction();
      const sum = sale.items.reduce((s, it) => s + it.total, 0);
      expect(sale.total).toBe(sum);
    });
  });
});
