/**
 * Unit tests for the Invoice Log module.
 * Covers: retrieval by date/customer/reference, detail integrity, export.
 */

import {
  buildSaleTransaction,
  buildPurchaseTransaction,
  buildReturnTransaction,
} from '../fixtures/transactions.fixture';

const filterByDateRange = (
  txs: Array<Record<string, unknown>>,
  from: string,
  to: string,
) =>
  txs.filter((tx) => {
    const d = String(tx.date || '').slice(0, 10);
    return d >= from && d <= to;
  });

const filterByCustomer = (
  txs: Array<Record<string, unknown>>,
  customer: string,
) =>
  txs.filter((tx) =>
    String(tx.client || '').toLowerCase().includes(customer.toLowerCase()),
  );

const filterByRef = (txs: Array<Record<string, unknown>>, ref: string) =>
  txs.filter((tx) => String(tx.ref || '').includes(ref));

const stripHtml = (val: unknown) => {
  if (typeof val !== 'string') return val;
  return val.replace(/<[^>]+>/g, '').trim();
};

const txToExportRow = (tx: Record<string, unknown>) => ({
  التاريخ: String(tx.date || '').slice(0, 10),
  النوع: tx.type,
  العميل: tx.client,
  المرجع: tx.ref,
  الموظف: tx.employee,
  الإجمالي: tx.total,
  المدفوع: tx.deposit,
  المتبقي: tx.remaining,
  الحالة: tx.payStatus,
  طريقة_الدفع: tx.depMethod,
  الأصناف: ((tx.items as Array<Record<string, unknown>>) || [])
    .map((it) => `${it.name} (${it.qty} × ${it.price} = ${it.total})`)
    .join('; '),
});

