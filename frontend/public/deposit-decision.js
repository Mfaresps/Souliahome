/* Customer reasons are fetched from the server's canonical code registry. */
let _depositDecisionOptionsPromise;
let _ddOpenCount=0,_ddPreviousOverflow='';
function ddText(ar,en){return typeof currentLang!=='undefined'&&currentLang==='en'?en:ar;}
function ddEscape(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function ddOptions(){return _depositDecisionOptionsPromise||(_depositDecisionOptionsPromise=api('/shopify/deposit-decision-options').catch(e=>{_depositDecisionOptionsPromise=null;throw e;}));}
function ddEnhanceDecisionSelects(dialog){
 const cleanups=[],pickers=[];
 dialog.querySelectorAll('select').forEach(select=>{
  const required=select.required;select.required=false;select.hidden=true;select.tabIndex=-1;select.setAttribute('aria-hidden','true');
  const wrap=document.createElement('div');wrap.className='dd-picker';select.before(wrap);wrap.appendChild(select);
  const label=dialog.querySelector(`label[for="${select.id}"]`);if(label)label.id=select.id+'-label';
  const button=document.createElement('button');button.type='button';button.id=select.id+'-trigger';button.className='dd-picker-trigger';
  button.setAttribute('role','combobox');button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');button.setAttribute('aria-required',String(required));
  if(label){button.setAttribute('aria-labelledby',label.id+' '+select.id+'-value');label.htmlFor=button.id;}
  button.innerHTML=`<span id="${select.id}-value"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m7 10 5 5 5-5"/></svg>`;
  const error=document.createElement('span');error.className='dd-picker-error';error.id=select.id+'-error';error.setAttribute('aria-live','polite');
  button.setAttribute('aria-describedby',error.id);wrap.append(button,error);
  const list=document.createElement('div');list.className='dd-choice-list';list.id=select.id+'-list';list.setAttribute('role','listbox');list.setAttribute('aria-labelledby',label?.id||button.id);list.setAttribute('popover','manual');list.dir=dialog.dir;
  button.setAttribute('aria-controls',list.id);wrap.appendChild(list);
  const options=Array.from(select.options).filter(o=>o.value&&!o.disabled);let active=-1,opened=false,typed='',typedAt=0;
  options.forEach((option,index)=>{
   const item=document.createElement('div');item.className='dd-choice-option';item.id=select.id+'-option-'+index;item.setAttribute('role','option');item.dataset.value=option.value;
   item.innerHTML=`<span>${ddEscape(option.text)}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>`;
   item.onpointerdown=e=>e.preventDefault();item.onclick=()=>choose(index);item.onpointermove=()=>highlight(index,false);list.appendChild(item);
  });
  const sync=()=>{button.querySelector('span').textContent=select.selectedOptions[0]?.text||'';button.dataset.empty=String(!select.value);Array.from(list.children).forEach((item,i)=>item.setAttribute('aria-selected',String(options[i].value===select.value)));if(select.value){button.removeAttribute('aria-invalid');error.textContent='';}};
  const highlight=(index,scroll=true)=>{active=index;Array.from(list.children).forEach((item,i)=>item.classList.toggle('is-active',i===index));if(index>=0){button.setAttribute('aria-activedescendant',list.children[index].id);if(scroll)list.children[index].scrollIntoView({block:'nearest'});}};
  const position=()=>{
   const r=button.getBoundingClientRect(),view=window.visualViewport,w=view?.width||innerWidth,h=view?.height||innerHeight,x=view?.offsetLeft||0,y=view?.offsetTop||0;
   const edge=12,gap=6,desiredHeight=Math.min(w<=600?222:206,options.length*48+12);
   const below=Math.max(0,y+h-edge-r.bottom-gap),above=Math.max(0,r.top-y-edge-gap);
   const up=below<Math.min(desiredHeight,160)&&above>below;
   const height=Math.max(48,Math.min(desiredHeight,up?above:below));
   const width=Math.min(r.width,480,w-edge*2);
   list.style.width=width+'px';list.style.maxHeight=height+'px';
   list.style.left=Math.max(x+edge,Math.min(dialog.dir==='rtl'?r.right-width:r.left,x+w-width-edge))+'px';
   list.style.top=(up?r.top-gap-list.offsetHeight:r.bottom+gap)+'px';
  };
  const close=()=>{if(!opened)return;opened=false;if(list.matches(':popover-open'))list.hidePopover();list.classList.remove('is-open');button.setAttribute('aria-expanded','false');button.removeAttribute('aria-activedescendant');};
  const open=()=>{pickers.forEach(p=>p.close());opened=true;list.classList.add('is-open');if(typeof list.showPopover==='function')list.showPopover();button.setAttribute('aria-expanded','true');sync();position();highlight(Math.max(0,options.findIndex(o=>o.value===select.value)));};
  const choose=index=>{select.value=options[index].value;select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));sync();close();button.focus({preventScroll:true});};
  button.onclick=()=>opened?close():open();
  button.onkeydown=e=>{
   if(e.key==='Escape'&&opened){e.preventDefault();e.stopPropagation();close();return;}
   if(e.key==='Tab'){close();return;}
   if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();if(!opened){open();if(e.key==='ArrowUp')highlight(options.length-1);return;}highlight(e.key==='Home'?0:e.key==='End'?options.length-1:(active+(e.key==='ArrowDown'?1:-1)+options.length)%options.length);return;}
   if(e.key==='Enter'||e.key===' '){e.preventDefault();if(opened&&active>=0)choose(active);else open();return;}
   if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){const now=Date.now();typed=(now-typedAt>650?'':typed)+e.key.toLocaleLowerCase();typedAt=now;if(!opened)open();const i=options.findIndex(o=>o.text.toLocaleLowerCase().startsWith(typed));if(i>=0)highlight(i);}
  };
  const outside=e=>{if(opened&&!wrap.contains(e.target))close();};
  const reposition=e=>{if(opened&&!list.contains(e.target))position();};
  document.addEventListener('pointerdown',outside,true);dialog.addEventListener('scroll',reposition,true);window.addEventListener('resize',close);window.visualViewport?.addEventListener('resize',close);select.addEventListener('change',sync);
  cleanups.push(()=>{close();document.removeEventListener('pointerdown',outside,true);dialog.removeEventListener('scroll',reposition,true);window.removeEventListener('resize',close);window.visualViewport?.removeEventListener('resize',close);});
  pickers.push({close,validate(){const valid=!required||!!select.value;if(!valid){button.setAttribute('aria-invalid','true');error.textContent=ddText('اختر أحد الأسباب للمتابعة','Choose an option to continue');}return valid?null:button;}});sync();
 });
 dialog.addEventListener('close',()=>cleanups.forEach(fn=>fn()),{once:true});
 return ()=>{const invalid=pickers.map(p=>p.validate()).find(Boolean);if(invalid)invalid.focus();return !invalid;};
}
function ddDialog(title,body,wide=false){
 const d=document.createElement('dialog');d.className='dd-dialog'+(wide?' dd-report':'');d.dir=ddText('rtl','ltr');
 const previousFocus=document.activeElement;
 d.setAttribute('aria-label',title);d.innerHTML=`<header class="dd-head"><h3 tabindex="-1" autofocus>${ddEscape(title)}</h3><button type="button" class="dd-close" aria-label="${ddText('إغلاق','Close')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="dd-body">${body}</div>`;document.body.appendChild(d);
 if(_ddOpenCount++===0){_ddPreviousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';}
 d.querySelector('.dd-close').onclick=()=>d.close();
 d.addEventListener('close',()=>{d.remove();if(--_ddOpenCount===0)document.body.style.overflow=_ddPreviousOverflow;if(previousFocus?.isConnected)previousFocus.focus({preventScroll:true});},{once:true});
 d.showModal();d.querySelector('h3').focus({preventScroll:true});return d;
}
async function _spAskDepositDecision(order,objectionOnly=false,onSave){
 const initialRevision=order.depositDecisionRevision||0;
 const options=await ddOptions();
 if(document.querySelector('dialog.dd-editor[open]'))return null;
 return new Promise(resolve=>{
  const optionHtml=(list,placeholder)=>`<option value="" disabled selected>${placeholder}</option>`+list.map(r=>`<option value="${ddEscape(r.code)}">${ddEscape(ddText(r.ar,r.en))}</option>`).join('');
  const d=ddDialog(ddText(objectionOnly?'تسجيل سبب عدم دفع المقدم':'الشحن بدون عربون',objectionOnly?'Record deposit objection':'Ship without a deposit'),`
   <form class="dd-form" data-validation-on-submit novalidate><div class="dd-form-scroll">
   <div class="dd-order-context"><span class="dd-order-ref">${ddText('الطلب','Order')} <b>#${ddEscape(order.ref)}</b></span><span>${ddText('سجّل السبب كما أوضحه العميل','Record the reason given by the customer')}</span></div>
   <section class="dd-field-section"><span class="dd-section-caption">${ddText('سبب العميل','Customer reason')}</span><label for="dd-reason">${ddText('لماذا لم يدفع العميل مقدمًا؟','Why did the customer not pay a deposit?')}</label><select id="dd-reason" name="reasonCode" required data-empty="true">${optionHtml(options.reasons.filter(r=>!objectionOnly||r.code!=='not-requested'),ddText('اختر سبب عدم دفع المقدم','Choose the customer’s reason'))}</select>
   <details class="dd-note-wrap"><summary>${ddText('إضافة تفاصيل — اختياري','Add details — optional')}</summary><label for="dd-note">${ddText('تفاصيل السبب','Reason details')}</label><textarea id="dd-note" name="note" maxlength="500" placeholder="${ddText('اكتب ما يساعد على فهم موقف العميل','Add context about the customer’s concern')}"></textarea></details></section>
   ${objectionOnly?'':`<section class="dd-field-section"><span class="dd-section-caption">${ddText('قرار السماح بالشحن','Shipping exception')}</span><label for="dd-exception">${ddText('لماذا وافقت على الشحن بدون عربون؟','Why are you allowing shipping without a deposit?')}</label><select id="dd-exception" name="exceptionCode" required data-empty="true">${optionHtml(options.exceptions,ddText('اختر مبرر الاستثناء','Choose the exception justification'))}</select>
   <details class="dd-note-wrap"><summary>${ddText('إضافة توضيح — اختياري','Add a note — optional')}</summary><label for="dd-exception-note">${ddText('تفاصيل الاستثناء','Exception details')}</label><textarea id="dd-exception-note" name="exceptionNote" maxlength="500" placeholder="${ddText('اذكر توجيه الإدارة أو سبب الاستثناء','Record management direction or the justification')}"></textarea></details></section>`}
   <p class="dd-error" role="alert" aria-live="polite"></p></div><div class="dd-actions"><button class="btn btn-outline" type="button" data-close>${ddText('رجوع','Cancel')}</button><button type="submit" class="btn btn-primary">${ddText(objectionOnly?'حفظ السبب':'حفظ وتفعيل',objectionOnly?'Save reason':'Save and enable')}</button></div></form>`);
  d.classList.add('dd-editor');
  const f=d.querySelector('form');let settled=false;
  d.addEventListener('close',()=>{if(!settled)resolve(null);});d.querySelector('[data-close]').onclick=()=>d.close();
  const noteState=(select,textarea,required)=>{select.dataset.empty=String(!select.value);textarea.required=required;textarea.minLength=required?5:0;const details=textarea.closest('details');details.dataset.required=String(required);if(required)details.open=true;details.querySelector('summary').textContent=required?ddText('تفاصيل إضافية مطلوبة','Additional details required'):ddText('إضافة تفاصيل — اختياري','Add details — optional');if(!required&&typeof clearValidation==='function')clearValidation(textarea);};
  f.reasonCode.onchange=()=>noteState(f.reasonCode,f.note,f.reasonCode.value==='other');
  if(!objectionOnly)f.exceptionCode.onchange=()=>noteState(f.exceptionCode,f.exceptionNote,['manager-exception','other'].includes(f.exceptionCode.value));
  const validateChoices=ddEnhanceDecisionSelects(d);
  f.onsubmit=async event=>{event.preventDefault();f.dataset.validationAttempted='true';
   if(!validateChoices())return;
   for(const field of f.querySelectorAll('textarea[required]'))field.closest('details').open=true;
   if(typeof validateRequired==='function'&&!validateRequired(f).ok)return;
   if(!f.reportValidity())return;
   const payload={revision:initialRevision,reasonCode:f.reasonCode.value,note:f.note.value.trim(),...(!objectionOnly?{exceptionCode:f.exceptionCode.value,exceptionNote:f.exceptionNote.value.trim()}: {})};
   if((payload.reasonCode==='other'&&payload.note.length<5)||(!objectionOnly&&['manager-exception','other'].includes(payload.exceptionCode)&&payload.exceptionNote.length<5)){d.querySelector('[role=alert]').textContent=ddText('اكتب توضيحًا من 5 أحرف على الأقل.','Enter at least five characters of detail.');return;}
   const submit=f.querySelector('[type=submit]');if(submit.disabled)return;submit.disabled=true;
   try{if(onSave)await onSave(payload);settled=true;resolve(payload);d.close();}
   catch(e){d.querySelector('[role=alert]').textContent=e.message||ddText('تعذر الحفظ','Could not save');submit.disabled=false;}
  };
 });
}
function ddCanRecord(){return typeof hasPerm==='function'&&hasPerm('shopify-deposit-upload');}
async function openDepositObjectionForRef(ref){
 try{
  if(!ddCanRecord())return;
  let order=typeof _shopifyOrders!=='undefined'&&_shopifyOrders.find(o=>String(o.ref).replace(/^#/,'')===String(ref).replace(/^#/,''));
  if(!order&&typeof loadShopifyOrders==='function'){await loadShopifyOrders();order=_shopifyOrders.find(o=>String(o.ref).replace(/^#/,'')===String(ref).replace(/^#/,''));}
  if(!order||order.status!=='pending'||order.cancelled){toast(ddText('تسجيل الاعتراض متاح للطلب غير المؤكد وغير الملغي فقط.','Objections can be recorded on pending, uncancelled orders.'),true);return;}
  await _spAskDepositDecision(order,true,async payload=>{
   const change=await api(`/shopify/orders/${encodeURIComponent(order._id)}/deposit-objection`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   _spApplyShippingChoice(change);toast(ddText('تم حفظ السبب في سجل الطلب','Reason saved to the order history'));
  });
 }catch(e){toast(e.message,true);}
}
function depositObjectionButton(ref,compact=false,recorded=false){
 if(!ddCanRecord())return '';
 const label=compact?(recorded?ddText('تحديث السبب','Update reason'):ddText('تسجيل السبب','Record reason')):ddText('تسجيل سبب عدم دفع المقدم','Record deposit objection');
 return `<button type="button" class="dd-info-button${compact?' dd-info-button--compact':''}" onclick="event.stopPropagation();openDepositObjectionForRef(${ddEscape(JSON.stringify(String(ref)))})">${label}</button>`;
}
function depositDecisionSummaryHtml(order,compact=false){
 if(!order)return '';
 const hasHistory=!!order.depositDecision||!!order.depositDecisionHistory?.length||!!order.shipWithoutDeposit;
 const editable=order.status==='pending'&&!order.cancelled;
 if(compact){
  const canRecord=editable&&ddCanRecord();
  if(!hasHistory&&!canRecord)return '';
  const recorded=!!order.depositDecision?.reasonCode||!!order.depositDecisionHistory?.some(e=>e.after?.reasonCode);
  const note=recorded?ddText('السبب مسجّل في سجل الطلب','Reason saved in the order history'):hasHistory?ddText('يوجد سجل قرارات، ولم يُسجّل سبب العميل','Decision history available; customer reason missing'):ddText('لم يُسجّل سبب العميل بعد','Customer reason not recorded yet');
  return `<div class="dd-summary dd-summary--compact"><div class="dd-summary-copy"><b>${ddText('سبب عدم دفع العربون','Deposit reason')}</b><span>${note}</span></div><div class="dd-summary-actions">${canRecord?depositObjectionButton(order.ref,true,recorded):''}${hasHistory?`<button type="button" class="dd-info-button dd-info-button--quiet" onclick="event.stopPropagation();openDepositDecisionHistory(${ddEscape(JSON.stringify(String(order.ref)))},${!!order.type})">${ddText('سجل القرارات','Decision history')}</button>`:''}</div></div>`;
 }
 return `<div class="dd-summary">${hasHistory?`<button type="button" class="dd-info-button" onclick="event.stopPropagation();openDepositDecisionHistory(${ddEscape(JSON.stringify(String(order.ref)))},${!!order.type})">${ddText('سبب الشحن وسجل قرارات العربون','Shipping reason and deposit decisions')}</button>`:''}${editable?depositObjectionButton(order.ref):''}${!hasHistory&&!editable?ddText('سبب الشحن بدون عربون: غير مسجل','Shipping without deposit reason: not recorded'):''}</div>`;
}
async function openDepositDecisionHistory(ref,invoice=false){
 try{
  const options=await ddOptions();
  const o=(!invoice&&typeof _shopifyOrders!=='undefined'&&_shopifyOrders.find(o=>String(o.ref)===String(ref)))||(typeof transactions!=='undefined'&&transactions.find(t=>String(t.ref)===String(ref)));
  if(!o)return;
  const label=(code,registry)=>{const r=registry.find(r=>r.code===code);return r?ddText(r.ar,r.en):ddText('غير مسجل','Not recorded');};
  const details=decision=>`${ddEscape(label(decision?.reasonCode,options.reasons))}${decision?.note?` — ${ddEscape(decision.note)}`:''}<p>${ddText('مبرر الاستثناء','Exception justification')}: ${ddEscape(label(decision?.exceptionCode,options.exceptions))}${decision?.exceptionNote?` — ${ddEscape(decision.exceptionNote)}`:''}</p>`;
  const actions={enabled:ddText('تفعيل الشحن بدون عربون','Enabled shipping without deposit'),disabled:ddText('إيقاف الشحن بدون عربون','Disabled shipping without deposit'),'reason-changed':ddText('تغيير السبب','Reason changed'),'objection-recorded':ddText('تسجيل اعتراض العميل','Customer reason recorded')};
  const history=(o.depositDecisionHistory||[]).slice().reverse();
  const d=ddDialog(`${ddText('قرارات العربون','Deposit decisions')} #${ref}`,`<div class="dd-summary">${details(o.depositDecision)}</div><ol class="dd-history">${history.map(e=>`<li><b>${ddEscape(actions[e.action]||e.action)}</b><span class="dd-history-label">${ddEscape(new Date(e.at).toLocaleString(ddText('ar-EG','en-GB'),{timeZone:'Africa/Cairo'}))} · ${ddEscape(e.by)}</span>${details(e.after)}${e.before?.reasonCode?`<p>${ddText('السبب السابق','Previous reason')}: ${ddEscape(label(e.before.reasonCode,options.reasons))}</p>`:''}</li>`).join('')||`<li>${ddText('لا يوجد تاريخ مسجل للطلبات القديمة.','No recorded history for this older order.')}</li>`}</ol><div class="dd-actions">${o.status==='pending'&&!o.cancelled?depositObjectionButton(ref):''}<button type="button" class="btn btn-outline" data-close>${ddText('إغلاق','Close')}</button></div>`);
  d.querySelector('[data-close]').onclick=()=>d.close();
 }catch(e){toast(e.message,true);}
}
function syncDepositDecisionButtons(){
 const b=document.getElementById('sp-deposit-analysis-btn');if(b){b.hidden=!hasPerm('reports-orderaudit');b.textContent=ddText('تحليل العربون','Deposit analysis');}
}
async function openDepositDecisionReport(){
 if(!hasPerm('reports-orderaudit'))return;
 const date=new Date();const month=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit'}).format(date);
 const d=ddDialog(ddText('تحليل أسباب العربون والشحن','Deposit and shipping reason analysis'),`<p>${ddText('اختر شهر ورود الطلبات. النتائج حسب أحدث حالة مسجلة. يُستخدم سبب الإلغاء المتعلق بالعربون إن وُجد، وإلا السبب المحفوظ عند التأكيد أو آخر سبب للطلب المفتوح.','Choose the order creation month. Outcomes use the latest recorded state. An explicit deposit-related cancellation reason takes precedence; otherwise the reason is frozen at confirmation or is the latest open-order reason.')}</p><label for="dd-month">${ddText('شهر ورود الطلب','Order creation month')}</label><input id="dd-month" type="month" value="${month}" min="2000-01" max="2099-12"><div class="dd-actions"><button type="button" class="btn btn-primary" data-load>${ddText('عرض التحليل','Analyze')}</button><button type="button" class="btn btn-outline" data-export disabled>${ddText('تصدير التفاصيل CSV','Export details CSV')}</button><button type="button" class="btn btn-outline" data-close>${ddText('إغلاق','Close')}</button></div><div data-result role="status"></div>`,true);
 let report=null,request=0;d.querySelector('[data-close]').onclick=()=>d.close();
 const table=(heads,rows)=>`<div class="dd-table-wrap"><table><thead><tr>${heads.map(h=>`<th>${ddEscape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(v=>`<td>${ddEscape(v??'—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
 const load=async()=>{
  const current=++request;const month=d.querySelector('input').value,host=d.querySelector('[data-result]');
  report=null;d.querySelector('[data-export]').disabled=true;host.textContent=ddText('جارٍ التحليل…','Analyzing…');
  try{const result=await api('/shopify/deposit-decision-report?month='+encodeURIComponent(month));if(current!==request||!d.isConnected)return;report=result;
   const heads=['السبب','طلبات','فُعّل الاستثناء','تأكد بلا مقدم مسجل','شُحن','تم التسليم','مرتجع','ملغي','شحن جارٍ','غير مؤكد','مقدم سُجّل لاحقًا','نجاح التسليم'];
   host.innerHTML=`<p>${ddText('إجمالي الوارد','Total orders')}: <b>${result.totalOrders}</b> · ${ddText('أسباب مسجلة','Recorded reasons')}: <b>${result.recordedReasons}</b> · ${ddText('لا يوجد اعتراض مسجل','No objection recorded')}: <b>${result.noObjectionRecorded}</b></p><p>${ddText('الحالة حتى','As of')}: ${ddEscape(new Date(result.asOf).toLocaleString(ddText('ar-EG','en-GB'),{timeZone:'Africa/Cairo'}))}</p>${table(heads,result.groups.map(g=>[g.label,g.orders,g.enabled,g.confirmedWithoutDeposit,g.shipped,g.delivered,g.returned,g.cancelled,g.inProgress,g.pending,g.paidLater,g.deliveryRate===null?'—':g.deliveryRate+'%']))}<p>${ddText('نجاح التسليم = المسلّم ÷ المشحون. الفئات متداخلة: المرتجع قد يكون ملغيًا، والتفعيل لا يعني الشحن. «مقدم سُجّل لاحقًا» يعتمد على وقت اعتماد الإيصال أو تسجيل المقدم بعد أول تسجيل للسبب، وليس بالضرورة وقت التحويل البنكي. عدم تسجيل اعتراض لا يثبت قبول العربون.','Delivery success = delivered / shipped. Columns overlap: a return may be cancelled, and enabling is not shipping. Later recorded deposits use receipt approval or deposit-entry time after the first reason, not necessarily bank transfer time. Missing objections do not prove acceptance.')}</p><details><summary>${ddText('تفاصيل الطلبات وأسبابها','Order details and reasons')}</summary>${table(['الطلب','السبب','التفاصيل','مبرر الاستثناء','تم التسليم','ملغي','دفع لاحقًا'],result.rows.filter(r=>r.reasonCode!=='no-objection-recorded').map(r=>[r.ref,r.reason,r.note,r.exception,r.delivered?'✓':'—',r.cancelled?'✓':'—',r.paidLater?'✓':'—']))}</details>`;
   d.querySelector('[data-export]').disabled=false;
  }catch(e){if(current===request)host.textContent=e.message;}
 };
 d.querySelector('[data-load]').onclick=load;
 d.querySelector('[data-export]').onclick=()=>{
  if(!report)return;
  const fields=['ref','reason','note','exception','exceptionNote','everEnabled','confirmedWithoutDeposit','shipped','delivered','returned','cancelled','inProgress','pending','paidLater','cancelReason','at','by'];
  const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
  const headers=['الطلب','سبب عدم دفع المقدم','تفاصيل السبب','مبرر الاستثناء','تفاصيل الاستثناء','سبق تفعيل الشحن بدون عربون','تأكد بلا مقدم مسجل','تم الشحن','تم التسليم','مرتجع','ملغي','شحن جارٍ','غير مؤكد','مقدم سجل لاحقًا','سبب الإلغاء','وقت تسجيل السبب','الموظف'];
  const csv='\ufeff'+[headers,...report.rows.map(r=>fields.map(k=>r[k]))].map(row=>row.map(cell).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`deposit-analysis-${report.month}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 };await load();
}
