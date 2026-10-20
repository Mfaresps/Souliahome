import { ADVERTISING_CATEGORY, calculateAuditMarketing, calculateAuditFinancials, previousMarketingWindows, OrderAuditMarketingService } from '../../src/shopify/order-audit-marketing.service';

const row = (more: any = {}) => ({ registered:true, syncStatus:'synced', orderTotal:1500, netProfit:500, productCost:900, shippingCost:100, actualShipCost:100, hasProfit:true, ...more });
const chain = (items: any[]) => { const q:any={}; for(const method of ['sort','skip','limit','select']) q[method]=jest.fn(()=>q); q.lean=jest.fn(async()=>items); return q; };
it('subtracts advertising exactly once from profit and separately from sales', () => {
  const m=calculateAuditMarketing([row(),row()] as any,[{amount:200},{amount:300}]);
  expect(m).toMatchObject({spend:500,revenue:3000,roas:6,costPerOrder:250,salesAfterAdvertising:2500,profitBeforeAdvertising:1000,profitAfterAdvertising:500,netMargin:16.6667,breakEvenRoas:3});
});
it('excludes cancelled and missing orders, identifies pending estimates and missing costs', () => {
  const m=calculateAuditMarketing([row({hasProfit:false}),row({registered:false,syncStatus:'pending'}),row({cancelled:true}),row({registered:false,syncStatus:'missing'})] as any,[{amount:100}]);
  expect(m).toMatchObject({orders:2,registeredOrders:1,pendingOrders:1,excludedOrders:2,profitAfterAdvertising:400,estimatedProfitAfterAdvertising:900,missingCostOrders:1,breakEvenRoas:null});
  expect(calculateAuditMarketing([],[])).toMatchObject({roas:null,costPerOrder:null,netMargin:null,profitAfterAdvertising:null});
});
it('restricts listing to advertising even when arbitrary categories are supplied', async () => {
  const query=chain([]), expenses:any={find:jest.fn(()=>query)}, audit:any={};
  const s=new OrderAuditMarketingService(expenses,audit);
  await s.list({category:'rent',search:'.*',fromDate:'2026-01-01',toDate:'2026-03-31',months:'1,3',year:'2026'});
  const filter=expenses.find.mock.calls[0][0];
  expect(filter.category).toBe(ADVERTISING_CATEGORY); expect(filter.category.test('اعلانات')).toBe(true); expect(filter.category.test('rent')).toBe(false);
  expect(filter.$or[0].desc.test('anything')).toBe(false);expect(filter.$or[0].desc.test('.*')).toBe(true);
  expect(filter.$and[0].date.test('2026-02-20')).toBe(false);expect(filter.$and[0].date.test('2026-03-20')).toBe(true);
  expect(query.limit).toHaveBeenCalledWith(31);
});
it('deduplicates and validates approved advertising invoices on the server and forwards the exact period', async () => {
  const id='123456789012345678901234', expenses:any={find:jest.fn(()=>chain([{_id:id,amount:100}]))};
  const audit:any={runAuditPeriod:jest.fn(async()=>({rows:[row(),row({registered:false,syncStatus:'pending'})]}))};
  const s=new OrderAuditMarketingService(expenses,audit);
  const result=await s.analyze({expenseIds:[id,id],scopes:['synced'],period:{fromDate:'2026-01-01',toDate:'2026-03-31',months:[1,3],year:2026}});
  expect(result.metrics.orders).toBe(1);expect(result.metrics.spend).toBe(100);
  expect(expenses.find.mock.calls[0][0]).toMatchObject({status:'معتمد',amount:{$gt:0},category:ADVERTISING_CATEGORY});
  expect(audit.runAuditPeriod).toHaveBeenCalledWith({fromDate:'2026-01-01',toDate:'2026-03-31',months:'1,3',year:'2026'},{persist:false});
  expenses.find.mockImplementation(()=>chain([]));
  await expect(s.analyze({expenseIds:[id],scopes:['synced'],from:1,to:2})).rejects.toThrow('معتمدة');
  await expect(s.analyze({expenseIds:[],scopes:['bad'],from:1,to:2})).rejects.toThrow();
  await expect(s.analyze({expenseIds:['bad'],scopes:[],from:1,to:2})).rejects.toThrow();
});
it('recomputes advertising metrics for synced, deposits and their union without reassigning the advertising spend', async () => {
  const id='123456789012345678901234';
  const expenses:any={find:()=>chain([{_id:id,amount:500}])};
  const audit:any={runAudit:async()=>({rows:[row(),row({registered:false,syncStatus:'pending',depositPending:100,orderTotal:1000,productCost:600,shippingCost:100}),row({registered:false,syncStatus:'pending',shipWithoutDeposit:true})]})};
  const service=new OrderAuditMarketingService(expenses,audit);
  const analyze=(scopes:string[])=>service.analyze({expenseIds:[id],scopes,from:1,to:3});
  expect((await analyze(['synced'])).metrics).toMatchObject({orders:1,revenue:1500,roas:3,costPerOrder:500,profitAfterAdvertising:0});
  expect((await analyze(['pending-deposit'])).metrics).toMatchObject({orders:1,revenue:1000,roas:2,costPerOrder:500,profitAfterAdvertising:null,estimatedProfitAfterAdvertising:-200});
  expect((await analyze(['synced','pending-deposit'])).metrics).toMatchObject({orders:2,revenue:2500,spend:500,roas:5,costPerOrder:250,estimatedProfitAfterAdvertising:300});
});
it('compares matching calendar days, complete months, leap years and separated months without overlaps',()=>{
  expect(previousMarketingWindows({fromDate:'2026-10-01',toDate:'2026-10-21'})).toEqual([{fromDate:'2026-09-01',toDate:'2026-09-21'}]);
  expect(previousMarketingWindows({fromDate:'2026-03-01',toDate:'2026-03-31'})).toEqual([{fromDate:'2026-02-01',toDate:'2026-02-28'}]);
  expect(previousMarketingWindows({fromDate:'2024-03-01',toDate:'2024-03-31'})).toEqual([{fromDate:'2024-02-01',toDate:'2024-02-29'}]);
  expect(previousMarketingWindows({fromDate:'2026-01-01',toDate:'2026-01-31'})).toEqual([{fromDate:'2025-12-01',toDate:'2025-12-31'}]);
  expect(previousMarketingWindows({fromDate:'2026-01-01',toDate:'2026-03-31',months:[1,3],year:2026})).toEqual([{fromDate:'2025-10-01',toDate:'2025-10-31'},{fromDate:'2025-12-01',toDate:'2025-12-31'}]);
  expect(previousMarketingWindows({fromDate:'2026-10-15',toDate:'2026-11-02'})).toEqual([{fromDate:'2026-09-26',toDate:'2026-10-14'}]);
});
it('uses independent approved advertising expenses and identical order scopes for the prior period',async()=>{
  const current={_id:'111111111111111111111111',amount:200,date:'2026-10-10'},previous={_id:'222222222222222222222222',amount:500,date:'2026-09-10'};
  const find=jest.fn(filter=>chain(filter._id?(filter._id.$in.length?filter._id.$in[0].toString()===current._id?[current]:[previous]:[]):[previous]));
  const audit:any={runAuditPeriod:jest.fn(async p=>({period:p,rows:p.fromDate.startsWith('2026-10')?[row()]:[row({orderTotal:1000,netProfit:300}),row({registered:false,syncStatus:'pending',depositPending:50})]}))};
  const service=new OrderAuditMarketingService({find} as any,audit);
  const body={expenseIds:[current._id],scopes:['synced'],period:{fromDate:'2026-10-01',toDate:'2026-10-21'},compare:true};
  const result=await service.analyze(body);
  expect(result.metrics.spend).toBe(200);expect(result.comparison.metrics).toMatchObject({spend:500,orders:1,roas:2,profitAfterAdvertising:-200});
  expect(result.comparison.expenseMode).toBe('all-approved');expect(result.comparison.financials.sales).toBe(1000);
  expect(find.mock.calls[1][0]).toMatchObject({category:ADVERTISING_CATEGORY,status:'معتمد',amount:{$gt:0},$or:[{date:{$gte:'2026-09-01',$lt:'2026-09-22'}}]});
  expect(audit.runAuditPeriod.mock.calls.every(call=>call[1].persist===false)).toBe(true);
  expect((await service.analyze({...body,previousExpenseIds:[]})).comparison.metrics.spend).toBe(0);
  expect((await service.analyze({...body,compare:false})).comparison).toBeNull();
});
it('preserves a valid current analysis if comparison is unavailable and keeps financial scope totals consistent',async()=>{
  const audit:any={runAuditPeriod:jest.fn(async p=>{if(p.fromDate.startsWith('2026-09'))throw Error('offline');return{period:p,rows:[row()]};})};
  const result=await new OrderAuditMarketingService({} as any,audit).analyze({expenseIds:[],scopes:['synced'],period:{fromDate:'2026-10-01',toDate:'2026-10-21'},compare:true});
  expect(result.metrics.revenue).toBe(1500);expect(result.comparison.error).toContain('تعذر');
  expect(calculateAuditFinancials([row(),row({registered:false,syncStatus:'pending',orderTotal:1000})] as any)).toMatchObject({orders:2,sales:2500,profit:500,margin:500/1500*100,pendingOrders:1});
});
