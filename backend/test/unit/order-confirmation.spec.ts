import { needsOrderConfirmation } from '../../src/employee-performance/order-confirmation';
const orderStates = require('../../../frontend/public/order-status.js');

describe('Home confirmation workload', () => {
  it.each([
    [{}, true],
    [{ depositReceipts: [{ status: 'معتمد', amount: 500 }] }, false],
    [{ depositReceipts: [{ status: 'معتمد', amount: '500' }] }, false],
    [{ depositReceipts: [{ status: 'معتمد', amount: 0 }] }, true],
    [{ depositReceipts: [{ status: 'معلق', amount: 500 }] }, false],
    [{ depositReceipts: [{ status: 'معلق', amount: 0 }] }, true],
    [{ depositReceipts: [{ status: 'مسودة', amount: 500 }] }, true],
    [{ depositReceipts: [{ status: 'مرفوض', amount: 500 }] }, true],
    [{ depositReceipts: [{ status: 'مُسترد', amount: 500 }] }, true],
    [{ shipWithoutDeposit: true }, false],
    [{ confirmationApproved: true }, false],
    [{ depositStatus: 'full', depositAmount: 500, notes: '500' }, true],
    [{ cancelled: true }, false],
    [{ status: 'approved' }, false],
    [{ status: 'rejected' }, false],
  ])('classifies %j consistently with the order lifecycle', (fields, expected) => {
    const order = { status: 'pending', ...fields };
    expect(needsOrderConfirmation(order)).toBe(expected);
    expect(needsOrderConfirmation(order)).toBe(orderStates.resolve(order, 'shopify', 'en').key === 'awaiting_confirmation');
  });
});
