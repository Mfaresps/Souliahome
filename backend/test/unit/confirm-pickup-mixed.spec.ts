import { BadRequestException } from '@nestjs/common';
import { TransactionsService } from '../../src/transactions/transactions.service';

export {};

const ID1 = '64b000000000000000000001';
const ID2 = '64b000000000000000000002';

function makeSvc(orders: any[]) {
  const calls: any[] = [];
  const svc: any = Object.create(TransactionsService.prototype);
  svc.transactionModel = {
    find: () => ({ select: () => ({ exec: async () => orders }) }),
    findOne: () => ({ sort: () => ({ select: () => ({ exec: async () => null }) }) }),
    updateMany: async (filter: any, update: any) => { calls.push({ filter, update }); return { modifiedCount: orders.length }; },
  };
  svc.genPickupRef = () => 'RUN-1';
  svc.emit = () => {};
  return { svc: svc as TransactionsService, calls };
}

describe('confirmPickup — a prep group where some orders were sent to Bosta', () => {
  it('moves prepared + already-Ready (Bosta) orders together', async () => {
    const { svc, calls } = makeSvc([
      { _id: ID1, pickupStatus: 'Preparing', prepChecked: true },
      { _id: ID2, pickupStatus: 'Ready', prepChecked: true },
    ]);
    const r = await svc.confirmPickup([ID1, ID2], 'Reem', '2026-10-05');
    expect(r.updated).toBe(2);
    expect(calls[0].filter.$or).toEqual([
      { pickupStatus: 'Preparing', prepChecked: true },
      { pickupStatus: { $in: ['Ready', 'Picked-Up'] } },
    ]);
    expect(calls[0].update.$set.pickupStatus).toBe('Ready');
  });

  it('still refuses an order that was never prepared', async () => {
    const { svc } = makeSvc([
      { _id: ID1, pickupStatus: 'Preparing', prepChecked: false },
      { _id: ID2, pickupStatus: 'Ready' },
    ]);
    await expect(svc.confirmPickup([ID1, ID2], 'Reem')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an all-prepared group keeps the original filter', async () => {
    const { svc, calls } = makeSvc([
      { _id: ID1, pickupStatus: 'Preparing', prepChecked: true },
      { _id: ID2, pickupStatus: 'Preparing', prepChecked: true },
    ]);
    await svc.confirmPickup([ID1, ID2], 'Reem');
    expect(calls[0].filter.$or).toBeUndefined();
    expect(calls[0].filter.pickupStatus).toBe('Preparing');
  });
});
