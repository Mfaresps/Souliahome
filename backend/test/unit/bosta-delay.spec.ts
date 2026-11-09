import { bostaDelayFlag } from '../../src/bosta/bosta-delay.util';

describe('Bosta delay signal', () => {
  it('reads the carrier delay and SLA fields independently of movement status', () => {
    expect(bostaDelayFlag({ isDelayed: true }, 'IN_TRANSIT')).toBe(true);
    expect(bostaDelayFlag({ sla: { orderSla: { isExceededOrderSla: true } } }, 'IN_TRANSIT')).toBe(true);
    expect(bostaDelayFlag({ isDelayed: false }, 'IN_TRANSIT')).toBe(false);
  });

  it('preserves the last known flag when a webhook has no delay data', () => {
    expect(bostaDelayFlag({ state: 30 }, 'IN_TRANSIT')).toBeNull();
  });

  it('clears the flag when a shipment finishes', () => {
    for (const status of ['DELIVERED', 'RETURNED', 'CANCELLED', 'DELETED']) {
      expect(bostaDelayFlag({ isDelayed: true }, status)).toBe(false);
    }
  });
});
