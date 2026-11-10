(function () {
  'use strict';
  const tr = (ar, en) => typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ar;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const amount = value => (typeof fmtMoneyN === 'function' ? fmtMoneyN(value || 0) : Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })) + ' ' + tr('ج', 'EGP');
  const date = value => value ? (typeof fmtDateTime === 'function' ? fmtDateTime(value) : new Date(value).toLocaleString('en-GB', { timeZone: 'Africa/Cairo' })) : '—';
  const key = () => 'after-sales:' + crypto.randomUUID();
  const admin = () => typeof isAdmin === 'function' && isAdmin();
  const allowed = perm => admin() || typeof hasPerm === 'function' && hasPerm(perm);
  function productCard(item) {
    const catalog = typeof products !== 'undefined' && Array.isArray(products) ? products.find(p => p._id === item.productId || p.code === item.code) : null;
    const name = item.name || catalog?.name || item.code || tr('منتج','Product');
    const url = item.imageUrl || catalog?.imageUrl || catalog?.images?.[0] || '';
    const safe = /^(https?:\/\/|\/(?!\/)|data:image\/(png|jpeg|webp|gif);base64,)/i.test(url);
    return `<div class="as-product"><span class="as-thumb">${safe ? `<img src="${esc(url)}" alt="${esc(name)}" loading="lazy" onerror="this.hidden=true">` : '<span aria-hidden="true">▧</span>'}</span><span class="as-product-info"><strong>${esc(name)}</strong><small>${esc(item.code || catalog?.code || '')}</small></span></div>`;
  }
  function exchangeSummary(items, replacements) {
    const from = (items||[]).reduce((n,i)=>n+Number(i.qty||0),0), to = (replacements||[]).reduce((n,i)=>n+Number(i.qty||0),0);
    return `<div class="as-banner as-exchange-summary">${from===1&&to===1 ? tr('استبدال قطعة بقطعة','One piece for one piece') : tr(`استبدال ${from} قطعة بـ ${to} قطعة`,`Exchange ${from} piece(s) for ${to} piece(s)`)}</div>`;
  }
  function operationIcon(kind) {
    return kind==='exchange'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 13-5-5 5-5M4 8h10a6 6 0 0 1 0 12h-3"/></svg>';
  }
  function formIcon(name) {
    const paths={box:'M21 8l-9 5-9-5m9 5v9M3 8l9-5 9 5v10l-9 4-9-4V8Z',wallet:'M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v12H5a2 2 0 0 1-2-2V6m17 7h-5v4h5',note:'M8 3H5v18h14V7l-4-4H8Zm6 0v5h5M7 12h8m-8 4h6',calendar:'M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z',truck:'M14 7h4l4 5v6h-3m-5 0H9m-6 0H2V4h12v14M7 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm12 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM14 12h8',warehouse:'m3 10 9-7 9 7v11H3V10Zm5 11V11h8v10M8 15h8',check:'m5 12 4 4L19 6',plus:'M12 5v14M5 12h14',user:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-3a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v3',alert:'M12 8v5m0 4h.01M10 3 2 19h20L14 3h-4Z',back:'m14 6-6 6 6 6',close:'m6 6 12 12M6 18 18 6'};
    if(name==='return'||name==='exchange')return operationIcon(name).replace('<svg ','<svg class="as-form-icon pm-select-icon" ');
    return `<svg class="as-form-icon pm-select-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.box}"/></svg>`;
  }
  function selectIcon(value) {
    return formIcon(({bosta:'truck',direct:'warehouse','customer-choice':'user',defect:'alert','wrong-item':'box'})[value]||value);
  }
  function requestSelect(name,label,options) {
    return `<div class="as-field"><span id="as-label-${name}">${label}</span><select name="${name}" data-icons="after-sales" aria-labelledby="as-label-${name}">${Object.entries(options).map(([value,text])=>`<option value="${value}">${text}</option>`).join('')}</select></div>`;
  }
  function operationIconButton(caseId, kind, detail='') {
    const label=tr(kind==='exchange'?'استبدال':'استرجاع',kind==='exchange'?'Exchange':'Return');
    const description=[label,detail].filter(Boolean).join(' · ');
    return `<button type="button" class="as-operation-icon as-operation-${kind==='exchange'?'exchange':'return'}" onclick="event.stopPropagation();AfterSales.open('${esc(caseId)}')" aria-label="${esc(description)}" title="${esc(description)}">${operationIcon(kind)}</button>`;
  }
  function shippingBadges(tx, compact=false) {
    return Object.values(tx.afterSales?.shipments || {}).filter(s => s.deliveryId).map(s => {
      const meta = SouliaOrderStatus.resolve({bostaOrderId:s.deliveryId,bostaStatus:s.status,shipCo:'Bosta'},'transaction',tr('ar','en'));
      const label = meta.label;
      if(compact)return operationIconButton(s.caseId,s.kind,[label,s.trackingNumber].filter(Boolean).join(' · '));
      return '<button type="button" class="as-badge as-shipment-badge" onclick="event.stopPropagation();AfterSales.open(&quot;'+esc(s.caseId)+'&quot;)" title="'+esc(s.trackingNumber||'')+'">'+tr(s.kind==='exchange'?'شحنة استبدال':'سحب مرتجع',s.kind==='exchange'?'Exchange shipment':'Return collection')+' · '+SouliaOrderStatus.badge(meta)+(s.trackingNumber?' · <span dir="ltr">'+esc(s.trackingNumber)+'</span>':'')+'</button>';
    }).join(' ');
  }
  function orderCases(tx) {
    const linked=tx?.afterSales;
    if(linked?.caseId)return [{...linked,kind:linked.kind||(linked.role==='replacement'?'exchange':'return')}];
    return Object.values(linked?.shipments||{}).filter(s=>s.caseId);
  }
  function orderBadge(tx, interactive=true) {
    return orderCases(tx).map(c=>{
      const label=tr(c.kind==='exchange'?'استبدال':'استرجاع',c.kind==='exchange'?'Exchange':'Return');
      const title=[label,c.caseRef,c.originalRef?'#'+c.originalRef:''].filter(Boolean).join(' · ');
      const content=operationIcon(c.kind)+'<span>'+label+'</span>';
      return interactive?`<button type="button" class="as-order-type" onclick="event.stopPropagation();AfterSales.open('${esc(c.caseId)}')" title="${esc(title)}">${content}</button>`:`<span class="as-order-type" title="${esc(title)}">${content}</span>`;
    }).join(' ');
  }
  function preparationDetails(tx) {
    return orderCases(tx).map(c=>`<section class="as-card as-preparation" data-as-preparation="${esc(c.caseId)}" data-as-view="${esc(navigationOwner()+':'+tr('ar','en'))}">
      <h3>${tr(c.kind==='exchange'?'طلب الاستبدال':'طلب الاسترجاع',c.kind==='exchange'?'Exchange request':'Return request')}</h3>
      <div class="as-prep-reference"><bdi>${esc(c.caseRef||'')}</bdi>${c.originalRef?'<span>'+tr('الفاتورة الأصلية','Original invoice')+' <bdi>#'+esc(c.originalRef)+'</bdi></span>':''}</div>
      <div data-as-preparation-content>${tr('جارٍ تحميل التفاصيل…','Loading details…')}</div>
      <div class="as-actions"><button type="button" class="pw-abtn" onclick="AfterSales.open('${esc(c.caseId)}')">${tr('فتح تفاصيل الطلب','Open request details')}</button><button type="button" class="pw-abtn" onclick="AfterSales.printOrderCase('${esc(c.caseId)}')">${tr('طباعة الطلب','Print request')}</button></div>
    </section>`).join('');
  }
  function preparationContent(row) {
    const exchange=row.requestKind==='exchange',q=row.workflow.quote;
    const lines=(items)=>`<ul class="as-prep-lines">${(items||[]).map(i=>`<li><span title="${esc(i.code||'')}">${esc(i.name||i.code)}</span><b><bdi>× ${esc(i.qty)}</bdi></b></li>`).join('')}</ul>`;
    const difference=exchange?(q.collectDue?tr('فرق مطلوب من العميل','Customer pays'):q.refundDue?tr('فرق يُرد للعميل','Customer refund'):tr('استبدال بدون فرق','No price difference')):tr('المستحق للعميل','Customer refund');
    return `<div class="as-prep-status">${esc(stage(row.workflow.stage,row.requestKind))}</div>
      <h4>${tr('القطع الراجعة','Returned items')}</h4>${lines(row.items)}
      <div class="as-prep-difference"><span>${difference}</span>${q.collectDue||q.refundDue?'<b><bdi>'+amount(q.collectDue||q.refundDue)+'</bdi></b>':''}</div>
      <details class="as-prep-more"><summary>${tr('الأصناف والمبالغ والتفاصيل','Items, amounts and details')}</summary><div>
      <p class="as-muted">${esc(reasonLabel(row.reason))}${row.reasonDetails?' · '+esc(row.reasonDetails):''}</p>
      ${exchange?'<h4>'+tr('القطع البديلة','Replacement items')+'</h4>'+lines(row.exchangeItems):''}${summary(q,row.requestKind)}</div></details>`;
  }
  const preparationLoads=new WeakMap();
  function loadPreparationSection(section,force=false) {
    let state=preparationLoads.get(section);
    if(!state){state={attempted:false,task:null,revision:0};preparationLoads.set(section,state);}
    if(force){state.revision++;state.attempted=false;}
    if(state.task)return state.task;
    if(state.attempted)return Promise.resolve();
    state.attempted=true;
    const revision=state.revision,owner=navigationOwner(),target=section.querySelector('[data-as-preparation-content]');
    state.task=(async()=>{
      try {
        const row=await api('/after-sales/'+encodeURIComponent(section.dataset.asPreparation),{background:true});
        if(!section.isConnected||owner!==navigationOwner()||revision!==state.revision)return;
        target.querySelector('[data-as-load-error]')?.remove();
        const markup=preparationContent(row),expanded=target.querySelector('details')?.open;
        if(target._asMarkup!==markup){target.innerHTML=markup;target._asMarkup=markup;if(expanded)target.querySelector('details').open=true;}
      } catch(error) {
        if(!section.isConnected||owner!==navigationOwner()||revision!==state.revision)return;
        // Keep a previously loaded summary visible if a later refresh fails.
        target.querySelector('[data-as-load-error]')?.remove();
        const errorNode=document.createElement('div');errorNode.dataset.asLoadError='';
        errorNode.innerHTML=`<p class="as-error">${esc(error.message)}</p><button type="button" class="pw-abtn" data-as-retry>${tr('إعادة المحاولة','Retry')}</button>`;
        if(!target._asMarkup)target.textContent='';target.appendChild(errorNode);
        errorNode.querySelector('button').onclick=()=>loadPreparationSection(section,true);
      } finally {
        state.task=null;
        if(!state.attempted&&section.isConnected&&owner===navigationOwner())await loadPreparationSection(section);
      }
    })();
    return state.task;
  }
  async function loadPreparationDetails(host) {
    await Promise.all([...host.querySelectorAll('[data-as-preparation]')].map(section=>loadPreparationSection(section)));
  }
  function refreshPreparationDetails(id) {
    return Promise.all([...document.querySelectorAll('[data-as-preparation]')].filter(section=>!id||section.dataset.asPreparation===String(id)).map(section=>loadPreparationSection(section,true)));
  }
  async function printOrderCase(id) {
    const popup=window.open('','_blank');
    if(!popup){alert(tr('اسمح بنافذة الطباعة.','Allow the print window.'));return;}
    popup.document.body.textContent=tr('جارٍ تحميل الطلب…','Loading request…');
    try { const row=await api('/after-sales/'+encodeURIComponent(id)); if(!popup.closed)await printCase(row,popup); }
    catch(error){if(!popup.closed)popup.close();alert(error.message);}
  }
  const stage = (v,kind) => v==='approved'&&kind==='return'?tr('معتمد — بانتظار سحب المرتجع','Approved — awaiting return collection'):({ requested:tr('بانتظار الموافقة','Awaiting approval'), approved:tr('معتمد — متابعة التجهيز','Approved — track preparation'), shipping:tr('قيد الشحن والاستلام','Shipping / receiving'), settlement:tr('بانتظار التسوية','Awaiting settlement'), closed:tr('مكتمل','Completed'), cancelled:tr('ملغي / مرفوض','Cancelled / rejected') }[v] || v);
  const reasonLabel = v => ({ 'customer-choice':tr('رغبة العميل','Customer preference'),defect:tr('عيب في المنتج','Product defect'),'wrong-item':tr('خطأ في المنتج المرسل','Wrong item sent') }[v]||v);
  const actionLabel = v => ({'step-rolled-back':tr('التراجع عن خطوة','Step undone'),'shipment-created':tr('إنشاء بوليصة بوسطة','Bosta waybill created'),'carrier-status':tr('تحديث حالة بوسطة','Bosta status updated'),requested:tr('تسجيل الطلب','Request submitted'),approved:tr('اعتماد الطلب','Request approved'),cancelled:tr('إلغاء الطلب','Case cancelled'),'shipment-requested':tr('طلب شحنة بوسطة','Bosta shipment requested'),'shipment-linked':tr('مطابقة البوليصة','Shipment reconciled'),'received-and-inspected':tr('استلام وفحص المرتجع','Return received and inspected'),'replacement-delivered':tr('تأكيد تسليم البديل','Replacement delivered'),'settlement:refund':tr('رد المبلغ للعميل','Customer refunded'),'settlement:collection':tr('تحصيل فرق العميل','Customer difference collected'),'settlement:carrier':tr('تسوية بوسطة','Carrier settled'),exception:tr('تسجيل مشكلة','Issue recorded'),'exception-resolved':tr('معالجة المشكلة','Issue resolved')}[v]||v);
  const reduceMotion=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let entrance=null,resizeMotion=null,closingMotion=null;
  function cancelDialogClose(){if(closingMotion){const pending=closingMotion;closingMotion=null;pending.animation.cancel();}dialog?.classList.remove('as-is-closing');if(dialog)window.SouliaMotion?.cancelClose(dialog);}
  function enterDialog(delay=0){
    cancelDialogClose();entrance?.cancel();entrance=null;
    if(reduceMotion())return;
    const animation=dialog.animate([{opacity:0,transform:'translateY(6px) scale(.99)'},{opacity:1,transform:'none'}],{duration:200,delay,easing:'cubic-bezier(.2,.8,.2,1)',fill:'backwards'});
    entrance=animation;animation.finished.then(()=>{if(entrance===animation)entrance=null;}).catch(()=>{});
  }
  function closeDialog(){
    if(typeof _pmSelClose==='function')_pmSelClose();
    if(!dialog?.open)return Promise.resolve();
    if(closingMotion)return closingMotion.task;
    serial++; // A late invoice/case response must not cancel the user's close.
    const style=getComputedStyle(dialog),opacity=style.opacity,transform=style.transform,height=dialog.offsetHeight+'px',width=dialog.offsetWidth+'px';
    entrance?.cancel();entrance=null;resizeMotion?.cancel();resizeMotion=null;
    if(reduceMotion()){dialog.close();return Promise.resolve();}
    dialog.classList.add('as-is-closing');
    const pending={animation:dialog.animate([{opacity,transform,height,width},{opacity:0,transform:'translateY(4px) scale(.99)',height,width}],{duration:140,easing:'ease-in'})};
    pending.task=pending.animation.finished.catch(()=>{}).then(()=>{if(closingMotion!==pending)return;closingMotion=null;dialog.close();});
    closingMotion=pending;return pending.task;
  }
  let dialog, serial = 0, busy = false, activeCase, activeInvoice, quoteSerial = 0, caseReturn = null;
  let complaintOrigin=null,suspendedView=null,activeCaseOwner='';
  const navigationOwner=()=>String(currentUser?._id||currentUser?.userId||'');
  const originKey=origin=>`${origin.complaintId}:`+(origin.caseId?`case:${origin.caseId}`:`create:${origin.invoiceId}:${origin.kind}:${origin.expectedComplaintRevision}`);
  function showComplaintNavigation(){
    if(complaintOrigin?.owner!==navigationOwner()){complaintOrigin=null;suspendedView=null;}
    dialog?.toggleAttribute('data-as-from-complaint',!!complaintOrigin);
    const head=el('.as-head');if(!head)return;
    head.querySelector('[data-as-complaint-nav]')?.remove();
    if(!complaintOrigin)return;
    el('.as-close')?.setAttribute('aria-label',tr('رجوع لملف الشكوى','Back to complaint'));
    const nav=document.createElement('div');nav.className='as-complaint-nav';nav.dataset.asComplaintNav='';
    nav.innerHTML=`<button type="button" class="btn btn-outline" data-as-back-complaint><span class="as-back-icon">${formIcon('back')}</span> ${tr('رجوع لملف الشكوى','Back to complaint')}</button><span><bdi>${esc(complaintOrigin.complaintNo||'')}</bdi><small>${tr('الشكوى / الاستبدال والاسترجاع','Complaint / returns and exchanges')}</small></span>`;
    nav.querySelector('button').onclick=backToComplaint;head.appendChild(nav);
  }
  function backToComplaint(){
    if(busy||!complaintOrigin)return;
    const origin=complaintOrigin;
    suspendedView={key:originKey(origin),owner:navigationOwner(),serial,top:(el('.as-create-content')||el('.as-body'))?.scrollTop||0};
    // Restore the complaint document before dismissing the execution overlay.
    const task=window.ComplaintFlow?.resume(origin.complaintId);
    if(document.querySelector('#page-complaint-detail.active')||document.querySelector('.cf-dialog[open]')){closeDialog();suspendedView.serial=serial;}
    return task;
  }
  function fromComplaint(origin){
    if(busy)return;
    const next={...origin,owner:navigationOwner()},key=originKey(next);
    const resume=suspendedView&&suspendedView.owner===next.owner&&suspendedView.key===key&&suspendedView.serial===serial&&dialog?.querySelector('form');
    complaintOrigin=next;
    if(resume){const top=suspendedView.top;suspendedView=null;showComplaintNavigation();if(!dialog.open)dialog.showModal();enterDialog();(el('.as-create-content')||el('.as-body')).scrollTop=top;el('[data-as-back-complaint]')?.focus({preventScroll:true});return;}
    if(suspendedView?.key===key)caseReturn={id:String(origin.caseId),top:suspendedView.top};
    suspendedView=null;
    return origin.caseId?open(origin.caseId,true):create(origin.invoiceId,origin.kind,origin);
  }
  function show(title, subtitle, html) {
    serial++;
    cancelDialogClose();
    if (!dialog) { dialog = document.createElement('dialog'); dialog.className = 'as-dialog'; document.body.appendChild(dialog); dialog.addEventListener('cancel', e => { e.preventDefault();if(!busy){if(complaintOrigin)backToComplaint();else closeDialog();} }); }
    const wasOpen = dialog.open;
    const previousHeight=wasOpen?dialog.offsetHeight:0,previousWidth=wasOpen?dialog.offsetWidth:0;
    resizeMotion?.cancel();resizeMotion=null;
    dialog.dir = tr('rtl','ltr'); dialog.setAttribute('aria-labelledby','as-title');
    dialog.innerHTML = `<header class="as-head"><div><h2 id="as-title">${esc(title)}</h2><p>${esc(subtitle || '')}</p></div><button type="button" class="as-close" aria-label="${tr('إغلاق','Close')}">×</button></header><div class="as-body"><div data-as-message role="status"></div>${html}</div>`;
    dialog.classList.toggle('as-compact', !!dialog.querySelector('form') && !dialog.querySelector('.as-grid, [data-as-report-results]'));
    dialog.classList.toggle('as-create-dialog',!!dialog.querySelector('[data-as-create],[data-as-create-loading]'));
    dialog.querySelector('.as-close').onclick = () => { if (!busy){if(complaintOrigin)backToComplaint();else closeDialog();} };
    showComplaintNavigation();
    if (!dialog.open) dialog.showModal();
    if(!wasOpen)enterDialog(dialog.querySelector('[data-as-create-loading]')?100:0);
    else if(!reduceMotion()){
      const nextHeight=dialog.offsetHeight,nextWidth=dialog.offsetWidth;
      const enteringVisible=!entrance||Number(entrance.currentTime)>=(entrance.effect?.getTiming().delay||0);
      if(enteringVisible&&(Math.abs(nextHeight-previousHeight)>1||Math.abs(nextWidth-previousWidth)>1)){resizeMotion=dialog.animate([{height:previousHeight+'px',width:previousWidth+'px'},{height:nextHeight+'px',width:nextWidth+'px'}],{duration:200,easing:'cubic-bezier(.2,.8,.2,1)'});resizeMotion.finished.catch(()=>{});}
      if(!entrance)dialog.querySelector('.as-body').animate?.([{opacity:0},{opacity:1}],{duration:160,easing:'ease-out'});
    }
    return serial;
  }
  const el = selector => dialog?.querySelector(selector);
  function message(text, error = true) {
    const node = el('[data-as-message]'); if (!node) return;
    let detail = String(text || '');
    if (/failed to fetch|network|timeout/i.test(detail)) detail = tr('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.','Unable to reach the server. Check your connection and retry.');
    node.className = 'as-banner ' + (error ? 'as-error' : 'as-success'); node.setAttribute('role', error ? 'alert' : 'status');
    node.innerHTML = `<strong>${error ? tr('لم يكتمل الإجراء','Action could not be completed') : tr('تمت العملية بنجاح','Action completed')}</strong><div>${esc(detail)}</div>`;
    node.scrollIntoView({ block:'nearest' });
  }
  const disabledBeforeBusy = new WeakMap();
  const busyLabels = new WeakMap();
  function setBusy(value) {
    busy = value; dialog?.setAttribute('aria-busy', String(value));
    dialog?.querySelectorAll('button').forEach(button => {
      if(value){if(!disabledBeforeBusy.has(button))disabledBeforeBusy.set(button,button.disabled);button.disabled=true;}
      else if(disabledBeforeBusy.has(button)){button.disabled=disabledBeforeBusy.get(button);disabledBeforeBusy.delete(button);}
      if(value&&button.type==='submit'&&!busyLabels.has(button)){busyLabels.set(button,button.innerHTML);button.textContent=tr('جارٍ حفظ الخطوة…','Saving this step…');}
      else if(!value&&busyLabels.has(button)){button.innerHTML=busyLabels.get(button);busyLabels.delete(button);}
    });
    if(!value&&refreshNeeded.size)void refresh([]);
  }
  function requestStorage(action, id) { return 'as-pending:' + String(typeof currentUser !== 'undefined' ? currentUser?._id || currentUser?.userId || currentUser?.username : '') + ':' + id + ':' + action; }
  async function post(action, id, body = {}) {
    const owner=navigationOwner();
    const storage = requestStorage(action,id || body.complaintId || body.originalTransactionId || ''); let pending;
    try { pending = JSON.parse(sessionStorage.getItem(storage) || 'null'); } catch {}
    if (!pending) { pending = { ...body, operationKey:key() }; sessionStorage.setItem(storage, JSON.stringify(pending)); }
    try {
      const result = await api('/after-sales' + (id ? '/' + id : '') + (action ? '/' + action : ''), { method:'POST', body:JSON.stringify(pending) });
      sessionStorage.removeItem(storage);
      if(owner!==navigationOwner())throw new Error(tr('تغيّر الحساب أثناء الحفظ؛ افتح الملف من الحساب الحالي.','The account changed while saving; reopen the case with the current account.'));
      return result;
    } catch (error) {
      if (Number(error.status) >= 400 && Number(error.status) < 500 && ![408,429].includes(Number(error.status))) sessionStorage.removeItem(storage);
      throw error;
    }
  }
  const refreshNeeded = new Set();
  let refreshTask;
  function refresh(datasets = ['returns','transactions','inventory','vault']) {
    datasets.forEach(dataset=>refreshNeeded.add(dataset));
    // Fold local socket echoes into the refresh after saving. Never make the
    // next case step wait for the full transaction history or inventory list.
    if(busy||refreshTask)return refreshTask;
    const owner=navigationOwner();
    refreshTask=(async()=>{
      while(refreshNeeded.size&&!busy&&owner===navigationOwner()){
        const requested=[...refreshNeeded];refreshNeeded.clear();
        await Promise.allSettled(requested.map(async dataset=>{
          if(dataset==='vault'){if(typeof syncVaultState==='function')await syncVaultState();return;}
          const rows=await api({returns:'/returns',transactions:'/transactions',inventory:'/transactions/inventory'}[dataset],{background:true});
          if(owner!==navigationOwner()||refreshNeeded.has(dataset))return;
          if(dataset==='returns'){returnRequests=rows;if(currentPage==='approvals')renderApprovals();}
          if(dataset==='transactions'){transactions=rows;if(currentPage==='movements')renderMovements();if(currentPage==='invoice-view')renderInvoiceViewPage();}
          if(dataset==='inventory'){inventoryCache=rows;if(currentPage==='inventory'&&typeof renderInventory==='function')renderInventory();}
        }));
        if(owner!==navigationOwner())break;
        if(typeof buildNotifications==='function')buildNotifications();
        if(typeof buildSidebar==='function')buildSidebar();
      }
    })().catch(error=>console.warn('After-sales background refresh',error)).finally(()=>{
      refreshTask=null;
      if(owner!==navigationOwner())refreshNeeded.clear();
      else if(refreshNeeded.size&&!busy)void refresh([]);
    });
    return refreshTask;
  }
  async function savedStep(result, id, datasets) {
    // Use the server's committed state, not an optimistic financial/stock update.
    await open(result?._id||id,false,result);
    refreshPreparationDetails(result?._id||id);
    window.InvoiceUnitIdentities?.changed(result?.originalTransactionId || activeInvoice?._id);
    void refresh(datasets);
  }
  function summary(q, kind = 'return') {
    const exchange = kind === 'exchange';
    if (!q) return `<p class="as-muted">${exchange ? tr('اختر القطع الراجعة والبديل لحساب فرق الاستبدال.','Select returned and replacement items to calculate the exchange difference.') : tr('اختر القطع المطلوب استرجاعها لحساب المبلغ المستحق للعميل.','Select returned items to calculate the customer refund.')}</p>`;
    return `<div class="as-summary" data-as-summary-kind="${kind}"><div><span>${tr('قيمة المنتجات الراجعة','Returned items value')}</span><b>${amount(q.credit)}</b></div>${exchange?`<div><span>${tr('قيمة البديل','Replacement value')}</span><b>${amount(q.replacement)}</b></div>`:''}<div><span>${exchange?tr('تكلفة الاستبدال','Exchange cost'):tr('تكلفة الاسترجاع المخصومة','Return cost deduction')}</span><b>${amount(q.customerFee)}</b></div><div class="as-total"><span>${!exchange ? tr('صافي المبلغ المستحق للعميل','Net customer refund') : q.collectDue ? tr('فرق مطلوب من العميل','Difference to collect') : q.refundDue ? tr('فرق يُرد للعميل','Difference to refund') : tr('استبدال بدون فرق','Exchange with no difference')}</span><b>${amount(q.collectDue || q.refundDue)}</b></div></div>`;
  }
  function flowSteps(row) {
    const w=row.workflow, exchange=row.requestKind==='exchange';
    const steps=[[exchange?tr('طلب استبدال','Exchange request'):tr('طلب استرجاع','Return request'),true,'status'],[tr('الاعتماد','Approval'),!!w.approvedAt,'approve']];
    if(exchange)steps.push([tr('البديل بانتظار التجهيز','Replacement awaiting prep'),!!w.replacementTxId,'orders'],[tr('تجهيز البديل','Prepare replacement'),['Preparing','Ready','Picked-Up','Shipped','Delivered'].includes(w.replacementPickupStatus)||!!w.shipment?.deliveryId,'orders']);
    if(w.fulfillmentChannel!=='direct')steps.push([exchange?tr('شحنة الاستبدال','Exchange shipment'):tr('شحنة سحب المرتجع','Return collection'),!!w.shipment?.deliveryId,'ship']);
    steps.push([tr('استلام وفحص الراجع','Receive and inspect return'),!!w.receivedAt,'receive']);
    if(exchange)steps.push([tr('تسليم البديل','Deliver replacement'),!!w.replacementDeliveredAt,'delivery']);
    if(w.quote.refundDue)steps.push([exchange?tr('رد فرق السعر','Refund difference'):tr('رد مبلغ العميل','Refund customer'),!!w.refund,'settle']);
    if(exchange&&w.quote.collectDue)steps.push([tr('تحصيل الفرق','Collect difference'),!!w.collection,'settle']);
    steps.push([tr('التسوية والإغلاق','Settle and close'),w.stage==='closed','settle']);
    const current=['closed','cancelled'].includes(w.stage)?-1:steps.findIndex(([,done])=>!done);
    const completed=steps.filter(([,done])=>done).length;
    return `<nav class="as-flow-nav" aria-label="${tr('مسار تنفيذ الطلب','Order workflow')}"><div class="as-flow-caption"><strong>${tr('خطوات الطلب','Case steps')}</strong><span>${completed} / ${steps.length}</span></div><progress value="${completed}" max="${steps.length}" aria-label="${tr('تقدم الطلب','Case progress')}"></progress><ol class="as-steps" data-as-flow="${row.requestKind}">${steps.map(([label,done,target],i)=>`<li class="as-step ${done?'is-done':i===current?'is-current':''}" ${i===current?'aria-current="step"':''}><button type="button" data-as-step="${target}" data-as-step-done="${done}" title="${tr('الانتقال إلى الخطوة','Go to step')}: ${esc(label)}"><b>${i+1}</b> ${label}</button></li>`).join('')}</ol></nav>`;
  }
  function nextAction(row) {
    const w=row.workflow;if(['closed','cancelled'].includes(w.stage))return '';
    let action, text;
    if(w.stage==='requested'){action='approve';text=tr('الطلب بانتظار اعتماد المسؤول قبل بدء التنفيذ.','Awaiting approval before processing.');}
    else if(['creating','reconcile'].includes(w.shipment?.status)){action='link-shipment';text=tr('طابق البوليصة الموجودة قبل أي إرسال جديد.','Reconcile the existing waybill before sending again.');}
    else if(row.requestKind==='exchange'&&!w.shipment&&!w.replacementPrepared){action='orders';text=tr('ابدأ تجهيز البديل المسجّل، وأكمل فحص القطع قبل الشحن.','Start preparing the registered replacement and complete the item checks before shipping.');}
    else if(w.fulfillmentChannel!=='direct'&&!w.shipment&&!w.receivedAt){action='ship';text=tr('راجع عنوان العميل وأنشئ طلب الشحنة لدى بوسطة.','Review the customer address and create the Bosta shipment.');}
    else if(!w.receivedAt){action='receive';text=tr('بعد وصول القطع فعليًا، سجل استلام المخزن وحالة كل قطعة.','Once the items physically arrive, record warehouse receipt and each item condition.');}
    else if(row.requestKind==='exchange'&&!w.replacementDeliveredAt){action='delivery';text=tr('أكد تسليم البديل للعميل بمرجع إثبات التسليم.','Confirm replacement delivery with proof of handover.');}
    else{action='settle';text=tr('سجل المدفوعات الفعلية وتكلفة الشحن لإكمال وإغلاق الطلب.','Record actual payments and shipping cost to complete and close the case.');}
    return `<section class="as-next-step"><strong>${tr('الإجراء التالي','Next action')}</strong><p>${text}</p></section>`;
  }
  function moveToCaseStep(button) {
    const target=button.dataset.asStep,done=button.dataset.asStepDone==='true';
    const section=target==='settle'?'financial':['ship','receive','delivery'].includes(target)?'shipment':'status';
    const actionButton=!done&&target!=='orders'?dialog.querySelector(`[data-as-action="${target}"]`):null;
    const destination=actionButton||(target==='orders'?el('[data-as-orders]'):null)||el(`[data-as-section="${section}"]`);
    if(!destination)return;
    destination.scrollIntoView({behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});
    destination.focus({preventScroll:true});
    destination.classList.add('as-step-target');
    setTimeout(()=>destination.classList.remove('as-step-target'),1400);
  }
  function financialStatus(row) {
    const w=row.workflow, exchange=row.requestKind==='exchange';
    return `<p class="as-muted">${w.quote.refundDue?`${exchange?tr('رد فرق السعر','Difference refunded'):tr('رد مبلغ العميل','Customer refund')}: ${w.refund?date(w.refund.at):tr('بانتظار الدفع الفعلي','Awaiting actual payment')}<br>`:''}${exchange&&w.quote.collectDue?`${tr('تحصيل الفرق','Difference collected')}: ${w.collection?date(w.collection.at):tr('بانتظار التحصيل','Awaiting collection')}<br>`:''}${tr('تكلفة بوسطة الفعلية','Actual Bosta cost')}: ${w.fulfillmentChannel==='direct'?amount(0):w.carrierSettlement?amount(w.carrierSettlement.cost):tr('بانتظار التسوية','Awaiting settlement')}</p>${exchange?`<p class="as-muted">${tr('رصيد الراجع المسوّى مع البديل','Returned credit transferred to replacement')}: ${amount(w.quote.creditApplied)}</p>`:''}`;
  }
  function shipmentLabel(kind) {
    return kind==='exchange'?tr('شحن الاستبدال','Ship exchange'):tr('سحب المرتجع','Collect return');
  }
  function shippingAddressForm(row) {
    const a=row.workflow.customerAddress||{};
    const locationPicker=(name,label,hint)=>`<div class="as-field as-combo-field"><span>${label}</span><div class="as-combo" data-as-combo="${name}"><select name="${name}" class="as-combo-native" tabindex="-1" aria-hidden="true"><option value="">${hint}</option></select><input type="search" data-as-combo-search role="combobox" aria-autocomplete="list" aria-expanded="false" autocomplete="off" required placeholder="${hint}" aria-label="${tr('بحث واختيار','Search and select')} ${label}"><div class="as-combo-list" role="listbox" hidden></div></div></div>`;
    return `<section class="as-card"><h3>${tr('عنوان العميل لاستلام المرتجع أو تسليم البديل','Customer return / replacement address')}</h3><label class="as-field">${tr('مصدر العنوان','Address source')}<select name="addressMode"><option value="manual">${tr('تحديد المحافظة والمنطقة مباشرة','Select city and district directly')}</option><option value="original">${tr('استخدام عنوان بوليصة بوسطة الأصلية','Use the original Bosta waybill address')}</option></select></label><div data-as-address-fields><div class="as-two"><label class="as-field">${tr('اسم العميل','Customer name')}<input name="customerName" required maxlength="150" autocomplete="name" value="${esc(a.customerName||row.addressHint?.customerName||row.client||'')}"></label><label class="as-field">${tr('رقم هاتف العميل','Customer phone')}<input name="customerPhone" type="tel" required maxlength="40" autocomplete="tel" dir="ltr" value="${esc(a.phone||row.addressHint?.phone||row.phone||'')}"></label></div><div class="as-two">${locationPicker('customerCityId',tr('المحافظة','City'),tr('ابحث عن المحافظة','Search city'))}${locationPicker('customerDistrictId',tr('المنطقة','District'),tr('ابحث عن المنطقة','Search district'))}</div><label class="as-field">${tr('عنوان العميل بالتفصيل','Full customer address')}<textarea name="customerFirstLine" minlength="6" maxlength="500" required rows="2">${esc(a.firstLine||row.addressHint?.firstLine||'')}</textarea></label><p class="as-muted" data-as-address-message role="status"></p><button type="button" class="btn btn-outline" data-as-address-retry>${tr('إعادة تحميل العناوين','Reload addresses')}</button></div></section>`;
  }
  function bindShippingAddress(row) {
    const form=el('[data-as-action-form]'), f=form.elements, messageNode=el('[data-as-address-message]');
    let districtRequest=0;
    const combos=['customerCityId','customerDistrictId'].map(name=>{
      const host=form.querySelector(`[data-as-combo="${name}"]`),select=f[name],input=host.querySelector('[data-as-combo-search]'),list=host.querySelector('[role=listbox]');
      let active=0;
      const options=()=>[...select.options].filter(option=>option.value);
      const close=()=>{list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');};
      const sync=()=>{input.value=select.selectedOptions[0]?.value?select.selectedOptions[0].textContent:'';input.setCustomValidity('');};
      const render=(query='')=>{
        const found=options().filter(option=>option.textContent.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
        list.replaceChildren();active=0;
        found.slice(0,80).forEach((option,index)=>{
          const item=document.createElement('button');item.type='button';item.className='as-combo-option';item.setAttribute('role','option');item.id=`as-${name}-${index}`;item.textContent=option.textContent;
          item.setAttribute('aria-selected',String(select.value===option.value));
          item.onclick=()=>{select.value=option.value;sync();close();select.dispatchEvent(new Event('change',{bubbles:true}));input.focus();};
          list.appendChild(item);
        });
        if(!found.length){const empty=document.createElement('div');empty.className='as-combo-empty';empty.textContent=tr('لا توجد نتائج مطابقة','No matching results');list.appendChild(empty);}
        else if(found.length>80){const more=document.createElement('div');more.className='as-combo-empty';more.textContent=tr('اكتب جزءًا من الاسم لعرض بقية النتائج','Type part of the name to see more results');list.appendChild(more);}
        const body=form.closest('.as-body'),bounds=input.getBoundingClientRect(),frame=body.getBoundingClientRect();
        host.classList.toggle('is-up',Math.min(window.innerHeight-12,frame.bottom)-bounds.bottom<180&&bounds.top-Math.max(12,frame.top)>100);
        list.hidden=false;input.setAttribute('aria-expanded','true');input.setAttribute('aria-controls',`${name}-options`);list.id=`${name}-options`;
      };
      input.onfocus=()=>render('');
      input.oninput=()=>{select.value='';render(input.value);};
      input.onkeydown=event=>{
        const items=[...list.querySelectorAll('[role=option]')];
        if(event.key==='Escape'){close();input.blur();return;}
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){
          event.preventDefault();if(list.hidden)render('');const available=[...list.querySelectorAll('[role=option]')];
          active=Math.max(0,Math.min(available.length-1,active+(event.key==='ArrowDown'?1:-1)));
          available.forEach((item,index)=>item.classList.toggle('is-active',index===active));
          if(available[active]){input.setAttribute('aria-activedescendant',available[active].id);available[active].scrollIntoView({block:'nearest'});}return;
        }
        if(event.key==='Enter'&&!list.hidden&&items.length){event.preventDefault();items[active]?.click();}
      };
      input.onblur=()=>setTimeout(()=>{if(!host.contains(document.activeElement)){close();if(select.value)sync();}},120);
      return {name,input,sync,close};
    });
    const syncCombo=name=>combos.find(combo=>combo.name===name)?.sync();
    form.addEventListener('submit',event=>{
      if(f.addressMode.value!=='manual')return;
      for(const combo of combos)if(!f[combo.name].value){event.preventDefault();combo.input.setCustomValidity(tr('اختر قيمة من نتائج البحث','Select a result from the list'));combo.input.reportValidity();combo.input.focus();return;}
    },true);
    const placeholder=(select,text)=>{select.innerHTML=`<option value="">${esc(text)}</option>`;};
    async function districts() {
      const request=++districtRequest,cityId=f.customerCityId.value;
      placeholder(f.customerDistrictId,tr('اختر المنطقة','Select district'));syncCombo('customerDistrictId');if(!cityId)return;
      messageNode.textContent=tr('جارٍ تحميل المناطق…','Loading districts…');
      try {
        const rows=await api('/after-sales/shipping/cities/'+encodeURIComponent(cityId)+'/districts',{background:true});
        if(request!==districtRequest||!form.isConnected)return;
        for(const d of rows){const available=row.requestKind==='exchange'?d.dropOffAvailability!==false:d.pickupAvailability!==false;if(!available)continue;const option=document.createElement('option');option.value=d.id;option.textContent=currentLang==='en'?d.name:d.nameAr;f.customerDistrictId.appendChild(option);}
        if(cityId===row.workflow.customerAddress?.cityId)f.customerDistrictId.value=row.workflow.customerAddress.districtId;
        syncCombo('customerDistrictId');
        messageNode.textContent=rows.length?tr('اختر منطقة العميل الفعلية؛ يتم التحقق منها قبل إرسال الشحنة.','Choose the actual customer district; it is verified before sending.'):tr('لا توجد مناطق متاحة لهذه المحافظة.','No districts available for this city.');
      }catch(error){if(request===districtRequest&&form.isConnected)messageNode.textContent=tr('تعذر تحميل المناطق. اضغط إعادة تحميل العناوين.','Districts could not be loaded. Reload the addresses.');}
    }
    async function cities(){
      messageNode.textContent=tr('جارٍ تحميل المحافظات…','Loading cities…');
      try{
        const rows=await api('/after-sales/shipping/cities',{background:true});if(!form.isConnected)return;
        const previous=f.customerCityId.value||row.workflow.customerAddress?.cityId;
        placeholder(f.customerCityId,tr('اختر المحافظة','Select city'));
        rows.forEach(c=>{const option=document.createElement('option');option.value=c.id;option.textContent=currentLang==='en'?c.name:c.nameAr;f.customerCityId.appendChild(option);});
        f.customerCityId.value=previous||rows.find(c=>[c.name,c.nameAr].includes(row.addressHint?.city))?.id||'';
        syncCombo('customerCityId');
        messageNode.textContent='';await districts();
      }catch(error){if(form.isConnected)messageNode.textContent=tr('تعذر تحميل المحافظات. أعد المحاولة من زر إعادة التحميل.','Cities could not be loaded. Use Reload addresses to retry.');}
    }
    f.customerCityId.onchange=districts;
    f.addressMode.onchange=()=>{const manual=f.addressMode.value==='manual';el('[data-as-address-fields]').hidden=!manual;for(const name of ['customerCityId','customerDistrictId','customerFirstLine','customerName','customerPhone'])f[name].disabled=!manual;for(const combo of combos){combo.input.disabled=!manual;combo.close();}};
    el('[data-as-address-retry]').onclick=cities;void cities();
  }
  async function create(invoiceId, kind = 'return', complaint = null) {
    if (!allowed('transaction')) return;
    if(!complaint||complaintOrigin?.complaintId!==complaint.complaintId){complaintOrigin=complaint?{...complaint,invoiceId,kind,owner:navigationOwner()}:null;suspendedView=null;}
    const version = show(kind==='exchange'?tr('طلب استبدال منتج','Product exchange request'):tr('طلب استرجاع منتج','Product return request'), '', `<div class="as-request-loading" data-as-create-loading role="status">${tr('جارٍ تحميل الفاتورة…','Loading invoice…')}</div>`);
    try {
      const data = await api('/after-sales/invoice/' + encodeURIComponent(invoiceId));
      if (version !== serial || !dialog.open) return;
      activeInvoice = data.invoice; activeCase = null;
      const tx = data.invoice;
      show(tr('طلب خدمة ما بعد البيع','After-sales request'), '#' + tx.ref + ' · ' + tx.client,
        `<form data-as-create><div class="as-create-content"><p class="as-request-hint" data-as-path-description></p><section class="as-request-controls"><div class="as-request-fields">${requestSelect('kind',tr('نوع الطلب','Request type'),{return:tr('استرجاع','Return'),exchange:tr('استبدال','Exchange')})}${requestSelect('reason',tr('سبب الطلب','Request reason'),{'customer-choice':tr('رغبة العميل','Customer preference'),defect:tr('عيب في المنتج','Product defect'),'wrong-item':tr('منتج مرسل بالخطأ','Wrong item sent')})}${requestSelect('fulfillmentChannel',tr('طريقة التنفيذ','Fulfillment method'),{bosta:tr('شحن','Shipment'),direct:tr('تسليم بالمخزن','Warehouse handover')})}</div><div class="as-request-policy"><span>${tr('عيب المنتج أو خطأ الإرسال بدون رسوم على العميل.','No customer fee for defects or wrong items.')}</span>${tx.deliveredAt?`<span class="as-request-date">${formIcon('calendar')}${tr('تم التسليم','Delivered')} <time datetime="${esc(tx.deliveredAt)}" title="${esc(date(tx.deliveredAt))}">${esc(new Intl.DateTimeFormat(tr('ar-EG','en-GB'),{day:'numeric',month:'short',year:'numeric',timeZone:'Africa/Cairo'}).format(new Date(tx.deliveredAt)))}</time></span>`:''}</div></section><div class="as-grid as-request-grid"><div class="as-request-products">
        <section class="as-card"><h3>${formIcon('return')}${tr('القطع الراجعة','Returned items')}</h3><div class="as-return-lines">${tx.items.map((line,i) => {
          const used = data.prior.flatMap(r => r.items || []).filter(l => l.lineIndex === i || l.lineIndex == null && l.code === line.code).reduce((n,l) => n + Number(l.qty),0), available = Math.max(0,Number(line.qty)-used);
          const ids = data.identities.lines.find(l => line.lineId ? l.lineId === line.lineId : l.sku === line.code)?.current || [];
          return `<div class="as-return-line" data-as-line="${i}"><div class="as-row">${productCard({...data.products.find(p=>p.code===line.code),...line,imageUrl:line.imageUrl||data.products.find(p=>p.code===line.code)?.imageUrl})}<label class="as-return-quantity"><span>${tr('الكمية','Quantity')}</span><input class="as-input as-qty" type="number" min="0" max="${available}" step="1" value="0" data-as-qty ${available ? '' : 'disabled'}><small>${tr('من','of')} ${available}</small></label></div>${ids.length?`<details class="as-unit-details"><summary>${tr('اختيار القطع بالكود','Select unit codes')} <span>${ids.length}</span></summary>${ids.map(u => `<label class="as-identity"><input type="checkbox" value="${esc(u.unitId)}" data-as-unit><code dir="ltr">${esc(u.manualCode || u.barcode)}</code></label>`).join('')}</details>`:''}</div>`;
        }).join('')}</div></section><section class="as-card" data-as-replacements hidden><div class="as-card-heading"><h3>${formIcon('exchange')}${tr('المنتج البديل','Replacement items')}</h3><button type="button" class="btn btn-outline" data-as-add aria-expanded="false" aria-controls="as-replacement-picker">${formIcon('plus')}${tr('إضافة بديل','Add replacement')}</button></div><div class="as-picker" id="as-replacement-picker" data-as-picker hidden><label class="as-field">${tr('ابحث بالاسم أو كود المنتج','Search by product name or code')}<input type="search" data-as-search autocomplete="off"></label><div class="as-picker-results" data-as-picker-results></div></div><div data-as-replacement-list></div><div data-as-exchange-summary></div><label class="as-check"><input type="checkbox" name="upgradeAccepted">${tr('وافق العميل على فرق سعر الترقية، إن وجد.','Customer accepted any upgrade price difference.')}</label></section></div>
        <aside class="as-request-aside"><section class="as-card as-settlement-card"><h3>${formIcon('wallet')}${tr('ملخص التسوية','Settlement summary')}</h3><div data-as-quote aria-live="polite">${summary(null)}</div><details class="as-fee-details"><summary>${tr('رسوم العملية','Request fees')}<b data-as-fee-value></b></summary><div class="as-fee-content"><label class="as-field">${tr('التكلفة على العميل','Customer cost')}<input type="number" name="customerFee" min="0" step="0.01" value="${data.policy.returnFee || 0}" ${data.policy.customerFeesEnabled ? '' : 'disabled'}></label><p class="as-muted" data-as-fee-help></p><button type="button" class="btn btn-outline" data-as-reset-fee>${tr('استعادة الافتراضي','Reset to default')}</button><label class="as-field">${tr('سبب انطباق الرسوم','Why the fee applies')}<textarea name="feeBasis" maxlength="1000" rows="2"></textarea></label>${data.policy.feePolicyNote?`<p class="as-muted">${esc(data.policy.feePolicyNote)}</p>`:''}</div></details></section><section class="as-card as-note-card"><h3>${formIcon('note')}${tr('ملاحظات','Notes')}<small>${tr('اختياري','Optional')}</small></h3><label class="as-field"><span class="as-visually-hidden">${tr('تفاصيل المشكلة أو مرجع الصور','Issue details or photo reference')}</span><textarea name="note" maxlength="1000" rows="2" placeholder="${tr('تفاصيل تساعد في تنفيذ الطلب…','Details to help process the request…')}"></textarea></label></section></aside></div></div><footer class="as-foot"><span class="as-submit-hint">${tr('يُرسل للمراجعة قبل التنفيذ','Sent for review before processing')}</span><button type="submit" class="btn btn-primary"><span data-as-submit-label>${tr('تسجيل الطلب','Submit request')}</span>${formIcon('check')}</button></footer></form>`);
      const form = el('form'), field = name => form.elements.namedItem(name);
      field('kind').value = kind;
      if (complaint) {
        field('kind').disabled = true;
        for (const row of form.querySelectorAll('[data-as-line]')) {
          const item = complaint.items.find(i => i.lineIndex === Number(row.dataset.asLine));
          row.querySelector('[data-as-qty]').value = item?.qty || 0;
          row.querySelector('[data-as-qty]').readOnly = true;
          for (const input of row.querySelectorAll('[data-as-unit]')) if (item?.unitIds?.includes(input.value)) input.checked = true;
        }
      }
      const manualFees = new Map();
      function syncFee() {
        const charge = data.policy.customerFeesEnabled && field('reason').value === 'customer-choice';
        const defaultFee = field('fulfillmentChannel').value === 'direct' ? 0 : Number(data.policy[field('kind').value === 'exchange' ? 'exchangeFee' : 'returnFee'] || 0);
        field('customerFee').disabled = !charge;
        field('customerFee').value = charge ? (manualFees.get(field('kind').value) ?? defaultFee) : '0';
        field('feeBasis').disabled = !charge;
        field('feeBasis').required = charge && Number(field('customerFee').value) > 0;
        el('[data-as-reset-fee]').disabled = !charge;
        el('[data-as-fee-help]').textContent = !data.policy.customerFeesEnabled
          ? tr('فعّل رسوم العميل من سياسة الاسترجاع والاستبدال لتعديل التكلفة.', 'Enable customer fees in the returns and exchange policy to edit the cost.')
          : !charge ? tr('الديفوه وخطأ الشركة بدون تكلفة على العميل.', 'Defects and company errors have no customer cost.')
          : tr('يمكن تعديل التكلفة لهذه العملية فقط، بما فيها الاستلام المباشر. تُخصم من المبلغ المُرد للعميل، وتُضاف إلى الفرق المطلوب منه عند الاستبدال إن وجد.', 'Edit the cost for this request, including direct handover. It reduces the customer refund or increases any exchange amount to collect.');
      }
      syncFee();
      form.addEventListener('invalid',event=>{const details=event.target.closest('details');if(details)details.open=true;},true);
      el('[data-as-reset-fee]').onclick = () => { manualFees.delete(field('kind').value); syncFee(); void calculate(); };
      const selected = new Map();
      const normalize = value => typeof normalizeUiSearch === 'function' ? normalizeUiSearch(String(value||'')) : String(value||'').toLocaleLowerCase().trim();
      function renderSelected() {
        const host=el('[data-as-replacement-list]');
        host.innerHTML=[...selected.values()].map(({product:p,qty})=>`<div class="as-row as-replacement-row" data-as-replacement="${esc(p._id)}">${productCard(p)}<div><strong>${amount(p.sellPrice)}</strong><small class="as-picker-stock">${tr('المتاح','Available')}: ${p.available??'—'}</small></div><div class="as-stepper"><button type="button" class="btn btn-outline" data-as-minus aria-label="${tr('تقليل الكمية','Decrease quantity')}">−</button><input class="as-input as-qty" type="number" min="1" max="${p.available??9999}" step="1" value="${qty}" data-as-replacement-qty aria-label="${tr('كمية البديل','Replacement quantity')}"><button type="button" class="btn btn-outline" data-as-plus aria-label="${tr('زيادة الكمية','Increase quantity')}">+</button></div><button type="button" class="btn btn-outline" data-as-remove aria-label="${tr('حذف البديل','Remove replacement')}">×</button></div>`).join('') || '<p class="as-muted">'+tr('اختر المنتج البديل من قائمة المنتجات.','Choose a replacement from the product list.')+'</p>';
        host.querySelectorAll('[data-as-replacement]').forEach(row=>{
          const entry=selected.get(row.dataset.asReplacement),input=row.querySelector('input');
          const change=qty=>{entry.qty=Math.max(1,Math.min(Number(entry.product.available??9999),qty||1));input.value=entry.qty;void calculate();};
          input.onchange=()=>change(Number(input.value));
          row.querySelector('[data-as-minus]').onclick=()=>change(entry.qty-1);
          row.querySelector('[data-as-plus]').onclick=()=>change(entry.qty+1);
          row.querySelector('[data-as-remove]').onclick=()=>{selected.delete(row.dataset.asReplacement);renderSelected();renderPicker();void calculate();};
        });
      }
      function renderPicker(){
        const query=normalize(el('[data-as-search]').value).split(/\s+/).filter(Boolean);
        const matches=data.products.filter(p=>p.isActive!==false&&query.every(t=>normalize(p.name+' '+p.code).includes(t))).slice(0,80);
        el('[data-as-picker-results]').innerHTML=matches.map(p=>`<div class="as-picker-result tx-picker-item">${productCard(p)}<div><strong>${amount(p.sellPrice)}</strong><div class="as-picker-stock">${tr('متاح بالمخزن','Warehouse stock')}: ${p.available??'—'}</div></div><button type="button" class="btn btn-outline" data-as-pick="${esc(p._id)}" ${p.available===0||selected.has(p._id)?'disabled':''}>${selected.has(p._id)?tr('تمت الإضافة','Added'):p.available===0?tr('غير متاح','Out of stock'):tr('إضافة','Add')}</button></div>`).join('') || '<p class="as-muted">'+tr('لا توجد منتجات مطابقة. جرّب الاسم أو الكود.','No matching products. Try a name or code.')+'</p>';
        el('[data-as-picker-results]').querySelectorAll('[data-as-pick]').forEach(button=>button.onclick=()=>{
          const product=data.products.find(p=>p._id===button.dataset.asPick);
          selected.set(product._id,{product,qty:1});renderSelected();renderPicker();void calculate();
        });
      }
      el('[data-as-add]').onclick=()=>{const picker=el('[data-as-picker]');picker.hidden=!picker.hidden;el('[data-as-add]').setAttribute('aria-expanded',String(!picker.hidden));if(!picker.hidden){renderPicker();el('[data-as-search]').focus();}};
      el('[data-as-search]').onkeydown=event=>{if(event.key==='Escape'&&!el('[data-as-picker]').hidden){event.preventDefault();event.stopPropagation();el('[data-as-picker]').hidden=true;el('[data-as-add]').setAttribute('aria-expanded','false');el('[data-as-add]').focus();}};
      el('[data-as-search]').oninput=renderPicker;
      renderSelected();
      function payload() {
        return { ...(complaint ? { complaintId:complaint.complaintId, expectedComplaintRevision:complaint.expectedComplaintRevision } : {}), fulfillmentChannel:field('fulfillmentChannel').value, originalTransactionId:invoiceId, kind:field('kind').value, reason:field('reason').value,
          items:[...form.querySelectorAll('[data-as-line]')].filter(row => Number(row.querySelector('[data-as-qty]').value) > 0).map(row => ({ lineIndex:Number(row.dataset.asLine), qty:Number(row.querySelector('[data-as-qty]').value), unitIds:[...row.querySelectorAll('[data-as-unit]:checked')].map(input=>input.value) })),
          exchangeItems:field('kind').value==='exchange'?[...selected.values()].map(({product,qty})=>({productId:product._id,qty})):[],
          customerFee:Number(field('customerFee').value), feeBasis:field('feeBasis').value.trim(), upgradeAccepted:field('kind').value==='exchange'&&field('upgradeAccepted').checked, note:field('note').value.trim() };
      }
      let quoteController, quoteKey = '';
      async function calculate() {
        if(!form.isConnected||!dialog.open||busy)return;
        const isExchange=field('kind').value==='exchange';
        el('[data-as-replacements]').hidden = !isExchange;
        field('upgradeAccepted').disabled=!isExchange;
        el('#as-title').innerHTML=formIcon(isExchange?'exchange':'return')+tr(isExchange?'طلب استبدال منتج':'طلب استرجاع منتج',isExchange?'Product exchange request':'Product return request');
        el('[data-as-path-description]').textContent=isExchange?tr('اختر القطع الراجعة والبديل، ثم راجع فرق السعر قبل تسجيل الطلب.','Choose returned and replacement items, then review the difference before submitting.'):tr('اختر القطع الراجعة وراجع المستحق للعميل. يُرد المبلغ بعد الاستلام والفحص.','Choose returned items and review the refund. Payment follows receipt and inspection.');
        el('[data-as-submit-label]').textContent=isExchange?tr('تسجيل الاستبدال','Submit exchange'):tr('تسجيل الاسترجاع','Submit return');
        el('[data-as-fee-value]').textContent=amount(field('customerFee').value);
        form.querySelectorAll('[data-as-line]').forEach(row=>row.classList.toggle('is-selected',Number(row.querySelector('[data-as-qty]').value)>0));
        field('feeBasis').required = !field('customerFee').disabled && Number(field('customerFee').value) > 0;
        const body=payload(); el('[data-as-exchange-summary]').innerHTML=body.items.length&&body.exchangeItems.length?exchangeSummary(body.items,body.exchangeItems):'';
        // Notes/search and repeated input/change events do not change the quote.
        const signature=JSON.stringify({...body,note:undefined,feeBasis:!!body.feeBasis});
        if(signature===quoteKey)return;
        quoteKey=signature;
        quoteController?.abort();quoteController=new AbortController();
        const request = ++quoteSerial, target = el('[data-as-quote]');
        target.removeAttribute('aria-busy');
        if(!body.items.length || body.kind==='exchange'&&!body.exchangeItems.length){target.innerHTML=summary(null,body.kind);return;}
        target.setAttribute('aria-busy','true');
        target.innerHTML=`<p class="as-muted" role="status">${tr('جارٍ حساب المبلغ…','Calculating amount…')}</p>`;
        try {
          const result = await api('/after-sales/quote', { method:'POST', body:JSON.stringify(body), background:true, signal:quoteController.signal });
          if (request !== quoteSerial || !target.isConnected) return;
          target.innerHTML = summary(result.quote,body.kind) + (result.requiresReview ? `<p class="as-muted">${tr('يلزم مراجعة المدير للمهلة أو تاريخ الاستلام.','Manager review required for the return window or delivery date.')}</p>` : '');
        } catch(error) { if(request === quoteSerial && target.isConnected&&error.name!=='AbortError'){quoteKey='';target.innerHTML = `<p class="as-muted">${esc(error.message)}</p>`;} }
        finally { if(request===quoteSerial&&target.isConnected)target.removeAttribute('aria-busy'); }
      }
      let timer; form.oninput = event => { if(event.target.name==='note'||event.target.matches('[data-as-search]'))return; if(event.target.name==='customerFee') manualFees.set(field('kind').value,field('customerFee').value); clearTimeout(timer); timer=setTimeout(calculate,180); };
      form.onchange = event => { if(event.target.name==='note'||event.target.matches('[data-as-search]'))return; clearTimeout(timer); if(event.target.name==='customerFee') manualFees.set(field('kind').value,field('customerFee').value); if(['kind','reason','fulfillmentChannel'].includes(event.target.name)) syncFee(); void calculate(); };
      form.onsubmit = async event => { event.preventDefault(); if(busy)return; setBusy(true); try { const result=await post('', '', payload()); if(complaintOrigin)complaintOrigin.caseId=result._id; await savedStep(result,result._id,['returns']); if (complaint) void window.ComplaintFlow?.changed(); message(tr('تم تسجيل الطلب وإرساله للمراجعة.','The request was submitted for review.'),false); } catch(error){message(error.message);} finally{setBusy(false);} };
      if(typeof _pmEnhanceSelects==='function')_pmEnhanceSelects(form);
      el('.as-fee-details').open=!!data.policy.customerFeesEnabled&&Number(field('customerFee').value)>0;
      await calculate();
    } catch(error) { message(error.message); }
  }
  function links(row) {
    const complaintLinks = (row.workflow.complaintIds || []).map(id=>`<button class="as-link" type="button" data-as-complaint="${esc(id)}">${tr('ملف الشكوى','Complaint workspace')}</button>`).join('');
    return complaintLinks + [{ id:row.originalTransactionId, label:tr('الفاتورة الأصلية','Original invoice')+' #'+row.originalRef },
      { id:row.workflow.replacementTxId,label:tr('فاتورة البديل','Replacement invoice')+' #'+(row.workflow.replacementRef||'') },
      { id:row.returnTxId,label:tr('فاتورة المرتجع','Return invoice')+' #'+(row.returnTxRef||'') }].filter(x=>x.id).map(x=>`<button class="as-link" type="button" data-as-invoice="${esc(x.id)}">${esc(x.label)}</button>`).join('');
  }
  function bindLinks() { dialog.querySelectorAll('[data-as-complaint]').forEach(button=>button.onclick=()=>{if(complaintOrigin?.complaintId===button.dataset.asComplaint)return backToComplaint();const task=window.ComplaintFlow?.resume(button.dataset.asComplaint);if(document.querySelector('#page-complaint-detail.active')||document.querySelector('.cf-dialog[open]')){closeDialog();}return task;}); dialog.querySelectorAll('[data-as-invoice]').forEach(button=>button.onclick=()=>{complaintOrigin=null;suspendedView=null;closeDialog();showInvoiceDetail(button.dataset.asInvoice);}); }
  async function open(id, restorePosition = false, committedRow = null) {
    if(complaintOrigin&&String(complaintOrigin.caseId)!==String(id)){complaintOrigin=null;suspendedView=null;}
    const owner=navigationOwner();
    const cached=activeCaseOwner===owner&&String(activeCase?._id)===String(id)&&el('[data-as-print]');
    const version = cached?++serial:show(tr('ملف خدمة ما بعد البيع','After-sales case'),'',tr('جارٍ التحميل…','Loading…'));
    if(cached){showComplaintNavigation();if(!dialog.open)dialog.showModal();if(restorePosition&&caseReturn?.id===String(id))el('.as-body').scrollTop=caseReturn.top;}
    try {
      const row=String(committedRow?._id)===String(id)&&committedRow?.workflow ? committedRow : await api('/after-sales/'+encodeURIComponent(id)); if(version!==serial||!dialog.open||owner!==navigationOwner())return; activeCase=row;activeCaseOwner=owner;
      if(!complaintOrigin&&row.workflow?.complaintIds?.length===1){const complaintId=row.workflow.complaintIds[0],source=(typeof complaints!=='undefined'?complaints:[]).find(c=>c._id===complaintId);complaintOrigin={complaintId,complaintNo:source?.complaintNo||'',caseId:id,owner:navigationOwner()};}
      const w=row.workflow, closed=['closed','cancelled'].includes(w.stage), actions=[];
      if(!closed){
        if(admin()&&row.rollback?.available)actions.push(['rollback',tr('رجوع للخطوة السابقة','Undo previous step')]);
        if(w.stage==='requested'&&admin())actions.push(['approve',tr('اعتماد الطلب','Approve request')]);
        if(!w.shipment&&admin())actions.push(['cancel',tr('إلغاء الطلب','Cancel request')]);
        if(w.fulfillmentChannel!=='direct'&&w.approvedAt&&!w.shipment&&(!w.receivedAt||row.requestKind==='exchange')&&allowed('shopify-prepare-ship'))actions.push(['ship',shipmentLabel(row.requestKind)]);
        if(w.shipment?.deliveryId&&allowed('shopify-prepare-ship'))actions.push(['sync',tr('تحديث من بوسطة','Sync Bosta')]);
        if(['creating','reconcile'].includes(w.shipment?.status)&&admin())actions.push(['link-shipment',tr('مطابقة بوليصة موجودة','Match existing shipment')]);
        if(w.approvedAt&&!w.receivedAt&&allowed('inventory-units-condition'))actions.push(['receive',tr('استلام المرتجع','Receive return')]);
        if(row.requestKind==='exchange'&&(w.shipment?.deliveryId||w.fulfillmentChannel==='direct'&&w.approvedAt)&&!w.replacementDeliveredAt&&admin())actions.push(['delivery',tr('تأكيد التسليم','Confirm delivery')]);
        if((w.receivedAt||w.replacementDeliveredAt)&&admin())actions.push(['settle',tr('تسوية المبالغ','Settle payments')]);
        if(allowed('transaction'))actions.push(['exception',tr('إدارة مشكلة','Manage issue')]);
      }
      show((row.requestKind==='exchange'?tr('استبدال','Exchange'):tr('استرجاع','Return'))+' · #'+row.originalRef,row.client+' · '+w.ref,
        `${row.requestKind==='exchange'?exchangeSummary(row.items,row.exchangeItems):''}${flowSteps(row)}${nextAction(row)}
        ${w.fulfillmentChannel==='direct'?`<div class="as-banner">${tr('استلام وتسليم مباشر بالمخزن · دون بوليصة أو تسوية ناقل','Direct warehouse handover · no waybill or carrier settlement')}</div>`:''}
        ${w.exception?`<div class="as-banner as-error">${esc(w.exception)}</div>`:''}
        ${admin()&&!closed&&row.rollback&&!row.rollback.available?`<p class="as-muted">${tr('الرجوع للخطوة السابقة: ','Undo previous step: ')}${esc(row.rollback.reason)}</p>`:''}
        <div class="as-grid"><div><section class="as-card" data-as-section="status" tabindex="-1"><div class="as-row"><h3>${tr('حالة الطلب','Case status')}</h3><span class="as-badge">${stage(w.stage,row.requestKind)}</span></div><div class="as-actions">${links(row)}</div>${row.requestKind==='exchange'&&w.replacementTxId?`<div class="as-banner">${tr('حالة طلب البديل','Replacement order status')}: ${SouliaOrderStatus.badge(SouliaOrderStatus.resolve({pickupStatus:w.replacementPickupStatus||'Pending',bostaOrderId:w.shipment?.deliveryId,bostaStatus:w.shipment?.carrierStatus},'transaction',tr('ar','en')))}<button type="button" class="btn btn-outline" data-as-orders>${tr('فتح الطلبات والتجهيز','Open orders and preparation')}</button></div>`:''}<p class="as-muted">${tr('سبب الطلب','Reason')}: ${esc(reasonLabel(row.reason))} · ${esc(row.reasonDetails||'')}</p><div class="as-table-wrap"><table class="as-table"><thead><tr><th>${tr('المنتج الراجع','Returned item')}</th><th>${tr('الكمية','Qty')}</th><th>${tr('القيمة','Value')}</th></tr></thead><tbody>${row.items.map(i=>`<tr><td>${productCard(i)}<small class="as-muted"> ${esc(i.condition||'')}</small></td><td>${i.qty}</td><td>${amount(i.total)}</td></tr>`).join('')}</tbody></table></div>${row.requestKind==='exchange'&&row.exchangeItems?.length?`<p class="as-muted">${tr('البديل','Replacement')}: ${row.exchangeItems.map(i=>productCard(i)+'<span class="as-badge">× '+i.qty+'</span>').join('')}</p>`:''}</section>
        <section class="as-card" data-as-section="shipment" tabindex="-1"><h3>${tr('الشحن والاستلام','Shipment and receipt')}</h3><p>${esc(w.shipment?.trackingNumber||tr('لم تُنشأ بوليصة بعد','No waybill yet'))} <span class="as-badge">${esc(w.shipment?.carrierLabel||w.shipment?.status||'')}</span></p><p class="as-muted">${tr('استلام المخزن','Warehouse receipt')}: ${date(w.receivedAt)}${row.requestKind==='exchange'?`<br>${tr('تسليم البديل','Replacement delivery')}: ${date(w.replacementDeliveredAt)}` : ''}</p>${w.shipment?.trackingNumber?`<a class="as-link" href="https://bosta.co/ar-eg/tracking-shipments?shipment-number=${encodeURIComponent(w.shipment.trackingNumber)}" target="_blank" rel="noopener">${tr('تتبع بوسطة','Track Bosta')}</a>`:''}</section><div class="as-actions">${actions.map(([action,label])=>`<button class="btn ${['approve','ship','receive','settle'].includes(action)?'btn-primary':'btn-outline'}" type="button" data-as-action="${action}">${label}</button>`).join('')}<button class="btn btn-outline" type="button" data-as-print>${tr('طباعة','Print')}</button></div></div>
        <aside><section class="as-card" data-as-section="financial" tabindex="-1"><h3>${tr('التسوية المالية','Financial settlement')}</h3>${summary(w.quote,row.requestKind)}${financialStatus(row)}</section><section class="as-card"><h3>${tr('سجل الطلب','Case history')}</h3><ol class="as-history">${(w.history||[]).slice().reverse().map(h=>`<li>${esc(actionLabel(h.action))} · ${esc(h.by)}<time>${date(h.at)}</time>${h.note?`<div>${esc(h.note)}</div>`:''}</li>`).join('')}</ol></section></aside></div>`);
      if(el('[data-as-orders]'))el('[data-as-orders]').onclick=()=>{closeDialog();navigateTo('pickup-orders');};
      dialog.querySelectorAll('[data-as-step]').forEach(button=>button.onclick=()=>moveToCaseStep(button));
      if(restorePosition&&caseReturn?.id===String(row._id))el('.as-body').scrollTop=caseReturn.top;
      bindLinks(); dialog.querySelectorAll('[data-as-action]').forEach(button=>button.onclick=()=>{
        caseReturn={id:String(row._id),top:el('.as-body').scrollTop};
        action(row,button.dataset.asAction);
      });
      el('[data-as-print]').onclick=()=>printCase(row);
    } catch(error){if(version===serial&&dialog?.open)message(error.message);}
  }
  function rollback(row) {
    if(!admin()||!row.rollback?.available)return;
    const descriptions={request:tr('سيُلغى الطلب الحالي لأنه لم يُعتمد بعد. يمكنك تسجيل طلب جديد بعد الإلغاء.','This request has not been approved. Undoing its submission cancels it so you can create a new request.'),
      preparation:tr('سيعود البديل إلى انتظار التجهيز، وتُلغى اختيارات القطع وتجهيزها. يظل اعتماد الطلب ساريًا.','The replacement returns to awaiting preparation. Piece assignments and preparation are reset; approval remains.'),
      approval:tr('سيعود الطلب إلى انتظار الاعتماد. تُلغى فاتورة البديل الحالية ويُعاد رصيدها للمخزون مع الاحتفاظ بسجلها.','The case returns to awaiting approval. Its replacement invoice is cancelled and its stock balance restored, retaining the history.')};
    show(tr('رجوع للخطوة السابقة','Undo previous step'),row.workflow.ref,`<form data-as-rollback-form><div class="as-banner">${esc(descriptions[row.rollback.step]||row.rollback.reason)}</div><label class="as-field">${tr('سبب التراجع','Reason for undoing')}<textarea name="note" rows="3" maxlength="1000" required></textarea></label><label class="as-check"><input type="checkbox" name="confirmed" required><span>${tr('أؤكد التراجع عن هذه الخطوة وآثارها الموضحة','I confirm undoing this step and the effects described above')}</span></label><footer class="as-foot"><button type="button" class="btn btn-outline" data-as-back>${tr('إلغاء','Cancel')}</button><button type="submit" class="btn btn-primary">${tr('تأكيد الرجوع','Confirm undo')}</button></footer></form>`);
    el('[data-as-back]').onclick=()=>open(row._id,true);
    el('form').onsubmit=async event=>{
      event.preventDefault();if(busy)return;
      const form=event.target;setBusy(true);
      try{const result=await post('rollback',row._id,{step:row.rollback.step,expectedToken:row.rollback.token,note:form.elements.note.value.trim(),confirmed:form.elements.confirmed.checked});await savedStep(result,row._id);message(tr('تم الرجوع خطوة وتسجيل الإجراء في سجل الطلب.','The step was undone and recorded in the case history.'),false);}
      catch(error){message(error.message);}finally{setBusy(false);}
    };
  }
  async function action(row, name) {
    if(busy)return;
    if(name==='rollback')return rollback(row);
    if(name==='receive')return receive(row);
    if(name==='settle')return settle(row);
    if(name==='sync'){setBusy(true);try{const result=await api('/after-sales/'+row._id+'/sync',{method:'POST',body:'{}'});await savedStep(result,row._id,['returns','transactions']);}catch(error){message(error.message);}finally{setBusy(false);}return;}
    const labels={approve:tr('اعتماد الطلب','Approve request'),cancel:tr('إلغاء الطلب','Cancel request'),ship:shipmentLabel(row.requestKind),delivery:tr('تأكيد التسليم','Confirm delivery'),'link-shipment':tr('ربط بوليصة بوسطة','Link Bosta shipment'),exception:tr('إدارة مشكلة','Manage issue')};
    show(labels[name],row.workflow.ref,`<form data-as-action-form><div class="as-banner">${name==='ship'?tr('سيتم إرسال طلب الشحنة إلى بوسطة. عند انقطاع الاتصال تتم مطابقة الطلب قبل إعادة الإرسال.','The shipment request will be sent to Bosta. An interrupted request must be reconciled before resending.'):name==='approve'?tr('الموافقة تبدأ التجهيز. الاستلام ورد المبلغ لهما خطوات مستقلة.','Approval starts preparation. Receipt and refund have separate steps.'):tr('سجّل التفاصيل والمرجع لإكمال الإجراء.','Record the details and reference to complete this action.')}</div>${name==='ship'?shippingAddressForm(row):''}${name==='link-shipment'?`<label class="as-field">${tr('معرّف الشحنة في بوسطة','Bosta delivery ID')}<input name="deliveryId" required></label>`:''}${name==='exception'&&admin()?`<label class="as-check"><input type="checkbox" name="resolve">${tr('تم حل المشكلة مع توثيق الإجراء','Issue resolved; document the resolution')}</label>`:''}<label class="as-field">${tr('الملاحظة / مرجع الإثبات','Note / evidence reference')}<textarea name="note" rows="3" maxlength="1000" ${['cancel','delivery','exception'].includes(name)||name==='approve'&&row.workflow.requiresReview?'required':''}></textarea></label>${name==='delivery'?`<label class="as-check"><input type="checkbox" name="confirmed" required>${tr('تأكدت من تسليم البديل للعميل','I verified delivery of the replacement to the customer')}</label>`:''}<footer class="as-foot"><button type="button" class="btn btn-outline" data-as-back>${tr('رجوع','Back')}</button><button type="submit" class="btn btn-primary">${labels[name]}</button></footer></form>`);
    el('[data-as-back]').onclick=()=>open(row._id,true);
    if(name==='ship')bindShippingAddress(row);
    el('form').onsubmit=async event=>{event.preventDefault();if(busy)return;setBusy(true);const form=event.target;try{const result=await post(name,row._id,{note:form.elements.note.value,confirmed:form.elements.confirmed?.checked===true,resolve:form.elements.resolve?.checked===true,deliveryId:form.elements.deliveryId?.value,addressMode:form.elements.addressMode?.value,customerAddress:form.elements.addressMode?.value==='manual'?{cityId:form.elements.customerCityId.value,districtId:form.elements.customerDistrictId.value,firstLine:form.elements.customerFirstLine.value,phone:form.elements.customerPhone.value,customerName:form.elements.customerName.value}:undefined});await savedStep(result,row._id);message(name==='approve'&&row.requestKind==='exchange'?tr('تم الاعتماد. طلب الاستبدال مسجّل وبانتظار التجهيز، ويمكن بدء تجهيزه من شاشة الطلبات.','Approved. The replacement is registered and awaiting prep on the orders board.'):tr('تم حفظ الإجراء وتحديث سجل الطلب.','The action was saved and the order history updated.'),false);}catch(error){message(error.message);}finally{setBusy(false);}};
  }
  function receive(row) {
    const w=row.workflow;
    show(tr('استلام وفحص القطع الراجعة','Receive and inspect returned pieces'),w.ref,
      `<form data-as-receive><div class="as-banner">${tr('طابق القطع فعليًا مع الفاتورة. السليم يعود للبيع، والتالف يُعزل. إذا كانت الهوية مطموسة اطبع نفس الهوية ثم أكد لصقها.','Match the physical pieces to the invoice. Sound items return to sale; damaged items are isolated. Reprint obscured labels with the same identity and confirm attachment.')}</div>${w.selectedLines.map(line=>`<section class="as-card" data-as-receipt-line="${line.lineIndex}"><div class="as-row">${productCard(line)}<span class="as-badge">× ${line.qty}</span><label class="as-field">${tr('حالة القطع','Condition')}<select data-as-condition><option value="سليم">${tr('سليم بعد الفحص','Inspected and sound')}</option><option value="تالف">${tr('تالف — غير متاح للبيع','Damaged — blocked from sale')}</option>${line.qty>1?`<option value="mixed">${tr("سليم وتالف","Mixed condition")}</option>`:""}</select><input class="as-input" data-as-damaged-qty type="number" min="1" max="${line.qty-1}" value="1" aria-label="${tr("عدد القطع التالفة","Damaged quantity")}" hidden disabled></label></div>${line.unitIds.map(id=>`<div class="as-identity" data-as-label="${esc(id)}"><code dir="ltr">SU-${esc(id.toUpperCase())}</code><select data-as-unit-condition hidden aria-label="${tr("حالة القطعة","Piece condition")}"><option value="سليم">${tr("سليم","Sound")}</option><option value="تالف">${tr("تالف","Damaged")}</option></select><select data-as-label-state aria-label="${tr('حالة الملصق','Label condition')}"><option value="">${tr('حالة الهوية','Label condition')}</option><option value="intact">${tr('موجودة وواضحة','Intact and readable')}</option><option value="reprinted">${tr('مطموسة / مفقودة','Obscured / missing')}</option></select><button type="button" class="btn btn-outline" data-as-print-label hidden>${tr('طباعة نفس الهوية','Print same identity')}</button><label><input type="checkbox" data-as-attached> ${tr('تأكدت من الهوية ولصق الملصق','Identity verified and label attached')}</label></div>`).join('')}</section>`).join('')}<label class="as-field">${tr('مقاس الملصق','Label size')}<select name="sizeId">${['50x30','60x40','80x50','100x70'].map(s=>`<option>${s}</option>`).join('')}</select></label><label class="as-check"><input type="checkbox" name="physicalPossessionConfirmed" required>${tr('استلمت كل الكمية الموضحة فعليًا وفحصتها؛ عند النقص أو اختلاف القطع أسجل مشكلة بدل تأكيد الاستلام.','I physically received and inspected the full listed quantity. Record an issue if items are missing or different.')}</label><footer class="as-foot"><button type="button" class="btn btn-outline" data-as-back>${tr('رجوع','Back')}</button><button type="submit" class="btn btn-primary">${tr('تأكيد الاستلام والفحص','Confirm receipt and inspection')}</button></footer></form>`);
    el('[data-as-back]').onclick=()=>open(row._id,true);
    if(!(w.selectedUnits||[]).length)el('form').elements.sizeId.closest('label').hidden=true;
    dialog.querySelectorAll('[data-as-label]').forEach(label=>{
      const select=label.querySelector('[data-as-label-state]'),print=label.querySelector('button');select.onchange=()=>{print.hidden=select.value!=='reprinted';label.querySelector('input').checked=false;};
      print.onclick=()=>printIdentity(label,el('form').elements.sizeId.value);
    });
    dialog.querySelectorAll('[data-as-receipt-line]').forEach(line=>{line.querySelector('[data-as-condition]').onchange=()=>{const mixed=line.querySelector('[data-as-condition]').value==='mixed';line.querySelector('[data-as-damaged-qty]').hidden=!mixed;line.querySelector('[data-as-damaged-qty]').disabled=!mixed;line.querySelectorAll('[data-as-unit-condition]').forEach(select=>select.hidden=!mixed);};});
    el('form').onsubmit=async event=>{
      event.preventDefault();if(busy)return;
      const identities=[...dialog.querySelectorAll('[data-as-label]')].map(label=>({unitId:label.dataset.asLabel,labelState:label.querySelector('[data-as-label-state]').value,condition:label.querySelector('[data-as-unit-condition]').value,labelAttached:label.querySelector('input').checked,printOperationKey:label.dataset.printOperationKey}));
      if(identities.some(l=>!l.labelState||!l.labelAttached||l.labelState==='reprinted'&&!l.printOperationKey)){message(tr('راجع كل هوية وأكّد لصق الملصق.','Review each identity and confirm label attachment.'));return;}
      const items=[...dialog.querySelectorAll('[data-as-receipt-line]')].map(line=>({lineIndex:Number(line.dataset.asReceiptLine),condition:line.querySelector('[data-as-condition]').value,damagedQty:Number(line.querySelector('[data-as-damaged-qty]').value)}));
      setBusy(true);try{const result=await post('receive',row._id,{items,identities,physicalPossessionConfirmed:true});await savedStep(result,row._id);message(tr('تم استلام القطع وتسجيل الفحص وحركة المخزن.','Items received; inspection and inventory movements recorded.'),false);}catch(error){message(error.message);}finally{setBusy(false);}
    };
  }
  async function printIdentity(label,sizeId) {
    if(busy)return;const popup=window.open('','_blank','width=850,height=750');if(!popup){message(tr('اسمح بفتح نافذة الطباعة.','Allow the print window to open.'));return;}
    setBusy(true);
    try{
      const helpers=window.InventoryUnitLabels;
      if(!helpers)throw new Error(tr('تعذر تحميل أدوات الطباعة. حدّث الصفحة وأعد المحاولة.','Print tools unavailable. Refresh the page and retry.'));
      // Receipt printing can be opened before the barcode workspace has loaded its configuration.
      const config=await api('/inventory-units/config');
      if(!Array.isArray(config?.labelSizes)||config.symbology&&config.symbology!=='QR'||!config.labelSizes.some(size=>size.id===sizeId))throw new Error(tr('مقاس الملصق غير متاح. حدّث الصفحة وأعد المحاولة.','Label size unavailable. Refresh the page and retry.'));
      const unitId=label.dataset.asLabel,operationKey=label.dataset.printSize===sizeId&&label.dataset.printOperationKey||key();label.dataset.printOperationKey=operationKey;label.dataset.printSize=sizeId;
      const apiBody={unitIds:[unitId],sizeId,operationKey,allowReprint:true,reason:'After-sales physical receipt: reprint obscured identity'};
      const batch=helpers.validateBatch(await api('/inventory-units/labels/requests',{method:'POST',body:JSON.stringify(apiBody)}),[unitId],sizeId,config),s=batch.size;
      popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>SOULIA</title><link rel="stylesheet" href="${location.origin}/inventory-units.css"><style>@page{size:${s.widthMm}mm ${s.heightMm}mm;margin:0}html,body{margin:0;padding:0;width:${s.widthMm}mm;background:white}.iu-label{margin:0!important;transform:none!important}</style></head><body>${batch.labels.map(l=>helpers.labelHtml(l,s)).join('')}</body></html>`);popup.document.close();
      await new Promise((resolve,reject)=>{const css=popup.document.querySelector('link'),timer=setTimeout(()=>reject(new Error(tr('تعذر تحميل تنسيق الطباعة','Print stylesheet timed out'))),15000);const done=()=>{clearTimeout(timer);resolve();};if(css.sheet)done();else{css.onload=done;css.onerror=()=>{clearTimeout(timer);reject(new Error('Print stylesheet unavailable'));};}});
      await helpers.waitForLayout(popup.document);popup.focus();popup.print();message(tr('الصق الملصق ثم أكد الهوية في النموذج.','Attach the printed label and confirm it in the form.'),false);
    }catch(error){if(!popup.closed)popup.close();message(error.message);}finally{setBusy(false);}
  }
  function settle(row) {
    const w=row.workflow,options=[];
    if(w.receivedAt&&(row.requestKind==='return'||w.replacementDeliveredAt)&&w.quote.refundDue&&!w.refund)options.push(['refund',tr('رد مستحق العميل','Refund customer')+' — '+amount(w.quote.refundDue)]);
    if(w.replacementDeliveredAt&&w.quote.collectDue&&!w.collection)options.push(['collection',tr('استلام فرق العميل مباشرة','Receive customer difference directly')+' — '+amount(w.quote.collectDue)]);
    if(w.fulfillmentChannel!=='direct'&&w.receivedAt&&(row.requestKind==='return'||w.replacementDeliveredAt)&&!w.carrierSettlement)options.push(['carrier',tr('تسوية بوسطة: التحصيل والتكلفة','Bosta settlement: collection and cost')]);
    if(!options.length){
      const pending=[];
      if(!w.receivedAt)pending.push(tr('تسجيل استلام المرتجع وفحصه في المخزن.','Record warehouse receipt and inspection.'));
      if(row.requestKind==='exchange'&&!w.replacementDeliveredAt)pending.push(tr('تأكيد تسليم البديل للعميل من ملف الطلب.','Confirm replacement delivery in the case.'));
      show(tr('متابعة التسوية','Settlement progress'),w.ref,
        '<section class="as-card">'+summary(w.quote,row.requestKind)+'</section><section class="as-next-step" data-as-settlement-wait><strong>'+
        (pending.length?tr('خطوات مطلوبة قبل التسوية','Required before settlement'):tr('لا توجد حركة مالية متاحة حاليًا','No financial action is currently available'))+
        '</strong>'+(pending.length?'<ul>'+pending.map(text=>'<li>'+text+'</li>').join(''):'<p>'+tr('راجع التسويات المسجلة وحالة إغلاق الطلب من ملفه.','Review recorded settlements and case closure in its details.')+'</p>')+
        '</section><footer class="as-foot"><button class="btn btn-primary" type="button" data-as-back>'+tr('متابعة خطوات الطلب','Continue case workflow')+'</button></footer>');
      el('[data-as-back]').onclick=()=>open(row._id,true);return;
    }
    show(row.requestKind==='exchange'?tr('تسوية الاستبدال: الفرق والشحن','Exchange settlement: difference and shipping'):tr('تسوية الاسترجاع ورد المبلغ','Return settlement and refund'),w.ref,`<form><section class="as-card">${summary(w.quote,row.requestKind)}</section><label class="as-field">${tr('الحركة','Action')}<select name="kind">${options.map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label><div data-as-carrier-fields><label class="as-field">${tr('تكلفة بوسطة الفعلية','Actual Bosta cost')}<input type="number" min="0" step="0.01" name="actualCost" value="0"></label>${w.quote.collectDue&&!w.collection?`<label class="as-check"><input type="checkbox" name="includesCollection" checked>${tr('التحويل يتضمن فرق العميل المحصل لدى بوسطة','Transfer includes the customer difference held by Bosta')}</label>`:''}<div class="as-banner" data-as-net></div></div><div class="as-two"><label class="as-field">${tr('الخزنة','Vault')}<select name="method">${['كاش','فودافون كاش','Instapay','تحويل بنكي'].map(m=>`<option>${m}</option>`).join('')}</select></label><label class="as-field">${tr('مرجع التحويل أو الدفع','Payment / transfer reference')}<input name="reference" required maxlength="150"></label></div><label class="as-check"><input type="checkbox" name="confirmed" required>${tr('الحركة تمت فعليًا، والمبلغ والخزنة والمرجع صحيحون.','The payment happened and the amount, vault and reference are correct.')}</label><footer class="as-foot"><button type="button" class="btn btn-outline" data-as-back>${tr('رجوع','Back')}</button><button type="submit" class="btn btn-primary" ${options.length?'':'disabled'}>${tr('تسجيل التسوية','Record settlement')}</button></footer></form>`);
    const form=el('form');const update=()=>{el('[data-as-carrier-fields]').hidden=form.elements.kind.value!=='carrier';const net=(form.elements.includesCollection?.checked?w.quote.collectDue:0)-Number(form.elements.actualCost.value);el('[data-as-net]').textContent=tr('صافي حركة الخزنة: ','Net vault movement: ')+(net<0?tr('خروج ','Outflow '):tr('دخول ','Inflow '))+amount(Math.abs(net));};form.oninput=update;update();
    el('[data-as-back]').onclick=()=>open(row._id,true);
    form.onsubmit=async event=>{event.preventDefault();if(busy)return;setBusy(true);try{const result=await post('settle',row._id,{kind:form.elements.kind.value,method:form.elements.method.value,reference:form.elements.reference.value,actualCost:Number(form.elements.actualCost.value),includesCollection:form.elements.includesCollection?.checked===true,confirmed:true});await savedStep(result,row._id,['returns','transactions','vault']);message(tr('تم تسجيل التسوية المالية وربط قيد الخزنة بالطلب.','Settlement recorded and the vault entry linked to this case.'),false);}catch(error){message(error.message);}finally{setBusy(false);}};
  }
  async function list(invoiceId) {
    complaintOrigin=null;suspendedView=null;
    const version=show(tr('الاسترجاع والاستبدال','Returns and exchanges'),'',tr('جارٍ التحميل…','Loading…'));
    try{const rows=await api('/after-sales'+(invoiceId?'?invoiceId='+encodeURIComponent(invoiceId):''));if(version!==serial||!dialog.open)return;
      show(tr('الاسترجاع والاستبدال','Returns and exchanges'),tr('ملفات الطلبات والشحن والتسوية','Requests, shipments and settlements'),`<div class="as-actions" style="margin-bottom:14px"><button type="button" class="btn btn-outline" data-as-report>${tr('تقرير خدمة ما بعد البيع','After-sales report')}</button>${admin()?`<button type="button" class="btn btn-outline" data-as-policy>${tr('إعداد السياسة','Policy settings')}</button>`:''}</div><label class="as-field">${tr('بحث بالعميل أو الفاتورة أو البوليصة','Search customer, invoice or tracking number')}<input type="search" data-as-search></label><div data-as-list></div>`);
      const render=()=>{const q=el('[data-as-search]').value.toLowerCase();const filtered=rows.filter(r=>[r.client,r.phone,r.originalRef,r.workflow.ref,r.returnTxRef,r.workflow.replacementRef,r.workflow.shipment?.trackingNumber].join(' ').toLowerCase().includes(q));el('[data-as-list]').innerHTML=filtered.map(r=>`<article class="as-list-row"><div><strong>${esc(r.client)}</strong><div class="as-muted">#${esc(r.originalRef)} · ${r.requestKind==='exchange'?tr('استبدال','Exchange'):tr('استرجاع','Return')}</div></div><div><span class="as-badge">${stage(r.workflow.stage,r.requestKind)}</span><div class="as-muted">${date(r.createdAt)}</div>${shippingBadges({afterSales:{shipments:{current:{caseId:r._id,kind:r.requestKind,...r.workflow.shipment,status:r.workflow.shipment?.carrierStatus||'CREATED'}}}})}</div><button class="btn btn-outline" data-as-open="${esc(r._id)}">${tr('فتح الملف','Open case')}</button></article>`).join('')||`<div class="as-banner">${tr('لا توجد طلبات مطابقة.','No matching requests.')}</div>`;dialog.querySelectorAll('[data-as-open]').forEach(b=>b.onclick=()=>open(b.dataset.asOpen));};el('[data-as-search]').oninput=render;render();el('[data-as-report]').onclick=report;el('[data-as-policy]')?.addEventListener('click',policy);
    }catch(error){message(error.message);}
  }
  function reportStatus(row) {
    const shipment=row.workflow.shipment;
    let details='';
    if(shipment?.deliveryId){
      const meta=SouliaOrderStatus.resolve({bostaOrderId:shipment.deliveryId,bostaStatus:shipment.carrierStatus||'CREATED',shipCo:'Bosta'},'transaction',tr('ar','en'));
      details=`<button type="button" class="as-report-shipment" data-as-open="${esc(row._id)}"><span class="as-report-shipment-label">${tr(row.requestKind==='exchange'?'شحنة استبدال':'سحب مرتجع',row.requestKind==='exchange'?'Exchange shipment':'Return collection')}</span>${SouliaOrderStatus.badge(meta)}${shipment.trackingNumber?`<bdi class="as-report-tracking" dir="ltr">${esc(shipment.trackingNumber)}</bdi>`:''}</button>`;
    }
    return `<div class="as-report-status"><span>${stage(row.workflow.stage,row.requestKind)}</span>${details}</div>`;
  }
  async function report() {
    complaintOrigin=null;suspendedView=null;
    show(tr('تقرير خدمة ما بعد البيع','After-sales report'),'',`<form class="as-two"><label class="as-field">${tr('من تاريخ','From')}<input type="date" name="from"></label><label class="as-field">${tr('إلى تاريخ','To')}<input type="date" name="to"></label><button class="btn btn-primary" type="submit">${tr('عرض التقرير','Run report')}</button><button class="btn btn-outline" type="button" data-as-export>${tr('تصدير CSV','Export CSV')}</button></form><div data-as-report-results style="margin-top:18px"></div>`);
    const form=el('form');let data;
    async function run(){try{const params=new URLSearchParams();if(form.elements.from.value)params.set('from',form.elements.from.value);if(form.elements.to.value)params.set('to',form.elements.to.value);data=await api('/after-sales/report?'+params);const s=data.summary;el('[data-as-report-results]').innerHTML=`<div class="as-kpis">${[[tr('طلبات مفتوحة','Open cases'),s.open],[tr('مكتملة','Completed'),s.closed],[tr('مبالغ رُدت','Refunded'),amount(s.refunded)],[tr('تكلفة الناقل','Carrier cost'),amount(s.carrierCost)],[tr('مستحق للعميل','Pending refunds'),amount(s.refundPending)],[tr('متبقي للتحصيل','Pending collection'),amount(s.collectPending)],[tr('قيمة التالف','Damaged value'),amount(s.damagedValue)],[tr('استبدال / استرجاع','Exchange / return'),s.exchanges+' / '+s.returns]].map(([label,value])=>`<div class="as-kpi"><span>${label}</span><b>${value}</b></div>`).join('')}</div><div class="as-table-wrap as-report-table-wrap" tabindex="0" role="region" aria-labelledby="as-title"><table class="as-table as-report-table"><colgroup><col class="as-report-invoice-col"><col class="as-report-customer-col"><col class="as-report-status-col"><col span="3" class="as-report-money-col"></colgroup><thead><tr><th scope="col">${tr('الفاتورة','Invoice')}</th><th scope="col">${tr('العميل','Customer')}</th><th scope="col">${tr('الحالة','Status')}</th><th scope="col">${tr('رصيد المرتجع','Return credit')}</th><th scope="col">${tr('رد فعلي','Refund paid')}</th><th scope="col">${tr('تكلفة الناقل','Carrier cost')}</th></tr></thead><tbody>${data.rows.map(r=>`<tr><td><button class="as-link" data-as-open="${esc(r._id)}">${esc(r.originalRef)}</button></td><td class="as-report-customer"><bdi>${esc(r.client)}</bdi></td><td>${reportStatus(r)}</td><td class="as-report-money"><bdi>${amount(r.total)}</bdi></td><td class="as-report-money"><bdi>${amount(r.workflow.refund?.amount)}</bdi></td><td class="as-report-money"><bdi>${amount(r.workflow.carrierSettlement?.cost)}</bdi></td></tr>`).join('')||`<tr><td colspan="6" class="as-report-empty">${tr('لا توجد طلبات في الفترة المحددة.','No cases in the selected period.')}</td></tr>`}</tbody></table></div>`;dialog.querySelectorAll('[data-as-open]').forEach(b=>b.onclick=()=>open(b.dataset.asOpen));}catch(error){message(error.message);}}
    form.onsubmit=e=>{e.preventDefault();void run();};el('[data-as-export]').onclick=()=>{if(!data)return;const cell=value=>'"'+String(value??'').replace(/"/g,'""').replace(/^[=+@-]/,"'")+'"';const rows=[['Case','Invoice','Customer','Kind','Stage','Tracking number','Shipping status','Return credit','Replacement','Customer fee','Refund paid','Collected','Carrier cost'],...data.rows.map(r=>[r.workflow.ref,r.originalRef,r.client,r.requestKind,r.workflow.stage,r.workflow.shipment?.trackingNumber||'',r.workflow.shipment?.carrierStatus||'',r.total,r.exchangeTotal,r.workflow.quote.customerFee,r.workflow.refund?.amount||0,r.workflow.collection?.amount||0,r.workflow.carrierSettlement?.cost||0])];const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='after-sales.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};await run();
  }
  async function policy() {
    complaintOrigin=null;suspendedView=null;
    try{const p=await api('/after-sales/policy');show(tr('سياسة الاسترجاع والاستبدال','Returns and exchange policy'),tr('تُحفظ نسخة السياسة مع كل طلب','Each case keeps its policy version'),`<form><div class="as-two">${[['normalDays',tr('مهلة رغبة العميل بالأيام','Customer preference window, days')],['defectDays',tr('مهلة العيوب بالأيام','Defect window, days')],['exchangeFee',tr('تكلفة الاستبدال الافتراضية','Default exchange cost')],['returnFee',tr('تكلفة الاسترجاع الافتراضية','Default return cost')]].map(([name,label])=>`<label class="as-field">${label}<input type="number" min="0" step="${name.endsWith('Fee') ? '0.01' : '1'}" name="${name}" value="${p[name]}" required></label>`).join('')}</div><label class="as-check"><input type="checkbox" name="customerFeesEnabled" ${p.customerFeesEnabled?'checked':''}>${tr('تفعيل تكلفة رغبة العميل وإتاحة تعديلها لكل عملية، بما فيها الاستلام المباشر','Enable customer preference costs and manual edits per request, including direct handover')}</label><label class="as-field">${tr('الحالات التي تسمح برسوم العميل','Cases where customer fees apply')}<textarea name="feePolicyNote" rows="3" maxlength="1000">${esc(p.feePolicyNote)}</textarea></label><label class="as-field">${tr('معرّف موقع العودة لدى بوسطة','Bosta return business location ID')}<input name="businessLocationId" value="${esc(p.businessLocationId)}"></label><div class="as-banner">${tr('الديفوه وخطأ الشركة بدون رسوم على العميل. المهلة تبدأ من تاريخ الاستلام، وتُراجع حالات الرسوم وفق السياسة المطبقة.','Defects and company errors have no customer fee. Eligibility begins at delivery; fees must follow the applicable policy.')}</div><footer class="as-foot"><button class="btn btn-primary" type="submit">${tr('حفظ السياسة','Save policy')}</button></footer></form>`);el('form').onsubmit=async event=>{event.preventDefault();setBusy(true);try{const f=event.target.elements,body={};for(const name of ['normalDays','defectDays','exchangeFee','returnFee'])body[name]=Number(f[name].value);Object.assign(body,{customerFeesEnabled:f.customerFeesEnabled.checked,feePolicyNote:f.feePolicyNote.value,businessLocationId:f.businessLocationId.value});await api('/after-sales/policy',{method:'POST',body:JSON.stringify(body)});message(tr('تم حفظ السياسة.','Policy saved.'),false);}catch(error){message(error.message);}finally{setBusy(false);}};}catch(error){message(error.message);}
  }
  async function printCase(row, printWindow) {
    const popup=printWindow||window.open('','_blank');if(!popup){message(tr('اسمح بنافذة الطباعة.','Allow the print window.'));return;}
    const w=row.workflow, exchange=row.requestKind==='exchange', q=w.quote;
    const title=exchange?tr('فاتورة استبدال','Exchange invoice'):tr('فاتورة استرجاع','Return invoice');
    const money=value=>`<bdi dir="ltr">${esc(amount(value))}</bdi>`;
    const field=(label,value,ltr=false,wide=false)=>`<div class="field${wide?' wide-field':''}"><dt>${label}</dt><dd>${ltr?'<bdi dir="ltr">':''}${esc(value??'—')||'—'}${ltr?'</bdi>':''}</dd></div>`;
    const moneyRow=(label,value,highlight=false)=>`<div class="money-row${highlight?' total':''}"><span>${label}</span><strong>${money(value)}</strong></div>`;
    const itemsTable=(heading,items)=>{
      const rows=(items||[]).map((i,index)=>{
      const total=i.total!=null?Number(i.total):i.price!=null?Number(i.price)*Number(i.qty):null;
      const price=i.price!=null?Number(i.price):total!=null&&Number(i.qty)>0?total/Number(i.qty):null;
      return `<tr><td>${index+1}</td><td><strong>${esc(i.name||i.code||'—')}</strong>${i.code?` <small>· <bdi dir="ltr">${esc(i.code)}</bdi></small>`:''}${i.condition?` <small>· ${esc(i.condition==='سليم'?tr('سليم','Sound'):i.condition==='تالف'?tr('تالف','Damaged'):i.condition)}</small>`:''}</td><td class="number"><bdi>${esc(i.qty)}</bdi></td><td class="number">${price==null?'—':money(price)}</td><td class="number">${total==null?'—':money(total)}</td></tr>`;
      });
      const table=part=>`<table><colgroup><col style="width:6%"><col style="width:38%"><col style="width:8%"><col style="width:24%"><col style="width:24%"></colgroup><thead><tr><th>#</th><th>${tr('المنتج / الكود','Product / code')}</th><th class="number">${tr('الكمية','Qty')}</th><th class="number">${tr('سعر الوحدة','Unit price')}</th><th class="number">${tr('الإجمالي','Total')}</th></tr></thead><tbody>${part.join('')||`<tr><td colspan="5">${tr('لا توجد منتجات مسجلة','No items recorded')}</td></tr>`}</tbody></table>`;
      const middle=Math.ceil(rows.length/2);
      return `<section class="items"><h2>${heading} <span class="item-count">${tr('إجمالي القطع','Total quantity')}: ${(items||[]).reduce((sum,item)=>sum+Number(item.qty||0),0)}</span></h2>${rows.length>18?`<div class="item-columns">${table(rows.slice(0,middle))}${table(rows.slice(middle))}</div>`:table(rows)}</section>`;
    };
    const address={...(row.addressHint||{}),...(w.customerAddress||{})};
    const addressText=[address.firstLine,address.districtName||address.district,address.cityName||address.city].filter(Boolean).join(' · ');
    const refundPaid=Number(w.refund?.amount||0), collected=Number(w.collection?.amount||0);
    const balanceLabel=exchange&&q?.collectDue?tr('المتبقي للتحصيل من العميل','Remaining to collect'):tr('المتبقي للرد إلى العميل','Remaining customer refund');
    const balance=q?Math.max(0,exchange&&q.collectDue?Number(q.collectDue)-collected:Number(q.refundDue||0)-refundPaid):null;
    const paymentDetails=[['refund',tr('رد المبلغ','Refund')],['collection',tr('التحصيل','Collection')]].filter(([key])=>w[key]).map(([key,label])=>{
      const payment=w[key];
      return `<div class="payment-record"><strong>${label}</strong><span>${esc([payment.method,payment.reference,payment.at?date(payment.at):''].filter(Boolean).join(' · ')||'—')}</span></div>`;
    }).join('');
    const notes=[[tr('تفاصيل الطلب','Request details'),row.reasonDetails],[tr('سبب الرسوم','Fee basis'),w.feeBasis],[tr('إثبات التسليم','Delivery evidence'),w.deliveryEvidence]].filter(([,value])=>value);
    const sideBySide=exchange&&(row.items?.length||0)+(row.exchangeItems?.length||0)>18&&Math.max(row.items?.length||0,row.exchangeItems?.length||0)<=18;
    const shippingInfo=`<h2>${tr('الشحن والاستلام','Shipment and receipt')}</h2><dl style="margin:0">${field(tr('طريقة التنفيذ','Fulfillment'),w.fulfillmentChannel==='direct'?tr('استلام وتسليم مباشر','Direct handover'):row.returnShipCo||'Bosta')}${field(exchange?tr('بوليصة الاستبدال','Exchange waybill'):tr('بوليصة سحب المرتجع','Return collection waybill'),w.shipment?.trackingNumber||row.returnTrackingNumber,true)}${field(tr('استلام المخزن','Warehouse receipt'),date(w.receivedAt)+(w.receivedBy?' · '+w.receivedBy:''))}${exchange?field(tr('تسليم البديل','Replacement delivery'),date(w.replacementDeliveredAt)):''}${w.shipment?.carrierLabel||w.shipment?.status?field(tr('حالة الشحنة','Shipment status'),w.shipment.carrierLabel||w.shipment.status):''}</dl>${paymentDetails?`<section class="payment-details"><h2>${tr('حركات الدفع المسجلة','Recorded payments')}</h2>${paymentDetails}</section>`:''}${w.carrierSettlement?`<section class="carrier-settlement"><h2>${tr('تسوية شركة الشحن','Carrier settlement')}</h2>${moneyRow(tr('تكلفة الناقل','Carrier cost'),w.carrierSettlement.cost)}<p class="note">${esc([w.carrierSettlement.method,w.carrierSettlement.reference,w.carrierSettlement.at?date(w.carrierSettlement.at):''].filter(Boolean).join(' · '))}</p></section>`:''}`;
    popup.document.write(`<!doctype html><html lang="${tr('ar','en')}" dir="${tr('rtl','ltr')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} - ${esc(w.ref)}</title><style>
      *{box-sizing:border-box}body{margin:0;background:#edf0f4;color:#172033;font:13px/1.65 Arial,Tahoma,sans-serif}.toolbar{max-width:794px;margin:18px auto;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:0 16px;color:#526074}.toolbar button{border:0;border-radius:6px;background:#172033;color:white;padding:10px 24px;font:inherit;cursor:pointer}.sheet{max-width:794px;margin:0 auto 24px;background:white;padding:36px 40px;box-shadow:0 2px 16px #17203314}.invoice-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;border-bottom:3px solid #172033;padding-bottom:20px}.brand{font-size:30px;letter-spacing:3px;font-weight:800;line-height:1.2}.eyebrow{font-size:11px;color:#526074;margin-top:8px}h1{font-size:23px;margin:0 0 6px;line-height:1.4}.document-title{text-align:end}.reference{font-size:13px}.status{display:inline-block;border:1px solid #c3cbd4;border-radius:4px;padding:3px 10px;margin-top:10px;font-size:11px}.details{display:grid;grid-template-columns:1fr 1fr;gap:8px 26px;margin:20px 0;padding:16px;border:1px solid #dce1e7;border-radius:6px}.field{min-width:0}dt{font-size:10px;color:#526074}dd{margin:2px 0 0;font-weight:600;overflow-wrap:anywhere}h2{font-size:14px;margin:0 0 10px}.items{margin:22px 0}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}th,td{padding:10px 8px;text-align:start;border-bottom:1px solid #dce1e7;overflow-wrap:anywhere;vertical-align:top}th{background:#f2f4f7;font-size:10px;color:#526074;border-top:1px solid #dce1e7}.number{text-align:end;font-variant-numeric:tabular-nums}small{display:block;font-size:10px;color:#526074;margin-top:3px}.settlement{display:grid;grid-template-columns:1fr 1.15fr;gap:24px;margin-top:24px;align-items:start}.shipping{border:1px solid #dce1e7;border-radius:6px;padding:14px}.shipping .field+.field{margin-top:10px}.money-row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid #e6e9ee;font-size:12px}.money-row strong{white-space:nowrap;font-variant-numeric:tabular-nums}.total{border-top:2px solid #172033;border-bottom:2px solid #172033;margin-top:8px;padding:12px 0;font-size:13px}.paid{margin-top:12px}.balance{font-weight:bold;margin-top:8px}.note{color:#526074;font-size:10px;margin:14px 0 0;white-space:pre-line;overflow-wrap:anywhere}.invoice-footer{border-top:1px solid #dce1e7;margin-top:28px;padding-top:10px;display:flex;justify-content:space-between;gap:16px;font-size:10px;color:#526074}.invoice-footer bdi{flex-shrink:0}
      .print-preview{overflow:auto}.print-page{width:210mm;min-height:297mm;padding:10mm;margin:0 auto 24px;background:#fff;box-shadow:0 2px 16px #17203314}.sheet{width:190mm;max-width:none;margin:0 auto;padding:0;box-shadow:none;font-size:11px;line-height:1.4}.invoice-head{padding-bottom:10px;border-bottom-width:2px;gap:12px}.brand{font-size:27px}.eyebrow{font-size:9px;margin-top:4px}h1{font-size:21px;margin-bottom:3px}.reference{font-size:11px}.status{margin-top:5px;padding:2px 8px;font-size:10px}.details{grid-template-columns:repeat(3,minmax(0,1fr));gap:7px 14px;margin:12px 0;padding:10px;border-radius:4px}.wide-field{grid-column:span 2}dt{font-size:9px}dd{font-size:11px;margin-top:1px}.items{margin:12px 0}h2{font-size:12px;margin:0 0 6px}.items h2{display:flex;align-items:baseline;justify-content:space-between;gap:10px}.item-count{font-size:9px;font-weight:400;color:#526074}table{font-size:10.5px}th,td{padding:5px 5px}th{font-size:9px}td small{display:inline;font-size:9px;margin:0 0 0 5px}.item-columns,.item-tables.side-by-side{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start}.item-columns table,.side-by-side table{font-size:9px}.item-columns th,.side-by-side th{font-size:8px}.item-columns th,.item-columns td,.side-by-side th,.side-by-side td{padding:3px}.side-by-side .items{min-width:0}.settlement{grid-template-columns:1fr 1.1fr;gap:16px;margin-top:12px}.shipping{padding:10px;border-radius:4px}.shipping dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 10px}.shipping .field+.field{margin:0}.money-row{font-size:10.5px;padding:4px 0;gap:10px}.total{font-size:11px;margin-top:5px;padding:6px 0;border-width:1px}.paid{margin-top:6px}.balance{margin-top:4px}.note{font-size:9px;margin-top:8px}.payment-record{margin-top:6px;padding-top:6px;border-top:1px solid #dce1e7;font-size:9px;overflow-wrap:anywhere}.payment-record strong,.payment-record span{display:block}.invoice-notes{margin-top:10px;padding:8px 10px;border:1px solid #dce1e7;border-radius:4px;font-size:10px;overflow-wrap:anywhere;white-space:pre-line}.invoice-notes p{margin:3px 0}.invoice-footer{margin-top:12px;padding-top:7px;font-size:9px;gap:12px}.print-signatures{display:flex;justify-content:space-between;gap:20px;margin-top:18px;font-size:10px}.print-signatures span{flex:1;border-top:1px solid #c3cbd4;padding-top:5px}
      @page{size:A4 portrait;margin:10mm} @media print{html,body{background:#fff}.toolbar{display:none}.print-preview{overflow:visible}.print-page{width:190mm;min-height:0;margin:0;padding:0;box-shadow:none}.sheet{margin:0 auto}thead{display:table-header-group}tr,.invoice-head,.details,.settlement,.invoice-footer,.invoice-notes,.print-signatures{break-inside:avoid}h2{break-after:avoid}th{print-color-adjust:exact;-webkit-print-color-adjust:exact}}@media screen and (max-width:600px){.toolbar{font-size:11px}.toolbar button{padding:8px 12px}.print-page{margin-inline:0}}
      .payment-details,.carrier-settlement{margin-top:10px}
    </style></head><body><div class="toolbar"><span>${tr('ورقة واحدة · A4','One page · A4')}</span><button type="button" id="print-invoice">${tr('طباعة / حفظ PDF','Print / Save PDF')}</button></div><div class="print-preview"><main class="print-page"><article class="sheet"><header class="invoice-head"><div><div class="brand" dir="ltr">SOULIA</div><div class="eyebrow">${tr('خدمة ما بعد البيع','AFTER-SALES SERVICE')}</div></div><div class="document-title"><h1>${title}</h1><div class="reference"><bdi dir="ltr">${esc(w.ref)}</bdi></div><span class="status">${esc(stage(w.stage,row.requestKind))}</span></div></header>
      <dl class="details">${field(tr('العميل','Customer'),address.customerName||row.client)}${field(tr('رقم الهاتف','Phone'),address.phone||row.phone,true)}${field(tr('تاريخ الطلب','Request date'),date(row.createdAt))}${field(tr('الفاتورة الأصلية','Original invoice'),row.originalRef?'#'+row.originalRef:'',true)}${exchange&&w.replacementRef?field(tr('فاتورة البديل','Replacement invoice'),'#'+w.replacementRef,true):''}${row.returnTxRef?field(tr('فاتورة المرتجع','Return invoice'),'#'+row.returnTxRef,true):''}${field(tr('سبب الطلب','Request reason'),reasonLabel(row.reason))}${addressText?field(tr('عنوان العميل','Customer address'),addressText,false,true):''}${row.requestedBy?field(tr('مسجل الطلب','Requested by'),row.requestedBy):''}${w.approvedBy?field(tr('الاعتماد','Approval'),w.approvedBy+' · '+date(w.approvedAt)):''}</dl>
      <div class="item-tables${sideBySide?' side-by-side':''}">${itemsTable(tr('المنتجات المرتجعة','Returned items'),row.items)}${exchange?itemsTable(tr('المنتجات البديلة','Replacement items'),row.exchangeItems):''}</div>
      <div class="settlement"><section class="shipping">${shippingInfo}</section><section class="financial"><h2>${tr('الملخص المالي','Financial summary')}</h2>${q?`${moneyRow(tr('قيمة المنتجات الراجعة','Returned items value'),q.credit)}${exchange?moneyRow(tr('قيمة البديل','Replacement value'),q.replacement):''}${moneyRow(exchange?tr('تكلفة الاستبدال','Exchange cost'):tr('تكلفة الاسترجاع المخصومة','Return cost deduction'),q.customerFee)}${moneyRow(exchange?(q.collectDue?tr('فرق مطلوب من العميل','Difference to collect'):q.refundDue?tr('فرق يُرد للعميل','Difference to refund'):tr('استبدال بدون فرق','Exchange with no difference')):tr('صافي المبلغ المستحق للعميل','Net customer refund'),q.collectDue||q.refundDue,true)}`:`<p>${tr('لم يُحسب المبلغ بعد','Amount not calculated yet')}</p>`}<div class="paid">${moneyRow(tr('المدفوع فعليًا للعميل','Refund actually paid'),refundPaid)}${exchange?moneyRow(tr('التحصيل الفعلي','Actually collected'),collected):''}${balance!=null?`<div class="balance">${moneyRow(balanceLabel,balance)}</div>`:''}</div><p class="note">${tr('المبالغ المستحقة حسب الطلب؛ المدفوع والمحصّل حسب التسويات المسجلة.','Amounts due reflect the case quote; paid and collected amounts reflect recorded settlements.')}</p></section></div>
      ${notes.length?`<section class="invoice-notes">${notes.map(([label,value])=>`<p><strong>${label}: </strong>${esc(value)}</p>`).join('')}</section>`:''}
      <div class="print-signatures"><span>${tr('توقيع العميل','Customer signature')}</span><span>${tr('مسؤول الاستلام / التسليم','Receipt / delivery officer')}</span></div><footer class="invoice-footer"><span>${tr('مستند خدمة ما بعد البيع مرتبط بالفاتورة الأصلية.','After-sales document linked to the original invoice.')}</span><bdi dir="ltr">${esc(w.ref)}</bdi></footer></article></main></div></body></html>`);
    popup.document.close();
    // CSS uses the same 190 mm content width in preview and print. Fit all content
    // inside the 277 mm A4 printable height, including notes and final balances.
    const fitPage=()=>{
      if(popup.closed)return;
      const sheet=popup.document.querySelector('.sheet');
      const applyScale=scale=>{sheet.style.zoom=String(scale);sheet.style.width=(190/scale)+'mm';};
      applyScale(1);
      const available=277*96/25.4-4;
      let scale=1;
      if(sheet.getBoundingClientRect().height>available){
        let low=.001,high=1;
        for(let attempt=0;attempt<12;attempt++){
          const candidate=(low+high)/2;applyScale(candidate);
          if(sheet.getBoundingClientRect().height<=available)low=candidate;else high=candidate;
        }
        scale=Math.floor(low*1000)/1000;applyScale(scale);
      }
      // Font rounding at a fractional zoom can wrap an extra line. Measure the
      // rendered result as well, rather than relying on the initial ratio alone.
      for(let attempt=0;attempt<8&&sheet.getBoundingClientRect().height>available;attempt++){
        scale=Math.max(.001,Math.floor(scale*available/sheet.getBoundingClientRect().height*995)/1000);
        applyScale(scale);
      }
      sheet.dataset.printScale=String(scale);
    };
    popup.addEventListener('beforeprint',fitPage);
    popup.document.getElementById('print-invoice').onclick=()=>{fitPage();popup.print();};
    await popup.document.fonts?.ready;
    if(popup.closed)return;
    popup.requestAnimationFrame(()=>popup.requestAnimationFrame(()=>{if(!popup.closed){fitPage();popup.focus();popup.print();}}));
  }
  function timeline(tx) {
    const groups=new Map();
    for(const event of tx.afterSalesEvents||[]){if(!groups.has(event.caseId))groups.set(event.caseId,[]);groups.get(event.caseId).push(event);}
    if(!groups.size)return '';
    return '<section class="as-invoice-timeline" dir="'+tr('rtl','ltr')+'"><h3>'+tr('مسار الاسترجاع والاستبدال','Return and exchange timeline')+'</h3>'+[...groups].map(([caseId,events])=>{
      const rows=events.slice().sort((a,b)=>new Date(a.at)-new Date(b.at)),last=rows[rows.length-1];
      const shipment=tx.afterSales?.shipments?.[caseId],kind=shipment?.kind||(rows.some(e=>e.replacementRef)?'exchange':'return');
      const currentStage=[...rows].reverse().find(e=>e.stage)?.stage;
      return '<article class="as-case-path"><header class="as-case-path-head"><div><strong>'+tr(kind==='exchange'?'طلب استبدال':'طلب استرجاع',kind==='exchange'?'Exchange case':'Return case')+' <bdi dir="ltr">'+esc(last.caseRef)+'</bdi></strong><p>'+tr('الفاتورة الأصلية','Original invoice')+' <bdi dir="ltr">#'+esc(last.originalRef)+'</bdi>'+(last.replacementRef?' · '+tr('البديل','Replacement')+' <bdi dir="ltr">#'+esc(last.replacementRef)+'</bdi>':'')+(last.returnRef?' · '+tr('المرتجع','Return')+' <bdi dir="ltr">#'+esc(last.returnRef)+'</bdi>':'')+'</p></div><button type="button" class="btn btn-outline btn-sm" onclick="AfterSales.open(&quot;'+esc(caseId)+'&quot;)">'+tr('متابعة الطلب','View case workflow')+'</button></header>'+
        (currentStage?'<p class="as-path-status">'+tr('حالة العملية','Case status')+': <strong>'+esc(stage(currentStage,kind))+'</strong></p>':'')+
        shippingBadges({afterSales:{shipments:shipment?{[caseId]:shipment}:{}}})+
        '<ol class="as-history as-path-events">'+rows.map((h,i)=>'<li class="'+(i===rows.length-1?'is-latest':'')+'"><span class="as-event-dot" aria-hidden="true">'+(i+1)+'</span><div class="as-event-content"><strong>'+esc(actionLabel(h.action))+'</strong><time>'+date(h.at)+' · '+esc(h.by||'')+'</time>'+(h.note?'<p>'+esc(h.note)+'</p>':'')+'</div></li>').join('')+'</ol></article>';
    }).join('')+'</section>';
  }
  function ledgerDetails(row) {
    const caseId=row.afterSalesId;if(!caseId)return '';
    const v=row.afterSales;
    return '<section class="as-card"><button class="btn btn-outline btn-sm" onclick="AfterSales.open(&quot;'+esc(caseId)+'&quot;)">'+tr('فتح ملف الاسترجاع / الاستبدال','Open return / exchange case')+' '+esc(v?.caseRef||row.afterSalesRef||'')+'</button><p>'+tr('الفاتورة الأصلية','Original invoice')+' #'+esc(v?.originalRef||row.originalInvoiceRef||'')+'</p>'+(v?'<p>'+tr('التحصيل الفعلي','Gross collection')+': '+amount(v.grossCollection)+' · '+tr('تكلفة الشحن','Carrier cost')+': '+amount(v.carrierCost)+' · '+tr('صافي حركة الخزنة','Net cash movement')+': '+amount(v.net)+'</p><p>'+tr('تسوية رصيد غير نقدية','Non-cash credit transfer')+': '+amount(v.creditApplied)+' · '+tr('مرجع الدفع','Payment reference')+': '+esc(v.paymentReference)+'</p>':'<p>'+tr('حركة القطع الفعلية (+ استلام / − خروج)','Physical pieces (+ receipt / − dispatch)')+': '+Number(row.physicalQty||0)+' · '+tr('معزول تالف','Quarantined damaged')+': '+Number(row.quarantinedQty||0)+' · '+tr('تغير الرصيد المتاح','Available stock change')+': '+Number(row.qtyDelta||0)+'</p>')+'</section>';
  }
  function invoiceNotes(tx) {
    const notes=String(tx?.notes||''), ref=tx?.afterSales?.caseRef, id=tx?.afterSales?.caseId;
    if(!ref||!id)return esc(notes);
    const link=`<button type="button" class="as-link" style="font:inherit;padding:0;white-space:nowrap" data-as-case-id="${esc(id)}" onclick="AfterSales.open(this.dataset.asCaseId)" title="${esc(tr('فتح ملف الاسترجاع / الاستبدال','Open return / exchange case'))}"><bdi dir="ltr">${esc(ref)}</bdi></button>`;
    return notes.split(ref).map(esc).join(link);
  }
  function invoiceActions(tx) {
    if(!tx?._id||tx.type!=='مبيعات'&&!tx.afterSales?.caseId||!allowed('transaction')&&!allowed('movements'))return '';
    const original=tx.afterSales?.originalTransactionId||tx._id;
    const linked=!!tx.afterSales?.caseId;
    const role=tx.afterSales?.role==='return'?tr('فاتورة مرتجع','Return invoice'):tr('فاتورة بديل','Replacement invoice');
    return `<section class="as-invoice-section" dir="${tr('rtl','ltr')}"><div class="as-invoice-tools"><small>${linked?`${role} · ${tr('مرتبطة بملف','Linked to case')} <bdi dir="ltr">${esc(tx.afterSales.caseRef||'')}</bdi>`:tr('الاسترجاع والاستبدال والشحن والتسويات المرتبطة بالفاتورة','Returns, replacements, shipments and settlements linked to this invoice')}</small><div class="as-invoice-buttons">${tx.type==='مبيعات'&&!tx.cancelled&&allowed('transaction')&&(tx.deliveredAt||tx.pickupStatus==='Delivered'||tx.bostaStatus==='DELIVERED')?`<button type="button" class="btn btn-outline btn-sm" onclick="AfterSales.create('${esc(tx._id)}')">${tr('طلب استرجاع / استبدال','Return / exchange request')}</button>`:''}<button type="button" class="btn btn-outline btn-sm" onclick="AfterSales.list('${esc(original)}')">${tr('الطلبات المرتبطة','Related cases')}</button>${linked?`<button type="button" class="btn btn-primary btn-sm" onclick="AfterSales.open('${esc(tx.afterSales.caseId)}')">${tr('فتح ملف الاسترجاع / الاستبدال','Open return / exchange case')}</button>`:''}</div></div>${linked?`<div class="as-banner">${tr('تُدار الأصناف والمبالغ وحركة المخزون والخزنة من ملف الاسترجاع أو الاستبدال المرتبط.','Items, amounts, inventory and vault movements are managed from the linked return or exchange case.')}</div>`:''}${timeline(tx)}</section>`;
  }
  function mountLaunchers() {
    for(const [page,permission] of [['movements','movements'],['reports','reports'],['settings','settings']]){
      const host=document.getElementById('page-'+page);if(!host||host.querySelector('[data-as-launcher]')||!allowed(permission))continue;
      const bar=document.createElement('div');bar.className='as-launcher';bar.dataset.asLauncher='1';const button=document.createElement('button');button.className='btn btn-outline';button.type='button';button.textContent=page==='reports'?tr('تقرير الاسترجاع والاستبدال','Returns and exchange report'):page==='settings'?tr('سياسة خدمة ما بعد البيع','After-sales policy'):tr('متابعة الاسترجاع والاستبدال','Manage returns and exchanges');button.onclick=page==='reports'?report:page==='settings'?policy:()=>list();button.title=button.textContent;bar.appendChild(button);const header=page==='movements'?host.querySelector('#mov-page-header'):page==='reports'?host.querySelector('#rep-export-actions'):null;if(header)header.appendChild(bar);else host.prepend(bar);
    }
  }
  async function changed(id) {
    refreshPreparationDetails(id);
    void refresh(['returns']);
    if(!busy&&dialog?.open&&activeCase?._id===id&&el('[data-as-print]'))void open(id);
  }
  window.AfterSales={create,open,fromComplaint,list,report,policy,invoiceNotes,invoiceActions,timeline,ledgerDetails,orderBadge,preparationDetails,loadPreparationDetails,refreshPreparationDetails,printOrderCase,shippingBadges,changed,selectIcon};
  document.addEventListener('DOMContentLoaded',()=>{mountLaunchers();let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;mountLaunchers();});}).observe(document.getElementById('main')||document.body,{childList:true,subtree:true});});
})();
