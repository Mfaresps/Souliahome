import { bostaCashoutDueAt } from '../../src/shared/bosta-cashout.util';
import { CarrierAutoSettleService } from '../../src/transactions/carrier-auto-settle.service';

describe('Bosta wallet and bank cashout', () => {
  const payload = (day: string = '2026-10-21') => ({ data: {
    cod: 1379, state: { code: 45 },
    log: [{ actionsList: { pricing: { after: { priceAfterVat: 127.68 } } } }],
    wallet: { cashCycle: { deposited_at: '2026-10-10T13:49:00Z' }, cashout: { next_cashout_date: day } },
  } });
  let service: any, tx: any, collect: jest.Mock, addEntry: jest.Mock, fetchDelivery: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-10T14:00:00Z'));
    tx = { _id: 'abc', ref: '123', type: 'مبيعات', bostaOrderId: 'delivery', bostaStatus: 'DELIVERED', remaining: 1379, shipCost: 120, payments: [] };
    collect = jest.fn().mockResolvedValue({ payments: [{ id: 'payment' }] });
    addEntry = jest.fn();
    fetchDelivery = jest.fn().mockResolvedValue(payload());
    service = new CarrierAutoSettleService(
      {} as any, {} as any,
      { collect } as any,
      { fetchDelivery } as any,
      { getSettings: jest.fn().mockResolvedValue({ autoSettleReviewLimit: 20, autoSettleVaultMethod: 'تحويل بنكي' }) } as any,
      { addSystemEntry: addEntry, findLatestByRef: jest.fn().mockResolvedValue({ _id: 'vault-entry' }) } as any,
      {} as any, {} as any, {} as any,
    );
    service.lock = jest.fn().mockImplementation(async () => tx);
    service.unlock = jest.fn().mockResolvedValue(undefined);
    service.writeStatement = jest.fn().mockImplementation(async (_id: string, cs: any) => { tx.carrierSettlement = cs; });
  });
  afterEach(() => jest.useRealTimers());

  it('uses Cairo noon including daylight saving and winter', () => {
    expect(bostaCashoutDueAt(payload())).toBe('2026-10-21T09:00:00.000Z');
    expect(bostaCashoutDueAt(payload('2026-12-02'))).toBe('2026-12-02T10:00:00.000Z');
    expect(bostaCashoutDueAt(payload('invalid'))).toBe('');
    expect(bostaCashoutDueAt(payload('2026-02-30'))).toBe('');
  });

  it.each(['auto', 'manual-select', 'approve'])('keeps funds out of the vault before cashout for %s', async trigger => {
    if (trigger === 'approve') tx.carrierSettlement = { status: 'review' };
    const result = await service.settleOne('abc', { trigger, by: 'test' });
    expect(result.outcome).toBe('wallet');
    expect(tx.carrierSettlement).toMatchObject({ status: 'pending', phase: 'wallet', net: 1251.32, dueAt: '2026-10-21T09:00:00.000Z' });
    expect(collect).not.toHaveBeenCalled();
    expect(addEntry).not.toHaveBeenCalled();
  });

  it('records the wallet at noon without any individual vault posting', async () => {
    jest.setSystemTime(new Date('2026-10-21T09:00:00Z'));
    expect((await service.settleOne('abc', { trigger: 'auto', by: 'system' })).outcome).toBe('wallet');
    expect(collect).not.toHaveBeenCalled();
    expect(addEntry).not.toHaveBeenCalled();
  });

  it('does not invent a transfer date when Bosta has none', async () => {
    fetchDelivery.mockResolvedValue(payload(''));
    expect((await service.settleOne('abc', { trigger: 'auto', by: 'system' })).outcome).toBe('wallet');
    expect(tx.carrierSettlement.reason).toBe('cashout-date-missing');
    expect(collect).not.toHaveBeenCalled();
  });

  it('waits for wallet deposit even when the bank date has arrived', async () => {
    jest.setSystemTime(new Date('2026-10-21T09:00:00Z'));
    const raw = payload();
    raw.data.wallet.cashCycle.deposited_at = '';
    fetchDelivery.mockResolvedValue(raw);
    expect((await service.settleOne('abc', { trigger: 'auto', by: 'system' })).outcome).toBe('wallet');
    expect(collect).not.toHaveBeenCalled();
  });

  it('keeps wallet funds pending and retries if Bosta is unavailable on cashout day', async () => {
    await service.settleOne('abc', { trigger: 'auto', by: 'system' });
    jest.setSystemTime(new Date('2026-10-21T09:00:00Z'));
    fetchDelivery.mockRejectedValue(new Error('Bosta unavailable'));
    expect((await service.settleOne('abc', { trigger: 'auto', by: 'system' })).reason).toBe('fetch-failed');
    expect(tx.carrierSettlement).toMatchObject({ status: 'pending', phase: 'wallet', net: 1251.32, dueAt: '2026-10-21T10:00:00.000Z' });
    expect(collect).not.toHaveBeenCalled();
  });

  it('preserves approval of the same fees until the bank day', async () => {
    const raw = payload();
    raw.data.log[0].actionsList.pricing.after.priceAfterVat = 150;
    fetchDelivery.mockResolvedValue(raw);
    tx.carrierSettlement = { status: 'review' };
    expect((await service.settleOne('abc', { trigger: 'approve', by: 'admin' })).outcome).toBe('wallet');
    jest.setSystemTime(new Date('2026-10-21T09:00:00Z'));
    expect((await service.settleOne('abc', { trigger: 'auto', by: 'system' })).outcome).toBe('wallet');
    expect(tx.carrierSettlement.approvedFees).toBe(150);
    expect(collect).not.toHaveBeenCalled();
  });

  it('includes a prepaid order with existing payments as a fee-only wallet liability', async () => {
    tx.remaining = 0;
    tx.payStatus = 'مكتمل';
    tx.codCollectionStatus = 'Collected';
    tx.payments = [{ id: 'prepaid', amount: 1379 }];
    const raw = payload();
    raw.data.cod = 0;
    raw.data.wallet.cashCycle.deposited_at = '';
    fetchDelivery.mockResolvedValue(raw);
    expect((await service.settleOne('abc', { trigger: 'auto', by: 'system' })).outcome).toBe('wallet');
    expect(tx.carrierSettlement).toMatchObject({ carrierCod: 0, net: -127.68, phase: 'wallet' });
    expect(tx.carrierSettlement.walletDepositedAt).toBeTruthy();
    expect(addEntry).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it('holds fee shortfalls outside the vault before the bank day', async () => {
    tx.remaining = 50;
    tx.shipCost = 127.68;
    const raw = payload();
    raw.data.cod = 50;
    fetchDelivery.mockResolvedValue(raw);
    expect((await service.settleOne('abc', { trigger: 'auto', by: 'system' })).outcome).toBe('wallet');
    expect(tx.carrierSettlement.net).toBe(-77.68);
    expect(addEntry).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it('uses the final wallet fees when they differ from the shipment log', async () => {
    const raw: any = payload();
    raw.data.wallet.cashCycle.bosta_fees = '130.00';
    raw.data.wallet.cashCycle.cod = '1379.00';
    fetchDelivery.mockResolvedValue(raw);
    expect((await service.settleOne('abc', { trigger: 'auto', by: 'system' })).outcome).toBe('wallet');
    expect(tx.carrierSettlement).toMatchObject({ net: 1249, fees: { priceAfterVat: 130 } });
  });
});
