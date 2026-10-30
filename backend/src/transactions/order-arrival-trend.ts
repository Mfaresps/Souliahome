/** Both counts are cohorts of the original arrival day, never the registration day. */
type ArrivalOrder = {
  _id?: unknown;
  shopifyId?: string;
  shopifyCreatedAt?: string;
  createdAt?: unknown;
};
type ArrivalSale = {
  _id?: unknown;
  shopifyOrderId?: string;
  shopifyCreatedAt?: string;
  transactionDate?: string;
  date?: string;
  cancelled?: boolean;
  archived?: boolean;
};

const cairoDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
});

function arrivalDay(...values: unknown[]): string {
  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) continue;
    const text = String(value);
    // A chosen business day is already a calendar date; timestamps use Cairo time.
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    return cairoDay.format(date);
  }
  return '';
}

export function buildOrderArrivalTrend(
  orders: ArrivalOrder[], sales: ArrivalSale[], from?: string, to?: string,
) {
  const arrivals = new Map<string, { date: string; confirmed: boolean }>();
  orders.forEach((order, index) => {
    const key = order.shopifyId ? `shopify:${order.shopifyId}` : `order:${order._id ?? index}`;
    // Do not use local createdAt: an import can happen days after the actual arrival.
    arrivals.set(key, { date: arrivalDay(order.shopifyCreatedAt), confirmed: false });
  });
  sales.forEach((sale, index) => {
    const key = sale.shopifyOrderId ? `shopify:${sale.shopifyOrderId}` : `sale:${sale._id ?? index}`;
    const existing = arrivals.get(key);
    const date = existing?.date || arrivalDay(sale.shopifyCreatedAt, sale.transactionDate, sale.date);
    arrivals.set(key, {
      date,
      confirmed: Boolean(existing?.confirmed || (!sale.cancelled && !sale.archived)),
    });
  });

  const daily = new Map<string, { date: string; receivedOrders: number; confirmedOrders: number }>();
  let undatedOrders = 0;
  for (const order of arrivals.values()) {
    if (!order.date) { undatedOrders++; continue; }
    if ((from && order.date < from) || (to && order.date > to)) continue;
    const row = daily.get(order.date) || { date: order.date, receivedOrders: 0, confirmedOrders: 0 };
    row.receivedOrders++;
    if (order.confirmed) row.confirmedOrders++;
    daily.set(order.date, row);
  }
  const days = [...daily.keys()].sort();
  const first = from || days[0];
  const last = to || days[days.length - 1];
  const series: Array<{ date: string; receivedOrders: number; confirmedOrders: number }> = [];
  if (first && last) {
    for (const day = new Date(first + 'T00:00:00Z'), end = new Date(last + 'T00:00:00Z'); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
      const date = day.toISOString().slice(0, 10);
      series.push(daily.get(date) || { date, receivedOrders: 0, confirmedOrders: 0 });
    }
  }
  return { series, undatedOrders };
}
