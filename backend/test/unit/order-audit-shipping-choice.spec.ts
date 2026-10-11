import * as fs from 'fs';
import * as path from 'path';
import { OrderAuditService } from '../../src/shopify/order-audit.service';

const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8').replace(/\r\n/g, '\n');
function shipped(name: string) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const ui = new Function(`
  const AUDIT_HIGH_VALUE=5000, esc=String, fmtJ=v=>String(v), t=key=>key==='spDepPendingShort'?'قيد المراجعة':'شحن بدون عربون';
  ${['_auditShipsWithoutDeposit','_auditPaymentCellHtml','matchesAuditFilter','renderAuditFilterCounts','matchesAuditPaymentFilter'].map(shipped).join('\n')}
  let currentAuditData, counts={};
  const fmtNum=String, qsa=selector=>[{set textContent(value){counts[selector]=value;}}];
  return {cell:_auditPaymentCellHtml,filter:matchesAuditFilter,paymentFilter:matchesAuditPaymentFilter,
    counts(rows){currentAuditData={rows};counts={};renderAuditFilterCounts();return counts;}};
`)();
const pending = (extra: any = {}) => ({syncStatus:'pending',registered:false,shipWithoutDeposit:true,depositApproved:0,depositPending:0,...extra});

describe('Order analysis — shipped table and filters', () => {
  it('displays the saved choice in green, within the pending filter', () => {
    const row = pending();
    expect(ui.cell(row)).toContain('شحن بدون عربون');
    expect(ui.cell(row)).toContain('class="oa-payment-ready"');
    expect(ui.cell(pending({depositApproved:100}))).toContain('class="oa-payment-ready"');
    expect(ui.filter(row,'pending')).toBe(true);
    expect(ui.filter(row,'ship-without-deposit')).toBe(true);
  });
  it.each([
    {shipWithoutDeposit:false}, {depositApproved:100}, {depositPending:100},
    {registered:true}, {syncStatus:'cancelled',cancelled:true}, {syncStatus:'missing'},
  ])('excludes other payment states from the shipping filter: %j', extra => {
    expect(ui.filter(pending(extra),'ship-without-deposit')).toBe(false);
  });
  it('keeps approved deposits and ordinary no-deposit labels', () => {
    expect(ui.cell(pending({depositApproved:100,depositMethod:'Instapay'}))).toContain('100 · Instapay');
    expect(ui.cell(pending({shipWithoutDeposit:false}))).toContain('بدون عربون');
    expect(ui.cell(pending({shipWithoutDeposit:false}))).not.toContain('شحن بدون عربون');
    expect(ui.cell(pending({shipWithoutDeposit:false}))).not.toContain('oa-payment-ready');
  });
  it('shows a pending deposit amount with its review status instead of no deposit', () => {
    const html=ui.cell(pending({shipWithoutDeposit:false,depositPending:250}));
    expect(html).toContain('250');
    expect(html).toContain('قيد المراجعة');
    expect(html).toContain('oa-payment-ready');
    expect(html).not.toContain('بدون عربون');
  });
  it('shows approved and pending amounts separately when both exist', () => {
    const html=ui.cell(pending({depositApproved:100,depositPending:250,depositMethod:'Instapay'}));
    expect(html).toContain('100 · Instapay');
    expect(html).toContain('250');
    expect(html).toContain('قيد المراجعة');
    expect(html).not.toContain('بدون عربون');
  });
  it('counts both pending orders and the shipping choice separately', () => {
    const counts = ui.counts([pending(),pending({shipWithoutDeposit:false}),pending({depositPending:100}),pending({syncStatus:'cancelled'})]);
    expect(counts['.oa-filter-count[data-oa-count="pending"]']).toBe('(3)');
    expect(counts['.oa-filter-count[data-oa-count="ship-without-deposit"]']).toBe('(1)');
  });
  it('separates shipping without deposit from awaiting deposit in payment filters', () => {
    expect(ui.paymentFilter(pending(),'ship-without-deposit')).toBe(true);
    expect(ui.paymentFilter(pending(),'awaiting-deposit')).toBe(false);
    expect(ui.paymentFilter(pending({shipWithoutDeposit:false}),'awaiting-deposit')).toBe(true);
    expect(ui.paymentFilter(pending({depositApproved:100}),'deposit-paid')).toBe(true);
    expect(ui.paymentFilter(pending({depositPending:100}),'pending-review')).toBe(true);
  });
});

describe('Order analysis — service data', () => {
  it('includes every pending order and exposes only active shipping choices', async () => {
    const orders = [
      {_id:'1',ref:'1',status:'pending',shipWithoutDeposit:true},
      {_id:'2',ref:'2',status:'pending',shipWithoutDeposit:false},
      {_id:'3',ref:'3',status:'pending',shipWithoutDeposit:true,depositReceipts:[{status:'معلق',amount:100}]},
      {_id:'4',ref:'4',status:'pending',shipWithoutDeposit:true,depositReceipts:[{status:'معتمد',amount:100,method:'Instapay'}]},
      {_id:'5',ref:'5',status:'pending',shipWithoutDeposit:true,cancelled:true},
    ];
    const model = (rows: any[]) => ({find:jest.fn().mockReturnValue({lean:jest.fn().mockResolvedValue(rows)})});
    const service: any = Object.create(OrderAuditService.prototype);
    service.txModel=model([]);
    service.shopifyOrderModel=model(orders);
    service.productModel=model([]);
    service.loadReviews=jest.fn().mockResolvedValue(new Map());
    const result = await service.runAudit(1,6,{persist:false});
    expect(result.sequence.pendingCount).toBe(4);
    expect(result.rows.map((r: any) => r.shipWithoutDeposit)).toEqual([true,false,false,false,false,false]);
    expect(result.rows[2].depositPending).toBe(100);
    expect(result.rows[3].depositApproved).toBe(100);
    expect(result.rows[5].syncStatus).toBe('missing');
  });
});
