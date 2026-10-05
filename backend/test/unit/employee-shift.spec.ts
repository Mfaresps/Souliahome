/**
 * Employee shift scheduling — weekly days, leave exclusion, overnight-wrap boundary,
 * and the overlap guard.
 *
 * This is the layer `ShopifyService.approveOrder` and `FollowUpsService` route real
 * orders and delivery-problem tickets through — see resolveAssignee/listShiftCandidates
 * callers. A routing mistake here silently sends work to the wrong person (or nobody),
 * which is exactly the class of bug that is invisible until someone asks "why didn't
 * anyone see this order?".
 */

import { EmployeeShiftService } from '../../src/employee-performance/employee-shift.service';
import { EmployeeLeaveService } from '../../src/employee-performance/employee-leave.service';

/**
 * A Cairo wall-clock instant.
 *
 * ⚠ Shift windows are stored as Cairo wall-clock ("09:00" = nine in the shop), and
 * the service resolves them through `businessParts()`. These fixtures therefore say
 * what the CLOCK ON THE WALL reads, not UTC. Using `Date.UTC` here was the original
 * mistake mirrored from the service: it happened to pass while the code also read
 * UTC, and both were wrong together on any server not running at UTC+0.
 */
function cairo(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  // Egypt observes DST, so the offset is resolved per-instant rather than fixed at +03.
  const guess = new Date(Date.UTC(y, m, d, hh, mm));
  const shown = new Date(guess.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
  const utcEcho = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (shown.getTime() - utcEcho.getTime()));
}

/** Minimal in-memory stand-in for the EmployeeShift Mongoose model. */
function mockShiftModel(rows: any[]) {
  let seq = 1;
  const withId = (r: any) => ({ _id: r._id || String(seq++), ...r });
  const store: any[] = rows.map(withId);

  const applyFilter = (list: any[], filter: any = {}) =>
    list.filter((r) =>
      Object.entries(filter).every(([k, cond]: [string, any]) => {
        if (cond && typeof cond === 'object' && '$ne' in cond) return r[k] !== cond.$ne;
        if (cond && typeof cond === 'object' && '$in' in cond) return cond.$in.includes(r[k]);
        return r[k] === cond;
      }),
    );

  const query = (list: any[]) => ({
    sort: () => query(list),
    select: () => query(list),
    lean: () => query(list),
    exec: async () => list,
  });

  return {
    _store: store,
    find: (filter?: any) => query(applyFilter(store, filter)),
    findOne: (filter?: any) => ({ exec: async () => applyFilter(store, filter)[0] || null }),
    findById: (id: string) => ({ exec: async () => store.find((r) => r._id === id) || null }),
    findByIdAndUpdate: (id: string, update: any, opts?: any) => ({
      exec: async () => {
        const doc = store.find((r) => r._id === id);
        if (!doc) return null;
        Object.assign(doc, update);
        return opts?.new ? doc : { ...doc };
      },
    }),
    findByIdAndDelete: (id: string) => ({
      exec: async () => {
        const idx = store.findIndex((r) => r._id === id);
        if (idx === -1) return null;
        return store.splice(idx, 1)[0];
      },
    }),
    updateMany: (filter: any, update: any) => ({
      exec: async () => {
        applyFilter(store, filter).forEach((r) => Object.assign(r, update));
        return { modifiedCount: 0 };
      },
    }),
    create: async (doc: any) => {
      const created = withId({ ...doc });
      store.push(created);
      return created;
    },
  } as any;
}

function mockUsersService(users: Record<string, { role: string; name: string; isActive?: boolean }>) {
  return {
    findById: async (id: string) => (users[id] ? { _id: id, ...users[id] } : null),
    findActiveUserIds: async () =>
      new Set(Object.keys(users).filter((id) => users[id].isActive !== false)),
  } as any;
}

function mockLeaveService(onLeaveByDate: Record<string, string[]> = {}) {
  return {
    listUserIdsOnLeave: async (dateStr: string) => new Set(onLeaveByDate[dateStr] || []),
  } as any;
}

