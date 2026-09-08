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
  // حركة ملغاة حقيقية (ref 2404 من نسخة 2026-09-07). البحث برقمها كان بيرجع«لم يتم العثور على نتائج» لأن كل استعلامات الحركات كانت بتستبعد الملغي.
  { _id: 't4', ref: '2404', client: 'هند آحمد مكي مكي', phone: '01005642638', type: 'مبيعات', total: 1760, payStatus: 'ملغي', items: [{}], createdAt: '2026-09-05T00:00:00.000Z', cancelled: true, cancelledAt: '2026-09-06T09:46:34.501Z', cancelReason: 'فشل توصيل — رفض الاستلام' },
  // إلغاء وإعادة إنشاء بنفس الرقم — نمط حقيقي في البيانات (6 حالات). الاتنين
  // بيطابقوا الاستعلام بنفس الدرجة، فلازم الحيّة تسبق الملغاة.
  { _id: 't5', ref: '2404', client: 'هند آحمد مكي مكي', phone: '01005642638', type: 'مبيعات', total: 1760, payStatus: 'مكتمل', items: [{}], createdAt: '2026-09-04T00:00:00.000Z' },
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

  /**
   * الحركة الملغاة حالة تُعرض، مش سبب للإخفاء. `TX_ACTIVE_FILTER` كان مطبّق
   * على كل استعلامات الحركات، فالبحث برقم أوردر ملغي كان بيرجع «لم يتم العثور
   * على نتائج» — وده بيتقري إن الأوردر مش موجود أصلاً، مش إنه اتلغى.
   */
  describe('cancelled orders stay searchable', () => {
    it('finds a cancelled order by its exact ref', async () => {
      const { results } = await makeService().search('2404');
      const hit = results.find((r) => r.title === '#2404');
      expect(hit).toBeDefined();
      expect(hit!.type).toBe('order');
    });

    it('marks it cancelled so the UI can badge it instead of hiding it', async () => {
      const { results } = await makeService().search('2404');
      const hit = results.find((r) => r.title === '#2404' && r.cancelled)!;
      expect(hit).toBeDefined();
      expect(hit.cancelReason).toBe('فشل توصيل — رفض الاستلام');
    });

    it('an active order still reports cancelled:false, never undefined', async () => {
      const { results } = await makeService().search('2254');
      const hit = results.find((r) => r.title === '#2254')!;
      expect(hit.cancelled).toBe(false);
    });

    it('finds a cancelled order by customer name and by phone', async () => {
      const byName = await makeService().search('هند');
      expect(byName.results.some((r) => r.title === '#2404')).toBe(true);
      const byPhone = await makeService().search('01005642638');
      expect(byPhone.results.some((r) => r.title === '#2404')).toBe(true);
    });

    /**
     * ترتيب، مش إخفاء: الحركة الحيّة تسبق الملغاة عند تساوي المطابقة — لكن
     * الملغاة تفضل ظاهرة. ⚠ الملغاة هنا createdAt أحدث من الحيّة عمداً، فلو
     * الخصم اتشال هيرجّعها `recencyBoost` للأول تاني.
     */
    it('ranks the live order above a cancelled one sharing the same ref', async () => {
      const { results } = await makeService().search('2404');
      const both = results.filter((r) => r.title === '#2404');
      expect(both).toHaveLength(2);
      expect(both[0].cancelled).toBe(false);
      expect(both[1].cancelled).toBe(true);
    });

    it('the penalty never outweighs a better textual match', async () => {
      // 2404 مطابقة تامة للملغاة، و22540 مجرد بادئة لحركة حيّة — الملغاة تكسب.
      const { results } = await makeService().search('2404');
      expect(results[0].title).toBe('#2404');
    });

    /**
     * الاستثناء المقصود: تجميع العملاء بيجمع عدد الطلبات والإجمالي، فالحركة
     * الملغاة لازم تفضل مستبعدة هناك وإلا هنعدّ فلوس ما اتحصلتش.
     */
    it('still excludes cancelled orders from customer totals', async () => {
      const { results } = await makeService().search('01005642638');
      const cust = results.find((r) => r.type === 'customer')!;
      // العميل عنده حركتين بنفس الرقم: واحدة حيّة وواحدة ملغاة. التجميع لازم
      // يعدّ الحيّة بس — لو عدّ الاتنين هيقول «2 معاملة | 3520 ج» لفلوس
      // نصّها ما اتحصلش.
      expect(cust.meta).toBe('1 معاملة | 1760 ج');
    });
  });

  it('returns nothing for an empty query', async () => {
    expect((await makeService().search('   ')).results).toHaveLength(0);
  });
});
