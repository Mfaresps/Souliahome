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
  const actionNames=()=>({assign:tr('تحديد المسؤول','Owner assigned'),review:tr('بدء المراجعة','Review started'),plan:tr('تحديد خطة الحل','Resolution planned'),case_linked:tr('ربط طلب التنفيذ','Execution linked'),link:tr('ربط طلب التنفيذ','Execution linked'),unlink:tr('مراجعة طلب ملغى','Cancelled case reviewed'),wait:tr('تحديد انتظار ومتابعة','Follow-up scheduled'),resume:tr('استئناف المعالجة','Processing resumed'),fulfill:tr('توثيق تنفيذ الحل','Resolution documented'),payment:tr('دفع مستحق العميل','Customer payment recorded'),contact:tr('تواصل مع العميل','Customer contact'),close:tr('إغلاق الشكوى','Complaint closed'),reopen:tr('إعادة فتح الشكوى','Complaint reopened'),archive:tr('أرشفة الشكوى','Complaint archived'),items:tr('تحديد البنود والكميات','Items selected'),negative_rating:tr('تقييم يحتاج مراجعة','Rating needs review')});
  let dialog,active,serial=0,busy=false,queue='active',lastFocus,createDraft=null,draftOwner='';
  const el=s=>dialog?.querySelector(s);
  function show(title,subtitle,html){
    if(!dialog){dialog=document.createElement('dialog');dialog.className='cf-dialog';document.body.appendChild(dialog);dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});dialog.addEventListener('close',()=>lastFocus?.isConnected&&lastFocus.focus());}
    if(!dialog.open)lastFocus=document.activeElement;
    dialog.dir=tr('rtl','ltr');dialog.setAttribute('aria-labelledby','cf-title');
    dialog.innerHTML=`<div class="cf-shell"><header class="cf-head"><div><small>${esc(subtitle)}</small><h2 id="cf-title">${esc(title)}</h2></div><button type="button" class="btn btn-outline" data-cf-dismiss aria-label="${tr('إغلاق','Close')}">×</button></header><div class="cf-body"><div class="cf-error" role="alert" data-cf-error></div>${html}</div></div>`;
    el('[data-cf-dismiss]').onclick=()=>{if(!busy)dialog.close();};if(!dialog.open)dialog.showModal();return ++serial;
  }
  const error=e=>{if(el('[data-cf-error]')){el('[data-cf-error]').textContent=e.message||String(e);el('[data-cf-error]').scrollIntoView({block:'nearest'});}else toast(e.message||String(e),true);};
  function buttonsDisabled(value){busy=value;dialog?.querySelectorAll('button').forEach(b=>{if(value){b.dataset.wasDisabled=String(b.disabled);b.disabled=true;}else{b.disabled=b.dataset.wasDisabled==='true';delete b.dataset.wasDisabled;}});}
  async function refresh(){if(typeof loadComplaints==='function')await loadComplaints();if(typeof buildNotifications==='function')buildNotifications();if(typeof buildSidebar==='function')buildSidebar();}
  async function mutate(row,action,fields){
    const storage=`complaint-operation:${me()}:${row._id}:${action}`;
    let pending;try{pending=JSON.parse(sessionStorage.getItem(storage)||'null');}catch{}
    if(!pending){pending={action,...fields,expectedRevision:row.workflow?.revision||0,operationKey:uid()};sessionStorage.setItem(storage,JSON.stringify(pending));}
    try{const result=await api(`/complaints/${row._id}/workflow`,{method:'POST',body:JSON.stringify(pending)});sessionStorage.removeItem(storage);return result;}
    catch(e){if(e.status>=400&&e.status<500&&![408,429].includes(e.status))sessionStorage.removeItem(storage);throw e;}
  }
  const field=(name,label,type='text',value='',extra='')=>`<label class="cf-field">${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const select=(name,label,values,value='')=>`<label class="cf-field">${esc(label)}<select name="${name}">${Object.entries(values).map(([key,text])=>`<option value="${esc(key)}" ${key===value?'selected':''}>${esc(text)}</option>`).join('')}</select></label>`;
  const note=(label=tr('التفاصيل وسبب الإجراء','Details and reason'))=>`<label class="cf-field">${esc(label)}<textarea name="note" required maxlength="2000"></textarea></label>`;
  const confirm=(name,label)=>`<label class="cf-check"><input name="${name}" type="checkbox">${esc(label)}</label>`;
  function cairoInput(date){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;}
  function cairoDate(value){let guess=Date.parse(value+'Z');for(let i=0;i<3;i++)guess+=Date.parse(value+'Z')-Date.parse(cairoInput(new Date(guess))+'Z');if(cairoInput(new Date(guess))!==value)throw new Error(tr('موعد غير صالح بتوقيت القاهرة','Invalid Cairo date/time'));return new Date(guess).toISOString();}
  const nextDay=()=>cairoInput(new Date(Date.now()+86400000));
  const deadline=()=>field('dueAt',tr('موعد المتابعة القادمة · توقيت القاهرة','Next follow-up · Cairo time'),'datetime-local',nextDay(),'required');
  const button=(key,label,primary=false)=>`<button type="button" class="btn ${primary?'btn-primary':'btn-outline'}" data-cf-action="${key}">${esc(label)}</button>`;
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
  async function open(id,messageEvent=''){
    const version=show(tr('ملف الشكوى','Complaint workspace'),'',`<p>${tr('جارٍ تحميل الملف…','Loading complaint…')}</p>`);
    try{const row=await api('/complaints/'+encodeURIComponent(id));if(version!==serial||!dialog.open)return;active=row;render(row);await loadCustomerMessage(row,messageEvent);}catch(e){error(e);}
  }
  const messageKinds=()=>({registered:tr('تأكيد تسجيل الشكوى','Complaint registered'),update:tr('تحديث متابعة المشكلة','Progress update'),confirmation:tr('طلب تأكيد انتهاء المشكلة','Request resolution confirmation'),resolved:tr('تأكيد حل المشكلة','Resolution completed'),closed:tr('إبلاغ بنتيجة الإغلاق','Closure outcome')});
  async function loadCustomerMessage(row,event=''){
    const card=el('[data-cf-message-card]');if(!card)return;
    const area=card.querySelector('textarea'),copy=card.querySelector('[data-cf-message]');
    copy.dataset.wasDisabled='true';
    copy.onclick=async()=>{try{await navigator.clipboard.writeText(area.value);toast(tr('تم النسخ؛ الرسالة جاهزة لإرسالها للعميل','Copied; ready to send to the customer'));}catch{area.focus();area.select();toast(tr('تعذر النسخ التلقائي؛ النص محدد لتنسخه يدويًا','Clipboard unavailable; select and copy the highlighted text'),true);}};
    card.querySelector('[data-cf-templates]')?.addEventListener('click',()=>editMessageTemplates(row._id,event));
    try{
      const result=await api(`/complaints/${row._id}/customer-message?lang=${tr('ar','en')}&event=${encodeURIComponent(event)}`);
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
    const history=[...(row.notes||[]).map(n=>({at:n.createdAt,by:n.author,note:n.text,action:''})),...(w.history||[]),...(w.executionEvents||[])].sort((a,b)=>String(b.at).localeCompare(String(a.at)));
    const actions=closed?(admin()?button('reopen',tr('إعادة فتح','Reopen'))+button('archive',tr('أرشفة','Archive')):''):
      button('contact',tr('تسجيل تواصل','Log contact'))+button('assign',tr('المسؤول والموعد','Owner & deadline'))+button(w.stage==='waiting'?'resume':'wait',w.stage==='waiting'?tr('استئناف','Resume'):tr('انتظار ومتابعة','Schedule follow-up'))+
      (!w.caseId&&!w.payment&&!w.fulfillment?button('items',tr('الفاتورة والقطع','Invoice & items'))+(admin()?button('plan',tr('خطة الحل','Resolution plan')):''):'')+
      (admin()&&['exchange','return'].includes(w.solution)&&!w.caseId?button('link',tr('ربط طلب موجود','Link existing case')):'')+
      (admin()&&e.blockers?.includes('case_cancelled')?button('unlink',tr('مراجعة الطلب الملغى','Review cancelled case')):'')+
      (admin()?button('close',tr('إغلاق بنتيجة','Close with outcome')):'');
    show(row.complaintNo,row.clientName||tr('ملف خدمة العملاء','Customer care'),`
      <section class="cf-card cf-customer-message" data-cf-message-card><h3 data-cf-message-title>${tr('رسالة جاهزة للعميل','Message ready for the customer')}</h3><label class="cf-field">${tr('راجع النص ثم انسخه وأرسله للعميل','Review, copy and send to the customer')}<textarea rows="5" readonly data-cf-message-text>${tr('جارٍ تجهيز الرسالة…','Preparing message…')}</textarea></label><div class="cf-actions"><button type="button" class="btn btn-primary" data-cf-message disabled>${tr('نسخ الرسالة للعميل','Copy message for customer')}</button>${admin()?`<button type="button" class="btn btn-outline" data-cf-templates>${tr('تعديل قوالب الرسائل','Edit message templates')}</button>`:''}</div><small class="cf-muted">${tr('النسخ لا يرسل الرسالة تلقائيًا.','Copying does not send the message automatically.')}</small></section>
      <ol class="cf-steps">${stageOrder.map((s,i)=>`<li class="${i<=position?'is-done':''} ${i===position?'is-current':''}" ${i===position?'aria-current="step"':''}>${esc(({review:tr('المراجعة','Review'),planned:tr('الخطة','Plan'),execution:tr('التنفيذ','Execute'),confirmation:tr('التأكيد','Confirm'),closed:tr('الإغلاق','Close')})[s])}</li>`).join('')}</ol>
      ${w.legacy?`<div class="cf-notice">${tr('سجل سابق: راجع القرار والقطع واربط أي تنفيذ موجود قبل بدء إجراء جديد.','Legacy record: review the decision and items; link existing execution before creating a new case.')}</div>`:''}
      ${w.reviewRequired?`<div class="cf-notice">${tr('يوجد اعتراض أو تقييم منخفض يحتاج مراجعة المسؤول.','A dispute or low rating needs owner review.')}</div>`:''}
      <div class="cf-grid"><main><section class="cf-card cf-next"><h3>${esc(closed?outcomes()[w.outcome]||stages().closed:stages()[stage])}</h3><p>${esc(closed?w.closureNote:stage==='waiting'?w.waitReason:e.ready?tr('اكتملت أدلة التنفيذ. تواصل مع العميل لتأكيد انتهاء المشكلة.','Execution evidence is complete. Confirm with the customer that the issue is resolved.'):!w.solution?tr('راجع المشكلة وحدد الحل المناسب مع العميل.','Review the issue and agree a resolution with the customer.'):(e.blockers||[]).map(b=>blockers()[b]||b).join(' · '))}</p>${!closed||admin()?button(n[0],n[1],true):''}</section>
      <section class="cf-card cf-problem"><h3>${tr('المشكلة والقطع المتضررة','Issue and affected items')}</h3><p>${esc(row.description)}</p>${(row.items||[]).map(i=>`<div class="cf-item"><span>•</span><span>${esc(i.name||i.code)}<small>${esc(i.code)}</small></span><bdi>${i.qty}</bdi></div>`).join('')}${row.imageUrl&&/^https?:\/\//i.test(row.imageUrl)?`<a href="${esc(row.imageUrl)}" target="_blank" rel="noopener">${tr('عرض صورة المشكلة','View issue image')}</a>`:''}</section>
      <section class="cf-card cf-evidence"><h3>${tr('صور وإثباتات المشكلة','Images and evidence')}</h3><div class="cf-images">${(row.attachments||[]).map(a=>`<button type="button" class="cf-link" data-cf-image="${esc(a.id)}" title="${esc(a.name)}"><img alt="${esc(a.name)}" loading="lazy"></button>`).join('')}</div><label class="cf-field">${tr('إضافة صور · حتى 5 ميجابايت للصورة','Add images · up to 5 MB each')}<input type="file" accept="image/jpeg,image/png,image/webp" multiple data-cf-upload></label></section>
      <section class="cf-card cf-log"><h3>${tr('سجل الشكوى','Complaint history')}</h3><ol class="cf-history">${history.map(h=>`<li><strong>${esc(actionNames()[h.action]||({requested:tr('تسجيل طلب التنفيذ','Execution requested'),approved:tr('اعتماد التنفيذ','Execution approved'),'shipment-created':tr('إنشاء الشحنة','Shipment created'),'carrier-status':tr('تحديث الشحن','Shipping update'),'received-and-inspected':tr('استلام وفحص','Received and inspected'),'replacement-delivered':tr('تسليم البديل','Replacement delivered'),'settlement:refund':tr('رد المبلغ','Refund paid'),'settlement:collection':tr('تحصيل الفرق','Difference collected'),'settlement:carrier':tr('تسوية الناقل','Carrier settled'),attachment:tr('إضافة إثبات','Evidence added')})[h.action]||h.action||tr('ملاحظة','Note'))}</strong> · ${esc(h.by||'')}<time>${esc(time(h.at))}</time>${h.note?`<p>${esc(h.note)}</p>`:''}</li>`).join('')||`<li>${tr('تم تسجيل الشكوى','Complaint registered')}</li>`}</ol></section></main>
      <aside><section class="cf-card cf-context"><h3>${tr('المتابعة','Follow-up')}</h3><dl><dt>${tr('المسؤول','Owner')}</dt><dd>${esc(w.owner||row.submittedBy)}</dd><dt>${tr('الموعد','Due')}</dt><dd>${esc(time(w.dueAt))}${row.overdue?' · '+tr('متأخرة','Overdue'):''}</dd><dt>${tr('التواصل','Phone')}</dt><dd><bdi>${esc(row.phone||'—')}</bdi></dd><dt>${tr('الفاتورة','Invoice')}</dt><dd>${row.transactionId?`<button class="cf-link" data-cf-invoice="${esc(row.transactionId)}"><bdi>#${esc(row.transactionRef)}</bdi></button>`:'—'}</dd><dt>${tr('الحل','Solution')}</dt><dd>${esc(solutions()[w.solution]||'—')}</dd><dt>${tr('دورة المعالجة','Resolution cycle')}</dt><dd>${w.cycle||1}</dd></dl></section>
      ${w.caseId?`<section class="cf-card cf-linked"><h3>${tr('التنفيذ المرتبط','Linked execution')}</h3><button class="cf-link" data-cf-action="case"><bdi>${esc(w.caseRef||e.caseRef)}</bdi></button><p>${esc(e.trackingNumber||'')} ${esc(e.carrierStatus||'')}</p>${e.financialPending&&e.ready?`<small>${tr('اكتمل حل العميل؛ تسوية الناقل الداخلية ما زالت مفتوحة.','Customer resolution is complete; internal carrier settlement remains open.')}</small>`:''}</section>`:''}
      ${w.payment?`<section class="cf-card"><h3>${tr('إثبات الدفع','Payment evidence')}</h3><dl><dt>${tr('المبلغ','Amount')}</dt><dd><bdi>${Number(w.payment.amount).toFixed(2)}</bdi></dd><dt>${tr('الحساب','Account')}</dt><dd>${esc(w.payment.method)}</dd><dt>${tr('المرجع','Reference')}</dt><dd>${esc(w.payment.reference)}</dd><dt>${tr('تم بواسطة','Recorded by')}</dt><dd>${esc(w.payment.by)} · ${esc(time(w.payment.at))}</dd></dl></section>`:''}
      ${w.cycles?.length?`<section class="cf-card"><h3>${tr('المعالجات السابقة','Previous resolution cycles')}</h3>${w.cycles.map(c=>`<p><strong>${tr('الدورة','Cycle')} ${c.cycle} · ${esc(outcomes()[c.outcome]||'')}</strong><br>${esc(solutions()[c.solution]||'')} · ${esc(time(c.closedAt))}<br>${esc(c.closureNote||'')}${c.caseId?`<br><button type="button" class="cf-link" data-cf-previous="${esc(c.caseId)}">${tr('طلب التنفيذ السابق','Previous execution case')}</button>`:''}${c.payment?`<br>${tr('دفعة سابقة','Previous payment')}: <bdi>${Number(c.payment.amount).toFixed(2)}</bdi> · ${esc(c.payment.reference)}`:''}</p>`).join('')}</section>`:''}
      ${row.surveySlug&&closed?`<section class="cf-card"><h3>${tr('تقييم العميل','Customer feedback')}</h3>${row.surveyRating?`<p>${row.surveyRating} / 5</p><p>${esc(row.surveyComment)}</p>`:`<button class="btn btn-outline" data-cf-copy>${tr('نسخ رابط التقييم','Copy feedback link')}</button>`}</section>`:''}
      <section class="cf-card"><h3>${tr('الإجراءات','Actions')}</h3><div class="cf-actions">${actions}${button('comment',tr('ملاحظة داخلية','Internal note'))}</div></section></aside></div>`);
    dialog.querySelectorAll('[data-cf-action]').forEach(b=>b.onclick=()=>act(row,b.dataset.cfAction));
    dialog.querySelectorAll('[data-cf-previous]').forEach(b=>b.onclick=()=>{dialog.close();AfterSales.open(b.dataset.cfPrevious);});
    el('[data-cf-invoice]')?.addEventListener('click',()=>{dialog.close();showInvoiceDetail(row.transactionId);});
    el('[data-cf-copy]')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.origin+'/s/'+row.surveySlug);toast(tr('تم نسخ الرابط','Link copied'));}catch(e){error(e);}});
    dialog.querySelectorAll('[data-cf-image]').forEach(async button=>{try{const result=await api(`/complaints/${row._id}/evidence/${button.dataset.cfImage}`);if(!button.isConnected)return;button.querySelector('img').src=result.data;button.onclick=()=>{show(tr('إثبات الشكوى','Complaint evidence'),row.complaintNo,`<img src="${esc(result.data)}" style="max-width:100%;display:block;margin:auto" alt="${esc(button.title)}"><div class="cf-foot"><button class="btn btn-outline" data-cf-back>${tr('رجوع','Back')}</button></div>`);el('[data-cf-back]').onclick=()=>open(row._id);};}catch{button.textContent=tr('تعذر تحميل الصورة','Image unavailable');}});
    el('[data-cf-upload]').onchange=async event=>{if(busy)return;const files=[...event.target.files];if(!files.length)return;buttonsDisabled(true);try{for(const file of files){if(file.size>5*1024*1024)throw new Error(tr('الصورة أكبر من 5 ميجابايت','Image exceeds 5 MB'));const data=new FormData();data.append('file',file);await api(`/complaints/${row._id}/evidence`,{method:'POST',body:data});}await open(row._id);await refresh();}catch(e){await open(row._id);error(e);}finally{buttonsDisabled(false);}};
  }
  async function act(row,action){
    if(action==='case'){dialog.close();return AfterSales.open(row.workflow.caseId);}
    if(action==='create-case'){dialog.close();return AfterSales.create(row.transactionId,row.workflow.solution,{complaintId:row._id,expectedComplaintRevision:row.workflow.revision,items:row.items,complaintNo:row.complaintNo});}
    return form(row._id,action);
  }
  async function form(id,action){
    const version=show(tr('إجراء على الشكوى','Complaint action'),'',tr('جارٍ التحميل…','Loading…'));
    try{
      const row=await api('/complaints/'+encodeURIComponent(id));if(version!==serial||!dialog.open)return;active=row;
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
      show(actionNames()[action]||(action==='comment'?tr('ملاحظة داخلية','Internal note'):tr('إجراء الشكوى','Complaint action')),row.complaintNo,`${pending?`<div class="cf-notice">${tr('هناك محاولة لم يتأكد حفظها. إعادة المحاولة تستخدم نفس البيانات لمنع التكرار.','An earlier attempt is unconfirmed. Retrying uses the same data to avoid duplication.')}</div>`:''}${extraNotice?`<div class="cf-notice">${esc(extraNotice)}</div>`:''}<form data-cf-form>${fields}${note()}<div class="cf-foot"><button type="button" class="btn btn-outline" data-cf-back>${tr('رجوع','Back')}</button><button class="btn btn-primary" type="submit">${tr('حفظ الإجراء','Save action')}</button></div></form>`);
      const f=el('form');el('[data-cf-back]').onclick=()=>open(id);
      function dynamic(){if(el('[data-cf-money]'))el('[data-cf-money]').hidden=!['compensation','refund_without_return'].includes(f.elements.solution.value);if(el('[data-cf-duplicate]'))el('[data-cf-duplicate]').hidden=f.elements.outcome.value!=='duplicate';}f.onchange=dynamic;dynamic();
      if(pending){for(const [name,value] of Object.entries(pending)){const input=f.elements.namedItem(name);if(!input)continue;if(input.type==='checkbox')input.checked=value===true;else input.value=name==='dueAt'?cairoInput(new Date(value)):value;input.disabled=true;}dynamic();}
      f.onsubmit=async event=>{event.preventDefault();if(busy)return;buttonsDisabled(true);try{const values=Object.fromEntries(new FormData(f));for(const name of ['confirmed','customerConfirmed'])if(f.elements[name])values[name]=f.elements[name].checked;if(values.amount)values.amount=Number(values.amount);else delete values.amount;if(values.dueAt)values.dueAt=cairoDate(values.dueAt);await mutate(row,action,values);await refresh();await open(id);}catch(e){error(e);}finally{buttonsDisabled(false);}};
    }catch(e){error(e);}
  }
  function draftKey(){return 'complaint-draft:'+me();}
  async function create(invoiceId='',options={}){
    if(draftOwner!==me()){createDraft=null;draftOwner=me();}
    let saved;try{saved=JSON.parse(sessionStorage.getItem(draftKey())||'null');}catch{}
    const draft=options.edit?{operationKey:uid(),transactionId:invoiceId,items:options.edit.items||[],description:options.edit.description}:createDraft||saved||{operationKey:uid(),items:[],...options.seed};
    if(invoiceId&&draft.transactionId!==invoiceId){draft.transactionId=invoiceId;draft.items=[];}
    createDraft=options.edit?null:draft;
    let tx=(transactions||[]).find(t=>t._id===draft.transactionId);
    if(!tx&&draft.transactionId){try{tx=await api('/transactions/'+encodeURIComponent(draft.transactionId));}catch(e){toast(e.message,true);}}
    const edit=options.edit;
    show(edit?tr('الفاتورة والقطع المتضررة','Invoice and affected items'):tr('شكوى جديدة','New complaint'),tr('ملف واحد لكل مشكلة · متابعة حتى الإغلاق','One issue, one case · tracked through closure'),`<form data-cf-create>
      <section class="cf-card"><h3>${tr('الفاتورة','Invoice')}</h3><input class="cf-search" name="orderSearch" placeholder="${tr('ابحث برقم الفاتورة أو الاسم أو الهاتف','Search invoice, name or phone')}" autocomplete="off"><div data-cf-results></div><div data-cf-selected></div><div data-cf-items></div><div data-cf-duplicates></div></section>
      ${!edit?`<div class="cf-two">${field('clientName',tr('اسم العميل','Customer name'),'text',draft.clientName||'','required')}${field('phone',tr('رقم التواصل','Phone'),'tel',draft.phone||'','required')}</div><div class="cf-two">${select('categoryGroup',tr('نوع المشكلة','Issue category'),{'':tr('اختر','Choose'),...Object.fromEntries(Object.keys(CMP_CATEGORIES).map(k=>[k,_cmpCategoryLabel(k)]))},draft.categoryGroup)}${select('priority',tr('الأولوية','Priority'),{'متوسطة':tr('متوسطة','Medium'),'عالية':tr('عالية','High'),'منخفضة':tr('منخفضة','Low')},draft.priority||'متوسطة')}</div><label class="cf-field">${tr('وصف المشكلة والنتيجة المطلوبة','Issue and desired outcome')}<textarea name="description" required maxlength="5000">${esc(draft.description||'')}</textarea></label>${field('imageUrl',tr('رابط صورة المشكلة — اختياري','Issue image URL — optional'),'url',draft.imageUrl||'')}`:''}
      <div class="cf-foot"><button type="button" class="btn btn-outline" data-cf-back>${edit?tr('رجوع','Back'):tr('حفظ مسودة وإغلاق','Save draft & close')}</button>${!edit?`<button type="button" class="btn btn-outline" data-cf-discard>${tr('مسح المسودة','Discard draft')}</button>`:''}<button type="submit" class="btn btn-primary">${edit?tr('حفظ البنود','Save items'):tr('تسجيل الشكوى','Create complaint')}</button></div></form>`);
    const f=el('form');let selected=tx;
    function saveDraft(){if(edit)return;const values=Object.fromEntries(new FormData(f));delete values.orderSearch;Object.assign(draft,values);draft.items=readItems();draft.transactionId=selected?._id||'';sessionStorage.setItem(draftKey(),JSON.stringify(draft));}
    function readItems(){return [...f.querySelectorAll('[data-cf-line]')].filter(r=>r.querySelector('[type=checkbox]').checked).map(r=>({lineIndex:Number(r.dataset.cfLine),qty:Number(r.querySelector('[type=number]').value)}));}
    function draw(){
      el('[data-cf-selected]').innerHTML=selected?`<p><bdi>#${esc(selected.ref)}</bdi> · ${esc(selected.client)} ${!edit?`<button type="button" class="cf-link" data-cf-clear>${tr('تغيير','Change')}</button>`:''}</p>`:`<p class="cf-muted">${tr('يمكن تسجيل الشكوى بدون فاتورة مع بيانات التواصل.','You can register without an invoice using customer contact details.')}</p>`;
      if(!edit){f.elements.clientName.readOnly=!!selected?.client;f.elements.phone.readOnly=!!selected?.phone;if(selected){f.elements.clientName.value=selected.client||draft.clientName||'';f.elements.phone.value=selected.phone||draft.phone||'';}}
      el('[data-cf-items]').innerHTML=(selected?.items||[]).map((i,index)=>{const picked=draft.items?.find(v=>v.lineIndex===index);return `<label class="cf-item" data-cf-line="${index}"><input type="checkbox" ${picked?'checked':''}><span>${esc(i.name||i.code)}<small>${tr('الكمية بالفاتورة','Invoice quantity')}: ${i.qty}</small></span><input type="number" min="1" max="${i.qty}" step="1" value="${picked?.qty||1}" aria-label="${tr('الكمية المتضررة','Affected quantity')} ${esc(i.name||i.code)}"></label>`;}).join('');
      const similar=(complaints||[]).filter(c=>c._id!==edit?._id&&c.workflow?.stage!=='closed'&&(selected?c.transactionId===selected._id:draft.phone&&c.phone===draft.phone));
      el('[data-cf-duplicates]').innerHTML=similar.length?`<div class="cf-notice">${tr('توجد شكاوى مفتوحة؛ راجعها قبل إنشاء أخرى:','Open complaints found; review before creating another:')} ${similar.map(c=>`<button type="button" class="cf-link" data-cf-existing="${esc(c._id)}">${esc(c.complaintNo)}</button>`).join(' · ')}</div>`:'';
      f.querySelectorAll('[data-cf-existing]').forEach(b=>b.onclick=()=>{saveDraft();open(b.dataset.cfExisting);});
      el('[data-cf-clear]')?.addEventListener('click',()=>{selected=null;draft.items=[];draw();saveDraft();});
    }
    draw();
    f.elements.orderSearch.oninput=()=>{const q=f.elements.orderSearch.value.trim().toLowerCase();const rows=q?(transactions||[]).filter(t=>t.type==='مبيعات'&&[t.ref,t.client,t.phone].some(v=>String(v||'').toLowerCase().includes(q))).slice(0,20):[];el('[data-cf-results]').innerHTML=rows.map(t=>`<button class="cf-result" type="button" data-cf-pick="${esc(t._id)}"><bdi>#${esc(t.ref)}</bdi> · ${esc(t.client)} · <bdi>${esc(t.phone||'')}</bdi></button>`).join('');f.querySelectorAll('[data-cf-pick]').forEach(b=>b.onclick=()=>{selected=rows.find(t=>t._id===b.dataset.cfPick);draft.items=[];f.elements.orderSearch.value='';el('[data-cf-results]').innerHTML='';draw();saveDraft();});};
    f.addEventListener('input',saveDraft);f.addEventListener('change',saveDraft);
    el('[data-cf-back]').onclick=()=>{saveDraft();edit?open(edit._id):dialog.close();};
    el('[data-cf-discard]')?.addEventListener('click',()=>{sessionStorage.removeItem(draftKey());createDraft=null;dialog.close();});
    f.onsubmit=async event=>{event.preventDefault();if(busy)return;saveDraft();buttonsDisabled(true);try{
      let result;
      if(edit)result=await mutate(edit,'items',{transactionId:selected?._id,items:readItems()});
      else{const body={...draft,items:readItems()};delete body.orderSearch;if(!body.transactionId)delete body.transactionId;result=await api('/complaints',{method:'POST',body:JSON.stringify(body)});sessionStorage.removeItem(draftKey());createDraft=null;}
      await refresh();await open(result._id,edit?'':'registered');
    }catch(e){error(e);}finally{buttonsDisabled(false);}};
  }
  function matches(c){const w=c.workflow||{},stage=c.lifecycleStage||w.stage||'review';if(queue==='attention')return !!w.reviewRequired||stage==='blocked';if(queue==='archived')return !!w.archivedAt;if(w.archivedAt)return false;if(queue==='all')return true;if(queue==='active')return stage!=='closed';if(queue==='mine')return stage!=='closed'&&(w.ownerId||c.submittedById)===me();if(queue==='overdue')return !!c.overdue;return stage===queue;}
  function mount(){
    const host=document.getElementById('cmp-complaints-section');if(!host)return;
    let box=host.querySelector('[data-cf-queue]');
    if(!box){box=document.createElement('div');box.className='cf-queue';box.dataset.cfQueue='';host.prepend(box);}
    if(box.dataset.lang!==currentLang){box.dataset.lang=currentLang;box.innerHTML=`<label for="cf-queue">${tr('قائمة العمل','Work queue')}</label><select id="cf-queue">${Object.entries({active:tr('الشكاوى المفتوحة','Open complaints'),mine:tr('مسؤول عنها','Assigned to me'),overdue:tr('متأخرة','Overdue'),attention:tr('تحتاج مراجعة','Needs attention'),...stages(),all:tr('الكل','All'),archived:tr('الأرشيف','Archived')}).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('')}</select><span class="cf-muted" data-cf-counts aria-live="polite"></span>`;box.querySelector('select').value=queue;box.querySelector('select').onchange=e=>{queue=e.target.value;renderComplaints();};}
    const rows=complaints||[],open=rows.filter(c=>c.workflow?.stage!=='closed'),due=rows.filter(c=>c.overdue),ready=rows.filter(c=>c.execution?.ready&&c.workflow?.stage!=='closed');
    box.querySelector('[data-cf-counts]').textContent=tr(`مفتوحة ${open.length} · متأخرة ${due.length} · بانتظار التأكيد ${ready.length}`,`Open ${open.length} · Overdue ${due.length} · Awaiting confirmation ${ready.length}`);
  }
  async function changed(){if(busy||!admin()&&typeof hasPerm==='function'&&!hasPerm('complaints')&&!hasPerm('transaction'))return;try{await refresh();if(dialog?.open&&active&&el('.cf-grid'))await open(active._id);}catch{}}
  window.ComplaintFlow={open,form,create,chooseTicket,badge,menu,matches,mount,changed};
})();
