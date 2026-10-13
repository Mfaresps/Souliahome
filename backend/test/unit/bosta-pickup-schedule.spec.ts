import { pickupClock, pickupSchedule, pickupDateReason, isPickupDate } from '../../src/bosta/pickup-schedule.util';
import { UpdateSettingsDto } from '../../src/settings/dto/settings.dto';
import { SettingsService } from '../../src/settings/settings.service';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

const policy = { cutoffTime: '16:00', holidayDates: [] as string[] };
describe('Bosta Cairo calendar', () => {
  it.each([
    ['2026-10-13T12:59:59.999Z', '2026-10-13', ''],
    ['2026-10-13T13:00:00Z', '2026-10-13', 'cutoff'],
    ['2026-10-13T13:00:00Z', '2026-10-14', ''],
    ['2026-01-13T13:59:59.999Z', '2026-01-13', ''],
    ['2026-01-13T14:00:00Z', '2026-01-13', 'cutoff'],
    ['2026-10-13T13:00:00Z', '2026-10-12', 'past'],
    ['2026-10-13T13:00:00Z', '2026-10-16', 'friday'],
  ])('checks %s → %s using Cairo summer/winter time', (now, date, reason) => {
    expect(pickupDateReason(date, new Date(now), policy)).toBe(reason);
  });
  it('skips Thursday after cutoff, Friday and a configured Saturday holiday', () => {
    const schedule = pickupSchedule(new Date('2026-10-15T13:00:00Z'), { ...policy, holidayDates: ['2026-10-17'] });
    expect(schedule.earliestDate).toBe('2026-10-18');
    expect(schedule.dates.slice(0, 4).map(d => d.reason)).toEqual(['cutoff', 'friday', 'holiday', '']);
  });
  it('uses the Cairo calendar date when UTC is still the previous day', () => {
    expect(pickupClock(new Date('2026-10-15T21:05:00Z'))).toEqual({ today: '2026-10-16', time: '00:05' });
    expect(pickupSchedule(new Date('2026-10-15T21:05:00Z'), policy).earliestDate).toBe('2026-10-17');
  });
  it('handles year boundaries and consecutive unavailable dates', () => {
    expect(pickupSchedule(new Date('2026-12-31T14:00:00Z'), { ...policy, holidayDates: ['2027-01-02'] }).earliestDate).toBe('2027-01-03');
  });
  it('applies account or Ramadan cutoff overrides', () => {
    const schedule = pickupSchedule(new Date('2026-03-10T12:00:00Z'), { ...policy, cutoffTime: '14:00' });
    expect(schedule.dates[0].reason).toBe('cutoff'); expect(schedule.earliestDate).toBe('2026-03-11');
  });
  it('skips carrier-rejected and existing request dates while retaining their reason', () => {
    const schedule = pickupSchedule(new Date('2026-10-13T10:00:00Z'), policy, [
      { date: '2026-10-13', reason: 'holiday' }, { date: '2026-10-14', reason: 'duplicate' }, { date: '2026-10-15', reason: 'uncertain' },
    ]);
    expect(schedule.earliestDate).toBe('2026-10-17');
  });
  it('reports no available date when the entire window is blocked', () => {
    const now = new Date('2026-10-13T10:00:00Z');
    const holidayDates = pickupSchedule(now, policy).dates.map(d => d.date);
    expect(pickupSchedule(now, { ...policy, holidayDates }).earliestDate).toBe('');
  });
  it.each(['2026-02-29', '2026-02-31', '2026-13-01', '2026-00-01', '2026-10-00', '2026-10-32', 'foo'])('rejects invalid calendar dates %s', date => {
    expect(isPickupDate(date)).toBe(false);
  });
  it('accepts leap days in leap years', () => expect(isPickupDate('2028-02-29')).toBe(true));
  it('validates scheduling settings', async () => {
    expect(await validate(plainToInstance(UpdateSettingsDto, { bostaPickupCutoffTime: '14:30', bostaPickupHolidayDates: ['2026-10-17'] }))).toHaveLength(0);
    expect((await validate(plainToInstance(UpdateSettingsDto, { bostaPickupCutoffTime: '25:00' }))).length).toBeGreaterThan(0);
    const service: any = Object.create(SettingsService.prototype);
    service.getSettings = jest.fn();
    await expect(service.updateSettings({ bostaPickupHolidayDates: ['2026-02-31'] })).rejects.toThrow('تاريخ غير صحيح');
    expect(service.getSettings).not.toHaveBeenCalled();
  });
});
