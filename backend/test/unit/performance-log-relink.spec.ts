/**
 * Performance-log identity survival across a restore.
 *
 * ⚠ WHY THIS EXISTS. `employeeperformancelogs.employeeId` stores a `User._id` as a
 * string, but `restoreUsersMerge` matches accounts by USERNAME and keeps the id that
 * is already on the target machine. So restoring a backup onto a *different* database
 * (the local install ↔ the online one) leaves the same person holding a different
 * `_id` on each side, and every restored point row points at an id that exists
 * nowhere. The leaderboard then renders EMPTY while every row is present and correct —
 * the failure is completely invisible, which is what makes it dangerous.
 *
 * Measured on the two real backups in this repo when that scenario was reproduced:
 * 858 of 1307 points (66%) were orphaned.
 *
 * These cases lock in the three rules that make the repair safe:
 *   1. a stale id is re-linked via employeeUsername,
 *   2. a row with NO username is reported, never guessed at,
 *   3. the repair is idempotent and a dry run writes nothing.
 */

export {};

type Row = { _id: string; employeeId: string; employeeUsername?: string; points: number };

/** In-memory stand-in for the EmployeePerformanceLog model (find/updateMany only). */
function mockLogModel(rows: Row[]) {
  const store = rows.map((r) => ({ ...r }));
  const matches = (r: any, f: any = {}): boolean =>
    Object.entries(f).every(([k, c]: [string, any]) => {
      if (k === '$or') return (c as any[]).some((sub) => matches(r, sub));
      if (c && typeof c === 'object' && '$exists' in c) return (r[k] !== undefined) === c.$exists;
      if (c && typeof c === 'object' && '$in' in c) return c.$in.includes(r[k]);
      return r[k] === c;
    });
  const q = (v: any): any => ({ select: () => q(v), lean: () => q(v), sort: () => q(v), exec: async () => v });
  return {
    _store: store,
    find: (f?: any) => q(store.filter((r) => matches(r, f))),
    updateMany: (f: any, upd: any) => ({
      exec: async () => {
        let n = 0;
        for (const r of store) if (matches(r, f)) { Object.assign(r, upd.$set); n++; }
        return { modifiedCount: n };
      },
    }),
  } as any;
}

const q = (v: any): any => ({ select: () => q(v), lean: () => q(v), sort: () => q(v), exec: async () => v });

function mockShiftModel(rows: any[]) {
  const store = rows.map((r) => ({ ...r }));
  const matches = (r: any, f: any = {}): boolean =>
    Object.entries(f).every(([k, c]: [string, any]) => {
      if (k === '$or') return (c as any[]).some((sub) => matches(r, sub));
      if (c && typeof c === 'object' && '$exists' in c) return (r[k] !== undefined) === c.$exists;
      return r[k] === c;
    });
  return {
    _store: store,
    find: (f?: any) => q(store.filter((r) => matches(r, f))),
    updateOne: (f: any, upd: any) => ({
      exec: async () => {
        const row = store.find((r) => String(r._id) === String(f._id));
        if (row) Object.assign(row, upd.$set);
        return { modifiedCount: row ? 1 : 0 };
      },
    }),
  } as any;
}

function buildService(logs: any, users: any[], shifts: any[] = [], shiftModelOverride?: any) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EmployeeScoringService } = require('../../src/employee-performance/employee-scoring.service');
  const userModel: any = { find: () => q(users) };
  const shiftModel: any = shiftModelOverride || { find: () => q(shifts) };
  const usersService: any = { findById: async (id: string) => users.find((u) => String(u._id) === id) || null };
  const settingsService: any = { getSettings: async () => ({ performanceConfig: {} }) };
  return new EmployeeScoringService(logs, {}, {}, userModel, shiftModel, {}, usersService, settingsService);
}

