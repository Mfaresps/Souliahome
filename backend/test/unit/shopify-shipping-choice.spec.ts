import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../src/employee-performance/employee-scoring.service', () => ({ EmployeeScoringService: class {} }));

const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8').replace(/\r\n/g, '\n');
function shipped(name: string) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function ui(order: any, api: any = jest.fn().mockResolvedValue({shipWithoutDeposit:true}), showConfirm: any = jest.fn().mockResolvedValue(true)) {
  return new Function('order', 'api', 'showConfirm', `
    const _spShippingSwitchBusy = new Set();
    const currentLang = 'en';
    const _spDepositOf = o => ({deposit:o.depositAmount || 0,pending:o.pending || [],byMethod:o.depositAmount?{Instapay:o.depositAmount}:{}});
    const hasPerm = () => true, esc = v => v, t = v => v;
    const _spReceiptJs = JSON.stringify, _spOrderById = () => order;
    const _spRefreshOrderRow = () => {}, toast = () => {};
    const currentAuditData=null,renderAuditTable=()=>{};
    ${['_spHasDepositRecorded','_spCanAddDeposit','_spCanChooseShipping','_spShipsWithoutDeposit','_spShippingSwitchHtml','_spDepositNeedsFollowup','_spDepIcon','_spVaultAmountHtml','_spMobileDepositActionHtml','_spDepositCellHtml','_spDepositAddButtonHtml','_spDepositCardClass','_spMobileDepositSummaryHtml'].map(shipped).join('\n')}
    const fmtJ=String,payMethodIcon=()=>'',_payMethodLabel=String;
    ${source.slice(source.indexOf('const SP_FILTERS = ['),source.indexOf('\n];',source.indexOf('const SP_FILTERS = ['))+3)}
    async ${shipped('_spToggleShipWithoutDeposit')}
    ${shipped('_spApplyShippingChoice')}
    return {active:_spShipsWithoutDeposit, followup:_spDepositNeedsFollowup,
      html:_spShippingSwitchHtml,toggle:_spToggleShipWithoutDeposit,
      cell:_spDepositCellHtml,mobile:_spMobileDepositActionHtml,filters:SP_FILTERS,
      cardClass:_spDepositCardClass,summary:_spMobileDepositSummaryHtml};
  `)(order, api, showConfirm);
}
const pending = (extra = {}): any => ({_id:'o1',status:'pending',shopifyCreatedAt:'2020-01-01',...extra});

describe('Shipping without deposit — shipped UI', () => {
  it('shows an accessible green switch and suppresses overdue followup', () => {
    const order = pending({shipWithoutDeposit:true});
    const env = ui(order);
    expect(env.html(order)).toContain('aria-checked="true"');
    expect(env.html(order)).toContain('is-on');
    expect(env.followup(order)).toBe(false);
    expect(env.followup(pending())).toBe(true);
  });
  it.each([{depositAmount:100},{pending:[{amount:100}]}])('receipts supersede the choice: %j', extra => {
    const order = pending({shipWithoutDeposit:true,...extra});
    expect(ui(order).active(order)).toBe(false);
  });
  it('saves the explicit choice', async () => {
    const order: any = pending();
    const api = jest.fn().mockResolvedValue({shipWithoutDeposit:true});
    await ui(order,api).toggle('o1');
    expect(order.shipWithoutDeposit).toBe(true);
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({enabled:true});
  });
  it('rolls back on failure and permits retry', async () => {
    const order: any = pending();
    const api = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({shipWithoutDeposit:true});
    const env = ui(order,api);
    await env.toggle('o1');
    expect(order.shipWithoutDeposit).toBe(false);
    await env.toggle('o1');
    expect(order.shipWithoutDeposit).toBe(true);
  });
  it('blocks double taps while saving', async () => {
    let release: any;
    const api = jest.fn(() => new Promise(resolve => {release=resolve;}));
    const env = ui(pending(),api);
    const first = env.toggle('o1');
    await env.toggle('o1');
    expect(api).toHaveBeenCalledTimes(1);
    release({shipWithoutDeposit:true});
    await first;
  });
  it.each([false,true])('asks for confirmation before changing %s, and cancellation keeps state', async previous => {
    const order = pending({shipWithoutDeposit:previous});
    const api=jest.fn();
    const confirm=jest.fn().mockResolvedValue(false);
    const env=ui(order,api,confirm);
    await env.toggle('o1');
    expect(confirm).toHaveBeenCalledWith(previous?'spShipWithoutDepositOffConfirm':'spShipWithoutDepositOnConfirm',expect.any(Object));
    expect(order.shipWithoutDeposit).toBe(previous);
    expect(api).not.toHaveBeenCalled();
  });
  it('keeps the compact plus disabled when on and enables it when off on both layouts', async () => {
    const order=pending({shipWithoutDeposit:true});
    const env=ui(order,jest.fn().mockResolvedValue({shipWithoutDeposit:false}));
    expect(env.cell(order)).toContain('class="spdep-quick-add" disabled');
    expect(env.mobile(order)).toContain('class="spdep-quick-add" disabled');
    expect(env.cell(order)).not.toContain('spdep-no-deposit');
    await env.toggle('o1');
    expect(env.cell(order)).toContain('spdep-quick-add');
    expect(env.cell(order)).not.toContain('class="spdep-quick-add" disabled');
    expect(env.mobile(order)).toContain('spdep-quick-add');
    expect(env.mobile(order)).not.toContain('class="spdep-quick-add" disabled');
  });
  it.each([{depositAmount:100},{pending:[{amount:100}]}])('hides switch until receipts are removed: %j', extra => {
    const order:any=pending(extra),env=ui(order);
    expect(env.html(order)).toBe('');
    expect(env.cell(order)).not.toContain('role="switch"');
    order.depositAmount=0;order.pending=[];
    expect(env.cell(order)).toContain('role="switch"');
  });
  it('includes the choice in the Shopify dropdown filter and excludes deposits and cancellations', () => {
    const env=ui(pending());
    const filter=env.filters.find((f:any)=>f.key==='ship-without-deposit');
    expect(filter.test(pending({shipWithoutDeposit:true}))).toBe(true);
    expect(filter.test(pending())).toBe(false);
    expect(filter.test(pending({shipWithoutDeposit:true,cancelled:true}))).toBe(false);
    expect(filter.test(pending({shipWithoutDeposit:true,depositAmount:100}))).toBe(false);
  });
  it.each([true,false])('renders only one switch per editable mobile card: %s', enabled => {
    const order=pending({shipWithoutDeposit:enabled}),env=ui(order);
    const html=env.summary(order)+env.mobile(order);
    expect((html.match(/role="switch"/g)||[]).length).toBe(1);
    expect(html).not.toContain('spdep-shipping-status');
  });
  it('uses the paid card color for shipping without deposit and restores amber when off', () => {
    const env=ui(pending());
    expect(env.cardClass(pending({shipWithoutDeposit:true}))).toBe(env.cardClass(pending({depositAmount:100})));
    expect(env.cardClass(pending({shipWithoutDeposit:false}))).toBe('sp-card-deposit-none');
  });
  it('shows a plain status in read-only views, instead of a second disabled switch', () => {
    const order=pending({shipWithoutDeposit:true}),env=ui(order);
    expect(env.cell(order,false)).toContain('role="status"');
    expect(env.cell(order,false)).not.toContain('role="switch"');
  });
});

