/** The performance UI uses Sunday-based weeks. Convert boundaries using Cairo, including DST. */
export function previousPerformanceWeek(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (key: string) => Number(parts.find(part => part.type === key)!.value);
  const endDay = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  endDay.setUTCDate(endDay.getUTCDate() - endDay.getUTCDay());
  const startDay = new Date(endDay); startDay.setUTCDate(startDay.getUTCDate() - 7);
  const midnight = (day: Date) => {
    const zone = new Intl.DateTimeFormat('en', { timeZone: 'Africa/Cairo', timeZoneName: 'shortOffset' }).formatToParts(day).find(part => part.type === 'timeZoneName')!.value;
    const hours = Number(zone.match(/GMT([+-]\d+)/)?.[1] || 0);
    return new Date(day.getTime() - hours * 3600000);
  };
  return { start: midnight(startDay), end: midnight(endDay), key: startDay.toISOString().slice(0, 10) };
}
