import {readFileSync} from 'fs';
import {resolve} from 'path';
import {runInNewContext} from 'vm';
const html=readFileSync(resolve(__dirname,'../../../frontend/public/index.html'),'utf8');
const grab=(name:string)=>html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))![0];
function fixture(units:any[]){
  const state:any={};const order={_id:'one',prepChecked:true};
  const button={focus:jest.fn(),scrollIntoView:jest.fn()};
  const c:any={currentLang:'en',esc:String,_pickupOrders:[order],_pucoColType:'prep',_pwSelId:'one',
    _pwPickState:()=>state,api:jest.fn(async()=>({lines:[{units}]})),_pwRenderWork:jest.fn(),qs:()=>button,
    _puSetLocalPrepChecked:jest.fn(),_puPersistPrepCheck:jest.fn(),toast:jest.fn(),_pwReaderKeys:''};
  runInNewContext(['_pwUndoScanButtonHtml','_pwGuideUndoScannedPreparation','_pwResetUndoneScan','_pucoTickOrderImpl'].map(grab).join('\n'),c);
  return {c,state,order,button};
}
it('guides a scanned Prepared order to Undo last scan without clearing preparation or making a write',async()=>{
  const {c,state,order,button}=fixture([{unitId:'piece',status:'prepared'}]);
  await c._pucoTickOrderImpl('one',false);
  expect(state.undoScanAttention).toBe(true);expect(order.prepChecked).toBe(true);
  expect(c._puSetLocalPrepChecked).not.toHaveBeenCalled();expect(c._puPersistPrepCheck).not.toHaveBeenCalled();
  expect(c.api).toHaveBeenCalledWith('/inventory-units/orders/one/picking');
  expect(button.focus).toHaveBeenCalled();expect(button.scrollIntoView).toHaveBeenCalledWith({block:'nearest',behavior:'auto'});
  expect(c._pwUndoScanButtonHtml(order,state)).toContain('pw-undo-scan-dot');
});
it('does not mark orders without active scans and clears stale attention',async()=>{
  const {c,state}=fixture([{status:'available'}]);state.undoScanAttention=true;
  await expect(c._pwGuideUndoScannedPreparation('one')).resolves.toBe(false);
  expect(state.undoScanAttention).toBe(false);expect(c._pwRenderWork).not.toHaveBeenCalled();
});
it('clears the red marker when a scan is successfully undone',()=>{
  const {c,state,order}=fixture([]);state.undoScanAttention=true;state.last={unit:{}};
  c._pwResetUndoneScan(state);
  expect(state.undoScanAttention).toBe(false);expect(c._pwUndoScanButtonHtml(order,state)).not.toContain('pw-undo-scan-dot');
});
it('leaves Prepared intact if scan verification cannot be loaded',async()=>{
  const {c,order}=fixture([]);c.api.mockRejectedValue(new Error('Offline'));
  await c._pucoTickOrderImpl('one',false);
  expect(order.prepChecked).toBe(true);expect(c._puPersistPrepCheck).not.toHaveBeenCalled();
  expect(c.toast).toHaveBeenCalledWith('Offline',true);
});
