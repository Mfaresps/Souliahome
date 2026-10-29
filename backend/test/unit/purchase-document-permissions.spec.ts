import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext, Script } from 'vm';
import { maskPurchaseFields } from '../../src/transactions/purchase-mask.util';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
function grab(name: string) {
  const match = html.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}'));
  if (!match) throw new Error(name);
  return match[0];
}
const purchase = (extra: any = {}) => ({ _id:'purchase', type:'مشتريات', ref:'900015', total:98765,
  items:[{name:'Private purchase item',qty:61,price:1234,total:75274}], ...extra });
const sale = (extra: any = {}) => ({ _id:'sale', type:'مبيعات', shipCo:'Bosta', pickupStatus:'Preparing', ...extra });

function fixture(rows: any[], admin = false, canShip = false) {
  const buttons = new Map(['bulk-print-btn','bulk-export-btn','bulk-bosta-btn','mov-bulk-bar'].map(id=>[id,{style:{display:''}}]));
  const documentWrite = jest.fn(), open = jest.fn(() => ({document:{write:documentWrite,close:jest.fn()},close:jest.fn()}));
  const c: any = {
    transactions:rows, selectedMovIds:new Set(rows.map(row=>row._id)), currentLang:'en',
    isAdmin:()=>admin, hasPerm:()=>false, _puCanEdit:()=>canShip, _puRequireEdit:()=>canShip,
    qs:(selector: string)=>buttons.get(selector.slice(1)) || null,
    qsa:()=>[], _bostaCaseId:(tx: any)=>tx.afterSales?.caseId || '',
    carrierIntegration:(code: string)=>code === 'Bosta' ? 'bosta' : '',
    toast:jest.fn(), t:(key: string)=>key, fmtJT:String, isExchangeSalePendingCollect:()=>false,
    window:{open,InvoiceUnitIdentities:{ensure:jest.fn(async()=>{})}},
    buildInvoiceHtml:jest.fn((tx: any)=>'<invoice>'+tx._id+'</invoice>'),
    _invoiceSharedCss:()=>'', _invPrintTrigger:()=>'', requireExportOtp:jest.fn(),
    api:jest.fn(), showConfirm:jest.fn(),
  };
  runInNewContext(['_isPurchaseDetailsRestricted','_invoiceDetailsDenied','_bsfIsBostaOrder','_isBulkBostaEligible',
    'updateMovementSelectionActions','bulkPrintPDF','printInvoice','exportSelectedExcel','bulkSendToBosta'].map(grab).join('\n'),c);
  return { c,buttons,open,documentWrite };
}

describe('Purchase documents and bulk shipping privacy',()=>{
  it.each([purchase(),purchase({purchaseDetailsHidden:true}),purchase({type:'مرتجع مشتريات'}),sale({purchaseDetailsHidden:true})])(
    'blocks direct and bulk printing/exporting of a restricted document before opening a window', async tx=>{
      const {c,open}=fixture([tx]);
      await c.bulkPrintPDF(); await c.printInvoice(tx._id); c.exportSelectedExcel();
      expect(open).not.toHaveBeenCalled(); expect(c.window.InvoiceUnitIdentities.ensure).not.toHaveBeenCalled();
      expect(c.buildInvoiceHtml).not.toHaveBeenCalled(); expect(c.requireExportOtp).not.toHaveBeenCalled();
      c.updateMovementSelectionActions();
      expect(c.qs('#bulk-print-btn').style.display).toBe('none');
      expect(c.qs('#bulk-export-btn').style.display).toBe('none');
    });

  it('rejects a mixed purchase/sales selection without partially printing it',async()=>{
    const {c,open}=fixture([sale(),purchase()]);
    await c.bulkPrintPDF(); expect(open).not.toHaveBeenCalled();
  });

  it.each([[false,sale()],[true,purchase()],[true,purchase({type:'مرتجع مشتريات'})]])(
    'keeps authorized invoice printing available (admin=%s)',async(admin,tx)=>{
      const {c,open,documentWrite}=fixture([tx],admin as boolean);
      await c.bulkPrintPDF(); expect(open).toHaveBeenCalledTimes(1);
      expect(documentWrite.mock.calls[0][0]).toContain('<invoice>'+tx._id+'</invoice>');
      c.updateMovementSelectionActions(); expect(c.qs('#bulk-print-btn').style.display).toBe('inline-flex');
    });

  it('keeps the HTML builder from rendering restricted data even when called directly',()=>{
    const {c}=fixture([purchase()]);
    runInNewContext(grab('buildInvoiceHtml'),c);
    expect(c.buildInvoiceHtml(purchase())).toBe('');
  });

  it.each([purchase(),purchase({type:'مرتجع مشتريات'}),sale({shipCo:'Aramex'}),
    sale({pickupStatus:'Pending'}),sale({cancelled:true}),sale({archived:true}),sale({bostaOrderId:'existing'}),
    sale({afterSales:{caseId:'case'}})])('hides Bosta for an ineligible selection',tx=>{
      const {c}=fixture([tx],false,true); c.updateMovementSelectionActions();
      expect(c.qs('#bulk-bosta-btn').style.display).toBe('none');
    });

  it('shows Bosta only for eligible sales and a user permitted to ship',()=>{
    const allowed=fixture([sale()],false,true).c; allowed.updateMovementSelectionActions();
    expect(allowed.qs('#bulk-bosta-btn').style.display).toBe('inline-flex');
    for(const c of [fixture([sale()]).c,fixture([sale(),purchase()],false,true).c]){
      c.updateMovementSelectionActions(); expect(c.qs('#bulk-bosta-btn').style.display).toBe('none');
    }
  });

  it('rejects forcing bulk shipping for purchases or a mixed selection before confirmation or requests',async()=>{
    for(const rows of [[purchase()],[sale(),purchase()]]){
      const {c}=fixture(rows,false,true);await c.bulkSendToBosta();
      expect(c.showConfirm).not.toHaveBeenCalled();expect(c.api).not.toHaveBeenCalled();
    }
  });

  it('server responses continue masking purchase costs even for users allowed to see operational rows',()=>{
    const raw=purchase(); const masked=maskPurchaseFields(raw,'staff');
    expect(masked.purchaseDetailsHidden).toBe(true); expect(masked.total).toBeNull();
    expect(masked.items[0].price).toBeNull(); expect(masked.items[0].total).toBeNull();
    expect(raw.total).toBe(98765); expect(maskPurchaseFields(raw,'admin')).toBe(raw);
  });

  it('keeps all shipped inline scripts valid',()=>{
    for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
      if(/\bsrc\s*=|application\//.test(match[1]))continue;
      expect(()=>new Script(match[2])).not.toThrow();
    }
  });
});

