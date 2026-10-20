import { OrderAuditService } from '../../src/shopify/order-audit.service';
import { auditShippingCharge } from '../../src/shopify/order-audit-shipping.util';
import { OrderAuditExportService } from '../../src/shopify/order-audit-export.service';
import * as ExcelJS from 'exceljs';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const model=(rows:any[])=>({find:jest.fn(()=>({lean:async()=>rows}))});
function service(transactions:any[],live?:any) {
  const s:any=Object.create(OrderAuditService.prototype);
  s.txModel=model(transactions);s.productModel=model([{code:'p',buyPrice:100}]);s.shopifyOrderModel=model([]);
  s.loadReviews=jest.fn(async()=>new Map());s.saveAuditLog=jest.fn(async()=>{});s.carrierDetails=live;
  return s as OrderAuditService;
}
const tx=(ref:string,extra:any={})=>({_id:ref,ref,type:'مبيعات',items:[{code:'p',price:1000,qty:1}],total:1100,shipCost:100,carrierCode:'bosta',bostaOrderId:'b-'+ref,...extra});
it('uses Bosta wallet deductions before quoted or manually entered shipping and preserves explicit zero',()=>{
  expect(auditShippingCharge(tx('1',{actualShipCost:999}),{fetchedAt:'2026-10-21',wallet:{bostaFees:114.57},logFees:{priceAfterVat:80}})).toMatchObject({amount:114.57,source:'bosta-wallet'});
  expect(auditShippingCharge(tx('1'),{wallet:{bostaFees:0},logFees:{priceAfterVat:80}}).amount).toBe(0);
  expect(auditShippingCharge(tx('1',{bostaRawResponse:{data:{wallet:{cashCycle:{bosta_fees:120}}}}}),{logFees:{priceAfterVat:80}}).amount).toBe(120);
  expect(auditShippingCharge(tx('1',{actualShipCost:999,shipCost:300}))).toMatchObject({amount:null,source:'unconfirmed'});
});
it('does not substitute customer tariffs for actual costs and keeps carrier sources distinct',()=>{
  expect(auditShippingCharge(tx('1'),{logFees:{priceAfterVat:128.25}})).toMatchObject({amount:128.25,source:'bosta-pricing'});
  expect(auditShippingCharge({carrierCode:'jt-express',actualShipCost:112.34,shipCost:200})).toMatchObject({amount:112.34,source:'recorded-actual'});
  expect(auditShippingCharge({carrierCode:'jt-express',shipCost:200}).amount).toBeNull();
});
it('totals only verified actual charges, chooses the real maximum and averages only known orders',async()=>{
  const bostaDetails=jest.fn(async id=>({fetchedAt:'2026-10-21T10:00:00Z',wallet:{bostaFees:id==='1'?114.57:id==='2'?130.22:0}}));
  const s=service([tx('1',{shipCost:900}),tx('2',{shipCost:110}),tx('3',{shipCost:100}),tx('4',{bostaOrderId:'',shipCost:1200}),tx('5',{cancelled:true})],{bostaDetails});
  const result=await s.runAudit(1,5,{persist:false,shippingLive:true});
  expect(result.shipping).toMatchObject({totalShippingCost:244.79,avgShippingCost:81.6,measuredCount:3,unconfirmedCount:1,bostaMeasuredCount:3,highestOrder:{orderNumber:'2',cost:130.22}});
  expect(result.financials.totalShippingCost).toBe(244.79);
  expect(result.rows[0].netProfit).toBeCloseTo(1685.43);
  expect(bostaDetails).toHaveBeenCalledTimes(3);
  await s.runAudit(1,5,{persist:false,shippingLive:true});expect(bostaDetails).toHaveBeenCalledTimes(3);
});
it('keeps reports available on Bosta failure and reuses only verified charges',async()=>{
  const s=service([tx('1',{shipCost:900,bostaRawResponse:{wallet:{cashCycle:{bosta_fees:114.57}}}}),tx('2',{shipCost:800})],{bostaDetails:jest.fn(async()=>{throw Error('offline')})});
  const result=await s.runAudit(1,2,{persist:false,shippingLive:true});
  expect(result.shipping).toMatchObject({totalShippingCost:114.57,measuredCount:1,unconfirmedCount:1,liveFailedCount:2,highestOrder:{orderNumber:'1',cost:114.57}});
});
it('never presents unconfirmed shipping as a real zero or a highest-cost order',async()=>{
  const result=await service([tx('1',{shipCost:9999,actualShipCost:900})]).runAudit(1,1,{persist:false});
  expect(result.shipping).toMatchObject({totalShippingCost:0,measuredCount:0,unconfirmedCount:1,highestOrder:null,companies:[]});
});
it('exports the same actual shipping charge and decimal precision as the report',async()=>{
  const report=await service([tx('1',{shipCost:9999,bostaRawResponse:{wallet:{cashCycle:{bosta_fees:114.57}}}})]).runAudit(1,1,{persist:false});
  const buffer=await new OrderAuditExportService().buildExcel(report),workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const shipping=workbook.getWorksheet('تحليل الشحن')!;
  expect(shipping.getRow(2).getCell(3).value).toBe(114.57);expect(shipping.getRow(2).getCell(3).numFmt).toBe('#,##0.00');
  expect(workbook.getWorksheet('تفاصيل الأوردرات')!.getRow(2).getCell(10).value).toBe(114.57);
  expect(workbook.getWorksheet('تفاصيل الأوردرات')!.getRow(2).getCell(10).numFmt).toBe('#,##0.00');
});
it('renders actual coverage and source, and refuses legacy tariff-based shipping summaries',()=>{
  const html=readFileSync(resolve(__dirname,'../../../frontend/public/index.html'),'utf8'),start=html.indexOf('function renderAuditShipping('),code=html.slice(start,html.indexOf('\n}',start)+2),el={innerHTML:''};
  const context:any={qs:()=>el,esc:String,fmtJ:(value:number)=>String(value),fmtNum:String};runInNewContext(code,context);
  context.renderAuditShipping({shipping:{source:'carrier-actual-v1',totalShippingCost:114.57,avgShippingCost:114.57,measuredCount:1,unconfirmedCount:2,companies:[],highestOrder:{orderNumber:'1',cost:114.57}},rows:[{orderNumber:'1',actualShippingSource:'bosta-wallet',bostaTrackingNumber:'123456'}]});
  expect(el.innerHTML).toContain('114.57');expect(el.innerHTML).toContain('2 بدون تكلفة مؤكدة');expect(el.innerHTML).toContain('مستحقات بوسطة من المحفظة');
  context.renderAuditShipping({shipping:{totalShippingCost:9999},rows:[]});expect(el.innerHTML).not.toContain('9999');expect(el.innerHTML).toContain('أعد عرض التحليل');
});