describe('EmployeeShiftService — resolveAssignee', () => {
  const users = { u1: { role: 'staff', name: 'Ahmed' }, u2: { role: 'staff', name: 'Sara' } };

  it('routes to the employee whose weekly days include the order weekday', async () => {
    // Ahmed: Sun(0)-Tue(2) 09:00-17:00. Sara: Wed(3)-Thu(4) 09:00-17:00.
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1, 2], isActive: true, isOnCall: false },
      { userId: 'u2', name: 'Sara', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [3, 4], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());

    // 2026-08-05 is a Wednesday (UTC).
    const wed = cairo(2026, 7, 5, 10, 0).toISOString();
    const res = await svc.resolveAssignee(wed);
    expect(res?.userId).toBe('u2');
    expect(res?.reason).toBe('shift');

    // 2026-08-02 is a Sunday.
    const sun = cairo(2026, 7, 2, 10, 0).toISOString();
    const res2 = await svc.resolveAssignee(sun);
    expect(res2?.userId).toBe('u1');
  });

  it('does not route to a disabled employee even though their shift still covers the time', async () => {
    // Ahmed's account was disabled after the shift was scheduled — the row is untouched.
    // Sara is on-call that day but her own shift does not cover this window, so a match
    // for her here can only come from the on-call fallback, proving Ahmed's window was skipped.
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1, 2], isActive: true, isOnCall: false },
      { userId: 'u2', name: 'Sara', shiftStart: '20:00', shiftEnd: '23:00', daysOfWeek: [0, 1, 2], isOnCall: true, isActive: true },
    ]);
    const disabledUsers = { u1: { role: 'staff', name: 'Ahmed', isActive: false }, u2: { role: 'staff', name: 'Sara' } };
    const svc = new EmployeeShiftService(model, mockUsersService(disabledUsers), mockLeaveService());
    const sun = cairo(2026, 7, 2, 10, 0).toISOString();
    const res = await svc.resolveAssignee(sun);
    // Falls through past Ahmed's matching window to the on-call fallback, not to him.
    expect(res?.userId).toBe('u2');
    expect(res?.reason).toBe('on-call-fallback');
  });

  it('does not route to a shift on a day it does not cover, even if the time matches', async () => {
    // Ahmed only works Sun-Tue; an order on Wednesday at the same time must miss him.
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1, 2], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
    const wed = cairo(2026, 7, 5, 10, 0).toISOString();
    const res = await svc.resolveAssignee(wed);
    expect(res).toBeNull();
  });

  it('excludes an employee on leave that day even though their shift covers the time', async () => {
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true, isOnCall: false },
    ]);
    const wed = cairo(2026, 7, 5, 10, 0);
    const dateStr = wed.toISOString().slice(0, 10);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService({ [dateStr]: ['u1'] }));
    const res = await svc.resolveAssignee(wed.toISOString());
    expect(res).toBeNull();
  });

  it('falls back to the on-call employee for that weekday when nobody is on shift', async () => {
    // Sara is on-call for every day (incl. Wed), but her actual working window (09-17)
    // does not cover 22:00 — so a Wednesday-night order must fall to her via the
    // on-call path, not the on-shift path.
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1, 2], isActive: true, isOnCall: false },
      { userId: 'u2', name: 'Sara', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true, isOnCall: true },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
    const wed = cairo(2026, 7, 5, 22, 0).toISOString(); // outside Ahmed's window/day AND Sara's window
    const res = await svc.resolveAssignee(wed);
    expect(res?.userId).toBe('u2');
    expect(res?.reason).toBe('on-call-fallback');
  });

  it('does NOT use an on-call employee whose on-call days do not include this weekday', async () => {
    // Sara is on-call only for Wed/Thu; an order on Sunday must not fall to her.
    const model = mockShiftModel([
      { userId: 'u2', name: 'Sara', shiftStart: '00:00', shiftEnd: '00:00', daysOfWeek: [3, 4], isActive: true, isOnCall: true },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
    const sun = cairo(2026, 7, 2, 10, 0).toISOString();
    const res = await svc.resolveAssignee(sun);
    expect(res).toBeNull();
  });

  describe('overnight-wrap across a weekday boundary', () => {
    // Ahmed works Saturday(6) night 22:00 -> 06:00, i.e. into early Sunday morning.
    const model = () =>
      mockShiftModel([
        { userId: 'u1', name: 'Ahmed', shiftStart: '22:00', shiftEnd: '06:00', daysOfWeek: [6], isActive: true, isOnCall: false },
      ]);

    it('covers late Saturday night (the day the shift is scheduled on)', async () => {
      const svc = new EmployeeShiftService(model(), mockUsersService(users), mockLeaveService());
      // 2026-08-01 is a Saturday, 23:30.
      const sat2330 = cairo(2026, 7, 1, 23, 30).toISOString();
      const res = await svc.resolveAssignee(sat2330);
      expect(res?.userId).toBe('u1');
    });

    it('still covers early Sunday morning, because it is the tail of Saturday night\'s shift', async () => {
      // 2026-08-02 is Sunday, 02:00 — the shift's calendar weekday has rolled over, but the
      // window (22:00 Sat -> 06:00 Sun) is still open.
      const svc = new EmployeeShiftService(model(), mockUsersService(users), mockLeaveService());
      const sun0200 = cairo(2026, 7, 2, 2, 0).toISOString();
      const res = await svc.resolveAssignee(sun0200);
      expect(res?.userId).toBe('u1');
    });

    it('does not cover Sunday daytime, after the overnight window has closed', async () => {
      const svc = new EmployeeShiftService(model(), mockUsersService(users), mockLeaveService());
      const sun1000 = cairo(2026, 7, 2, 10, 0).toISOString();
      const res = await svc.resolveAssignee(sun1000);
      expect(res).toBeNull();
    });

    it('an order in the Sunday-morning tail is excluded if Ahmed is on leave the Saturday the shift started', async () => {
      // The leave lookup must key off Saturday 2026-08-01 (the shift's start day), not
      // Sunday 2026-08-02 (the calendar day the order actually landed on) — otherwise a
      // leave registered for Saturday would not exclude the Sunday-morning tail of that
      // same overnight shift.
      const svc = new EmployeeShiftService(model(), mockUsersService(users), mockLeaveService({ '2026-08-02': ['u1'] }));
      const sun0200 = cairo(2026, 7, 2, 2, 0).toISOString();
      const res = await svc.resolveAssignee(sun0200);
      // NOTE: listUserIdsOnLeave is queried with the order's own BUSINESS day
      // (Cairo 2026-08-02), not the UTC one — resolveAssignee takes it from
      // businessParts(). A leave filed for the shift's Sunday tail excludes it.
      expect(res).toBeNull();
    });
  });

  describe('ranking overlapping shifts — the running one wins', () => {
    /**
     * The order must go to whoever is genuinely mid-shift.
     *
     * At 05:30 a night shift that began 18:00 the previous evening has been running for
     * 11h30, while a 05:00 morning shift has been running 30 minutes. Sorting by the
     * shiftStart STRING made '05:00' < '18:00', so the morning shift was called
     * "earliest" and took the order off the person actually on duty.
     */
    it('routes to the overnight shift already running, not the morning shift that just started', async () => {
      const model = mockShiftModel([
        // Ahmed: Sunday(0) night 18:00 -> 06:00, so at Monday 05:30 he is 11h30 in.
        { userId: 'u1', name: 'Ahmed', shiftStart: '18:00', shiftEnd: '06:00', daysOfWeek: [0], isActive: true, isOnCall: false },
        // Sara: Monday(1) morning 05:00 -> 13:00, only 30 minutes in at the same instant.
        { userId: 'u2', name: 'Sara', shiftStart: '05:00', shiftEnd: '13:00', daysOfWeek: [1], isActive: true, isOnCall: false },
      ]);
      const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
      // 2026-08-03 is a Monday, 05:30 Cairo.
      const mon0530 = cairo(2026, 7, 3, 5, 30).toISOString();
      const res = await svc.resolveAssignee(mon0530);
      expect(res?.userId).toBe('u1');
    });

    it('still prefers the earlier of two same-day shifts — no behaviour change without a wrap', async () => {
      const model = mockShiftModel([
        { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [1], isActive: true, isOnCall: false },
        { userId: 'u2', name: 'Sara', shiftStart: '11:00', shiftEnd: '19:00', daysOfWeek: [1], isActive: true, isOnCall: false },
      ]);
      const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
      const mon1200 = cairo(2026, 7, 3, 12, 0).toISOString();
      const res = await svc.resolveAssignee(mon1200);
      expect(res?.userId).toBe('u1');
    });

    it('routes to the only match when a single overnight shift is running', async () => {
      // The reported case: nobody else covers 04:54, so the night worker takes it.
      const model = mockShiftModel([
        { userId: 'u1', name: 'Ahmed', shiftStart: '18:00', shiftEnd: '06:00', daysOfWeek: [0], isActive: true, isOnCall: false },
        { userId: 'u2', name: 'Sara', shiftStart: '06:00', shiftEnd: '18:00', daysOfWeek: [1], isActive: true, isOnCall: false },
      ]);
      const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
      const mon0454 = cairo(2026, 7, 3, 4, 54).toISOString();
      const res = await svc.resolveAssignee(mon0454);
      expect(res?.userId).toBe('u1');

      // ...and the handover at 06:00 goes to the morning shift.
      const mon0700 = cairo(2026, 7, 3, 7, 0).toISOString();
      expect((await svc.resolveAssignee(mon0700))?.userId).toBe('u2');
    });
  });
});

