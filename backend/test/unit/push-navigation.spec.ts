import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const source = readFileSync(resolve(__dirname, '../../../frontend/public/push-navigation.js'), 'utf8');
const id = '507f1f77bcf86cd799439011';
function fixture(kind: string, type: string, event = '123') {
  const element = { closest: jest.fn(() => ({ open: false })), scrollIntoView: jest.fn(), classList: { add: jest.fn(), remove: jest.fn() } };
  const context: any = {
    URL, CSS: { escape: (s: string) => s },
    location: { href: `https://soulia.test/?pushRecord=${kind}:${id}&pushType=${type}&pushEvent=${event}` },
    history: { replaceState: jest.fn() }, currentUser: { role: 'admin' }, currentLang: 'en', souliaPushAppReady: false,
    transactions: [], api: jest.fn(async () => ({ _id: id, comments: [{ id: 123 }], depositReceipts: [] })),
    navigateTo: jest.fn(), openOrderView: jest.fn(), highlightInvComment: jest.fn(), showInvoicePaymentHistory: jest.fn(),
    loadShopifyOrders: jest.fn(async () => {}), _spOrderById: jest.fn(() => ({ _id: id })),
    openShopifyOrderComments: jest.fn(async () => {}), openSpOrderPeek: jest.fn(), goToFuAndHighlight: jest.fn(async () => {}),
    saveMentionNotifs: jest.fn(), onMentionNotifClick: jest.fn(async () => {}), toast: jest.fn(),
    requestAnimationFrame: (fn: any) => fn(), setTimeout: (fn: any) => fn(),
    document: { querySelector: jest.fn(() => element) },
  };
  context.window = context; runInNewContext(source, context); context.souliaPushAppReady = true;
  return { context, element };
}
describe('Notification event routing', () => {
  it('opens the authenticated employee profile for their own points notification', async () => {
    const { context } = fixture('performance', 'performance'); context.currentUser = { id, role: 'staff' };
    await context.souliaOpenPendingPush();
    expect(context.navigateTo).toHaveBeenCalledWith('userhub'); expect(context.api).not.toHaveBeenCalled();
  });
  it('does not open another employee performance record', async () => {
    const { context } = fixture('performance', 'performance'); context.currentUser = { id: 'another', role: 'staff' };
    await context.souliaOpenPendingPush();
    expect(context.navigateTo).not.toHaveBeenCalledWith('userhub'); expect(context.toast).toHaveBeenCalled();
  });
  it.each(['otp', 'audit', 'return', 'vault', 'product', 'expense', 'supplierReturn'])('blocks staff navigation to admin-only %s events', async kind => {
    const { context } = fixture(kind, 'approval'); context.currentUser.role = 'staff';
    expect(await context.souliaOpenPendingPush()).toBe(false); expect(context.api).not.toHaveBeenCalled();
  });
  it('opens the exact security event even when it is outside the recent log page', async () => {
    const { context, element } = fixture('audit', 'security');
    context._securityLogs = []; context._securityLogPage = 1;
    context.loadSecurityPanel = jest.fn(async () => {}); context._renderSecurityLogPage = jest.fn();
    await context.souliaOpenPendingPush();
    expect(context.api).toHaveBeenCalledWith('/security-audit/logs/' + id);
    expect(context.navigateTo).toHaveBeenCalledWith('users'); expect(context._securityLogPage).toBe(0);
    expect(element.scrollIntoView).toHaveBeenCalled();
  });
  it('opens the exact OTP request beyond the recent 500 rows without loading twice', async () => {
    const { context, element } = fixture('otp', 'otp');
    context.api.mockImplementation(async (url: string) => url === '/discount-otp' ? [] : { _id: id });
    context.document.getElementById = jest.fn(() => ({ value: '' }));
    context.switchApprTab = jest.fn(); context.renderOtpAudit = jest.fn(async () => {});
    context.renderOtpTablePage = jest.fn(); context.OTP_PAGE_SIZE = 25;
    context._otpAuditAllRows = []; context._otpAuditPage = 1;
    await context.souliaOpenPendingPush();
    expect(context.api).toHaveBeenCalledWith('/discount-otp/record/' + id);
    expect(context.switchApprTab.mock.calls[0][2]).toBe(false);
    expect(context._otpAuditAllRows[0]._id).toBe(id); expect(element.scrollIntoView).toHaveBeenCalled();
  });
  it('opens the notified vault entry with the existing detail viewer', async () => {
    const { context } = fixture('vault', 'approval'); context.vaultLog = []; context.openVaultTransactionDetail = jest.fn();
    await context.souliaOpenPendingPush();
    expect(context.api).toHaveBeenCalledWith('/vault/' + id);
    expect(context.openVaultTransactionDetail).toHaveBeenCalledWith(id);
  });
  it('preserves the cash register lock and defers its target until unlock', async () => {
    const { context } = fixture('vault', 'approval');
    context.vaultLog = []; context.vaultUnlocked = false;
    context.openVaultTx = jest.fn(); context.openVaultTransactionDetail = jest.fn();
    context.api.mockResolvedValue({ _id: id, txNo: 'VLT-1' });
    await context.souliaOpenPendingPush();
    expect(context.openVaultTx).toHaveBeenCalledWith('VLT-1');
    expect(context.openVaultTransactionDetail).not.toHaveBeenCalled();
  });
  it('waits for login and startup data before opening the exact transaction comment', async () => {
    const { context } = fixture('tx', 'comment'); context.currentUser = null; context.souliaPushAppReady = false;
    expect(await context.souliaOpenPendingPush()).toBe(false); expect(context.api).not.toHaveBeenCalled();
    context.currentUser = { role: 'admin' }; context.souliaPushAppReady = true;
    // Startup may already have changed the URL; the captured target is retained.
    context.location.href = 'https://soulia.test/#home';
    expect(await context.souliaOpenPendingPush()).toBe(true);
    expect(context.api).toHaveBeenCalledWith('/transactions/' + id);
    expect(context.openOrderView).toHaveBeenCalledWith(id); expect(context.highlightInvComment).toHaveBeenCalledWith(123);
    expect(await context.souliaOpenPendingPush()).toBe(false);
  });
  it('opens the precise Shopify comment after loading orders', async () => {
    const { context } = fixture('shopify', 'comment'); await context.souliaOpenPendingPush();
    expect(context.loadShopifyOrders).toHaveBeenCalledTimes(1); expect(context.openShopifyOrderComments).toHaveBeenCalledWith(id, '123');
  });
  it('opens Shopify receipts and highlights the notified receipt', async () => {
    const { context, element } = fixture('shopify', 'deposit', 'receipt-123'); await context.souliaOpenPendingPush();
    expect(context.openSpOrderPeek).toHaveBeenCalledWith(id);
    expect(context.document.querySelector).toHaveBeenCalledWith('#sp-peek [data-push-receipt-id="receipt-123"]');
    expect(element.scrollIntoView).toHaveBeenCalled(); expect(element.classList.add).toHaveBeenCalledWith('comment-mention-highlight');
    expect(context.openShopifyOrderComments).not.toHaveBeenCalled();
  });
  it('expands the transaction receipt section before highlighting it', async () => {
    const { context, element } = fixture('tx', 'deposit', 'receipt-123');
    const details = { open: false }; element.closest.mockReturnValue(details);
    context.api.mockResolvedValue({ _id: id, depositReceipts: [{ id: 'receipt-123' }] });
    await context.souliaOpenPendingPush(); expect(details.open).toBe(true); expect(context.showInvoicePaymentHistory).not.toHaveBeenCalled();
  });
  it('opens the deposit payment history for manual deposits', async () => {
    const { context } = fixture('tx', 'deposit', 'deposit-123'); await context.souliaOpenPendingPush();
    expect(context.showInvoicePaymentHistory).toHaveBeenCalledWith(id);
    expect(context.document.querySelector).toHaveBeenCalledWith('[data-push-payment-id="deposit-123"]');
  });
  it('opens the exact follow-up thread comment', async () => {
    const { context } = fixture('followup', 'comment', id); await context.souliaOpenPendingPush();
    expect(context.goToFuAndHighlight).toHaveBeenCalledWith(id, true, id, true);
  });
  it('opens staff order comments through the authenticated transaction API', async () => {
    const { context } = fixture('tx', 'comment'); context.currentUser.role = 'staff';
    expect(await context.souliaOpenPendingPush()).toBe(true); expect(context.api).toHaveBeenCalledWith('/transactions/' + id); expect(context.highlightInvComment).toHaveBeenCalledWith(123);
  });
  it('routes staff mentions through the existing authorized mention flow', async () => {
    const { context } = fixture('mention', 'mention'); context.currentUser.role = 'staff';
    context.api.mockResolvedValue([{ id, txId: 'shopify:order', commentId: 123 }]);
    await context.souliaOpenPendingPush(); expect(context.onMentionNotifClick).toHaveBeenCalledWith(id, 'shopify:order', 123);
  });
  it('shows fetch failures instead of opening an old cached event', async () => {
    const { context } = fixture('tx', 'comment'); context.api.mockRejectedValue(new Error('Access denied'));
    await context.souliaOpenPendingPush(); expect(context.toast).toHaveBeenCalledWith('Access denied', true); expect(context.openOrderView).not.toHaveBeenCalled();
  });
});

describe('Native notification clicks', () => {
  it.each([false, true])('opens the full event URL when the existing tab is unavailable: %s', async navigateFails => {
    const handlers: any = {};
    const target = `/?pushRecord=tx:${id}&pushType=comment&pushEvent=123`;
    const openWindow = jest.fn(async () => {});
    const self = { addEventListener: (name: string, fn: any) => handlers[name] = fn, location: { origin: 'https://soulia.test' }, clients: {
      matchAll: async () => navigateFails ? [{ url: 'https://soulia.test/', navigate: async () => { throw new Error('Tab closed'); } }] : [], openWindow,
    } };
    runInNewContext(readFileSync(resolve(__dirname, '../../../frontend/public/push-sw.js'), 'utf8'), { self, URL });
    let work: any; handlers.notificationclick({ notification: { close: jest.fn(), data: { url: target } }, waitUntil: (p: any) => work = p });
    await work; expect(openWindow).toHaveBeenCalledWith('https://soulia.test' + target);
  });
});