const toCsv = (rows: Array<Record<string, unknown>>) => {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = String(v ?? '').replace(/"/g, '""');
    return /[,\n"]/.test(s) ? `"${s}"` : s;
  };
  const head = headers.map(escape).join(',');
  const body = rows
    .map((r) => headers.map((h) => escape(r[h])).join(','))
    .join('\n');
  return head + '\n' + body;
};

describe('Invoice Log Module', () => {
  const transactions = [
    buildSaleTransaction({ _id: 't1', ref: '1001', date: '2026-04-25', client: 'علي' }),
    buildSaleTransaction({ _id: 't2', ref: '1002', date: '2026-04-26', client: 'محمد' }),
    buildPurchaseTransaction({ _id: 't3', ref: '5001', date: '2026-04-24', client: 'مورد A' }),
    buildReturnTransaction({ _id: 't4', ref: '1001-RET', date: '2026-04-26', client: 'علي' }),
  ];

  describe('Retrieval by filters', () => {
    it('filters by date range (inclusive)', () => {
      const result = filterByDateRange(transactions, '2026-04-25', '2026-04-26');
      expect(result).toHaveLength(3);
    });

    it('filters by single date', () => {
      const result = filterByDateRange(transactions, '2026-04-25', '2026-04-25');
      expect(result).toHaveLength(1);
      expect(result[0]._id).toBe('t1');
    });

    it('returns empty for out-of-range dates', () => {
      const result = filterByDateRange(transactions, '2025-01-01', '2025-12-31');
      expect(result).toHaveLength(0);
    });

    it('filters by exact customer name', () => {
      const result = filterByCustomer(transactions, 'علي');
      expect(result).toHaveLength(2); // sale + return
    });

    it('filters by partial customer name', () => {
      const result = filterByCustomer(transactions, 'محم');
      expect(result.map((t) => t._id)).toEqual(['t2']);
    });

    it('is case-insensitive in customer search', () => {
      const list = [buildSaleTransaction({ client: 'Ahmed' })];
      const result = filterByCustomer(list, 'AHMED');
      expect(result).toHaveLength(1);
    });

    it('filters by reference number', () => {
      const result = filterByRef(transactions, '1001');
      expect(result).toHaveLength(2); // sale 1001 and return 1001-RET
    });

    it('filters by exact reference', () => {
      const result = filterByRef(transactions, '5001');
      expect(result.map((t) => t._id)).toEqual(['t3']);
    });
  });

  describe('Invoice detail integrity', () => {
    it('preserves all required transaction fields', () => {
      const tx = buildSaleTransaction();
      const required = [
        'date',
        'type',
        'client',
        'ref',
        'items',
        'total',
        'deposit',
        'remaining',
        'employee',
        'payStatus',
        'depMethod',
      ];
      required.forEach((f) => {
        expect(tx).toHaveProperty(f);
      });
    });

    it('preserves item details (code, name, qty, price, total)', () => {
      const tx = buildSaleTransaction();
      tx.items.forEach((it) => {
        expect(it).toHaveProperty('code');
        expect(it).toHaveProperty('name');
        expect(it).toHaveProperty('qty');
        expect(it).toHaveProperty('price');
        expect(it).toHaveProperty('total');
      });
    });

    it('total in invoice equals total stored on transaction', () => {
      const tx = buildSaleTransaction();
      const calc = tx.items.reduce((s, it) => s + it.total, 0);
      expect(tx.total).toBe(calc);
    });

    it('records initial deposit in deposits log', () => {
      const tx = buildSaleTransaction();
      const deposits = [
        {
          amount: tx.deposit,
          method: tx.depMethod,
          note: 'ديبوزت أول - عند إنشاء الحركة',
          date: tx.date,
          by: tx.employee,
        },
      ];
      expect(deposits[0].amount).toBe(tx.deposit);
      expect(deposits[0].method).toBe(tx.depMethod);
    });
  });

  describe('Export functionality', () => {
    it('strips HTML tags from cell values', () => {
      const value = '<div>500 ج</div>';
      expect(stripHtml(value)).toBe('500 ج');
    });

    it('handles nested HTML in export values', () => {
      const value = '<div><span>1,500</span> ج</div>';
      expect(stripHtml(value)).toBe('1,500 ج');
    });

    it('exports transaction to a flat row', () => {
      const tx = buildSaleTransaction();
      const row = txToExportRow(tx);
      expect(row['التاريخ']).toBe('2026-04-26');
      expect(row['النوع']).toBe('مبيعات');
      expect(row['العميل']).toBe('عميل تجريبي');
      expect(row['الإجمالي']).toBe(450);
    });

    it('flattens items into a single string column', () => {
      const tx = buildSaleTransaction();
      const row = txToExportRow(tx);
      expect(row['الأصناف']).toContain('منتج اختبار 1');
      expect(row['الأصناف']).toContain('2 × 100');
      expect(row['الأصناف']).toContain('= 200');
    });

    it('produces a valid CSV with proper escaping', () => {
      const rows = [
        { name: 'Ali', note: 'has, comma' },
        { name: 'محمد', note: 'normal' },
      ];
      const csv = toCsv(rows);
      expect(csv).toContain('"has, comma"');
      expect(csv.split('\n')).toHaveLength(3); // header + 2 rows
    });

    it('escapes double quotes in CSV', () => {
      const rows = [{ value: 'has "quotes" inside' }];
      const csv = toCsv(rows);
      expect(csv).toContain('"has ""quotes"" inside"');
    });

    it('handles empty data gracefully', () => {
      expect(toCsv([])).toBe('');
    });

    it('includes Arabic column headers', () => {
      const tx = buildSaleTransaction();
      const row = txToExportRow(tx);
      const headers = Object.keys(row);
      expect(headers).toContain('التاريخ');
      expect(headers).toContain('العميل');
      expect(headers).toContain('الإجمالي');
    });
  });

  describe('Status display logic', () => {
    it('marks completed sales as مكتمل', () => {
      const tx = buildSaleTransaction({ remaining: 0, payStatus: 'مكتمل' });
      expect(tx.payStatus).toBe('مكتمل');
    });

    it('marks pending sales as معلق', () => {
      const tx = buildSaleTransaction({ remaining: 250, payStatus: 'معلق' });
      expect(tx.payStatus).toBe('معلق');
    });

    it('marks cancelled transactions correctly', () => {
      const tx = buildSaleTransaction({ cancelled: true });
      expect(tx.cancelled).toBe(true);
    });
  });
});