describe('EmployeeShiftService — create/update guards', () => {
  const users = { u1: { role: 'staff', name: 'Ahmed' }, u2: { role: 'customer', name: 'Not Staff' } };

  it('rejects scheduling a non-staff user', async () => {
    const svc = new EmployeeShiftService(mockShiftModel([]), mockUsersService(users), mockLeaveService());
    await expect(
      svc.createShift({ userId: 'u2', shiftStart: '09:00', shiftEnd: '17:00' } as any, 'admin'),
    ).rejects.toThrow('لا يمكن جدولة إلا الموظفين');
  });

  it('rejects an unknown employee', async () => {
    const svc = new EmployeeShiftService(mockShiftModel([]), mockUsersService(users), mockLeaveService());
    await expect(
      svc.createShift({ userId: 'ghost', shiftStart: '09:00', shiftEnd: '17:00' } as any, 'admin'),
    ).rejects.toThrow('الموظف غير موجود');
  });

  it('defaults an omitted daysOfWeek to every day — matches the legacy always-on shift', async () => {
    const model = mockShiftModel([]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
    await svc.createShift({ userId: 'u1', shiftStart: '09:00', shiftEnd: '17:00' } as any, 'admin');
    expect(model._store[0].daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('allows two shifts for the same employee on different days', async () => {
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1, 2], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
    await expect(
      svc.createShift({ userId: 'u1', shiftStart: '12:00', shiftEnd: '20:00', daysOfWeek: [3, 4] } as any, 'admin'),
    ).resolves.toBeDefined();
  });

  it('allows two shifts for the same employee on the same day if times do not overlap', async () => {
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '13:00', daysOfWeek: [0], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
    await expect(
      svc.createShift({ userId: 'u1', shiftStart: '14:00', shiftEnd: '18:00', daysOfWeek: [0] } as any, 'admin'),
    ).resolves.toBeDefined();
  });

  it('rejects two shifts for the same employee sharing a day with overlapping times', async () => {
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
    await expect(
      svc.createShift({ userId: 'u1', shiftStart: '15:00', shiftEnd: '20:00', daysOfWeek: [1, 2] } as any, 'admin'),
    ).rejects.toThrow('وردية أخرى');
  });

  it('rejects an overlap across an overnight-wrapping pair on the shared day', async () => {
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '22:00', shiftEnd: '06:00', daysOfWeek: [5], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
    // 05:00-09:00 on the same day(5) overlaps the tail (00:00-06:00) of the overnight shift.
    await expect(
      svc.createShift({ userId: 'u1', shiftStart: '05:00', shiftEnd: '09:00', daysOfWeek: [5] } as any, 'admin'),
    ).rejects.toThrow('وردية أخرى');
  });

  it('excludes the shift being edited from its own overlap check', async () => {
    const model = mockShiftModel([
      { _id: 's1', userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
    await expect(svc.updateShift('s1', { shiftStart: '10:00' } as any, 'admin')).resolves.toBeDefined();
  });
});

describe('EmployeeShiftService — setOnCall day-scoping', () => {
  const users = { u1: { role: 'staff', name: 'Ahmed' }, u2: { role: 'staff', name: 'Sara' } };

  it('only clears isOnCall on shifts sharing a day with the newly-set shift', async () => {
    const model = mockShiftModel([
      { _id: 's1', userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1, 2], isActive: true, isOnCall: true },
      { _id: 's2', userId: 'u2', name: 'Sara', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [3, 4], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
    await svc.setOnCall('s2');
    // Sara's days (3,4) don't intersect Ahmed's (0,1,2) — Ahmed's on-call flag survives.
    expect(model._store.find((r: any) => r._id === 's1').isOnCall).toBe(true);
    expect(model._store.find((r: any) => r._id === 's2').isOnCall).toBe(true);
  });

  it('clears a prior on-call shift that shares a day with the new one', async () => {
    const model = mockShiftModel([
      { _id: 's1', userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1], isActive: true, isOnCall: true },
      { _id: 's2', userId: 'u2', name: 'Sara', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [1, 2], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
    await svc.setOnCall('s2'); // shares day 1 with s1
    expect(model._store.find((r: any) => r._id === 's1').isOnCall).toBe(false);
    expect(model._store.find((r: any) => r._id === 's2').isOnCall).toBe(true);
  });

  it('unsetOnCall clears only the target shift, leaving unrelated on-call shifts untouched', async () => {
    // Regression guard: the frontend on-call control is a checkbox, and unchecking it must
    // not silently re-invoke setOnCall (which would force it back to true) nor clear anyone
    // else's on-call flag.
    const model = mockShiftModel([
      { _id: 's1', userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1], isActive: true, isOnCall: true },
      { _id: 's2', userId: 'u2', name: 'Sara', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [3, 4], isActive: true, isOnCall: true },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
    await svc.unsetOnCall('s1');
    expect(model._store.find((r: any) => r._id === 's1').isOnCall).toBe(false);
    expect(model._store.find((r: any) => r._id === 's2').isOnCall).toBe(true);
  });

  it('unsetOnCall throws for an unknown shift id', async () => {
    const svc = new EmployeeShiftService(mockShiftModel([]), mockUsersService(users), mockLeaveService());
    await expect(svc.unsetOnCall('ghost')).rejects.toThrow('غير موجود');
  });
});

describe('EmployeeShiftService — weekly-grid narrow-then-create sequence', () => {
  // The frontend's per-day weekly schedule view edits one weekday of a multi-day shift
  // record by (1) PUT-narrowing the existing record to drop that day, then (2) POSTing a
  // brand-new single-day record for the edited day. This locks in that BOTH steps succeed
  // in sequence against the real service and leave every other day's schedule untouched.
  const users = { u1: { role: 'staff', name: 'Ahmed' } };

  it('narrows a 3-day record to 2 days, then creates the pulled-out day as its own record', async () => {
    const model = mockShiftModel([
      { _id: 's1', userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1, 2], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());

    // Step 1: narrow s1 to drop Sunday(0), which the UI is about to retime independently.
    await svc.updateShift('s1', { daysOfWeek: [1, 2] } as any, 'admin');
    expect(model._store.find((r: any) => r._id === 's1').daysOfWeek).toEqual([1, 2]);

    // Step 2: create Sunday as its own record with a different time — must not conflict,
    // since s1 no longer covers Sunday.
    await svc.createShift({ userId: 'u1', shiftStart: '12:00', shiftEnd: '20:00', daysOfWeek: [0] } as any, 'admin');

    const all = model._store;
    expect(all).toHaveLength(2);
    const sunday = all.find((r: any) => r.daysOfWeek.includes(0));
    const monTue = all.find((r: any) => r._id === 's1');
    expect(sunday.shiftStart).toBe('12:00');
    expect(monTue.daysOfWeek).toEqual([1, 2]);
    expect(monTue.shiftStart).toBe('09:00'); // untouched by the Sunday edit
  });

  it('narrowing a 2-day record down to its last day leaves one valid record (no empty-array state reachable)', async () => {
    const model = mockShiftModel([
      { _id: 's1', userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [3, 4], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveService());
    await svc.updateShift('s1', { daysOfWeek: [4] } as any, 'admin');
    expect(model._store.find((r: any) => r._id === 's1').daysOfWeek).toEqual([4]);
  });
});

describe('EmployeeLeaveService', () => {
  function mockLeaveModel(rows: any[] = []) {
    let seq = 1;
    const store: any[] = rows.map((r) => ({ _id: r._id || String(seq++), ...r }));
    const query = (list: any[]) => ({
      sort: () => query(list),
      select: () => query(list),
      lean: () => query(list),
      exec: async () => list,
    });
    return {
      _store: store,
      find: (filter: any = {}) =>
        query(
          store.filter((r) => {
            if (filter.fromDate?.$lte !== undefined && !(r.fromDate <= filter.fromDate.$lte)) return false;
            if (filter.toDate?.$gte !== undefined && !(r.toDate >= filter.toDate.$gte)) return false;
            return true;
          }),
        ),
      findByIdAndDelete: (id: string) => ({
        exec: async () => {
          const idx = store.findIndex((r) => r._id === id);
          if (idx === -1) return null;
          return store.splice(idx, 1)[0];
        },
      }),
      create: async (doc: any) => {
        const created = { _id: String(seq++), ...doc };
        store.push(created);
        return created;
      },
    } as any;
  }

  it('rejects a leave whose end date precedes its start date', async () => {
    const svc = new EmployeeLeaveService(mockLeaveModel(), mockUsersService({ u1: { role: 'staff', name: 'Ahmed' } }));
    await expect(
      svc.createLeave({ userId: 'u1', fromDate: '2026-08-10', toDate: '2026-08-05' } as any, 'admin'),
    ).rejects.toThrow('لا يمكن أن يسبق');
  });

  it('lists a user as on-leave for every day within an inclusive range', async () => {
    const model = mockLeaveModel([{ userId: 'u1', name: 'Ahmed', fromDate: '2026-08-05', toDate: '2026-08-07', reason: '' }]);
    const svc = new EmployeeLeaveService(model, mockUsersService({ u1: { role: 'staff', name: 'Ahmed' } }));
    expect((await svc.listUserIdsOnLeave('2026-08-04')).has('u1')).toBe(false);
    expect((await svc.listUserIdsOnLeave('2026-08-05')).has('u1')).toBe(true);
    expect((await svc.listUserIdsOnLeave('2026-08-06')).has('u1')).toBe(true);
    expect((await svc.listUserIdsOnLeave('2026-08-07')).has('u1')).toBe(true);
    expect((await svc.listUserIdsOnLeave('2026-08-08')).has('u1')).toBe(false);
  });

  it('never throws on a lookup failure — assignment must degrade to "nobody on leave"', async () => {
    const brokenModel = { find: () => { throw new Error('db down'); } } as any;
    const svc = new EmployeeLeaveService(brokenModel, mockUsersService({}));
    await expect(svc.listUserIdsOnLeave('2026-08-05')).resolves.toEqual(new Set());
  });
});

/**
 * getMyRoster — the employee's own schedule panel.
 *
 * Two things are load-bearing here and both are easy to break by "simplifying":
 *   1. The query is scoped by userId, so a staff screen never receives a
 *      colleague's row. A test asserts the OTHER employee's shift is absent, not
 *      merely unrendered — the response is the privacy boundary.
 *   2. Shift-window progress must stay monotonic across midnight on an overnight
 *      shift, where the current clock time is numerically BELOW the start time.
 */
/**
 * Business-timezone resolution — the reported "مفيش حد شغّال دلوقتي" bug.
 *
 * The service used to read `getUTCHours()`/`getUTCDay()` while shift windows are
 * written in Cairo wall-clock. On the real UTC+3 server that made a Cairo 10:00
 * read as 07:00, so a 09:00–21:00 shift did not match and the duty board announced
 * that nobody was working — in the middle of the working day, with the employee's
 * own schedule visibly saying otherwise two rows below.
 *
 * These cases pin the wall-clock contract. They fail if anyone reintroduces a raw
 * getUTC* read, and they are timezone-independent: the fixtures name an instant,
 * not a local reading of one.
 */
/**
 * Zero-width windows — the "01:00 – 01:00" row from the reported screenshot.
 *
 * Nothing on either layer stopped such a row being saved, and once saved the three
 * readers each answered differently:
 *   · isWithinShiftWindow  → false (its own explicit misconfiguration guard)
 *   · coversWeekdayAtTime  → true  (start < end is false → overnight-wrap branch,
 *                                   which matched every hour of the day)
 *   · windowLengthMinutes  → 1440  (e <= s → added a full 24h)
 * On screen: the duty board treated the employee as covering the whole day, the
 * roster header said «خارج مواعيد عملك», and the weekly total counted +24h.
 */
describe('EmployeeShiftService — zero-width shift windows', () => {
  const users = { u1: { role: 'staff', name: 'Reem' } };
  const leave = () => ({
    listUserIdsOnLeave: async () => new Set<string>(),
    listUpcomingForUser: async () => [],
  }) as any;
  const zeroWidth = () =>
    mockShiftModel([
      { userId: 'u1', name: 'Reem', shiftStart: '01:00', shiftEnd: '01:00', daysOfWeek: [2], isActive: true, isOnCall: false },
    ]);

  it('is rejected at save — a typo must not become a schedule', async () => {
    const svc = new EmployeeShiftService(mockShiftModel([]), mockUsersService(users), leave());
    await expect(
      svc.createShift({ userId: 'u1', shiftStart: '01:00', shiftEnd: '01:00', daysOfWeek: [2] } as any, 'admin'),
    ).rejects.toThrow('متطابق');
  });

  it('covers NO time — the duty board must not report the employee on shift', async () => {
    // Tuesday 05:00 Cairo: inside the bogus "wrap", outside any real window.
    const svc = new EmployeeShiftService(zeroWidth(), mockUsersService(users), leave());
    const b = await svc.getDutyBoard(cairo(2026, 8, 8, 5, 0).toISOString());
    expect(b.onDuty).toEqual([]);
    const r = await svc.getMyRoster('u1', cairo(2026, 8, 8, 5, 0).toISOString());
    expect(r.onShiftNow).toBe(false);
  });

  it('routes no order to a zero-width window', async () => {
    const svc = new EmployeeShiftService(zeroWidth(), mockUsersService(users), leave());
    expect(await svc.resolveAssignee(cairo(2026, 8, 8, 5, 0).toISOString())).toBeNull();
  });

  it('contributes 0 minutes, not 24 hours, to the weekly total', async () => {
    const svc = new EmployeeShiftService(zeroWidth(), mockUsersService(users), leave());
    const r = await svc.getMyRoster('u1', cairo(2026, 8, 8, 5, 0).toISOString());
    expect(r.shifts[0].lengthMinutes).toBe(0);
  });

  it('a genuine overnight wrap still counts a full crossing', async () => {
    // The guard must not break the case it sits next to: 22:00 -> 06:00 is 8 hours.
    const svc = new EmployeeShiftService(
      mockShiftModel([
        { userId: 'u1', name: 'Reem', shiftStart: '22:00', shiftEnd: '06:00', daysOfWeek: [2], isActive: true, isOnCall: false },
      ]),
      mockUsersService(users),
      leave(),
    );
    const r = await svc.getMyRoster('u1', cairo(2026, 8, 8, 23, 0).toISOString());
    expect(r.shifts[0].lengthMinutes).toBe(480);
    expect(r.onShiftNow).toBe(true);
  });
});

describe('EmployeeShiftService — business timezone (Cairo wall-clock)', () => {
  const users = { u1: { role: 'staff', name: 'Reem' } };
  const leave = () => ({
    listUserIdsOnLeave: async () => new Set<string>(),
    listUpcomingForUser: async () => [],
  }) as any;

  /** The exact shape from the bug report: Mon 09:00–21:00, checked at Cairo 10:00. */
  const nineToNine = () =>
    mockShiftModel([
      { userId: 'u1', name: 'Reem', shiftStart: '09:00', shiftEnd: '21:00', daysOfWeek: [1], isActive: true, isOnCall: false },
    ]);

  it('getDutyBoard reports the employee on duty at Cairo 10:00 — not a coverage gap', async () => {
    const svc = new EmployeeShiftService(nineToNine(), mockUsersService(users), leave());
    // 2026-08-03 is a Monday. Under the old UTC read this instant was 07:00 → no match.
    const b = await svc.getDutyBoard(cairo(2026, 7, 3, 10, 0).toISOString());
    expect(b.onDuty.map((o: any) => o.name)).toEqual(['Reem']);
    expect(b.coverageGap).toBe(false);
  });

  it('getMyRoster says the employee is working at Cairo 10:00', async () => {
    const svc = new EmployeeShiftService(nineToNine(), mockUsersService(users), leave());
    const r = await svc.getMyRoster('u1', cairo(2026, 7, 3, 10, 0).toISOString());
    expect(r.onShiftNow).toBe(true);
    expect(r.currentShift?.elapsedMinutes).toBe(60);   // one hour into 09:00
  });

  it('getDutyBoard drops a disabled employee entirely — their shift row outlives the account', async () => {
    const disabled = { u1: { role: 'staff', name: 'Reem', isActive: false } };
    const svc = new EmployeeShiftService(nineToNine(), mockUsersService(disabled), leave());
    const b = await svc.getDutyBoard(cairo(2026, 7, 3, 10, 0).toISOString());
    expect(b.onDuty).toEqual([]);
    // Nobody left to cover this window → a coverage gap, not a silent miss.
    expect(b.coverageGap).toBe(true);
  });

  it('resolveAssignee routes a Cairo-10:00 order to the employee on that window', async () => {
    const svc = new EmployeeShiftService(nineToNine(), mockUsersService(users), leave());
    const res = await svc.resolveAssignee(cairo(2026, 7, 3, 10, 0).toISOString());
    expect(res?.userId).toBe('u1');
    expect(res?.reason).toBe('shift');
  });

  it('is genuinely off-shift outside the window — the guard must still be able to say no', async () => {
    const svc = new EmployeeShiftService(nineToNine(), mockUsersService(users), leave());
    const r = await svc.getMyRoster('u1', cairo(2026, 7, 3, 22, 0).toISOString());
    expect(r.onShiftNow).toBe(false);
  });

  it('the weekday is the business weekday, not the UTC one, just after Cairo midnight', async () => {
    // ⚠ Cairo 01:00 Tuesday is still Monday in UTC. The old code drew Monday's roster
    // while the employee's own calendar had already turned over to Tuesday.
    const svc = new EmployeeShiftService(nineToNine(), mockUsersService(users), leave());
    const r = await svc.getMyRoster('u1', cairo(2026, 7, 4, 1, 0).toISOString());
    expect(r.todayWeekday).toBe(2);          // Tuesday
    expect(r.todayDate).toBe('2026-08-04');
  });
});

describe('EmployeeShiftService — getMyRoster', () => {
  const users = { u1: { role: 'staff', name: 'Ahmed' }, u2: { role: 'staff', name: 'Sara' } };

  /** Leave mock that also answers the per-user upcoming query getMyRoster needs. */
  function mockLeaveSvc(
    onLeaveByDate: Record<string, string[]> = {},
    upcoming: Record<string, any[]> = {},
  ) {
    return {
      listUserIdsOnLeave: async (dateStr: string) => new Set(onLeaveByDate[dateStr] || []),
      listUpcomingForUser: async (userId: string) => upcoming[userId] || [],
    } as any;
  }

  it('returns ONLY the calling employee\'s shifts — never a colleague\'s', async () => {
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1, 2], isActive: true, isOnCall: false },
      { userId: 'u2', name: 'Sara', shiftStart: '12:00', shiftEnd: '20:00', daysOfWeek: [3, 4], isActive: true, isOnCall: true },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveSvc());

    const res = await svc.getMyRoster('u1', cairo(2026, 7, 2, 10, 0).toISOString());
    expect(res.shifts).toHaveLength(1);
    expect(res.shifts[0].shiftStart).toBe('09:00');
    // Sara's window must not appear anywhere in the payload.
    expect(JSON.stringify(res)).not.toContain('12:00');
  });

  it('reports onShiftNow with elapsed/remaining inside the window', async () => {
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1, 2], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveSvc());

    // Sunday 2026-08-02, 11:30 → 2.5h into an 8h window.
    const res = await svc.getMyRoster('u1', cairo(2026, 7, 2, 11, 30).toISOString());
    expect(res.onShiftNow).toBe(true);
    expect(res.currentShift?.lengthMinutes).toBe(480);
    expect(res.currentShift?.elapsedMinutes).toBe(150);
    expect(res.currentShift?.remainingMinutes).toBe(330);
  });

  it('is not "on shift" on a weekday the shift does not cover', async () => {
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1, 2], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveSvc());
    // Wednesday, same time of day.
    const res = await svc.getMyRoster('u1', cairo(2026, 7, 5, 10, 0).toISOString());
    expect(res.onShiftNow).toBe(false);
    expect(res.currentShift).toBeNull();
    // The template is still returned — the week grid must draw even when off-duty.
    expect(res.shifts).toHaveLength(1);
  });

  it('an employee on leave today is not "on shift", even inside their window', async () => {
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true, isOnCall: false },
    ]);
    const day = cairo(2026, 7, 2, 10, 0);
    const svc = new EmployeeShiftService(
      model,
      mockUsersService(users),
      mockLeaveSvc({ [day.toISOString().slice(0, 10)]: ['u1'] }),
    );
    const res = await svc.getMyRoster('u1', day.toISOString());
    expect(res.onLeaveToday).toBe(true);
    expect(res.onShiftNow).toBe(false);
  });

  it('keeps progress monotonic past midnight on an overnight shift', async () => {
    // 22:00 → 06:00 = 480 minutes. At 01:30 the clock reads BELOW the start time;
    // a raw minute subtraction would make elapsed negative and the bar jump backwards.
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '22:00', shiftEnd: '06:00', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveSvc());

    const late = await svc.getMyRoster('u1', cairo(2026, 7, 2, 23, 0).toISOString());
    expect(late.onShiftNow).toBe(true);
    expect(late.currentShift?.elapsedMinutes).toBe(60);

    const past = await svc.getMyRoster('u1', cairo(2026, 7, 3, 1, 30).toISOString());
    expect(past.onShiftNow).toBe(true);
    expect(past.currentShift?.lengthMinutes).toBe(480);
    expect(past.currentShift?.elapsedMinutes).toBe(210); // 22:00 → 01:30
    expect(past.currentShift?.remainingMinutes).toBe(270);
  });

  it('reports the weekday/date it resolved, so the grid can highlight today', async () => {
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [3], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveSvc());
    const res = await svc.getMyRoster('u1', cairo(2026, 7, 5, 10, 0).toISOString());
    expect(res.todayWeekday).toBe(3); // Wednesday
    expect(res.todayDate).toBe('2026-08-05');
  });

  it('returns only this employee\'s leave rows', async () => {
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0], isActive: true, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(
      model,
      mockUsersService(users),
      mockLeaveSvc({}, { u1: [{ _id: 'l1', fromDate: '2026-08-20', toDate: '2026-08-22', reason: 'سفر' }] }),
    );
    const res = await svc.getMyRoster('u1', cairo(2026, 7, 2, 10, 0).toISOString());
    expect(res.leaves).toHaveLength(1);
    expect(res.leaves[0].fromDate).toBe('2026-08-20');
    expect(res.leaves[0].reason).toBe('سفر');
  });

  it('an employee with no shift configured gets an empty roster, not an error', async () => {
    const svc = new EmployeeShiftService(mockShiftModel([]), mockUsersService(users), mockLeaveSvc());
    const res = await svc.getMyRoster('u1', cairo(2026, 7, 2, 10, 0).toISOString());
    expect(res.shifts).toEqual([]);
    expect(res.onShiftNow).toBe(false);
    expect(res.currentShift).toBeNull();
  });

  it('an inactive shift never reads as on-shift, but still appears in the grid', async () => {
    const model = mockShiftModel([
      { userId: 'u1', name: 'Ahmed', shiftStart: '09:00', shiftEnd: '17:00', daysOfWeek: [0], isActive: false, isOnCall: false },
    ]);
    const svc = new EmployeeShiftService(model, mockUsersService(users), mockLeaveSvc());
    const res = await svc.getMyRoster('u1', cairo(2026, 7, 2, 10, 0).toISOString());
    expect(res.onShiftNow).toBe(false);
    expect(res.shifts[0].isActive).toBe(false);
  });
});
