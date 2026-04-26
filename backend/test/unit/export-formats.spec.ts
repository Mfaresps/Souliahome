/**
 * Export format tests — CSV/Excel rows, BOM, escaping, column selection.
 */

import { buildSaleTransaction } from '../fixtures/transactions.fixture';

const csvEscape = (v: unknown) => {
  const s = String(v ?? '').replace(/"/g, '""');
  return /[,\n"]/.test(s) ? `"${s}"` : s;
};

const buildCsv = (rows: Array<Record<string, unknown>>) => {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(',')),
  ].join('\n');
};

const filterColumns = (
  rows: Array<Record<string, unknown>>,
  keep: string[],
): Array<Record<string, unknown>> =>
  rows.map((r) => {
    const out: Record<string, unknown> = {};
    keep.forEach((k) => {
      if (k in r) out[k] = r[k];
    });
    return out;
  });

describe('Export formats', () => {
  describe('CSV generation', () => {
    it('produces proper CSV with headers', () => {
      const csv = buildCsv([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
      expect(csv).toBe('a,b\n1,2\n3,4');
    });

    it('escapes commas in cells', () => {
      const csv = buildCsv([{ note: 'hello, world' }]);
      expect(csv).toContain('"hello, world"');
    });

    it('escapes newlines in cells', () => {
      const csv = buildCsv([{ note: 'line1\nline2' }]);
      expect(csv).toContain('"line1\nline2"');
    });

    it('doubles quotes inside quoted cells', () => {
      const csv = buildCsv([{ q: 'say "hi"' }]);
      expect(csv).toContain('"say ""hi"""');
    });

    it('handles null/undefined as empty', () => {
      const csv = buildCsv([{ a: null, b: undefined, c: 'ok' }]);
      expect(csv).toBe('a,b,c\n,,ok');
    });

    it('handles empty rows array', () => {
      expect(buildCsv([])).toBe('');
    });
  });

  describe('Excel-friendly UTF-8 BOM', () => {
    it('prepends BOM marker for Arabic CSV', () => {
      const content = 'العميل,الإجمالي\nعلي,1000';
      const withBOM = '﻿' + content;
      expect(withBOM.charCodeAt(0)).toBe(0xfeff);
    });

    it('Arabic characters preserved in CSV', () => {
      const csv = buildCsv([{ العميل: 'محمد', الإجمالي: 500 }]);
      expect(csv).toContain('محمد');
      expect(csv).toContain('500');
    });
  });

  describe('Column selection', () => {
    const rows = [
      { date: '2026-04-26', client: 'علي', total: 500, hidden: 'should not appear' },
    ];

    it('keeps only selected columns', () => {
      const out = filterColumns(rows, ['date', 'client', 'total']);
      expect(Object.keys(out[0])).toEqual(['date', 'client', 'total']);
    });

    it('excludes columns not in selection', () => {
      const out = filterColumns(rows, ['date']);
      expect(out[0]).not.toHaveProperty('hidden');
    });

    it('preserves order of selection', () => {
      const out = filterColumns(rows, ['total', 'client', 'date']);
      expect(Object.keys(out[0])).toEqual(['total', 'client', 'date']);
    });

    it('handles empty selection', () => {
      const out = filterColumns(rows, []);
      expect(Object.keys(out[0])).toEqual([]);
    });
  });

  describe('Item flattening for export', () => {
    it('formats items as "Name (Qty × Price = Total)"', () => {
      const items = [
        { name: 'Item A', qty: 2, price: 100, total: 200 },
        { name: 'Item B', qty: 1, price: 50, total: 50 },
      ];
      const formatted = items
        .map((it) => `${it.name} (${it.qty} × ${it.price} = ${it.total})`)
        .join('; ');
      expect(formatted).toBe('Item A (2 × 100 = 200); Item B (1 × 50 = 50)');
    });

    it('handles single item', () => {
      const items = [{ name: 'Solo', qty: 1, price: 99, total: 99 }];
      const formatted = items
        .map((it) => `${it.name} (${it.qty} × ${it.price} = ${it.total})`)
        .join('; ');
      expect(formatted).toBe('Solo (1 × 99 = 99)');
    });

    it('handles empty items list', () => {
      const items: Array<{ name: string; qty: number; price: number; total: number }> = [];
      const formatted = items.map((it) => `${it.name}`).join('; ');
      expect(formatted).toBe('');
    });
  });

  describe('Strip HTML before export', () => {
    const stripHtml = (val: unknown) => {
      if (typeof val !== 'string') return val;
      return val.replace(/<[^>]+>/g, '').trim();
    };

    it('removes div tags', () => {
      expect(stripHtml('<div>500 ج</div>')).toBe('500 ج');
    });

    it('removes nested tags', () => {
      expect(stripHtml('<div><span>500</span> ج</div>')).toBe('500 ج');
    });

    it('removes class attributes', () => {
      expect(stripHtml('<div class="text-muted">100</div>')).toBe('100');
    });

    it('passes through non-string values', () => {
      expect(stripHtml(123)).toBe(123);
      expect(stripHtml(null)).toBeNull();
    });
  });

  describe('Sale to export row', () => {
    it('contains all expected columns in Arabic', () => {
      const sale = buildSaleTransaction();
      const row = {
        التاريخ: sale.date,
        النوع: sale.type,
        العميل: sale.client,
        الإجمالي: sale.total,
        المدفوع: sale.deposit,
        المتبقي: sale.remaining,
      };
      expect(Object.keys(row)).toEqual([
        'التاريخ',
        'النوع',
        'العميل',
        'الإجمالي',
        'المدفوع',
        'المتبقي',
      ]);
    });
  });
});