describe('performance log — surviving a restore onto another database', () => {
  // The same person, whose account was recreated on the target machine with a new _id.
  const USERS = [{ _id: 'newIdReem', username: 'reem@soulia.store', name: 'Reem', role: 'staff' }];

  it('re-links a row whose employeeId went stale, using employeeUsername', async () => {
    const logs = mockLogModel([
      { _id: 'l1', employeeId: 'oldIdReem', employeeUsername: 'reem@soulia.store', points: 5 },
      { _id: 'l2', employeeId: 'oldIdReem', employeeUsername: 'reem@soulia.store', points: 3 },
    ]);
    const svc = buildService(logs, USERS);

    const res = await svc.relinkOrphanedLogs(false);

    expect(res.relinked).toBe(2);
    expect(res.unresolved).toBe(0);
    expect(logs._store.every((r: Row) => r.employeeId === 'newIdReem')).toBe(true);
    // The points themselves are never rewritten — only the link.
    expect(logs._store.map((r: Row) => r.points)).toEqual([5, 3]);
  });

  it('a dry run reports the fix but writes nothing', async () => {
    const logs = mockLogModel([
      { _id: 'l1', employeeId: 'oldIdReem', employeeUsername: 'reem@soulia.store', points: 5 },
    ]);
    const svc = buildService(logs, USERS);

    const res = await svc.relinkOrphanedLogs(true);

    expect(res.relinked).toBe(1);
    expect(res.dryRun).toBe(true);
    expect(logs._store[0].employeeId).toBe('oldIdReem'); // untouched
  });

  it('is idempotent — a second run re-links nothing', async () => {
    const logs = mockLogModel([
      { _id: 'l1', employeeId: 'oldIdReem', employeeUsername: 'reem@soulia.store', points: 5 },
    ]);
    const svc = buildService(logs, USERS);

    await svc.relinkOrphanedLogs(false);
    const second = await svc.relinkOrphanedLogs(false);

    expect(second.relinked).toBe(0);
    expect(second.healthy).toBe(1);
  });

  it('NEVER guesses an owner for a row with no username — it reports it', async () => {
    const logs = mockLogModel([
      { _id: 'l1', employeeId: 'deletedAccount', employeeUsername: '', points: 40 },
    ]);
    const svc = buildService(logs, USERS);

    const res = await svc.relinkOrphanedLogs(false);

    expect(res.relinked).toBe(0);
    expect(res.unresolved).toBe(1);
    expect(res.unresolvedPoints).toBe(40);
    // The row keeps its original (broken) id rather than being attached to someone else.
    expect(logs._store[0].employeeId).toBe('deletedAccount');
  });

  it('leaves an already-healthy row alone', async () => {
    const logs = mockLogModel([{ _id: 'l1', employeeId: 'newIdReem', employeeUsername: 'reem@soulia.store', points: 7 }]);
    const svc = buildService(logs, USERS);

    const res = await svc.relinkOrphanedLogs(false);

    expect(res.healthy).toBe(1);
    expect(res.relinked).toBe(0);
  });

  it('backfill stamps employeeUsername on pre-existing rows while the id still resolves', async () => {
    const logs = mockLogModel([
      { _id: 'l1', employeeId: 'newIdReem', points: 5 },                       // no username yet
      { _id: 'l2', employeeId: 'goneForever', points: 9 },                     // account deleted
    ]);
    const svc = buildService(logs, USERS);

    const res = await svc.backfillLogUsernames(false);

    expect(res.filled).toBe(1);
    expect(res.skipped).toBe(1); // nothing to resolve — left empty rather than invented
    expect(logs._store[0].employeeUsername).toBe('reem@soulia.store');
    expect(logs._store[1].employeeUsername).toBeUndefined();
  });
});

