import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8').replace(/\r\n/g, '\n');
function shippedFunction(name: string) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing shipped handler ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function setup() {
  const api = jest.fn();
  const context: any = {
    transactions:[{_id:'order-1', type:'مبيعات', bostaOrderId:'shipment-1'}],
    _ivBosta:new Map(), api, currentPage:'invoice-view', window:{_invoiceViewTxId:'order-1'},
  };
  context.renderInvoiceViewPage = jest.fn(() => {
    // The actual page renderer calls the loader on every repaint.
    if (context.renderInvoiceViewPage.mock.calls.length <= 10) context._ivLoadBostaDetails('order-1');
  });
  vm.createContext(context);
  vm.runInContext(shippedFunction('_ivLoadBostaDetails') + '\n' + shippedFunction('_ivRepaintIfOpen'), context);
  return context;
}

describe('invoice Bosta details loading', () => {
  it('does not loop requests or skeletons after a failed fetch', async () => {
    const c=setup(); c.api.mockRejectedValue(new Error('Bosta unavailable'));
    await c._ivLoadBostaDetails('order-1');
    for(let i=0;i<20;i++) c._ivLoadBostaDetails('order-1');
    expect(c.api).toHaveBeenCalledTimes(1);
    expect(c.renderInvoiceViewPage).toHaveBeenCalledTimes(1);
    expect(c._ivBosta.get('order-1').state).toBe('fail');
  });

  it('permits explicit retry and caches the recovered result', async () => {
    const c=setup(); c.api.mockRejectedValueOnce(new Error('temporary')).mockResolvedValue({available:true});
    await c._ivLoadBostaDetails('order-1');
    await c._ivLoadBostaDetails('order-1',true);
    c._ivLoadBostaDetails('order-1');
    expect(c.api).toHaveBeenCalledTimes(2);
    expect(c.api.mock.calls[1][0]).toContain('?fresh=1');
    expect(c._ivBosta.get('order-1').state).toBe('ok');
  });

  it('preserves visible data while refreshing and after a failed refresh', async () => {
    const c=setup(); const data={available:true,trackingNumber:'123'};
    c.api.mockResolvedValueOnce(data); await c._ivLoadBostaDetails('order-1');
    let reject!: (e:Error)=>void;
    c.api.mockImplementationOnce(()=>new Promise((_,fail)=>{reject=fail;}));
    const refresh=c._ivLoadBostaDetails('order-1',true);
    expect(c._ivBosta.get('order-1').data).toBe(data);
    reject(new Error('offline')); await refresh;
    expect(c._ivBosta.get('order-1').data).toBe(data);
    expect(c._ivBosta.get('order-1').state).toBe('fail');
    expect(c.api).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent requests and repeated retry clicks', async () => {
    const c=setup(); let resolve!: (data:any)=>void;
    c.api.mockImplementation(()=>new Promise(ok=>{resolve=ok;}));
    const pending=c._ivLoadBostaDetails('order-1');
    for(let i=0;i<50;i++) c._ivLoadBostaDetails('order-1',true);
    expect(c.api).toHaveBeenCalledTimes(1);
    resolve({available:true}); await pending;
  });

  it('ignores a late response from a replaced shipment', async () => {
    const c=setup(); let resolveOld!: (data:any)=>void;
    c.api.mockImplementationOnce(()=>new Promise(ok=>{resolveOld=ok;})).mockResolvedValueOnce({trackingNumber:'new'});
    const old=c._ivLoadBostaDetails('order-1');
    c.transactions[0].bostaOrderId='shipment-2';
    await c._ivLoadBostaDetails('order-1');
    resolveOld({trackingNumber:'old'}); await old;
    expect(c._ivBosta.get('order-1').data.trackingNumber).toBe('new');
    expect(c.renderInvoiceViewPage).toHaveBeenCalledTimes(1);
  });

  it('does not repaint a different invoice when a request completes', async () => {
    const c=setup(); c.api.mockResolvedValue({available:true});
    const pending=c._ivLoadBostaDetails('order-1');
    c.window._invoiceViewTxId='order-2'; await pending;
    expect(c.renderInvoiceViewPage).not.toHaveBeenCalled();
  });
});
