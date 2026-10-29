import {readFileSync} from 'fs';
import {resolve} from 'path';
import { runInNewContext } from '../pickup-authorized-context';
const source=readFileSync(resolve(__dirname,'../../../frontend/public/pickup-ready-return.js'),'utf8');
function fixture(){
  const button={disabled:false,setAttribute:jest.fn()};
  const c:any={currentLang:'en',esc:String,_pickupOrders:[{_id:'one',ref:'2913',pickupStatus:'Ready',pickupRef:'READY-A',prepChecked:true,client:'Customer'}],
    _puPrepGroups:[],_puDailyAwaitingPickup:()=>true,qsa:()=>[button],_genPrepRef:()=> 'PREP-NEW',
    _puConfirm:jest.fn(async()=>true),api:jest.fn(async()=>({updated:1})),loadPickupOrders:jest.fn(async()=>{}),
    _puApplyRealtimeEvent:jest.fn(),_pucoGetGroup:()=>null,closePuCardOrdersModal:jest.fn(),toast:jest.fn()};
  runInNewContext(source,c);return {c,button};
}
it('Pending explicitly cancels preparation and clears scanned invoice identities through the reset endpoint',async()=>{
  const {c,button}=fixture();await c._puReturnReadyOrder('one','pending');
  expect(c._puConfirm.mock.calls[0][0]).toContain('scanned piece identities removed');
  expect(c.api).toHaveBeenCalledWith('/transactions/pickup-orders/undo',expect.objectContaining({body:JSON.stringify({ids:['one'],sourceRef:'READY-A'})}));
  expect(c._puApplyRealtimeEvent).toHaveBeenCalledWith({ids:['one'],action:'undo',scansReset:true});
  expect(button.disabled).toBe(false);
});
it('Preparing uses the selected existing group and preserves preparation and identities',async()=>{
  const {c}=fixture();const groups=[{prepRef:'PREP-A',orders:[{}]},{prepRef:'PREP-B',orders:[{}],note:'Selected group',shipCo:'Bosta'}];
  c._puPrepGroups=groups;c._puChooseReturnPrepGroup=jest.fn(async()=>({prepRef:'PREP-B',joinExisting:true,group:groups[1]}));
  await c._puReturnReadyOrder('one','preparing');
  expect(c._puChooseReturnPrepGroup).toHaveBeenCalledWith(c._pickupOrders[0],groups);
  expect(c.api.mock.calls[0][0]).toBe('/transactions/pickup-orders/return-to-preparing');
  expect(JSON.parse(c.api.mock.calls[0][1].body)).toMatchObject({ids:['one'],prepRef:'PREP-B',joinExisting:true,sourceRef:'READY-A'});
  expect(c._puApplyRealtimeEvent).toHaveBeenCalledWith(expect.objectContaining({action:'preparing',preparationPreserved:true,pickupRef:'PREP-B'}));
  expect(c._pickupOrders[0].prepChecked).toBe(true);
});
it('supports creating a preparation group when no group exists',async()=>{
  const {c}=fixture();c._puChooseReturnPrepGroup=jest.fn(async()=>({prepRef:'PREP-NEW',joinExisting:false}));
  await c._puReturnReadyOrder('one','preparing');
  expect(JSON.parse(c.api.mock.calls[0][1].body)).toMatchObject({prepRef:'PREP-NEW',joinExisting:false});
});
it.each(['pending','preparing'])('cancelling %s does not change an order or submit a request',async mode=>{
  const {c,button}=fixture();c._puConfirm.mockResolvedValue(false);c._puChooseReturnPrepGroup=jest.fn(async()=>null);
  await c._puReturnReadyOrder('one',mode);expect(c.api).not.toHaveBeenCalled();
  expect(c._puApplyRealtimeEvent).not.toHaveBeenCalled();expect(button.disabled).toBe(false);
});
it('blocks a competing Pending action while the user selects a preparation group',async()=>{
  const {c,button}=fixture();let choose:any;
  c._puChooseReturnPrepGroup=jest.fn(()=>new Promise(resolve=>{choose=resolve;}));
  const first=c._puReturnReadyOrder('one','preparing');await c._puReturnReadyOrder('one','pending');
  expect(button.disabled).toBe(true);expect(c._puConfirm).not.toHaveBeenCalled();
  choose({prepRef:'PREP-A',joinExisting:true});await first;expect(c.api).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(false);
});
it('refreshes a stale destination without changing local preparation or piece identities',async()=>{
  const {c,button}=fixture();c._puChooseReturnPrepGroup=jest.fn(async()=>({prepRef:'OLD',joinExisting:true}));
  c.api.mockRejectedValue(new Error('Destination no longer available'));
  await c._puReturnReadyOrder('one','preparing');expect(c.loadPickupOrders).toHaveBeenCalledTimes(1);
  expect(c._puApplyRealtimeEvent).not.toHaveBeenCalled();expect(c._pickupOrders[0].prepChecked).toBe(true);
  expect(button.disabled).toBe(false);
});
