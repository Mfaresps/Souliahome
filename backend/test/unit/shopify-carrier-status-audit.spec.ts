/** Offline behavioral audit. All persistence and outbound effects are mocked. */
jest.mock('../../src/employee-performance/employee-scoring.service', () => ({ EmployeeScoringService: class {} }));
import { BostaService } from '../../src/bosta/bosta.service';

// Public carrier state table: https://docs.bosta.co/docs/how-to/get-delivery-status-via-webhook/
const cases: Array<[number, string]> = [
  [10, 'CREATED'], [11, 'CREATED'], [20, 'CREATED'], [21, 'PICKED_UP'],
  [22, 'IN_TRANSIT'], [23, 'PICKED_UP'], [24, 'IN_TRANSIT'], [25, 'IN_TRANSIT'],
  [30, 'IN_TRANSIT'], [40, 'IN_TRANSIT'], [41, 'OUT_FOR_DELIVERY'], [45, 'DELIVERED'],
  [46, 'RETURNED'], [47, 'FAILED_ATTEMPT'], [48, 'CANCELLED'], [49, 'CANCELLED'],
  [60, 'RETURNED'], [100, 'FAILED_ATTEMPT'], [101, 'FAILED_ATTEMPT'],
  [102, 'FAILED_ATTEMPT'], [103, 'FAILED_ATTEMPT'], [104, 'CANCELLED'], [105, 'IN_TRANSIT'],
];
const observations: any[] = [];

function fixture(overrides: Record<string, any> = {}) {
  const service: any = Object.create(BostaService.prototype);
  const tx: any = {
    _id: 'audit-tx', ref: 'AUDIT-ONLY', shopifyOrderId: 'audit-shopify-order',
    bostaOrderId: 'audit-delivery', bostaTrackingNumber: 'audit-tracking',
    bostaStatus: 'CREATED', pickupStatus: 'Ready', remaining: 470,
    codCollectionStatus: 'DepositPaid', ...overrides,
  };
  const writes: any[] = [], outbound: string[] = [];
  service.txModel = {
    findByIdAndUpdate: jest.fn(async (_id, update) => {
      writes.push(update);
      Object.assign(tx, update.$set || Object.fromEntries(Object.entries(update).filter(([k]) => !k.startsWith('$'))));
      return tx;
    }),
    findById: () => ({ lean: async () => tx }),
  };
  service.shopifyAdmin = new Proxy({}, {
    get: (_target, name) => async () => { outbound.push(String(name)); return { success: true }; },
  });
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  service.emit = jest.fn();
  service.autoSettleScheduleFor = jest.fn(async () => ({}));
  service.employeeScoringService = { scoreDelivery: jest.fn(async () => undefined) };
  service.followUpsService = {
    openShippingIssueFollowUp: jest.fn(async () => undefined),
    closeShippingIssueFollowUp: jest.fn(async () => undefined),
  };
  service.notifications = { enqueue: jest.fn(async () => undefined) };
  return { service, tx, writes, outbound };
}

describe('carrier status audit using real local status handler', () => {
  beforeAll(() => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => { throw new Error('Network forbidden in offline audit'); });
    jest.spyOn(require('https'), 'request').mockImplementation(() => { throw new Error('Network forbidden in offline audit'); });
  });
  afterAll(() => {
    const fs = require('fs'), path = require('path');
    const directory = path.resolve(__dirname, '../../../artifacts/shopify-status-audit');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'local-handler-results.json'), JSON.stringify({
      testedAt: new Date().toISOString(), network: 'blocked', observations,
      note: 'Local-handler coverage only. Outbound call counts are observations, not proof of Shopify event delivery.',
    }, null, 2));
    jest.restoreAllMocks();
  });

  for (const source of ['webhook', 'sync'] as const) {
    it.each(cases)(`${source}: carrier code %i produces local %s without recording payment`, async (code, expected) => {
      const { service, tx, outbound } = fixture();
      const payload = source === 'webhook' ? { state: code, type: 'SEND' } : { data: { state: { code }, type: 'SEND' } };
      const result = await service.applyDeliveryUpdate(tx._id, tx, payload, source);
      expect(result.success).toBe(true);
      expect(result.status).toBe(expected);
      expect(tx.bostaStatus).toBe(expected);
      expect(tx.codCollectionStatus).not.toBe('Collected');
      observations.push({ source, code, localStatus: result.status, localShippingStatus: tx.bostaShippingStatus, outboundShopifyCalls: outbound });
    });
  }

  it.each(['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'FAILED_ATTEMPT', 'DELIVERED', 'RETURNED', 'CANCELLED'])('accepts text state %s', async status => {
    const { service, tx } = fixture();
    const result = await service.applyDeliveryUpdate(tx._id, tx, { status }, 'webhook');
    expect(result.status).toBe(status);
  });

  it('preserves a known status when the carrier value is unknown', async () => {
    const { service, tx } = fixture({ bostaStatus: 'IN_TRANSIT' });
    await service.applyDeliveryUpdate(tx._id, tx, { state: 999999 }, 'webhook');
    expect(tx.bostaStatus).toBe('IN_TRANSIT');
  });

  it('records deletion separately from an order cancellation', async () => {
    const { service, tx } = fixture();
    await service.applyDeliveryUpdate(tx._id, tx, { isDeleted: true }, 'webhook');
    expect(tx.bostaStatus).toBe('DELETED');
    expect(tx.cancelled).not.toBe(true);
  });

  it('does not overwrite a manually confirmed delivery', async () => {
    const { service, tx } = fixture({ deliverySource: 'MANUAL', bostaStatus: 'DELIVERED' });
    await service.applyDeliveryUpdate(tx._id, tx, { state: 30 }, 'webhook');
    expect(tx.bostaStatus).toBe('DELIVERED');
  });

  it('does not send a duplicate delivered notification for a repeated event', async () => {
    const { service, tx } = fixture();
    await service.applyDeliveryUpdate(tx._id, tx, { state: 45 }, 'webhook');
    const firstTime = tx.deliveredAt;
    await service.applyDeliveryUpdate(tx._id, tx, { state: 45 }, 'webhook');
    expect(service.notifications.enqueue.mock.calls.filter((c: any[]) => c[0] === 'delivered')).toHaveLength(1);
    expect(tx.deliveredAt).toBe(firstTime);
  });

  it('supports recovery from a failed attempt to delivery without marking money collected', async () => {
    const { service, tx } = fixture();
    for (const code of [30, 41, 47, 30, 41, 45]) {
      await service.applyDeliveryUpdate(tx._id, tx, { state: code }, 'webhook');
    }
    expect(tx.bostaStatus).toBe('DELIVERED');
    expect(tx.codCollectionStatus).toBe('CODWaitingCollection');
  });
});
