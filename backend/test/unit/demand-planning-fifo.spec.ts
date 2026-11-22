/* The demand window's stock rules, through the real DemandPlanningService over fake data:
 * oldest first by creation date, all or nothing, MAIN only for Shopify, damaged/lost pieces
 * not sellable, older unselected orders claim first, confirmed orders never subtracted twice. */
import { DemandPlanningService } from '../../src/demand-planning/demand-planning.service';

type Row = Record<string, any>;
const oid = (n: string) => (Buffer.from(n).toString('hex') + '0'.repeat(24)).slice(0, 24);
const name = (id: string) => Buffer.from(id.replace(/0+$/, ''), 'hex').toString();

function chain(rows: Row[]) {
  const q: any = {
    sort: () => q, select: () => q, lean: () => q,
    exec: async () => rows, toArray: async () => rows,
  };
  return q;
}

function build(data: {
  transactions?: Row[];
  shopify?: Row[];
  inventory: Row[];
  products: Row[];
  units?: Row[];
}) {
  const txs = data.transactions || [];
  const db = {
    collection: (name: string) => ({
      find: () => chain(({
        transactions: txs.filter(t => t.type === 'مبيعات' && !t.cancelled),
        products: data.products,
        inventoryunits: data.units || [],
      } as Record<string, Row[]>)[name] || []),
    }),
  };
  const txModel: any = {
    db,
    find: (f: any) => chain(f._id ? txs.filter(t => f._id.$in.includes(String(t._id)))
      : f.ref ? txs.filter(t => f.ref.$in.includes(t.ref))
      : txs.filter(t => t.type === f.type && !t.cancelled && !t.archived)),
  };
  const shop = data.shopify || [];
  const shopifyOrderModel: any = {
    find: (f: any) => chain(f.status
      ? shop.filter(o => o.status === 'pending' && !o.cancelled && !f._id.$nin.map(String).includes(String(o._id)))
      : shop.filter(o => f._id.$in.includes(String(o._id)))),
  };
  const svc = new DemandPlanningService(
    txModel, shopifyOrderModel, { create: async () => ({}) } as any,
    { getInventory: async () => data.inventory } as any,
    { findAll: async () => data.products } as any,
    {} as any, {} as any,
  );
  return svc;
}

const day = (d: number) => `2026-11-${String(d).padStart(2, '0')}T10:00:00.000Z`;
const item = (code: string, qty: number, linked = true) => ({ code, name: 'P ' + code, qty, ...(linked ? { productId: 'p' + code } : {}) });
const sOrder = (id: string, d: number, items: Row[], extra: Row = {}) => ({
  _id: oid(id), ref: id, client: 'C', status: 'pending', shopifyCreatedAt: day(d),
  // the last edit must never decide the order
  updatedAt: day(28 - d), total: 100, items, depositReceipts: [], ...extra,
});

describe('analyzeShopify — oldest first, all or nothing, three kinds of stock', () => {
  const products = [{ _id: 'pA', code: 'A', name: 'A' }, { _id: 'pB', code: 'B', name: 'B' }];
  const inventory = [
    { code: 'A', name: 'A', current: 10, warehouseBalances: { MAIN: 5, W2: 5 } },
    { code: 'B', name: 'B', current: 1, warehouseBalances: { MAIN: 1 } },
  ];
  const units = [
    { _id: 'u1', productId: 'pA', status: 'damaged', warehouseCode: 'MAIN' },
    { _id: 'u2', productId: 'pA', status: 'lost', warehouseCode: 'W2' },   // other warehouse: ignored
  ];
  const transactions = [
    // confirmed, still in MAIN: already out of the balance → shown, never subtracted again
    { _id: oid('t1'), type: 'مبيعات', ref: '900', items: [{ code: 'A', qty: 2 }], warehouseCode: 'MAIN', pickupStatus: 'Preparing' },
  ];
  const shopify = [
    sOrder('U2', 1, [item('A', 5), item('X', 1, false)]),   // older, unselected, unlinked → claims nothing
    sOrder('U1', 1, [item('A', 2)], { shopifyCreatedAt: day(1).replace('10:', '11:') }),   // older, unselected
    sOrder('S4', 2, [item('A', 1), item('Y', 1, false)]),   // selected, unlinked
    sOrder('S1', 3, [item('A', 1), item('B', 2)]),           // B short → takes nothing
    sOrder('S2', 4, [item('A', 2)]),
    sOrder('S3', 5, [item('A', 1)]),
    sOrder('N1', 9, [item('A', 3)]),                          // newer, unselected
  ];

  it('builds the plan and the stock terms', async () => {
    const svc = build({ transactions, shopify, inventory, products, units });
    const a = await svc.analyzeShopify({ orderIds: ['S3', 'S1', 'S2', 'S4'].map(oid), persistLog: false } as any);
    const plan = Object.fromEntries((a.orderPlan || []).map(p => [name(p.transactionId), p]));
    expect(a.orderPlan!.map(p => name(p.transactionId))).toEqual(['S4', 'S1', 'S2', 'S3']);   // creation order
    expect(plan.S4.state).toBe('unlinked');
    expect(plan.S1.state).toBe('short');
    expect(plan.S1.items.find(i => i.sku === 'B')!.missing).toBe(1);
    expect(plan.S2.state).toBe('ready');
    expect(plan.S3.state).toBe('short');
    expect(plan.S3.items[0].freeAtTurn).toBe(0);
    expect(a.queueSize).toBe(7);

    const A = a.lines.find(l => l.sku === 'A')!;
    expect(A.reservedConfirmed).toBe(2);   // shown
    expect(A.onHand).toBe(7);              // MAIN 5 + 2 still on the shelf for t1
    expect(A.notSellable).toBe(1);         // the MAIN damaged piece only
    expect(A.sellable).toBe(4);            // 5 − 1; t1 NOT subtracted again
    expect(A.reservedOlder).toBe(2);       // U1 only (U2 unlinked, N1 newer)
    expect(A.freeToUse).toBe(2);
    expect(a.unlinkedOrders!.map(o => name(o.transactionId))).toEqual(['S4']);
  });

  it('a cancelled older order frees its stock on the next analysis', async () => {
    const without = shopify.map(o => o.ref === 'U1' ? { ...o, cancelled: true } : o);
    const a = await build({ transactions, shopify: without, inventory, products, units })
      .analyzeShopify({ orderIds: ['S1', 'S2', 'S3', 'S4'].map(oid), persistLog: false } as any);
    const st = Object.fromEntries(a.orderPlan!.map(p => [name(p.transactionId), p.state]));
    expect(st.S2).toBe('ready');
    expect(st.S3).toBe('ready');   // the 2 units U1 held are back
  });
});

