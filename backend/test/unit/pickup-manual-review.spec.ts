import {readFileSync} from 'fs';
import {resolve} from 'path';
import { runInNewContext } from '../pickup-authorized-context';
const html=readFileSync(resolve(__dirname,'../../../frontend/public/index.html'),'utf8');
const grab=(name:string)=>html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))![0];
function fixture(qty=1){
  const order={_id:'one',prepChecked:false,items:[{lineId:'line',qty}]};
  const state:any={summary:{prepChecked:false,lines:[{lineId:'line',qty,units:[],skippedCount:0}]}};
  const approve={focus:jest.fn()};
  const c:any={currentLang:'en',_pickupOrders:[order,{_id:'two',prepChecked:false}],_pwSelId:'one',_pucoColType:'prep',
    _pwPickState:()=>state,_pucoGetGroup:()=>({orders:[order]}),hasPerm:()=>true,_pwRenderWork:jest.fn(),
    _pwScanFocus:jest.fn(),_pwAutoPrepareScannedOrder:jest.fn(),pucoTickOrder:jest.fn(async()=>{}),
    window:{},crypto:{randomUUID:()=> 'manual-key'},fmtN:String,esc:String,qs:()=>approve,CSS:{escape:String},
    toast:jest.fn(),showPrompt:jest.fn(async()=> '1'),_pwScheduleFeedbackExpiry:jest.fn()};
  c.api=jest.fn(async()=>({prepChecked:false}));
  c._pwLoadPickSummary=jest.fn(async()=>{state.summary={prepChecked:false,lines:[{lineId:'line',qty,units:[],skippedCount:1}]};});
  runInNewContext(['_pwIncompletePickLines','pwSkipDamagedLabel','_pwScanIntroHtml'].map(grab).join('\n'),c);
  return {c,state,order,approve};
}
it('records manual preparation without approving, reordering or changing the selected order',async()=>{
  const {c,state,order,approve}=fixture();
  await c.pwSkipDamagedLabel('one','line');
  expect(c.api).toHaveBeenCalledTimes(1);expect(JSON.parse(c.api.mock.calls[0][1].body)).toMatchObject({action:'skip',quantity:1});
  expect(c._pwAutoPrepareScannedOrder).not.toHaveBeenCalled();expect(c.pucoTickOrder).not.toHaveBeenCalled();
  expect(order.prepChecked).toBe(false);expect(c._pwSelId).toBe('one');expect(c._pickupOrders.map(row=>row._id)).toEqual(['one','two']);
  expect(state.feedback.hint).toContain('Approve preparation');expect(approve.focus).toHaveBeenCalledWith({preventScroll:true});
  expect(c._pwScanIntroHtml(order,state)).toContain('is-manual-review');
});
it('keeps a partially completed manual order ready for its remaining items',async()=>{
  const {c,state,order,approve}=fixture(2);await c.pwSkipDamagedLabel('one','line');
  expect(order.prepChecked).toBe(false);expect(approve.focus).not.toHaveBeenCalled();
  expect(c._pwScanFocus).toHaveBeenCalled();expect(c._pwScanIntroHtml(order,state)).not.toContain('is-manual-review');
});
it.each([0,1])('requires manual approval when skipped pieces remain alongside %s scanned pieces',async scanned=>{
  const {c,state,order}=fixture(scanned+1);
  state.summary.lines[0].skippedCount=1;state.summary.lines[0].units=Array.from({length:scanned},()=>({status:'prepared'}));
  runInNewContext(grab('_pwAutoPrepareScannedOrder'),c);
  await c._pwAutoPrepareScannedOrder('one');expect(c.pucoTickOrder).not.toHaveBeenCalled();expect(order.prepChecked).toBe(false);
});
it('continues automatically approving fully scanned orders',async()=>{
  const {c,state}=fixture();state.summary.lines[0].units=[{status:'prepared'}];
  runInNewContext(grab('_pwAutoPrepareScannedOrder'),c);
  await c._pwAutoPrepareScannedOrder('one');expect(c.pucoTickOrder).toHaveBeenCalledWith('one',true);
});
