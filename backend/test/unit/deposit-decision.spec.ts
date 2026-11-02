import { validateDepositDecision, depositDecisionReport } from '../../src/shopify/deposit-decision.util';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ShippingDecisionDto } from '../../src/shopify/dto/deposit-decision.dto';
jest.mock('../../src/employee-performance/employee-scoring.service', () => ({ EmployeeScoringService: class {} }));

describe('Structured deposit decision',()=>{
 const valid={revision:0,reasonCode:'prefers-cod',exceptionCode:'staff-discretion',note:' customer ',exceptionNote:''};
 it('requires a known reason and separate exception; rejects empty other details',()=>{
  for(const input of [{}, {...valid,reasonCode:'bad'}, {...valid,exceptionCode:''}, {...valid,reasonCode:'other',note:' '}, {...valid,exceptionCode:'manager-exception',exceptionNote:''}, {...valid,exceptionCode:'other',exceptionNote:' '}, {...valid,note:'a'.repeat(501)}]) expect(()=>validateDepositDecision(input,true)).toThrow();
  expect(validateDepositDecision(valid,true).note).toBe('customer');
  expect(validateDepositDecision({reasonCode:'no-payment-method'},false)).toEqual({reasonCode:'no-payment-method',note:''});
 });
 it('rejects missing revisions and string booleans at the HTTP boundary',async()=>{
  expect((await validate(plainToInstance(ShippingDecisionDto,{...valid,enabled:true}))).length).toBe(0);
  expect((await validate(plainToInstance(ShippingDecisionDto,{...valid,enabled:'false'}))).length).toBeGreaterThan(0);
  expect((await validate(plainToInstance(ShippingDecisionDto,{enabled:false}))).length).toBeGreaterThan(0);
 });
 function svc(order:any){
  const {ShopifyService}=require('../../src/shopify/shopify.service');const s=Object.create(ShopifyService.prototype);
  s.shopifyOrderModel={findById:jest.fn().mockResolvedValue(order),findOneAndUpdate:jest.fn().mockImplementation(async(_f:any,u:any)=>({...order,...u.$set,depositDecisionRevision:(order.depositDecisionRevision||0)+1}))};
  s.presence={emitEvent:jest.fn()};return s;
 }
 it('disabling retains the reason and records the previous and next choices',async()=>{
  const s=svc({_id:'o1',shipWithoutDeposit:true,depositDecisionRevision:2,depositDecision:{reasonCode:'no-payment-method',note:'existing'}});
  await s.setShipWithoutDeposit('o1',false,'Staff',{revision:2},{id:'u',username:'staff'});
  const [filter,update]=s.shopifyOrderModel.findOneAndUpdate.mock.calls[0];
  expect(filter.$and).toEqual([{depositDecisionRevision:2}]);
  expect(update.$set.depositDecision).toEqual({reasonCode:'no-payment-method',note:'existing'});
  expect(update.$push.depositDecisionHistory).toMatchObject({action:'disabled',byId:'u',byUsername:'staff',before:{enabled:true},after:{enabled:false,reasonCode:'no-payment-method'}});
  expect(update.$set.depositAmount).toBeUndefined();
 });
 it('rejects stale revisions without overwriting someone else’s decision',async()=>{
  const s=svc({_id:'o1',depositDecisionRevision:2});
  await expect(s.setShipWithoutDeposit('o1',true,'Staff',valid)).rejects.toThrow();
  await expect(s.recordDepositObjection('o1',{revision:1,reasonCode:'prefers-cod'},{name:'Staff'})).rejects.toThrow();
  expect(s.shopifyOrderModel.findOneAndUpdate).not.toHaveBeenCalled();
 });
 it('records an objection without enabling shipping or touching money',async()=>{
  const s=svc({_id:'o1',shipWithoutDeposit:false});
  await s.recordDepositObjection('o1',{revision:0,reasonCode:'first-order-trust'},{id:'u',username:'staff',name:'Staff'});
  const [filter,update]=s.shopifyOrderModel.findOneAndUpdate.mock.calls[0];
  expect(filter).toMatchObject({status:'pending',cancelled:{$ne:true}});
  expect(Object.keys(update.$set)).toEqual(['depositDecision']);
  expect(update.$push.depositDecisionHistory).toMatchObject({action:'objection-recorded',byId:'u',after:{enabled:false}});
 });
});

describe('Monthly deposit report',()=>{
 const order=(ref:string,extra:any={})=>({ref,shopifyId:ref,shopifyCreatedAt:'2026-10-10T12:00:00+03:00',...extra});
 const tx=(ref:string,extra:any={})=>({ref,shopifyOrderId:ref,type:'مبيعات',...extra});
 it('uses Cairo creation month including UTC midnight boundaries',()=>{
  const report=depositDecisionReport([order('1',{shopifyCreatedAt:'2026-09-30T22:30:00Z'}),order('2',{shopifyCreatedAt:'2026-10-31T22:30:00Z'})],[],'2026-10');
  expect(report.rows.map(r=>r.ref)).toEqual(['1']);
  expect(()=>depositDecisionReport([],[],'2026-13')).toThrow();
 });
 it('separates enabled from shipped; counts orders once despite repeated activations',()=>{
  const report=depositDecisionReport([order('1',{shipWithoutDeposit:true,depositDecision:{reasonCode:'prefers-cod'},depositDecisionHistory:[{action:'enabled'},{action:'disabled'},{action:'enabled'}]}),order('2',{shipWithoutDeposit:true,depositDecision:{reasonCode:'prefers-cod'}})], [tx('2',{initialDeposit:0,shipWithoutDeposit:true,bostaStatus:'DELIVERED',pickupStatus:'Shipped'})],'2026-10');
  expect(report.groups.find(g=>g.code==='prefers-cod')).toMatchObject({orders:2,enabled:2,shipped:1,delivered:1,pending:1,deliveryRate:100});
 });
 it('does not interpret collection after delivery as an initial deposit, or invent legacy reasons',()=>{
  const report=depositDecisionReport([order('1'),order('2')],[tx('1',{deposit:1000,initialDeposit:0,bostaStatus:'DELIVERED'}),tx('2',{initialDeposit:100})],'2026-10');
  expect(report.rows[0]).toMatchObject({paid:false,reasonCode:'unrecorded',everEnabled:false,confirmedWithoutDeposit:true});
  expect(report.rows[1]).toMatchObject({paid:true,reasonCode:'no-objection-recorded'});
 });
 it('retains the confirmed reason snapshot and measures later approved money by dates',()=>{
  const o=order('1',{depositDecision:{reasonCode:'prefers-cod',at:'2026-10-10'},depositDecisionHistory:[{action:'objection-recorded',at:'2026-10-10',after:{reasonCode:'first-order-trust'}}],depositReceipts:[{status:'معتمد',amount:100,reviewedAt:'2026-10-11'}]});
  const report=depositDecisionReport([o],[tx('1',{initialDeposit:100,depositDecision:{reasonCode:'first-order-trust'}})],'2026-10');
  expect(report.rows[0]).toMatchObject({paidLater:true,reasonCode:'first-order-trust'});
 });
 it('captures explicit cancellation reasons even when shipping was never enabled',()=>{
  const report=depositDecisionReport([order('1',{cancelled:true,cancelReasonCode:'customer-no-payment-method'}),order('2',{cancelled:true,cancelReasonCode:'customer-unreachable'})],[],'2026-10');
  expect(report.rows[0]).toMatchObject({reasonCode:'no-payment-method',cancelled:true,everEnabled:false,shipped:false});
  expect(report.rows[1].reasonCode).toBe('no-objection-recorded');
 });
});
