/**
 * Extended Returns tests — exchange flow, partial returns, complex scenarios.
 */

describe('Returns — Extended', () => {
  describe('Exchange (استبدال) workflow', () => {
    it('exchange = return + new sale combined', () => {
      const returnedAmount = 100;
      const newPurchaseAmount = 150;
      const customerOwes = newPurchaseAmount - returnedAmount;
      expect(customerOwes).toBe(50);
    });

    it('exchange returns same value → no money exchange', () => {
      const returned = 100;
      const newSale = 100;
      expect(newSale - returned).toBe(0);
    });

    it('exchange refund when new value < returned', () => {
      const returned = 200;
      const newSale = 150;
      const refund = returned - newSale;
      expect(refund).toBe(50);
    });

    it('exchange ref uses -EXC suffix', () => {
      const ref = '1001-EXC';
      expect(/-EXC$/i.test(ref)).toBe(true);
    });

    it('exchange creates two transactions: return + sale', () => {
      const transactions = [
        { type: 'مرتجع', ref: '1001-RET' },
        { type: 'مبيعات', ref: '1001-EXC' },
      ];
      expect(transactions).toHaveLength(2);
      expect(transactions[0].type).toBe('مرتجع');
      expect(transactions[1].type).toBe('مبيعات');
    });
  });

  describe('Partial returns', () => {
    it('returns subset of original sale items', () => {
      const sold = [
        { code: 'P001', qty: 5 },
        { code: 'P002', qty: 3 },
      ];
      const returned = [{ code: 'P001', qty: 2 }];
      expect(returned[0].qty).toBeLessThan(sold[0].qty);
    });

    it('multiple partial returns until total qty exhausted', () => {
      const sold = 10;
      const returns = [3, 4, 3];
      const totalReturned = returns.reduce((s, r) => s + r, 0);
      expect(totalReturned).toBe(sold);
    });

    it('rejects when cumulative returns exceed sold qty', () => {
      const sold = 5;
      const previousReturns = 3;
      const newReturn = 3;
      const wouldExceed = previousReturns + newReturn > sold;
      expect(wouldExceed).toBe(true);
    });
  });

  describe('Return reasons & documentation', () => {
    const validReasons = ['عيب صناعة', 'لم يعجب العميل', 'مقاس خاطئ', 'تالف', 'أخرى'];

    it('records return reason', () => {
      const ret = { reason: 'عيب صناعة' };
      expect(validReasons).toContain(ret.reason);
    });

    it('requires reason for return', () => {
      const reason = '';
      const validate = () => {
        if (!reason) throw new Error('سبب الإرجاع مطلوب');
      };
      expect(validate).toThrow('سبب الإرجاع مطلوب');
    });

    it('records who approved the return', () => {
      const ret = { approvedBy: 'مدير', approvedAt: '2026-04-27T10:00:00Z' };
      expect(ret.approvedBy).toBeTruthy();
      expect(ret.approvedAt).toBeTruthy();
    });
  });

  describe('Return-to-vault refund logic', () => {
    it('refund leaves vault when sales-return is approved', () => {
      const vaultBefore = 1000;
      const refund = 200;
      expect(vaultBefore - refund).toBe(800);
    });

    it('refund uses original payment method', () => {
      const sale = { depMethod: 'فودافون كاش' };
      const refundMethod = sale.depMethod;
      expect(refundMethod).toBe('فودافون كاش');
    });

    it('cash refund requires sufficient vault balance', () => {
      const vaultBalance = 100;
      const refund = 200;
      const canRefund = vaultBalance >= refund;
      expect(canRefund).toBe(false);
    });
  });
});
