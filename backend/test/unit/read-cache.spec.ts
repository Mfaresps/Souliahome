import { cachedRead, invalidateReadCaches } from '../../src/shared/read-cache.util';

export {};

describe('cachedRead — display-only cache', () => {
  beforeEach(() => invalidateReadCaches());

  it('shares one computation between concurrent callers', async () => {
    let calls = 0;
    const compute = () => new Promise<number>(resolve => { calls++; setTimeout(() => resolve(calls), 10); });
    const [a, b, c] = await Promise.all([cachedRead('k', 5000, compute), cachedRead('k', 5000, compute), cachedRead('k', 5000, compute)]);
    expect(calls).toBe(1);
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  it('recomputes after a write invalidates it', async () => {
    let value = 1;
    expect(await cachedRead('k', 5000, async () => value)).toBe(1);
    value = 2;
    expect(await cachedRead('k', 5000, async () => value)).toBe(1);
    invalidateReadCaches();
    expect(await cachedRead('k', 5000, async () => value)).toBe(2);
  });

  it('does not keep a read that started before a write finished', async () => {
    let value = 1;
    let release!: () => void;
    // The read sees the data as it was when it started.
    const slow = cachedRead('k', 5000, () => { const seen = value; return new Promise<number>(r => { release = () => r(seen); }); });
    invalidateReadCaches();           // the write lands while the read is running
    value = 2;
    release();
    expect(await slow).toBe(1);       // that caller gets what it read...
    expect(await cachedRead('k', 5000, async () => value)).toBe(2); // ...but it is not reused
  });

  it('expires after its TTL', async () => {
    let value = 1;
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    expect(await cachedRead('k', 5000, async () => value)).toBe(1);
    value = 2;
    now.mockReturnValue(7000);
    expect(await cachedRead('k', 5000, async () => value)).toBe(2);
    now.mockRestore();
  });

  it('does not keep a failure', async () => {
    await expect(cachedRead('k', 5000, async () => { throw new Error('db down'); })).rejects.toThrow('db down');
    expect(await cachedRead('k', 5000, async () => 3)).toBe(3);
  });

  it('shares slow in-flight work even when the query takes longer than the TTL', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      let release!: (value: number) => void;
      const compute = jest.fn(() => new Promise<number>(resolve => { release = resolve; }));
      const first = cachedRead('slow', 3000, compute);
      now.mockReturnValue(9000);
      const second = cachedRead('slow', 3000, compute);
      expect(compute).toHaveBeenCalledTimes(1);
      release(42);
      expect(await first).toBe(42);
      expect(await second).toBe(42);
      now.mockReturnValue(10000);
      expect(await cachedRead('slow', 3000, compute)).toBe(42);
      expect(compute).toHaveBeenCalledTimes(1);
    } finally { now.mockRestore(); }
  });

  it('bounds retained entries on a long-running server', async () => {
    const first = jest.fn(async () => 1);
    await cachedRead('oldest', 5000, first);
    for (let i = 0; i < 128; i++) await cachedRead(`filter-${i}`, 5000, async () => i);
    await cachedRead('oldest', 5000, first);
    expect(first).toHaveBeenCalledTimes(2);
  });
});
