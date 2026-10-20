import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { OrderAuditController } from '../../src/shopify/order-audit.controller';
import { OrderAuditService } from '../../src/shopify/order-audit.service';
import { OrderAuditExportService } from '../../src/shopify/order-audit-export.service';
import { OrderAuditMarketingService } from '../../src/shopify/order-audit-marketing.service';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';
import { PermsGuard } from '../../src/core/guards/perms.guard';

describe('Order analysis period HTTP routing', () => {
  let app: INestApplication, base: string;
  const orders = [
    { ref: '10', status: 'pending', shopifyCreatedAt: '2026-01-10T10:00:00Z' },
    { ref: '20', status: 'pending', shopifyCreatedAt: '2026-02-10T10:00:00Z' },
    { ref: '10000', status: 'pending', shopifyCreatedAt: '2026-03-10T10:00:00Z' },
  ];
  const service: any = Object.create(OrderAuditService.prototype);
  beforeAll(async () => {
    const model = (rows: any[]) => ({ find: () => ({ lean: async () => rows }) });
    service.txModel = model([]); service.shopifyOrderModel = model(orders); service.productModel = model([]);
    service.loadReviews = jest.fn(async () => new Map()); service.saveAuditLog = jest.fn(async () => {});
    const module = await Test.createTestingModule({ controllers: [OrderAuditController], providers: [
      { provide: OrderAuditService, useValue: service }, { provide: OrderAuditExportService, useValue: {} },
      { provide: OrderAuditMarketingService, useValue: new OrderAuditMarketingService({find:()=>{const q:any={sort:()=>q,skip:()=>q,limit:()=>q,select:()=>q,lean:async()=>[]};return q;}} as any, service) },
    ] }).overrideGuard(JwtAuthGuard).useValue({ canActivate: (context: any) => {context.switchToHttp().getRequest().user = {username:'test'};return true;} })
      .overrideGuard(PermsGuard).useValue({canActivate:()=>true}).compile();
    app = module.createNestApplication(); app.useLogger(false); app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true}));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  afterAll(async () => {if(app)await app.close();});
  it('routes advertising-only browsing and analysis through the report controller', async () => {
    const listing=await fetch(base+'/api/order-audit/advertising-expenses?category=rent');
    expect(listing.status).toBe(200);expect(await listing.json()).toEqual({items:[],hasMore:false,page:1});
    const response=await fetch(base+'/api/order-audit/marketing-analysis',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expenseIds:[],scopes:['pending-no-choice'],period:{fromDate:'2026-01-01',toDate:'2026-03-31',months:[1,3],year:2026}})});
    const result:any=await response.json();expect(response.status).toBe(201);expect(result.metrics.orders).toBe(2);expect(result.metrics.roas).toBeNull();
    const rejected=await fetch(base+'/api/order-audit/marketing-analysis',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expenseIds:['111111111111111111111111'],scopes:['synced'],from:1,to:2})});
    expect(rejected.status).toBe(400);
  });
  it('applies nonconsecutive months without requiring numeric order inputs', async () => {
    const response = await fetch(base + '/api/order-audit/period?fromDate=2026-01-01&toDate=2026-03-31&months=1%2C3&year=2026&persist=false');
    const data: any = await response.json();
    expect(response.status).toBe(200); expect(data.rows.map((row: any) => row.orderNumber)).toEqual(['10', '10000']);
    expect(data.period.months).toEqual([1,3]);
  });
  it('returns financial and advertising comparison through the real HTTP route',async()=>{
    const response=await fetch(base+'/api/order-audit/marketing-analysis',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expenseIds:[],scopes:['pending-no-choice'],period:{fromDate:'2026-03-01',toDate:'2026-03-31'},compare:true})});
    const result:any=await response.json();expect(response.status).toBe(201);
    expect(result.financials.orders).toBe(1);expect(result.comparison.financials.orders).toBe(1);
    expect(result.comparison.windows).toEqual([{fromDate:'2026-02-01',toDate:'2026-02-28'}]);expect(result.comparison.metrics.roas).toBeNull();
  });
  it('accepts date-only and empty periods and reports date validation errors as dates', async () => {
    const response = await fetch(base + '/api/order-audit/period?fromDate=2026-10-01&toDate=2026-10-21&persist=false');
    const data: any = await response.json(); expect(response.status).toBe(200); expect(data.rows).toEqual([]);
    const invalid = await fetch(base + '/api/order-audit/period?fromDate=bad&toDate=2026-10-21');
    const error: any = await invalid.json(); expect(invalid.status).toBe(400); expect(error.message).toContain('تاريخ');
  });
  it('retains existing numeric and date-compatible run requests', async () => {
    const numeric = await fetch(base + '/api/order-audit/run?from=10&to=20&persist=false');
    expect(numeric.status).toBe(200);
    const dates = await fetch(base + '/api/order-audit/run?fromDate=2026-01-01&toDate=2026-03-31&months=1%2C3&year=2026&persist=false');
    const data: any = await dates.json(); expect(dates.status).toBe(200); expect(data.rows).toHaveLength(2);
  });
  it('reads Bosta charges through the date report route rather than the customer tariff',async()=>{
    const previousModel=service.txModel;
    service.txModel={find:()=>({lean:async()=>[{_id:'fees-10',ref:'10',type:'مبيعات',shopifyCreatedAt:'2026-01-10T10:00:00Z',shipCost:9999,bostaOrderId:'delivery-10',items:[],total:10000}]})};
    service.carrierDetails={bostaDetails:jest.fn(async()=>({fetchedAt:'2026-10-21T10:00:00Z',wallet:{bostaFees:114.57}}))};
    try{
      const response=await fetch(base+'/api/order-audit/period?fromDate=2026-01-01&toDate=2026-01-31&persist=false');
      const result:any=await response.json();expect(response.status).toBe(200);
      expect(result.shipping.totalShippingCost).toBe(114.57);expect(result.shipping.highestOrder.cost).toBe(114.57);
      expect(service.carrierDetails.bostaDetails).toHaveBeenCalledWith('fees-10',true);
    }finally{service.txModel=previousModel;service.carrierDetails=undefined;}
  });
});