describe('performance data health report', () => {
  it('separates "orphaned link" from "missing from the roster"', async () => {
    // Reem is linked AND on the roster; Fares is linked but has no shift row;
    // one row belongs to an account that no longer exists at all.
    const users = [
      { _id: 'reem', username: 'reem@soulia.store', name: 'Reem', role: 'staff' },
      { _id: 'fares', username: 'Fares', name: 'Fares', role: 'admin' },
    ];
    const logs = mockLogModel([
      { _id: 'l1', employeeId: 'reem', employeeUsername: 'reem@soulia.store', points: 10 },
      { _id: 'l2', employeeId: 'fares', employeeUsername: 'Fares', points: 55 },
      { _id: 'l3', employeeId: 'deleted', employeeUsername: '', points: 40 },
    ]);
    const svc = buildService(logs, users, [{ userId: 'reem' }]);

    const h = await svc.getPerformanceDataHealth();

    expect(h.ok).toBe(false);
    expect(h.totalRows).toBe(3);
    expect(h.orphanRows).toBe(1);
    expect(h.orphanPoints).toBe(40);
    expect(h.missingUsernameRows).toBe(1);
    expect(h.repairableRows).toBe(0);
    // Fares' points are linked perfectly and still invisible on the leaderboard.
    expect(h.rosterCovered).toBe(1);
    expect(h.rosterMissing).toEqual([{ username: 'Fares', name: 'Fares', points: 55 }]);
  });

  it('flags an empty shift table — the leaderboard would render empty at any score', async () => {
    const users = [{ _id: 'reem', username: 'reem@soulia.store', name: 'Reem', role: 'staff' }];
    const logs = mockLogModel([{ _id: 'l1', employeeId: 'reem', employeeUsername: 'reem@soulia.store', points: 10 }]);
    const svc = buildService(logs, users, []); // no shifts restored

    const h = await svc.getPerformanceDataHealth();

    expect(h.ok).toBe(false);
    expect(h.orphanRows).toBe(0); // links are fine …
    expect(h.shiftRows).toBe(0);  // … but nobody can appear
    expect(h.issues.some((i: string) => i.includes('ورديات'))).toBe(true);
  });

  it('reports a clean database as ok', async () => {
    const users = [{ _id: 'reem', username: 'reem@soulia.store', name: 'Reem', role: 'staff' }];
    const logs = mockLogModel([{ _id: 'l1', employeeId: 'reem', employeeUsername: 'reem@soulia.store', points: 10 }]);
    const svc = buildService(logs, users, [{ userId: 'reem' }]);

    const h = await svc.getPerformanceDataHealth();

    expect(h.ok).toBe(true);
    expect(h.issues).toEqual([]);
    expect(h.linkedPoints).toBe(10);
  });
});

/**
 * The roster half of the same problem. A shift row carries a User._id too, and it is
 * MORE damaging when it breaks: the leaderboard roster is built from this collection,
 * so one stale userId hides that employee entirely even when all their points re-linked.
 */
describe('employee shifts — surviving the same restore', () => {
  const USERS = [{ _id: 'newIdGannh', username: 'Gannh@soulia.store', name: 'Gannh', role: 'staff' }];

  it('re-links a shift whose userId went stale, using userUsername', async () => {
    const shifts = mockShiftModel([
      { _id: 's1', userId: 'oldIdGannh', userUsername: 'Gannh@soulia.store', name: 'Gannh' },
    ]);
    const svc = buildService(mockLogModel([]), USERS, [], shifts);

    const res = await svc.relinkOrphanedShifts(false);

    expect(res.relinked).toBe(1);
    expect(shifts._store[0].userId).toBe('newIdGannh');
  });

  it('a dry run writes nothing', async () => {
    const shifts = mockShiftModel([
      { _id: 's1', userId: 'oldIdGannh', userUsername: 'Gannh@soulia.store', name: 'Gannh' },
    ]);
    const svc = buildService(mockLogModel([]), USERS, [], shifts);

    await svc.relinkOrphanedShifts(true);

    expect(shifts._store[0].userId).toBe('oldIdGannh');
  });

  it('never guesses an owner for a shift with no username', async () => {
    const shifts = mockShiftModel([{ _id: 's1', userId: 'deleted', userUsername: '', name: 'X' }]);
    const svc = buildService(mockLogModel([]), USERS, [], shifts);

    const res = await svc.relinkOrphanedShifts(false);

    expect(res.relinked).toBe(0);
    expect(res.unresolved).toBe(1);
    expect(shifts._store[0].userId).toBe('deleted');
  });

  it('backfills userUsername while the id still resolves', async () => {
    const shifts = mockShiftModel([{ _id: 's1', userId: 'newIdGannh', name: 'Gannh' }]);
    const svc = buildService(mockLogModel([]), USERS, [], shifts);

    const res = await svc.backfillShiftUsernames(false);

    expect(res.filled).toBe(1);
    expect(shifts._store[0].userUsername).toBe('Gannh@soulia.store');
  });

  it('health report flags a shift pointing at a dead account', async () => {
    const shifts = mockShiftModel([{ _id: 's1', userId: 'oldIdGannh', userUsername: 'Gannh@soulia.store' }]);
    const logs = mockLogModel([
      { _id: 'l1', employeeId: 'newIdGannh', employeeUsername: 'Gannh@soulia.store', points: 10 },
    ]);
    const svc = buildService(logs, USERS, [], shifts);

    const h = await svc.getPerformanceDataHealth();

    expect(h.orphanRows).toBe(0);       // the points are fine …
    expect(h.brokenShiftRows).toBe(1);  // … but the roster entry is not
    expect(h.ok).toBe(false);
    expect(h.issues.some((i: string) => i.includes('وردية'))).toBe(true);
  });
});

