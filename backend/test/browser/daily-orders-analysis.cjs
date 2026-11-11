const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calendar, difference, analyze } = require('../../../frontend/public/daily-orders-analysis.js');
const month = (key, values) => ({ month: key, days: values.map((orders, i) => ({
  date: `${key}-${String(i + 1).padStart(2, '0')}`, orders, revenue: orders * 100,
})) });
const series = (key, values, today = '2026-11-11') => calendar(month(key, values), today);
const assess = (values, previous = [], today = '2026-11-11') => analyze(series('2026-10', values, today), series('2026-09', previous, today), today);

test('calendar aligns sparse dates; missing, invalid, future and zero remain distinct', () => {
  const rows = calendar({ month: '2026-11', days: [
    { date: '2026-11-01', orders: 0 }, { date: '2026-11-03', orders: 7 },
    { date: '2026-11-04', orders: null }, { date: '2026-11-05', orders: '8' },
    { date: '2026-11-12', orders: 9999 }, { date: '2026-10-02', orders: 10 },
  ] }, '2026-11-11');
  assert.equal(rows.length, 31);
  assert.equal(rows[0].orders, 0);
  assert.equal(rows[1].status, 'missing');
  assert.equal(rows[2].orders, 7);
  assert.equal(rows[3].status, 'missing');
  assert.equal(rows[4].status, 'missing');
  assert.equal(rows[11].status, 'future');
  assert.equal(rows[30].status, 'outside');
  assert.equal(rows[0].revenue, null);
});
test('leap years and short months do not fabricate calendar dates', () => {
  assert.equal(series('2024-02', Array(29).fill(1))[28].status, 'available');
  assert.equal(series('2025-02', Array(31).fill(1))[28].status, 'outside');
  assert.equal(series('2026-04', Array(31).fill(1))[30].status, 'outside');
});

test('received and confirmed values never fall back to unrelated net revenue', () => {
  const rows = calendar({ month: '2026-11', days: [
    { date: '2026-11-01', orders: 5, revenue: 0, receivedValue: 1500, confirmedValue: 600, confirmedOrders: 2 },
    { date: '2026-11-02', orders: 5, revenue: 900 },
    { date: '2026-11-03', orders: 0, receivedValue: 0, confirmedValue: 0, confirmedOrders: 0 },
  ] }, '2026-11-11');
  assert.equal(rows[0].receivedValue, 1500);
  assert.equal(rows[0].confirmedValue, 600);
  assert.equal(rows[0].confirmedOrders, 2);
  assert.equal(rows[1].receivedValue, null);
  assert.equal(rows[1].confirmedValue, null);
  assert.equal(rows[2].receivedValue, 0);
  assert.equal(rows[2].confirmedValue, 0);
});
test('differences require both observed counts and never divide by zero', () => {
  const available = orders => ({ status: 'available', orders });
  assert.deepEqual(difference(available(15), available(10)), { orders: 5, percent: 50 });
  assert.deepEqual(difference(available(0), available(10)), { orders: -10, percent: -100 });
  assert.deepEqual(difference(available(5), available(0)), { orders: 5, percent: null });
  assert.deepEqual(difference(available(0), available(0)), { orders: 0, percent: null });
  assert.equal(difference(available(5), { status: 'missing' }), null);
});
test('peak uses observed dates and deterministic earliest ties without publishing a low label', () => {
  const result = assess([6, 0, null, 21, 21, 0]);
  assert.equal(result.peak.day, 4);
  assert.equal(Object.hasOwn(result, 'low'), false);
});
test('flat, empty and one-point histories have no artificial extremes or insights', () => {
  for (const values of [[], [4], Array(31).fill(0), Array(31).fill(10)]) {
    const result = assess(values);
    assert.equal(result.peak, null);
    assert.equal(result.insight, null);
    assert.deepEqual(result.hotspots, []);
  }
});
test('future values cannot affect extrema, hotspots or insights', () => {
  const current = series('2026-11', [3, 7, ...Array(29).fill(99999)], '2026-11-02');
  const result = analyze(current, [], '2026-11-02');
  assert.equal(result.peak.day, 2);
  assert.equal(Object.hasOwn(result, 'low'), false);
  assert.equal(result.insight, null);
  assert.deepEqual(result.hotspots, []);
});
test('hotspots need history and reject ordinary variations', () => {
  assert.equal(assess([10, 11, 9, 10, 50]).hotspots.length, 0);
  assert.equal(assess(Array.from({ length: 31 }, (_, i) => 9 + i % 4)).hotspots.length, 0);
  const values = Array(31).fill(10); values[4] = 50; values[18] = 42; values[23] = 35;
  const result = assess(values);
  assert.deepEqual(result.hotspots.map(row => row.day), [5, 19]);
  assert.equal(result.insight.type, 'hotspot');
});
test('comparison uses corresponding available completed dates, not full-month totals', () => {
  const result = assess(Array(31).fill(20), Array(30).fill(10));
  assert.equal(result.insight.type, 'comparison');
  assert.equal(result.insight.days, 30);
  assert.equal(result.insight.change, 100);
  const early = analyze(series('2026-11', Array(30).fill(20)), series('2026-10', Array(31).fill(10)), '2026-11-11');
  assert.equal(early.insight, null);
});
test('sparse coverage, a single spike and zero baselines cannot imply month-wide growth', () => {
  const sparse = assess([...Array(14).fill(20)], Array(30).fill(10));
  assert.notEqual(sparse.insight?.type, 'comparison');
  const values = Array(31).fill(10); values[4] = 1000;
  assert.notEqual(assess(values, Array(30).fill(10)).insight?.type, 'comparison');
  assert.equal(assess(Array(31).fill(10), Array(30).fill(0)).insight, null);
});
test('weekday finding compares averages with at least three repetitions of every weekday', () => {
  const values = Array.from({ length: 31 }, (_, i) => new Date(Date.UTC(2026, 9, i + 1)).getUTCDay() === 4 ? 20 : 10);
  const result = assess(values);
  assert.deepEqual(result.insight, { type: 'weekday', weekday: 4, strong: true });
  assert.equal(assess(values.slice(0, 14)).insight, null);
});
test('trend requires contiguous weeks and consistent same-weekday changes', () => {
  const result = assess([...Array(17).fill(10), ...Array(7).fill(10), ...Array(7).fill(20)]);
  assert.equal(result.insight.type, 'trend');
  assert.equal(result.insight.change, 100);
  assert.equal(result.insight.from, '2026-10-25');
  const gap = [...Array(31).fill(10)]; gap[20] = null;
  assert.notEqual(assess(gap).insight?.type, 'trend');
});
