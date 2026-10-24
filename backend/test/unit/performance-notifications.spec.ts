import { previousPerformanceWeek } from '../../src/notifications/performance-notifications';
import { EmployeeScoringService } from '../../src/employee-performance/employee-scoring.service';
import { notificationBody } from '../../src/notifications/notifications.service';
import { notificationTitle } from '../../src/notifications/notification-titles';

const employee = '507f1f77bcf86cd799439011', logId = '507f1f77bcf86cd799439012';
function scoring(existing: any = null, points = 10) {
  const service: any = Object.create(EmployeeScoringService.prototype);
  service.logModel = { findOne: () => ({ lean: () => ({ exec: async () => existing }) }), deleteOne: () => ({ exec: async () => ({ deletedCount: 1 }) }), create: jest.fn(async (values: any) => ({ _id: logId, ...values })) };
  service.notifications = { recordPointChange: jest.fn(async () => {}) };
  service.settingsService = { getSettings: async () => ({}) };
  service.usernameForId = async () => 'ahmed'; service.scoreDepositPoints = () => ({ actionType: 'deposit_full', points });
  service.logger = { error: jest.fn() };
  const order = { _id: logId, assignedTo: employee, ref: '2771', depositPercentage: 100, depositAmount: 100 };
  return { service, order };
}
it('uses Cairo Sunday boundaries across a DST change without assuming a seven-day UTC duration', () => {
  const week = previousPerformanceWeek(new Date('2026-11-01T07:00:00Z'));
  expect(week.key).toBe('2026-10-25');
  expect(week.start.toISOString()).toBe('2026-10-24T21:00:00.000Z');
  expect(week.end.toISOString()).toBe('2026-10-31T22:00:00.000Z');
  expect((week.end.getTime() - week.start.getTime()) / 3600000).toBe(169);
});
it('uses the exact recorded positive/negative values and reason with concise bodies', () => {
  expect(notificationTitle('performance', { pointDelta: 10 }, 'en')).toBe('⭐ Points Earned');
  expect(notificationTitle('performance', { pointDelta: -5 }, 'en')).toBe('⚠️ Points Deducted');
  expect(notificationBody('performance', '', { pointDelta: -5, pointReason: 'خصم مسجل' })).toBe('تم خصم -5 نقاط من رصيدك. السبب: خصم مسجل');
  expect(notificationBody('performance', '', { weekly: true, balance: 125, earned: 20, deducted: 5 })).toBe('رصيد نقاطك الحالي: 125 نقطة. نقاط مكتسبة هذا الأسبوع: +20. نقاط مخصومة: -5.');
  expect(notificationBody('performance', '2771', { pointDelta: 10, pointReason: 'سبب طويل '.repeat(100) }).length).toBeLessThanOrEqual(160);
});
it('scores a new deposit once, targeting only its employee with the committed reason', async () => {
  const { service, order } = scoring(); await service.scoreDepositDetection(order);
  expect(service.notifications.recordPointChange).toHaveBeenCalledWith(logId, employee, 10, expect.stringContaining('تحليل إيداع'), '2771', undefined);
  expect(service.logModel.create).toHaveBeenCalledTimes(1);
});
it('uses only the net deduction when a deposit score is lowered', async () => {
  const previous = { _id: 'old', employeeId: employee, points: 15, actionType: 'deposit_full' };
  const { service, order } = scoring(previous, 10); await service.scoreDepositDetection(order);
  expect(service.notifications.recordPointChange).toHaveBeenCalledWith(logId, employee, -5, expect.any(String), '2771', previous);
});
it('does not duplicate unchanged scores', async () => {
  const { service, order } = scoring({ employeeId: employee, points: 10, actionType: 'deposit_full' });
  await service.scoreDepositDetection(order);
  expect(service.logModel.create).not.toHaveBeenCalled(); expect(service.notifications.recordPointChange).not.toHaveBeenCalled();
});
it('notifies both employees of their own deltas when deposit credit is transferred', async () => {
  const previous = { _id: 'old', employeeId: 'former', points: 15, note: 'سبب التقييم' };
  const { service, order } = scoring(previous, 10); await service.scoreDepositDetection(order);
  expect(service.notifications.recordPointChange).toHaveBeenCalledWith(logId + ':transfer-out', 'former', -15, expect.stringContaining('تغيير الموظف'), '2771', previous);
  expect(service.notifications.recordPointChange).toHaveBeenCalledWith(logId, employee, 10, expect.any(String), '2771', undefined);
});
it('manual adjustments retain the actual reason and survive notification failure', async () => {
  const { service } = scoring(); service.notifications.recordPointChange.mockRejectedValue(new Error('offline'));
  const result = await service.addManualBonus(employee, -5, 'السبب الفعلي', 'admin');
  expect(result.points).toBe(-5);
  expect(service.notifications.recordPointChange).toHaveBeenCalledWith(logId, employee, -5, 'السبب الفعلي', '', undefined);
});