describe('analyzeShopify — orders that need an action first', () => {
  it('states each refusal the confirmation would give, and keeps the order in the queue', async () => {
    const products = [{ _id: 'pA', code: 'A', name: 'A' }];
    const inventory = [{ code: 'A', name: 'A', current: 10, warehouseBalances: { MAIN: 10 } }];
    const shopify = [
      sOrder('E', 1, [item('A', 1)], { editRequest: { status: 'معلق' } }),
      sOrder('D', 2, [item('A', 1)], { depositReceipts: [{ id: 'r', status: 'معلق', amount: 50 }] }),
      sOrder('B', 3, [item('A', 1)], { depositReceipts: [{ id: 'r', status: 'معتمد', amount: 50 }] }),   // no vaultEntryId
      sOrder('V', 4, [item('A', 1)], { shopifyDivergence: { erpTotal: 90, shopifyTotal: 100, diff: -10, by: 'Reem', at: '2026-11-20T09:00:00Z', changes: ['الخصم اليدوي: 0 ← 10'] } }),
      sOrder('R', 5, [item('A', 1)]),                                       // its number is already a sale
      sOrder('C', 6, [item('A', 1)], { cancelRequest: { status: 'معلق' }, itemSyncConflict: { conflictingKeys: [] } }),
      sOrder('OK', 7, [item('A', 1)]),
    ];
    const transactions = [{ _id: oid('x'), type: 'مبيعات', ref: '#R', items: [], cancelled: true }];
    const a = await build({ shopify, inventory, products, transactions })
      .analyzeShopify({ orderIds: ['E', 'D', 'B', 'V', 'R', 'C', 'OK'].map(oid), persistLog: false } as any);
    const by = Object.fromEntries(a.orderPlan!.map(p => [name(p.transactionId), p]));
    expect(by.E.blocks).toEqual(['edit-pending']);
    expect(by.D.blocks).toEqual(['deposit-review']);
    expect(by.B.blocks).toEqual(['deposit-booking']);
    expect(by.V.blocks).toEqual(['divergence']);
    expect(by.V.divergence).toEqual({ shopifyTotal: 100, erpTotal: 90, diff: -10, by: 'Reem', at: '2026-11-20T09:00:00Z', changes: ['الخصم اليدوي: 0 ← 10'] });
    expect(by.OK.divergence).toBeNull();
    expect(by.R.blocks).toEqual(['dup-ref']);
    expect(by.C.blocks).toEqual(['cancel-request', 'item-conflict']);
    expect(by.OK.blocks).toEqual([]);
    // still served in turn: a blocked order keeps its stock and place
    expect(a.orderPlan!.every(p => p.state === 'ready')).toBe(true);
  });
});

describe('analyze (transactions) — confirmed orders are not subtracted twice', () => {
  it('the selection is ready when the shelf really holds its pieces', async () => {
    // Received 9: confirmed O1 holds 4 (already out of the balance), T1 (selected) needs 2.
    // Ledger = 9 − 4 − 2 = 3. Before the fix: 3 + 2 − 4 = 1 free → «short 1».
    const svc = build({
      products: [{ _id: 'pA', code: 'A', name: 'A' }],
      inventory: [{ code: 'A', name: 'A', current: 3 }],
      transactions: [
        { _id: oid('T1'), type: 'مبيعات', ref: '1', client: 'c', createdAt: new Date(day(2)), items: [{ code: 'A', qty: 2 }], pickupStatus: 'Pending' },
        { _id: oid('O1'), type: 'مبيعات', ref: '2', client: 'c', createdAt: new Date(day(1)), items: [{ code: 'A', qty: 4 }], pickupStatus: 'Preparing' },
      ],
    });
    const a = await svc.analyze({ transactionIds: [oid('T1')], persistLog: false } as any);
    const A = a.lines[0];
    expect(A.reservedConfirmed).toBe(4);
    expect(A.onHand).toBe(9);
    expect(A.freeToUse).toBe(5);
    expect(A.shortage).toBe(0);
    expect(a.orderPlan![0].state).toBe('ready');
  });
});
