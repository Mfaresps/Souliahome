export type PickupPolicy = { cutoffTime: string; holidayDates: string[] };
export type PickupBlock = { date: string; reason: string };

export function isPickupDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function pickupClock(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return { today: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

export function pickupDateReason(date: string, now: Date, policy: PickupPolicy, blocked: PickupBlock[] = []): string {
  if (!isPickupDate(date)) return 'invalid';
  const clock = pickupClock(now);
  if (date < clock.today) return 'past';
  if (new Date(date + 'T00:00:00Z').getUTCDay() === 5) return 'friday';
  if (policy.holidayDates.includes(date)) return 'holiday';
  const block = blocked.find(b => b.date === date);
  if (block) return block.reason;
  if (date === clock.today && clock.time >= policy.cutoffTime) return 'cutoff';
  return '';
}

export function pickupSchedule(now: Date, policy: PickupPolicy, blocked: PickupBlock[] = []) {
  const clock = pickupClock(now);
  const dates = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(clock.today + 'T00:00:00Z');
    day.setUTCDate(day.getUTCDate() + index);
    const date = day.toISOString().slice(0, 10);
    return { date, reason: pickupDateReason(date, now, policy, blocked) };
  });
  return { today: clock.today, serverNow: now.toISOString(), timezone: 'Africa/Cairo', cutoffTime: policy.cutoffTime,
    dates, earliestDate: dates.find(d => !d.reason)?.date || '' };
}

export function pickupReasonMessage(reason: string): string {
  return ({ invalid: 'اختر تاريخ استلام صحيحًا', past: 'لا يمكن اختيار تاريخ استلام في الماضي',
    friday: 'الجمعة إجازة — اختر أقرب يوم متاح', holiday: 'هذا اليوم إجازة لبوسطة — اختر يومًا آخر',
    cutoff: 'انتهى وقت طلب استلام اليوم — اختر أقرب يوم متاح',
    duplicate: 'يوجد طلب استلام لهذا المخزن في هذا اليوم — راجعه في بوسطة',
    uncertain: 'نتيجة طلب سابق غير مؤكدة — راجع بوسطة قبل إنشاء طلب جديد لهذا اليوم',
  } as Record<string, string>)[reason] || 'الموعد غير متاح للاستلام';
}

export function pickupCarrierReason(code: number): string {
  if (code === 1080) return 'friday';
  if (code === 1081) return 'cutoff';
  if (code === 1083) return 'past';
  if (code === 2022) return 'holiday';
  return [1078, 2024, 2025, 2026, 2027].includes(code) ? 'duplicate' : '';
}
