import mongoose, { Connection, Model } from 'mongoose';
jest.mock('../../src/transactions/transactions.service', () => ({TransactionsService:class {}}));
import { PurchaseOrdersService } from '../../src/purchase-orders/purchase-orders.service';
import { PurchaseOrderSchema } from '../../src/purchase-orders/schemas/purchase-order.schema';

const prefix=`PO-${new Date().getFullYear()}-`;
const dto={supplierId:'supplier-1',supplierName:'Supplier',createdBy:'Tester',items:[{productCode:'10',productName:'Basket',qty:2,unitPrice:20}]};
let connection:Connection, model:Model<any>, service:PurchaseOrdersService;
beforeAll(async()=>{
  // Generated scratch database only; never points at the application's live data.
  connection=await mongoose.createConnection(`mongodb://localhost:27017/soulia_test_purchase_orders_${process.pid}_${Date.now()}`,{serverSelectionTimeoutMS:3000}).asPromise();
  model=connection.model('PurchaseOrder',PurchaseOrderSchema);
  await model.init();
  service=new PurchaseOrdersService(model as any,{} as any);
});
beforeEach(async()=>{await model.deleteMany({});});
afterAll(async()=>{if(connection){await connection.dropDatabase();await connection.close();}});

describe('purchase order numbering in real Mongo',()=>{
  it('uses the highest number after deletion gaps rather than document count',async()=>{
    await model.create({...dto,poNumber:prefix+'001',createdDate:'2026-10-11'});
    const deleted=await model.create({...dto,poNumber:prefix+'002',createdDate:'2026-10-11'});
    await model.create({...dto,poNumber:prefix+'003',createdDate:'2026-10-11'});
    await model.deleteOne({_id:deleted._id});
    expect((await service.create(dto)).poNumber).toBe(prefix+'004');
  });
  it('compares suffixes numerically past 999 and ignores malformed numbers',async()=>{
    for(const suffix of ['999','1000','manual'])await model.create({...dto,poNumber:prefix+suffix,createdDate:'2026-10-11'});
    expect((await service.create(dto)).poNumber).toBe(prefix+'1001');
  });
  it('creates 20 orders concurrently with unique numbers and intact item totals',async()=>{
    const result=await Promise.all(Array.from({length:20},()=>service.create(dto)));
    expect(new Set(result.map(r=>r.poNumber)).size).toBe(20);
    expect(await model.countDocuments()).toBe(20);
    expect(result.every(r=>r.items[0].total===40)).toBe(true);
  });
  it('does not retry or hide an unrelated duplicate-key error',async()=>{
    const error=Object.assign(new Error('different index'),{code:11000,keyPattern:{differentField:1}});
    const spy=jest.spyOn(model,'create').mockRejectedValueOnce(error);
    try{await expect(service.create(dto)).rejects.toBe(error);expect(spy).toHaveBeenCalledTimes(1);}finally{spy.mockRestore();}
  });
});
