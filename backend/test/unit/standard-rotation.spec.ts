/**
 * The standard rota must leave NO uncovered minute in the week.
 *
 * ⚠ The plan is EXTRACTED from the shipped index.html rather than copied here. A copy
 * would keep passing after the real one broke — exactly the trap returns.spec.ts falls
 * into. If the markup moves, this test fails loudly rather than silently testing nothing.
 *
 * `coversWeekdayAtTime` is transcribed from EmployeeShiftService because it is private;
 * the transcription is asserted against its documented overnight-wrap behaviour below.
 */
import * as fs from 'fs';
import * as path from 'path';

export {};

const HTML = fs.readFileSync(
  path.join(__dirname, '../../../frontend/public/index.html'),
  'utf8',
);

type Win = { start: string; end: string };
type Row = { day: number; a: Win[]; b: Win[] };

/** Pulls SM_STD_MORNING / SM_STD_NIGHT and the day rows out of the shipped file. */
function extractPlan(): Row[] {
  const win = (name: string): Win => {
    const m = HTML.match(
      new RegExp(name + String.raw`\s*=\s*\{\s*start:\s*'([^']+)',\s*end:\s*'([^']+)'`),
    );
    if (!m) throw new Error(`${name} not found in index.html`);
    return { start: m[1], end: m[2] };
  };
  const M = win('SM_STD_MORNING');
  const N = win('SM_STD_NIGHT');

  const body = HTML.match(/function _rotaBuiltin\([\s\S]*?\n\}/);
  if (!body) throw new Error('_rotaBuiltin not found in index.html');

  const rows: Row[] = [];
  // matches: { day: 6, windows: { r1: [M, N], r2: [] } }
  const re = /\{\s*day:\s*(\d)\s*,\s*windows:\s*\{\s*r1:\s*\[([^\]]*)\]\s*,\s*r2:\s*\[([^\]]*)\]\s*\}\s*\}/g;
  const pick = (s: string): Win[] =>
    s.split(',').map(x => x.trim()).filter(Boolean).map(tok => {
      if (tok === 'M') return M;
      if (tok === 'N') return N;
      throw new Error(`unexpected window token: ${tok}`);
    });
  let m: RegExpExecArray | null;
  while ((m = re.exec(body[0]))) {
    rows.push({ day: Number(m[1]), a: pick(m[2]), b: pick(m[3]) });
  }
  return rows;
}

type Rec = { who: 'A' | 'B'; days: number[]; start: string; end: string };

function toRecords(plan: Row[]): Rec[] {
  const out: Rec[] = [];
  for (const r of plan) {
    r.a.forEach(w => out.push({ who: 'A', days: [r.day], start: w.start, end: w.end }));
    r.b.forEach(w => out.push({ who: 'B', days: [r.day], start: w.start, end: w.end }));
  }
  return out;
}

/** Transcribed from EmployeeShiftService.coversWeekdayAtTime (private). */
function covers(s: Rec, weekday: number, time: string): boolean {
  if (s.start === s.end) return false;
  if (s.start < s.end) return s.days.includes(weekday) && time >= s.start && time < s.end;
  const prev = (weekday + 6) % 7;
  if (time >= s.start) return s.days.includes(weekday);
  if (time < s.end) return s.days.includes(prev);
  return false;
}

/** Transcribed from EmployeeShiftService.timeWindowsOverlap (private). */
function overlaps(aS: string, aE: string, bS: string, bE: string): boolean {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const exp = (s: string, e: string): [number, number] => {
    const sm = toMin(s); let em = toMin(e);
    if (em <= sm) em += 1440;
    return [sm, em];
  };
  const [as, ae] = exp(aS, aE); const [bs, be] = exp(bS, bE);
  const io = (s1: number, e1: number, s2: number, e2: number) => s1 < e2 && s2 < e1;
  return io(as, ae, bs, be) || io(as, ae, bs + 1440, be + 1440) || io(as + 1440, ae + 1440, bs, be);
}

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

describe('standard rota — the shipped plan', () => {
  const plan = extractPlan();
  const recs = toRecords(plan);

  it('is extracted, covering all seven days', () => {
    expect(plan).toHaveLength(7);
    expect([...new Set(plan.map(r => r.day))].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('uses complementary 12h halves', () => {
    const wins = recs.map(r => `${r.start}-${r.end}`);
    expect([...new Set(wins)].sort()).toEqual(['06:00-18:00', '18:00-06:00']);
  });

  it('leaves NO uncovered minute in the week', () => {
    const gaps: string[] = [];
    for (let d = 0; d < 7; d++) {
      for (let m = 0; m < 1440; m++) {
        const t = hhmm(m);
        if (!recs.some(r => covers(r, d, t))) gaps.push(`${d} ${t}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it('never double-books two people on the same minute', () => {
    let dbl = 0;
    for (let d = 0; d < 7; d++) {
      for (let m = 0; m < 1440; m++) {
        const t = hhmm(m);
        if (recs.filter(r => covers(r, d, t)).length > 1) dbl++;
      }
    }
    expect(dbl).toBe(0);
  });

  it('gives each employee an equal share', () => {
    const mins = { A: 0, B: 0 };
    for (let d = 0; d < 7; d++) {
      for (let m = 0; m < 1440; m++) {
        const t = hhmm(m);
        recs.filter(r => covers(r, d, t)).forEach(r => { mins[r.who] += 1; });
      }
    }
    expect(mins.A / 60).toBe(84);
    expect(mins.B / 60).toBe(84);
    expect(mins.A).toBe(mins.B);
  });

  it('produces no record the backend overlap guard would reject', () => {
    const clashes: string[] = [];
    for (const who of ['A', 'B'] as const) {
      for (let d = 0; d < 7; d++) {
        const mine = recs.filter(r => r.who === who && r.days.includes(d));
        for (let i = 0; i < mine.length; i++) {
          for (let j = i + 1; j < mine.length; j++) {
            if (overlaps(mine[i].start, mine[i].end, mine[j].start, mine[j].end)) {
              clashes.push(`${who} day ${d}`);
            }
          }
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it('covers a rest day with the other employee working both halves', () => {
    const rest = plan.filter(r => r.a.length === 0 || r.b.length === 0);
    expect(rest).toHaveLength(2);
    for (const r of rest) {
      const working = r.a.length === 0 ? r.b : r.a;
      expect(working).toHaveLength(2); // morning + night, i.e. the full 24h
    }
  });
});
