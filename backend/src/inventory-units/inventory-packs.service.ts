import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import * as QRCode from 'qrcode';
import { InventoryUnit } from './schemas/inventory-unit.schema';
import { InventoryUnitsService, TrackingActor } from './inventory-units.service';
import { CreatePacksDto, PackLabelsDto, OrderPickScanDto, TrackingRequestDto } from './inventory-unit.dto';
import { LABEL_SIZES, OBJECT_ID_PATTERN } from './inventory-unit.constants';
import { warehouseCode } from '../warehouses/warehouse-storage';
import { initPackCodes, manualPackCode, nextPackCode, normalizePackCode, packCodeFilter } from './pack-manual-codes';

@Injectable()
export class InventoryPacksService implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection:Connection,
    @InjectModel(InventoryUnit.name) private readonly units:Model<any>, private readonly tracking:InventoryUnitsService) {}
  private packs(){return this.connection.collection('inventorypacks');}
  async onModuleInit(){
    await initPackCodes(this.connection);
    await this.packs().createIndex({barcode:1},{unique:true,name:'inventory_pack_barcode_unique'});
    await this.packs().createIndex({unitIds:1},{unique:true,partialFilterExpression:{state:'sealed'},name:'inventory_pack_active_members_unique'});
  }
  private id(value:string){if(!OBJECT_ID_PATTERN.test(String(value)))throw new BadRequestException('Invalid pack ID');return new Types.ObjectId(value);}
  private packStatus(pack:any,members:any[],orders:Map<string,any>){
    if(pack.state!=='sealed')return {availabilityStatus:'opened',statusCounts:[],assignedOrders:[]};
    if(members.length!==pack.quantity||members.some(unit=>String(unit.packId)!==String(pack._id)||unit.productId!==pack.productId||warehouseCode(unit.warehouseCode)!==warehouseCode(pack.warehouseCode)))
      return {availabilityStatus:'incomplete',statusCounts:[],assignedOrders:[]};
    const counts=new Map<string,number>(),assigned=new Set<string>();
    for(const unit of members){
      let status=unit.status||'unknown';
      const orderId=unit.assignment?.transactionId,order=orderId?orders.get(String(orderId)):null;
      if(orderId)assigned.add(String(orderId));
      if(status==='available'&&orderId)status='reserved';
      if(['prepared','shipped'].includes(status)&&order){
        if(order.pickupStatus==='Delivered'||order.bostaStatus==='DELIVERED'||order.deliveredAt)status='delivered';
        else if(order.shippedAt||order.pickupStatus==='Shipped')status='shipped';
      }
      counts.set(status,(counts.get(status)||0)+1);
    }
    return {availabilityStatus:counts.size===1?[...counts.keys()][0]:'mixed',
      statusCounts:[...counts].map(([status,quantity])=>({status,quantity})),
      assignedOrders:[...assigned].map(transactionId=>({transactionId,ref:String(orders.get(transactionId)?.ref||'')}))};
  }
  private async visiblePackPage(filter:any,page:number){
    const allMembers=(condition:any)=>({$allElementsTrue:[{$map:{input:'$_members',as:'unit',in:condition}}]});
    const warehouse=(value:any)=>({$cond:[{$in:[{$ifNull:[value,'']},['','main','MAIN','المخزن الرئيسي']]},'MAIN',value]});
    const pipeline:any[]=[
      {$match:{...filter,state:'sealed'}},
      {$lookup:{from:'inventoryunits',let:{ids:'$unitIds'},pipeline:[{$match:{$expr:{$in:[{$toString:'$_id'},'$$ids']}}},{$project:{status:1,assignment:1,packId:1,productId:1,warehouseCode:1}}],as:'_members'}},
      {$match:{$expr:{$and:[{$eq:[{$size:'$_members'},'$quantity']},
        allMembers({$and:[{$eq:['$$unit.packId',{$toString:'$_id'}]},{$eq:['$$unit.productId','$productId']},{$eq:[warehouse('$$unit.warehouseCode'),warehouse('$warehouseCode')]}]}),
        {$or:[allMembers({$and:[{$eq:['$$unit.status','available']},{$eq:[{$ifNull:['$$unit.assignment',null]},null]}]}),allMembers({$eq:['$$unit.status','prepared']})]}
      ]}}},
      {$lookup:{from:'transactions',let:{ids:{$map:{input:'$_members',as:'unit',in:{$ifNull:['$$unit.assignment.transactionId','']}}}},pipeline:[
        {$match:{$expr:{$and:[{$in:[{$toString:'$_id'},'$$ids']},{$eq:['$type','مبيعات']},{$or:[
          {$in:['$pickupStatus',['Shipped','Delivered']]},{$eq:['$bostaStatus','DELIVERED']},{$ne:[{$ifNull:['$shippedAt','']},'']},{$ne:[{$ifNull:['$deliveredAt','']},'']}
        ]}]}}},{$project:{_id:1}}
      ],as:'_dispatchedOrders'}},
      {$match:{$expr:{$eq:[{$size:'$_dispatchedOrders'},0]}}},
      {$facet:{packs:[{$sort:{createdAt:-1,_id:-1}},{$skip:(page-1)*30},{$limit:30},{$project:{_members:0,_dispatchedOrders:0}}],counts:[{$count:'total'}]}}
    ];
    const [result]=await this.packs().aggregate(pipeline).toArray();
    return {packs:result?.packs||[],total:Number(result?.counts?.[0]?.total||0)};
  }
  async list(query:Record<string,string>){
    const filter:any={};if(query.productId)filter.productId=String(this.id(query.productId));
    if(query.warehouseCode)filter.warehouseCode=warehouseCode(query.warehouseCode);
    if(query.q){const pattern={$regex:normalizePackCode(query.q).replace(/[.*+?^${}()|[\]\\]/g,'\\$&').slice(0,100),$options:'i'};filter.$or=[{barcode:pattern},{manualCode:pattern}];}
    const page=Math.max(1,Math.min(1000,Number(query.page)||1));if(!Number.isInteger(page))throw new BadRequestException('Invalid page');
    const listed=query.visibility==='available-prepared'?await this.visiblePackPage(filter,page):await (async()=>{
      const [packs,total]=await Promise.all([this.packs().find(filter).sort({createdAt:-1,_id:-1}).skip((page-1)*30).limit(30).toArray(),this.packs().countDocuments(filter)]);return {packs,total};
    })();
    const packs:any[]=listed.packs,total=listed.total;
    const products=await this.connection.collection('products').find({_id:{$in:[...new Set(packs.map(p=>p.productId))].map(id=>this.id(id))}},{projection:{name:1,code:1}}).toArray();
    const memberIds=[...new Set(packs.flatMap(p=>(p.unitIds||[]) as string[]))];
    const members:any[]=memberIds.length?await this.units.find({_id:{$in:memberIds.map(id=>this.id(String(id)))}}).select('_id origin status assignment packId productId warehouseCode').lean():[];
    const orderIds=[...new Set(members.map(unit=>unit.assignment?.transactionId).filter(id=>OBJECT_ID_PATTERN.test(String(id||''))))] as string[];
    const sales=orderIds.length?await this.connection.collection('transactions').find({_id:{$in:orderIds.map(id=>this.id(id))},type:'مبيعات'},
      {projection:{ref:1,pickupStatus:1,bostaStatus:1,shippedAt:1,deliveredAt:1}}).toArray():[];
    const ordersById=new Map(sales.map(order=>[String(order._id),order]));
    const invoiceIds=[...new Set(members.map(unit=>unit.origin?.purchaseTransactionId).filter(id=>OBJECT_ID_PATTERN.test(String(id||''))))] as string[];
    const invoices=invoiceIds.length?await this.connection.collection('transactions').find({_id:{$in:invoiceIds.map(id=>this.id(id))},type:'مشتريات'},
      {projection:{ref:1}}).toArray():[];
    const membersById=new Map(members.map(unit=>[String(unit._id),unit]));
    const invoicesById=new Map(invoices.map(invoice=>[String(invoice._id),invoice]));
    return {packs:await Promise.all(packs.map(async p=>{
      const grouped=new Map<string,number>();let unlinkedPieces=0;
      for(const memberId of p.unitIds||[]){
        const unit=membersById.get(String(memberId));
        const invoice=invoicesById.get(String(unit?.origin?.purchaseTransactionId||''));
        if(invoice)grouped.set(String(invoice._id),(grouped.get(String(invoice._id))||0)+1);else unlinkedPieces++;
      }
      return {...p,manualCode:await manualPackCode(this.connection,p),product:products.find(row=>String(row._id)===p.productId)||null,
        ...this.packStatus(p,(p.unitIds||[]).map((id:string)=>membersById.get(String(id))).filter(Boolean),ordersById),
        purchaseInvoices:[...grouped].map(([transactionId,quantity])=>({transactionId,ref:String(invoicesById.get(transactionId)?.ref||''),quantity})),unlinkedPieces};
    })),total,page};
  }
  create(dto:CreatePacksDto,actor:TrackingActor){return this.tracking.packOperation('create',dto,actor,async(session,name)=>{
    const ids=(dto.unitIds||[]).map(id=>String(this.id(id)));
    if(new Set(ids).size!==ids.length||ids.length<2||ids.length>1000||!Number.isSafeInteger(dto.piecesPerPack)||dto.piecesPerPack<2||dto.piecesPerPack>1000||!['reject','leave-single'].includes(dto.remainder))throw new BadRequestException('Invalid pack quantities');
    const count=Math.floor(ids.length/dto.piecesPerPack),remainder=ids.length%dto.piecesPerPack;
    if(!count||count>100||remainder&&dto.remainder!=='leave-single')throw new BadRequestException('Choose full packs or explicitly leave the remainder as single pieces');
    const members:any[]=await this.units.find({_id:{$in:ids.map(id=>this.id(id))}}).session(session);
    if(members.length!==ids.length)throw new ConflictException('Selected pieces changed; reload the selection');
    const first=members[0];
    if(members.some(u=>u.productId!==first.productId||warehouseCode(u.warehouseCode)!==warehouseCode(first.warehouseCode)||u.assignment||u.packId||u.status!=='available'))throw new ConflictException('Select available, unassigned, unpacked pieces of the same product and warehouse');
    const product=await this.connection.collection('products').findOneAndUpdate({_id:this.id(first.productId)},{$inc:{unitTrackingRevision:1}},{session,returnDocument:'after',includeResultMetadata:false});
    if(!product)throw new NotFoundException('Product not found');
    members.sort((a,b)=>String(a._id).localeCompare(String(b._id)));
    const packs:any[]=[],now=new Date().toISOString();
    for(let i=0;i<count;i++){
      const group=members.slice(i*dto.piecesPerPack,(i+1)*dto.piecesPerPack),_id=new Types.ObjectId();
      const pack={_id,manualCode:await nextPackCode(this.connection,session),barcode:'PK-'+String(_id).toUpperCase(),productId:first.productId,warehouseCode:warehouseCode(first.warehouseCode),quantity:group.length,unitIds:group.map(u=>String(u._id)),state:'sealed',createdAt:now,createdBy:name,createdByUserId:actor.userId,printCount:0,history:[{action:'created',at:now,by:name,byUserId:actor.userId,reason:dto.reason}]};
      await this.packs().insertOne(pack,{session});
      for(const unit of group){unit.packId=String(_id);await unit.save({session});}
      packs.push({...pack,_id:String(_id),availabilityStatus:'available',statusCounts:[{status:'available',quantity:group.length}],assignedOrders:[],product:{name:product.name,code:product.code}});
    }
    return {packs,singleUnitIds:members.slice(count*dto.piecesPerPack).map(u=>String(u._id)),totalPieces:ids.length,stockChanged:false};
  });}
  open(identifier:string,dto:TrackingRequestDto,actor:TrackingActor){return this.tracking.packOperation(`open:${identifier}`,dto,actor,async(session,name)=>{
    const pack:any=await this.packs().findOneAndUpdate({...packCodeFilter(identifier),state:'sealed'},{$set:{state:'opened',openedAt:new Date().toISOString(),openedBy:name},$push:{history:{action:'opened',at:new Date().toISOString(),by:name,byUserId:actor.userId,reason:dto.reason}} as any},{session,returnDocument:'after',includeResultMetadata:false});
    if(!pack)throw new ConflictException('This pack is already open or unavailable');
    const members=await this.units.find({_id:{$in:pack.unitIds.map((id:string)=>this.id(id))}}).session(session);
    if(members.length!==pack.quantity)throw new ConflictException('Pack membership is incomplete');
    for(const unit of members){if(unit.packId!==String(pack._id))throw new ConflictException('Pack membership changed');unit.packId=null;await unit.save({session});}
    return {packId:String(pack._id),barcode:pack.barcode,state:'opened',stockChanged:false};
  });}
  scan(transactionId:string,dto:OrderPickScanDto,actor:TrackingActor){
    dto={...dto,identifier:dto.identifier.trim().replace(/^\][A-Za-z]\d/,'').toUpperCase()};
    return this.tracking.packOperation(`scan:${transactionId}`,dto,actor,async(session,name)=>{
    if(!dto.physicalPossessionConfirmed)throw new BadRequestException('Physical pack scan required');
    const pack:any=await this.packs().findOneAndUpdate({...packCodeFilter(dto.identifier),state:'sealed'},{$inc:{revision:1}},{session,returnDocument:'after',includeResultMetadata:false});
    if(!pack)throw new ConflictException('Pack is open or unknown; scan the individual pieces instead');
    const members=await this.units.find({_id:{$in:pack.unitIds.map((id:string)=>this.id(id))}}).session(session).lean();
    if(members.length!==pack.quantity||members.some(u=>u.packId!==String(pack._id)||u.productId!==pack.productId||warehouseCode(u.warehouseCode)!==pack.warehouseCode||u.status!=='available'||u.assignment))throw new ConflictException('Pack was already scanned, is assigned, or contains unavailable pieces');
    const results:any[]=[];
    for(const unit of members)results.push(await this.tracking.pickUnitInSession(transactionId,{...dto,identifier:unit.barcode},actor,session,name,String(pack._id)));
    await this.packs().updateOne({_id:pack._id},{$push:{history:{action:'scanned',at:new Date().toISOString(),by:name,byUserId:actor.userId,transactionId,lineId:dto.lineId,reason:dto.reason}} as any},{session});
    return {outcome:'accepted',isPack:true,quantity:pack.quantity,packId:String(pack._id),units:results.map(row=>row.unit),unit:{...results[0].unit,barcode:pack.barcode,manualCode:await manualPackCode(this.connection,pack,session)},lineId:dto.lineId,transactionId,stockChanged:false};
  });}
  async labels(dto:PackLabelsDto,actor:TrackingActor,record=false){
    const make=async(session?:any)=>{
      const size=LABEL_SIZES.find(s=>s.id===dto.sizeId);if(!size)throw new BadRequestException('Unsupported label size');
      const ids=(dto.packIds||[]).map(id=>String(this.id(id)));if(!ids.length||ids.length>100||new Set(ids).size!==ids.length)throw new BadRequestException('Invalid pack selection');
      const packs=await this.packs().find({_id:{$in:ids.map(id=>this.id(id))},state:'sealed'},{session}).toArray();
      if(packs.length!==ids.length)throw new ConflictException('An opened pack cannot be printed as a sealed pack');
      const labels=[];
      for(const pack of packs){const product=await this.connection.collection('products').findOne({_id:this.id(pack.productId)},{session});if(!product)throw new NotFoundException('Product not found');
        const members:any[]=await this.units.find({_id:{$in:pack.unitIds.map((id:string)=>this.id(id))}}).select('origin.purchaseTransactionId').session(session||null).lean();
        const purchaseIds=[...new Set(members.map(unit=>unit.origin?.purchaseTransactionId).filter(id=>OBJECT_ID_PATTERN.test(String(id||''))))];
        const invoices=purchaseIds.length?await this.connection.collection('transactions').find({_id:{$in:purchaseIds.map(id=>this.id(String(id)))},type:'مشتريات'},{session,projection:{date:1}}).toArray():[];
        const invoiceDates=[...new Set(invoices.map(invoice=>invoice.date).filter(Boolean).map(value=>String(value)))];
        labels.push({invoiceDate:invoiceDates.length===1?invoiceDates[0]:null,invoiceDates,unitId:String(pack._id),packId:String(pack._id),barcode:pack.barcode,quantity:pack.quantity,isPack:true,productName:product.name,sku:product.code,manualCode:await manualPackCode(this.connection,pack,session),sellPrice:typeof product.sellPrice==='number'?product.sellPrice*pack.quantity:null,printCount:(pack.printCount||0)+(record?1:0),svg:await QRCode.toString(pack.barcode,{type:'svg',errorCorrectionLevel:'M',margin:2})});}
      return {size,labels,stockChanged:false,physicalPrintingVerified:false};
    };
    if(!record)return make();
    return this.tracking.packOperation('print',dto,actor,async(session,name)=>{
      const batch=await make(session);
      await this.packs().updateMany({_id:{$in:dto.packIds.map(id=>this.id(id))}},{$inc:{printCount:1},$push:{history:{action:'print-requested',at:new Date().toISOString(),by:name,byUserId:actor.userId,sizeId:dto.sizeId,reason:dto.reason}} as any},{session});return batch;
    },'inventory-units-print');
  }
  undoScan(identifier:string,dto:TrackingRequestDto,actor:TrackingActor){return this.tracking.packOperation(`undo:${identifier}`,dto,actor,async(session,name,context)=>{
    const pack:any=await this.packs().findOneAndUpdate({...packCodeFilter(identifier),state:'sealed'},{$inc:{revision:1}},{session,returnDocument:'after',includeResultMetadata:false});
    if(!pack)throw new ConflictException('Pack is open or unavailable');
    const members=await this.units.find({_id:{$in:pack.unitIds.map((id:string)=>this.id(id))}}).session(session).lean();
    const assignment=members[0]?.assignment;
    if(members.length!==pack.quantity||!assignment||members.some(u=>u.packId!==String(pack._id)||!['picking','prepared'].includes(u.status)||u.assignment?.transactionId!==assignment.transactionId||u.assignment?.lineId!==assignment.lineId))throw new ConflictException('Every pack member must still be picking or prepared for the same order');
    for(const unit of members)await this.tracking.actionInSession(unit.barcode,{...dto,action:'undo-picking',expectedVersion:unit.__v,physicalPossessionConfirmed:true,transactionId:assignment.transactionId,lineId:assignment.lineId},actor,session,name,String(pack._id),context);
    await this.packs().updateOne({_id:pack._id},{$push:{history:{action:'scan-undone',at:new Date().toISOString(),by:name,byUserId:actor.userId,reason:dto.reason}} as any},{session});
    return {barcode:pack.barcode,quantity:pack.quantity,transactionId:assignment.transactionId,stockChanged:false};
  });}
}