/**
 * ⚠ The bug that made a KPI read 0 while the points existed.
 *
 * A restore reads the backup with JSON.parse, which has no Date type, so createdAt
 * lands as an ISO STRING. Mongo compares BSON types, so every period-scoped query
 * (periodMatch builds {createdAt: {$gte: <Date>}}) matches a string row not at all.
 * Measured live: 633 of 637 rows were strings, and Gannh showed 0 points while
 * holding 279. Converting them restored 60 points for September immediately.
 */
describe("point-log timestamps must be Dates, not strings", () => {
  function mockTsModel(rows: any[]) {
    const store = rows.map((r) => ({ ...r }));
    const updates: any[] = [];
    const qq = (v: any): any => ({ select: () => qq(v), lean: () => qq(v), sort: () => qq(v), exec: async () => v });
    return {
      _store: store,
      _updates: updates,
      // only $type:'string' rows are considered broken
      find: (f: any) => qq(store.filter((r) => (f?.createdAt?.$type === 'string' ? typeof r.createdAt === 'string' : true))),
      // the raw driver is what the fix must write through
      collection: {
        updateOne: async (f: any, upd: any) => {
          updates.push({ f, upd });
          const row = store.find((r) => String(r._id) === String(f._id));
          if (row) Object.assign(row, upd.$set);
          return { modifiedCount: row ? 1 : 0 };
        },
      },
      updateOne: () => ({ exec: async () => { throw new Error('must not write through Mongoose — timestamps:true discards it'); } }),
    } as any;
  }

  it('converts a string createdAt into a real Date', async () => {
    const logs = mockTsModel([{ _id: 'l1', createdAt: '2026-09-04T10:00:00.000Z', updatedAt: '2026-09-04T10:00:00.000Z' }]);
    const svc = buildService(logs, []);

    const res = await svc.fixLogTimestamps(false);

    expect(res.converted).toBe(1);
    expect(logs._store[0].createdAt instanceof Date).toBe(true);
  });

  it('writes through the RAW driver — Mongoose would discard it', async () => {
    const logs = mockTsModel([{ _id: 'l1', createdAt: '2026-09-04T10:00:00.000Z' }]);
    const svc = buildService(logs, []);

    // mockTsModel.updateOne throws if the Mongoose path is used at all.
    await expect(svc.fixLogTimestamps(false)).resolves.toBeDefined();
    expect(logs._updates.length).toBe(1);
  });

  it('a dry run writes nothing', async () => {
    const logs = mockTsModel([{ _id: 'l1', createdAt: '2026-09-04T10:00:00.000Z' }]);
    const svc = buildService(logs, []);

    const res = await svc.fixLogTimestamps(true);

    expect(res.converted).toBe(1);
    expect(logs._updates.length).toBe(0);
    expect(typeof logs._store[0].createdAt).toBe('string');
  });

  it('reports an unparseable value instead of writing Invalid Date', async () => {
    const logs = mockTsModel([{ _id: 'l1', createdAt: 'not-a-date' }]);
    const svc = buildService(logs, []);

    const res = await svc.fixLogTimestamps(false);

    expect(res.converted).toBe(0);
    expect(res.failed).toBe(1);
  });
});
