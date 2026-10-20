(() => {
  'use strict';
  const tr=(en,ar)=>typeof currentLang!=='undefined'&&currentLang==='en'?en:ar;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const key=()=>`pack-${crypto.randomUUID()}`;
  const permitted=p=>typeof hasPerm==='function'&&hasPerm(p);
  let dialog,selected=[],batch=null,page=1,total=0,busy=false,openingActor='',scope=null,selectionError='';
  let currentPacks=[],showHistory=false;
  let creationSummary=null;
  function rememberCreation(result){
    if(!Array.isArray(result?.packs)||!result.packs.length)return;
    creationSummary={pieces:result.packs.reduce((sum,pack)=>sum+Number(pack.quantity||0),0),packs:result.packs.length,
      size:result.packs[0].quantity,remainder:Array.isArray(result.singleUnitIds)?result.singleUnitIds.length:0};
  }
  let packedExcluded=0,unavailableExcluded=0;
  const warehouseCode=value=>!value||['main','المخزن الرئيسي'].includes(value)?'MAIN':String(value);
  function selectionContext(selection){
    const units=selection?.units||[],first=units[0];
    scope=null;selectionError='';packedExcluded=0;unavailableExcluded=0;selected=[];
    if(!first){selectionError=tr('Select at least two available pieces of one product first.','حدد أولًا قطعتين متاحتين على الأقل من نفس المنتج.');return;}
    if(!first.productId||units.length!==selection.ids.length||units.some(u=>u.productId!==first.productId||warehouseCode(u.warehouseCode)!==warehouseCode(first.warehouseCode))){selectionError=tr('Choose one product from one warehouse. Mixed selections cannot form a pack.','اختر منتجًا واحدًا من مخزن واحد. لا يمكن خلط منتجات أو مخازن داخل الباك.');return;}
    scope={productId:first.productId,warehouseCode:warehouseCode(first.warehouseCode),name:first.product?.name||first.productName||first.product?.code||'',sku:first.product?.code||''};
    packedExcluded=units.filter(u=>!!u.packId).length;
    unavailableExcluded=units.filter(u=>!u.packId&&(u.assignment||u.status!=='available')).length;
    selected=units.filter(u=>!u.packId&&!u.assignment&&u.status==='available').map(u=>String(u._id||u.unitId));
    if(selected.length<2)selectionError=tr('At least two available, unpacked pieces are needed. Existing packs stay unchanged; approve any pieces awaiting inspection first.','مطلوب قطعتان متاحتان وغير مجمعتين على الأقل. الباكات القديمة كما هي؛ اعتمد القطع التي تنتظر الفحص أولًا إن وجدت.');
  }
  const el=id=>dialog.querySelector('#'+id);
  const actor=()=>String(typeof currentUser!=='undefined'?(currentUser?._id||currentUser?.id||currentUser?.userId||''): '');
  const storageKey=()=>`soulia-pack-pending:${actor()}`;
  const request=(path,body)=>api('/inventory-packs'+path,body?{method:'POST',body:JSON.stringify(body),background:true}:{background:true});
  function notice(text,error=false){el('ip-message').classList.remove('iu-print-success');el('ip-message').textContent=text;el('ip-message').dataset.error=String(error);}
  const disabledBefore=new WeakMap();
  function lock(value){busy=value;dialog.querySelectorAll('button,input,select').forEach(e=>{if(value){disabledBefore.set(e,e.disabled);e.disabled=true;}else if(disabledBefore.has(e)){e.disabled=disabledBefore.get(e);disabledBefore.delete(e);}});if(!value){summary();el('ip-retry').hidden=!pending();}}
  function pending(){try{return JSON.parse(sessionStorage.getItem(storageKey())||'null');}catch{return null;}}
  async function write(path,body){
    if(actor()!==openingActor)throw new Error(tr('Account changed. Reopen packs.','تغير الحساب. افتح الباكات مجددًا.'));
    const previous=pending();
    if(previous&&(previous.path!==path||JSON.stringify(previous.body)!==JSON.stringify(body)))throw new Error(tr('Retry the pending request first.','أعد محاولة العملية المعلقة أولًا.'));
    const ownStorageKey=storageKey();sessionStorage.setItem(ownStorageKey,JSON.stringify({path,body}));
    try{const result=await request(path,body);sessionStorage.removeItem(ownStorageKey);if(actor()!==openingActor)throw new Error(tr('Account changed. Reopen packs.','تغير الحساب. افتح الباكات مجددًا.'));return result;}
    catch(error){
      // A timeout may hide a committed transaction. Keep exactly the same payload for retries.
      if(error.status>=400&&error.status<500&&![408,429].includes(Number(error.status)))sessionStorage.removeItem(ownStorageKey);
      throw error;
    }
  }
  function matchesPendingCreate(p,size,remainder){
    if(p?.path!==''||!Array.isArray(p.body?.unitIds))return false;
    const ids=values=>JSON.stringify(values.map(String).map(id=>id.toLowerCase()).sort());
    return ids(p.body.unitIds)===ids(selected)&&Number(p.body.piecesPerPack)===size&&p.body.remainder===(remainder?'leave-single':'reject');
  }
  async function recoverPendingCreate(){
    const p=pending();if(p?.path!==''||!p.body?.operationKey)return;
    const ownDialog=dialog,ownActor=openingActor,ownStorageKey=storageKey();
    notice(tr('Checking the previous pack request…','جارٍ التحقق من عملية الباكات السابقة…'));
    const response=await request('/operations/'+encodeURIComponent(p.body.operationKey));
    if(dialog!==ownDialog||actor()!==ownActor)return;
    if(response.state==='resolved'&&Array.isArray(response.result?.packs)){
      if(JSON.stringify(pending())!==JSON.stringify(p))return;
      sessionStorage.removeItem(ownStorageKey);
      const packs=response.result.packs;
      if(scope&&packs.every(pack=>String(pack.productId)===scope.productId&&warehouseCode(pack.warehouseCode)===scope.warehouseCode)){
        rememberCreation(response.result);
        currentPacks=packs.map(pack=>({...pack,product:pack.product||{name:scope.name,code:scope.sku}}));showHistory=false;
        const consumed=new Set(p.body.unitIds.map(String));selected=selected.filter(id=>!consumed.has(id));
        selectionError=selected.length<2?tr('The previous packs are already created. Select other unpacked pieces to create more.','الباكات السابقة أُنشئت بالفعل. حدد قطعًا أخرى غير مجمعة لإنشاء المزيد.'):'';
      }
      window.InventoryUnitLabels?.refreshAfterPackChange?.();await list();
      notice(tr(`Recovered ${packs.length} previously created pack(s). No duplicates were created.`,`تم استرجاع ${packs.length} باك سبق إنشاؤه، دون إنشاء نسخ مكررة.`));
    }else{
      const s=summary();
      notice(matchesPendingCreate(p,s.size,s.remainder)?tr('A previous attempt is unconfirmed. Choose Resume pack creation to safely continue the same request.','هناك محاولة سابقة غير مؤكدة. اضغط «استكمال إنشاء الباكات» لإكمال نفس الطلب بأمان.'):tr('A different request is pending. Use Retry pending request to resolve it before creating another pack.','توجد عملية معلقة بتحديد مختلف. اضغط «إعادة العملية المعلقة» لحسمها قبل إنشاء باكات جديدة.'));
    }
  }
  function summary(){
    const size=Number(el('ip-size').value),valid=Number.isInteger(size)&&size>=2&&size<=1000;
    const count=valid?Math.floor(selected.length/size):0,remainder=valid?selected.length%size:0;
    const completed=!!creationSummary&&!selected.length;
    const shownPieces=completed?creationSummary.pieces:selected.length,shownPacks=completed?creationSummary.packs:count,
      shownSize=completed?creationSummary.size:valid?size:'—',shownRemainder=completed?creationSummary.remainder:remainder;
    const icons={pieces:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',packs:'<path d="m12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5"/>',size:'<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',remainder:'<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 12h6"/>'};
    const metric=(kind,value,label)=>`<div class="ip-metric ip-metric-${kind}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[kind]}</svg><strong dir="ltr">${esc(value)}</strong><span>${esc(label)}</span></div>`;
    const explanation=completed?tr(`Created ${shownPacks} packs containing ${shownPieces} pieces. Each pack has ${shownSize} pieces.`,`تم تجميع ${shownPieces} قطعة في ${shownPacks} باكات، كل باك يحتوي على ${shownSize} قطع.`):!selected.length?tr('Select pieces of the same product to calculate the packs.','حدد قطعًا من نفس المنتج لحساب الباكات.') : !valid?tr('Enter a valid number of pieces per pack.','أدخل عددًا صحيحًا للقطع في كل باك.') : !count?tr('The selection is not enough for one full pack.','القطع المحددة لا تكفي لتكوين باك كامل.') : tr('Selected pieces will form equal packs. Any remainder stays as individual pieces.','تُوزّع القطع المحددة على باكات متساوية، وتبقى أي قطع زائدة منفردة.');
    el('ip-summary').setAttribute('aria-live','polite');el('ip-summary').setAttribute('aria-atomic','true');
    el('ip-summary').innerHTML=`<div class="ip-metrics${shownRemainder?' has-remainder':''}">${metric('pieces',shownPieces,completed?tr('Packed pieces','القطع المجمعة'):tr('Selected pieces','القطع المحددة'))}${metric('packs',shownPacks,completed?tr('Packs created','الباكات المنشأة'):tr('Packs to create','الباكات الناتجة'))}${metric('size',shownSize,tr('Pieces per pack','قطع في كل باك'))}${shownRemainder?metric('remainder',shownRemainder,tr('Left as singles','قطع متبقية')):''}</div><p class="ip-calculation-help">${esc(explanation)}</p>`;
    el('ip-remainder-wrap').hidden=completed||!remainder;
    el('ip-size').disabled=busy||completed;
    el('ip-remainder-text').textContent=tr(`Leave ${remainder} piece(s) unpacked`, `اترك ${remainder} قطعة منفردة دون باك`);
    const p=pending(),resume=matchesPendingCreate(p,size,remainder);
    el('ip-create').disabled=busy||!!selectionError||!scope||!permitted('inventory-units-allocate')||!count||!!(p&&!resume)||!!(remainder&&!el('ip-remainder').checked);
    el('ip-create').textContent=completed?tr('Packs created','تم إنشاء الباكات'):resume?tr('Resume pack creation','استكمال إنشاء الباكات'):tr('Create packs','إنشاء الباكات');
    el('ip-create').title=selectionError||p&&!resume?selectionError||tr('Resolve the previous request first.','احسم نتيجة العملية السابقة أولًا.') : '';
    return {size,count,remainder,valid};
  }
  async function list(){
    el('ip-history-toggle').textContent=showHistory?tr('Back to new packs','العودة للباكات الجديدة'):tr('View previous packs','عرض الباكات السابقة');
    el('ip-history-toggle').setAttribute('aria-expanded',String(showHistory));
    el('ip-list-title').textContent=showHistory?tr('Previous packs','الباكات السابقة'):tr('Created in this operation','الباكات المنشأة الآن');
    el('ip-search').parentElement.hidden=!showHistory;
    el('ip-prev').parentElement.hidden=!showHistory;
    el('ip-list').hidden=!showHistory&&!currentPacks.length;
    el('ip-list-title').hidden=!showHistory&&!currentPacks.length;
    el('ip-paper').parentElement.hidden=!showHistory&&!currentPacks.length;
    if(!scope){total=0;el('ip-list').innerHTML=`<p class="ip-empty">${esc(selectionError)}</p>`;el('ip-page').textContent='0 / 0';el('ip-prev').disabled=true;el('ip-next').disabled=true;return;}
    const data=showHistory?await request('?'+new URLSearchParams({page:String(page),q:el('ip-search').value.trim(),productId:scope.productId,warehouseCode:scope.warehouseCode,visibility:'available-prepared'})):{packs:currentPacks.filter(pack=>pack.state==='sealed'&&['available','prepared'].includes(pack.availabilityStatus)),total:currentPacks.filter(pack=>pack.state==='sealed'&&['available','prepared'].includes(pack.availabilityStatus)).length};total=data.total;
    el('ip-list').innerHTML=data.packs.length?data.packs.map(p=>`<div class="ip-row"><input type="checkbox" data-pack-id="${esc(p._id)}" ${p.state!=='sealed'?'disabled':''} aria-label="${esc(p.barcode)}"><div class="ip-info"><strong>${esc(p.product?.name||p.productId)}</strong><small class="ip-code" dir="ltr">${esc(p.manualCode || p.barcode)}</small>${packInvoiceHtml(p)}${packStateHtml(p)}</div><span class="ip-count">${Number(p.quantity)} ${tr('pieces','قطع')}</span><div class="ip-actions"><button type="button" data-preview="${esc(p._id)}" ${p.state!=='sealed'?'disabled':''}>${tr('Label','الملصق')}</button>${permitted('inventory-units-allocate')&&p.state==='sealed'?`<button type="button" data-open="${esc(p.barcode)}">${tr('Ungroup pack','فك الباك')}</button>`:''}</div></div>`).join(''):`<p>${tr('No available or prepared packs.','لا توجد باكات متاحة للبيع أو مجهزة.')}</p>`;
    el('ip-page').textContent=`${page} / ${Math.max(1,Math.ceil(total/30))}`;
    el('ip-list').scrollTop=0;
    el('ip-prev').disabled=page===1;el('ip-next').disabled=page*30>=total;
  }
  function packInvoiceHtml(pack){
    if(!Array.isArray(pack.purchaseInvoices))return '';
    const icon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 7h6M9 11h6M9 15h3"/></svg>';
    return `<div class="ip-invoice-refs">${pack.purchaseInvoices.map(invoice=>`<span class="ip-invoice-ref">${icon}<span>${tr('Invoice','فاتورة')} <bdi>#${esc(invoice.ref||tr('Unnumbered','بدون رقم'))}</bdi>${pack.purchaseInvoices.length>1?` · ${Number(invoice.quantity)} ${tr('pieces','قطع')}`:''}</span></span>`).join('')}${pack.unlinkedPieces?`<small>${tr('Pieces without a linked purchase invoice: ','قطع دون فاتورة شراء مرتبطة: ')}${Number(pack.unlinkedPieces)}</small>`:''}</div>`;
  }
  function packStateHtml(pack){
    const names={available:['Available','متاح'],reserved:['Reserved','محجوز'],picking:['Preparing','قيد التحضير'],prepared:['Prepared','مجهز'],shipped:['Shipped','مع شركة الشحن'],delivered:['Delivered','تم التسليم'],returned:['Returned','مرتجع للمخزن'],'inspection-required':['Awaiting inspection','بانتظار الفحص'],damaged:['Damaged','تالف'],'supplier-return-pending':['Pending supplier return','محجوز لمرتجع مورد'],'returned-to-supplier':['Returned to supplier','مرتجع للمورد'],lost:['Lost','مفقود'],retired:['Retired','مستبعد'],mixed:['Mixed piece statuses','حالات قطع مختلفة'],incomplete:['Membership needs review','عضوية الباك تحتاج مراجعة'],opened:['Ungrouped · label inactive','مفكوك · الملصق غير فعال'],unknown:['Status needs refresh','الحالة تحتاج تحديثًا']};
    const status=pack.state!=='sealed'?'opened':pack.availabilityStatus||'unknown';
    const label=key=>names[key]?tr(...names[key]):tr('Needs review','تحتاج مراجعة');
    return `<div class="ip-pack-status"><span class="ip-status-badge" data-status="${esc(status)}"><i aria-hidden="true"></i>${esc(label(status))}</span>${status==='mixed'?`<small>${(pack.statusCounts||[]).map(row=>esc(label(row.status))+' · '+Number(row.quantity)).join(' / ')}</small>`:''}${status!=='opened'?(pack.assignedOrders||[]).map(order=>`<small>${tr('Customer order','طلب العميل')}${order.ref?` <bdi>#${esc(order.ref)}</bdi>`:''}</small>`).join(''):''}</div>`;
  }
  async function preview(ids){
    const sizeId=el('ip-paper').value;
    if(!sizeId)throw new Error(tr('Choose label dimensions.','اختر مقاس الملصق.'));
    batch=window.InventoryUnitLabels.validateBatch(await request('/labels/preview',{packIds:ids,sizeId,operationKey:key(),reason:'Preview sealed pack labels'}),ids,sizeId);
    el('ip-preview').innerHTML=window.InventoryUnitLabels.previewSheets(batch);
    await window.InventoryUnitLabels.waitForLayout(el('ip-preview'));
    el('ip-print').hidden=!permitted('inventory-units-print');
  }
  async function printing(){
    if(!batch||!permitted('inventory-units-print'))return;
    let popup=window.open('','_blank','width=800,height=700');
    if(!popup)throw new Error(tr('Allow popups for printing.','اسمح بالنوافذ المنبثقة للطباعة.'));
    try{
      const ids=batch.labels.map(l=>l.unitId),sizeId=batch.size.id;
      const retry=pending();
      if(!retry){
        batch=window.InventoryUnitLabels.validateBatch(await request('/labels/preview',{packIds:ids,sizeId,operationKey:key(),reason:'Check print history before printing pack labels'}),ids,sizeId);
        const reprints=batch.labels.filter(label=>Number(label.printCount)>0);
        if(reprints.length){popup.close();popup=await window.InventoryUnitLabels.confirmReprint(reprints);if(!popup){notice(tr('Reprint cancelled.','تم إلغاء إعادة الطباعة.'));return;}}
      }
      const result=await write('/labels/requests',retry?.path==='/labels/requests'?retry.body:{packIds:ids,sizeId,operationKey:key(),reason:'Print sealed pack labels; physical output unverified'});
      window.InventoryUnitLabels.validateBatch(result,ids,sizeId);batch=result;
      const size=result.size;
      popup.document.write(`<!doctype html><html dir="ltr"><head><meta charset="utf-8"><title>Pack labels</title><link rel="stylesheet" href="${location.origin}/inventory-units.css"><link rel="stylesheet" href="${location.origin}/inventory-packs.css"><style>@page{size:${size.widthMm}mm ${size.heightMm}mm;margin:0}html,body{margin:0;padding:0;width:${size.widthMm}mm;background:white}.iu-print-sheet{width:${size.widthMm}mm;height:${size.heightMm}mm;break-after:page;overflow:hidden}.iu-print-sheet:last-child{break-after:auto}.iu-label{margin:0!important;transform:none!important}</style></head><body>${result.labels.map(l=>`<section class="iu-print-sheet">${window.InventoryUnitLabels.labelHtml(l,size)}</section>`).join('')}</body></html>`);
      popup.document.close();
      await Promise.all([...popup.document.querySelectorAll('link')].map(link=>link.sheet?Promise.resolve():new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Print stylesheet timeout')),15000);link.onload=()=>{clearTimeout(timer);resolve();};link.onerror=()=>{clearTimeout(timer);reject(new Error('Print stylesheet unavailable'));};})));
      await window.InventoryUnitLabels.waitForLayout(popup.document);popup.focus();popup.print();
      el('ip-preview').innerHTML=window.InventoryUnitLabels.previewSheets(batch);window.InventoryUnitLabels.printSuccess(batch.labels.length,el('ip-message'));
    }catch(error){if(popup&&!popup.closed)popup.close();throw error;}
  }
  async function run(work){if(busy)return;lock(true);try{await work();}catch(error){notice(error.message||String(error),true);}finally{lock(false);}}
  function confirmOpenPack(){
    return new Promise(resolve=>{
      const prompt=document.createElement('dialog');prompt.className='ip-confirm-dialog';prompt.dir=tr('ltr','rtl');prompt.setAttribute('aria-labelledby','ip-open-title');
      prompt.innerHTML=`<h2 id="ip-open-title">${tr('Ungroup this pack?','فك تجميع الباك؟')}</h2><p>${tr('Handle each piece separately using its existing piece code.','ستتعامل مع كل قطعة منفردة باستخدام كودها الحالي.')}</p><ul><li>${tr('The pack barcode will stop working.','سيتوقف باركود الباك عن العمل.')}</li><li>${tr('Piece codes, quantities and statuses stay unchanged.','أكواد القطع وكمياتها وحالاتها تبقى كما هي.')}</li></ul><footer><button type="button" data-cancel>${tr('Cancel','إلغاء')}</button><button type="button" data-confirm>${tr('Confirm ungrouping','تأكيد فك الباك')}</button></footer>`;
      document.body.append(prompt);prompt.addEventListener('close',()=>{const confirmed=prompt.returnValue==='confirm';prompt.remove();resolve(confirmed);},{once:true});
      prompt.querySelector('[data-cancel]').onclick=()=>prompt.close('cancel');prompt.querySelector('[data-confirm]').onclick=()=>prompt.close('confirm');prompt.showModal();prompt.querySelector('[data-cancel]').focus();
    });
  }
  function show(){
    if(busy||!permitted('inventory-units-view'))return;
    const selection=window.InventoryUnitLabels?.selection();if(!selection?.ready||selection.busy)return;
    openingActor=actor();selected=[...selection.ids];selectionContext(selection);batch=null;page=1;currentPacks=[];showHistory=false;creationSummary=null;
    dialog?.remove();dialog=document.createElement('dialog');dialog.className='ip-dialog';dialog.dir=tr('ltr','rtl');
    dialog.innerHTML=`<div class="ip-head"><h2>${tr('Ready-made packs','الباكات الجاهزة')}</h2><button type="button" id="ip-close">${tr('Close','إغلاق')}</button></div><div class="ip-create"><label>${tr('Pieces per pack','عدد القطع في الباك')}<input id="ip-size" type="number" min="2" max="1000" value="6"></label><div id="ip-summary" class="ip-summary"></div><button id="ip-create" class="btn btn-primary" type="button">${tr('Create packs','إنشاء الباكات')}</button><label id="ip-remainder-wrap" class="ip-remainder"><input id="ip-remainder" type="checkbox"><span id="ip-remainder-text"></span></label></div><p class="iu-help">${tr('Select received pieces of one product first. Grouping preserves stock and inspection status.','حدد القطع المستلمة من صنف واحد أولًا. التجميع يحافظ على رصيد المخزون وحالة الفحص.')}</p><div class="ip-toolbar"><input id="ip-search" placeholder="${tr('Pack code','كود الباك')}" aria-label="${tr('Search packs','بحث الباكات')}"><button id="ip-search-btn" type="button">${tr('Search','بحث')}</button><button id="ip-retry" type="button" ${pending()?'':'hidden'}>${tr('Retry pending request','إعادة العملية المعلقة')}</button></div><div id="ip-list" class="ip-list"></div><div class="ip-toolbar"><button id="ip-prev" type="button">${tr('Previous','السابق')}</button><span id="ip-page"></span><button id="ip-next" type="button">${tr('Next','التالي')}</button></div><div class="ip-toolbar"><select id="ip-paper" aria-label="${tr('Label dimensions','مقاس الملصق')}">${selection.config.labelSizes.map(s=>`<option value="${esc(s.id)}" ${s.id===selection.sizeId?'selected':''}>${esc(s.id)} mm</option>`).join('')}</select><button id="ip-print" class="btn btn-primary" type="button" hidden>${tr('Print labels','طباعة الملصقات')}</button></div><p id="ip-message" class="ip-message" role="status"></p><div id="ip-preview" class="ip-preview"></div>`;
    dialog.setAttribute('aria-label',tr('Ready-made packs','الباكات الجاهزة'));
    const historyBar=document.createElement('div');historyBar.className='ip-history-bar';
    historyBar.innerHTML=`<strong id="ip-list-title" hidden></strong><button type="button" id="ip-history-toggle" aria-controls="ip-list" aria-expanded="false">${tr('View previous packs','عرض الباكات السابقة')}</button>`;
    el('ip-search').parentElement.before(historyBar);historyBar.append(el('ip-retry'));
    document.body.append(dialog);dialog.showModal();
    el('ip-size').value=String(Math.max(2,Math.min(6,selected.length||6)));
    const savedRequest=pending();
    if(savedRequest?.path===''&&Array.isArray(savedRequest.body?.unitIds)&&JSON.stringify(savedRequest.body.unitIds.map(String).sort())===JSON.stringify([...selected].sort())&&Number.isInteger(savedRequest.body.piecesPerPack)&&savedRequest.body.piecesPerPack>=2&&savedRequest.body.piecesPerPack<=1000){
      el('ip-size').value=String(savedRequest.body.piecesPerPack);el('ip-remainder').checked=savedRequest.body.remainder==='leave-single';
    }
    const context=document.createElement('div');context.className='ip-context';context.innerHTML=scope?`<strong dir="auto">${esc(scope.name||scope.sku)}</strong><small>${esc(scope.sku)} · ${esc(window.SouliaWarehouses?.name(scope.warehouseCode)||scope.warehouseCode)}</small>`:`<strong>${tr('Select pieces first','حدد القطع أولًا')}</strong>`;dialog.querySelector('.ip-head').after(context);
    if(scope&&(packedExcluded||unavailableExcluded)){const note=document.createElement('p');note.className='iu-help';note.textContent=tr(`Eligible for new packs: ${selected.length}. Already packed: ${packedExcluded}. Unavailable: ${unavailableExcluded}. Existing packs will stay unchanged.`,`المتاح لباكات جديدة: ${selected.length} · داخل باكات بالفعل: ${packedExcluded} · غير متاح: ${unavailableExcluded}. الباكات السابقة لن تتغير.`);context.append(note);}
    dialog.querySelector('.ip-create').nextElementSibling.textContent=tr('One product · one warehouse · available pieces only. Pieces already in packs are excluded automatically. Stock quantities stay unchanged.','منتج واحد · مخزن واحد · قطع متاحة فقط. تُستبعد القطع الموجودة داخل باكات تلقائيًا. التجميع لا يغير رصيد المخزون.');
    if(selectionError)notice(selectionError,true);summary();
    el('ip-close').onclick=()=>{if(!busy)dialog.close();};dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
    el('ip-size').oninput=()=>{el('ip-remainder').checked=false;summary();};
    el('ip-remainder').onchange=summary;
    el('ip-create').onclick=()=>run(async()=>{
      const s=summary();if(!s.valid||!s.count)throw new Error(tr('Select enough pieces and a valid pack size.','حدد قطعًا كافية وعددًا صحيحًا للباك.'));
      if(selectionError||!scope)throw new Error(selectionError||tr('Select one product first.','حدد منتجًا واحدًا أولًا.'));
      if(s.remainder&&!el('ip-remainder').checked)throw new Error(tr('Confirm the remaining single pieces.','أكد ترك القطع المتبقية منفردة.'));
      const p=pending();
      const result=await write('',matchesPendingCreate(p,s.size,s.remainder)?p.body:{unitIds:selected,piecesPerPack:s.size,remainder:s.remainder?'leave-single':'reject',operationKey:key(),reason:'Group received physical pieces into sealed ready-made packs'});
      rememberCreation(result);
      currentPacks=result.packs.map(p=>({...p,product:p.product||{name:scope.name,code:scope.sku}}));showHistory=false;selected=[];summary();window.InventoryUnitLabels.refreshAfterPackChange?.();await list();await preview(result.packs.map(p=>p._id));notice(tr(`Created ${result.packs.length} packs. Stock unchanged.`,`تم إنشاء ${result.packs.length} باكات دون تغيير المخزون.`));
    });
    el('ip-retry').onclick=()=>run(async()=>{const p=pending();if(!p)return;const result=await write(p.path,p.body);el('ip-retry').hidden=true;if(p.path===''){rememberCreation(result);currentPacks=result.packs.map(pack=>({...pack,product:pack.product||{name:scope.name,code:scope.sku}}));showHistory=false;selected=[];summary();await preview(result.packs.map(r=>r._id));}notice(tr('Request recovered. Preview and print labels if needed.','تم استرجاع العملية. عاين الملصقات واطبعها عند الحاجة.'));await list();});
    el('ip-search-btn').onclick=()=>run(async()=>{page=1;await list();});
    el('ip-history-toggle').onclick=()=>run(async()=>{showHistory=!showHistory;page=1;el('ip-search').value='';batch=null;el('ip-preview').replaceChildren();el('ip-print').hidden=true;await list();});
    el('ip-search').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();el('ip-search-btn').click();}};
    el('ip-prev').onclick=()=>run(async()=>{page=Math.max(1,page-1);await list();});el('ip-next').onclick=()=>run(async()=>{page++;await list();});
    el('ip-list').onchange=event=>{if(!event.target.matches('[data-pack-id]'))return;run(async()=>{
      const ids=[...dialog.querySelectorAll('[data-pack-id]:checked')].map(c=>c.dataset.packId);
      if(ids.length)await preview(ids);
      else{batch=null;el('ip-preview').replaceChildren();el('ip-print').hidden=true;}
    });};
    el('ip-paper').onchange=()=>run(async()=>{
      const checked=[...dialog.querySelectorAll('[data-pack-id]:checked')].map(c=>c.dataset.packId);
      const ids=checked.length?checked:(batch?.labels||[]).map(label=>label.unitId);
      batch=null;el('ip-preview').replaceChildren();el('ip-print').hidden=true;
      if(ids.length)await preview(ids);
    });
    el('ip-print').onclick=()=>run(printing);
    el('ip-list').onclick=e=>{const button=e.target.closest('button');if(!button)return;if(button.dataset.preview)run(()=>preview([button.dataset.preview]));if(button.dataset.open)run(async()=>{if(!await confirmOpenPack())return;await write('/'+encodeURIComponent(button.dataset.open)+'/open',{operationKey:key(),reason:'Operator opened physical sealed pack'});currentPacks=currentPacks.map(pack=>pack.barcode===button.dataset.open?{...pack,state:'opened'}:pack);batch=null;el('ip-preview').replaceChildren();el('ip-print').hidden=true;await list();notice(tr('Pack ungrouped. Use the existing codes of its individual pieces.','تم فك الباك. استخدم الأكواد الحالية للقطع المنفردة.'));});};
    run(async()=>{await list();await recoverPendingCreate();});
  }
  function mount(){const anchor=document.getElementById('iu-preview');if(!anchor||document.getElementById('ip-launch'))return;const button=document.createElement('button');button.type='button';button.id='ip-launch';button.className='btn btn-outline ip-pack-button';button.textContent=tr('Ready-made packs','الباكات الجاهزة');button.onclick=show;anchor.after(button);}
  new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});mount();
})();
