import { BostaService } from '../../src/bosta/bosta.service';
import { ExtendPickupDto } from '../../src/bosta/dto/extend-pickup.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

const requestId = '507f1f77bcf86cd799439010';
const additions = ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'];
const dto = { orderIds: additions, expectedNumberOfParcels: 30 };

function fixture() {
  const svc: any = Object.create(BostaService.prototype);
  const state: any = { _id: requestId, status: 'created', bostaPickupId: 'B-30', businessLocationId: 'warehouse', scheduledDate: '2099-10-13', numberOfParcels: 30, orderIds: Array.from({length:30},(_,i)=>`old-${i}`), pendingOrderIds: [], updateState: 'idle' };
  const carrier: any = { _id: 'B-30', businessLocationId: 'warehouse', scheduledDate: state.scheduledDate, numberOfParcels: 30, state: 'Requested' };
  svc.settingsService = { getBostaPickupPolicy: jest.fn(async()=>({cutoffTime:'16:00',holidayDates:[]})) };
  svc.resolveApiKey = jest.fn(async()=>'test-key');
  svc.pickupPreview = jest.fn(async()=>({orders:additions.map(id=>({id})),numberOfParcels:2}));
  svc.txModel = { findByIdAndUpdate: jest.fn() };
  function matches(query:any) {
    return Object.entries(query).every(([key,value]:any)=> {
      if(value?.$in)return value.$in.includes(state[key]);
      if(value?.$nin)return !value.$nin.includes(state[key]);
      return JSON.stringify(state[key])===JSON.stringify(value);
    });
  }
  function apply(update:any) {
    Object.assign(state, structuredClone(update.$set || {}));
    if(update.$addToSet)state.orderIds=[...new Set([...state.orderIds,...update.$addToSet.orderIds.$each])];
    if(update.$pull)state.orderIds=state.orderIds.filter((id:string)=>!update.$pull.orderIds.$in.includes(id));
    if(update.$push)state.updateHistory=[...(state.updateHistory||[]),structuredClone(update.$push.updateHistory)];
  }
  svc.pickupModel = {
    init:jest.fn(async()=>undefined),
    findById:jest.fn(async()=>structuredClone(state)),
    findOneAndUpdate:jest.fn(async(query:any,update:any)=> {if(!matches(query))return null;apply(update);return structuredClone(state);}),
    updateOne:jest.fn(async(query:any,update:any)=>{if(!matches(query))return {modifiedCount:0};apply(update);return {modifiedCount:1};}),
  };
  svc.request = jest.fn(async(method:string,_path:string,body:any)=>{
    if(method==='PUT')carrier.numberOfParcels=body.numberOfParcels;
    return {success:true,data:structuredClone(carrier)};
  });
  return {svc,state,carrier};
}

