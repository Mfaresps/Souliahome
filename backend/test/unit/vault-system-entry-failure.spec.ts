import { VaultService } from '../../src/vault/vault.service';

describe('system ledger failures during receipt approval/refund', () => {
  function setup() {
    let balance = 1000;
    const model = {countDocuments:jest.fn().mockResolvedValue(0),create:jest.fn()};
    const settings = {
      getSettings:jest.fn(async()=>({vaultInstapay:balance})),
      adjustVaultBalance:jest.fn(async(_seg:string,delta:number)=>{
        balance += delta;
        return {vaultInstapay:balance,vaultBalance:balance};
      }),
    };
    const presence = {emitEvent:jest.fn()};
    const service = new VaultService(model as any,settings as any,presence as any);
    return {service,model,settings,presence,balance:()=>balance};
  }

  it.each([500,-500])('rejected %s entry restores balance and retry books once', async amount=>{
    const f = setup();
    f.model.create.mockRejectedValueOnce(new Error('ledger unavailable'))
      .mockResolvedValueOnce({_id:'entry-1'});
    await expect(f.service.addSystemEntry(amount,'Instapay','receipt','2026-10-10'))
      .rejects.toThrow('ledger unavailable');
    expect(f.balance()).toBe(1000);
    expect(f.presence.emitEvent).not.toHaveBeenCalled();
    await f.service.addSystemEntry(amount,'Instapay','receipt','2026-10-10');
    expect(f.balance()).toBe(1000+amount);
    expect(f.presence.emitEvent).toHaveBeenCalledTimes(1);
  });

  it('number generation failure leaves the vault untouched', async()=>{
    const f = setup();
    f.model.countDocuments.mockRejectedValue(new Error('database unavailable'));
    await expect(f.service.addSystemEntry(500,'Instapay','receipt','2026-10-10'))
      .rejects.toThrow('database unavailable');
    expect(f.settings.adjustVaultBalance).not.toHaveBeenCalled();
    expect(f.model.create).not.toHaveBeenCalled();
    expect(f.balance()).toBe(1000);
  });
});
