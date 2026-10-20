const { inspect } = require('../../scripts/check-inventory-readiness.cjs');

describe('read-only inventory release gate', () => {
  const run = async (hello: any, collections: any[]) => {
    const indexes = jest.fn(async () => ({ applied: false, collections }));
    const command = jest.fn(async () => hello);
    const result = await inspect({ db: { admin: () => ({ command }) } }, indexes);
    expect(command).toHaveBeenCalledWith({ hello: 1 });
    expect(indexes).toHaveBeenCalledWith(expect.anything(), false);
    return result;
  };
  const ready = [{ exists: true, missing: [] }];
  const replica = { setName: 'test', logicalSessionTimeoutMinutes: 30, maxWireVersion: 17 };
  it('rejects standalone even when every index exists', async () => {
    expect((await run({ logicalSessionTimeoutMinutes: 30, maxWireVersion: 17 }, ready)).writesReady).toBe(false);
  });
  it('rejects missing indexes before replacing application containers', async () => {
    expect((await run(replica, [{ exists: true, missing: ['required_unique_index'] }])).writesReady).toBe(false);
  });
  it('accepts replica and mongos only when indexes exist', async () => {
    expect((await run(replica, ready)).writesReady).toBe(true);
    expect((await run({ ...replica, setName: undefined, msg: 'isdbgrid' }, ready)).writesReady).toBe(true);
  });
});
