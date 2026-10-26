import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const start = html.indexOf('async function openMyFollowUpTrail(');
const source = html.slice(start, html.indexOf('\n}', start) + 2);
function reminderFixture() {
  const now = Date.now();
  const context: any = { Date, currentLang: 'en', currentUser: { _id: 'employee' }, _myShowOtherTasks: false,
    _myDueRemindersSeen: new Set(), _myWorkspace: { followUps: [
      { id: 'future', orderRef: '1', deferredUntil: new Date(now + 60000).toISOString() },
      { id: 'due', orderRef: '2', clientName: 'Customer', deferredUntil: new Date(now - 60000).toISOString() },
      { id: 'shipping', orderRef: '3', autoSource: 'shipping-issue', lastActivityAt: new Date(now - 86400000).toISOString() },
      { id: 'closed', orderRef: '4', settled: true, deferredUntil: new Date(now - 120000).toISOString() },
    ] }, _fuIsSettled: (f: any) => !!f.settled, _customerCancelledConfirmation: () => false,
    myDeliveryIssueCount: () => 1, toast: jest.fn(), window: { refreshMyFollowUpSession: jest.fn() },
    renderMyKpis: jest.fn(), qs: () => null, qsa: () => [], fmtN: String,
  };
  for (const name of ['myFollowUpPriorities', 'syncMyFollowUpWaitLabels', 'scheduleMyDueFollowUpWakeup']) {
    const index = html.indexOf(`function ${name}(`);
    runInNewContext(html.slice(index, html.indexOf('\n}', index) + 2), context);
  }
  return context;
}
it('places due follow-ups first across task tabs, excluding scheduled and resolved tasks', () => {
  const context = reminderFixture();
  expect(context.myFollowUpPriorities().map((row: any) => row.f.id)).toEqual(['due', 'shipping']);
  context._myShowOtherTasks = true;
  expect(context.myFollowUpPriorities().map((row: any) => row.f.id)).toEqual(['due']);
});
it('alerts once per due appointment and redraws the priority cards', () => {
  const context = reminderFixture();
  context.syncMyFollowUpWaitLabels();
  context.syncMyFollowUpWaitLabels();
  expect(context.toast).toHaveBeenCalledTimes(1);
  expect(context.toast).toHaveBeenCalledWith(expect.stringContaining('#2 Customer'));
  expect(context.renderMyKpis).toHaveBeenCalled();
});
it('wakes up at the appointment without waiting for a refresh', () => {
  jest.useFakeTimers();
  try {
    const context = reminderFixture();
    Object.assign(context, { clearTimeout, setTimeout, _myDueReminderTimer: null, isAdmin: () => false });
    context.scheduleMyDueFollowUpWakeup();
    jest.advanceTimersByTime(60051);
    expect(context.myFollowUpPriorities()[0].due).toBe(true);
    expect(context.toast).toHaveBeenCalledWith(expect.stringContaining('#2 Customer (+1)'));
  } finally { jest.useRealTimers(); }
});
function fixture() {
  const context: any = { _myTrailOpenRequest: 0, followUps: [],
    _requirePageAccess: jest.fn(() => true), api: jest.fn().mockResolvedValue([{ _id: 'f1', comments: [{ _id: 'c1' }] }]),
    openFuCommentPopup: jest.fn(), navigateTo: jest.fn(), toast: jest.fn(), t: (key: string) => key,
  };
  runInNewContext(source, context);
  return context;
}

