import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
function fixture(workspace: any = {}) {
  const env: any = {
    _myWorkspace: workspace, _myShowOtherTasks: false, currentLang: 'en', _myWsFailed: false,
    _fuIsSettled: (f: any) => !!f.settled, _customerCancelledConfirmation: () => false,
    _canAccessPage: () => true, esc: String,
  };
  for (const name of ['myFollowUpPriorities', 'myDeliveryIssueCount', 'myPendingConfirmationCount', 'myTaskOverview', 'myWorkspacePeriodLabel', 'renderMyWorkspaceNotice']) {
    const start = html.indexOf(`function ${name}(`);
    runInNewContext(html.slice(start, html.indexOf('\n}', start) + 2), env);
  }
  return env;
}

describe('employee dashboard task accounting', () => {
  it('counts distinct orders consistently across delivery, follow-up and confirmation', () => {
    const env = fixture({ openFollowUpsCount: 2, pendingConfirmationCount: 2,
      followUps: [{ id: 'delivery', shopifyOrderId: 'a', autoSource: 'shipping-issue' }, { id: 'followup', orderRef: '#42' }],
      orders: [{ id: 'a', needsConfirmation: true }, { ref: '43', needsConfirmation: true }],
    });
    expect(env.myTaskOverview()).toEqual({ total: 3, followups: 2, confirmations: 1, partial: false });
    expect(env.myDeliveryIssueCount()).toBe(1);
    expect(env.myFollowUpPriorities().map((r: any) => r.f.id)).toEqual(['delivery']);
    env._myShowOtherTasks = true;
    expect(env.myFollowUpPriorities()).toHaveLength(2);
  });
  it('shows pending confirmation when the only delivery issue is scheduled', () => {
    const env = fixture({ openFollowUpsCount: 1, deliveryIssueFollowUpsCount: 1,
      followUps: [{ id: 'scheduled', autoSource: 'shipping-issue', deferredUntil: new Date(Date.now() + 3600000).toISOString() }],
      orders: [{ ref: 'pending', needsConfirmation: true }],
    });
    expect(env.myDeliveryIssueCount()).toBe(0);
    expect(env.myFollowUpPriorities().map((r: any) => r.f.orderRef)).toEqual(['pending']);
    expect(env.myTaskOverview().total).toBe(1);
  });
  it('does not reintroduce a scheduled order as an immediate confirmation task', () => {
    const env = fixture({ followUps: [{ id: 'f', shopifyOrderId: 'o', orderRef: '1', deferredUntil: new Date(Date.now() + 60000).toISOString() }],
      orders: [{ id: 'o', ref: '1', needsConfirmation: true }],
    });
    expect(env.myFollowUpPriorities(false)).toHaveLength(0);
  });
  it('returns scheduled work to the correct task tab when due', () => {
    const env = fixture({ followUps: [{ id: 'f', autoSource: 'shipping-issue', deferredUntil: new Date(Date.now() - 1).toISOString() }] });
    expect(env.myDeliveryIssueCount()).toBe(1);
    expect(env.myFollowUpPriorities()[0].due).toBe(true);
  });
  it('excludes closed work from delivery counts even if server counts are stale', () => {
    const env = fixture({ deliveryIssueFollowUpsCount: 1, followUps: [{ id: 'f', autoSource: 'shipping-issue', settled: true }] });
    expect(env.myDeliveryIssueCount()).toBe(0);
  });
  it('discloses tasks outside bounded previews and provides access to full lists', () => {
    const env = fixture({ openFollowUpsCount: 105, pendingConfirmationCount: 201, followUps: [], orders: [] });
    expect(env.myTaskOverview().partial).toBe(true);
    expect(env.renderMyWorkspaceNotice()).toContain('More tasks are available');
    expect(env.renderMyWorkspaceNotice()).toContain('All follow-ups');
    expect(env.renderMyWorkspaceNotice()).toContain('Confirmation orders');
  });
  it('keeps cached data visibly marked after refresh failure', () => {
    const env = fixture(); env._myWsFailed = true;
    expect(env.renderMyWorkspaceNotice()).toContain('previously loaded');
    expect(env.renderMyWorkspaceNotice()).toContain('Retry');
    env._myWsFailed = false;
    expect(env.renderMyWorkspaceNotice()).toBe('');
  });
  it('formats current and previous periods in the selected language', () => {
    const env = fixture({ periodKey: '2026-11', periodLabel: 'نوفمبر 2026' });
    expect(env.myWorkspacePeriodLabel()).toBe('November 2026');
    expect(env.myWorkspacePeriodLabel('2026-10')).toBe('October 2026');
    expect(env.myWorkspacePeriodLabel('2026')).toBe('2026');
    expect(env.myWorkspacePeriodLabel('2026-W44')).toContain('Oct');
    expect(env.myWorkspacePeriodLabel('all')).toBe('All time');
    env.currentLang = 'ar';
    expect(env.myWorkspacePeriodLabel()).toContain('نوفمبر');
  });
});
