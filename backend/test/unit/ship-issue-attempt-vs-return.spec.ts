import { nextShipIssueState, LEGACY_ATTEMPT_AS_RETURN_FILTER } from '../../src/shared/ship-issue-state.util';
import { carrierExceptionHistory, carrierTrackingUpdate, newCarrierEvents } from '../../src/bosta/bosta-tracking.util';

describe('failed attempt vs return — two states with their own endings', () => {
  it('a failed attempt opens "attempt", never the warehouse question', () => {
    expect(nextShipIssueState('', '', 'FAILED_ATTEMPT')).toBe('attempt');
    expect(nextShipIssueState('closed', 'FAILED_ATTEMPT', 'FAILED_ATTEMPT')).toBe('attempt');
    expect(nextShipIssueState('reshipped', 'RETURNED', 'FAILED_ATTEMPT')).toBe('attempt');
  });

  it('RETURNED opens the return question, and an "attempt" escalates to it', () => {
    expect(nextShipIssueState('', '', 'RETURNED')).toBe('open');
    expect(nextShipIssueState('attempt', 'FAILED_ATTEMPT', 'RETURNED')).toBe('open');
    // «لم تصل بعد» survives a new carrier event on the same return
    expect(nextShipIssueState('awaiting', 'RETURNED', 'RETURNED')).toBe('awaiting');
  });

  it('a failed attempt on a parcel already coming back does not undo the return', () => {
    expect(nextShipIssueState('open', 'RETURNED', 'FAILED_ATTEMPT')).toBe('open');
    expect(nextShipIssueState('awaiting', 'RETURNED', 'FAILED_ATTEMPT')).toBe('awaiting');
  });

  it('a legacy "open" opened by a failed attempt heals to "attempt" on the next attempt', () => {
    expect(nextShipIssueState('open', 'FAILED_ATTEMPT', 'FAILED_ATTEMPT')).toBe('attempt');
    expect(LEGACY_ATTEMPT_AS_RETURN_FILTER).toMatchObject({ shipIssueTrigger: 'FAILED_ATTEMPT', bostaStatus: { $ne: 'RETURNED' } });
  });
});

describe('one carrier event is saved once', () => {
  // The reported case: customer not at the address, rescheduled to the next day.
  const time = '2026-11-15T12:30:05.000Z';
  const scheduledAt = '2026-11-16T21:59:59.000Z';
  const d = {
    state: { code: 47, exception: [{ code: 1, reason: 'Customer not at address', time, scheduledAt }] },
    timeStamp: Date.parse('2026-11-15T12:30:41.000Z'),
    numberOfAttempts: 1,
  };
  const live = carrierTrackingUpdate(d, 'FAILED_ATTEMPT', 'محاولة تسليم فاشلة', 'S1',
    { code: 1, reason: 'Customer not at address', at: time, scheduledAt }, 'webhook', '2026-11-15T12:31:00.000Z');
  const history = carrierExceptionHistory(d, 'S1');

  it('the history copy and the live copy of the same attempt have different keys (why it doubled)', () => {
    expect(history).toHaveLength(1);
    expect(history[0].key).not.toBe(live.key);
  });

  it('first sync saves the attempt once', () => {
    expect(newCarrierEvents([], history, live, true)).toHaveLength(1);
  });

  it('a later sync adds nothing when either copy is already saved', () => {
    expect(newCarrierEvents(history, history, live, true)).toHaveLength(0);
    expect(newCarrierEvents([live], history, live, true)).toHaveLength(0);
  });

  it('a second, different attempt is still saved', () => {
    const t2 = '2026-11-16T10:00:00.000Z';
    const d2 = { ...d, state: { code: 47, exception: [...d.state.exception, { code: 7, reason: 'No answer', time: t2 }] } };
    const live2 = carrierTrackingUpdate(d2, 'FAILED_ATTEMPT', 'محاولة تسليم فاشلة', 'S1',
      { code: 7, reason: 'No answer', at: t2, scheduledAt: '' }, 'webhook', t2, live);
    const added = newCarrierEvents([live], carrierExceptionHistory(d2, 'S1'), live2, true);
    expect(added).toHaveLength(1);
    expect(added[0].exceptionAt).toBe(t2);
  });
});
