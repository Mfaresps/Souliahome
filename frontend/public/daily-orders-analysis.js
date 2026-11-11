/* SPDX-License-Identifier: MIT */
/* Presentation-only analysis of the existing monthly buckets. No sales totals are changed. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.dailyOrdersAnalysis = api;
})(typeof window === 'undefined' ? globalThis : window, () => {
  'use strict';
  const validOrders = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  function calendar(data, today) {
    if (!data) return [];
    const [year, month] = data.month.split('-').map(Number);
    const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const buckets = new Map((data.days || []).filter(Boolean).map(row => [row.date, row]));
    return Array.from({ length: 31 }, (_, index) => {
      const date = `${data.month}-${String(index + 1).padStart(2, '0')}`;
      const source = buckets.get(date);
      const status = index >= length ? 'outside' : date > today ? 'future'
        : !source || !validOrders(source.orders) ? 'missing' : 'available';
      const amount = key => status === 'available' && typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] : null;
      return { date, day: index + 1, status, orders: status === 'available' ? source.orders : null,
        receivedValue: amount('receivedValue'), confirmedValue: amount('confirmedValue'),
        confirmedOrders: status === 'available' && validOrders(source.confirmedOrders) ? source.confirmedOrders : null,
        revenue: status === 'available' && typeof source.revenue === 'number' && Number.isFinite(source.revenue) ? source.revenue : null };
    });
  }
  function difference(current, previous) {
    if (current?.status !== 'available' || previous?.status !== 'available') return null;
    const orders = current.orders - previous.orders;
    return { orders, percent: previous.orders === 0 ? null : orders / previous.orders * 100 };
  }
  const quantile = (sorted, fraction) => {
    const at = (sorted.length - 1) * fraction, low = Math.floor(at);
    return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low);
  };
  function analyze(current, previous, today) {
    const available = current.filter(row => row.status === 'available');
    // Today's observed count is shown, but never used as evidence of a pattern or trend.
    const complete = available.filter(row => row.date < today);
    let peak = null;
    if (available.length >= 2) {
      const highest = available.reduce((best, row) => row.orders > best.orders ? row : best);
      const lowest = available.reduce((best, row) => row.orders < best.orders ? row : best);
      if (highest.orders > lowest.orders) peak = highest;
    }
    let hotspots = [];
    if (complete.length >= 14) {
      const values = complete.map(row => row.orders).sort((a, b) => a - b);
      const median = quantile(values, .5), q1 = quantile(values, .25), q3 = quantile(values, .75);
      const mad = quantile(values.map(value => Math.abs(value - median)).sort((a, b) => a - b), .5);
      // Require agreement from robust spread, relative lift and count noise thresholds.
      const threshold = Math.max(q3 + 1.5 * (q3 - q1), median + 3 * 1.4826 * mad,
        median + 3 * Math.sqrt(Math.max(1, median)), median * 1.5);
      const exceptional = complete.filter(row => row.orders > threshold);
      // Frequent highs are a recurring pattern or level shift, not isolated hotspots.
      if (exceptional.length <= Math.max(1, Math.floor(complete.length * .1)))
        hotspots = exceptional.sort((a, b) => b.orders - a.orders).slice(0, 2);
    }
    let insight = null;
    const pairs = complete.map(row => [row, previous[row.day - 1]])
      .filter(([, other]) => other?.status === 'available' && other.date < today);
    const elapsed = current.filter(row => row.status !== 'outside' && row.date < today).length;
    if (pairs.length >= 14 && pairs.length >= elapsed * .8) {
      const total = pairs.reduce((sum, [row]) => sum + row.orders, 0);
      const baseline = pairs.reduce((sum, [, row]) => sum + row.orders, 0);
      const change = baseline > 0 ? (total - baseline) / baseline : 0;
      const aligned = pairs.filter(([a, b]) => change > 0 ? a.orders > b.orders : a.orders < b.orders).length;
      if (Math.abs(change) >= .25 && Math.abs(total - baseline) >= 10 && aligned >= pairs.length * .65)
        insight = { type: 'comparison', change: change * 100, days: pairs.length };
    }
    if (!insight && complete.length >= 21 && complete.length >= elapsed * .8) {
      const groups = Array.from({ length: 7 }, () => []);
      complete.forEach(row => groups[new Date(`${row.date}T12:00:00Z`).getUTCDay()].push(row));
      if (groups.every(group => group.length >= 3)) {
        const means = groups.map(group => group.reduce((sum, row) => sum + row.orders, 0) / group.length);
        const average = complete.reduce((sum, row) => sum + row.orders, 0) / complete.length;
        const strongest = means.indexOf(Math.max(...means)), weakest = means.indexOf(Math.min(...means));
        const strongLift = average > 0 ? means[strongest] / average - 1 : 0;
        const weakDrop = average > 0 ? 1 - means[weakest] / average : 0;
        const weekday = strongLift >= weakDrop ? strongest : weakest;
        const strong = weekday === strongest;
        if (Math.max(strongLift, weakDrop) >= .2 && groups[weekday].filter(row => strong ? row.orders > average : row.orders < average).length >= groups[weekday].length * .75)
          insight = { type: 'weekday', weekday, strong };
      }
    }
    if (!insight && hotspots.length) insight = { type: 'hotspot', row: hotspots[0] };
    if (!insight && complete.length >= 14) {
      const recent = complete.slice(-14);
      const contiguous = recent.every((row, index) => !index || new Date(`${row.date}T12:00:00Z`) - new Date(`${recent[index - 1].date}T12:00:00Z`) === 86400000);
      const first = recent.slice(0, 7).reduce((sum, row) => sum + row.orders, 0);
      const last = recent.slice(7).reduce((sum, row) => sum + row.orders, 0);
      const change = first > 0 ? (last - first) / first : 0;
      const aligned = recent.slice(7).filter((row, index) => change > 0 ? row.orders > recent[index].orders : row.orders < recent[index].orders).length;
      if (contiguous && Math.abs(change) >= .25 && Math.abs(last - first) >= 10 && aligned >= 5)
        insight = { type: 'trend', change: change * 100, from: recent[7].date, to: recent[13].date };
    }
    return { peak, hotspots, insight };
  }
  return { calendar, difference, analyze };
});
