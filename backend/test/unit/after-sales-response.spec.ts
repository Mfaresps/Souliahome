import { AfterSalesController } from '../../src/after-sales/after-sales.controller';

describe('After-sales committed response', () => {
  it('returns the saved workflow with its navigation metadata without re-reading the case', async () => {
    const saved = { _id: 'case-id', workflow: { receivedAt: '2026-11-02' } };
    const view = { ...saved, addressHint: {}, rollback: { available: false } };
    const service = { receive: jest.fn().mockResolvedValue(saved), describe: jest.fn().mockResolvedValue(view), get: jest.fn() };
    const controller = new AfterSalesController(service as any);
    await expect(controller.receive('case-id', { operationKey: 'key' }, { user: { userId: 'operator' } })).resolves.toBe(view);
    expect(service.describe).toHaveBeenCalledWith(saved);
    expect(service.get).not.toHaveBeenCalled();
  });
  it('still reports a committed settlement as saved when optional display enrichment fails', async () => {
    const saved = { _id: 'case-id', workflow: { stage: 'closed', carrierSettlement: { cost: 0 } } };
    const service = { settle: jest.fn().mockResolvedValue(saved), describe: jest.fn().mockRejectedValue(new Error('read unavailable')) };
    await expect(new AfterSalesController(service as any).settle('case-id', {}, { user: {} })).resolves.toBe(saved);
  });
  it('preserves save failures rather than turning them into successful transitions', async () => {
    const service = { receive: jest.fn().mockRejectedValue(new Error('stock conflict')), describe: jest.fn() };
    await expect(new AfterSalesController(service as any).receive('case-id', {}, { user: {} })).rejects.toThrow('stock conflict');
    expect(service.describe).not.toHaveBeenCalled();
  });
  it('sends only the quote and eligibility fields needed by the calculator', async () => {
    const view = { quote: { credit: 100 }, requiresReview: false, days: 1, allowedDays: 14 };
    const service = { quote: jest.fn().mockResolvedValue({ ...view, original: { comments: ['large history'] }, items: [], policy: {} }) };
    await expect(new AfterSalesController(service as any).quote({})).resolves.toEqual(view);
  });
});