describe('Shipping choice — service persistence', () => {
  function service(updated: any = {shipWithoutDeposit:true}) {
    const {ShopifyService} = require('../../src/shopify/shopify.service');
    const svc = Object.create(ShopifyService.prototype);
    svc.shopifyOrderModel = {
      findById:jest.fn().mockResolvedValue({_id:'o1'}),
      findOneAndUpdate:jest.fn().mockResolvedValue(updated),
    };
    svc.presence={emitEvent:jest.fn()};
    return svc;
  }
  it('atomically guards order and receipt state and only saves shipping metadata', async () => {
    const svc = service();
    await expect(svc.setShipWithoutDeposit('o1',true,'Staff')).resolves.toMatchObject({success:true,shipWithoutDeposit:true});
    const [filter,update] = svc.shopifyOrderModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({status:'pending',cancelled:{$ne:true},depositReceipts:{$not:{$elemMatch:{status:{$in:['معلق','معتمد']}}}}});
    expect(update.$set).toEqual({shipWithoutDeposit:true,shipWithoutDepositBy:'Staff',shipWithoutDepositAt:expect.any(String)});
  });
  it('rejects a receipt or status change racing the write', async () => {
    const svc=service(null);
    await expect(svc.setShipWithoutDeposit('o1',true)).rejects.toThrow();
    expect(svc.presence.emitEvent).not.toHaveBeenCalled();
  });
  it('broadcasts only the saved state, with its order and revision, to connected users', async () => {
    const updated={_id:'o1',ref:'2776',shipWithoutDeposit:true,shipWithoutDepositAt:'2026-10-11T12:00:00.000Z',shipWithoutDepositBy:'Staff'};
    const svc=service(updated);
    const result=await svc.setShipWithoutDeposit('o1',true,'Staff');
    expect(svc.presence.emitEvent).toHaveBeenCalledWith('shopify:shipping-choice-changed',{orderId:'o1',ref:'2776',shipWithoutDeposit:true,shipWithoutDepositAt:updated.shipWithoutDepositAt,shipWithoutDepositBy:'Staff'});
    expect(result.orderId).toBe('o1');
    expect(result.shipWithoutDepositAt).toBe(updated.shipWithoutDepositAt);
  });
  it('does not block a receipt-free order because of a legacy deposit summary', async () => {
    const svc=service();
    svc.shopifyOrderModel.findById.mockResolvedValue({_id:'o1',status:'pending',depositAmount:1000,depositReceipts:[]});
    await expect(svc.setShipWithoutDeposit('o1',true)).resolves.toMatchObject({shipWithoutDeposit:true});
    const [filter,update]=svc.shopifyOrderModel.findOneAndUpdate.mock.calls[0];
    expect(filter.depositAmount).toBeUndefined();
    expect(filter.depositReceipts).toEqual({$not:{$elemMatch:{status:{$in:['معلق','معتمد']}}}});
    expect(update.$set.depositAmount).toBeUndefined();
  });
  it('rejects strings instead of treating them as true', async () => {
    await expect(service().setShipWithoutDeposit('o1','false')).rejects.toThrow('boolean');
  });
  it('can clear the choice without changing receipts', async () => {
    const svc = service({shipWithoutDeposit:false});
    await svc.setShipWithoutDeposit('o1',false);
    const [filter] = svc.shopifyOrderModel.findOneAndUpdate.mock.calls[0];
    expect(filter.depositReceipts).toBeUndefined();
  });
});
