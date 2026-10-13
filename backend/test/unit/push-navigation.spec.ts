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
  it('keeps regular staff business notifications protected', async () => {
    const { context } = fixture('tx', 'comment'); context.currentUser.role = 'staff';
    expect(await context.souliaOpenPendingPush()).toBe(false); expect(context.api).not.toHaveBeenCalled();
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