it('opens the full trail popup and highlights the comment without navigating away', async () => {
  const context = fixture(), trigger = { setAttribute: jest.fn(), removeAttribute: jest.fn() };
  await context.openMyFollowUpTrail('f1', 'c1', trigger);
  expect(context.api).toHaveBeenCalledWith('/followups');
  expect(context.openFuCommentPopup).toHaveBeenCalledWith('f1', 'c1');
  expect(context.navigateTo).not.toHaveBeenCalled();
  expect(trigger.removeAttribute).toHaveBeenCalledWith('aria-busy');
});
it('does not open a missing or inaccessible follow-up', async () => {
  const context = fixture();
  context._requirePageAccess.mockReturnValueOnce(false);
  await context.openMyFollowUpTrail('f1');
  expect(context.api).not.toHaveBeenCalled();
  context.api.mockResolvedValueOnce([]);
  await context.openMyFollowUpTrail('missing');
  expect(context.openFuCommentPopup).not.toHaveBeenCalled();
  expect(context.toast).toHaveBeenCalledWith('fuNotFound', true);
});
it('shows a fetch error without changing the current page or opening stale content', async () => {
  const context = fixture();
  context.api.mockRejectedValueOnce(new Error('Network failed'));
  await context.openMyFollowUpTrail('f1');
  expect(context.openFuCommentPopup).not.toHaveBeenCalled();
  expect(context.navigateTo).not.toHaveBeenCalled();
  expect(context.toast).toHaveBeenCalledWith('Network failed', true);
});
it('uses the popup handler on scheduled follow-up buttons', () => {
  const name = 'renderMyDeferredWork', index = html.indexOf(`function ${name}(`);
  const render = html.slice(index, html.indexOf('\n}', index) + 2);
  const context: any = {
    currentLang: 'en', myDeferredFollowUps: () => [{ id: 'f1', orderRef: '2911', deferReason: 'awaiting_customer', deferredUntil: '2026-10-26T15:00:00Z' }],
    myDeferredFollowUpCount: () => 1, esc: String, escHtml: String, fmtN: String, fmtDateTime: String,
    myDeferReasonLabel: String, renderMyFollowUpComment: () => '', renderMyDeferredTime: () => '',
  };
  runInNewContext(render, context);
  const markup = context.renderMyDeferredWork();
  expect(markup).toContain("openMyFollowUpTrail('f1','',this)");
  expect(markup).not.toContain('goToFuAndHighlight');
  expect(markup).not.toContain('navigateTo');
});
it('shows Cairo follow-up time in 12-hour format with a remaining-time countdown', () => {
  const index = html.indexOf('function renderMyDeferredTime(');
  const context: any = { currentLang: 'en', esc: String, escHtml: String, fmtN: String, fmtDateTime: String };
  runInNewContext(html.slice(index, html.indexOf('\n}', index) + 2), context);
  const markup = context.renderMyDeferredTime(new Date(Date.now() + 95 * 60000).toISOString());
  expect(markup).toMatch(/AM|PM/i);
  expect(markup).toContain('In 1h 35m');
  expect(markup).toContain('role="timer"');
  expect(context.renderMyDeferredTime('invalid')).toBe('');
});
it('renders icon-only phone and Vrobo links with accessible labels when requested', () => {
  const index = html.indexOf('function renderMyFollowUpContacts(');
  const context: any = { currentLang: 'en', esc: String, escHtml: String,
    _fdWaPhone: (phone: string) => phone, _fdVroboUrl: (phone: string) => 'https://vrobo.test/' + phone,
    _FDC_PHONE_ICON: '<svg class="phone-icon"></svg>', _SP_VROBO_ICON: '<span class="sp-vrobo-ic">V</span>',
  };
  runInNewContext(html.slice(index, html.indexOf('\n}', index) + 2), context);
  const markup = context.renderMyFollowUpContacts({ clientPhone: '201000002307' }, true);
  expect(markup).toContain('href="tel:+201000002307"');
  expect(markup).toContain('aria-label="Call customer"');
  expect(markup).toContain('aria-label="Contact via Vrobo"');
  expect(markup).not.toContain('<span>Call</span>');
  expect(markup).not.toContain('<span>Vrobo</span>');
  expect(context.renderMyFollowUpContacts({ clientPhone: '201000002307' })).toContain('<span>Call</span>');
});
