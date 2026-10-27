import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const source = readFileSync(resolve(__dirname, '../../../frontend/public/followup-reminders.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(storage = new Map<string, string>()) {
  const buttons: any = {}, hosts: any[] = [], tones: any[] = [];
  const audio: any = { state: 'running', currentTime: 0, destination: {}, resume: jest.fn().mockResolvedValue(undefined),
    createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }),
    createOscillator: () => { const tone = { frequency: { setValueAtTime: jest.fn() }, connect() {}, disconnect() {}, start: jest.fn(), stop: jest.fn() }; tones.push(tone); return tone; },
  };
  const document: any = { hidden: false, addEventListener: jest.fn(), body: { append: (host: any) => hosts.push(host) },
    createElement: () => ({ innerHTML: '', remove: jest.fn(), querySelector: (selector: string) => buttons[selector] ||= {} }),
  };
  const context: any = { currentUser: { _id: 'employee' }, currentLang: 'en', Date, document,
    window: { addEventListener: jest.fn(), AudioContext: function () { return audio; } },
    navigator: { vibrate: jest.fn(), locks: { request: jest.fn(async (_key, fn) => fn()) } },
    localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
    api: jest.fn().mockResolvedValue([]), _canAccessPage: () => true, _fuIsSettled: (row: any) => row.status === 'done',
    escHtml: (text: any) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    myDeferReasonLabel: () => 'Contact to confirm', openMyFollowUpTrail: jest.fn(), fuCommentTargetId: '',
    setTimeout, clearTimeout, setInterval: jest.fn(),
  };
  runInNewContext(source, context);
  return { context, alerts: context.window.souliaFollowUpReminder, hosts, buttons, tones, storage };
}
const row = (extra = {}) => ({ _id: 'ticket', responsibleId: 'employee', deferredUntil: new Date(Date.now() - 1000).toISOString(), orderRef: '2814', clientName: 'Malak', ...extra });

describe('distinct follow-up reminders', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-27T17:01:00Z')); });
  afterEach(() => jest.useRealTimers());

  it('shows a persistent actionable reminder with its own six-note sound', async () => {
    const { alerts, hosts, tones, buttons, context } = fixture(); await flush();
    expect(await alerts.notify(row())).toBe(true); await flush();
    expect(hosts[0].innerHTML).toContain('Time to follow up');
    expect(hosts[0].innerHTML).toContain('#2814');
    expect(hosts[0].innerHTML).toContain('data-open');
    expect(tones).toHaveLength(6);
    expect(context.navigator.vibrate).toHaveBeenCalledTimes(1);
    context.openMyFollowUpTrail.mockImplementation(async () => { context.fuCommentTargetId = 'ticket'; });
    await buttons['[data-open]'].onclick({ currentTarget: {} });
    expect(context.openMyFollowUpTrail).toHaveBeenCalledWith('ticket', '', expect.any(Object));
    expect(hosts[0].remove).toHaveBeenCalled();
  });

  it('deduplicates socket, polling and page reloads but allows a newly scheduled time', async () => {
    const a = fixture(); await flush(); const reminder = row();
    await a.alerts.notify(reminder); await a.alerts.notify(reminder); await flush();
    const b = fixture(a.storage); await flush();
    expect(await b.alerts.notify(reminder)).toBe(false);
    expect(b.hosts).toHaveLength(0);
    expect(a.tones).toHaveLength(6);
    expect(await b.alerts.notify(row({ deferredUntil: new Date(Date.now() - 2000).toISOString() }))).toBe(true);
  });

  it('ignores future, closed, unassigned and other employees’ reminders', async () => {
    const { alerts, hosts } = fixture(); await flush();
    for (const extra of [{ responsibleId: 'other' }, { responsibleId: '' }, { cancelled: true }, { orderOutcome: 'confirmed' }, { status: 'done' }, { deferredUntil: 'invalid' }, { deferredUntil: new Date(Date.now() + 5000).toISOString() }]) {
      expect(await alerts.notify(row(extra))).toBe(false);
    }
    expect(hosts).toHaveLength(0);
  });

  it('revalidates on the exact deadline and removes a reminder after cancellation', async () => {
    const { alerts, context, hosts } = fixture(); await flush();
    const reminder = row({ deferredUntil: new Date(Date.now() + 5000).toISOString() });
    context.api.mockResolvedValue([reminder]); alerts.sync([reminder]);
    await jest.advanceTimersByTimeAsync(5031); await flush();
    expect(hosts).toHaveLength(1);
    alerts.sync([{ ...reminder, cancelled: true }]);
    expect(hosts[0].remove).toHaveBeenCalled();
  });

  it('does not alert if a scheduled reminder is reassigned before its deadline', async () => {
    const { alerts, context, hosts } = fixture(); await flush();
    const reminder = row({ deferredUntil: new Date(Date.now() + 5000).toISOString() });
    context.api.mockResolvedValue([{ ...reminder, responsibleId: 'other' }]); alerts.sync([reminder]);
    await jest.advanceTimersByTimeAsync(5031); await flush();
    expect(hosts).toHaveLength(0);
  });

  it('keeps visual reminders when muted and clears the old account on logout', async () => {
    const { alerts, storage, tones, hosts, context } = fixture(); await flush();
    storage.set('soulia-followup-sound:employee', 'off');
    await alerts.notify(row()); await flush();
    expect(hosts).toHaveLength(1); expect(tones).toHaveLength(0);
    context.currentUser = null; alerts.reset();
    expect(hosts[0].remove).toHaveBeenCalled();
    expect(await alerts.notify(row())).toBe(false);
  });

  it('queues simultaneous reminders without overlapping sounds or losing the next order', async () => {
    const { alerts, hosts, tones, buttons } = fixture(); await flush();
    await alerts.notify(row()); await alerts.notify(row({ _id: 'ticket2', orderRef: '2815' })); await flush();
    expect(hosts[0].innerHTML).toContain('2 follow-ups'); expect(tones).toHaveLength(6);
    buttons['[data-dismiss]'].onclick();
    expect(hosts[0].innerHTML).toContain('#2815');
  });
});

it('requests persistent push and a distinct vibration only for due reminders', async () => {
  const listeners: any = {}, showNotification = jest.fn().mockResolvedValue(undefined);
  runInNewContext(readFileSync(resolve(__dirname, '../../../frontend/public/push-sw.js'), 'utf8'), {
    URL, self: { location: { origin: 'https://soulia.test' }, registration: { showNotification },
      addEventListener: (name: string, fn: any) => { listeners[name] = fn; } },
  });
  let done: any;
  listeners.push({ data: { json: () => ({ title: 'Due', reminder: true, tag: 'event1' }) }, waitUntil: (task: any) => { done = task; } }); await done;
  expect(showNotification).toHaveBeenLastCalledWith('Due', expect.objectContaining({ requireInteraction: true, renotify: true, vibrate: [200, 100, 200, 100, 400] }));
  listeners.push({ data: { json: () => ({ title: 'Ordinary' }) }, waitUntil: (task: any) => { done = task; } }); await done;
  expect(showNotification.mock.calls[1][1].requireInteraction).toBeUndefined();
});
