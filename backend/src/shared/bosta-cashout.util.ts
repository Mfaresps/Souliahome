/** Bank posting is due at noon in Cairo on Bosta's scheduled cashout day. */
export function bostaCashoutDueAt(raw: any): string {
  const d = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  const value = d?.wallet?.cashout?.next_cashout_date;
  const day = typeof value === 'string' ? value.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const target = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== day) return '';
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
    const local = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    instant += target - local;
  }
  return new Date(instant).toISOString();
}
