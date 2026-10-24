import { Types } from 'mongoose';
import { trackingMongo } from '../helpers/tracking-mongo';
import { InventoryUnitsService } from '../../src/inventory-units/inventory-units.service';
import { InventoryPacksService } from '../../src/inventory-units/inventory-packs.service';
import { UnitManualCodesService } from '../../src/inventory-units/unit-manual-codes.service';
import { InventoryUnitSchema } from '../../src/inventory-units/schemas/inventory-unit.schema';
import { InventoryUnitEventSchema } from '../../src/inventory-units/schemas/inventory-unit-event.schema';
import { InventoryUnitOperationSchema } from '../../src/inventory-units/schemas/inventory-unit-operation.schema';
import { migrateInventoryUnitIndexes } from '../../src/inventory-units/inventory-unit-index.migration';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { TransactionSchema } from '../../src/transactions/schemas/transaction.schema';
import { InventoryUnitsController } from '../../src/inventory-units/inventory-units.controller';
import { InventoryScanningService } from '../../src/inventory-units/inventory-scanning.service';

describe('Sealed physical packs',()=>{
  let mongo:Awaited<ReturnType<typeof trackingMongo>>,tracking:InventoryUnitsService,packs:InventoryPacksService,Unit:any;
  let actor:any,productId:string,saleId:string,unitIds:string[],pickup:any;
  const id=()=>new Types.ObjectId().toHexString();
  const req=(extra={})=>({operationKey:id(),reason:'Isolated physical pack test',...extra});
  const raw=(name:string)=>mongo.connection.collection(name);
  const create=(extra={})=>packs.create({...req(),unitIds,piecesPerPack:6,remainder:'reject',...extra} as any,actor);
  const scan=(barcode:string,extra={})=>packs.scan(saleId,{...req(),identifier:barcode,lineId:'line-1',physicalPossessionConfirmed:true,...extra} as any,actor);
  beforeAll(async()=>{
    mongo=await trackingMongo();Unit=mongo.connection.model('InventoryUnit',InventoryUnitSchema);
    const Event=mongo.connection.model('InventoryUnitEvent',InventoryUnitEventSchema),Operation=mongo.connection.model('InventoryUnitOperation',InventoryUnitOperationSchema);
    const manual=new UnitManualCodesService(mongo.connection);await manual.onModuleInit();
    tracking=new InventoryUnitsService(mongo.connection,Unit,Event,Operation,{} as any,manual);
    await migrateInventoryUnitIndexes(mongo.connection.db!,true);
    packs=new InventoryPacksService(mongo.connection,Unit,tracking);await packs.onModuleInit();
    pickup=Object.create(TransactionsService.prototype);pickup.transactionModel=mongo.connection.model('Transaction',TransactionSchema);pickup.emit=jest.fn();
  },40000);
  beforeEach(async()=>{
    for(const name of ['users','products','transactions','inventorypacks','inventoryunits','inventoryunitevents','inventoryunitoperations'])await raw(name).deleteMany({});
    actor={userId:id(),role:'admin'};productId=id();saleId=id();
    await raw('users').insertOne({_id:new Types.ObjectId(actor.userId),name:'Pack operator'});
    await raw('products').insertOne({_id:new Types.ObjectId(productId),code:'PACK-TEST',name:'Six-piece product',sellPrice:10,stock:24});
    await raw('transactions').insertOne({_id:new Types.ObjectId(saleId),type:'مبيعات',warehouseCode:'MAIN',pickupStatus:'Preparing',prepChecked:false,items:[{lineId:'line-1',code:'PACK-TEST',qty:6}],total:60});
    const units=await Unit.create(Array.from({length:24},()=>({productId,status:'available',warehouseCode:'MAIN',assignment:null,origin:{kind:'legacy-unknown',reconciliationRef:'isolated-pack-test'},registeredByUserId:actor.userId,registeredBy:'Pack operator'})));
    unitIds=units.map((u:any)=>String(u._id));
  });
  afterAll(async()=>{await mongo?.close();});
  it('counts sealed printed pack members once in purchase label coverage and clears their coverage when ungrouped',async()=>{
    const purchaseId=id();await raw('transactions').insertOne({_id:new Types.ObjectId(purchaseId),type:'مشتريات',ref:'PACK-PRINT',date:'2026-10-20',items:[{code:'PACK-TEST',qty:24,lineId:'purchase-1'}]});
    await raw('inventoryunits').updateMany({},{$set:{'origin.kind':'purchase','origin.purchaseTransactionId':purchaseId,'origin.purchaseLineId':'purchase-1'}});
    const receipt=async()=> (await tracking.purchaseReceipts()).find(row=>row.transactionId===purchaseId)!.lines[0];
    const created=await create();
    await packs.labels({...req(),packIds:[created.packs[0]._id],sizeId:'50x25'},actor);
    expect((await receipt()).printedUnits).toBe(0);
    const firstPrint={...req(),packIds:[created.packs[0]._id],sizeId:'50x25'};
    await packs.labels(firstPrint,actor,true);await packs.labels(firstPrint,actor,true);
    expect((await receipt()).printedUnits).toBe(6);
    await packs.labels({...req(),packIds:[created.packs[0]._id],sizeId:'50x25'},actor,true);
    expect((await receipt()).printedUnits).toBe(6);
    await packs.labels({...req(),packIds:created.packs.slice(1).map((pack:any)=>pack._id),sizeId:'50x25'},actor,true);
    expect((await receipt()).printedUnits).toBe(24);
    await packs.open(created.packs[0].barcode,req(),actor);
    expect((await receipt()).printedUnits).toBe(18);
    expect(await raw('inventoryunitevents').countDocuments({action:{$in:['label-print-requested','label-reprint-requested']}})).toBe(0);
  });
  it('prints the source purchase invoice date for piece and pack labels',async()=>{
    const purchaseId=id();await raw('transactions').insertOne({_id:new Types.ObjectId(purchaseId),type:'مشتريات',ref:'INV-20',date:'2026-10-20',createdAt:new Date('2026-10-21'),items:[{code:'PACK-TEST',qty:24,lineId:'purchase-1'}]});
    await raw('inventoryunits').updateMany({},{$set:{'origin.kind':'purchase','origin.purchaseTransactionId':purchaseId,'origin.purchaseLineId':'purchase-1'}});
    const single=await tracking.preview({...req(),unitIds:[unitIds[0]],sizeId:'50x25'} as any);
    expect(single.labels[0].invoiceDate).toBe('2026-10-20');
    const created=await create();
    const batch=await packs.labels({...req(),packIds:[created.packs[0]._id],sizeId:'50x25'},actor);
    expect(batch.labels[0].invoiceDate).toBe('2026-10-20');
    expect(batch.labels[0].invoiceDates).toEqual(['2026-10-20']);
  });
  it('uses stable short pack codes for lookup, printing, scanning six pieces and undo while keeping old labels valid',async()=>{
    const result=await create(),pack=result.packs[0];
    expect(pack.manualCode).toMatch(/^PK-\d{6}-\d$/);
    expect(new Set(result.packs.map((row:any)=>row.manualCode)).size).toBe(4);
    expect((await tracking.lookup(pack.manualCode)).unit.barcode).toBe(pack.barcode);
    expect((await tracking.lookup(pack.manualCode.replace(/-/g,''))).unit.manualCode).toBe(pack.manualCode);
    expect((await tracking.lookup(pack.barcode)).unit.manualCode).toBe(pack.manualCode);
    const scanner=new InventoryScanningService(mongo.connection,Unit,mongo.connection.model('InventoryUnitEvent'),mongo.connection.model('InventoryUnitOperation'),tracking);
    const validated=await scanner.validate({...req(),sessionKey:'pack-short-lookup',intent:'lookup',identifier:pack.manualCode,inputMethod:'manual-entry'} as any,actor);
    expect(validated).toMatchObject({code:'VALIDATED',unit:{isPack:true,manualCode:pack.manualCode,quantity:6}});
    const incorrect=pack.manualCode.slice(0,-1)+(Number(pack.manualCode.slice(-1))+1)%10;
    await expect(tracking.lookup(incorrect)).rejects.toThrow('verification');
    const labels=await packs.labels({...req(),packIds:[pack._id],sizeId:'50x25'},actor);
    expect(labels.labels[0]).toMatchObject({barcode:pack.barcode,manualCode:pack.manualCode,quantity:6});
    const scanned=await scan(pack.manualCode.replace(/-/g,''));
    expect(scanned.quantity).toBe(6);expect(scanned.unit.manualCode).toBe(pack.manualCode);
    expect((await tracking.pickingSummary(saleId)).lines[0].units.every((unit:any)=>unit.packManualCode===pack.manualCode)).toBe(true);
    await packs.undoScan(pack.manualCode,req(),actor);
    expect((await tracking.pickingSummary(saleId)).lines[0].units).toHaveLength(0);
    await packs.open(pack.manualCode,req(),actor);
    expect((await tracking.lookup(pack.barcode)).unit.status).toBe('opened');
  });
  it('assigns short codes to existing packs without changing their original QR identity',async()=>{
    const created=await create(),pack=created.packs[0];
    await raw('inventorypacks').updateOne({_id:new Types.ObjectId(pack._id)},{$unset:{manualCode:''}});
    const first:any=(await packs.list({})).packs.find((row:any)=>String(row._id)===pack._id)!;
    expect(first.manualCode).toMatch(/^PK-\d{6}-\d$/);expect(first.barcode).toBe(pack.barcode);
    expect((await tracking.lookup(pack.barcode)).unit.manualCode).toBe(first.manualCode);
    expect((await packs.list({q:first.manualCode})).total).toBe(1);
  });
  it('24 pieces create 4 unique six-piece labels, without changing stock, and retry returns the same packs',async()=>{
    const dto={...req(),unitIds,piecesPerPack:6,remainder:'reject'};
    const result=await packs.create(dto,actor);
    expect(result.packs).toHaveLength(4);expect(new Set(result.packs.map((p:any)=>p.barcode)).size).toBe(4);
    expect(result.packs.every((p:any)=>p.quantity===6&&p.unitIds.length===6)).toBe(true);
    expect((await packs.create(dto,actor)).packs.map((p:any)=>p.barcode)).toEqual(result.packs.map((p:any)=>p.barcode));
    expect(await Unit.countDocuments({status:'available',packId:{$ne:null}})).toBe(24);
    expect((await raw('products').findOne({_id:new Types.ObjectId(productId)}))!.stock).toBe(24);
    const labels=await packs.labels({...req(),packIds:result.packs.map((p:any)=>p._id),sizeId:'50x25'},actor);
    expect(labels.labels).toHaveLength(4);expect(labels.labels.every((l:any)=>l.isPack&&l.quantity===6&&l.svg.includes('<svg'))).toBe(true);
    const printed=await packs.labels({...req(),packIds:[result.packs[0]._id],sizeId:'50x25'},actor,true);
    const reprinted=await packs.labels({...req(),packIds:[result.packs[0]._id],sizeId:'50x25'},actor,true);
    expect(printed.labels[0].barcode).toBe(reprinted.labels[0].barcode);expect(reprinted.labels[0].printCount).toBe(2);
    expect(await raw('inventorypacks').countDocuments()).toBe(4);
  });
  it('requires explicit remainder handling and preserves inspection status',async()=>{
    await expect(create({unitIds:unitIds.slice(0,23)})).rejects.toThrow('remainder');
    await raw('inventoryunits').updateOne({_id:new Types.ObjectId(unitIds[0])},{$set:{status:'inspection-required'}});
    const result=await create({unitIds:unitIds.slice(1),remainder:'leave-single'});
    expect(result.packs).toHaveLength(3);expect(result.singleUnitIds).toHaveLength(5);
    expect((await Unit.findById(unitIds[0])).status).toBe('inspection-required');
  });
  it('serializes two attempts to group the same pieces',async()=>{
    const outcomes=await Promise.allSettled([create(),create()]);
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await raw('inventorypacks').countDocuments()).toBe(4);
  });
  it('atomically scans six pieces, prevents duplicate and single-member scans, and undoes all six',async()=>{
    const result=await create(),pack=result.packs[0],member=await Unit.findById(pack.unitIds[0]);
    await expect(tracking.pickScan(saleId,{...req(),identifier:member.barcode,lineId:'line-1',physicalPossessionConfirmed:true},actor)).rejects.toThrow('sealed pack');
    const scanned=await scan(pack.barcode);expect(scanned.quantity).toBe(6);expect(scanned.units).toHaveLength(6);
    expect((await tracking.pickingSummary(saleId)).lines[0].units).toHaveLength(6);
    expect((await tracking.lookup(pack.barcode)).assignmentOrder?.transactionId).toBe(saleId);
    await expect(scan(pack.barcode)).rejects.toThrow('already scanned');
    await packs.undoScan(pack.barcode,req(),actor);expect(await Unit.countDocuments({status:'picking'})).toBe(0);
    await expect(scan(pack.barcode)).resolves.toMatchObject({quantity:6});
  });
  it('recognizes scanner prefixes and lowercase pack codes through the ordinary piece-scanning endpoint',async()=>{
    const {packs:created}=await create(),pack=created[0];
    const identifier=']Q3'+pack.barcode.toLowerCase();
    expect((await tracking.lookup(identifier)).unit).toMatchObject({isPack:true,quantity:6,status:'available'});
    const controller=new InventoryUnitsController(tracking,{} as any,{} as any,packs);
    const result=await controller.pickScan(saleId,{...req(),identifier,lineId:'line-1',physicalPossessionConfirmed:true},{user:actor});
    expect(result).toMatchObject({isPack:true,quantity:6});
    expect((await tracking.pickingSummary(saleId)).lines[0].units).toHaveLength(6);
    expect(await Unit.countDocuments({packId:pack._id,status:'picking','assignment.transactionId':saleId})).toBe(6);
  });
  it('undoes an approved prepared pack atomically, reopens approval, and allows scanning it again',async()=>{
    const {packs:created}=await create(),pack=created[0];await scan(pack.barcode);
    for(const unit of await Unit.find({packId:pack._id}))await tracking.action(unit.barcode,{...req(),action:'prepare',expectedVersion:unit.__v,transactionId:saleId,lineId:'line-1',physicalPossessionConfirmed:true},actor);
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{prepChecked:true}});
    await packs.undoScan(pack.barcode,req(),actor);
    expect(await Unit.countDocuments({packId:pack._id,status:'available',assignment:null})).toBe(6);
    expect((await tracking.pickingSummary(saleId))).toMatchObject({prepChecked:false,lines:[{units:[]}]});
    expect((await raw('transactions').findOne({_id:new Types.ObjectId(saleId)}))!.pickupHistory).toHaveLength(1);
    await expect(scan(pack.barcode)).resolves.toMatchObject({quantity:6});
  });
  it('undoes an already prepared single piece even when approval was previously removed',async()=>{
    const unit=await Unit.findById(unitIds[0]);
    const picked=await tracking.pickScan(saleId,{...req(),identifier:unit.barcode,lineId:'line-1',physicalPossessionConfirmed:true},actor);
    await tracking.action(unit.barcode,{...req(),action:'prepare',expectedVersion:picked.unit.version,transactionId:saleId,lineId:'line-1',physicalPossessionConfirmed:true},actor);
    const current=await Unit.findById(unit._id);
    await tracking.action(unit.barcode,{...req(),action:'undo-picking',expectedVersion:current.__v,transactionId:saleId,lineId:'line-1'},actor);
    expect((await Unit.findById(unit._id)).toObject()).toMatchObject({status:'available',assignment:null});
    await expect(tracking.pickScan(saleId,{...req(),identifier:unit.barcode,lineId:'line-1',physicalPossessionConfirmed:true},actor)).resolves.toMatchObject({outcome:'accepted'});
  });
  it('does not undo a dispatched prepared pack or clear its approval',async()=>{
    const {packs:created}=await create(),pack=created[0];await scan(pack.barcode);
    for(const unit of await Unit.find({packId:pack._id}))await tracking.action(unit.barcode,{...req(),action:'prepare',expectedVersion:unit.__v,transactionId:saleId,lineId:'line-1',physicalPossessionConfirmed:true},actor);
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{prepChecked:true,shippedAt:'2026-10-20'}});
    await expect(packs.undoScan(pack.barcode,req(),actor)).rejects.toThrow();
    expect(await Unit.countDocuments({packId:pack._id,status:'prepared'})).toBe(6);
    expect((await raw('transactions').findOne({_id:new Types.ObjectId(saleId)}))!.prepChecked).toBe(true);
  });
  it('rolls back every member when the order needs fewer than six pieces',async()=>{
    const result=await create();await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{'items.0.qty':5}});
    await expect(scan(result.packs[0].barcode)).rejects.toThrow('full quantity');
    expect(await Unit.countDocuments({status:'picking'})).toBe(0);expect(await raw('inventoryunitevents').countDocuments()).toBe(0);
  });
  it('rejects wrong SKU and unavailable members without partial allocation',async()=>{
    const result=await create(),pack=result.packs[0];
    await raw('inventoryunits').updateOne({_id:new Types.ObjectId(pack.unitIds[0])},{$set:{status:'inspection-required'}});
    await expect(scan(pack.barcode)).rejects.toThrow('unavailable');
    await raw('inventoryunits').updateOne({_id:new Types.ObjectId(pack.unitIds[0])},{$set:{status:'available'}});
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{'items.0.code':'WRONG-SKU'}});
    await expect(scan(pack.barcode)).rejects.toThrow();expect(await Unit.countDocuments({status:'picking'})).toBe(0);
  });
  it('opening invalidates the old pack code and allows its original unit barcodes',async()=>{
    const result=await create(),pack=result.packs[0];await packs.open(pack.barcode,req(),actor);
    expect((await tracking.lookup(pack.barcode)).unit.status).toBe('opened');
    await expect(scan(pack.barcode)).rejects.toThrow('open or unknown');
    await expect(packs.labels({...req(),packIds:[pack._id],sizeId:'50x25'},actor)).rejects.toThrow('opened pack');
    const member=await Unit.findById(pack.unitIds[0]);expect(member.packId).toBeNull();
    await expect(tracking.pickScan(saleId,{...req(),identifier:member.barcode,lineId:'line-1',physicalPossessionConfirmed:true},actor)).resolves.toMatchObject({outcome:'accepted'});
    expect(await Unit.countDocuments({})).toBe(24);
  });
  it('rejects mixed products, warehouses and unauthorized grouping',async()=>{
    await raw('inventoryunits').updateOne({_id:new Types.ObjectId(unitIds[0])},{$set:{warehouseCode:'OTHER'}});await expect(create()).rejects.toThrow('same product and warehouse');
    await raw('inventoryunits').updateOne({_id:new Types.ObjectId(unitIds[0])},{$set:{warehouseCode:'MAIN',productId:id()}});await expect(create()).rejects.toThrow('same product and warehouse');
    await expect(packs.create({...req(),unitIds,piecesPerPack:6,remainder:'reject'},{...actor,role:'staff',perms:[]})).rejects.toThrow('Permission');
  });
  it('returning to Pending resets all scans, prepared pieces and skips, then permits the whole pack again',async()=>{
    const {packs:created}=await create(),pack=created[0];
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{'items.0.qty':7}});
    await scan(pack.barcode);
    await tracking.pickException(saleId,{...req(),lineId:'line-1',action:'skip'},actor);
    for(const unit of await Unit.find({packId:pack._id}))await tracking.action(unit.barcode,{...req(),action:'prepare',expectedVersion:unit.__v,transactionId:saleId,lineId:'line-1',physicalPossessionConfirmed:true},actor);
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{pickupStatus:'Ready',prepChecked:true,pickupRef:'TEST-RUN'}});
    expect((await tracking.invoiceIdentities(saleId)).lines[0].current).toHaveLength(6);
    expect(await pickup.undoPickup([saleId],'Pack operator',actor.userId,'TEST-RUN')).toEqual({updated:1});
    expect((await tracking.invoiceIdentities(saleId)).lines[0]).toMatchObject({sku:'PACK-TEST',current:[],history:[]});
    const summary=await tracking.pickingSummary(saleId);
    expect(summary).toMatchObject({prepChecked:false,lines:[{units:[],skippedCount:0}]});
    expect(await Unit.countDocuments({packId:pack._id,status:'available',assignment:null})).toBe(6);
    expect((await raw('inventorypacks').findOne({_id:new Types.ObjectId(pack._id)}))!.state).toBe('sealed');
    expect(await raw('inventoryunitevents').countDocuments({transactionId:saleId,action:'picking-undone','details.pickupReset':true})).toBe(6);
    const sale:any=await raw('transactions').findOne({_id:new Types.ObjectId(saleId)});
    expect(sale).toMatchObject({pickupStatus:'Pending',prepChecked:false,pickupRef:null,pickingExceptions:[{active:false}]});
    expect((await raw('products').findOne({_id:new Types.ObjectId(productId)}))!.stock).toBe(24);
    await expect(scan(pack.barcode)).rejects.toThrow('Live sale required');
    expect(await pickup.undoPickup([saleId],'Pack operator',actor.userId)).toEqual({updated:0});
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{pickupStatus:'Preparing'}});
    await expect(scan(pack.barcode)).resolves.toMatchObject({quantity:6});
  });
  it('returns Ready orders directly to Preparing while preserving every scanned identity and preparation state',async()=>{
    const {packs:created}=await create();await scan(created[0].barcode);
    for (const unit of await Unit.find({'assignment.transactionId':saleId})) {
      unit.status='prepared';await unit.save();
    }
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{pickupStatus:'Ready',pickupRef:'READY-OLD',prepChecked:true,bostaStatus:'CREATED'}});
    const unitsBefore=await Unit.find({'assignment.transactionId':saleId}).sort({_id:1}).lean();
    const eventsBefore=await raw('inventoryunitevents').countDocuments({transactionId:saleId});
    const packBefore=await raw('inventorypacks').findOne({_id:new Types.ObjectId(created[0]._id)});
    pickup.emit.mockClear();
    expect(await pickup.returnPickupToPreparing([saleId],'Pack operator',actor.userId,'PREP-RETURN',{note:'Return ticket',shipCo:'Bosta'})).toEqual({updated:1});
    const sale:any=await raw('transactions').findOne({_id:new Types.ObjectId(saleId)});
    expect(sale).toMatchObject({pickupStatus:'Preparing',pickupRef:'PREP-RETURN',prepChecked:true,prepNote:'Return ticket',prepShipCo:'Bosta',pickupDate:null});
    expect(sale.pickupHistory.at(-1)).toMatchObject({action:'preparing',pickupRef:'PREP-RETURN'});
    expect(sale.pickupHistory.at(-1).scansReset).not.toBe(true);
    expect(await Unit.find({'assignment.transactionId':saleId}).sort({_id:1}).lean()).toEqual(unitsBefore);
    expect(unitsBefore).toHaveLength(6);
    expect(await raw('inventoryunitevents').countDocuments({transactionId:saleId})).toBe(eventsBefore);
    expect(await raw('inventorypacks').findOne({_id:new Types.ObjectId(created[0]._id)})).toEqual(packBefore);
    expect((await raw('products').findOne({_id:new Types.ObjectId(productId)}))!.stock).toBe(24);
    expect(pickup.emit).toHaveBeenCalledTimes(1);
    expect(pickup.emit).toHaveBeenCalledWith('pickup:updated',expect.objectContaining({action:'preparing',pickupRef:'PREP-RETURN',preparationPreserved:true}));
    expect(pickup.emit.mock.calls[0][1].scansReset).not.toBe(true);
  });
  it('joins a selected preparation group without overwriting its metadata or scanned identities',async()=>{
    const {packs:created}=await create();await scan(created[0].barcode);
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{pickupStatus:'Ready',pickupRef:'READY-OLD',prepChecked:true}});
    const targetId=id(),meta={prepNote:'Existing group',prepShipCo:'Bosta',prepCreatedAt:'2026-10-20T09:00:00Z',prepCreatedBy:'Original owner'};
    await raw('transactions').insertOne({_id:new Types.ObjectId(targetId),type:'مبيعات',pickupStatus:'Preparing',pickupRef:'PREP-TARGET',...meta});
    const before=await tracking.invoiceIdentities(saleId);
    await pickup.returnPickupToPreparing([saleId],'Employee',actor.userId,'PREP-TARGET',{joinExisting:true,sourceRef:'READY-OLD',note:'Do not overwrite',shipCo:'Other'});
    expect((await raw('transactions').findOne({_id:new Types.ObjectId(saleId)}))!).toMatchObject({pickupStatus:'Preparing',pickupRef:'PREP-TARGET',prepChecked:true,...meta});
    expect((await tracking.invoiceIdentities(saleId)).lines[0].current).toEqual(before.lines[0].current);
  });
  it('rejects a missing selected preparation group and a stale Pending return without clearing identities',async()=>{
    const {packs:created}=await create();await scan(created[0].barcode);
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{pickupStatus:'Ready',pickupRef:'READY-OLD',prepChecked:true}});
    const before=await tracking.invoiceIdentities(saleId);
    await expect(pickup.returnPickupToPreparing([saleId],'Employee',actor.userId,'MISSING',{joinExisting:true,sourceRef:'READY-OLD'})).rejects.toMatchObject({status:409});
    await expect(pickup.undoPickup([saleId],'Employee',actor.userId,'STALE-REF')).rejects.toMatchObject({status:409});
    expect((await tracking.invoiceIdentities(saleId)).lines[0].current).toEqual(before.lines[0].current);
    expect((await raw('transactions').findOne({_id:new Types.ObjectId(saleId)}))!).toMatchObject({pickupStatus:'Ready',prepChecked:true});
  });
  it('preserves each returned order completion flag and active picking exceptions individually',async()=>{
    const otherId=id();
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{pickupStatus:'Ready',pickupRef:'READY-OLD',prepChecked:true}});
    const exceptions=[{id:'exception-1',active:true,note:'Existing physical preparation exception'}];
    await raw('transactions').insertOne({_id:new Types.ObjectId(otherId),type:'مبيعات',pickupStatus:'Ready',pickupRef:'READY-OLD',prepChecked:false,pickingExceptions:exceptions});
    await pickup.returnPickupToPreparing([saleId,otherId],'Pack operator',actor.userId,'PREP-RETURN');
    expect((await raw('transactions').findOne({_id:new Types.ObjectId(saleId)}))!.prepChecked).toBe(true);
    const other=await raw('transactions').findOne({_id:new Types.ObjectId(otherId)});
    expect(other).toMatchObject({pickupStatus:'Preparing',pickupRef:'PREP-RETURN',prepChecked:false,pickingExceptions:exceptions});
  });
  it('rejects a partially stale return group without changing any order or emitting Pending',async()=>{
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{pickupStatus:'Ready',pickupRef:'READY-OLD',bostaStatus:'CREATED'}});
    const otherId=id();await raw('transactions').insertOne({_id:new Types.ObjectId(otherId),type:'مبيعات',pickupStatus:'Ready',bostaStatus:'PICKED_UP'});
    pickup.emit.mockClear();
    await expect(pickup.returnPickupToPreparing([saleId,otherId],'Pack operator',actor.userId,'PREP-RETURN')).rejects.toThrow('awaiting courier');
    expect((await raw('transactions').findOne({_id:new Types.ObjectId(saleId)}))!.pickupStatus).toBe('Ready');
    expect(pickup.emit).not.toHaveBeenCalled();
  });
  it('allows only one of two employees to return the same ticket and records one transition',async()=>{
    const {packs:created}=await create();await scan(created[0].barcode);
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{pickupStatus:'Ready',pickupRef:'READY-OLD',prepChecked:true}});
    const unitsBefore=await Unit.find({'assignment.transactionId':saleId}).sort({_id:1}).lean();
    pickup.emit.mockClear();
    const results=await Promise.allSettled([
      pickup.returnPickupToPreparing([saleId],'Employee A',actor.userId,'PREP-A',{sourceRef:'READY-OLD'}),
      pickup.returnPickupToPreparing([saleId],'Employee B',actor.userId,'PREP-B',{sourceRef:'READY-OLD'}),
    ]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const rejected=results.find(result=>result.status==='rejected') as PromiseRejectedResult;
    expect(rejected.reason.getStatus()).toBe(409);
    const sale:any=await raw('transactions').findOne({_id:new Types.ObjectId(saleId)});
    expect(['PREP-A','PREP-B']).toContain(sale.pickupRef);
    expect(sale).toMatchObject({pickupStatus:'Preparing',prepChecked:true});
    expect(sale.pickupHistory.filter(entry=>entry.action==='preparing')).toHaveLength(1);
    expect(pickup.emit).toHaveBeenCalledTimes(1);
    expect(await Unit.find({'assignment.transactionId':saleId}).sort({_id:1}).lean()).toEqual(unitsBefore);
    await expect(pickup.returnPickupToPreparing([saleId],'Employee A',actor.userId,'PREP-RETRY',{sourceRef:'READY-OLD'})).rejects.toMatchObject({status:409});
    expect(pickup.emit).toHaveBeenCalledTimes(1);
  });
  it('rejects a stale return after another employee transfers the order to a different Ready ticket',async()=>{
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{pickupStatus:'Ready',pickupRef:'READY-NEW',prepChecked:true}});
    pickup.emit.mockClear();
    await expect(pickup.returnPickupToPreparing([saleId],'Employee',actor.userId,'PREP-RETURN',{sourceRef:'READY-OLD'})).rejects.toMatchObject({status:409});
    expect((await raw('transactions').findOne({_id:new Types.ObjectId(saleId)}))!).toMatchObject({pickupStatus:'Ready',pickupRef:'READY-NEW',prepChecked:true});
    expect(pickup.emit).not.toHaveBeenCalled();
  });
  it('reset is atomic across orders and rejects dispatch or missing actor without discarding scans',async()=>{
    const {packs:created}=await create();await scan(created[0].barcode);
    await expect(pickup.undoPickup([saleId],'Unknown')).rejects.toThrow('Authenticated actor');
    expect(await Unit.countDocuments({status:'picking'})).toBe(6);
    const otherId=id();await raw('transactions').insertOne({_id:new Types.ObjectId(otherId),type:'مبيعات',pickupStatus:'Ready',shippedAt:'2026-10-20'});
    await expect(pickup.undoPickup([saleId,otherId],'Pack operator',actor.userId)).rejects.toThrow('شحنه');
    expect((await raw('transactions').findOne({_id:new Types.ObjectId(saleId)}))!.pickupStatus).toBe('Preparing');
    expect(await Unit.countDocuments({status:'picking'})).toBe(6);
  });
  it('clears single-piece scans while preserving allocations of another order',async()=>{
    const members=await Unit.find().sort({_id:1});
    const otherId=id();await raw('transactions').insertOne({_id:new Types.ObjectId(otherId),type:'مبيعات',warehouseCode:'MAIN',pickupStatus:'Preparing',items:[{lineId:'line-1',code:'PACK-TEST',qty:1}]});
    await tracking.pickScan(saleId,{...req(),identifier:members[0].barcode,lineId:'line-1',physicalPossessionConfirmed:true},actor);
    await tracking.pickScan(otherId,{...req(),identifier:members[1].barcode,lineId:'line-1',physicalPossessionConfirmed:true},actor);
    await pickup.undoPickup([saleId],'Pack operator',actor.userId);
    expect((await Unit.findById(members[0]._id)).toObject()).toMatchObject({status:'available',assignment:null});
    expect((await Unit.findById(members[1]._id)).toObject()).toMatchObject({status:'picking',assignment:{transactionId:otherId}});
    await raw('transactions').updateOne({_id:new Types.ObjectId(saleId)},{$set:{pickupStatus:'Preparing'}});
    await expect(tracking.pickScan(saleId,{...req(),identifier:members[0].barcode,lineId:'line-1',physicalPossessionConfirmed:true},actor)).resolves.toMatchObject({outcome:'accepted'});
  });
  it('a concurrent scan cannot leave picked units behind on a Pending order',async()=>{
    const {packs:created}=await create();
    await Promise.allSettled([scan(created[0].barcode),pickup.undoPickup([saleId],'Pack operator',actor.userId)]);
    expect((await raw('transactions').findOne({_id:new Types.ObjectId(saleId)}))!.pickupStatus).toBe('Pending');
    expect(await Unit.countDocuments({'assignment.transactionId':saleId})).toBe(0);
    expect(await Unit.countDocuments({packId:created[0]._id,status:'available'})).toBe(6);
  });
});
