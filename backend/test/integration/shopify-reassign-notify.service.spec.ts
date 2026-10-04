/**
 * Shopify manual (re)assignment must NOT announce itself as a new order.
 *
 * Bug (Oct 5, 2026): reassignOrder reused notifyOrderAssigned, whose text is
 * «أوردر جديد مُسند إليك». The client dispatches on «مُسند» to draw the new-order
 * card and play the new-order sound, so assigning an order that had arrived hours
 * earlier read as a brand-new order — to the assignee, and to the admin who had
 * just pressed the button.
 *
 * Run with: npm test -- shopify-reassign-notify
 */
export {};

jest.mock('../../src/employee-performance/employee-scoring.service', () => ({
  EmployeeScoringService: class {},
}));

function ShopifyServiceClass(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../src/shopify/shopify.service').ShopifyService;
}

function setup(orderOverrides: Record<string, unknown> = {}) {
  const order: any = {
    _id: 'o1', ref: '#2685', client: 'Hagar Saleh', total: 1670, status: 'pending',
    depositDetectedAt: '2026-10-01T00:00:00Z', assignmentHistory: [], ...orderOverrides,
  };
  order.save = jest.fn().mockImplementation(async () => order);
  const svc = Object.create(ShopifyServiceClass().prototype);
  svc.shopifyOrderModel = { findById: jest.fn().mockResolvedValue(order) };
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.usersService = {
    findById: jest.fn().mockImplementation(async (id: string) => ({
      u2: { _id: 'u2', name: 'Gannh', username: 'gannh', role: 'staff' },
      u3: { _id: 'u3', name: 'Hassan Ammar', username: 'hassan', role: 'staff' },
    } as any)[id] || null),
    findAdmins: jest.fn().mockResolvedValue([{ _id: 'a1' }, { _id: 'a2' }]),
  };
  const created: any[] = [];
  svc.mentionsService = { createMany: jest.fn().mockImplementation(async (rows: any[]) => { created.push(...rows); return rows; }) };
  svc.presence = { emitToUser: jest.fn() };
  svc.employeeScoringService = { scoreDepositDetection: jest.fn().mockResolvedValue(undefined) };
  return { svc, order, created };
}

const flush = () => new Promise((r) => setImmediate(r));
const firstLine = (row: any) => String(row.commentText).split('\n')[0];

describe('ShopifyService.reassignOrder — notification', () => {
  it('tells the assignee it was ASSIGNED to them, never «أوردر جديد»', async () => {
    const { svc, created } = setup();
    const res = await svc.reassignOrder('o1', 'u2', '', 'Reem', 'a1');
    await flush();
    expect(res).toEqual({ success: true });
    const mine = created.find((r) => r.targetUserId === 'u2');
    expect(firstLine(mine)).toBe('تم إسناد الأوردر إليك: #2685');
    for (const r of created) {
      expect(firstLine(r)).not.toMatch(/مُسند/);      // the client's new-order trigger
      expect(r.commentText).not.toMatch(/أوردر جديد/);
    }
    expect(mine.commentText).toContain('بواسطة: Reem');
  });

  it('skips the admin who did it; other admins get the third-person line', async () => {
    const { svc, created } = setup();
    await svc.reassignOrder('o1', 'u2', '', 'Reem', 'a1');
    await flush();
    expect(created.map((r) => r.targetUserId).sort()).toEqual(['a2', 'u2']);
    expect(firstLine(created.find((r) => r.targetUserId === 'a2'))).toBe('تم إسناد الأوردر إلى Gannh: #2685');
  });

  it('tells the PREVIOUS assignee the order moved away from them', async () => {
    const { svc, created } = setup({ assignedTo: 'u3', assignedToName: 'Hassan Ammar' });
    await svc.reassignOrder('o1', 'u2', '', 'Reem', 'a1');
    await flush();
    const prev = created.find((r) => r.targetUserId === 'u3');
    expect(firstLine(prev)).toBe('تم نقل الأوردر منك إلى Gannh: #2685');
    expect(created.find((r) => r.targetUserId === 'u2').commentText).toContain('السابق: Hassan Ammar');
  });

  it('a brand-new order still uses the new-order wording (unchanged)', async () => {
    const { svc, order, created } = setup({ assignedToName: 'Gannh' });
    await svc.notifyOrderAssigned(order, 'u2');
    expect(firstLine(created.find((r) => r.targetUserId === 'u2'))).toBe('أوردر جديد مُسند إليك: #2685');
  });
});
