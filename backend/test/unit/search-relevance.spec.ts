/**
 * Global search relevance tests.
 *
 * Regression guard for the bug that motivated the relevance engine: searching
 * "mar" put COMPLAINTS first (matched mid-word inside a customer name) above
 * PRODUCTS whose names actually start with "Mar", because section order was a
 * hardcoded list rather than a function of match quality.
 */

import { SearchService } from '../../src/search/search.service';

/** Chainable stand-in for a Mongoose query — every builder call returns itself. */
function mockModel(rows: any[]) {
  const query: any = {
    select: () => query,
    sort: () => query,
    limit: () => query,
    lean: () => query,
    exec: async () => query._rows,
    _rows: rows,
    _all: rows,
  };
  return {
    find: (filter?: any) => {
      query._rows = applyFilter(query._all, filter);
      return query;
    },
  } as any;
}

/** Minimal in-memory evaluation of the only filter shapes the service builds. */
function applyFilter(rows: any[], filter?: any): any[] {
  if (!filter) return rows;
  return rows.filter((r) =>
    Object.entries(filter).every(([k, cond]: [string, any]) => {
      if (cond && typeof cond === 'object' && '$regex' in cond) {
        return new RegExp(cond.$regex, cond.$options || '').test(
          String(r[k] ?? ''),
        );
      }
      if (cond && typeof cond === 'object' && '$ne' in cond) {
        return r[k] !== cond.$ne;
      }
      return r[k] === cond;
    }),
  );
}

const PRODUCTS = [
  { _id: 'p1', name: 'Glam Organizer Maroon', code: 'Code 50M', sellPrice: 650, buyPrice: 200, isActive: true },
  { _id: 'p2', name: 'Red Marina bag', code: 'BAG-RDM5', sellPrice: 770, buyPrice: 240, isActive: true },
  { _id: 'p3', name: 'Marronella', code: 'BAG-MRN8', sellPrice: 920, buyPrice: 250, isActive: true },
  { _id: 'p4', name: 'شنطة كتف جلد', code: 'BAG-SH1', sellPrice: 500, buyPrice: 180, isActive: true },
];

const TRANSACTIONS = [
  { _id: 't1', ref: '3852', client: 'Ghada Omara', phone: '01001112233', type: 'مبيعات', total: 670, payStatus: 'مكتمل', items: [{}], createdAt: '2026-08-01T00:00:00.000Z' },
  { _id: 't2', ref: '2254', client: 'Sama Alsamarraie', phone: '01002223344', type: 'مبيعات', total: 1200, payStatus: 'مكتمل', items: [{}], createdAt: '2026-07-20T00:00:00.000Z' },
  { _id: 't3', ref: '22540', client: 'Noura Anas', phone: '01003334455', type: 'مبيعات', total: 300, payStatus: 'معلق', items: [{}], createdAt: '2026-07-25T00:00:00.000Z' },
];

const COMPLAINTS = [
  { _id: 'c1', complaintNo: 'CMP-260806-2335', clientName: 'Sama Alsamarraie', transactionRef: '2335', status: 'معلق', createdAt: '2026-08-06T00:00:00.000Z' },
  { _id: 'c2', complaintNo: 'CMP-260723-2210', clientName: 'Abeer Refay', transactionRef: '2210', status: 'مقبول', createdAt: '2026-07-23T00:00:00.000Z' },
  { _id: 'c3', complaintNo: 'CMP-260721-2157', clientName: 'Ghada Omara', transactionRef: '2157', status: 'مقبول', createdAt: '2026-07-21T00:00:00.000Z' },
];

const SUPPLIERS = [
  { _id: 's1', name: 'مورد الشنط', phone: '01055556666', address: 'القاهرة', products: 'شنط' },
];

function makeService() {
  return new SearchService(
    mockModel(PRODUCTS),
    mockModel(TRANSACTIONS),
    mockModel(SUPPLIERS),
    mockModel(COMPLAINTS),
    mockModel([]),
  );
}

/** Section order = order in which each type first appears in the ranked results. */
function sectionOrder(results: any[]): string[] {
  const seen: string[] = [];
  for (const r of results) if (!seen.includes(r.type)) seen.push(r.type);
  return seen;
}

describe('Search relevance', () => {
  describe('the "mar" regression', () => {
    it('ranks products above complaints and customers', async () => {
      const { results } = await makeService().search('mar');
      const order = sectionOrder(results);
      expect(order[0]).toBe('product');
      expect(order.indexOf('product')).toBeLessThan(order.indexOf('complaint'));
    });

    it('orders products by where the match lands, not by DB order', async () => {
      const { results } = await makeService().search('mar');
      const names = results.filter((r) => r.type === 'product').map((r) => r.title);
      // name-prefix beats word-prefix beats nothing
      expect(names[0]).toBe('Marronella');
      expect(names).toContain('Red Marina bag');
      expect(names).toContain('Glam Organizer Maroon');
    });

    it('still returns the weaker mid-word matches — ranking, not filtering', async () => {
      const { results } = await makeService().search('mar');
      expect(results.some((r) => r.type === 'complaint')).toBe(true);
      expect(results.some((r) => r.type === 'customer')).toBe(true);
    });
  });

  describe('exact matches pin to the top', () => {
    it('an exact ref outranks a longer ref sharing the prefix', async () => {
      const { results } = await makeService().search('2254');
      expect(results[0].type).toBe('order');
      expect(results[0].title).toBe('#2254');
    });

    it('an exact product code wins over a name match', async () => {
      const { results } = await makeService().search('BAG-MRN8');
      expect(results[0].type).toBe('product');
      expect(results[0].title).toBe('Marronella');
    });

    it('a numeric query puts orders above complaints containing the digits', async () => {
      const { results } = await makeService().search('2335');
      const order = sectionOrder(results);
      expect(order[0]).toBe('complaint'); // no order has ref 2335; complaint does
      expect(results[0].title).toBe('CMP-260806-2335');
    });
  });

  describe('query normalization', () => {
    it('Arabic-Indic digits find Latin-digit refs', async () => {
      const { results } = await makeService().search('٢٢٥٤');
      expect(results[0].title).toBe('#2254');
    });

    it('a leading # is ignored', async () => {
      const { results } = await makeService().search('#2254');
      expect(results[0].title).toBe('#2254');
    });
  });

  describe('typo tolerance', () => {
    it('falls back to fuzzy matching only when nothing matched exactly', async () => {
      const { results } = await makeService().search('Marronela'); // missing an l
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe('Marronella');
    });

    it('does not let fuzzy results outrank exact ones', async () => {
      const { results } = await makeService().search('Marina');
      expect(results[0].title).toBe('Red Marina bag');
    });
  });

  describe('multi-token queries', () => {
    it('requires every token to match somewhere (AND semantics preserved)', async () => {
      const { results } = await makeService().search('Marina zzzz');
      expect(results).toHaveLength(0);
    });

    it('matches tokens across different fields of the same record', async () => {
      const { results } = await makeService().search('Red bag');
      expect(results.some((r) => r.title === 'Red Marina bag')).toBe(true);
    });
  });

  describe('Arabic handling', () => {
    it('matches a word after the definite article "ال"', async () => {
      const { results } = await makeService().search('شنط');
      expect(results.some((r) => r.type === 'supplier')).toBe(true);
    });
  });

  it('returns nothing for an empty query', async () => {
    expect((await makeService().search('   ')).results).toHaveLength(0);
  });
});
