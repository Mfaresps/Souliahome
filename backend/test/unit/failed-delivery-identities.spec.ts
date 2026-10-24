import { checkReturnedIdentities, finishFailedDeliveryIdentities } from '../../src/inventory-units/failed-delivery-identities';

const saleId = '111111111111111111111111', unitId = '222222222222222222222222', actorId = '333333333333333333333333';
const label = { unitId, labelState: 'intact', labelAttached: true };
function fixture(status = 'shipped') {
  const assignment = { transactionId: saleId, lineId: 'line-1' };
  const unit: any = { _id: unitId, productId: '444444444444444444444444', warehouseCode: 'MAIN', status, assignment,
    markModified: jest.fn(), save: jest.fn(async () => {}) };
  const events: any[] = [];
  const session = { withTransaction: async (work: any) => work(), endSession: jest.fn() };
  const inventory = { find: jest.fn(() => ({ toArray: async () => [unit] })), findOne: jest.fn(async () => unit) };
  const users = { findOne: jest.fn(async () => ({ name: 'Operator' })) };
  const products = { updateOne: jest.fn(async () => {}) };
  const printEvents = { findOne: jest.fn(async () => null) };
  const Unit = { findById: () => ({ session: async () => unit }) };
  const Event: any = function (this: any, event: any) { this.save = async () => { events.push(event); }; };
  Event.findOne = () => ({ sort: () => ({ session: () => ({ lean: async () => ({ sequence: 4 }) }) }) });
  const tx: any = { db: { collection: (name: string) => ({ inventoryunits: inventory, users, products, inventoryunitevents: printEvents }[name]),
    startSession: async () => session, model: (name: string) => name === 'InventoryUnit' ? Unit : Event } };
  return { tx, unit, events, session, inventory, printEvents, assignment };
}
it('requires a distinct physical label confirmation for every assigned piece', async () => {
  const { tx } = fixture();
  for (const labels of [[], [label, label], [{ ...label, labelAttached: false }], [{ ...label, unitId: saleId }], [{ ...label, labelState: 'missing' }]]) {
    await expect(checkReturnedIdentities(tx, saleId, labels)).rejects.toThrow();
  }
  await expect(checkReturnedIdentities(tx, saleId, [label])).resolves.toHaveLength(1);
});
it('finishes a return shipped without identities without creating or printing any identity', async () => {
  const { tx, inventory, events } = fixture();
  inventory.find.mockReturnValue({ toArray: async () => [] });
  inventory.findOne.mockResolvedValue(null);
  await expect(checkReturnedIdentities(tx, saleId, [])).resolves.toEqual([]);
  const finish = jest.fn(async () => 'stock-restored');
  await expect(finishFailedDeliveryIdentities(tx, saleId, 'stock', [], 'Operator', actorId, finish)).resolves.toBe('stock-restored');
  expect(finish).toHaveBeenCalledTimes(1);
  expect(events).toHaveLength(0);
});
it('requires a recorded print request for an obscured identity', async () => {
  const { tx, printEvents } = fixture();
  await expect(checkReturnedIdentities(tx, saleId, [{ ...label, labelState: 'reprinted' }])).rejects.toThrow();
  printEvents.findOne.mockResolvedValue({ action: 'label-reprint-requested' } as never);
  await expect(checkReturnedIdentities(tx, saleId, [{ ...label, labelState: 'reprinted', printOperationKey: 'new-print' }])).resolves.toHaveLength(1);
});
it('detaches the returned identity and makes the piece available without a stock posting', async () => {
  const { tx, unit, events, session } = fixture();
  const finish = jest.fn(async () => 'closed');
  expect(await finishFailedDeliveryIdentities(tx, saleId, 'stock', [label], 'Operator', actorId, finish)).toBe('closed');
  expect(unit.assignment).toBeNull(); expect(unit.status).toBe('available');
  expect(events[0]).toMatchObject({ action: 'returned', transactionId: saleId, lineId: 'line-1', sequence: 5,
    details: { label, stockChanged: false, physicalPossessionConfirmed: true } });
  expect(finish).toHaveBeenCalledWith(session); expect(session.endSession).toHaveBeenCalled();
});
it('prepares the same piece for reshipment while retaining its original invoice assignment', async () => {
  const { tx, unit, events, assignment } = fixture();
  await finishFailedDeliveryIdentities(tx, saleId, 'reship', [], 'Operator', actorId, async () => 'reshipped');
  expect(unit.assignment).toBe(assignment); expect(unit.status).toBe('prepared');
  expect(events[0]).toMatchObject({ action: 'prepared', transactionId: saleId, details: { stockChanged: false } });
});
it('does not finish or release pieces when labels are unconfirmed or the piece was delivered', async () => {
  const { tx, unit } = fixture('delivered'); const finish = jest.fn();
  await expect(finishFailedDeliveryIdentities(tx, saleId, 'stock', [label], 'Operator', actorId, finish)).rejects.toThrow();
  expect(finish).not.toHaveBeenCalled(); expect(unit.save).not.toHaveBeenCalled();
});
