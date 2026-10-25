import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const states = require('../../../frontend/public/order-status.js');
const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
function shippedFunction(name: string, source = html) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function: ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function fixture() {
  const pill = { outerHTML: '' }, host = { innerHTML: '' };
  const order: any = { _id: 'local1', status: 'pending' };
  const context: any = {
    SouliaOrderStatus: states, currentLang: 'ar', transactions: [], _spPeekId: order._id,
    _spOrderById: () => order, qs: (selector: string) => selector === '#sp-pk-fu' ? host : pill,
    _spPeekHistoryState: () => new Map(), _spPeekScrollTrail: () => {}, _spPeekFuHtml: () => 'Follow-up',
  };
  runInNewContext(['_orderStateMeta', '_orderStateBadge', '_spPeekStatePill', '_puStatusBadge', '_puDisplayStatus', '_gsOrderStatus', '_spPeekRefreshFu'].map(name => shippedFunction(name)).join('\n'), context);
  return { context, order, pill };
}
describe('The same order state is rendered across application views', () => {
  it.each(['ar', 'en'])('shows cancellation prominently and replaces the composer shortcut with the closed trail (%s)', lang => {
    const context: any = {
      currentLang: lang, _SP_PK_ICO: {}, _spPeekFuState: 'ready',
      _spFollowUpsFor: () => [{ _id: 'f1', status: 'في انتظار العميل', responsibleName: 'Malak', reason: '', comments: [], createdAt: '2026-10-18' }],
      FU_STATUS_STYLES: { 'العميل ألغى الطلب': { bg: 'red', color: 'white' } },
      _fuStatusLabel: (value: string) => value, _fuReasonLabel: () => '',
      esc: (value: any) => String(value || ''), escHtml: (value: any) => String(value || ''),
      users: [], userAvatarHtml: () => '', fmtN: String, _pwWhenFull: () => '', _pwWhen: () => '',
    };
    runInNewContext(shippedFunction('_spPeekFuHtml'), context);
    const cancelled = context._spPeekFuHtml({ cancelled: true, cancelReason: 'الرقم غلط' });
    expect(cancelled).toContain('العميل ألغى الطلب');
    expect(cancelled).toContain('role="status"');
    expect(cancelled).toContain('الرقم غلط');
    expect(cancelled).toContain(lang === 'en' ? 'Open follow-up trail' : 'فتح مسار المتابعة');
    expect(cancelled).not.toContain(lang === 'en' ? 'Add note or call' : 'إضافة ملاحظة أو مكالمة');
    const active = context._spPeekFuHtml({ cancelled: false });
    expect(active).not.toContain('sp-pk-fu-outcome');
    expect(active).toContain(lang === 'en' ? 'Add note or call' : 'إضافة ملاحظة أو مكالمة');
  });
  it.each([
    { status: 'pending' },
    { status: 'pending', shipWithoutDeposit: true },
    { status: 'pending', depositReceipts: [{ status: 'معتمد', amount: 500 }] },
    { status: 'pending', depositReceipts: [{ status: 'معلق', amount: 500 }] },
    { status: 'pending', cancelled: true },
  ])('shares the Shopify state between search and quick view: %j', row => {
    const { context } = fixture();
    expect(context._spPeekStatePill(row)).toBe(states.badge(states.resolve(row, 'shopify', 'ar')));
  });
  it('uses current transaction data over an older search payload', () => {
    const { context } = fixture();
    context.transactions = [{ _id: 't1', pickupStatus: 'Shipped', bostaOrderId: 'b1', bostaStatus: 'DELIVERED', shipCo: 'Bosta' }];
    const meta = context._gsOrderStatus({ id: 't1', orderState: { pickupStatus: 'Pending' } });
    expect(meta.key).toBe('DELIVERED');
    expect(context._puStatusBadge('Shipped', context.transactions[0])).toBe(states.badge(meta));
  });
  it('updates the header after an approval without reopening the panel', () => {
    const { context, order, pill } = fixture();
    expect(context._spPeekStatePill(order)).toContain('بانتظار تأكيد العميل');
    order.shipWithoutDeposit = true;
    context._spPeekRefreshFu();
    expect(pill.outerHTML).toContain('مؤكّد · بانتظار التجهيز');
  });
  it('resolves registered Shopify orders through their linked invoice', () => {
    const { context } = fixture();
    context.transactions = [{ _id: 't1', pickupStatus: 'Preparing' }];
    expect(context._spPeekStatePill({ status: 'approved', transactionId: 't1' })).toContain('قيد التجهيز');
  });
  it('does not count an unapproved receipt as confirmation in the summary', () => {
    const { context } = fixture();
    context._spFollowUpsFor = () => [];
    context._fuIsSettled = () => false;
    context._payMethodLabel = (value: string) => value;
    const kpis = readFileSync(resolve(__dirname, '../../../frontend/public/shopify-kpis.js'), 'utf8');
    runInNewContext(shippedFunction('_spDepositOf') + '\n' + shippedFunction('_spkBucket', kpis), context);
    expect(context._spkBucket({ status: 'pending', depositReceipts: [{ status: 'معلق', amount: 500 }] })).toBe('open');
    expect(context._spkBucket({ status: 'pending', depositReceipts: [{ status: 'معتمد', amount: 500 }] })).toBe('deposit');
    expect(context._spkBucket({ status: 'pending', shipWithoutDeposit: true })).toBe('nodep');
  });
  it('matches the ready-to-ship filter when a linked carrier has not returned a status yet', () => {
    const { context } = fixture();
    const row = { bostaOrderId: 'b1', pickupStatus: 'Pending' };
    expect(context._puDisplayStatus(row)).toBe('Ready');
    expect(context._orderStateMeta(row).key).toBe('Ready');
  });
});
