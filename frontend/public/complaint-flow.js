(function(){
  'use strict';
  const tr=(ar,en)=>typeof currentLang!=='undefined'&&currentLang==='en'?en:ar;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid=()=>crypto.randomUUID();
  const admin=()=>typeof isAdmin==='function'&&isAdmin();
  const canExecute=()=>admin()||typeof hasPerm==='function'&&hasPerm('transaction');
  const me=()=>currentUser?._id||currentUser?.userId||'';
  const time=v=>v?new Date(v).toLocaleString(currentLang==='en'?'en-GB':'ar-EG',{timeZone:'Africa/Cairo',numberingSystem:'latn'}):'—';
  const stages=()=>({review:tr('تحت المراجعة','In review'),planned:tr('حل محدد · ينتظر التنفيذ','Planned · awaiting execution'),execution:tr('قيد التنفيذ','In progress'),confirmation:tr('بانتظار تأكيد الحل','Confirm resolution'),waiting:tr('بانتظار المتابعة','Waiting'),blocked:tr('تنفيذ متعثر','Needs attention'),closed:tr('مغلقة','Closed')});
  const solutions=()=>({exchange:tr('استبدال','Exchange'),return:tr('استرجاع','Return'),support:tr('حل بالدعم والتوضيح','Support'),delivery:tr('معالجة مشكلة التوصيل','Delivery issue'),compensation:tr('تعويض مالي','Monetary compensation'),refund_without_return:tr('رد مبلغ دون استلام منتج','Refund without return')});
  const outcomes=()=>({resolved:tr('تم الحل','Resolved'),partial_agreement:tr('حل جزئي وافق عليه العميل','Agreed partial resolution'),rejected:tr('رفض مسبب','Rejected with reason'),withdrawn:tr('سحب العميل الشكوى','Withdrawn'),duplicate:tr('شكوى مكررة','Duplicate'),unreachable:tr('تعذر التواصل','Unable to reach customer')});
  const blockers=()=>({case_required:tr('إنشاء أو ربط طلب التنفيذ','Create or link an execution case'),case_cancelled:tr('الطلب المرتبط ملغى؛ راجع خطة الحل','Linked case cancelled; review the plan'),receipt:tr('استلام وفحص القطع الراجعة','Receive and inspect returned items'),delivery:tr('إثبات تسليم البديل','Verify replacement delivery'),refund:tr('رد مستحق العميل','Pay customer refund'),collection:tr('تحصيل الفرق','Collect the difference'),exception:tr('معالجة تعثر التنفيذ','Resolve the execution issue'),payment:tr('تسجيل الدفع الفعلي','Record actual payment'),evidence:tr('توثيق تنفيذ الحل','Document the resolution')});
  let dialog,surface,pageView,routeTask,routeIntent,active,serial=0,busy=false,queue='active',lastFocus,createDraft=null,draftOwner='';
  let listOpening;
  const reduced=()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visible=()=>surface===pageView?currentPage==='complaint-detail':!!dialog?.open;
  const closing=new WeakMap();
  function cancelClose(node){const pending=closing.get(node);if(pending){closing.delete(node);pending.animation.cancel();}}
  function enterMotion(node){cancelClose(node);if(!reduced())node?.animate?.([{opacity:0,transform:'translateY(6px) scale(.99)'},{opacity:1,transform:'none'}],{duration:180,easing:'cubic-bezier(.2,.8,.2,1)'});}
  function closeLayer(layer){
    if(!layer?.open)return;
    if(layer===dialog)closeCalendar();
    if(closing.has(layer))return closing.get(layer).task;
    if(reduced()){layer.close();return Promise.resolve();}
    const pending={animation:layer.animate([{opacity:1,transform:'none'},{opacity:0,transform:'translateY(4px) scale(.99)'}],{duration:130,easing:'ease-in'})};
    pending.task=pending.animation.finished.catch(()=>{}).then(()=>{if(closing.get(layer)!==pending)return;closing.delete(layer);layer.close();});
    closing.set(layer,pending);return pending.task;
  }
  function animateDisclosure(details){
    const content=details.querySelector('.cf-disclosure-body');if(!content)return;
    let animation,target=details.open;
    details.querySelector('summary').addEventListener('click',event=>{
      event.preventDefault();target=!target;
      const height=content.getBoundingClientRect().height;animation?.cancel();
      if(reduced()){details.open=target;content.style.overflow='';return;}
      if(target)details.open=true;
      content.style.overflow='hidden';
      const current=content.animate([{height:height+'px',opacity:target?0:1},{height:(target?content.scrollHeight:0)+'px',opacity:target?1:0}],{duration:180,easing:'cubic-bezier(.2,.8,.2,1)'});
      animation=current;
      current.finished.then(()=>{if(animation!==current)return;details.open=target;content.style.overflow='';animation=null;}).catch(()=>{});
    });
  }
  let draftImageKey='',draftImages=[];
  function releaseDraftImages(){for(const item of draftImages)URL.revokeObjectURL(item.url);draftImages=[];draftImageKey='';}
  function imageDraftStore(key,value){
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open('soulia-complaint-drafts',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('images');
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{
        const db=request.result,tx=db.transaction('images',value===undefined?'readonly':'readwrite'),store=tx.objectStore('images');
        const operation=value===undefined?store.get(key):value===null?store.delete(key):store.put(value,key);
        tx.oncomplete=()=>{db.close();resolve(operation.result);};
        tx.onabort=tx.onerror=()=>{db.close();reject(tx.error||operation.error);};
      };
    });
  }
  async function persistDraftImages(){
    if(!draftImageKey)return;
    try{await imageDraftStore(draftImageKey,draftImages.map(({id,file})=>({id,file})));}
    catch{toast(tr('تعذر حفظ صور المسودة على هذا الجهاز؛ احتفظ بالصفحة مفتوحة حتى تسجيل المشكلة.','Draft images could not be saved on this device. Keep this page open until the issue is saved.'),true);}
  }
  async function clearDraftImages(){const key=draftImageKey;releaseDraftImages();if(key)try{await imageDraftStore(key,null);}catch{}}
  const details=new Map(),reads=new Map(),images=new Map(),positions=new Map();
  let cacheOwner='',imageObserver,changeTimer,changeTask,photoDialog;
  function evidenceImage(row,attachment){
    checkOwner();
    const key=`${me()}:${row._id}:${attachment.id}`;
    if(!images.has(key)){
      const task=api(`/complaints/${row._id}/evidence/${attachment.id}`,{background:true}).catch(error=>{if(images.get(key)===task)images.delete(key);throw error;});
      images.set(key,task);if(images.size>30)images.delete(images.keys().next().value);
    }
    return images.get(key);
  }
  function previewImage(row,photos,index,trigger){
    if(busy)return;
    const sourceScroll={x:window.scrollX,y:window.scrollY};
    serial++;
    photoDialog?.close();
    const viewer=document.createElement('dialog');photoDialog=viewer;
    viewer.className='cf-photo-dialog';viewer.dir=tr('rtl','ltr');viewer.setAttribute('aria-labelledby','cf-photo-title');
    viewer.innerHTML=`<div class="cf-photo-shell"><header class="cf-photo-head"><div><small>${esc(row.complaintNo)}</small><h2 id="cf-photo-title">${tr('معاينة صور المشكلة','Issue photo preview')}</h2></div><button type="button" class="btn btn-outline" data-cf-photo-close>× <span>${tr('الرجوع للمشكلة','Back to issue')}</span></button></header><div class="cf-photo-stage" aria-busy="true"><img data-cf-photo-full hidden><div class="cf-photo-status" role="status" aria-live="polite"><span></span><button type="button" class="btn btn-outline" data-cf-photo-retry hidden>${tr('إعادة المحاولة','Retry')}</button></div></div><footer class="cf-photo-foot"><div class="cf-photo-caption"><strong data-cf-photo-count aria-live="polite"></strong><span data-cf-photo-name dir="auto"></span></div><div class="cf-photo-controls"><button type="button" class="btn btn-outline" data-cf-photo-prev aria-label="${tr('الصورة السابقة','Previous photo')}">${tr('→ السابقة','← Previous')}</button><button type="button" class="btn btn-outline" data-cf-photo-next aria-label="${tr('الصورة التالية','Next photo')}">${tr('التالية ←','Next →')}</button></div></footer></div>`;
    document.body.appendChild(viewer);
    const find=selector=>viewer.querySelector(selector),image=find('[data-cf-photo-full]'),status=find('.cf-photo-status'),stage=find('.cf-photo-stage');
    let version=0;
    function failed(){image.hidden=true;stage.setAttribute('aria-busy','false');status.hidden=false;status.querySelector('span').textContent=tr('تعذر تحميل الصورة. حاول مرة أخرى.','Could not load the photo. Please retry.');find('[data-cf-photo-retry]').hidden=false;}
    async function draw(){
      const request=++version,photo=photos[index];
      image.hidden=true;image.removeAttribute('src');image.alt=photo.name;
      stage.setAttribute('aria-busy','true');status.hidden=false;status.querySelector('span').textContent=tr('جارٍ تحميل الصورة…','Loading photo…');find('[data-cf-photo-retry]').hidden=true;
      find('[data-cf-photo-count]').textContent=tr(`صورة ${index+1} من ${photos.length}`,`Photo ${index+1} of ${photos.length}`);
      find('[data-cf-photo-name]').textContent=photo.name;
      find('[data-cf-photo-prev]').disabled=index===0;find('[data-cf-photo-next]').disabled=index===photos.length-1;
      image.onload=()=>{if(request!==version)return;image.hidden=false;stage.setAttribute('aria-busy','false');status.hidden=true;};
      image.onerror=()=>{if(request===version)failed();};
      try{
        const src=photo.url||(await evidenceImage(row,photo)).data;
        if(request===version&&viewer.open)image.src=src;
      }catch{if(request===version&&viewer.open)failed();}
    }
    const move=delta=>{if(index+delta>=0&&index+delta<photos.length){index+=delta;void draw();}};
    find('[data-cf-photo-prev]').onclick=()=>move(-1);find('[data-cf-photo-next]').onclick=()=>move(1);
    find('[data-cf-photo-retry]').onclick=()=>{images.delete(`${me()}:${row._id}:${photos[index].id}`);void draw();};
    find('[data-cf-photo-close]').onclick=()=>closeLayer(viewer);
    viewer.addEventListener('cancel',event=>{event.preventDefault();void closeLayer(viewer);});
    viewer.addEventListener('keydown',event=>{
      if(event.key==='Escape')event.stopPropagation();
      if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();move((event.key==='ArrowRight'?1:-1)*(viewer.dir==='rtl'?-1:1));}
    });
    let outside=false;
    viewer.addEventListener('pointerdown',event=>{outside=event.target===viewer;});
    viewer.addEventListener('click',event=>{if(outside&&event.target===viewer)void closeLayer(viewer);outside=false;});
    viewer.addEventListener('close',()=>{version++;viewer.remove();if(photoDialog===viewer)photoDialog=null;if(visible()&&trigger?.isConnected){trigger.focus({preventScroll:true});window.scrollTo({left:sourceScroll.x,top:sourceScroll.y,behavior:'instant'});}},{once:true});
    viewer.showModal();enterMotion(viewer);void draw();
  }
  function checkOwner(){if(cacheOwner!==me()){cacheOwner=me();details.clear();reads.clear();images.clear();positions.clear();}}
  function remember(row){checkOwner();details.set(String(row._id),{row,at:Date.now()});if(details.size>50)details.delete(details.keys().next().value);return row;}
  function readDetail(id,fresh=false,event=''){
    checkOwner();const key=String(id),cached=details.get(key),owner=me(),lang=tr('ar','en'),readKey=key+':'+lang+':'+event;
    if(!fresh&&cached&&Date.now()-cached.at<15000)return Promise.resolve(cached.row);
    if(reads.has(readKey))return reads.get(readKey);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    const task=api(`/complaints/${encodeURIComponent(id)}?view=workspace&lang=${lang}&event=${encodeURIComponent(event)}`,{background:true,signal:controller.signal}).then(row=>{
      if(me()===owner&&reads.get(readKey)===task)remember(row);return row;
    }).catch(e=>{if(e.name==='AbortError')throw new Error(tr('استغرق تحميل الملف وقتًا أطول من المتوقع. أعد المحاولة.','Loading took longer than expected. Please retry.'));throw e;}).finally(()=>{clearTimeout(timer);if(reads.get(readKey)===task)reads.delete(readKey);});
    reads.set(readKey,task);return task;
  }
  const el=s=>surface?.querySelector(s);
  function show(title,subtitle,html){
    photoDialog?.close();
    closeCalendar();
    if(!dialog){dialog=document.createElement('dialog');dialog.className='cf-dialog';document.body.appendChild(dialog);dialog.addEventListener('cancel',e=>{e.preventDefault();if(!busy)void closeLayer(dialog);});dialog.addEventListener('close',()=>{if(dialog.open)return;closeSelect();if(surface===dialog){serial++;surface=currentPage==='complaint-detail'?pageView:null;}if(!document.querySelector('.as-dialog[open]')){const focus=lastFocus?.isConnected?lastFocus:currentPage==='complaint-detail'?pageView?.querySelector('h1'):null;focus?.focus({preventScroll:true});}});}
    closeSelect();
    cancelClose(dialog);
    surface=dialog;
    delete dialog.dataset.cfFormAction;
    delete dialog.dataset.cfView;
    if(!dialog.open&&!document.activeElement?.closest('.as-dialog'))lastFocus=document.activeElement;
    dialog.dir=tr('rtl','ltr');dialog.setAttribute('aria-labelledby','cf-title');
    dialog.innerHTML=`<div class="cf-shell"><header class="cf-head"><div><small>${esc(subtitle)}</small><h2 id="cf-title">${esc(title)}</h2></div><button type="button" class="btn btn-outline" data-cf-dismiss aria-label="${tr('إغلاق','Close')}">×</button></header><div class="cf-body"><div class="cf-error" role="alert" data-cf-error></div>${html}</div></div>`;
    el('[data-cf-dismiss]').onclick=()=>{if(!busy)void closeLayer(dialog);};if(!dialog.open){dialog.showModal();enterMotion(dialog);}
    if(typeof _pmEnhanceSelects==='function')_pmEnhanceSelects(dialog);
    return ++serial;
  }
  function showPage(title,subtitle,html){
    photoDialog?.close();closeSelect();imageObserver?.disconnect();
    pageView=document.getElementById('complaint-workspace');surface=pageView;
    if(dialog?.open)void closeLayer(dialog);
    pageView.dir=tr('rtl','ltr');
    pageView.innerHTML=`<div class="cf-shell"><header class="cf-head cf-case-head"><button type="button" class="btn btn-outline cf-case-back" data-cf-page-back aria-label="${tr('الرجوع إلى الشكاوى','Back to complaints')}" title="${tr('الرجوع إلى الشكاوى','Back to complaints')}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 5-7 7 7 7M5 12h15"/></svg></button><div class="cf-case-heading"><small>${tr('ملف الشكوى','Complaint file')}</small><div class="cf-case-identity"><h1 id="cf-case-title" tabindex="-1">${esc(subtitle||tr('الشكوى','Complaint'))}</h1></div><p>${esc(title)}</p></div><div class="cf-case-head-actions"></div></header><div class="cf-body"><div class="cf-error" role="alert" data-cf-error></div>${html}</div></div>`;
    el('[data-cf-page-back]').onclick=back;
    if(typeof syncNavigationShell==='function')syncNavigationShell();
    return ++serial;
  }
  function back(){if(!busy)navigateTo('complaints');}
  function leave(){serial++;imageObserver?.disconnect();photoDialog?.close();if(dialog?.open)void closeLayer(dialog);}
  function closeSelect(){if(typeof _pmSelOpen!=='undefined'&&_pmSelOpen?.wrap.closest('.cf-dialog')===dialog)_pmSelClose();}
  function closeCalendar(){if(typeof _sdpInput!=='undefined'&&_sdpInput?.closest('.cf-dialog')===dialog&&typeof closeDatePicker==='function')closeDatePicker();}
  function visitExecution(row,caseId=''){
    if(busy)return;
    checkOwner();
    if(visible()&&active?._id===row._id){
      positions.set(String(row._id),surface===pageView?window.scrollY:el('.cf-body').scrollTop);
      if(positions.size>50)positions.delete(positions.keys().next().value);
    }
    const task=AfterSales.fromComplaint({complaintId:row._id,complaintNo:row.complaintNo,invoiceId:row.transactionId,kind:row.workflow?.solution,expectedComplaintRevision:row.workflow?.revision,items:row.items,caseId});
    if(document.querySelector('.as-dialog[open]')){closeSelect();serial++;if(dialog?.open)void closeLayer(dialog);}
    return task;
  }
  function execution(id){const row=details.get(String(id))?.row||(complaints||[]).find(c=>String(c._id)===String(id));if(row)return visitExecution(row,row.workflow?.caseId);}
  function resume(id){
    checkOwner();
    const task=open(id);
    const body=el('.cf-body');if(surface===pageView)window.scrollTo({top:positions.get(String(id))||0,behavior:'instant'});else if(body)body.scrollTop=positions.get(String(id))||0;
    if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches)body?.animate?.([{opacity:.65},{opacity:1}],{duration:140,easing:'ease-out'});
    return task;
  }
  const error=e=>{if(el('[data-cf-error]')){el('[data-cf-error]').textContent=e.message||String(e);el('[data-cf-error]').scrollIntoView({block:'nearest'});}else toast(e.message||String(e),true);};
  function buttonsDisabled(value){busy=value;surface?.querySelectorAll('button').forEach(b=>{if(value){b.dataset.wasDisabled=String(b.disabled);b.disabled=true;}else if('wasDisabled' in b.dataset){b.disabled=b.dataset.wasDisabled==='true';delete b.dataset.wasDisabled;}});}
  async function refresh(row){
    if(row){remember(row);const index=(complaints||[]).findIndex(c=>String(c._id)===String(row._id));if(index<0)complaints.unshift(row);else complaints[index]=row;if(typeof renderComplaints==='function')renderComplaints();if(typeof renderCmpNegAlert==='function')renderCmpNegAlert();}
    else if(typeof loadComplaints==='function')await loadComplaints();
    if(typeof buildNotifications==='function')buildNotifications();if(typeof buildSidebar==='function')buildSidebar();
  }
  async function mutate(row,action,fields){
    const storage=`complaint-operation:${me()}:${row._id}:${action}`;
    let pending;try{pending=JSON.parse(sessionStorage.getItem(storage)||'null');}catch{}
    if(!pending){pending={action,...fields,expectedRevision:row.workflow?.revision||0,operationKey:uid()};sessionStorage.setItem(storage,JSON.stringify(pending));}
    details.delete(String(row._id));reads.clear();
    try{const result=await api(`/complaints/${row._id}/workflow`,{method:'POST',body:JSON.stringify(pending)});sessionStorage.removeItem(storage);remember(result);return result;}
    catch(e){if(e.status>=400&&e.status<500&&![408,429].includes(e.status))sessionStorage.removeItem(storage);throw e;}
  }
  const field=(name,label,type='text',value='',extra='')=>`<label class="cf-field">${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const select=(name,label,values,value='',required=false)=>`<div class="cf-field"><span id="cf-label-${name}">${esc(label)}${required?' <span class="cf-required" aria-hidden="true">*</span>':''}</span><span class="cf-select"><select name="${name}" aria-labelledby="cf-label-${name}" ${name==='solution'?'data-icons="complaint-solution"':name==='categoryGroup'?'data-icons="complaint-category"':''} ${required?'required':''}>${Object.entries(values).map(([key,text])=>`<option value="${esc(key)}" ${key===value?'selected':''}>${esc(text)}</option>`).join('')}</select></span></div>`;
  function shippingStatus(tx,compact=false){
    if(!window.SouliaOrderStatus)return '';
    const meta=SouliaOrderStatus.resolve(tx,'transaction',tr('ar','en'));
    return `<span class="cf-shipping">${SouliaOrderStatus.badge(meta,{compact})}${!compact&&meta.carrier?`<small>${esc(meta.carrier)}</small>`:''}${!compact&&meta.note?`<small>${esc(meta.note)}</small>`:''}</span>`;
  }
  function productImage(item){
    const catalog=typeof products!=='undefined'&&Array.isArray(products)?products.find(p=>(item.productId&&p._id===item.productId)||(item.code&&p.code===item.code)):null;
    const url=[item.imageUrl,catalog?.imageUrl,catalog?.images?.[0]].find(v=>typeof v==='string'&&/^(https?:\/\/|\/(?!\/)|data:image\/(png|jpeg|webp|gif);base64,)/i.test(v));
    return `<span class="cf-product-image"><span aria-hidden="true">▧</span>${url?`<img src="${esc(url)}" alt="${esc(item.name||catalog?.name||item.code||tr('منتج','Product'))}" loading="lazy" onerror="this.hidden=true">`:''}</span>`;
  }
  const note=(label=tr('التفاصيل وسبب الإجراء','Details and reason'),required=false)=>`<label class="cf-field">${esc(label)}${required?'':' · '+tr('اختياري','Optional')}<textarea name="note" ${required?'required':''} maxlength="2000"></textarea></label>`;
  const uploadControls=(count=0)=>{const hintId='cf-upload-hint-'+uid();return `<div class="cf-upload"><input type="file" accept="image/jpeg,image/png,image/webp" multiple data-cf-upload hidden><button type="button" class="btn btn-outline cf-upload-button" data-cf-choose-images aria-describedby="${hintId}" ${count>=10?'disabled':''}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/></svg><span>${tr('رفع صور','Upload images')}</span></button><small id="${hintId}">${tr('JPEG، PNG، WebP · حتى 5 ميجابايت للصورة · 10 صور كحد أقصى','JPEG, PNG, WebP · up to 5 MB each · maximum 10 images')}</small><span class="cf-muted" role="status" aria-live="polite" data-cf-upload-status></span></div>`;};
  function validateImages(files,count=0){
    if(files.length+count>10)throw new Error(tr('الحد الأقصى 10 صور لكل شكوى','Maximum 10 images per complaint'));
    for(const file of files){
      if(file.size>5*1024*1024)throw new Error(tr('الصورة أكبر من 5 ميجابايت','Image exceeds 5 MB'));
      if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error(tr('اختر صورة JPEG أو PNG أو WebP','Choose a JPEG, PNG or WebP image'));
    }
  }
  const confirm=(name,label)=>`<label class="cf-check"><input name="${name}" type="checkbox"><span>${esc(label)}</span></label>`;
  function cairoInput(date){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;}
  function cairoDate(value){let guess=Date.parse(value+'Z');for(let i=0;i<3;i++)guess+=Date.parse(value+'Z')-Date.parse(cairoInput(new Date(guess))+'Z');if(cairoInput(new Date(guess))!==value)throw new Error(tr('موعد غير صالح بتوقيت القاهرة','Invalid Cairo date/time'));return new Date(guess).toISOString();}
  const nextDay=()=>cairoInput(new Date(Date.now()+86400000));
  const deadline=()=>{const value=nextDay(),[day,hour]=value.split('T');return `<div class="cf-deadline"><span>${tr('موعد المتابعة القادمة · توقيت القاهرة','Next follow-up · Cairo time')}</span><div class="cf-deadline-inputs"><label class="cf-field"><span>${tr('التاريخ','Date')}</span><input name="dueDate" type="date" class="sdp-input" dir="ltr" required value="${day}" min="${cairoInput(new Date()).slice(0,10)}"></label><label class="cf-field"><span>${tr('الوقت','Time')}</span><input name="dueTime" type="time" dir="ltr" required value="${hour}"></label></div><input name="dueAt" type="hidden" value="${value}"></div>`;};
  const actionHelp=()=>({
    contact:tr('سجّل كيف تواصلت مع العميل، وما كانت النتيجة، ومتى ستتابع معه.','Record how you contacted the customer, the result, and when to follow up.'),
    assign:tr('حدّد الموظف المسؤول عن المشكلة وموعد المتابعة القادمة.','Choose who will handle the issue and set the next follow-up date.'),
    wait:tr('وضّح الجهة التي تنتظر ردها وحدّد موعدًا للمتابعة. تبقى المشكلة مفتوحة.','Choose who you are waiting for and set a follow-up date. The issue stays open.'),
    resume:tr('أعد متابعة المشكلة بعد انتهاء الانتظار وحدّد الموعد القادم.','Resume work after waiting and set the next follow-up date.'),
    items:tr('حدّد الفاتورة والمنتجات المتضررة وعدد القطع التي تخص المشكلة.','Select the invoice, affected products, and quantities involved.'),
    plan:tr('اختر طريقة الحل، مثل الاستبدال أو الاسترجاع أو الدعم. تحديد الخطة لا ينفّذها تلقائيًا.','Choose a solution, such as an exchange, return, or support. Choosing a plan does not carry it out.'),
    link:tr('اربط طلب استبدال أو استرجاع موجودًا يخص نفس الفاتورة والقطع.','Link an existing exchange or return request for the same invoice and items.'),
    unlink:tr('افصل طلب التنفيذ الملغى لتتمكن من تحديد خطة جديدة للمشكلة.','Unlink the cancelled execution request so you can choose a new solution.'),
    case:tr('افتح الطلب المرتبط لمتابعة الاستلام والتسليم والمبالغ المستحقة.','Open the linked request to follow receipt, delivery, and outstanding payments.'),
    'create-case':tr('أنشئ طلب الاستبدال أو الاسترجاع المرتبط بهذه المشكلة لبدء التنفيذ.','Create a linked exchange or return request to start carrying out the solution.'),
    fulfill:tr('أضف مرجعًا يثبت تنفيذ الحل وأكّد أنه تم فعليًا.','Add a reference that proves the solution was carried out and confirm completion.'),
    payment:tr('سجّل دفع المبلغ المعتمد للعميل، مع اختيار الخزنة وكتابة مرجع الدفع.','Record payment of the approved amount to the customer, including the account and payment reference.'),
    close:tr('اختر النتيجة النهائية وسبب الإغلاق. الإغلاق الناجح يتطلب اكتمال الحل وتأكيده.','Choose the final outcome and closure reason. Successful closure requires a completed, confirmed solution.'),
    reopen:tr('افتح دورة متابعة جديدة للمشكلة مع الاحتفاظ بما حدث في الدورات السابقة.','Start a new follow-up cycle while keeping the history of earlier cycles.'),
    archive:tr('انقل المشكلة المغلقة إلى الأرشيف. ستظل بياناتها وسجلها محفوظين.','Move the closed issue to the archive. Its details and history are kept.'),
    comment:tr('أضف ملاحظة للفريق داخل ملف المشكلة. لا تُرسل هذه الملاحظة للعميل.','Add a note for your team. This note is not sent to the customer.'),
    delete:tr('احذف المشكلة وصورها نهائيًا بعد التأكيد. لا يمكن التراجع؛ تبقى طلبات التنفيذ والمدفوعات محفوظة.','Permanently delete the issue and its images after confirmation. This cannot be undone; execution requests and payments are retained.'),
  });
  const actionIcons={
    contact:'<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
    assign:'<circle cx="9" cy="8" r="4"/><path d="M2 21v-2a7 7 0 0 1 11-5.7m3 3 2 2 4-4"/>',
    wait:'<path d="M21 10V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5M16 2v4M8 2v4M3 10h18"/><circle cx="17" cy="17" r="5"/><path d="M17 14v3l2 1"/>',
    resume:'<path d="M8 5v14l11-7z"/>',
    comment:'<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M8 8h4m-4 4h2m5-1 6-6a2.1 2.1 0 0 0-3-3l-6 6-1 4z"/>',
    items:'<path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8M7.5 5.5l9 5"/>',
    invoice:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8m-8 4h8m-8 4h5"/>',
    plan:'<circle cx="6" cy="5" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 8v6a4 4 0 0 0 4 4h5M9 5h3a3 3 0 0 1 3 3"/>',
    link:'<path d="M10 13a5 5 0 0 0 7 .4l3-3a5 5 0 0 0-7-7l-2 2m3 6a5 5 0 0 0-7-.4l-3 3a5 5 0 0 0 7 7l2-2"/>',
    unlink:'<path d="m3 3 18 18M9 15l-2 2a3 3 0 0 1-4-4l2-2m10-2 2-2a3 3 0 0 0-4-4l-2 2"/>',
    close:'<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
    resolved:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    reopen:'<path d="M3 11a9 9 0 1 1 3 7M3 4v7h7"/>',
    archive:'<rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v14h14V7M10 11h4"/>',
    delete:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    case:'<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9M14 3h7v7m0-7L10 14"/>',
    'create-case':'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 12v6m-3-3h6"/>',
    fulfill:'<rect x="4" y="4" width="16" height="18" rx="2"/><path d="M9 2h6v4H9zM8 13l3 3 5-6"/>',
    payment:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h3"/>',
  };
  const solutionIconPaths=new Map([
    ['exchange','<path d="M3 7h17l-4-4m5 14H4l4 4M3 7v5m18 5v-5"/>'],
    ['return','<path d="m9 4-6 6 6 6M3 10h12a6 6 0 0 1 0 12"/>'],
    ['support',actionIcons.contact],
    ['delivery','<path d="M3 5h12v12H3zM15 9h4l3 4v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>'],
    ['compensation','<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>'],
    ['refund_without_return','<path d="M3 8V5h16v4M3 8h18v13H3zM21 13h-5v4h5M9 16v-5m-3 3 3-3 3 3"/>'],
  ]);
  function solutionIcon(value){const path=solutionIconPaths.get(value);return path?`<svg class="pm-select-icon cf-solution-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`:'';}
  // Official Lucide SVGs (ISC): https://lucide.dev — vendor/lucide/LICENSE.
  const categoryIcons=new Map([
    ['مشكلة في المنتج',['package','<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>']],
    ['مشكلة في الشحن',['truck','<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>']],
    ['خدمة العملاء',['headset','<path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Zm0 0a9 9 0 1 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z"/><path d="M21 16v2a4 4 0 0 1-4 4h-5"/>']],
    ['أخرى',['ellipsis','<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>']],
  ]);
  function categoryIcon(value){const icon=categoryIcons.get(value);return icon?`<svg class="pm-select-icon cf-category-icon lucide lucide-${icon[0]}" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon[1]}</svg>`:'';}
  const productIssueTypes=()=>({wrong_color:tr('لون مختلف','Different color'),wrong_size:tr('مقاس غير صحيح','Wrong size'),wrong_item:tr('منتج مختلف','Wrong product'),missing:tr('المنتج لم يصل','Product not received'),damaged:tr('منتج تالف أو مكسور','Damaged or broken'),quality:tr('مشكلة في الجودة','Quality issue'),other:tr('مشكلة أخرى','Other issue')});
  const productIssueHint=type=>({wrong_color:tr('ما اللون المطلوب وما اللون الذي وصل؟','Which color was ordered, and which arrived?'),wrong_size:tr('اكتب المقاس المطلوب والمقاس الذي وصل.','Enter the ordered size and the size received.'),wrong_item:tr('ما المنتج المطلوب وما المنتج الذي وصل بدلًا منه؟','What was ordered, and what arrived instead?'),missing:tr('حدد القطع التي لم تصل وأي تفاصيل عن الشحنة.','Describe the missing items and any shipment details.'),damaged:tr('وضح مكان التلف أو الكسر في هذا المنتج.','Describe the damage to this product.'),quality:tr('وضح عيب الجودة في هذا المنتج.','Describe the quality problem with this product.'),other:tr('اكتب المشكلة الخاصة بهذا المنتج.','Describe this product’s issue.')}[type]||tr('اشرح المشكلة في هذا المنتج والنتيجة المطلوبة.','Describe this product’s issue and desired outcome.'));
  const actionLabels=()=>({contact:tr('تسجيل تواصل','Log customer contact'),assign:tr('تحديد المسؤول','Assign owner'),wait:tr('جدولة متابعة','Schedule follow-up'),resume:tr('استئناف المتابعة','Resume follow-up'),comment:tr('إضافة ملاحظة','Add internal note'),items:tr('المنتجات والكميات','Products & quantities'),plan:tr('خطة الحل','Resolution plan'),link:tr('ربط طلب موجود','Link existing request'),unlink:tr('فصل طلب ملغى','Unlink cancelled request'),close:tr('إغلاق الشكوى','Close complaint'),reopen:tr('إعادة فتح الشكوى','Reopen complaint'),archive:tr('أرشفة الشكوى','Archive complaint'),delete:tr('حذف الشكوى نهائيًا','Delete complaint permanently'),case:tr('متابعة الطلب المرتبط','Open linked request'),'create-case':tr('إنشاء طلب استرجاع أو استبدال','Create return or exchange request'),fulfill:tr('توثيق تنفيذ الحل','Document completed resolution'),payment:tr('تسجيل دفع مستحق العميل','Record customer payment')});
  const button=(key,label=actionLabels()[key],primary=false)=>{
    const text=label;
    return `<button type="button" class="btn cf-action-main ${primary?'btn-primary':'btn-outline'}" data-cf-action="${key}" aria-label="${esc(text)}" title="${esc(actionHelp()[key]||'')}">${actionIcons[key]?`<svg class="cf-action-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${actionIcons[key]}</svg>`:''}<span>${esc(text)}</span></button>`;
  };
  function actionPanel(row){
    const w=row.workflow||{},e=row.execution||{},closed=w.stage==='closed';
    const followUp=(!closed?button('contact')+button('assign')+button(w.stage==='waiting'?'resume':'wait'):'')+button('comment');
    const editable=!closed&&!w.caseId&&!w.payment&&!w.fulfillment;
    const plan=editable&&admin()?button('plan',w.solution?tr('تغيير الحل','Change solution'):actionLabels().plan,true):'';
    const products=editable?button('items',tr('المنتجات','Products')):'';
    const links=closed?'':(admin()&&['exchange','return'].includes(w.solution)&&!w.caseId?button('link',tr('ربط طلب','Link request')):'')+
      (admin()&&e.blockers?.includes('case_cancelled')?button('unlink'):'');
    const management=admin()?(closed?button('reopen')+(!w.archivedAt?button('archive'):''):button('close'))+button('delete'):'';
    return `<section class="cf-card cf-action-panel"><div class="cf-actions-heading"><h3>${tr('الإجراءات','Actions')}</h3><button type="button" class="cf-help-toggle" data-cf-help="cf-actions-guide" aria-controls="cf-actions-guide" aria-expanded="false">${tr('شرح الإجراءات','Action guide')}</button></div><div class="cf-action-list">${plan?`<div class="cf-action-priority">${plan}</div>`:''}${products||links?`<div class="cf-action-key-links">${products}${links}</div>`:''}<div class="cf-action-tools">${followUp}${management}</div></div><dl id="cf-actions-guide" class="cf-action-guide" hidden></dl></section>`;
  }
  function timeline(row){
    const w=row.workflow||{},createdText=/^تم (إنشاء|تسجيل) الشكوى$/;
    const events=[...(row.notes||[]).map(n=>({at:n.createdAt,by:n.author,note:n.text,action:n.kind==='system'&&createdText.test(n.text)?'registered':'comment'})),...(w.history||[]).map(event=>{const contact=event.action==='contact'?(w.contacts||[]).find(c=>c.at===event.at):null;return contact?{channel:contact.channel,contactResult:contact.result,dueAt:contact.dueAt,...event}:event;}),...(w.executionEvents||[])];
    if(!events.some(event=>event.action==='registered'))events.push({action:'registered',at:row.createdAt,by:row.submittedBy});
    events.sort((a,b)=>(Date.parse(a.at)||0)-(Date.parse(b.at)||0));
    const copy={
      registered:[tr('تسجيل المشكلة','Issue registered'),tr('تم فتح ملف للمشكلة لبدء متابعتها.','A case was opened to start following up on the issue.')],
      assign:[tr('تحديد المسؤول','Owner assigned'),tr('تم تحديد من سيتابع المشكلة وموعد المتابعة.','An owner and follow-up date were set.')],
      review:[tr('بدء المراجعة','Review started'),tr('بدأت مراجعة المشكلة لتحديد الحل المناسب.','The issue is being reviewed to choose a suitable solution.')],
      plan:[tr('اختيار الحل','Solution chosen'),tr('تم تحديد طريقة معالجة المشكلة.','A way to resolve the issue was chosen.')],
      wait:[tr('انتظار رد أو خطوة','Waiting for a response or step'),tr('توقفت المتابعة مؤقتًا لحين وصول الرد أو اكتمال الخطوة المطلوبة.','Follow-up is waiting for a response or a required step.')],
      resume:[tr('استئناف المتابعة','Follow-up resumed'),tr('استؤنفت متابعة المشكلة بعد الانتظار.','Work on the issue resumed after waiting.')],
      case_linked:[tr('ربط طلب التنفيذ','Execution request linked'),tr('تم ربط طلب لتنفيذ الاستبدال أو الاسترجاع ومتابعته.','An exchange or return request was linked for follow-up.')],
      unlink:[tr('مراجعة طلب ملغى','Cancelled request reviewed'),tr('تم فصل الطلب الملغى لإعادة النظر في الحل.','The cancelled request was unlinked so the solution can be reviewed.')],
      fulfill:[tr('توثيق تنفيذ الحل','Solution documented'),tr('تم تسجيل إثبات أن الحل نُفّذ بالفعل.','Evidence that the solution was carried out was recorded.')],
      payment:[tr('تسجيل دفع للعميل','Customer payment recorded'),tr('تم تسجيل دفع المبلغ المستحق للعميل.','Payment of the amount due to the customer was recorded.')],
      contact:[tr('تواصل مع العميل','Customer contact'),tr('تم تسجيل محاولة تواصل ونتيجتها.','A contact attempt and its outcome were recorded.')],
      close:[tr('إغلاق المشكلة','Issue closed'),tr('تم إنهاء المتابعة وتسجيل النتيجة النهائية.','Follow-up ended and the final outcome was recorded.')],
      reopen:[tr('إعادة فتح المشكلة','Issue reopened'),tr('بدأت دورة متابعة جديدة مع الاحتفاظ بالسجل السابق.','A new follow-up cycle started, keeping the earlier history.')],
      archive:[tr('نقل إلى الأرشيف','Moved to archive'),tr('نُقلت المشكلة المغلقة إلى الأرشيف مع حفظ بياناتها.','The closed issue was archived with its details retained.')],
      items:[tr('تحديث المنتجات والكميات','Products and quantities updated'),tr('تم تحديث الفاتورة والمنتجات والكميات المرتبطة بالمشكلة.','The invoice, affected products, and quantities were updated.')],
      comment:[tr('ملاحظة من الفريق','Team note'),tr('أُضيفت ملاحظة داخلية لمساعدة الفريق في المتابعة.','An internal note was added to help the team follow up.')],
      negative_rating:[tr('تقييم يحتاج مراجعة','Feedback needs review'),tr('وصل تقييم منخفض من العميل ويحتاج مراجعة المسؤول.','The customer left a low rating that needs review.')],
      attachment:[tr('إضافة صورة إثبات','Evidence image added'),tr('أُضيفت صورة توضح المشكلة أو تثبت ما حدث.','An image was added to explain the issue or document what happened.')],
      attachment_removed:[tr('حذف صورة إثبات','Evidence image deleted'),tr('حُذفت صورة من صور المشكلة.','An image was removed from the issue.')],
      requested:[tr('تسجيل طلب التنفيذ','Execution requested'),tr('تم إنشاء طلب لبدء تنفيذ الحل.','A request was created to carry out the solution.')],
      approved:[tr('اعتماد التنفيذ','Execution approved'),tr('تمت الموافقة على طلب التنفيذ.','The execution request was approved.')],
      cancelled:[tr('إلغاء طلب التنفيذ','Execution request cancelled'),tr('تم إلغاء الطلب المرتبط؛ قد تحتاج المشكلة إلى خطة بديلة.','The linked request was cancelled; the issue may need another solution.')],
      'step-rolled-back':[tr('التراجع عن خطوة تنفيذ','Execution step reversed'),tr('تم التراجع عن خطوة في الطلب المرتبط لإعادة معالجتها.','A step in the linked request was reversed so it can be handled again.')],
      'shipment-requested':[tr('طلب إنشاء شحنة','Shipment requested'),tr('بدأ طلب إنشاء شحنة لتنفيذ الحل.','A shipment was requested to carry out the solution.')],
      'shipment-created':[tr('إنشاء الشحنة','Shipment created'),tr('تم تسجيل شحنة ضمن طلب التنفيذ.','A shipment was created for the execution request.')],
      'shipment-linked':[tr('ربط شحنة موجودة','Existing shipment linked'),tr('تم ربط شحنة موجودة لمتابعة تنفيذ الحل.','An existing shipment was linked to follow the solution.')],
      'carrier-status':[tr('تحديث الشحن','Shipping updated'),tr('وصل تحديث لحالة الشحنة من شركة الشحن.','A shipment status update arrived from the carrier.')],
      'received-and-inspected':[tr('استلام وفحص القطع','Items received and inspected'),tr('تم استلام القطع الراجعة وتسجيل نتيجة فحصها.','Returned items were received and their inspection was recorded.')],
      'replacement-delivered':[tr('تسليم البديل','Replacement delivered'),tr('تم تسجيل تسليم البديل للعميل.','Delivery of the replacement to the customer was recorded.')],
      'settlement:refund':[tr('رد المبلغ للعميل','Customer refund'),tr('تم تسجيل رد المبلغ المستحق للعميل.','The customer refund was recorded.')],
      'settlement:collection':[tr('تحصيل الفرق','Difference collected'),tr('تم تسجيل تحصيل الفرق المستحق.','Collection of the outstanding difference was recorded.')],
      'settlement:carrier':[tr('تسوية شركة الشحن','Carrier settlement'),tr('تم تسجيل تسوية المبالغ مع شركة الشحن.','Settlement with the carrier was recorded.')],
      exception:[tr('تعثر في التنفيذ','Execution issue reported'),tr('سُجلت مشكلة أثناء التنفيذ وتحتاج إلى معالجة.','An issue during execution was recorded and needs attention.')],
      'exception-resolved':[tr('معالجة تعثر التنفيذ','Execution issue resolved'),tr('تم تسجيل معالجة المشكلة التي عطّلت التنفيذ.','The issue that held up execution was marked as resolved.')],
    };
    copy.link=copy.case_linked;
    const groups={registered:'registered',reopen:'reopen',review:'review',plan:'plan',requested:'execution',approved:'execution',case_linked:'execution',link:'execution','shipment-requested':'execution','shipment-created':'execution','shipment-linked':'execution',fulfill:'completed','received-and-inspected':'completed','replacement-delivered':'completed',payment:'completed','settlement:refund':'completed','settlement:collection':'completed',wait:'followup',resume:'followup',exception:'followup','exception-resolved':'followup',cancelled:'followup',unlink:'followup',negative_rating:'followup',close:'closed'};
    const latestReopen=events.findLastIndex(event=>event.action==='reopen');
    const milestones=new Map();
    events.forEach((event,index)=>{const group=groups[event.action];if(!group||index<latestReopen&&group!=='registered')return;if(group!=='registered'||!milestones.has(group))milestones.set(group,{event,index});});
    let summary=[...milestones.values()].sort((a,b)=>a.index-b.index);
    if(summary.length>6)summary=[summary[0],...summary.slice(-5)];
    const title=event=>{
      const label=(copy[event.action]||[tr('تحديث على المشكلة','Issue updated')])[0];
      const result=event.action==='close'?outcomes()[event.outcome]:event.action==='plan'?solutions()[event.solution]:'';
      return esc(label)+(result?' · '+esc(result):'');
    };
    const date=event=>event.at?listDate(event.at,true,true):'';
    const contactChannels={phone:tr('هاتف','Phone'),whatsapp:'WhatsApp',email:tr('بريد إلكتروني','Email'),other:tr('أخرى','Other')},contactResults={reached:tr('تم التواصل','Reached'),no_answer:tr('لم يرد','No answer'),confirmed:tr('أكد انتهاء المشكلة','Resolution confirmed'),disputed:tr('المشكلة ما زالت قائمة','Issue remains')};
    const eventDetails=event=>`${event.action==='contact'?`<p class="cf-activity-contact">${esc(contactChannels[event.channel]||event.channel||tr('تواصل','Contact'))}${event.contactResult?' · '+esc(contactResults[event.contactResult]||event.contactResult):''}</p>`:''}${event.dueAt?`<div class="cf-activity-due"><span>${tr('المتابعة · القاهرة','Follow-up · Cairo')}</span>${listDate(event.dueAt,true,true)}</div>`:''}`;
    const recent=events.filter(event=>['comment','contact','plan','assign','wait','resume','reopen'].includes(event.action)&&(event.note||event.dueAt||event.action==='contact')).slice(-3).reverse();
    const recentNotes=recent.length?`<section class="cf-activity-notes" aria-label="${tr('ملاحظات المتابعة','Follow-up notes')}"><h4>${tr('آخر الملاحظات','Recent notes')}</h4>${recent.map(event=>`<article class="cf-activity-note" data-cf-activity="${esc(event.action)}"><div class="cf-activity-title"><strong>${title(event)}</strong>${event.by?`<small>${esc(event.by)}</small>`:''}</div>${eventDetails(event)}${event.note?event.note.length>220?`<details class="cf-activity-note-more"><summary>${esc(event.note.slice(0,110))}…</summary><p dir="auto">${esc(event.note)}</p></details>`:`<p class="cf-activity-text" dir="auto">${esc(event.note)}</p>`:''}<div class="cf-timeline-meta">${date(event)}</div></article>`).join('')}</section>`:'';
    const html=`<section class="cf-card cf-log">${recentNotes}<ol class="cf-timeline">${summary.map(({event},index)=>`<li class="cf-timeline-step ${index===summary.length-1?'is-latest':''}"><span class="cf-timeline-marker" aria-hidden="true"></span><div class="cf-timeline-content"><div class="cf-timeline-heading"><strong>${title(event)}</strong></div><div class="cf-timeline-meta">${date(event)}</div></div></li>`).join('')}</ol>
      <details class="cf-disclosure cf-timeline-archive" data-cf-audit><summary>${tr('السجل الكامل','Full history')} <span>(${events.length})</span></summary><div class="cf-disclosure-body"><ol class="cf-audit-list" data-cf-audit-list></ol><nav class="cf-audit-pages" aria-label="${tr('صفحات السجل','History pages')}"><span data-cf-audit-page role="status"></span><div><button type="button" class="btn btn-outline" data-cf-audit-prev>${tr('السابق','Previous')}</button><button type="button" class="btn btn-outline" data-cf-audit-next>${tr('التالي','Next')}</button></div></nav></div></details></section>`;
    return {html,bind(){
      const archive=el('[data-cf-audit]'),list=archive.querySelector('[data-cf-audit-list]'),all=[...events].reverse();let offset=0,loaded=false;
      const previous=archive.querySelector('[data-cf-audit-prev]'),next=archive.querySelector('[data-cf-audit-next]');
      function draw(){
        loaded=true;
        list.innerHTML=all.slice(offset,offset+10).map(event=>{
          const note=event.note&&!(event.action==='registered'&&createdText.test(event.note))?event.note:'';
          return `<li><strong>${title(event)}</strong><div class="cf-timeline-meta">${date(event)}${event.by?`<span>${esc(event.by)}</span>`:''}${event.caseRef?`<bdi>${esc(event.caseRef)}</bdi>`:''}${event.cycle>1?`<span>${tr('الدورة','Cycle')} ${esc(event.cycle)}</span>`:''}</div>${eventDetails(event)}${note?`<details class="cf-timeline-details"><summary>${tr('التفاصيل','Details')}</summary><p>${esc(note)}</p></details>`:''}</li>`;
        }).join('');
        archive.querySelector('[data-cf-audit-page]').textContent=`${offset+1}–${Math.min(offset+10,all.length)} ${tr('من','of')} ${all.length}`;
        previous.disabled=offset===0;next.disabled=offset+10>=all.length;
      }
      archive.querySelector('summary').addEventListener('click',()=>{if(!loaded)draw();});
      archive.addEventListener('toggle',()=>{if(archive.open&&!loaded)draw();});
      previous.onclick=()=>{offset=Math.max(0,offset-10);draw();};next.onclick=()=>{if(offset+10<all.length){offset+=10;draw();}};
    }};
  }
  function badge(c){const stage=c.lifecycleStage||c.workflow?.stage||'review',label=stage==='planned'?tr('بانتظار التنفيذ','Awaiting execution'):stage==='closed'?outcomes()[c.workflow?.outcome]||stages().closed:stages()[stage]||stage;return `<button type="button" class="cf-badge ${stage==='closed'?'is-closed':''}" data-stage="${esc(stage)}" onclick="event.stopPropagation();ComplaintFlow.openFromList(this.dataset.id)" data-id="${esc(c._id)}"><span class="cf-stage-dot" aria-hidden="true"></span>${esc(label)}</button>`;}
  const menu=c=>`<button type="button" class="btn btn-outline btn-sm cf-open-case" data-id="${esc(c._id)}" aria-label="${esc(tr('فتح ملف الشكوى ','Open complaint ')+c.complaintNo)}" onclick="event.stopPropagation();ComplaintFlow.openFromList(this.dataset.id)">${tr('فتح','Open')}<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></svg></button>`;
  function chooseTicket(invoiceId){
    const tx=(transactions||[]).find(t=>t._id===invoiceId);if(!tx)return;
    show(tr('خدمة العميل','Customer care'),'#'+tx.ref+' · '+tx.client,`<section class="cf-card"><h3>${tr('ما الإجراء المطلوب؟','What would you like to do?')}</h3><p>${tr('سجّل مشكلة العميل وتابع حلها، أو افتح متابعة أو طلب استرجاع مباشر.','Track a customer issue through resolution, or create a follow-up or a direct return request.')}</p><div class="cf-actions"><button class="btn btn-primary" data-cf-new>${tr('شكوى جديدة','New complaint')}</button><button class="btn btn-outline" data-cf-followup>${tr('متابعة عميل','Customer follow-up')}</button><button class="btn btn-outline" data-cf-return>${tr('طلب استرجاع / استبدال','Return / exchange request')}</button></div></section>`);
    el('[data-cf-new]').onclick=()=>create(invoiceId);
    el('[data-cf-followup]').onclick=()=>{closeLayer(dialog);openAddTicketModal(invoiceId,true);document.getElementById('tkt-type').value='followup';_tktTypeChanged();};
    el('[data-cf-return]').onclick=()=>{closeLayer(dialog);AfterSales.create(invoiceId);};
    el('[data-cf-return]').hidden=!canExecute();
  }
  function next(row){
    const w=row.workflow||{},e=row.execution||{};
    if(w.stage==='closed')return ['reopen',tr('إعادة فتح بسبب جديد','Reopen with a reason')];
    if(w.stage==='waiting')return ['resume',tr('استئناف المتابعة','Resume follow-up')];
    if(e.ready)return admin()?['close',tr('تأكيد الحل وإغلاق الشكوى','Confirm resolution & close complaint')]:['contact',tr('تسجيل تأكيد العميل','Record customer confirmation')];
    if(w.caseId)return ['case',tr('متابعة طلب التنفيذ','Open execution case')];
    if(['exchange','return'].includes(w.solution))return canExecute()?['create-case',w.solution==='exchange'?tr('إنشاء طلب استبدال','Create exchange request'):tr('إنشاء طلب استرجاع','Create return request')]:['contact',tr('متابعة اعتماد التنفيذ مع المسؤول','Follow up execution with the manager')];
    if(['compensation','refund_without_return'].includes(w.solution))return admin()?['payment',tr('تسجيل دفع مستحق العميل','Record customer payment')]:['contact',tr('متابعة الدفع مع المسؤول','Follow up payment with the manager')];
    if(w.solution)return ['fulfill',tr('توثيق الحل المنفذ','Document resolution')];
    return [admin()?'plan':'contact',actionLabels()[admin()?'plan':'contact']];
  }
  function open(id,messageEvent='',savedRow=null){
    if(typeof _requirePageAccess==='function'&&!_requirePageAccess('complaint-detail'))return Promise.resolve();
    checkOwner();window._complaintViewId=String(id);
    if(currentPage!=='complaint-detail'||location.hash!== '#complaints/view/'+encodeURIComponent(id)){
      routeIntent={id,messageEvent,savedRow};routeTask=null;navigateTo('complaint-detail');return routeTask||Promise.resolve();
    }
    return openDetail(id,messageEvent,savedRow);
  }
  function openRow(event,id){
    if(event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
    if(event.target.closest('a,button,input,select,textarea,label,summary,[role="button"],[contenteditable="true"]'))return;
    if(window.getSelection()?.toString().trim())return;
    return openFromList(id);
  }
  function openFromList(id){
    if(busy)return Promise.resolve();
    if(listOpening)return listOpening.task;
    if(currentPage==='complaint-detail'&&String(window._complaintViewId)===String(id))return Promise.resolve();
    const source=document.getElementById('page-complaints');
    if(reduced()||currentPage!=='complaints'||!source?.classList.contains('active'))return window.ComplaintFlow.open(id);
    const intent={owner:me(),hash:location.hash};listOpening=intent;
    const exit=source.animate([{opacity:1},{opacity:.35}],{duration:90,easing:'ease-out',fill:'forwards'});
    intent.task=(async()=>{
      try{
        await exit.finished;
        if(me()!==intent.owner||currentPage!=='complaints'||location.hash!==intent.hash)return;
        // Start the route synchronously; the transition never waits for its network refresh.
        const read=window.ComplaintFlow.open(id);
        exit.cancel();
        const target=document.getElementById('page-complaint-detail');
        if(!reduced()&&currentPage==='complaint-detail'&&target){
          const arrival=target.animate([{opacity:.35},{opacity:1}],{duration:170,easing:'cubic-bezier(.2,.8,.2,1)'});
          await arrival.finished.catch(()=>{});
        }
        if(listOpening===intent)listOpening=null;
        return read;
      }finally{exit.cancel();if(listOpening===intent)listOpening=null;}
    })();
    return intent.task;
  }
  function enter(){
    const intent=routeIntent;routeIntent=null;
    const id=window._complaintViewId;
    if(!id){navigateTo('complaints');return Promise.resolve();}
    if(!window.SouliaNavigation?.shouldRoutePop())window.scrollTo({top:0,behavior:'instant'});
    routeTask=openDetail(id,intent?.id===id?intent.messageEvent:'',intent?.id===id?intent.savedRow:null);
    return routeTask;
  }
  async function openDetail(id,messageEvent='',savedRow=null){
    checkOwner();
    const cached=savedRow||details.get(String(id))?.row||(complaints||[]).find(c=>String(c._id)===String(id));
    if(cached){active=cached;render(cached);}
    else showPage(tr('جارٍ تحميل الملف…','Loading complaint…'),tr('ملف الشكوى','Complaint workspace'),`<p role="status">${tr('جارٍ تحميل الملف…','Loading complaint…')}</p>`);
    const version=serial;
    if(savedRow?.execution){void loadCustomerMessage(savedRow,messageEvent);return;}
    const body=el('.cf-body');body.setAttribute('aria-busy','true');
    const status=document.createElement('div');status.className='cf-refresh-status';status.setAttribute('role','status');status.textContent=tr('جارٍ تحديث بيانات الملف…','Updating case details…');el('.cf-head>div').appendChild(status);
    try{
      const row=await readDetail(id,true,messageEvent);if(version!==serial||!visible())return;
      const scrollTop=window.scrollY;active=row;
      const {customerMessage:cachedMessage,...cachedFields}=cached||{}, {customerMessage:updatedMessage,...updatedFields}=row;
      if(!cached||JSON.stringify(cachedFields)!==JSON.stringify(updatedFields)){render(row);window.scrollTo({top:scrollTop,behavior:'instant'});}
      void loadCustomerMessage(row,messageEvent);
    }catch(e){if(version===serial&&visible()){error(e);const box=el('[data-cf-error]');const retry=document.createElement('button');retry.type='button';retry.className='btn btn-outline';retry.textContent=tr('إعادة المحاولة','Retry');retry.onclick=()=>open(id,messageEvent);box.appendChild(retry);}}
    finally{if(body.isConnected)body.removeAttribute('aria-busy');status.remove();}
  }
  const messageKinds=()=>({registered:tr('تأكيد تسجيل الشكوى','Complaint registered'),update:tr('تحديث متابعة المشكلة','Progress update'),confirmation:tr('طلب تأكيد انتهاء المشكلة','Request resolution confirmation'),resolved:tr('تأكيد حل المشكلة','Resolution completed'),closed:tr('إبلاغ بنتيجة الإغلاق','Closure outcome')});
  async function loadCustomerMessage(row,event=''){
    const card=el('[data-cf-message-card]');if(!card)return;
    const area=card.querySelector('textarea'),copy=card.querySelector('[data-cf-message]');
    copy.dataset.wasDisabled='true';
    copy.onclick=async()=>{try{await navigator.clipboard.writeText(area.value);toast(tr('تم النسخ؛ الرسالة جاهزة لإرسالها للعميل','Copied; ready to send to the customer'));}catch{area.focus();area.select();toast(tr('تعذر النسخ التلقائي؛ النص محدد لتنسخه يدويًا','Clipboard unavailable; select and copy the highlighted text'),true);}};
    card.querySelector('[data-cf-templates]')?.addEventListener('click',()=>editMessageTemplates(row._id,event));
    try{
      const result=row.customerMessage?.language===tr('ar','en')?row.customerMessage:await api(`/complaints/${row._id}/customer-message?lang=${tr('ar','en')}&event=${encodeURIComponent(event)}`,{background:true});
      if(!card.isConnected)return;
      area.value=result.text;card.querySelector('[data-cf-message-title]').textContent=messageKinds()[result.kind];copy.disabled=false;copy.dataset.wasDisabled='false';
    }catch(e){if(card.isConnected){area.value=tr('تعذر تحميل الرسالة. أعد فتح الملف للمحاولة مجددًا.','Could not load the message. Reopen the case to retry.');error(e);}}
  }
  async function editMessageTemplates(id,event=''){
    if(!admin())return;
    const version=show(tr('قوالب رسائل العميل','Customer message templates'),'',tr('جارٍ التحميل…','Loading…'));
    try{
      const config=await api('/complaints/message-templates');if(version!==serial||!dialog.open)return;
      const drafts=structuredClone(config.templates);
      show(tr('قوالب رسائل العميل','Customer message templates'),tr('تعديل الأدمن يطبق على الرسائل الجديدة لجميع الموظفين','Admin changes apply to newly generated messages for all staff'),`<form data-cf-template-form><div class="cf-notice">${tr('المتغيرات المتاحة تُملأ تلقائيًا ببيانات العميل والشكوى. لا تضف ملاحظات داخلية إلى هذه الرسائل.','Available placeholders are filled from customer and complaint details. Keep internal notes out of these messages.')}<br><bdi>${config.tokens.map(t=>esc('{'+t+'}')).join(' · ')}</bdi></div><div class="cf-two">${select('kind',tr('نوع الرسالة','Message type'),messageKinds(),'registered')}${select('language',tr('لغة الرسالة','Message language'),{ar:'العربية',en:'English'},tr('ar','en'))}</div><label class="cf-field">${tr('نص القالب','Template text')}<textarea name="template" rows="8" required maxlength="3000"></textarea></label><label class="cf-field">${tr('معاينة ببيانات تجريبية','Preview with example data')}<textarea data-cf-template-preview rows="6" readonly></textarea></label><div class="cf-foot"><button class="btn btn-outline" type="button" data-cf-back>${tr('رجوع دون حفظ','Back without saving')}</button><button class="btn btn-primary" type="submit">${tr('حفظ القوالب للجميع','Save templates for everyone')}</button></div></form>`);
      const f=el('form');let kind=f.elements.kind.value,lang=f.elements.language.value;
      const preview=()=>{const values={customerName:lang==='ar'?'نور':'Nour',complaintNo:'CMP-0001',invoiceRef:'#2790',resolution:lang==='ar'?'استبدال':'Exchange',customerMessage:lang==='ar'?'تم تسليم البديل.':'Replacement delivered.'};el('[data-cf-template-preview]').value=f.elements.template.value.replace(/\{([a-zA-Z]+)\}/g,(token,key)=>values[key]??token);};
      function draw(){f.elements.template.value=drafts[kind][lang];f.elements.template.dir=lang==='ar'?'rtl':'ltr';el('[data-cf-template-preview]').dir=f.elements.template.dir;preview();}
      f.elements.template.oninput=()=>{drafts[kind][lang]=f.elements.template.value;preview();};
      f.elements.kind.onchange=f.elements.language.onchange=()=>{kind=f.elements.kind.value;lang=f.elements.language.value;draw();};draw();
      el('[data-cf-back]').onclick=()=>open(id,event);
      f.onsubmit=async e=>{e.preventDefault();if(busy)return;buttonsDisabled(true);try{await api('/complaints/message-templates',{method:'PUT',body:JSON.stringify({templates:drafts,revision:config.revision})});await open(id,event);toast(tr('تم حفظ قوالب الرسائل','Message templates saved'));}catch(e){error(e);}finally{buttonsDisabled(false);}};
    }catch(e){error(e);}
  }
  function arrangePage(row){
    const head=el('.cf-case-head'),body=el('.cf-body'),summary=el('.cf-case-summary');
    const status=summary.querySelector('dl>div:last-child dd');
    const badge=document.createElement('span');badge.className='cf-case-status'+(row.overdue?' is-overdue':'');badge.textContent=status.textContent;
    el('.cf-case-identity').appendChild(badge);
    const progress=document.createElement('section');progress.className='cf-case-progress';progress.setAttribute('aria-label',tr('مراحل المعالجة والمتابعة','Resolution progress and follow-up'));
    progress.appendChild(el('.cf-steps'));
    const metadata=document.createElement('dl');metadata.className='cf-case-context';
    const customer=el('.cf-case-heading>p'),contact=document.createElement('div');contact.className='cf-case-client';
    const name=document.createElement('strong');name.dir='auto';name.textContent=customer.textContent;contact.appendChild(name);
    [...summary.querySelectorAll('dl>div')].slice(0,2).forEach((item,index)=>{
      const field=document.createElement('span');field.className='cf-case-contact';
      const label=item.querySelector('dt').textContent,dd=item.querySelector('dd');
      field.title=label;field.innerHTML=`<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${index===0?actionIcons.invoice:'<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.4 2.1L8.1 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.6 1.9z"/>'}</svg>`;
      field.append(...dd.childNodes);field.querySelector('button')?.setAttribute('aria-label',label+' '+field.textContent);contact.appendChild(field);
    });
    customer.replaceWith(contact);
    const context=el('.cf-context');
    const fields=[...context.querySelector('dl').children];
    const entries=[];
    for(let index=0;index<fields.length;index+=2){const item=document.createElement('div');item.append(fields[index],fields[index+1]);entries.push(item);}
    entries[2].className='cf-case-solution';entries[2].querySelector('dd').innerHTML=solutionCell(row);
    entries[0].className='cf-case-owner';entries[0].querySelector('dd').innerHTML=ownerAvatar(row)+`<span dir="auto">${esc(owner(row)||tr('غير معيّن','Unassigned'))}</span>`;
    metadata.append(entries[2],entries[1],entries[3],entries[0]);
    progress.appendChild(metadata);head.after(progress);context.remove();summary.remove();
    const layout=document.createElement('div');layout.className='cf-case-layout';
    const main=document.createElement('div');main.className='cf-case-main';
    const aside=document.createElement('aside');aside.className='cf-case-aside';aside.setAttribute('aria-label',tr('الإجراءات وسجل الشكوى','Actions and case history'));
    main.append(el('.cf-problem'));
    const activity=el('.cf-activity-notes');if(activity){activity.classList.add('cf-card');main.append(activity);}
    main.append(el('.cf-overview-evidence'),el('.cf-message-details'));
    const next=el('.cf-next'),primary=next.querySelector('[data-cf-action]');
    if(primary)el('.cf-case-head-actions').prepend(primary);
    aside.append(next,el('.cf-action-panel'));
    const execution=el('.cf-followup-details');
    if(execution.querySelector('.cf-disclosure-body').children.length){execution.querySelector('summary').textContent=tr('تفاصيل التنفيذ','Execution details');aside.append(execution);}else execution.remove();
    const history=el('.cf-history-details');history.open=true;history.querySelector('.cf-log>h3')?.remove();aside.append(history);
    layout.append(main,aside);
    body.querySelectorAll('.cf-overview,.cf-secondary,.cf-resolution-actions').forEach(container=>container.remove());
    body.appendChild(layout);
  }
  function render(row){
    const w=row.workflow||{},e=row.execution||{},stage=row.lifecycleStage||w.stage||'review',n=next(row),closed=w.stage==='closed';
    const historyView=timeline(row);
    const stageOrder=['review','planned','execution','confirmation','closed'],position=stageOrder.indexOf(stage==='blocked'?'execution':stage==='waiting'?'review':stage);
    const items=row.items?.length?row.items:row.productName||row.productCode||row.productId?[{productId:row.productId,code:row.productCode,name:row.productName,imageUrl:row.productImageUrl,qty:row.productQty,variantDetail:row.variantDetail}]:[];
    const categoryLabel=value=>typeof _cmpCategoryLabel==='function'?_cmpCategoryLabel(value):value;
    const legacyImage=typeof row.imageUrl==='string'&&/^https?:\/\//i.test(row.imageUrl)?row.imageUrl:'';
    const photos=[...(row.attachments||[]).map(a=>({...a,name:a.name||tr('صورة المشكلة','Issue photo')})),...(legacyImage?[{url:legacyImage,name:tr('صورة المشكلة المرفقة','Attached issue photo')}]:[])];
    showPage(row.clientName||tr('ملف خدمة العملاء','Customer care'),row.complaintNo,`
      <section class="cf-case-summary" aria-label="${tr('بيانات الملف','Case details')}">
        <dl><div><dt>${tr('الفاتورة','Invoice')}</dt><dd>${row.transactionId?`<button type="button" class="cf-link" data-cf-invoice="${esc(row.transactionId)}"><bdi>#${esc(row.transactionRef||'—')}</bdi></button>`:esc(row.transactionRef?'#'+row.transactionRef:tr('بدون فاتورة','No invoice'))}</dd></div>
        <div><dt>${tr('رقم التواصل','Phone')}</dt><dd><bdi>${esc(row.phone||'—')}</bdi></dd></div>
        <div><dt>${tr('حالة المشكلة','Issue status')}</dt><dd class="${row.overdue&&!closed?'cf-due-overdue':''}">${esc(closed?outcomes()[w.outcome]||stages().closed:stages()[stage]||stage)}${row.overdue&&!closed?' · '+tr('متأخرة','Overdue'):''}</dd></div></dl>
      </section>
      ${w.legacy?`<div class="cf-notice">${tr('سجل سابق: راجع القرار والقطع واربط أي تنفيذ موجود قبل بدء إجراء جديد.','Legacy record: review the decision and items; link existing execution before creating a new case.')}</div>`:''}
      ${w.reviewRequired?`<div class="cf-notice">${tr('يوجد اعتراض أو تقييم منخفض يحتاج مراجعة المسؤول.','A dispute or low rating needs owner review.')}</div>`:''}
      ${w.deletingAt?`<div class="cf-notice">${admin()?tr('بدأ الحذف النهائي لهذه المشكلة. استخدم زر «حذف نهائي» لاستكماله.','Permanent deletion has started. Use Delete permanently to complete it.'):tr('هذه المشكلة قيد الحذف النهائي بواسطة المدير.','This issue is being permanently deleted by an administrator.')}</div>`:''}
      <div class="cf-grid cf-overview">
        <section class="cf-card cf-problem"><h3>${items.some(i=>i.issueType)?tr('مشكلات المنتجات','Product issues'):tr('المشكلة','The issue')}</h3>
          <dl class="cf-issue-facts"><div><dt>${tr('نوع المشكلة','Issue category')}</dt><dd class="cf-category-label">${categoryIcon(row.categoryGroup)}${esc(categoryLabel(row.categoryGroup)||tr('غير محدد','Unspecified'))}</dd></div>${items.some(i=>i.issueType)?'':`<div><dt>${tr('سبب المشكلة','Issue reason')}</dt><dd>${esc(categoryLabel(row.category)||tr('لم يُسجل سبب محدد','No specific reason recorded'))}</dd></div>`}</dl>
          ${items.some(i=>i.issueType)?row.additionalDescription?`<p class="cf-issue-description cf-additional-description">${esc(row.additionalDescription)}</p>`:'':`<p class="cf-issue-description">${esc(row.description||tr('لم يُسجل وصف للمشكلة','No issue description recorded'))}</p>`}
          <h4>${tr('المنتجات المتضررة','Affected products')}</h4>
          ${items.length?`<div class="cf-affected-list">${items.map((i,index)=>`<div class="cf-item cf-affected-item cf-affected-with-issue" data-cf-product-line="${esc(i.lineIndex??index)}">${productImage(i)}<span class="cf-product-info"><strong>${esc(i.name||i.code||tr('منتج','Product'))}</strong>${i.code?`<small>${tr('الكود','Code')} <bdi>${esc(i.code)}</bdi></small>`:''}${i.variantDetail?`<small>${esc(i.variantDetail)}</small>`:''}</span><span class="cf-affected-qty"><small>${tr('الكمية','Qty')}</small><bdi>${esc(i.qty??'—')}</bdi></span><dl class="cf-product-issue" aria-label="${esc(tr('مشكلة المنتج: ','Issue for product: ')+(i.name||i.code||tr('منتج','Product')))}"><div class="cf-product-issue-reason"><dt>${tr('المشكلة','Issue')}</dt><dd data-cf-item-reason-label class="${i.issueType?'':'cf-muted'}">${esc(productIssueTypes()[i.issueType]||i.issueType||tr('غير مسجلة','Not recorded'))}</dd></div><div class="cf-product-issue-description"><dt>${tr('الوصف','Description')}</dt><dd data-cf-item-description-text dir="auto" class="${i.issueDescription?'':'cf-muted'}">${esc(i.issueDescription||tr('لم يُسجل وصف خاص بهذا المنتج','No description recorded for this product'))}</dd></div></dl></div>`).join('')}</div>`:`<p class="cf-muted">${tr('لم تُحدد منتجات متضررة','No affected products selected')}</p>`}
        </section>
        <section class="cf-card cf-evidence cf-overview-evidence"><div class="cf-evidence-heading"><h3>${tr('صور المشكلة','Issue photos')}</h3>${photos.length?`<span>${tr(`${photos.length} صور`,`${photos.length} photos`)}</span>`:''}</div>
          ${photos.length?`<p class="cf-evidence-hint">${tr('اضغط على أي صورة لمعاينتها بحجم أكبر','Select a photo for a closer look')}</p>`:''}
          <div class="cf-images">${photos.map((a,index)=>`<div class="cf-evidence-item"><button type="button" class="cf-link" ${a.id?`data-cf-image="${esc(a.id)}"`:''} data-cf-preview="${index}" title="${esc(a.name)}" aria-label="${esc(tr('معاينة صورة المشكلة: ','Preview issue photo: ')+a.name)}"><img ${a.url?`src="${esc(a.url)}"`:''} alt="${esc(a.name)}" loading="lazy"><span class="cf-image-preview"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>${tr('معاينة','Preview')}</span><span class="cf-image-error" hidden>${tr('تعذر التحميل · اضغط للمحاولة','Unavailable · select to retry')}</span></button><div class="cf-evidence-caption"><span>${tr(`صورة ${index+1}`,`Photo ${index+1}`)}</span>${a.id?`<button type="button" class="cf-evidence-remove" data-cf-remove-image="${esc(a.id)}" aria-label="${esc(tr('حذف الصورة: ','Delete image: ')+a.name)}">${tr('حذف','Delete')}</button>`:''}</div></div>`).join('')}</div>
          ${!row.attachments?.length&&!legacyImage?`<p class="cf-evidence-empty">${tr('لا توجد صور مرفقة للمشكلة.','No issue photos attached.')}</p>`:''}
          ${uploadControls((row.attachments||[]).length)}
        </section>
      </div>
      <div class="cf-secondary">
        <details class="cf-disclosure cf-followup-details"><summary>${tr('تفاصيل المتابعة والتنفيذ','Follow-up and execution details')}</summary><div class="cf-disclosure-body">
      <ol class="cf-steps">${stageOrder.map((s,i)=>`<li class="${i<=position?'is-done':''} ${i===position?'is-current':''}" ${i===position?'aria-current="step"':''}>${esc(({review:tr('المراجعة','Review'),planned:tr('الخطة','Plan'),execution:tr('التنفيذ','Execute'),confirmation:tr('التأكيد','Confirm'),closed:tr('الإغلاق','Close')})[s])}</li>`).join('')}</ol>
      <section class="cf-card cf-context"><h3>${tr('المتابعة','Follow-up')}</h3><dl><dt>${tr('المسؤول','Owner')}</dt><dd>${esc(w.owner||row.submittedBy||'—')}</dd><dt>${tr('الموعد','Due')}</dt><dd>${esc(time(w.dueAt))}${row.overdue?' · '+tr('متأخرة','Overdue'):''}</dd><dt>${tr('الحل','Solution')}</dt><dd>${esc(solutions()[w.solution]||'—')}</dd><dt>${tr('دورة المعالجة','Resolution cycle')}</dt><dd>${w.cycle||1}</dd></dl></section>
      ${w.caseId?`<section class="cf-card cf-linked"><h3>${tr('التنفيذ المرتبط','Linked execution')}</h3><button class="cf-link" data-cf-action="case"><bdi>${esc(w.caseRef||e.caseRef)}</bdi></button><p>${esc(e.trackingNumber||'')} ${esc(e.carrierStatus||'')}</p>${e.financialPending&&e.ready?`<small>${tr('اكتمل حل العميل؛ تسوية الناقل الداخلية ما زالت مفتوحة.','Customer resolution is complete; internal carrier settlement remains open.')}</small>`:''}</section>`:''}
      ${w.payment?`<section class="cf-card"><h3>${tr('إثبات الدفع','Payment evidence')}</h3><dl><dt>${tr('المبلغ','Amount')}</dt><dd><bdi>${Number(w.payment.amount).toFixed(2)}</bdi></dd><dt>${tr('الحساب','Account')}</dt><dd>${esc(w.payment.method)}</dd><dt>${tr('المرجع','Reference')}</dt><dd>${esc(w.payment.reference)}</dd><dt>${tr('تم بواسطة','Recorded by')}</dt><dd>${esc(w.payment.by)} · ${esc(time(w.payment.at))}</dd></dl></section>`:''}
      ${w.cycles?.length?`<section class="cf-card"><h3>${tr('المعالجات السابقة','Previous resolution cycles')}</h3>${w.cycles.map(c=>`<p><strong>${tr('الدورة','Cycle')} ${c.cycle} · ${esc(outcomes()[c.outcome]||'')}</strong><br>${esc(solutions()[c.solution]||'')} · ${esc(time(c.closedAt))}<br>${esc(c.closureNote||'')}${c.caseId?`<br><button type="button" class="cf-link" data-cf-previous="${esc(c.caseId)}">${tr('طلب التنفيذ السابق','Previous execution case')}</button>`:''}${c.payment?`<br>${tr('دفعة سابقة','Previous payment')}: <bdi>${Number(c.payment.amount).toFixed(2)}</bdi> · ${esc(c.payment.reference)}`:''}</p>`).join('')}</section>`:''}
      ${row.surveySlug&&closed?`<section class="cf-card"><h3>${tr('تقييم العميل','Customer feedback')}</h3>${row.surveyRating?`<p>${row.surveyRating} / 5</p><p>${esc(row.surveyComment)}</p>`:`<button class="btn btn-outline" data-cf-copy>${tr('نسخ رابط التقييم','Copy feedback link')}</button>`}</section>`:''}
        </div></details>
        <details class="cf-disclosure cf-message-details"><summary>${tr('رسالة جاهزة للعميل','Message ready for the customer')}</summary><div class="cf-disclosure-body">
      <section class="cf-card cf-customer-message" data-cf-message-card><h3 data-cf-message-title>${tr('رسالة جاهزة للعميل','Message ready for the customer')}</h3><label class="cf-field">${tr('راجع النص ثم انسخه وأرسله للعميل','Review, copy and send to the customer')}<textarea rows="5" readonly data-cf-message-text>${tr('جارٍ تجهيز الرسالة…','Preparing message…')}</textarea></label><div class="cf-actions"><button type="button" class="btn btn-primary" data-cf-message disabled>${tr('نسخ الرسالة للعميل','Copy message for customer')}</button>${admin()?`<button type="button" class="btn btn-outline" data-cf-templates>${tr('تعديل قوالب الرسائل','Edit message templates')}</button>`:''}</div><small class="cf-muted">${tr('النسخ لا يرسل الرسالة تلقائيًا.','Copying does not send the message automatically.')}</small></section>
        </div></details>
        <details class="cf-disclosure cf-history-details"><summary>${tr('سجل المشكلة','Issue timeline')}</summary><div class="cf-disclosure-body">${historyView.html}</div></details>
      </div>
      <div class="cf-resolution-actions">
<section class="cf-card cf-next"><h3>${esc(closed?outcomes()[w.outcome]||stages().closed:stages()[stage])}</h3><p>${esc(closed?w.closureNote:stage==='waiting'?w.waitReason:e.ready?tr('اكتملت أدلة التنفيذ. تواصل مع العميل لتأكيد انتهاء المشكلة.','Execution evidence is complete. Confirm with the customer that the issue is resolved.'):!w.solution?tr('راجع المشكلة وحدد الحل المناسب مع العميل.','Review the issue and agree a resolution with the customer.'):(e.blockers||[]).map(b=>blockers()[b]||b).join(' · '))}</p>${!closed||admin()?button(n[0],n[1],true):''}</section>
      ${actionPanel(row)}</div>`);
    arrangePage(row);
    historyView.bind();
    surface.querySelectorAll('.cf-disclosure').forEach(animateDisclosure);
    surface.querySelectorAll('[data-cf-action]').forEach(b=>b.onclick=()=>act(row,b.dataset.cfAction));
    const guideActions=new Map([...surface.querySelectorAll('[data-cf-action]')].map(button=>[button.dataset.cfAction,button.getAttribute('aria-label')||button.textContent]));
    el('#cf-actions-guide').innerHTML=[...guideActions].map(([key,label])=>`<div><dt>${esc(label)}</dt><dd>${esc(actionHelp()[key]||'')}</dd></div>`).join('');
    const closeHelp=()=>{surface.querySelectorAll('[data-cf-help][aria-expanded=true]').forEach(button=>{button.setAttribute('aria-expanded','false');el('#'+button.dataset.cfHelp).hidden=true;});};
    surface.querySelectorAll('[data-cf-help]').forEach(button=>button.onclick=()=>{
      if(busy)return;const expanded=button.getAttribute('aria-expanded')==='true';closeHelp();
      if(!expanded){button.setAttribute('aria-expanded','true');el('#'+button.dataset.cfHelp).hidden=false;enterMotion(el('#'+button.dataset.cfHelp));}
    });
    surface.onkeydown=event=>{
      if(event.key!=='Escape')return;
      const expanded=el('[data-cf-help][aria-expanded=true]');
      if(expanded){event.preventDefault();event.stopPropagation();closeHelp();expanded.focus();}
    };
    surface.querySelectorAll('[data-cf-previous]').forEach(b=>b.onclick=()=>visitExecution(row,b.dataset.cfPrevious));
    el('[data-cf-invoice]')?.addEventListener('click',()=>{
      if(!_requirePageAccess('invoice-view'))return;
      if((transactions||[]).some(tx=>tx._id===row.transactionId))return openOrderView(row.transactionId);
      // Shared complaint links need no invoice index; the invoice page loads this one record.
      window._invoiceViewTxId=row.transactionId;window._invoiceViewRef=row.transactionRef||null;
      const slug=_orderViewSlugFor({_id:row.transactionId,ref:row.transactionRef});
      history.pushState(null,'','#'+_pageSlug('movements')+'/orders/view/'+encodeURIComponent(slug));
      _doNavigateTo('invoice-view',false);
    });
    el('[data-cf-copy]')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.origin+'/s/'+row.surveySlug);toast(tr('تم نسخ الرابط','Link copied'));}catch(e){error(e);}});
    async function loadImage(button){
      try{
        const result=await evidenceImage(row,{id:button.dataset.cfImage});if(!button.isConnected)return;
        const image=button.querySelector('img');image.onerror=()=>{image.hidden=true;button.querySelector('.cf-image-error').hidden=false;};image.src=result.data;
      }catch{if(button.isConnected){button.querySelector('img').hidden=true;button.querySelector('.cf-image-error').hidden=false;}}
    }
    surface.querySelectorAll('[data-cf-preview]').forEach(button=>{
      button.onclick=()=>previewImage(row,photos,Number(button.dataset.cfPreview),button);
      const image=button.querySelector('img');image.onerror=()=>{image.hidden=true;button.querySelector('.cf-image-error').hidden=false;};
    });
    imageObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){imageObserver.unobserve(entry.target);void loadImage(entry.target);}},{root:null,rootMargin:'200px'});
    surface.querySelectorAll('[data-cf-image]').forEach(button=>imageObserver.observe(button));
    el('[data-cf-choose-images]').onclick=()=>{if(!busy)el('[data-cf-upload]').click();};
    el('[data-cf-upload]').onchange=async event=>{
      const input=event.target,files=[...input.files];input.value='';if(busy||!files.length)return;
      let result;buttonsDisabled(true);
      try{
        validateImages(files,(row.attachments||[]).length);
        for(const [index,file] of files.entries()){
          el('[data-cf-upload-status]').textContent=tr(`جارٍ رفع الصورة ${index+1} من ${files.length}…`,`Uploading image ${index+1} of ${files.length}…`);
          const data=new FormData();data.append('file',file);
          result=await api(`/complaints/${row._id}/evidence`,{method:'POST',body:data});
        }
        await refresh(result);await open(row._id,'',result);
      }catch(e){
        if(result){await refresh(result);await open(row._id,'',result);}
        if(el('[data-cf-upload-status]'))el('[data-cf-upload-status]').textContent='';error(e);
      }finally{buttonsDisabled(false);}
    };
    surface.querySelectorAll('[data-cf-remove-image]').forEach(button=>button.onclick=async()=>{
      if(busy)return;buttonsDisabled(true);
      const attachmentId=button.dataset.cfRemoveImage;
      button.textContent=tr('جارٍ الحذف…','Deleting…');
      try{
        const result=await api(`/complaints/${row._id}/evidence/${attachmentId}`,{method:'DELETE'});
        images.delete(`${me()}:${row._id}:${attachmentId}`);details.delete(String(row._id));reads.clear();
        await refresh(result);await open(row._id,'',result);
      }catch(e){button.textContent=tr('حذف','Delete');error(e);}finally{buttonsDisabled(false);}
    });
  }
  async function act(row,action){
    if(action==='case')return visitExecution(row,row.workflow.caseId);
    if(action==='create-case')return visitExecution(row);
    return form(row._id,action);
  }
  function confirmRemove(row){
    if(!admin())return;
    show(tr('حذف المشكلة نهائيًا','Permanently delete issue'),row.complaintNo,`<form data-cf-delete-form><p>${tr('سيتم حذف هذه المشكلة وجميع صورها وسجلها نهائيًا. لا يمكن التراجع عن هذا الإجراء.','This issue, its images and history will be permanently deleted. This cannot be undone.')}</p><p class="cf-muted">${tr('تبقى طلبات الاستبدال والاسترجاع والمدفوعات المرتبطة محفوظة.','Linked exchange and return requests and payments will be retained.')}</p><div class="cf-foot"><button type="button" class="btn btn-outline" data-cf-cancel-delete>${tr('إلغاء','Cancel')}</button><button type="submit" class="btn cf-delete-button">${tr('حذف نهائي','Delete permanently')}</button></div></form>`);
    el('[data-cf-cancel-delete]').onclick=()=>open(row._id);
    el('[data-cf-delete-form]').onsubmit=async event=>{
      event.preventDefault();if(busy||!admin())return;buttonsDisabled(true);
      const submit=el('[data-cf-delete-form] button[type=submit]');submit.textContent=tr('جارٍ الحذف…','Deleting…');
      try{
        await api(`/complaints/${row._id}`,{method:'DELETE'});
        details.delete(String(row._id));reads.clear();positions.delete(String(row._id));
        for(const key of images.keys())if(key.startsWith(`${me()}:${row._id}:`))images.delete(key);
        try{for(const key of Object.keys(sessionStorage))if(key.startsWith(`complaint-operation:${me()}:${row._id}:`))sessionStorage.removeItem(key);}catch{}
        complaints=(complaints||[]).filter(c=>String(c._id)!==String(row._id));
        serial++;active=null;if(dialog?.open)void closeLayer(dialog);navigateTo('complaints');
        if(typeof renderComplaints==='function')renderComplaints();
        if(typeof renderCmpNegAlert==='function')renderCmpNegAlert();
        if(typeof buildNotifications==='function')buildNotifications();
        if(typeof buildSidebar==='function')buildSidebar();
        toast(tr('تم حذف المشكلة نهائيًا','Issue permanently deleted'));
      }catch(e){submit.textContent=tr('حذف نهائي','Delete permanently');error(e);}finally{buttonsDisabled(false);}
    };
    el('[data-cf-cancel-delete]').focus();
  }
  async function form(id,action){
    if(action==='delete'&&!admin())return;
    const version=show(tr('إجراء على الشكوى','Complaint action'),'',tr('جارٍ التحميل…','Loading…'));
    try{
      const row=await readDetail(id);if(version!==serial||!dialog.open)return;active=row;
      if(action==='delete')return confirmRemove(row);
      if(action==='items')return create(row.transactionId,{edit:row});
      let fields='',extraNotice='';
      const formTitle=action==='plan'&&row.workflow?.solution?tr('تغيير الحل','Change solution'):actionLabels()[action]||tr('إجراء على الشكوى','Complaint action');
      if(action==='plan')fields=select('solution',tr('الحل المقترح','Proposed solution'),solutions(),row.workflow?.solution||'support')+`<div data-cf-money>${field('amount',tr('المبلغ المعتمد','Approved amount'),'number',row.workflow?.amount||'','min="0.01" step="0.01"')}${confirm('confirmed',tr('أعتمد هذا المبلغ المستحق للعميل','I approve this customer payment'))}</div>`+deadline();
      if(action==='assign'){
        const staff=admin()?await api('/users'): [currentUser];if(version!==serial||!dialog.open)return;
        const options=Object.fromEntries(staff.filter(u=>u.active!==false&&u.isActive!==false&&(u.role==='admin'||(u.perms||[]).some(p=>['complaints','transaction'].includes(p)))).map(u=>[u._id||u.userId,u.name||u.username]));
        fields=select('ownerId',tr('المسؤول','Owner'),options,row.workflow?.ownerId||me())+deadline();
      }
      if(action==='wait')fields=select('waitingFor',tr('بانتظار','Waiting for'),{customer:tr('العميل','Customer'),warehouse:tr('المخزن','Warehouse'),carrier:tr('شركة الشحن','Carrier'),stock:tr('توفر البديل','Stock'),manager:tr('اعتماد المسؤول','Approval'),payment:tr('الدفع','Payment')})+deadline();
      if(action==='resume'||action==='reopen')fields=deadline();
      if(action==='link'){
        const cases=await api('/after-sales?invoiceId='+encodeURIComponent(row.transactionId));if(version!==serial||!dialog.open)return;
        const eligible=cases.filter(c=>c.originalTransactionId===row.transactionId&&c.requestKind===row.workflow.solution&&c.workflow.stage!=='cancelled');
        if(!eligible.length)extraNotice=tr('لا يوجد طلب مطابق. ارجع وأنشئ طلبًا مرتبطًا.','No matching case. Go back and create a linked case.');
        fields=select('caseId',tr('طلب التنفيذ','Execution case'),Object.fromEntries(eligible.map(c=>[c._id,`${c.workflow.ref} · ${c.workflow.stage}`])));
      }
      if(action==='fulfill')fields=field('reference',tr('مرجع إثبات الحل','Resolution evidence reference'),'text','','required')+confirm('confirmed',tr('تحققت من تنفيذ الحل فعليًا','I verified the resolution was carried out'));
      if(action==='payment')fields=`<div class="cf-notice">${tr('المبلغ المعتمد للدفع','Approved payment')}: <bdi>${Number(row.workflow.amount).toFixed(2)}</bdi></div>`+select('method',tr('الخزنة','Payment account'),{'كاش':tr('كاش','Cash'),'فودافون كاش':tr('فودافون كاش','Vodafone Cash'),Instapay:'Instapay','تحويل بنكي':tr('تحويل بنكي','Bank transfer')})+field('reference',tr('مرجع الدفع الفعلي','Actual payment reference'),'text','','required')+confirm('confirmed',tr('المبلغ دُفع فعليًا والمرجع صحيح','The payment was made and the reference is correct'));
      if(action==='contact')fields=select('channel',tr('وسيلة التواصل','Channel'),{phone:tr('هاتف','Phone'),whatsapp:'WhatsApp',email:tr('بريد إلكتروني','Email'),other:tr('أخرى','Other')})+select('contactResult',tr('نتيجة التواصل','Contact result'),{reached:tr('تم التواصل','Reached'),no_answer:tr('لم يرد','No answer'),confirmed:tr('أكد انتهاء المشكلة','Resolution confirmed'),disputed:tr('المشكلة ما زالت قائمة','Disputed')})+(row.workflow.stage!=='closed'?deadline():'');
      if(action==='close'){
        const available=row.execution?.ready?{resolved:outcomes().resolved,partial_agreement:outcomes().partial_agreement}:Object.fromEntries(Object.entries(outcomes()).filter(([k])=>!['resolved','partial_agreement'].includes(k)));
        fields=select('outcome',tr('نتيجة الإغلاق','Closure outcome'),available)+`<div data-cf-duplicate>${select('duplicateId',tr('الشكوى الأساسية','Primary complaint'),Object.fromEntries((complaints||[]).filter(c=>c._id!==id&&c.workflow?.outcome!=='duplicate'&&(row.transactionId?c.transactionId===row.transactionId:c.phone===row.phone)).map(c=>[c._id,c.complaintNo])))}</div>`+confirm('customerConfirmed',tr('أكد العميل انتهاء المشكلة أو وافق على الحل الجزئي','Customer confirmed resolution or agreed to the partial solution'))+field('customerMessage',tr('رسالة للعميل تظهر في التقييم','Customer-facing message'),'text','','maxlength="500"');
        extraNotice=row.execution?.ready?tr('سيحفظ الإغلاق الأدلة ويتيح التقييم. تسوية الناقل الداخلية تبقى مستقلة.','Closure keeps the evidence and enables feedback. Carrier settlement stays separate.'):tr('إغلاق ناجح غير متاح قبل اكتمال التنفيذ. الالتزامات المفتوحة تمنع الإغلاق.','Successful closure requires completed execution. Open obligations prevent closure.');
      }
      let pending;try{pending=JSON.parse(sessionStorage.getItem(`complaint-operation:${me()}:${row._id}:${action}`)||'null');}catch{}
      show(formTitle,row.complaintNo,`${pending?`<div class="cf-notice">${tr('هناك محاولة لم يتأكد حفظها. إعادة المحاولة تستخدم نفس البيانات لمنع التكرار.','An earlier attempt is unconfirmed. Retrying uses the same data to avoid duplication.')}</div>`:''}${extraNotice?`<div class="cf-notice">${esc(extraNotice)}</div>`:''}<form data-cf-form>${fields}${action==='close'?note(tr('سبب الإغلاق والتفاصيل','Closure reason and details'),true):action==='comment'?note(tr('نص الملاحظة','Note text'),true):note()}<div class="cf-foot"><button type="button" class="btn btn-outline" data-cf-back>${tr('رجوع','Back')}</button><button class="btn btn-primary" type="submit">${action==='close'?tr('إغلاق الشكوى','Close complaint'):action==='plan'?tr('حفظ ومتابعة التنفيذ','Save & continue'):tr('حفظ الإجراء','Save action')}</button></div></form>`);
      dialog.dataset.cfFormAction=action;
      const f=el('form');el('[data-cf-back]').onclick=()=>open(id);
      function syncDeadline(){if(!f.elements.dueAt||f.elements.dueAt.disabled)return;f.elements.dueAt.value=f.elements.dueDate.value&&f.elements.dueTime.value?`${f.elements.dueDate.value}T${f.elements.dueTime.value}`:'';}
      f.addEventListener('input',syncDeadline);f.addEventListener('change',syncDeadline);
      function dynamic(){
        if(el('[data-cf-money]'))el('[data-cf-money]').hidden=!['compensation','refund_without_return'].includes(f.elements.solution.value);
        if(el('[data-cf-duplicate]'))el('[data-cf-duplicate]').hidden=f.elements.outcome.value!=='duplicate';
        if(action==='close'){
          const success=['resolved','partial_agreement'].includes(f.elements.outcome.value);
          f.elements.customerConfirmed.closest('.cf-check').hidden=!success;
          if(!success)f.elements.customerConfirmed.checked=false;
        }
      }f.onchange=dynamic;dynamic();
      if(pending){for(const [name,value] of Object.entries(pending)){const input=f.elements.namedItem(name);if(!input)continue;if(input.type==='checkbox')input.checked=value===true;else input.value=name==='dueAt'?cairoInput(new Date(value)):value;input.disabled=true;}dynamic();}
      if(pending?.dueAt&&f.elements.dueDate){const [day,hour]=cairoInput(new Date(pending.dueAt)).split('T');f.elements.dueDate.value=day;f.elements.dueTime.value=hour;f.elements.dueDate.disabled=f.elements.dueTime.disabled=true;}
      f.onsubmit=async event=>{event.preventDefault();if(busy)return;syncDeadline();buttonsDisabled(true);const view=serial;let continuation;
        try{const values=Object.fromEntries(new FormData(f));delete values.dueDate;delete values.dueTime;for(const name of ['confirmed','customerConfirmed'])if(f.elements[name])values[name]=f.elements[name].checked;if(values.amount)values.amount=Number(values.amount);else delete values.amount;if(values.dueAt)values.dueAt=cairoDate(values.dueAt);const result=await mutate(row,action,values);await refresh(result);if(view===serial&&dialog.open){await open(id,'',result);if(action==='plan')continuation={row:result,version:serial,owner:me()};}}
        catch(e){if(view===serial)error(e);}finally{buttonsDisabled(false);}
        if(continuation&&serial===continuation.version&&me()===continuation.owner&&currentPage==='complaint-detail'&&active?._id===id){const [step]=next(continuation.row);if(step==='create-case'||step==='case')await visitExecution(continuation.row,continuation.row.workflow?.caseId);else await form(id,step);}
      };
    }catch(e){error(e);}
  }
  function draftKey(){return 'complaint-draft:'+me();}
  async function create(invoiceId='',options={}){
    if(draftOwner!==me()){createDraft=null;releaseDraftImages();draftOwner=me();}
    let saved;try{saved=JSON.parse(sessionStorage.getItem(draftKey())||'null');}catch{}
    const draft=options.edit?{operationKey:uid(),transactionId:invoiceId,items:options.edit.items||[],description:options.edit.description}:createDraft||saved||{operationKey:uid(),items:[],...options.seed};
    if(invoiceId&&!draft.createdId&&draft.transactionId!==invoiceId){draft.transactionId=invoiceId;draft.items=[];}
    createDraft=options.edit?null:draft;
    if(!options.edit){
      const key=draftKey()+':'+draft.operationKey;
      if(draftImageKey!==key){
        releaseDraftImages();draftImageKey=key;
        try{const stored=await imageDraftStore(key);if(draftImageKey===key)draftImages=(stored||[]).map(item=>({...item,url:URL.createObjectURL(item.file)}));}catch{}
      }
    }
    let tx=(transactions||[]).find(t=>t._id===draft.transactionId);
    if(!tx&&draft.transactionId){try{tx=await api('/transactions/'+encodeURIComponent(draft.transactionId));}catch(e){toast(e.message,true);}}
    const edit=options.edit;
    show(edit?tr('تعديل المنتجات والكميات','Edit products & quantities'):tr('شكوى جديدة','New complaint'),tr('ملف واحد لكل مشكلة · متابعة حتى الإغلاق','One issue, one case · tracked through closure'),`<form data-cf-create novalidate><fieldset class="cf-create-details" data-cf-create-details>
      <section class="cf-card cf-create-invoice"><h3>${tr('الفاتورة','Invoice')} <small>${tr('اختياري','Optional')}</small></h3><div class="cf-order-search"><label class="cf-search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input class="cf-search" name="orderSearch" aria-label="${tr('البحث عن فاتورة','Search invoices')}" aria-controls="cf-search-results" placeholder="${tr('ابحث برقم الفاتورة أو الاسم أو الهاتف','Search invoice, name or phone')}" autocomplete="off"></label><div class="cf-search-results" id="cf-search-results" data-cf-results hidden></div><small class="cf-search-hint" data-cf-search-hint role="status"></small></div><div data-cf-selected></div><div data-cf-items></div><div data-cf-duplicates></div></section>
      ${!edit?`<div class="cf-two">${field('clientName',tr('اسم العميل','Customer name'),'text',draft.clientName||'','required')}${field('phone',tr('رقم التواصل','Phone'),'tel',draft.phone||'','required')}</div><div class="cf-two cf-create-classify">${select('categoryGroup',tr('نوع المشكلة','Issue category'),{'':tr('اختر نوع المشكلة','Choose an issue category'),...Object.fromEntries(Object.keys(CMP_CATEGORIES).map(k=>[k,_cmpCategoryLabel(k)]))},draft.categoryGroup,true)}${select('priority',tr('الأولوية','Priority'),{'متوسطة':tr('متوسطة','Medium'),'عالية':tr('عالية','High'),'منخفضة':tr('منخفضة','Low')},draft.priority||'متوسطة')}</div><label class="cf-field"><span data-cf-description-label>${tr('وصف المشكلة والنتيجة المطلوبة','Issue and desired outcome')}</span><textarea name="description" required maxlength="5000" rows="3">${esc(draft.description||'')}</textarea></label>`:''}
      </fieldset>${!edit?`<section class="cf-card cf-evidence cf-create-evidence"><h3>${tr('صور المشكلة','Issue photos')} <small>${tr('اختياري','Optional')}</small></h3>${uploadControls()}<div class="cf-images" data-cf-draft-images></div><small class="cf-muted" data-cf-draft-upload-hint></small></section>`:''}
      <div class="cf-foot"><button type="button" class="btn btn-outline" data-cf-back>${edit?tr('رجوع','Back'):tr('حفظ مسودة وإغلاق','Save draft & close')}</button>${!edit?`<button type="button" class="btn btn-outline" data-cf-discard>${tr('مسح المسودة','Discard draft')}</button>`:''}<button type="submit" class="btn btn-primary">${edit?tr('حفظ المنتجات والكميات','Save products & quantities'):tr('تسجيل الشكوى','Create complaint')}</button></div></form>`);
    const f=el('form');let selected=tx;
    function saveDraft(){if(edit)return;if(!draft.createdId){const values=Object.fromEntries(new FormData(f));for(const key of Object.keys(values))if(key==='orderSearch'||/^itemIssue(Type|Description)_/.test(key))delete values[key];Object.assign(draft,values);delete draft.imageUrl;draft.items=readItems();draft.transactionId=selected?._id||'';}sessionStorage.setItem(draftKey(),JSON.stringify(draft));}
    function readItems(){return [...f.querySelectorAll('[data-cf-line]')].filter(r=>r.querySelector('[type=checkbox]').checked).map(r=>{const lineIndex=Number(r.dataset.cfLine);return {lineIndex,qty:Number(r.querySelector('[type=number]').value),issueType:r.querySelector('[data-cf-item-reason]').value,issueDescription:r.querySelector('[data-cf-item-description]').value.trim(),...(draft.items?.find(item=>item.lineIndex===lineIndex)?.unitIds?{unitIds:draft.items.find(item=>item.lineIndex===lineIndex).unitIds}:{})};});}
    function itemDetailsMatch(row,expected){const detailed=expected.filter(item=>item.issueType||item.issueDescription);return !detailed.length||Array.isArray(row?.items)&&row.items.length===expected.length&&detailed.every(item=>{const saved=row.items.find(line=>Number(line.lineIndex)===item.lineIndex);return saved&&Number(saved.qty)===item.qty&&saved.issueType===item.issueType&&String(saved.issueDescription||'').trim()===item.issueDescription.trim();});}
    async function verifyItemDetails(row,expected){
      if(itemDetailsMatch(row,expected))return row;
      if(row?._id)row=await api(`/complaints/${encodeURIComponent(row._id)}`,{background:true});
      if(itemDetailsMatch(row,expected))return row;
      const failure=new Error(tr('لم يكتمل حفظ سبب ووصف بعض المنتجات. احتفظنا بالتفاصيل في المسودة؛ أعد المحاولة.','Some product issues and descriptions were not saved. Your details are retained; retry saving.'));
      failure.itemDetailsMissing=true;failure.savedComplaint=row;throw failure;
    }
    function syncDescription(){if(edit)return;const perItem=readItems().length>0;f.elements.description.required=!perItem;f.querySelector('[data-cf-description-label]').textContent=perItem?tr('ملاحظات إضافية · اختياري','Additional notes · optional'):tr('وصف المشكلة والنتيجة المطلوبة','Issue and desired outcome');if(perItem&&typeof clearValidation==='function')clearValidation(f.elements.description);}
    function drawDraftImages(){
      if(edit||!f.isConnected)return;
      const host=f.querySelector('[data-cf-draft-images]');
      host.innerHTML=draftImages.map((item,index)=>`<div class="cf-evidence-item"><button type="button" class="cf-draft-preview" data-cf-draft-preview="${index}" title="${esc(tr('معاينة ','Preview ')+item.file.name)}" aria-label="${esc(tr('معاينة ','Preview ')+item.file.name)}" ${busy?'disabled':''}><img class="cf-draft-image" src="${esc(item.url)}" alt="${esc(item.file.name)}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg></button><div class="cf-draft-caption"><span title="${esc(item.file.name)}">${esc(item.file.name)}</span><button type="button" class="cf-evidence-remove" data-cf-remove-draft-image="${esc(item.id)}" aria-label="${esc(tr('إزالة الصورة: ','Remove image: ')+item.file.name)}" ${busy?'disabled':''}>${tr('إزالة','Remove')}</button></div></div>`).join('');
      host.querySelectorAll('[data-cf-draft-preview]').forEach(button=>button.onclick=()=>previewImage({complaintNo:tr('شكوى جديدة','New complaint')},draftImages.map(item=>({url:item.url,name:item.file.name})),Number(button.dataset.cfDraftPreview),button));
      const full=draftImages.length+(draft.savedImageCount||0)>=10,choose=f.querySelector('[data-cf-choose-images]');
      choose.disabled=busy||full;if(busy)choose.dataset.wasDisabled=String(full);
      host.querySelectorAll('[data-cf-remove-draft-image]').forEach(button=>button.onclick=async()=>{
        if(busy)return;buttonsDisabled(true);
        try{const index=draftImages.findIndex(item=>item.id===button.dataset.cfRemoveDraftImage);if(index>=0){URL.revokeObjectURL(draftImages[index].url);draftImages.splice(index,1);await persistDraftImages();}}
        finally{buttonsDisabled(false);drawDraftImages();}
      });
    }
    function showCreatedState(){
      if(edit||!draft.createdId)return;
      f.querySelector('[data-cf-create-details]').disabled=true;
      f.querySelector('[data-cf-draft-upload-hint]').textContent=draft.itemDetailsPending?tr('الملف مسجل، وتفاصيل المنتجات محفوظة في المسودة لحين تأكيد حفظها.','The case exists. Product details remain in your draft until their save is confirmed.'):tr('تم تسجيل المشكلة. أكمل رفع الصور المتبقية أو تخطّها لفتح المشكلة.','The issue is saved. Upload the remaining images or skip them to open the issue.');
      f.querySelector('button[type=submit]').textContent=draft.itemDetailsPending?tr('إعادة حفظ تفاصيل المنتجات','Retry saving product details'):tr('إكمال رفع الصور','Continue uploading images');
      f.querySelector('[data-cf-back]').textContent=tr('إكمال لاحقًا','Continue later');
      const discard=f.querySelector('[data-cf-discard]');discard.textContent=tr('تخطي الصور المتبقية','Skip remaining images');discard.disabled=!!draft.itemDetailsPending;if(busy)discard.dataset.wasDisabled=String(discard.disabled);
    }
    if(!edit){
      f.querySelector('[data-cf-choose-images]').onclick=()=>{if(!busy)f.querySelector('[data-cf-upload]').click();};
      f.querySelector('[data-cf-upload]').onchange=async event=>{
        const files=[...event.target.files];event.target.value='';if(busy||!files.length)return;
        buttonsDisabled(true);
        try{
          validateImages(files,draftImages.length+(draft.savedImageCount||0));
          for(const file of files)draftImages.push({id:uid(),file,url:URL.createObjectURL(file)});
          saveDraft();await persistDraftImages();
        }catch(e){error(e);}finally{buttonsDisabled(false);drawDraftImages();}
      };
      drawDraftImages();showCreatedState();
    }
    function draw(){
      el('.cf-order-search').hidden=!!selected;
      el('[data-cf-selected]').innerHTML=selected?`<div class="cf-selected-order"><div class="cf-order-info"><strong><bdi>#${esc(selected.ref)}</bdi> · ${esc(selected.client)}</strong>${selected.phone?`<small><bdi>${esc(selected.phone)}</bdi></small>`:''}${shippingStatus(selected)}</div>${!edit?`<button type="button" class="btn btn-outline cf-change-order" data-cf-clear>${tr('تغيير الفاتورة','Change invoice')}</button>`:''}</div>`:`<p class="cf-muted">${tr('يمكن تسجيل الشكوى بدون فاتورة مع بيانات التواصل.','You can register without an invoice using customer contact details.')}</p>`;
      if(!edit){f.elements.clientName.readOnly=!!selected?.client;f.elements.phone.readOnly=!!selected?.phone;if(selected){f.elements.clientName.value=selected.client||draft.clientName||'';f.elements.phone.value=selected.phone||draft.phone||'';}}
      el('[data-cf-items]').innerHTML=(selected?.items||[]).map((i,index)=>{const picked=draft.items?.find(v=>v.lineIndex===index),max=Number.isSafeInteger(Number(i.qty))&&Number(i.qty)>0?Number(i.qty):0,checked=!!picked&&max>0;return `<div class="cf-item cf-product-item ${checked?'is-selected':''}" data-cf-line="${index}"><label class="cf-product-choice"><input type="checkbox" ${checked?'checked':''} ${!max?'disabled':''}>${productImage(i)}<span class="cf-product-info"><strong>${esc(i.name||i.code)}</strong>${i.code?`<small><bdi>${esc(i.code)}</bdi></small>`:''}<small>${tr('الكمية بالفاتورة','Invoice quantity')}: ${esc(i.qty)}</small></span></label><label class="cf-item-quantity"><span>${tr('الكمية المتضررة','Affected quantity')}</span><input type="number" min="1" max="${max}" step="1" value="${max?Math.min(max,Math.max(1,Math.floor(Number(picked?.qty)||1))):0}" aria-label="${tr('الكمية المتضررة','Affected quantity')} ${esc(i.name||i.code)}" ${checked?'required':'disabled'}></label><div class="cf-line-issue" data-cf-line-issue ${checked?'':'hidden'}><div class="cf-field"><span id="cf-item-reason-${index}">${tr('مشكلة هذا المنتج','This product’s issue')} <span class="cf-required" aria-hidden="true">*</span></span><span class="cf-select"><select name="itemIssueType_${index}" data-cf-item-reason aria-labelledby="cf-item-reason-${index}" required ${checked?'':'disabled'}><option value="">${tr('اختر مشكلة المنتج','Choose this product’s issue')}</option>${Object.entries(productIssueTypes()).map(([key,label])=>`<option value="${key}" ${picked?.issueType===key?'selected':''}>${label}</option>`).join('')}</select></span></div><label class="cf-field"><span>${tr('وصف المشكلة لهذا المنتج','Describe this product’s issue')} <span class="cf-required" aria-hidden="true">*</span></span><textarea name="itemIssueDescription_${index}" data-cf-item-description required maxlength="2000" rows="2" placeholder="${esc(productIssueHint(picked?.issueType))}" ${checked?'':'disabled'}>${esc(picked?.issueDescription||'')}</textarea></label></div></div>`;}).join('');
      f.querySelectorAll('[data-cf-line]').forEach(row=>{
        const check=row.querySelector('[type=checkbox]'),qty=row.querySelector('[type=number]'),reason=row.querySelector('[data-cf-item-reason]'),description=row.querySelector('[data-cf-item-description]');
        const normalizeQty=()=>{if(qty.value!==''){const value=Number(qty.value);if(Number.isFinite(value))qty.value=Math.min(Number(qty.max),Math.max(1,Math.floor(value)));}};
        qty.addEventListener('input',normalizeQty);
        qty.addEventListener('blur',()=>{if(!qty.value)qty.value='1';normalizeQty();saveDraft();});
        check.addEventListener('change',()=>{const enabled=check.checked;row.classList.toggle('is-selected',enabled);row.querySelector('[data-cf-line-issue]').hidden=!enabled;qty.disabled=reason.disabled=description.disabled=!enabled;qty.required=enabled;if(!enabled&&typeof clearValidation==='function')[qty,reason,description].forEach(clearValidation);syncDescription();});
        reason.addEventListener('change',()=>{description.placeholder=productIssueHint(reason.value);});
      });
      if(typeof _pmEnhanceSelects==='function')_pmEnhanceSelects(el('[data-cf-items]'));
      syncDescription();
      const similar=(complaints||[]).filter(c=>c._id!==edit?._id&&c.workflow?.stage!=='closed'&&(selected?c.transactionId===selected._id:draft.phone&&c.phone===draft.phone));
      el('[data-cf-duplicates]').innerHTML=similar.length?`<div class="cf-notice">${tr('توجد شكاوى مفتوحة؛ راجعها قبل إنشاء أخرى:','Open complaints found; review before creating another:')} ${similar.map(c=>`<button type="button" class="cf-link" data-cf-existing="${esc(c._id)}">${esc(c.complaintNo)}</button>`).join(' · ')}</div>`:'';
      f.querySelectorAll('[data-cf-existing]').forEach(b=>b.onclick=()=>{saveDraft();open(b.dataset.cfExisting);});
      el('[data-cf-clear]')?.addEventListener('click',()=>{selected=null;draft.items=[];draw();saveDraft();f.elements.orderSearch.focus();});
    }
    draw();
    f.elements.orderSearch.oninput=()=>{
      const normalize=v=>String(v??'').toLowerCase().replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-1632)).trim();
      const q=normalize(f.elements.orderSearch.value).replace(/^#/,'');
      const matches=q?(transactions||[]).filter(t=>t.type==='مبيعات'&&[t.ref,t.client,t.phone].some(v=>normalize(v).includes(q))):[];
      matches.sort((a,b)=>Number(normalize(b.ref)===q)-Number(normalize(a.ref)===q));
      const rows=matches.slice(0,5),results=el('[data-cf-results]'),hint=el('[data-cf-search-hint]');
      results.hidden=!rows.length;
      results.innerHTML=rows.map(t=>`<button class="cf-result" type="button" data-cf-pick="${esc(t._id)}"><span class="cf-order-info"><strong><bdi>#${esc(t.ref)}</bdi> · ${esc(t.client)}</strong><small><bdi>${esc(t.phone||'')}</bdi></small></span>${shippingStatus(t)}</button>`).join('');
      hint.textContent=!q?'':!rows.length?tr('لا توجد فواتير مطابقة. جرّب رقم الفاتورة أو الهاتف.','No matching invoices. Try an invoice number or phone.'):matches.length>5?tr(`عرض 5 من ${matches.length} نتيجة — اكتب تفاصيل أكثر لتحديد الفاتورة.`,`Showing 5 of ${matches.length} results — refine your search to find the invoice.`):tr(`${rows.length} نتيجة بحث`,`${rows.length} search result(s)`);
      f.querySelectorAll('[data-cf-pick]').forEach(b=>b.onclick=()=>{selected=rows.find(t=>t._id===b.dataset.cfPick);draft.items=[];f.elements.orderSearch.value='';results.innerHTML='';results.hidden=true;hint.textContent='';draw();saveDraft();});
    };
    f.addEventListener('input',saveDraft);f.addEventListener('change',saveDraft);
    function syncCategoryError(){
      for(const input of [f.elements.categoryGroup,...f.querySelectorAll('[data-cf-item-reason]')].filter(Boolean)){
        const trigger=input.closest('.pm-sel')?.querySelector('.pm-sel-btn');if(!trigger)continue;
        if(input._errorMsgEl)input.closest('.cf-field')?.appendChild(input._errorMsgEl);
        if(input.getAttribute('aria-invalid')==='true'){trigger.setAttribute('aria-invalid','true');trigger.setAttribute('aria-describedby',input.getAttribute('aria-describedby')||'');}
        else{trigger.removeAttribute('aria-invalid');trigger.removeAttribute('aria-describedby');}
      }
    }
    f.addEventListener('change',syncCategoryError);
    function validateCreate(){
      f.dataset.validationAttempted='true';let first=null;
      for(const input of f.querySelectorAll('input,select,textarea')){
        if(input.matches(':disabled')||!input.required&&(!input.willValidate||input.validity.valid))continue;
        const message=input.closest('[data-cf-line]')&&input.type==='number'&&!input.validity.valid?tr(`الكمية من 1 إلى ${input.max}`,`Quantity must be between 1 and ${input.max}`):input.required&&!String(input.value).trim()?tr('مطلوب','Required'):typeof _fieldValidationMessage==='function'?_fieldValidationMessage(input):input.validity.valid?'':tr('مطلوب','Required');
        if(message){if(typeof markInvalid==='function')markInvalid(input,message);first||=input;}else if(typeof clearValidation==='function')clearValidation(input);
      }
      syncCategoryError();
      if(first){const target=first.closest('.pm-sel')?.querySelector('.pm-sel-btn')||first;target.focus({preventScroll:true});target.scrollIntoView({block:'nearest',behavior:'instant'});return false;}
      return true;
    }
    el('[data-cf-back]').onclick=()=>{saveDraft();edit?open(edit._id):closeLayer(dialog);};
    el('[data-cf-discard]')?.addEventListener('click',async()=>{
      if(busy)return;buttonsDisabled(true);const view=serial;
      try{const id=draft.createdId;sessionStorage.removeItem(draftKey());createDraft=null;await clearDraftImages();if(view===serial){if(id)await open(id);else closeLayer(dialog);}}
      finally{buttonsDisabled(false);}
    });
    f.onsubmit=async event=>{event.preventDefault();if(busy||!validateCreate())return;saveDraft();const expectedItems=readItems();buttonsDisabled(true);f.querySelector('[data-cf-create-details]').disabled=true;try{
      let result;
      if(edit){result=await mutate(edit,'items',{transactionId:selected?._id,items:expectedItems});edit.workflow=result.workflow;result=await verifyItemDetails(result,expectedItems);}
      else{
        validateImages(draftImages.map(item=>item.file),draft.savedImageCount||0);
        if(draft.createdId){
          result=await api(`/complaints/${draft.createdId}`,{background:true});
          if(!itemDetailsMatch(result,expectedItems))result=await mutate(result,'items',{transactionId:draft.transactionId,items:expectedItems});
        }
        else{
          const body={...draft,items:expectedItems};delete body.orderSearch;delete body.imageUrl;delete body.createdId;delete body.savedImageCount;delete body.itemDetailsPending;if(!body.transactionId)delete body.transactionId;
          result=await api('/complaints',{method:'POST',body:JSON.stringify(body)});
          draft.createdId=result._id;
        }
        draft.itemDetailsPending=!itemDetailsMatch(result,expectedItems);saveDraft();showCreatedState();
        result=await verifyItemDetails(result,expectedItems);delete draft.itemDetailsPending;saveDraft();showCreatedState();
        draft.savedImageCount=(result.attachments||[]).length;saveDraft();
        await refresh(result);
        const total=draftImages.length;let uploaded=0;
        while(draftImages.length){
          const item=draftImages[0],data=new FormData();data.append('file',item.file);
          f.querySelector('[data-cf-upload-status]').textContent=tr(`جارٍ رفع الصورة ${uploaded+1} من ${total}…`,`Uploading image ${uploaded+1} of ${total}…`);
          result=await api(`/complaints/${draft.createdId}/evidence`,{method:'POST',body:data});
          URL.revokeObjectURL(item.url);draftImages.shift();uploaded++;
          draft.savedImageCount=(result.attachments||[]).length;saveDraft();await persistDraftImages();drawDraftImages();result=await verifyItemDetails(result,expectedItems);await refresh(result);
        }
        sessionStorage.removeItem(draftKey());createDraft=null;await clearDraftImages();
      }
      await refresh(result);await open(result._id,edit?'':'registered',result);
    }catch(e){
      if(edit&&e.savedComplaint?.workflow)edit.workflow=e.savedComplaint.workflow;
      if(!edit&&draft.createdId){if(e.itemDetailsMissing)draft.itemDetailsPending=true;saveDraft();showCreatedState();f.querySelector('[data-cf-upload-status]').textContent=draft.itemDetailsPending?tr('تفاصيل المنتجات محفوظة في المسودة ولم يتأكد حفظها في الملف بعد.','Product details remain in the draft; their save in the case is not yet confirmed.'):tr('لم يكتمل رفع الصور. أعد المحاولة؛ المشكلة مسجلة بالفعل.','Image upload is incomplete. Retry; the issue is already saved.');}
      error(e);
    }finally{buttonsDisabled(false);if(f.isConnected){f.querySelector('[data-cf-create-details]').disabled=!!draft.createdId;drawDraftImages();}}};
  }
  function matches(c){const w=c.workflow||{},stage=c.lifecycleStage||w.stage||'review';if(queue==='attention')return !!w.reviewRequired||stage==='blocked';if(queue==='archived')return !!w.archivedAt;if(w.archivedAt)return false;if(queue==='all')return true;if(queue==='active')return stage!=='closed';if(queue==='mine')return stage!=='closed'&&(w.ownerId||c.submittedById)===me();if(queue==='overdue')return !!c.overdue;return stage===queue;}
  let invoiceIndex=new Map();
  let listPage=0,listSignature='';
  function pageRows(rows){
    const signature=rows.map(c=>c._id).join('|');if(signature!==listSignature){listSignature=signature;listPage=0;}
    const size=30,pages=Math.ceil(rows.length/size);listPage=Math.min(listPage,Math.max(0,pages-1));
    const host=document.getElementById('cmp-complaints-section');let foot=host?.querySelector('[data-cf-pagination]');
    if(host&&!foot){foot=document.createElement('div');foot.className='cf-pagination';foot.dataset.cfPagination='';host.appendChild(foot);}
    if(foot){foot.hidden=!rows.length;foot.innerHTML=`<span role="status">${tr('عرض','Showing')} ${listPage*size+1}–${Math.min((listPage+1)*size,rows.length)} ${tr('من','of')} ${rows.length}</span><div><button type="button" class="btn btn-outline" data-cf-prev ${listPage===0?'disabled':''}>${tr('السابق','Previous')}</button><button type="button" class="btn btn-outline" data-cf-next ${listPage>=pages-1?'disabled':''}>${tr('التالي','Next')}</button></div>`;foot.querySelector('[data-cf-prev]').onclick=()=>{listPage--;renderComplaints();};foot.querySelector('[data-cf-next]').onclick=()=>{listPage++;renderComplaints();};}
    return rows.slice(listPage*size,(listPage+1)*size);
  }
  const owner=c=>c.workflow?.owner||c.submittedBy||'';
  const stageOf=c=>c.lifecycleStage||c.workflow?.stage||'review';
  const listDateFormats=new Map();
  function listDate(value,withTime=false,compact=false){
    if(!value)return '<span class="cf-table-empty">—</span>';
    const date=new Date(value);if(!Number.isFinite(date.getTime()))return '<span class="cf-table-empty">—</span>';
    const locale=tr('ar-EG','en-GB');
    if(!listDateFormats.has(locale)){const options={timeZone:'Africa/Cairo',numberingSystem:'latn'};listDateFormats.set(locale,{day:new Intl.DateTimeFormat(locale,{...options,day:'2-digit',month:'short',year:'numeric'}),numeric:new Intl.DateTimeFormat(locale,{...options,day:'2-digit',month:'2-digit',year:'numeric'}),hour:new Intl.DateTimeFormat(locale,{...options,hour:'2-digit',minute:'2-digit',hourCycle:'h23'})});}
    const formats=listDateFormats.get(locale),parts=compact?Object.fromEntries(formats.numeric.formatToParts(date).map(part=>[part.type,part.value])):null;
    const day=compact?`${parts.day}/${parts.month}/${parts.year}`:formats.day.format(date),hour=formats.hour.format(date);
    return `<time class="cf-table-date" ${compact?'dir="ltr"':''} datetime="${esc(date.toISOString())}" title="${esc(day+' · '+hour)}"><span>${esc(day)}</span>${withTime?`<small><bdi>${esc(hour)}</bdi></small>`:''}</time>`;
  }
  function searchText(c){return [c.complaintNo,c.clientName,c.phone,c.transactionRef,c.description,c.categoryGroup,c.category,owner(c),c.submittedBy,c.workflow?.caseRef,solutions()[c.workflow?.solution],stages()[stageOf(c)],...(c.items||[]).flatMap(i=>[i.name,i.code])].join(' ').toLowerCase();}
  function ownerAvatar(c){const name=owner(c).trim(),label=tr('المسؤول: ','Owner: ')+(name||tr('غير معيّن','Unassigned')),initial=Array.from(name)[0]?.toLocaleUpperCase()||'—';return `<span class="cf-owner-avatar" role="img" aria-label="${esc(label)}" title="${esc(name||tr('غير معيّن','Unassigned'))}"><span aria-hidden="true">${esc(initial)}</span></span>`;}
  function tableHead(){return [tr('ملف الشكوى','Complaint'),tr('العميل','Customer'),tr('الفاتورة والشحن','Invoice / shipping'),tr('المشكلة والمنتجات','Issue / products'),tr('الحل والتنفيذ','Resolution / execution'),tr('مرحلة المعالجة','Workflow stage'),tr('الأولوية','Priority'),tr('موعد المتابعة','Follow-up due'),tr('الإجراءات','Actions'),tr('المسؤول الحالي','Current owner')].map((label,index)=>index===9?`<th scope="col" class="cf-owner-column" title="${esc(label)}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">${actionIcons.assign}</svg><span class="cf-sr-only">${esc(label)}</span></th>`:`<th scope="col">${esc(label)}</th>`).join('');}
  function ticketIdentity(c){return `<div class="cf-ticket-line" dir="ltr"><button type="button" class="cf-ticket-open" data-id="${esc(c._id)}" onclick="event.stopPropagation();ComplaintFlow.openFromList(this.dataset.id)" title="${esc(tr('فتح ملف الشكوى ','Open complaint ')+c.complaintNo)}"><bdi>${esc(c.complaintNo||'—')}</bdi></button><button type="button" class="cmp-no-chip cf-ticket-copy" data-number="${esc(c.complaintNo||'')}" onclick="event.stopPropagation();copyComplaintNo(this.dataset.number)" aria-label="${esc(tr('نسخ رقم التذكرة ','Copy ticket number ')+c.complaintNo)}" title="${esc(tr('نسخ رقم التذكرة','Copy ticket number'))}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg></button></div>`;}
  function issueSummary(c){
    const items=c.items?.length?c.items:c.productName?[{name:c.productName,qty:c.productQty||1}]:[];
    const category=typeof _cmpCategoryLabel==='function'?_cmpCategoryLabel(c.categoryGroup):c.categoryGroup;
    return `<div class="cf-cell-stack cf-issue-summary">${category?`<strong class="cf-category-label">${categoryIcon(c.categoryGroup)}${esc(category)}</strong>`:''}<span class="cf-cell-clamp" title="${esc(c.description)}">${esc(c.description||'—')}</span>${items.length?`<small class="cf-cell-clamp" title="${esc(items.map(i=>`${i.name||i.code} × ${i.qty}`).join(' · '))}">${esc(items.map(i=>`${i.name||i.code} × ${i.qty}`).join(' · '))}</small>`:''}${c.attachments?.length?`<small>${tr('صور الإثبات','Evidence images')}: ${c.attachments.length}</small>`:''}</div>`;
  }
  function stageCell(c){const w=c.workflow||{},e=c.execution||{};return `<div class="cf-cell-stack">${badge(c)}${w.reviewRequired?`<small class="cf-due-overdue">${tr('تحتاج مراجعة المسؤول','Owner review needed')}</small>`:''}${w.stage!=='closed'&&w.stage!=='waiting'&&w.solution&&e.blockers?.length?`<small class="cf-cell-clamp" title="${esc(e.blockers.map(b=>blockers()[b]||b).join(' · '))}">${esc(e.blockers.map(b=>blockers()[b]||b).join(' · '))}</small>`:''}${w.stage==='waiting'&&w.waitReason?`<small class="cf-cell-clamp" title="${esc(w.waitReason)}">${esc(w.waitReason)}</small>`:''}</div>`;}
  function solutionCell(c){
    const w=c.workflow||{},closed=w.stage==='closed',planned=!!w.solution;
    const icon=closed?(['resolved','partial_agreement'].includes(w.outcome)?actionIcons.resolved:actionIcons.close):!planned?'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>':solutionIconPaths.get(w.solution)||actionIcons.plan;
    return `<div class="cf-resolution ${closed?'is-closed':planned?'is-planned':'is-unplanned'}" data-solution="${esc(w.solution||'unplanned')}"><div class="cf-resolution-label"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon}</svg><strong>${esc(solutions()[w.solution]||w.solution||(closed?'—':tr('لم يُحدد الحل','Not planned')))}</strong></div>${w.caseId?`<button type="button" class="cf-execution-link" data-id="${esc(c._id)}" onclick="event.stopPropagation();ComplaintFlow.execution(this.dataset.id)"><bdi>${esc(w.caseRef||c.execution?.caseRef||tr('طلب التنفيذ','Execution case'))}</bdi><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/></svg></button>`:''}${closed?`<small>${esc(outcomes()[w.outcome]||'')}</small>`:''}</div>`;
  }
  function dueCell(c,compact=false){const w=c.workflow||{},overdue=tr('متأخرة','Overdue');return w.stage==='closed'?`<div class="cf-cell-stack cf-followup-date"><span class="cf-table-secondary">${tr('أُغلقت','Closed')}</span>${listDate(w.closedAt||c.resolvedAt,false,compact)}</div>`:`<div class="cf-cell-stack cf-followup-date ${c.overdue?'is-overdue':''}">${w.dueAt?listDate(w.dueAt,true,compact):`<span class="cf-table-secondary">${tr('غير محدد','Not scheduled')}</span>`}${c.overdue?(compact?`<span class="cf-overdue-mark" role="img" aria-label="${overdue}" title="${overdue}"></span>`:`<span class="cf-overdue-label">${overdue}</span>`):''}</div>`;}
  function invoiceCell(c){const tx=invoiceIndex.get(String(c.transactionId));return `<div class="cf-invoice-line"><span class="cf-invoice-ref" title="${esc(c.transactionRef?'#'+c.transactionRef:'')}">${cmpOrderRefCell(c)}</span>${tx?shippingStatus(tx,true):`<small title="${tr(c.transactionId?'حالة الشحن غير متاحة':'بدون فاتورة',c.transactionId?'Shipping status unavailable':'No invoice')}">${tr(c.transactionId?'حالة الشحن غير متاحة':'بدون فاتورة',c.transactionId?'Shipping status unavailable':'No invoice')}</small>`}</div>`;}
  function tableRow(c){return `<tr data-complaint-id="${esc(c._id)}" data-id="${esc(c._id)}" onclick="ComplaintFlow.openRow(event,this.dataset.id)">
    <td><div class="cf-cell-stack cf-record-identity">${ticketIdentity(c)}${listDate(c.createdAt)}</div></td>
    <td><div class="cf-cell-stack cf-client-identity"><strong dir="auto">${esc(c.clientName||'—')}</strong></div></td>
    <td>${invoiceCell(c)}</td><td>${issueSummary(c)}</td><td>${solutionCell(c)}</td><td>${stageCell(c)}</td><td>${cmpPriorityBadge(c)}</td>
    <td>${dueCell(c,true)}</td><td>${menu(c)}</td><td class="cf-owner-column">${ownerAvatar(c)}</td></tr>`;}
  function listCard(c){return `<article class="cmp-list-card cf-list-card" data-complaint-id="${esc(c._id)}">
    <div class="cf-list-heading">${ticketIdentity(c)}${cmpPriorityBadge(c)}</div>
    <div class="cf-cell-stack cf-list-client"><strong dir="auto">${esc(c.clientName||'—')}</strong><small><bdi>${esc(c.phone||'—')}</bdi></small>${listDate(c.createdAt)}</div>
    ${stageCell(c)}${issueSummary(c)}
    <dl class="cf-list-facts"><dt>${tr('الفاتورة والشحن','Invoice / shipping')}</dt><dd>${invoiceCell(c)}</dd><dt>${tr('المسؤول','Owner')}</dt><dd>${esc(owner(c)||'—')}</dd><dt>${tr('الحل والتنفيذ','Resolution / execution')}</dt><dd>${solutionCell(c)}</dd><dt>${tr('المتابعة','Follow-up')}</dt><dd>${dueCell(c)}</dd></dl>${menu(c)}</article>`;}
  const queueMedia=window.matchMedia('(max-width:768px)');
  function placeQueue(){
    const box=document.querySelector('[data-cf-queue]');if(!box)return;
    const target=document.querySelector(queueMedia.matches?'#cmp-header-block .cmp-mobile-bar':'#cmp-header-block .cmp-filter-bar');
    if(!target||box.parentElement===target)return;
    if(box.querySelector('.fsel-btn.is-open')&&typeof fselClose==='function')fselClose();
    if(queueMedia.matches)target.insertBefore(box,target.querySelector('.cmp-filter-trigger'));
    else target.querySelector('.cmp-filter-search').after(box);
  }
  queueMedia.addEventListener('change',placeQueue);
  function placeSummary(){
    const counts=document.querySelector('[data-cf-counts]');if(!counts)return;
    const bar=document.getElementById(queueMedia.matches?'cmp-chip-row':'cmp-status-tabs');if(!bar)return;
    const track=bar.closest('.ui-tabs-shell')||bar;
    let summary=track.closest('.cf-status-summary');
    if(!summary){summary=document.createElement('div');summary.className='cf-status-summary';summary.dataset.summaryView=queueMedia.matches?'mobile':'desktop';track.before(summary);summary.appendChild(track);}
    if(counts.parentElement!==summary)summary.appendChild(counts);
  }
  queueMedia.addEventListener('change',placeSummary);
  function mount(){
    const host=document.getElementById('cmp-complaints-section');if(!host)return;
    invoiceIndex=new Map((transactions||[]).map(tx=>[String(tx._id),tx]));
    const table=host.querySelector('#cmp-table');if(table){table.dataset.cfTable='';table.setAttribute('aria-label',tr('جدول الشكاوى والحلول والمتابعة','Complaints, resolutions and follow-up'));table.querySelector('thead tr').innerHTML=tableHead();const scroll=table.closest('.overflow-x');if(scroll){scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label',tr('جدول الشكاوى، قابل للتمرير أفقيًا','Complaints table, scroll horizontally'));}}
    const ownerLabel=document.querySelector('#cmp-emp-filter')?.closest('.cmp-filter-field')?.querySelector('label');if(ownerLabel){ownerLabel.removeAttribute('data-i18n');ownerLabel.textContent=tr('المسؤول الحالي','Current owner');}
    let box=document.querySelector('[data-cf-queue]');
    if(!box){box=document.createElement('div');box.className='cmp-filter-field cf-queue';box.dataset.cfQueue='';host.prepend(box);}
    placeQueue();
    if(box.dataset.lang!==currentLang){if(box.querySelector('.fsel-btn.is-open')&&typeof fselClose==='function')fselClose();box.dataset.lang=currentLang;box.innerHTML=`<div class="cf-queue-field"><label id="cf-queue-label" for="cf-queue">${tr('قائمة العمل','Work queue')}</label><select id="cf-queue">${Object.entries({active:tr('الشكاوى المفتوحة','Open complaints'),mine:tr('مسؤول عنها','Assigned to me'),overdue:tr('متأخرة','Overdue'),attention:tr('تحتاج مراجعة','Needs attention'),...stages(),all:tr('الكل','All'),archived:tr('الأرشيف','Archived')}).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('')}</select></div>`;box.querySelector('select').value=queue;box.querySelector('select').onchange=e=>{queue=e.target.value;renderComplaints();};}
    const queueSelect=box.querySelector('select');
    if(typeof fselInit==='function'){
      fselInit(queueSelect,{size:'lg'});fselSync(queueSelect);
      queueSelect.tabIndex=-1;queueSelect.setAttribute('aria-hidden','true');
      const trigger=box.querySelector('.fsel-btn');trigger.id='cf-queue-trigger';trigger.setAttribute('aria-labelledby','cf-queue-label');
      box.querySelector('label').htmlFor=trigger.id;
    }
    const rows=complaints||[],open=rows.filter(c=>c.workflow?.stage!=='closed'&&!c.workflow?.archivedAt),due=open.filter(c=>c.overdue),ready=open.filter(c=>c.execution?.ready),urgent=open.filter(c=>c.priority==='عالية');
    let counts=document.querySelector('[data-cf-counts]');
    if(!counts){counts=document.createElement('div');counts.className='cf-queue-counts';counts.dataset.cfCounts='';counts.setAttribute('aria-live','polite');host.prepend(counts);}
    counts.setAttribute('role','group');counts.setAttribute('aria-label',tr('ملخص متابعة الشكاوى','Complaint follow-up summary'));
    counts.innerHTML=[[tr('مفتوحة','Open'),open.length,'open'],[tr('متأخرة','Overdue'),due.length,'overdue'],[tr('بانتظار التأكيد','Awaiting confirmation'),ready.length,'confirmation'],[tr('أولوية عالية','High priority'),urgent.length,'urgent']].map(([label,count,key])=>`<span class="cf-summary-metric cf-summary-${key}${count?' has-value':''}"><span>${label}</span><strong>${typeof fmtN==='function'?fmtN(count):count}</strong></span>`).join('');
    placeSummary();
  }
  function changed(){
    clearTimeout(changeTimer);changeTimer=setTimeout(async()=>{
      if(busy||dialog?.open||photoDialog?.open||changeTask){changed();return;}
      if(!admin()&&typeof hasPerm==='function'&&!hasPerm('complaints')&&!hasPerm('transaction'))return;
      details.clear();reads.clear();const view=serial,id=visible()&&el('.cf-case-layout')?active?._id:null;
      changeTask=(async()=>{try{await refresh();if(id&&view===serial&&visible())await open(id);}catch{}finally{changeTask=null;}})();await changeTask;
    },200);
  }
  window.SouliaMotion={enter:enterMotion,close:closeLayer,cancelClose};
  window.ComplaintFlow={open,openRow,openFromList,enter,leave,back,resume,execution,form,create,chooseTicket,badge,menu,matches,mount,changed,tableRow,listCard,searchText,owner,pageRows,solutionIcon,categoryIcon};
})();
