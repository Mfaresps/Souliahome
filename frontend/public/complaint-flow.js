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
  const actionNames=()=>({attachment_removed:tr('حذف صورة إثبات','Evidence image deleted'),assign:tr('تحديد المسؤول','Owner assigned'),review:tr('بدء المراجعة','Review started'),plan:tr('تحديد خطة الحل','Resolution planned'),case_linked:tr('ربط طلب التنفيذ','Execution linked'),link:tr('ربط طلب التنفيذ','Execution linked'),unlink:tr('مراجعة طلب ملغى','Cancelled case reviewed'),wait:tr('تحديد انتظار ومتابعة','Follow-up scheduled'),resume:tr('استئناف المعالجة','Processing resumed'),fulfill:tr('توثيق تنفيذ الحل','Resolution documented'),payment:tr('دفع مستحق العميل','Customer payment recorded'),contact:tr('تواصل مع العميل','Customer contact'),close:tr('إغلاق الشكوى','Complaint closed'),reopen:tr('إعادة فتح الشكوى','Complaint reopened'),archive:tr('أرشفة الشكوى','Complaint archived'),items:tr('تحديد البنود والكميات','Items selected'),negative_rating:tr('تقييم يحتاج مراجعة','Rating needs review')});
  let dialog,active,serial=0,busy=false,queue='active',lastFocus,createDraft=null,draftOwner='';
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
  let cacheOwner='',imageObserver,changeTimer,changeTask;
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
  const el=s=>dialog?.querySelector(s);
  function show(title,subtitle,html){
    if(!dialog){dialog=document.createElement('dialog');dialog.className='cf-dialog';document.body.appendChild(dialog);dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});dialog.addEventListener('close',()=>{if(dialog.open)return;closeSelect();imageObserver?.disconnect();if(!document.querySelector('.as-dialog[open]')&&lastFocus?.isConnected)lastFocus.focus();});}
    closeSelect();
    imageObserver?.disconnect();
    delete dialog.dataset.cfFormAction;
    if(!dialog.open&&!document.activeElement?.closest('.as-dialog'))lastFocus=document.activeElement;
    dialog.dir=tr('rtl','ltr');dialog.setAttribute('aria-labelledby','cf-title');
    dialog.innerHTML=`<div class="cf-shell"><header class="cf-head"><div><small>${esc(subtitle)}</small><h2 id="cf-title">${esc(title)}</h2></div><button type="button" class="btn btn-outline" data-cf-dismiss aria-label="${tr('إغلاق','Close')}">×</button></header><div class="cf-body"><div class="cf-error" role="alert" data-cf-error></div>${html}</div></div>`;
    el('[data-cf-dismiss]').onclick=()=>{if(!busy)dialog.close();};if(!dialog.open)dialog.showModal();
    if(typeof _pmEnhanceSelects==='function')_pmEnhanceSelects(dialog);
    return ++serial;
  }
  function closeSelect(){if(typeof _pmSelOpen!=='undefined'&&_pmSelOpen?.wrap.closest('.cf-dialog')===dialog)_pmSelClose();}
  function visitExecution(row,caseId=''){
    if(busy)return;
    checkOwner();
    if(dialog?.open&&active?._id===row._id){
      positions.set(String(row._id),el('.cf-body').scrollTop);
      if(positions.size>50)positions.delete(positions.keys().next().value);
    }
    const task=AfterSales.fromComplaint({complaintId:row._id,complaintNo:row.complaintNo,invoiceId:row.transactionId,kind:row.workflow?.solution,expectedComplaintRevision:row.workflow?.revision,items:row.items,caseId});
    if(document.querySelector('.as-dialog[open]')){closeSelect();serial++;dialog?.close();}
    return task;
  }
  function execution(id){const row=details.get(String(id))?.row||(complaints||[]).find(c=>String(c._id)===String(id));if(row)return visitExecution(row,row.workflow?.caseId);}
  function resume(id){
    checkOwner();
    const task=open(id);
    const body=el('.cf-body');if(body)body.scrollTop=positions.get(String(id))||0;
    if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches)body?.animate?.([{opacity:.65},{opacity:1}],{duration:140,easing:'ease-out'});
    return task;
  }
  const error=e=>{if(el('[data-cf-error]')){el('[data-cf-error]').textContent=e.message||String(e);el('[data-cf-error]').scrollIntoView({block:'nearest'});}else toast(e.message||String(e),true);};
  function buttonsDisabled(value){busy=value;dialog?.querySelectorAll('button').forEach(b=>{if(value){b.dataset.wasDisabled=String(b.disabled);b.disabled=true;}else if('wasDisabled' in b.dataset){b.disabled=b.dataset.wasDisabled==='true';delete b.dataset.wasDisabled;}});}
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
  const select=(name,label,values,value='')=>`<div class="cf-field"><span id="cf-label-${name}">${esc(label)}</span><span class="cf-select"><select name="${name}" aria-labelledby="cf-label-${name}">${Object.entries(values).map(([key,text])=>`<option value="${esc(key)}" ${key===value?'selected':''}>${esc(text)}</option>`).join('')}</select></span></div>`;
  function shippingStatus(tx){
    if(!window.SouliaOrderStatus)return '';
    const meta=SouliaOrderStatus.resolve(tx,'transaction',tr('ar','en'));
    return `<span class="cf-shipping">${SouliaOrderStatus.badge(meta)}${meta.carrier?`<small>${esc(meta.carrier)}</small>`:''}${meta.note?`<small>${esc(meta.note)}</small>`:''}</span>`;
  }
  function productImage(item){
    const catalog=typeof products!=='undefined'&&Array.isArray(products)?products.find(p=>(item.productId&&p._id===item.productId)||(item.code&&p.code===item.code)):null;
    const url=[item.imageUrl,catalog?.imageUrl,catalog?.images?.[0]].find(v=>typeof v==='string'&&/^(https?:\/\/|\/(?!\/)|data:image\/(png|jpeg|webp|gif);base64,)/i.test(v));
    return `<span class="cf-product-image"><span aria-hidden="true">▧</span>${url?`<img src="${esc(url)}" alt="${esc(item.name||catalog?.name||item.code||tr('منتج','Product'))}" loading="lazy" onerror="this.hidden=true">`:''}</span>`;
  }
  const note=(label=tr('التفاصيل وسبب الإجراء','Details and reason'),required=false)=>`<label class="cf-field">${esc(label)}${required?'':' · '+tr('اختياري','Optional')}<textarea name="note" ${required?'required':''} maxlength="2000"></textarea></label>`;
  const uploadControls=(count=0)=>`<div class="cf-upload"><input type="file" accept="image/jpeg,image/png,image/webp" multiple data-cf-upload hidden><button type="button" class="btn btn-outline cf-upload-button" data-cf-choose-images aria-describedby="cf-upload-hint" ${count>=10?'disabled':''}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/></svg><span>${tr('رفع صور','Upload images')}</span></button><small id="cf-upload-hint">${tr('JPEG، PNG، WebP · حتى 5 ميجابايت للصورة · 10 صور كحد أقصى','JPEG, PNG, WebP · up to 5 MB each · maximum 10 images')}</small><span class="cf-muted" role="status" aria-live="polite" data-cf-upload-status></span></div>`;
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
  const deadline=()=>field('dueAt',tr('موعد المتابعة القادمة · توقيت القاهرة','Next follow-up · Cairo time'),'datetime-local',nextDay(),'required');
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
  const button=(key,label,primary=false)=>`<button type="button" class="btn cf-action-main ${primary?'btn-primary':'btn-outline'}" data-cf-action="${key}" title="${esc(actionHelp()[key]||'')}">${esc(label)}</button>`;
  function actionPanel(row){
    const w=row.workflow||{},e=row.execution||{},closed=w.stage==='closed';
    const followUp=(!closed?button('contact',tr('تسجيل تواصل','Log contact'))+button('assign',tr('المسؤول والموعد','Owner & deadline'))+button(w.stage==='waiting'?'resume':'wait',w.stage==='waiting'?tr('استئناف المتابعة','Resume follow-up'):tr('انتظار ومتابعة','Schedule follow-up')):'')+button('comment',tr('ملاحظة داخلية','Internal note'));
    const solution=closed?'':(!w.caseId&&!w.payment&&!w.fulfillment?button('items',tr('الفاتورة والقطع','Invoice & items'))+(admin()?button('plan',tr('خطة الحل','Resolution plan')):''):'')+
      (admin()&&['exchange','return'].includes(w.solution)&&!w.caseId?button('link',tr('ربط طلب موجود','Link existing case')):'')+
      (admin()&&e.blockers?.includes('case_cancelled')?button('unlink',tr('مراجعة الطلب الملغى','Review cancelled case')):'');
    const management=admin()?(closed?button('reopen',tr('إعادة فتح','Reopen'))+(!w.archivedAt?button('archive',tr('أرشفة','Archive')):''):button('close',tr('إغلاق بنتيجة','Close with outcome')))+button('delete',tr('حذف نهائي','Delete permanently')):'';
    return `<section class="cf-card cf-action-panel"><div class="cf-actions-heading"><h3>${tr('الإجراءات','Actions')}</h3><button type="button" class="cf-help-toggle" data-cf-help="cf-actions-guide" aria-controls="cf-actions-guide" aria-expanded="false">${tr('شرح الإجراءات','Action guide')}</button></div><div class="cf-action-list">${followUp}${solution}${management}</div><dl id="cf-actions-guide" class="cf-action-guide" hidden></dl></section>`;
  }
  function timeline(row){
    const w=row.workflow||{},createdText=/^تم (إنشاء|تسجيل) الشكوى$/;
    const events=[...(row.notes||[]).map(n=>({at:n.createdAt,by:n.author,note:n.text,action:n.kind==='system'&&createdText.test(n.text)?'registered':'comment'})),...(w.history||[]),...(w.executionEvents||[])];
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
      items:[tr('تحديد القطع المتضررة','Affected items selected'),tr('تم تحديث الفاتورة والقطع والكميات المرتبطة بالمشكلة.','The invoice, affected items, and quantities were updated.')],
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
    return `<section class="cf-card cf-log"><h3>${tr('مسار المشكلة','Issue timeline')}</h3><p class="cf-section-intro">${tr('الخطوات التي تمت، من تسجيل المشكلة حتى آخر تحديث.','What happened, from registration to the latest update.')}</p><ol class="cf-timeline">${events.map((event,index)=>{
      const [title,description]=copy[event.action]||[tr('تحديث على المشكلة','Issue updated'),tr('تم تسجيل تحديث جديد في ملف المشكلة.','An update was recorded in the case.')];
      const outcome=event.action==='close'?outcomes()[event.outcome]:event.action==='plan'?solutions()[event.solution]:'';
      const note=event.note&&!(event.action==='registered'&&createdText.test(event.note))?event.note:'';
      return `<li class="cf-timeline-step ${index===events.length-1?'is-latest':''}"><span class="cf-timeline-marker" aria-hidden="true">${index+1}</span><div class="cf-timeline-content"><div class="cf-timeline-heading"><strong>${esc(title)}</strong>${index===events.length-1?`<span class="cf-timeline-latest">${tr('آخر تحديث','Latest update')}</span>`:''}</div><p>${esc(description)}${outcome?` <strong>${esc(outcome)}</strong>`:''}</p><div class="cf-timeline-meta">${event.by?`<span>${esc(event.by)}</span>`:''}${event.at?`<time>${esc(time(event.at))}</time>`:''}${event.cycle>1?`<span>${tr('الدورة','Cycle')} ${esc(event.cycle)}</span>`:''}${event.caseRef?`<bdi>${esc(event.caseRef)}</bdi>`:''}</div>${note?`<details class="cf-timeline-details"><summary>${tr('عرض التفاصيل','View details')}</summary><p>${esc(note)}</p></details>`:''}</div></li>`;
    }).join('')}</ol></section>`;
  }
  function badge(c){const stage=c.lifecycleStage||c.workflow?.stage||'review';return `<button type="button" class="cf-badge ${c.overdue?'is-overdue':''} ${stage==='closed'?'is-closed':''}" onclick="event.stopPropagation();ComplaintFlow.open(this.dataset.id)" data-id="${esc(c._id)}">${esc(stage==='closed'?outcomes()[c.workflow?.outcome]||stages().closed:stages()[stage]||stage)}${c.overdue?' · '+tr('متأخرة','Overdue'):''}</button>`;}
  const menu=c=>`<button type="button" class="btn btn-outline btn-sm" data-id="${esc(c._id)}" onclick="event.stopPropagation();ComplaintFlow.open(this.dataset.id)">${tr('فتح الملف','Open case')}</button>`;
  function chooseTicket(invoiceId){
    const tx=(transactions||[]).find(t=>t._id===invoiceId);if(!tx)return;
    show(tr('خدمة العميل','Customer care'),'#'+tx.ref+' · '+tx.client,`<section class="cf-card"><h3>${tr('ما الإجراء المطلوب؟','What would you like to do?')}</h3><p>${tr('سجّل مشكلة العميل وتابع حلها، أو افتح متابعة أو طلب استرجاع مباشر.','Track a customer issue through resolution, or create a follow-up or a direct return request.')}</p><div class="cf-actions"><button class="btn btn-primary" data-cf-new>${tr('شكوى جديدة','New complaint')}</button><button class="btn btn-outline" data-cf-followup>${tr('متابعة عميل','Customer follow-up')}</button><button class="btn btn-outline" data-cf-return>${tr('طلب استرجاع / استبدال','Return / exchange request')}</button></div></section>`);
    el('[data-cf-new]').onclick=()=>create(invoiceId);
    el('[data-cf-followup]').onclick=()=>{dialog.close();openAddTicketModal(invoiceId,true);document.getElementById('tkt-type').value='followup';_tktTypeChanged();};
    el('[data-cf-return]').onclick=()=>{dialog.close();AfterSales.create(invoiceId);};
    el('[data-cf-return]').hidden=!canExecute();
  }
  function next(row){
    const w=row.workflow||{},e=row.execution||{};
    if(w.stage==='closed')return ['reopen',tr('إعادة فتح بسبب جديد','Reopen with a reason')];
    if(w.stage==='waiting')return ['resume',tr('استئناف المتابعة','Resume follow-up')];
    if(e.ready)return [admin()?'close':'contact',tr('تأكيد الحل وإغلاق الشكوى','Confirm resolution')];
    if(w.caseId)return ['case',tr('متابعة طلب التنفيذ','Open execution case')];
    if(['exchange','return'].includes(w.solution))return canExecute()?['create-case',tr('إنشاء طلب التنفيذ المرتبط','Create linked execution case')]:['contact',tr('متابعة اعتماد التنفيذ مع المسؤول','Follow up execution with the manager')];
    if(['compensation','refund_without_return'].includes(w.solution))return admin()?['payment',tr('تسجيل دفع مستحق العميل','Record customer payment')]:['contact',tr('متابعة الدفع مع المسؤول','Follow up payment with the manager')];
    if(w.solution)return ['fulfill',tr('توثيق الحل المنفذ','Document resolution')];
    return [admin()?'plan':'contact',admin()?tr('اختيار خطة الحل','Choose resolution plan'):tr('تسجيل تواصل العميل','Record customer contact')];
  }
  async function open(id,messageEvent='',savedRow=null){
    checkOwner();
    const cached=savedRow||details.get(String(id))?.row||(complaints||[]).find(c=>String(c._id)===String(id));
    if(cached){active=cached;render(cached);}
    else show(tr('ملف الشكوى','Complaint workspace'),'',`<p role="status">${tr('جارٍ تحميل الملف…','Loading complaint…')}</p>`);
    const version=serial;
    if(savedRow?.execution){void loadCustomerMessage(savedRow,messageEvent);return;}
    const body=el('.cf-body');body.setAttribute('aria-busy','true');
    const status=document.createElement('div');status.className='cf-refresh-status';status.setAttribute('role','status');status.textContent=tr('جارٍ تحديث بيانات الملف…','Updating case details…');el('.cf-head>div').appendChild(status);
    try{
      const row=await readDetail(id,true,messageEvent);if(version!==serial||!dialog.open)return;
      const scrollTop=body.scrollTop;active=row;render(row);el('.cf-body').scrollTop=scrollTop;void loadCustomerMessage(row,messageEvent);
    }catch(e){if(version===serial&&dialog.open){error(e);const box=el('[data-cf-error]');const retry=document.createElement('button');retry.type='button';retry.className='btn btn-outline';retry.textContent=tr('إعادة المحاولة','Retry');retry.onclick=()=>open(id,messageEvent);box.appendChild(retry);}}
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
  function render(row){
    const w=row.workflow||{},e=row.execution||{},stage=row.lifecycleStage||w.stage||'review',n=next(row),closed=w.stage==='closed';
    const stageOrder=['review','planned','execution','confirmation','closed'],position=stageOrder.indexOf(stage==='blocked'?'execution':stage==='waiting'?'review':stage);
    show(row.complaintNo,row.clientName||tr('ملف خدمة العملاء','Customer care'),`
      <section class="cf-card cf-customer-message" data-cf-message-card><h3 data-cf-message-title>${tr('رسالة جاهزة للعميل','Message ready for the customer')}</h3><label class="cf-field">${tr('راجع النص ثم انسخه وأرسله للعميل','Review, copy and send to the customer')}<textarea rows="5" readonly data-cf-message-text>${tr('جارٍ تجهيز الرسالة…','Preparing message…')}</textarea></label><div class="cf-actions"><button type="button" class="btn btn-primary" data-cf-message disabled>${tr('نسخ الرسالة للعميل','Copy message for customer')}</button>${admin()?`<button type="button" class="btn btn-outline" data-cf-templates>${tr('تعديل قوالب الرسائل','Edit message templates')}</button>`:''}</div><small class="cf-muted">${tr('النسخ لا يرسل الرسالة تلقائيًا.','Copying does not send the message automatically.')}</small></section>
      <ol class="cf-steps">${stageOrder.map((s,i)=>`<li class="${i<=position?'is-done':''} ${i===position?'is-current':''}" ${i===position?'aria-current="step"':''}>${esc(({review:tr('المراجعة','Review'),planned:tr('الخطة','Plan'),execution:tr('التنفيذ','Execute'),confirmation:tr('التأكيد','Confirm'),closed:tr('الإغلاق','Close')})[s])}</li>`).join('')}</ol>
      ${w.legacy?`<div class="cf-notice">${tr('سجل سابق: راجع القرار والقطع واربط أي تنفيذ موجود قبل بدء إجراء جديد.','Legacy record: review the decision and items; link existing execution before creating a new case.')}</div>`:''}
      ${w.reviewRequired?`<div class="cf-notice">${tr('يوجد اعتراض أو تقييم منخفض يحتاج مراجعة المسؤول.','A dispute or low rating needs owner review.')}</div>`:''}
      ${w.deletingAt?`<div class="cf-notice">${admin()?tr('بدأ الحذف النهائي لهذه المشكلة. استخدم زر «حذف نهائي» لاستكماله.','Permanent deletion has started. Use Delete permanently to complete it.'):tr('هذه المشكلة قيد الحذف النهائي بواسطة المدير.','This issue is being permanently deleted by an administrator.')}</div>`:''}
      <div class="cf-grid"><main><section class="cf-card cf-next"><h3>${esc(closed?outcomes()[w.outcome]||stages().closed:stages()[stage])}</h3><p>${esc(closed?w.closureNote:stage==='waiting'?w.waitReason:e.ready?tr('اكتملت أدلة التنفيذ. تواصل مع العميل لتأكيد انتهاء المشكلة.','Execution evidence is complete. Confirm with the customer that the issue is resolved.'):!w.solution?tr('راجع المشكلة وحدد الحل المناسب مع العميل.','Review the issue and agree a resolution with the customer.'):(e.blockers||[]).map(b=>blockers()[b]||b).join(' · '))}</p>${!closed||admin()?button(n[0],n[1],true):''}</section>
      <section class="cf-card cf-problem"><h3>${tr('المشكلة والقطع المتضررة','Issue and affected items')}</h3><p>${esc(row.description)}</p>${(row.items||[]).map(i=>`<div class="cf-item"><span>•</span><span>${esc(i.name||i.code)}<small>${esc(i.code)}</small></span><bdi>${i.qty}</bdi></div>`).join('')}${row.imageUrl&&/^https?:\/\//i.test(row.imageUrl)?`<a href="${esc(row.imageUrl)}" target="_blank" rel="noopener">${tr('عرض صورة المشكلة','View issue image')}</a>`:''}</section>
      <section class="cf-card cf-evidence"><h3>${tr('صور وإثباتات المشكلة','Images and evidence')}</h3><div class="cf-images">${(row.attachments||[]).map(a=>`<div class="cf-evidence-item"><button type="button" class="cf-link" data-cf-image="${esc(a.id)}" title="${esc(a.name)}"><img alt="${esc(a.name)}" loading="lazy"></button><button type="button" class="cf-evidence-remove" data-cf-remove-image="${esc(a.id)}" aria-label="${esc(tr('حذف الصورة: ','Delete image: ')+a.name)}">${tr('حذف','Delete')}</button></div>`).join('')}</div>${uploadControls((row.attachments||[]).length)}</section>
      ${timeline(row)}</main>
      <aside><section class="cf-card cf-context"><h3>${tr('المتابعة','Follow-up')}</h3><dl><dt>${tr('المسؤول','Owner')}</dt><dd>${esc(w.owner||row.submittedBy)}</dd><dt>${tr('الموعد','Due')}</dt><dd>${esc(time(w.dueAt))}${row.overdue?' · '+tr('متأخرة','Overdue'):''}</dd><dt>${tr('التواصل','Phone')}</dt><dd><bdi>${esc(row.phone||'—')}</bdi></dd><dt>${tr('الفاتورة','Invoice')}</dt><dd>${row.transactionId?`<button class="cf-link" data-cf-invoice="${esc(row.transactionId)}"><bdi>#${esc(row.transactionRef)}</bdi></button>`:'—'}</dd><dt>${tr('الحل','Solution')}</dt><dd>${esc(solutions()[w.solution]||'—')}</dd><dt>${tr('دورة المعالجة','Resolution cycle')}</dt><dd>${w.cycle||1}</dd></dl></section>
      ${w.caseId?`<section class="cf-card cf-linked"><h3>${tr('التنفيذ المرتبط','Linked execution')}</h3><button class="cf-link" data-cf-action="case"><bdi>${esc(w.caseRef||e.caseRef)}</bdi></button><p>${esc(e.trackingNumber||'')} ${esc(e.carrierStatus||'')}</p>${e.financialPending&&e.ready?`<small>${tr('اكتمل حل العميل؛ تسوية الناقل الداخلية ما زالت مفتوحة.','Customer resolution is complete; internal carrier settlement remains open.')}</small>`:''}</section>`:''}
      ${w.payment?`<section class="cf-card"><h3>${tr('إثبات الدفع','Payment evidence')}</h3><dl><dt>${tr('المبلغ','Amount')}</dt><dd><bdi>${Number(w.payment.amount).toFixed(2)}</bdi></dd><dt>${tr('الحساب','Account')}</dt><dd>${esc(w.payment.method)}</dd><dt>${tr('المرجع','Reference')}</dt><dd>${esc(w.payment.reference)}</dd><dt>${tr('تم بواسطة','Recorded by')}</dt><dd>${esc(w.payment.by)} · ${esc(time(w.payment.at))}</dd></dl></section>`:''}
      ${w.cycles?.length?`<section class="cf-card"><h3>${tr('المعالجات السابقة','Previous resolution cycles')}</h3>${w.cycles.map(c=>`<p><strong>${tr('الدورة','Cycle')} ${c.cycle} · ${esc(outcomes()[c.outcome]||'')}</strong><br>${esc(solutions()[c.solution]||'')} · ${esc(time(c.closedAt))}<br>${esc(c.closureNote||'')}${c.caseId?`<br><button type="button" class="cf-link" data-cf-previous="${esc(c.caseId)}">${tr('طلب التنفيذ السابق','Previous execution case')}</button>`:''}${c.payment?`<br>${tr('دفعة سابقة','Previous payment')}: <bdi>${Number(c.payment.amount).toFixed(2)}</bdi> · ${esc(c.payment.reference)}`:''}</p>`).join('')}</section>`:''}
      ${row.surveySlug&&closed?`<section class="cf-card"><h3>${tr('تقييم العميل','Customer feedback')}</h3>${row.surveyRating?`<p>${row.surveyRating} / 5</p><p>${esc(row.surveyComment)}</p>`:`<button class="btn btn-outline" data-cf-copy>${tr('نسخ رابط التقييم','Copy feedback link')}</button>`}</section>`:''}
      ${actionPanel(row)}</aside></div>`);
    dialog.querySelectorAll('[data-cf-action]').forEach(b=>b.onclick=()=>act(row,b.dataset.cfAction));
    const guideActions=new Map([...dialog.querySelectorAll('.cf-next [data-cf-action],.cf-action-panel [data-cf-action]')].map(button=>[button.dataset.cfAction,button.textContent]));
    el('#cf-actions-guide').innerHTML=[...guideActions].map(([key,label])=>`<div><dt>${esc(label)}</dt><dd>${esc(actionHelp()[key]||'')}</dd></div>`).join('');
    const closeHelp=()=>{dialog.querySelectorAll('[data-cf-help][aria-expanded=true]').forEach(button=>{button.setAttribute('aria-expanded','false');el('#'+button.dataset.cfHelp).hidden=true;});};
    dialog.querySelectorAll('[data-cf-help]').forEach(button=>button.onclick=()=>{
      if(busy)return;const expanded=button.getAttribute('aria-expanded')==='true';closeHelp();
      if(!expanded){button.setAttribute('aria-expanded','true');el('#'+button.dataset.cfHelp).hidden=false;}
    });
    dialog.onkeydown=event=>{
      if(event.key!=='Escape')return;
      const expanded=el('[data-cf-help][aria-expanded=true]');
      if(expanded){event.preventDefault();event.stopPropagation();closeHelp();expanded.focus();}
    };
    dialog.querySelectorAll('[data-cf-previous]').forEach(b=>b.onclick=()=>visitExecution(row,b.dataset.cfPrevious));
    el('[data-cf-invoice]')?.addEventListener('click',()=>{dialog.close();showInvoiceDetail(row.transactionId);});
    el('[data-cf-copy]')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.origin+'/s/'+row.surveySlug);toast(tr('تم نسخ الرابط','Link copied'));}catch(e){error(e);}});
    async function loadImage(button){
      const key=`${me()}:${row._id}:${button.dataset.cfImage}`;
      try{
        if(!images.has(key)){images.set(key,api(`/complaints/${row._id}/evidence/${button.dataset.cfImage}`,{background:true}));if(images.size>30)images.delete(images.keys().next().value);}
        const result=await images.get(key);if(!button.isConnected)return;
        button.querySelector('img').src=result.data;button.onclick=()=>{if(busy)return;show(tr('إثبات الشكوى','Complaint evidence'),row.complaintNo,`<img src="${esc(result.data)}" style="max-width:100%;display:block;margin:auto" alt="${esc(button.title)}"><div class="cf-foot"><button class="btn btn-outline" data-cf-back>${tr('رجوع','Back')}</button></div>`);el('[data-cf-back]').onclick=()=>open(row._id);};
      }catch{images.delete(key);if(button.isConnected)button.textContent=tr('تعذر تحميل الصورة','Image unavailable');}
    }
    imageObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){imageObserver.unobserve(entry.target);void loadImage(entry.target);}},{root:el('.cf-body'),rootMargin:'100px'});
    dialog.querySelectorAll('[data-cf-image]').forEach(button=>imageObserver.observe(button));
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
    dialog.querySelectorAll('[data-cf-remove-image]').forEach(button=>button.onclick=async()=>{
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
        serial++;active=null;dialog.close();
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
      show(actionNames()[action]||(action==='comment'?tr('ملاحظة داخلية','Internal note'):tr('إجراء الشكوى','Complaint action')),row.complaintNo,`${pending?`<div class="cf-notice">${tr('هناك محاولة لم يتأكد حفظها. إعادة المحاولة تستخدم نفس البيانات لمنع التكرار.','An earlier attempt is unconfirmed. Retrying uses the same data to avoid duplication.')}</div>`:''}${extraNotice?`<div class="cf-notice">${esc(extraNotice)}</div>`:''}<form data-cf-form>${fields}${action==='close'?note(tr('سبب الإغلاق والتفاصيل','Closure reason and details'),true):action==='comment'?note(tr('نص الملاحظة','Note text'),true):note()}<div class="cf-foot"><button type="button" class="btn btn-outline" data-cf-back>${tr('رجوع','Back')}</button><button class="btn btn-primary" type="submit">${action==='close'?tr('إغلاق الشكوى','Close complaint'):tr('حفظ الإجراء','Save action')}</button></div></form>`);
      dialog.dataset.cfFormAction=action;
      const f=el('form');el('[data-cf-back]').onclick=()=>open(id);
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
      f.onsubmit=async event=>{event.preventDefault();if(busy)return;buttonsDisabled(true);const view=serial;try{const values=Object.fromEntries(new FormData(f));for(const name of ['confirmed','customerConfirmed'])if(f.elements[name])values[name]=f.elements[name].checked;if(values.amount)values.amount=Number(values.amount);else delete values.amount;if(values.dueAt)values.dueAt=cairoDate(values.dueAt);const result=await mutate(row,action,values);await refresh(result);if(view===serial&&dialog.open)await open(id,'',result);}catch(e){if(view===serial)error(e);}finally{buttonsDisabled(false);}};
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
    show(edit?tr('الفاتورة والقطع المتضررة','Invoice and affected items'):tr('شكوى جديدة','New complaint'),tr('ملف واحد لكل مشكلة · متابعة حتى الإغلاق','One issue, one case · tracked through closure'),`<form data-cf-create><fieldset class="cf-create-details" data-cf-create-details>
      <section class="cf-card"><h3>${tr('الفاتورة','Invoice')}</h3><div class="cf-order-search"><label class="cf-search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input class="cf-search" name="orderSearch" aria-label="${tr('البحث عن فاتورة','Search invoices')}" aria-controls="cf-search-results" placeholder="${tr('ابحث برقم الفاتورة أو الاسم أو الهاتف','Search invoice, name or phone')}" autocomplete="off"></label><div class="cf-search-results" id="cf-search-results" data-cf-results hidden></div><small class="cf-search-hint" data-cf-search-hint role="status"></small></div><div data-cf-selected></div><div data-cf-items></div><div data-cf-duplicates></div></section>
      ${!edit?`<div class="cf-two">${field('clientName',tr('اسم العميل','Customer name'),'text',draft.clientName||'','required')}${field('phone',tr('رقم التواصل','Phone'),'tel',draft.phone||'','required')}</div><div class="cf-two">${select('categoryGroup',tr('نوع المشكلة','Issue category'),{'':tr('اختر','Choose'),...Object.fromEntries(Object.keys(CMP_CATEGORIES).map(k=>[k,_cmpCategoryLabel(k)]))},draft.categoryGroup)}${select('priority',tr('الأولوية','Priority'),{'متوسطة':tr('متوسطة','Medium'),'عالية':tr('عالية','High'),'منخفضة':tr('منخفضة','Low')},draft.priority||'متوسطة')}</div><label class="cf-field">${tr('وصف المشكلة والنتيجة المطلوبة','Issue and desired outcome')}<textarea name="description" required maxlength="5000">${esc(draft.description||'')}</textarea></label>`:''}
      </fieldset>${!edit?`<section class="cf-card cf-evidence"><h3>${tr('صور المشكلة · اختياري','Issue images · optional')}</h3><div class="cf-images" data-cf-draft-images></div>${uploadControls()}<small class="cf-muted" data-cf-draft-upload-hint>${tr('تُرفع الصور عند تسجيل المشكلة.','Images will be uploaded when you save the issue.')}</small></section>`:''}
      <div class="cf-foot"><button type="button" class="btn btn-outline" data-cf-back>${edit?tr('رجوع','Back'):tr('حفظ مسودة وإغلاق','Save draft & close')}</button>${!edit?`<button type="button" class="btn btn-outline" data-cf-discard>${tr('مسح المسودة','Discard draft')}</button>`:''}<button type="submit" class="btn btn-primary">${edit?tr('حفظ البنود','Save items'):tr('تسجيل الشكوى','Create complaint')}</button></div></form>`);
    const f=el('form');let selected=tx;
    function saveDraft(){if(edit)return;if(!draft.createdId){const values=Object.fromEntries(new FormData(f));delete values.orderSearch;Object.assign(draft,values);delete draft.imageUrl;draft.items=readItems();draft.transactionId=selected?._id||'';}sessionStorage.setItem(draftKey(),JSON.stringify(draft));}
    function readItems(){return [...f.querySelectorAll('[data-cf-line]')].filter(r=>r.querySelector('[type=checkbox]').checked).map(r=>({lineIndex:Number(r.dataset.cfLine),qty:Number(r.querySelector('[type=number]').value)}));}
    function drawDraftImages(){
      if(edit||!f.isConnected)return;
      const host=f.querySelector('[data-cf-draft-images]');
      host.innerHTML=draftImages.map(item=>`<div class="cf-evidence-item"><img class="cf-draft-image" src="${esc(item.url)}" alt="${esc(item.file.name)}"><button type="button" class="cf-evidence-remove" data-cf-remove-draft-image="${esc(item.id)}" aria-label="${esc(tr('إزالة الصورة: ','Remove image: ')+item.file.name)}" ${busy?'disabled':''}>${tr('إزالة','Remove')}</button></div>`).join('');
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
      f.querySelector('[data-cf-draft-upload-hint]').textContent=tr('تم تسجيل المشكلة. أكمل رفع الصور المتبقية أو تخطّها لفتح المشكلة.','The issue is saved. Upload the remaining images or skip them to open the issue.');
      f.querySelector('button[type=submit]').textContent=tr('إكمال رفع الصور','Continue uploading images');
      f.querySelector('[data-cf-back]').textContent=tr('إكمال لاحقًا','Continue later');
      f.querySelector('[data-cf-discard]').textContent=tr('تخطي الصور المتبقية','Skip remaining images');
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
      el('[data-cf-items]').innerHTML=(selected?.items||[]).map((i,index)=>{const picked=draft.items?.find(v=>v.lineIndex===index);return `<div class="cf-item cf-product-item" data-cf-line="${index}"><label class="cf-product-choice"><input type="checkbox" ${picked?'checked':''}>${productImage(i)}<span class="cf-product-info"><strong>${esc(i.name||i.code)}</strong>${i.code?`<small><bdi>${esc(i.code)}</bdi></small>`:''}<small>${tr('الكمية بالفاتورة','Invoice quantity')}: ${esc(i.qty)}</small></span></label><label class="cf-item-quantity"><span>${tr('الكمية المتضررة','Affected quantity')}</span><input type="number" min="1" max="${esc(i.qty)}" step="1" value="${esc(picked?.qty||1)}" aria-label="${tr('الكمية المتضررة','Affected quantity')} ${esc(i.name||i.code)}"></label></div>`;}).join('');
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
    el('[data-cf-back]').onclick=()=>{saveDraft();edit?open(edit._id):dialog.close();};
    el('[data-cf-discard]')?.addEventListener('click',async()=>{
      if(busy)return;buttonsDisabled(true);const view=serial;
      try{const id=draft.createdId;sessionStorage.removeItem(draftKey());createDraft=null;await clearDraftImages();if(view===serial){if(id)await open(id);else dialog.close();}}
      finally{buttonsDisabled(false);}
    });
    f.onsubmit=async event=>{event.preventDefault();if(busy)return;saveDraft();buttonsDisabled(true);f.querySelector('[data-cf-create-details]').disabled=true;try{
      let result;
      if(edit)result=await mutate(edit,'items',{transactionId:selected?._id,items:readItems()});
      else{
        validateImages(draftImages.map(item=>item.file),draft.savedImageCount||0);
        if(draft.createdId)result=await api(`/complaints/${draft.createdId}`,{background:true});
        else{
          const body={...draft,items:readItems()};delete body.orderSearch;delete body.imageUrl;delete body.createdId;delete body.savedImageCount;if(!body.transactionId)delete body.transactionId;
          result=await api('/complaints',{method:'POST',body:JSON.stringify(body)});
          draft.createdId=result._id;saveDraft();showCreatedState();
        }
        draft.savedImageCount=(result.attachments||[]).length;saveDraft();
        await refresh(result);
        const total=draftImages.length;let uploaded=0;
        while(draftImages.length){
          const item=draftImages[0],data=new FormData();data.append('file',item.file);
          f.querySelector('[data-cf-upload-status]').textContent=tr(`جارٍ رفع الصورة ${uploaded+1} من ${total}…`,`Uploading image ${uploaded+1} of ${total}…`);
          result=await api(`/complaints/${draft.createdId}/evidence`,{method:'POST',body:data});
          URL.revokeObjectURL(item.url);draftImages.shift();uploaded++;
          draft.savedImageCount=(result.attachments||[]).length;saveDraft();await persistDraftImages();drawDraftImages();await refresh(result);
        }
        sessionStorage.removeItem(draftKey());createDraft=null;await clearDraftImages();
      }
      await refresh(result);await open(result._id,edit?'':'registered',result);
    }catch(e){
      if(!edit&&draft.createdId){showCreatedState();f.querySelector('[data-cf-upload-status]').textContent=tr('لم يكتمل رفع الصور. أعد المحاولة؛ المشكلة مسجلة بالفعل.','Image upload is incomplete. Retry; the issue is already saved.');}
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
  function searchText(c){return [c.complaintNo,c.clientName,c.phone,c.transactionRef,c.description,c.categoryGroup,c.category,owner(c),c.submittedBy,c.workflow?.caseRef,solutions()[c.workflow?.solution],stages()[stageOf(c)],...(c.items||[]).flatMap(i=>[i.name,i.code])].join(' ').toLowerCase();}
  function tableHead(){return [tr('ملف الشكوى','Complaint'),tr('العميل والتواصل','Customer / phone'),tr('الفاتورة والشحن','Invoice / shipping'),tr('المشكلة والمنتجات','Issue / products'),tr('مرحلة المعالجة','Workflow stage'),tr('الحل والتنفيذ','Resolution / execution'),tr('الأولوية','Priority'),tr('المسؤول الحالي','Current owner'),tr('موعد المتابعة','Follow-up due'),tr('الإجراءات','Actions')].map(label=>`<th scope="col">${esc(label)}</th>`).join('');}
  function issueSummary(c){
    const items=c.items?.length?c.items:c.productName?[{name:c.productName,qty:c.productQty||1}]:[];
    const category=typeof _cmpCategoryLabel==='function'?_cmpCategoryLabel(c.categoryGroup):c.categoryGroup;
    return `<div class="cf-cell-stack"><strong>${esc(category||tr('غير محدد','Unspecified'))}</strong><span class="cf-cell-clamp" title="${esc(c.description)}">${esc(c.description||'—')}</span>${items.length?`<small class="cf-cell-clamp" title="${esc(items.map(i=>`${i.name||i.code} × ${i.qty}`).join(' · '))}">${esc(items.map(i=>`${i.name||i.code} × ${i.qty}`).join(' · '))}</small>`:''}${c.attachments?.length?`<small>${tr('صور الإثبات','Evidence images')}: ${c.attachments.length}</small>`:''}</div>`;
  }
  function stageCell(c){const w=c.workflow||{},e=c.execution||{};return `<div class="cf-cell-stack">${badge(c)}${w.reviewRequired?`<small class="cf-due-overdue">${tr('تحتاج مراجعة المسؤول','Owner review needed')}</small>`:''}${w.stage!=='closed'&&w.stage!=='waiting'&&w.solution&&e.blockers?.length?`<small class="cf-cell-clamp">${esc(e.blockers.map(b=>blockers()[b]||b).join(' · '))}</small>`:''}${w.stage==='waiting'&&w.waitReason?`<small class="cf-cell-clamp" title="${esc(w.waitReason)}">${esc(w.waitReason)}</small>`:''}</div>`;}
  function solutionCell(c){const w=c.workflow||{};return `<div class="cf-cell-stack"><span>${esc(solutions()[w.solution]||tr('لم يُحدد الحل','Not planned'))}</span>${w.caseId?`<button type="button" class="cf-link" data-id="${esc(c._id)}" onclick="event.stopPropagation();ComplaintFlow.execution(this.dataset.id)"><bdi>${esc(w.caseRef||c.execution?.caseRef||tr('طلب التنفيذ','Execution case'))}</bdi></button>`:''}${w.stage==='closed'?`<small>${esc(outcomes()[w.outcome]||'')}</small>`:''}</div>`;}
  function dueCell(c){const w=c.workflow||{};return w.stage==='closed'?`<div class="cf-cell-stack"><span>${tr('أُغلقت','Closed')}</span><small>${esc(time(w.closedAt||c.resolvedAt))}</small></div>`:`<div class="cf-cell-stack ${c.overdue?'cf-due-overdue':''}"><span>${esc(w.dueAt?time(w.dueAt):tr('غير محدد','Not scheduled'))}</span>${c.overdue?`<small>${tr('متأخرة','Overdue')}</small>`:''}</div>`;}
  function invoiceCell(c){const tx=invoiceIndex.get(String(c.transactionId));return `<div class="cf-cell-stack">${cmpOrderRefCell(c)}${tx?shippingStatus(tx):`<small>${tr(c.transactionId?'حالة الشحن غير متاحة':'بدون فاتورة',c.transactionId?'Shipping status unavailable':'No invoice')}</small>`}</div>`;}
  function tableRow(c){return `<tr data-complaint-id="${esc(c._id)}" data-id="${esc(c._id)}" onclick="ComplaintFlow.open(this.dataset.id)">
    <td><div class="cf-cell-stack">${cmpNoBadge(c)}<small>${esc(time(c.createdAt))}</small></div></td>
    <td><div class="cf-cell-stack"><strong>${esc(c.clientName||'—')}</strong><small><bdi>${esc(c.phone||'—')}</bdi></small></div></td>
    <td>${invoiceCell(c)}</td><td>${issueSummary(c)}</td><td>${stageCell(c)}</td><td>${solutionCell(c)}</td><td>${cmpPriorityBadge(c)}</td>
    <td><div class="cf-cell-stack"><span>${esc(owner(c)||tr('غير معيّن','Unassigned'))}</span>${c.submittedBy&&c.submittedBy!==owner(c)?`<small>${tr('أنشأها','Created by')}: ${esc(c.submittedBy)}</small>`:''}</div></td><td>${dueCell(c)}</td><td>${menu(c)}</td></tr>`;}
  function listCard(c){return `<article class="cmp-list-card cf-list-card" data-complaint-id="${esc(c._id)}">
    <div class="cf-list-heading">${cmpNoBadge(c)}${cmpPriorityBadge(c)}</div>
    <div class="cf-cell-stack"><strong>${esc(c.clientName||'—')}</strong><small><bdi>${esc(c.phone||'—')}</bdi> · ${esc(time(c.createdAt))}</small></div>
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
  function mount(){
    const host=document.getElementById('cmp-complaints-section');if(!host)return;
    invoiceIndex=new Map((transactions||[]).map(tx=>[String(tx._id),tx]));
    const table=host.querySelector('#cmp-table');if(table){table.dataset.cfTable='';table.querySelector('thead tr').innerHTML=tableHead();}
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
    const rows=complaints||[],open=rows.filter(c=>c.workflow?.stage!=='closed'),due=rows.filter(c=>c.overdue),ready=rows.filter(c=>c.execution?.ready&&c.workflow?.stage!=='closed');
    let counts=host.querySelector('[data-cf-counts]');
    if(!counts){counts=document.createElement('div');counts.className='cf-muted cf-queue-counts';counts.dataset.cfCounts='';counts.setAttribute('aria-live','polite');host.prepend(counts);}
    counts.textContent=tr(`مفتوحة ${open.length} · متأخرة ${due.length} · بانتظار التأكيد ${ready.length}`,`Open ${open.length} · Overdue ${due.length} · Awaiting confirmation ${ready.length}`);
  }
  function changed(){
    clearTimeout(changeTimer);changeTimer=setTimeout(async()=>{
      if(busy||changeTask){changed();return;}
      if(!admin()&&typeof hasPerm==='function'&&!hasPerm('complaints')&&!hasPerm('transaction'))return;
      details.clear();reads.clear();const view=serial,id=dialog?.open&&el('.cf-grid')?active?._id:null;
      changeTask=(async()=>{try{await refresh();if(id&&view===serial&&dialog?.open)await open(id);}catch{}finally{changeTask=null;}})();await changeTask;
    },200);
  }
  window.ComplaintFlow={open,resume,execution,form,create,chooseTicket,badge,menu,matches,mount,changed,tableRow,listCard,searchText,owner,pageRows};
})();
