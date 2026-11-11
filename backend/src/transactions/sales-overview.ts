/** A month of order arrivals, grouped in MongoDB before it reaches the browser. */
export type SalesOverviewDay = {
  date: string;
  orders: number;
  confirmedOrders: number;
  revenue: number;
  receivedValue: number;
  confirmedValue: number;
};

type OrderBucket = { _id: string; receivedOrders?: number; confirmedOrders?: number; receivedValue?: number; confirmedValue?: number; activeSales?: number; grossRevenue?: number };
type ReturnBucket = { _id: string; amount: number };

const cairoDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
});
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function cairoToday(now = new Date()): string { return cairoDate.format(now); }

export function salesOverviewMonth(year: number, month: number) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // Timestamps can carry an offset. Fetch a narrow indexed superset, then bucket in Cairo.
  const broadStart = new Date(Date.UTC(year, month - 1, 1) - 2 * 86400000).toISOString().slice(0, 10);
  const broadEnd = new Date(Date.UTC(year, month, 1) + 2 * 86400000).toISOString().slice(0, 10);
  return { start, next, count, broadStart, broadEnd };
}

/** Date-only business dates stay literal; timestamped dates use Cairo time. */
export function mongoCairoDay(field: string): Record<string, unknown> {
  return { $let: {
    vars: { raw: { $ifNull: [field, ''] } },
    in: { $cond: [
      { $regexMatch: { input: { $toString: '$$raw' }, regex: /^\d{4}-\d{2}-\d{2}$/ } },
      '$$raw',
      { $dateToString: {
        format: '%Y-%m-%d', timezone: 'Africa/Cairo',
        date: { $convert: { input: '$$raw', to: 'date', onError: null, onNull: null } },
        onNull: null,
      } },
    ] },
  } };
}

export function buildSalesOverview(
  year: number, month: number, orderBuckets: OrderBucket[], returnBuckets: ReturnBucket[], now = new Date(),
) {
  const { start, count } = salesOverviewMonth(year, month);
  const rows = new Map<string, SalesOverviewDay>();
  for (let day = 1; day <= count; day++) {
    const date = `${start.slice(0, 8)}${String(day).padStart(2, '0')}`;
    rows.set(date, { date, orders: 0, confirmedOrders: 0, revenue: 0, receivedValue: 0, confirmedValue: 0 });
  }
  for (const bucket of orderBuckets) {
    const row = rows.get(bucket._id);
    if (!row) continue;
    row.orders += Number(bucket.receivedOrders) || 0;
    row.confirmedOrders += Number(bucket.confirmedOrders) || 0;
    row.revenue += Number(bucket.grossRevenue) || 0;
    row.receivedValue += Number(bucket.receivedValue) || 0;
    row.confirmedValue += Number(bucket.confirmedValue) || 0;
  }
  for (const bucket of returnBuckets) {
    const row = rows.get(bucket._id);
    if (row) row.revenue -= Number(bucket.amount) || 0;
  }
  const days = [...rows.values()].map(row => ({ ...row, revenue: money(row.revenue), receivedValue: money(row.receivedValue), confirmedValue: money(row.confirmedValue) }));
  const totalOrders = days.reduce((sum, row) => sum + row.orders, 0);
  const confirmedOrders = days.reduce((sum, row) => sum + row.confirmedOrders, 0);
  const gross = orderBuckets.reduce((sum, row) => sum + (Number(row.grossRevenue) || 0), 0);
  const activeSales = orderBuckets.reduce((sum, row) => sum + (Number(row.activeSales) || 0), 0);
  const returns = returnBuckets.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  // Matches getReports(): product sales exclude shipping and approved returns reduce revenue.
  const totalRevenue = money(Math.max(0, gross - returns));
  const today = cairoToday(now);
  return {
    month: start.slice(0, 7), timeZone: 'Africa/Cairo',
    totalOrders, totalRevenue, confirmedOrders,
    totalReceivedValue: money(days.reduce((sum, row) => sum + row.receivedValue, 0)),
    totalConfirmedValue: money(days.reduce((sum, row) => sum + row.confirmedValue, 0)),
    // Matches getReports(): average uses gross product sales per active sales invoice.
    averageOrderValue: activeSales ? Math.round(gross / activeSales) : 0,
    today: today.startsWith(start.slice(0, 7)) ? today : null,
    days,
  };
}