describe('adding orders to an existing Bosta pickup',()=>{
  it('changes 30 to 32 on the same carrier pickup and confirms only after read-back',async()=>{
    const {svc,state}=fixture();
    expect(await svc.extendPickup(requestId,dto,'Mona')).toMatchObject({success:true,numberOfParcels:32,bostaPickupId:'B-30'});
    expect(svc.request.mock.calls.map((call:any[])=>call[0])).toEqual(['GET','PUT','GET']);
    expect(svc.request).toHaveBeenCalledWith('PUT','/pickups/B-30',{numberOfParcels:32},'test-key','https://app.bosta.co/api/v2');
    expect(state).toMatchObject({numberOfParcels:32,updateState:'idle',pendingOrderIds:[],pendingNumberOfParcels:0});
    expect(state.orderIds).toHaveLength(32);
    expect(state.updateHistory[0]).toMatchObject({from:30,to:32,by:'Mona',outcome:'confirmed'});
    expect(svc.txModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it.each(['Picked up','Picking up','Route Assigned','Done','Canceled','UNKNOWN'])('refuses changes when carrier state is %s',async carrierState=>{
    const {svc,state,carrier}=fixture();carrier.state=carrierState;
    await expect(svc.extendPickup(requestId,dto,'Mona')).rejects.toThrow('قابلًا للتعديل');
    expect(svc.request.mock.calls.map((call:any[])=>call[0])).toEqual(['GET']);
    expect(state.orderIds).toHaveLength(30);expect(state.numberOfParcels).toBe(30);expect(state.updateState).toBe('idle');
  });

  it.each(['missing-count','wrong-count','wrong-location','wrong-date','wrong-id'])('refuses to overwrite unverified carrier data: %s',async scenario=>{
    const {svc,state,carrier}=fixture();
    if(scenario==='missing-count')delete carrier.numberOfParcels;
    if(scenario==='wrong-count')carrier.numberOfParcels=31;
    if(scenario==='wrong-location')carrier.businessLocationId='elsewhere';
    if(scenario==='wrong-date')carrier.scheduledDate='2099-10-14';
    if(scenario==='wrong-id')carrier._id='other';
    await expect(svc.extendPickup(requestId,dto,'Mona')).rejects.toThrow();
    expect(svc.request).toHaveBeenCalledTimes(1);expect(state.orderIds).toHaveLength(30);
  });

  it('releases additions after an explicit PUT rejection while retaining the original 30',async()=>{
    const {svc,state}=fixture();const original=svc.request.getMockImplementation();
    svc.request.mockImplementation(async(...args:any[])=>args[0]==='PUT'?{success:false,message:'Update refused'}:original(...args));
    await expect(svc.extendPickup(requestId,dto,'Mona')).rejects.toThrow('Update refused');
    expect(state).toMatchObject({numberOfParcels:30,updateState:'idle',pendingOrderIds:[]});expect(state.orderIds).toHaveLength(30);
  });

  it.each(['timeout','unchanged','read-404','local-save'])('keeps additions reserved on ambiguous result: %s',async scenario=>{
    const {svc,state}=fixture();const original=svc.request.getMockImplementation();let reads=0;
    svc.request.mockImplementation(async(...args:any[])=>{
      if(args[0]==='GET' && ++reads===2 && scenario==='read-404')throw Object.assign(new Error('Not found'),{statusCode:404});
      if(args[0]==='PUT' && scenario==='timeout')throw new Error('timeout');
      if(args[0]==='PUT' && scenario==='unchanged')return {success:true};
      return original(...args);
    });
    if(scenario==='local-save')svc.pickupModel.updateOne.mockRejectedValueOnce(new Error('database disconnected'));
    await expect(svc.extendPickup(requestId,dto,'Mona')).rejects.toThrow('غير مؤكدة');
    expect(state).toMatchObject({numberOfParcels:30,updateState:'uncertain',pendingOrderIds:additions,pendingNumberOfParcels:32});
    expect(state.orderIds).toHaveLength(32);
    svc.request.mockClear();await expect(svc.extendPickup(requestId,dto,'Mona')).rejects.toThrow('قيد التأكيد');expect(svc.request).not.toHaveBeenCalled();
  });

  it('uses a read-only reconciliation after a timeout without sending PUT again',async()=>{
    const {svc,state,carrier}=fixture();const original=svc.request.getMockImplementation();
    svc.request.mockImplementation(async(...args:any[])=>{
      if(args[0]==='PUT'){carrier.numberOfParcels=32;throw new Error('timeout after acceptance');}
      return original(...args);
    });
    await expect(svc.extendPickup(requestId,dto,'Mona')).rejects.toThrow('غير مؤكدة');svc.request.mockClear();
    expect(await svc.verifyPickupUpdate(requestId)).toMatchObject({success:true,numberOfParcels:32});
    expect(svc.request.mock.calls.map((call:any[])=>call[0])).toEqual(['GET']);expect(state.updateState).toBe('idle');
  });

  it('does not release an uncertain addition just because Bosta still shows the old total',async()=>{
    const {svc,state}=fixture();Object.assign(state,{updateState:'uncertain',pendingOrderIds:additions,pendingNumberOfParcels:32});
    await expect(svc.verifyPickupUpdate(requestId)).rejects.toThrow('لم تؤكد');expect(state.pendingOrderIds).toEqual(additions);expect(svc.pickupModel.updateOne).not.toHaveBeenCalled();
  });

  it('allows only one competing update to reserve and send',async()=>{
    const {svc}=fixture();const results=await Promise.allSettled([svc.extendPickup(requestId,dto,'A'),svc.extendPickup(requestId,dto,'B')]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(svc.request.mock.calls.filter((call:any[])=>call[0]==='PUT')).toHaveLength(1);
  });

  it('rejects cross-request order reservation conflicts before contacting Bosta',async()=>{
    const {svc}=fixture();svc.pickupModel.findOneAndUpdate.mockRejectedValue({code:11000});
    await expect(svc.extendPickup(requestId,dto,'A')).rejects.toThrow('محجوزة');expect(svc.request).not.toHaveBeenCalled();
  });

  it('rejects stale order lists and totals before reserving',async()=>{
    const {svc}=fixture();
    await expect(svc.extendPickup(requestId,{...dto,expectedNumberOfParcels:29},'A')).rejects.toThrow('تغير العدد');
    await expect(svc.extendPickup(requestId,{...dto,orderIds:[additions[0]]},'A')).rejects.toThrow('تغيرت');
    expect(svc.pickupModel.findOneAndUpdate).not.toHaveBeenCalled();expect(svc.request).not.toHaveBeenCalled();
  });

  it('rejects duplicate IDs and client-supplied invalid totals at the API boundary',async()=>{
    expect(await validate(plainToInstance(ExtendPickupDto,dto))).toHaveLength(0);
    expect((await validate(plainToInstance(ExtendPickupDto,{orderIds:[additions[0],additions[0]],expectedNumberOfParcels:0}))).length).toBeGreaterThan(0);
  });

  it('enforces Cairo cutoff again when preflight runs past it',async()=>{
    jest.useFakeTimers().setSystemTime(new Date('2026-10-24T12:59:59Z'));
    try {
      const {svc,state,carrier}=fixture();state.scheduledDate=carrier.scheduledDate='2026-10-24';
      const original=svc.request.getMockImplementation();
      svc.request.mockImplementation(async(...args:any[])=>{const response=await original(...args);jest.setSystemTime(new Date('2026-10-24T13:00:00Z'));return response;});
      await expect(svc.extendPickup(requestId,dto,'Mona')).rejects.toThrow('انتهى وقت');
      expect(svc.request.mock.calls.map((call:any[])=>call[0])).toEqual(['GET']);expect(state.orderIds).toHaveLength(30);
    } finally {jest.useRealTimers();}
  });

  it('does not reconcile while another worker may still be sending the update',async()=>{
    const {svc,state}=fixture();Object.assign(state,{updateState:'pending',pendingOrderIds:additions,pendingNumberOfParcels:32,updateRequestedAt:new Date()});
    await expect(svc.verifyPickupUpdate(requestId)).rejects.toThrow('التعديل جارٍ');expect(svc.request).not.toHaveBeenCalled();
  });
});
