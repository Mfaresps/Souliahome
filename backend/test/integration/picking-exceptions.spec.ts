import { Types } from 'mongoose';
import { trackingMongo } from '../helpers/tracking-mongo';
import { InventoryUnitsService } from '../../src/inventory-units/inventory-units.service';
import { UnitManualCodesService } from '../../src/inventory-units/unit-manual-codes.service';
import { InventoryUnitSchema } from '../../src/inventory-units/schemas/inventory-unit.schema';
import { InventoryUnitEventSchema } from '../../src/inventory-units/schemas/inventory-unit-event.schema';
import { InventoryUnitOperationSchema } from '../../src/inventory-units/schemas/inventory-unit-operation.schema';
import { migrateInventoryUnitIndexes } from '../../src/inventory-units/inventory-unit-index.migration';
import { TransactionSchema } from '../../src/transactions/schemas/transaction.schema';
import { TransactionsService } from '../../src/transactions/transactions.service';

describe('Persisted damaged-label picking exceptions', () => {
  let mongo: Awaited<ReturnType<typeof trackingMongo>>, service: InventoryUnitsService, Unit: any, prep: any;
  let actor: any, saleId: string, productId: string;
  const id=()=>new Types.ObjectId().toHexString();
  const request=(extra={})=>({operationKey:id(),reason:'Damaged physical label',lineId:'line-1',action:'skip',...extra});
  const raw=(name:string)=>mongo.connection.collection(name);
  beforeAll(async()=>{
    mongo=await trackingMongo(); Unit=mongo.connection.model('InventoryUnit',InventoryUnitSchema);
    const Event=mongo.connection.model('InventoryUnitEvent',InventoryUnitEventSchema),Operation=mongo.connection.model('InventoryUnitOperation',InventoryUnitOperationSchema);
    const manualCodes=new UnitManualCodesService(mongo.connection);await manualCodes.onModuleInit();
    service=new InventoryUnitsService(mongo.connection,Unit,Event,Operation,{} as any,manualCodes);
    prep=Object.create(TransactionsService.prototype);prep.transactionModel=mongo.connection.model('Transaction',TransactionSchema);
    await migrateInventoryUnitIndexes(mongo.connection.db!,true);
  },40000);
  beforeEach(async()=>{
    for(const name of ['users','products','transactions','inventoryunits','inventoryunitevents','inventoryunitoperations'])await raw(name).deleteMany({});
    actor={userId:id(),role:'admin'};saleId=id();productId=id();
    await raw('users').insertOne({_id:new Types.ObjectId(actor.userId),name:'Verified Picker'});
    await raw('products').insertOne({_id:new Types.ObjectId(productId),code:'SKU-1',name:'Product'});
    await raw('transactions').insertOne({_id:new Types.ObjectId(saleId),type:'مبيعات',warehouseCode:'MAIN',pickupStatus:'Preparing',prepChecked:false,items:[{lineId:'line-1',code:'SKU-1',qty:1}],total:100});
    await Unit.create({productId,status:'available',warehouseCode:'MAIN',assignment:null,origin:{kind:'legacy-unknown',reconciliationRef:'isolated-picking-test'},registeredByUserId:actor.userId,registeredBy:'Verified Picker'});
  });
  afterAll(async()=>{await mongo?.close();});
  it('searches purchase invoice references without including other pieces of the same product',async()=>{
    const purchaseId=id();
    await raw('transactions').insertOne({_id:new Types.ObjectId(purchaseId),type:'مشتريات',ref:'PUR-88421',items:[{code:'SKU-1',qty:1}]});
    const linked=await Unit.create({productId,status:'available',warehouseCode:'MAIN',origin:{kind:'purchase',purchaseTransactionId:purchaseId},registeredByUserId:actor.userId,registeredBy:'Verified Picker'});
    const result=await service.search({q:'#PUR-88421'});
    expect(result.total).toBe(1);expect(String(result.units[0]._id)).toBe(String(linked._id));
    expect(result.units[0].invoiceRef).toBe('PUR-88421');expect(result.invoiceMatch).toBe(true);
    expect(result.products).toEqual([expect.objectContaining({code:'SKU-1',name:'Product'})]);
    expect((await service.search({q:'88421',status:'damaged'})).total).toBe(0);
    expect((await service.search({})).units.find((unit:any)=>!unit.origin.purchaseTransactionId)?.invoiceRef).toBe('');
    await raw('inventoryunits').deleteOne({_id:linked._id});
    const noPieces=await service.search({q:'88421'});
    expect(noPieces.total).toBe(0);expect(noPieces.products).toHaveLength(1);
  });
  it('persists a distinct exception with verified actor and idempotent replay, without changing inventory',async()=>{
    const dto=request(),first=await service.pickException(saleId,dto,actor);
    expect(first).toMatchObject({skippedCount:1,barcodeMatched:false,stockChanged:false,exception:{by:'Verified Picker',quantity:1,active:true}});
    expect((await service.pickException(saleId,dto,actor)).exception.id).toBe(first.exception.id);
    expect((await service.pickingSummary(saleId)).lines[0]).toMatchObject({skippedCount:1,units:[]});
    expect(await Unit.countDocuments({status:'available',assignment:null})).toBe(1);
    expect(await raw('transactions').findOne({_id:new Types.ObjectId(saleId)})).toMatchObject({total:100});
    expect(await raw('inventoryunitoperations').countDocuments({kind:{$regex:'order-pick-exception:'}})).toBe(1);
  });
  it('records a requested batch atomically, replays safely and allows undoing one piece',async()=>{
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{'items.0.qty':6}});
    const dto=request({quantity:4});
    const first=await service.pickException(saleId,dto,actor);
    expect(first.skippedCount).toBe(4);
    expect((await service.pickException(saleId,dto,actor)).skippedCount).toBe(4);
    await expect(service.pickException(saleId,request({quantity:3}),actor)).rejects.toThrow('remaining pieces');
    expect((await service.pickingSummary(saleId)).lines[0].skippedCount).toBe(4);
    await service.pickException(saleId,request({action:'undo',exceptionId:first.exception.id}),actor);
    expect((await service.pickingSummary(saleId)).lines[0].skippedCount).toBe(3);
    await service.pickException(saleId,request({quantity:3}),actor);
    await expect(prep.assertTrackedPickupPrepared(saleId)).resolves.toEqual(expect.any(Number));
    expect(await Unit.countDocuments({status:'available',assignment:null})).toBe(1);
  });
  it.each([0,-1,1.5])('rejects invalid exception quantity %s',async(quantity)=>{
    await expect(service.pickException(saleId,request({quantity}),actor)).rejects.toThrow('positive whole');
    expect((await service.pickingSummary(saleId)).lines[0].skippedCount).toBe(0);
  });
  it('returns current custody and a minimal linked-order summary without modifying the unit',async()=>{
    const unit=await Unit.findOne();
    expect((await service.lookup(unit.barcode)).assignmentOrder).toBeNull();
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{ref:'2773',client:'Fatma Hassan',deposit:50}});
    await service.pickScan(saleId,{operationKey:id(),reason:'Physical scan',identifier:unit.barcode,lineId:'line-1',physicalPossessionConfirmed:true},actor);
    const before=await raw('inventoryunitevents').countDocuments();
    const lookup=await service.lookup(unit.barcode);
    expect(lookup.unit.status).toBe('picking');
    expect(lookup.assignmentOrder).toMatchObject({transactionId:saleId,ref:'2773',client:'Fatma Hassan',pickupStatus:'Preparing'});
    expect(lookup.assignmentOrder).not.toHaveProperty('deposit');expect(lookup.assignmentOrder).not.toHaveProperty('total');
    expect(await raw('inventoryunitevents').countDocuments()).toBe(before);
    await raw('transactions').deleteOne({_id:new Types.ObjectId(saleId)});
    expect((await service.lookup(unit.barcode)).assignmentOrder).toBeNull();
  });
  it('includes only recorded exceptions in readiness and allows undo then a real scan',async()=>{
    await expect(prep.assertTrackedPickupPrepared(saleId)).rejects.toThrow('Scan and prepare');
    const first=await service.pickException(saleId,request(),actor);
    await expect(prep.assertTrackedPickupPrepared(saleId)).resolves.toEqual(expect.any(Number));
    const unit=await Unit.findOne();
    await expect(service.pickScan(saleId,{operationKey:id(),reason:'Physical scan',identifier:unit.barcode,lineId:'line-1',physicalPossessionConfirmed:true},actor)).rejects.toThrow('full quantity');
    await service.pickException(saleId,request({action:'undo',exceptionId:first.exception.id}),actor);
    await expect(prep.assertTrackedPickupPrepared(saleId)).rejects.toThrow('Scan and prepare');
    expect((await raw('transactions').findOne({_id:new Types.ObjectId(saleId)}))!.pickingExceptions[0]).toMatchObject({active:false,undoneBy:'Verified Picker'});
    await service.pickScan(saleId,{operationKey:id(),reason:'Physical scan',identifier:unit.barcode,lineId:'line-1',physicalPossessionConfirmed:true},actor);
    await expect(service.pickException(saleId,request(),actor)).rejects.toThrow('full quantity');
  });
  it('rejects unauthorized, wrong-line and completed-order skips',async()=>{
    await expect(service.pickException(saleId,request(),{...actor,role:'staff',perms:[]})).rejects.toThrow('Permission');
    await expect(service.pickException(saleId,request({lineId:'unknown'}),actor)).rejects.toThrow('Exact live sale line');
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{prepChecked:true}});
    await expect(service.pickException(saleId,request(),actor)).rejects.toThrow('awaiting preparation');
  });
  it('serializes concurrent skips and rejects excess quantity',async()=>{
    const outcomes=await Promise.allSettled([service.pickException(saleId,request(),actor),service.pickException(saleId,request(),actor)]);
    expect(outcomes.filter(row=>row.status==='fulfilled')).toHaveLength(1);
    expect((await service.pickingSummary(saleId)).lines[0].skippedCount).toBe(1);
    await expect(service.pickException(saleId,request(),actor)).rejects.toThrow('full quantity');
  });
  it('does not apply an exception to an edited SKU',async()=>{
    await service.pickException(saleId,request(),actor);
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{'items.0.code':'SKU-2'}});
    expect((await service.pickingSummary(saleId)).lines[0].skippedCount).toBe(0);
  });
  it('requires the remaining scanned unit to be prepared when one of two pieces was skipped',async()=>{
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{'items.0.qty':2}});
    const unit=await Unit.findOne();
    const scanned=await service.pickScan(saleId,{operationKey:id(),reason:'Physical scan',identifier:unit.barcode,lineId:'line-1',physicalPossessionConfirmed:true},actor);
    await service.pickException(saleId,request(),actor);
    await expect(prep.assertTrackedPickupPrepared(saleId)).rejects.toThrow('Scan and prepare');
    await service.action(scanned.unit.unitId,{operationKey:id(),reason:'Prepare scanned unit',action:'prepare',expectedVersion:scanned.unit.version,transactionId:saleId,lineId:'line-1',physicalPossessionConfirmed:true,evidenceReference:'isolated-scan'},actor);
    await expect(prep.assertTrackedPickupPrepared(saleId)).resolves.toEqual(expect.any(Number));
    const summary=await service.pickingSummary(saleId);
    expect(summary.lines[0]).toMatchObject({skippedCount:1,units:[{status:'prepared'}]});
  });
  it('blocks preparation when there are no registered identities, including an unmapped product',async()=>{
    await raw('inventoryunits').deleteMany({});
    await expect(prep.assertTrackedPickupPrepared(saleId)).rejects.toThrow('coverage is incomplete');
    await raw('products').deleteMany({});
    await expect(prep.assertTrackedPickupPrepared(saleId)).rejects.toThrow('every piece');
    await expect(prep.setPrepChecked(saleId,true,'Picker')).rejects.toThrow('every piece');
    expect((await raw('transactions').findOne({_id:new Types.ObjectId(saleId)}))!.prepChecked).toBe(false);
    await service.pickException(saleId,request(),actor);
    await expect(prep.assertTrackedPickupPrepared(saleId)).resolves.toEqual(expect.any(Number));
  });
  it('atomically reopens an approved preparation when undoing a skip, then permits scanning again',async()=>{
    const skipped=await service.pickException(saleId,request(),actor);
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{prepChecked:true}});
    const undo=request({action:'undo',exceptionId:skipped.exception.id});
    const result=await service.pickException(saleId,undo,actor);
    expect(result).toMatchObject({skippedCount:0,prepChecked:false,reopenedPreparation:true});
    const sale:any=await raw('transactions').findOne({_id:new Types.ObjectId(saleId)});
    expect(sale.prepChecked).toBe(false);
    expect(sale.pickupHistory).toEqual([expect.objectContaining({action:'prep-check-undo',by:'Verified Picker',prepChecked:false})]);
    await service.pickException(saleId,undo,actor);
    expect((await raw('transactions').findOne({_id:new Types.ObjectId(saleId)}))!.pickupHistory).toHaveLength(1);
    const unit=await Unit.findOne();
    await expect(service.pickScan(saleId,{operationKey:id(),reason:'Rescan after undo',identifier:unit.barcode,lineId:'line-1',physicalPossessionConfirmed:true},actor)).resolves.toMatchObject({outcome:'accepted'});
  });
  it.each([{pickupStatus:'Ready'},{pickupStatus:'Shipped'},{shippedAt:'2026-10-19'},{cancelled:true}])('does not reopen a closed or dispatched order: %j',async(change)=>{
    const skipped=await service.pickException(saleId,request(),actor);
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{prepChecked:true,...change}});
    await expect(service.pickException(saleId,request({action:'undo',exceptionId:skipped.exception.id}),actor)).rejects.toThrow();
    const sale:any=await raw('transactions').findOne({_id:new Types.ObjectId(saleId)});
    expect(sale.prepChecked).toBe(true);expect(sale.pickingExceptions[0].active).toBe(true);
  });
});
