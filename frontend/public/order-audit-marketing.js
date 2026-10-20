/* Advertising invoices are read and validated by the report API; this never posts expenses. */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => Number(value).toLocaleString('en-US', {maximumFractionDigits:2});
  const money = value => value == null ? '—' : `${number(value)} EGP`;
  const state = {data:null, scopes:[], context:'', ids:[], invoices:[], result:null, busy:false, error:'', notice:'', revision:0,compare:true,comparison:null,previousIds:undefined};
  let pickerMode='current';
  let dialog, draft, invoices = new Map(), visible = [], page = 1, hasMore = false, loading = false, listVersion = 0, timer, opener, closeTimer;
  let applyingRevision=0, appliedResult=null;
  const dateFormat = new Intl.DateTimeFormat('ar-EG', {day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
  function invoiceDate(value) {
    const date = new Date(String(value || '').slice(0,10));
    return Number.isFinite(date.getTime()) ? dateFormat.format(date) : 'بدون تاريخ';
  }
  function closeDialog(immediate = false, cancelPending = true) {
    if (!dialog?.open) return;
    if (cancelPending && applyingRevision && applyingRevision===state.revision) {
      ++state.revision;applyingRevision=0;state.busy=false;state.result=appliedResult;paint();updatePickerControls();
    }
    clearTimeout(closeTimer);
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) { dialog.close(); return; }
    dialog.classList.add('oam-closing');
    closeTimer = setTimeout(() => dialog.close(),180);
  }
  const endpoint = '/order-audit/';
  const scopeNames = () => state.scopes.map(id => (typeof AUDIT_FIN_SCOPES !== 'undefined' ? AUDIT_FIN_SCOPES.find(option=>option.id===id)?.label : null) || ({synced:'المتزامن','pending-deposit':'في انتظار الموافقة بديبوزت','pending-without-deposit':'شحن بدون ديبوزت','pending-no-choice':'لم يسجل ويحتاج متابعة',cancelled:'الملغي',unsynced:'غير المتزامن'}[id] || id)).join(' + ') || 'لم يتم اختيار حالات';
  const requestBody = ids => ({expenseIds:ids, scopes:[...state.scopes],compare:state.compare,...(state.previousIds===undefined?{}:{previousExpenseIds:state.previousIds}), ...(state.data.period ? {period:state.data.period} : {from:state.data.from,to:state.data.to})});
  const card = (label,value,hint,cls='') => `<div class="oam-kpi ${cls}"><span>${label}</span><strong class="${typeof value === 'number' && value < 0 ? 'oam-negative' : ''}">${value == null ? '—' : typeof value === 'number' ? money(value) : value}</strong><small>${hint}</small></div>`;
  function paint() {
    const root = document.getElementById('oa-marketing'); if (!root) return;
    const m = state.result;
    const estimated = !!m?.pendingOrders;
    const displayedProfit = estimated ? m.estimatedProfitAfterAdvertising : m?.profitAfterAdvertising;
    const displayedMargin = estimated ? (m.revenue > 0 && displayedProfit != null ? displayedProfit / m.revenue * 100 : null) : m?.netMargin;
    const period=state.data?.period;
    const outside=period ? state.invoices.filter(i=>{const date=String(i.date || '').slice(0,10);return date<period.fromDate || date>period.toDate || (period.months?.length && !period.months.includes(Number(date.slice(5,7))));}).length : 0;
    root.innerHTML = `<div class="oam-head"><div><h3>إعلانات وتسويق</h3><p>اربط مصروفات الإعلان بهذا التقرير لتعرف العائد والتكلفة والربح بعد الإعلان.</p></div><button type="button" class="oam-button primary" data-oam="open">${state.ids.length ? 'تعديل المصروفات المختارة' : 'اختيار مصروفات الإعلان'}</button></div>
      <div class="oam-scope" role="status"><span>حسب فلتر التحليل المالي: <strong>${escape(scopeNames())}</strong></span><button type="button" class="oam-button" data-oam="scopes">تغيير الحالات</button></div>
      ${state.error ? `<div class="oam-error" role="alert">${escape(state.error)} <button type="button" class="oam-button" data-oam="retry">إعادة المحاولة</button></div>` : ''}
      ${state.busy ? '<div class="oam-status" role="status">جارٍ مراجعة المصروفات وحساب المؤشرات…</div>' : ''}
      ${!state.ids.length && !state.busy ? '<div class="oam-empty">اختر فاتورة إعلانات معتمدة أو أكثر لبدء التحليل.<br><small>هذا تحليل فقط؛ لن يتم تسجيل مصروف جديد أو خصم المبلغ من الخزينة مرة أخرى.</small></div>' : ''}
      ${state.invoices.length ? `<div class="oam-chips">${state.invoices.map(i => `<span class="oam-chip">${escape(i.desc || i.expenseNo || 'إعلان')} · ${money(i.amount)} · ${escape(String(i.date || '').slice(0,10))}<button type="button" data-remove="${escape(i._id)}" aria-label="إزالة ${escape(i.desc || 'المصروف')}" ${state.busy ? 'disabled' : ''}>×</button></span>`).join('')}</div>` : ''}
      ${outside ? `<div class="oam-note">اخترت ${outside} مصروفات خارج فترة التقرير؛ تأكد من ارتباطها بالطلبات المعروضة قبل الاعتماد على النتائج.</div>` : ''}
      ${m && !state.busy ? `<p>${m.expenseCount} مصروفات معتمدة · ${m.registeredOrders} طلبات مسجلة · ${m.pendingOrders} طلبات منتظرة${m.excludedOrders ? ` · استُبعد ${m.excludedOrders} طلبات ملغاة أو غير مسجلة` : ''}</p>
      <div class="oam-grid">
        ${card('الإنفاق الإعلاني',m.spend,'إجمالي المصروفات المختارة')}
        ${card('العائد على الإنفاق · ROAS',m.roas == null ? '—' : `${number(m.roas)}×`,m.pendingOrders ? 'تقديري: يشمل قيمة الطلبات المنتظرة' : 'مبيعات الطلبات ÷ مصروفات الإعلان')}
        ${card('تكلفة الإعلان لكل طلب',m.costPerOrder,'الإنفاق ÷ عدد الطلبات في هذا العرض')}
        ${card(m.pendingOrders ? 'قيمة الطلبات بعد الإعلان' : 'المبيعات بعد الإعلان',m.salesAfterAdvertising,'قبل خصم المنتجات والشحن؛ ليست صافي الربح')}
        ${card(estimated ? 'الربح التقديري بعد الإعلان' : 'الربح بعد الإعلان',displayedProfit,estimated ? 'يشمل الطلبات المنتظرة المختارة؛ يتغير بعد تسجيلها' : 'ربح الطلبات المختارة − كامل الإنفاق المختار','profit')}
        ${card(estimated ? 'هامش الربح التقديري' : 'هامش الربح بعد الإعلان',displayedMargin == null ? '—' : `${number(displayedMargin)}%`,'الربح بعد الإعلان ÷ قيمة الطلبات المختارة')}
      </div>
      <div class="oam-note">نسبة الإنفاق من قيمة الطلبات: <b>${m.advertisingPercent == null ? '—' : number(m.advertisingPercent)+'%'}</b> · ربح الطلب المسجل بعد الإعلان: <b>${money(m.profitPerRegisteredOrder)}</b>${m.breakEvenRoas != null ? ` · ROAS التعادل: <b>${number(m.breakEvenRoas)}×</b>` : ''}${m.pendingOrders ? `<br>الربح التقديري إذا سُجلت الطلبات المنتظرة: <b>${money(m.estimatedProfitAfterAdvertising)}</b>؛ قد يتغير بعد الموافقة وتأكيد التكلفة.` : ''}</div>
      <p>المؤشرات تخص الطلبات ضمن حالات وفترة التقرير، ولا تثبت أن هذه الطلبات جاءت من الإعلان. المصروفات المختارة تُخصم مرة واحدة في هذا التحليل. الربح يعتمد على تكلفة المنتجات الحالية وتكلفة الشحن المسجلة، ولا يشمل المصروفات الأخرى.${m.missingCostOrders ? ` توجد ${m.missingCostOrders} طلبات بدون تكلفة منتجات مكتملة.` : ''}${m.unconfirmedShippingOrders ? ` تكلفة الشحن الفعلية غير مؤكدة في ${m.unconfirmedShippingOrders} طلبات.` : ''}</p>` : ''}`;
    if (window.AuditInsights) {
      const actions={compare:enabled=>{++state.revision;state.compare=enabled;state.comparison=null;state.busy=false;if(enabled)analyze(state.ids);else paint();},previous:()=>open('previous'),retry:()=>analyze(state.ids)};
      root.innerHTML=window.AuditInsights.marketing(state,{escape,number,money,scopeNames});
      window.AuditInsights.financial(state,actions);
      root.querySelector('[data-compare]')?.addEventListener('change',event=>actions.compare(event.target.checked));
      root.querySelector('[data-previous]')?.addEventListener('click',actions.previous);
      root.querySelector('[data-comparison-retry]')?.addEventListener('click',actions.retry);
    }
    root.querySelector('[data-oam="open"]').onclick = () => open('current');
    root.querySelector('[data-oam="scopes"]').onclick = event => {
      event.stopPropagation();
      const picker=document.getElementById('oa-fin-scope');
      if (picker) { picker.open=true; picker.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',block:'center'}); picker.querySelector('summary')?.focus({preventScroll:true}); }
    };
    root.querySelector('[data-oam="retry"]')?.addEventListener('click', () => analyze(state.ids));
    root.querySelectorAll('[data-remove]').forEach(button => button.onclick = () => analyze(state.ids.filter(id => id !== button.dataset.remove)));
  }
  async function analyze(ids, fromDialog = false, previousIds = state.previousIds) {
    const revision = ++state.revision, body = requestBody(ids), previousResult = fromDialog ? state.result : null;
    if (previousIds!==undefined) body.previousExpenseIds=previousIds;
    state.busy = true; state.result = null; state.error = ''; state.notice='';paint();
    if (fromDialog) { applyingRevision=revision;appliedResult=previousResult;updatePickerControls();dialog.querySelector('[data-dialog-error]').hidden=true;dialog.querySelector('[data-dialog-error]').textContent = ''; }
    try {
      const response = await api(endpoint+'marketing-analysis', {method:'POST', body:JSON.stringify(body), background:true});
      if (revision !== state.revision) return;
      state.ids = [...ids]; state.invoices = response.invoices; state.result = ids.length ? response.metrics : null;
      state.comparison=response.comparison||null;state.previousIds=previousIds;
      if (state.compare && state.data.period && response.comparison===undefined) state.comparison={error:'خادم التقارير لم يفعّل المقارنة بعد. أعد تشغيل النسخة المحدّثة من الخلفية.'};
      if (fromDialog) {state.notice=pickerMode==='previous'?'تم تحديث فواتير الفترة السابقة.':ids.length?`تم تطبيق ${ids.length} فواتير إعلانات وتحديث المؤشرات.`:'تمت إزالة فواتير الإعلان من التحليل.';closeDialog(false,false);}
    } catch (error) {
      if (revision !== state.revision) return;
      state.result = previousResult;
      const message = error.message || 'تعذر حساب المؤشرات. أعد المحاولة.';
      if (fromDialog) {dialog.querySelector('[data-dialog-error]').hidden=false;dialog.querySelector('[data-dialog-error]').textContent = message;}
      else state.error = message;
    } finally {
      if (revision === state.revision) { state.busy = false;if(applyingRevision===revision)applyingRevision=0;paint();if(dialog?.open)updatePickerControls(); }
    }
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement('dialog'); dialog.className = 'oam-dialog'; dialog.dir = 'rtl'; dialog.setAttribute('aria-labelledby','oam-dialog-title');
    dialog.innerHTML = `<div class="oam-dialog-inner"><header><div class="oam-head"><h3 id="oam-dialog-title">اختيار مصروفات الإعلان</h3><button type="button" class="oam-button" data-close aria-label="إغلاق">×</button></div><p>فواتير الإعلانات فقط · اختر الفواتير لحساب إجمالي الإنفاق.</p><input class="oam-search" type="search" placeholder="ابحث باسم المصروف أو رقم الفاتورة…" aria-label="بحث مصروفات الإعلان"><div class="oam-tools"><label class="oam-period"><input type="checkbox" data-period checked> فترة التقرير فقط</label><button type="button" class="oam-button" data-select>تحديد الظاهر</button><button type="button" class="oam-button" data-clear>مسح التحديد</button></div></header><div class="oam-list" aria-busy="false"></div><div class="oam-status" role="status" data-list-status></div><div class="oam-error" data-dialog-error role="alert" hidden></div><footer class="oam-footer"><div><strong data-total></strong><small>لن يتغير التقرير حتى تضغط تطبيق</small></div><button type="button" class="oam-button" data-close>إلغاء</button><button type="button" class="oam-button primary" data-apply>تطبيق التحليل</button></footer></div>`;
    document.body.appendChild(dialog);
    dialog.querySelectorAll('[data-close]').forEach(button => button.onclick = () => closeDialog());
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    dialog.addEventListener('close', () => { clearTimeout(closeTimer); dialog.classList.remove('oam-closing'); ++listVersion; (opener?.isConnected ? opener : document.querySelector('#oa-marketing [data-oam="open"]'))?.focus(); });
    dialog.querySelector('input[type=search]').oninput = () => { clearTimeout(timer); ++listVersion; timer = setTimeout(() => load(false),250); };
    dialog.querySelector('[data-period]').onchange = () => load(false);
    dialog.querySelector('[data-select]').onclick = () => { visible.filter(eligible).forEach(i => draft.add(String(i._id))); syncSelection(); };
    dialog.querySelector('[data-clear]').onclick = () => { draft.clear(); syncSelection(); };
    dialog.querySelector('[data-apply]').onclick = () => { if(applyingRevision)return;const error=dialog.querySelector('[data-dialog-error]'); if (draft.size>200) {error.hidden=false;error.textContent='يمكن اختيار حتى 200 مصروف في التحليل.';return;} if(pickerMode==='previous')analyze(state.ids,true,[...draft]);else analyze([...draft],true); };
  }
  const eligible = invoice => invoice.status === 'معتمد' && Number(invoice.amount) > 0;
  function syncSelection() {
    dialog.querySelectorAll('.oam-row input').forEach(input => {input.checked=draft.has(input.value);});
    totals();
  }
  function updatePickerControls() {
    const applying=applyingRevision===state.revision && !!applyingRevision;
    const hadSelection=pickerMode==='previous'?!!state.comparison?.invoices?.length:!!state.ids.length;
    dialog.setAttribute('aria-busy',String(applying));
    const apply=dialog.querySelector('[data-apply]');
    apply.disabled=applying||(!draft.size&&!hadSelection);
    apply.textContent=applying?'جارٍ التطبيق…':draft.size?`تطبيق (${draft.size})`:hadSelection?'إزالة الاختيار':'اختر فاتورة';
    dialog.querySelectorAll('input,[data-select],[data-clear],[data-more]').forEach(control=>{
      if(control.matches('.oam-row input')) control.disabled=applying||!eligible(invoices.get(control.value)||{});
      else if(control.matches('[data-period]')) control.disabled=applying||!state.data.period;
      else control.disabled=applying;
    });
    dialog.querySelector('[data-select]').disabled=applying||!visible.some(eligible);
    dialog.querySelector('[data-clear]').disabled=applying||!draft.size;
    dialog.querySelector('.oam-footer small').textContent=applying?'يمكنك الإلغاء قبل اكتمال التطبيق.':'تُحسب النتائج على الفواتير المختارة فقط.';
  }
  function totals() { dialog.querySelector('[data-total]').textContent = `${draft.size} فواتير · ${money([...draft].reduce((sum,id) => sum + Number(invoices.get(id)?.amount || 0),0))}`;updatePickerControls(); }
  function drawList() {
    const list = dialog.querySelector('.oam-list');
    list.innerHTML = visible.map(i => `<div class="oam-row" aria-disabled="${!eligible(i)}"><input type="checkbox" id="oam-exp-${escape(i._id)}" value="${escape(i._id)}" ${draft.has(String(i._id)) ? 'checked' : ''} ${eligible(i) ? '' : 'disabled'}><div class="oam-invoice-content"><label for="oam-exp-${escape(i._id)}"><div class="oam-row-title"><b class="oam-invoice-name">${escape(i.desc || 'مصروف إعلانات')}</b><b class="oam-invoice-amount" dir="ltr">${money(i.amount)}</b></div><small class="oam-invoice-meta"><time datetime="${escape(String(i.date || '').slice(0,10))}">${escape(invoiceDate(i.date))}</time>${i.expenseNo ? `<span>فاتورة ${escape(i.expenseNo)}</span>` : ''}${!eligible(i) ? `<span class="oam-invoice-unavailable">${escape(i.status)} · غير متاح</span>` : ''}</small></label>${i.notes || i.account ? `<details><summary>التفاصيل</summary>${escape(i.account || '')}<br>${escape(i.notes || '')}</details>` : ''}</div></div>`).join('');
    list.querySelectorAll('input').forEach(input => input.onchange = () => { if (input.checked) draft.add(input.value); else draft.delete(input.value); totals(); });
    list.querySelectorAll('.oam-row').forEach(row => row.onclick = event => {
      if (event.target.closest('input,label,details,button,a')) return;
      const input=row.querySelector('input');
      if (!input.disabled) { input.focus({preventScroll:true}); input.click(); }
    });
    if (!visible.length) {
      const periodOnly=dialog.querySelector('[data-period]').checked&&!dialog.querySelector('[data-period]').disabled;
      const searched=!!dialog.querySelector('input[type=search]').value.trim();
      list.innerHTML=`<div class="oam-picker-empty"><b>${searched?'لا توجد فواتير تطابق البحث':periodOnly?'لا توجد فواتير إعلانات في هذه الفترة':'لا توجد فواتير إعلانات متاحة'}</b><p>${periodOnly?'يمكنك اختيار إعلان من تاريخ آخر مع بقاء فلتر الطلبات كما هو.':'جرّب البحث باسم مختلف أو رقم الفاتورة.'}</p>${periodOnly?'<button type="button" class="oam-button" data-show-all>عرض كل فواتير الإعلانات</button>':searched?'<button type="button" class="oam-button" data-reset-search>مسح البحث</button>':''}</div>`;
      list.querySelector('[data-show-all]')?.addEventListener('click',()=>{dialog.querySelector('[data-period]').checked=false;dialog.querySelector('input[type=search]').value='';load(false);});
      list.querySelector('[data-reset-search]')?.addEventListener('click',()=>{dialog.querySelector('input[type=search]').value='';load(false);});
    }
    const status = dialog.querySelector('[data-list-status]'); status.innerHTML = hasMore ? '<button type="button" class="oam-button" data-more>عرض المزيد</button>' : visible.length ? `${visible.length} فواتير ظاهرة · اضغط البطاقة للاختيار` : '';
    status.querySelector('[data-more]')?.addEventListener('click', () => load(true)); totals();
  }
  async function load(more) {
    const version = ++listVersion; loading = true;
    if (!more) { page=1; visible=[]; dialog.querySelector('.oam-list').innerHTML=''; }
    const params = new URLSearchParams({page:String(more ? page+1 : 1),search:dialog.querySelector('input[type=search]').value});
    if (dialog.querySelector('[data-period]').checked && pickerMode==='previous' && state.comparison?.windows?.length) {
      params.set('windows',JSON.stringify(state.comparison.windows));
    } else if (dialog.querySelector('[data-period]').checked && state.data.period) {
      const p = state.data.period; params.set('fromDate',p.fromDate); params.set('toDate',p.toDate);
      if (p.months?.length) { params.set('months',p.months.join(',')); params.set('year',p.year); }
    }
    dialog.querySelector('.oam-list').setAttribute('aria-busy','true');
    dialog.querySelector('[data-list-status]').textContent='جارٍ تحميل مصروفات الإعلان…';
    updatePickerControls();
    try {
      const response = await api(endpoint+'advertising-expenses?'+params,{background:true});
      if (version !== listVersion || !dialog.open) return;
      page=response.page; hasMore=response.hasMore; visible=more ? [...visible,...response.items] : response.items;
      response.items.forEach(i=>invoices.set(String(i._id),i)); drawList();
    } catch (error) {
      if (version !== listVersion || !dialog.open) return;
      const status=dialog.querySelector('[data-list-status]'); status.textContent=error.message || 'تعذر تحميل المصروفات';
      const retry=document.createElement('button'); retry.type='button'; retry.className='oam-button'; retry.textContent='إعادة المحاولة'; retry.onclick=()=>load(more); status.appendChild(retry);
    } finally { if (version===listVersion) {loading=false;dialog.querySelector('.oam-list').setAttribute('aria-busy','false');} }
  }
  function open(mode='current') {
    pickerMode=mode;
    ensureDialog(); opener=document.activeElement;
    const selected=mode==='previous'?(state.comparison?.invoices||[]):state.invoices;
    draft=new Set(selected.map(i=>String(i._id))); invoices=new Map(selected.map(i=>[String(i._id),i]));
    dialog.querySelector('#oam-dialog-title').textContent=mode==='previous'?'إعلانات الفترة السابقة':'اختيار مصروفات الإعلان';
    dialog.querySelector('input[type=search]').value='';dialog.querySelector('[data-period]').checked=true;
    dialog.querySelector('[data-apply]').disabled=false;
    dialog.querySelector('[data-period]').disabled=!state.data.period;
    let scopeNote=dialog.querySelector('[data-dialog-scopes]');
    if (!scopeNote) { scopeNote=document.createElement('p');scopeNote.dataset.dialogScopes='';dialog.querySelector('header').appendChild(scopeNote); }
    scopeNote.textContent='سيُحسب الإعلان على: '+scopeNames();
    dialog.querySelector('[data-dialog-error]').hidden=true; totals(); clearTimeout(closeTimer); dialog.classList.remove('oam-closing'); dialog.showModal(); load(false);
  }
  window.renderAuditMarketing = (data, scopes) => {
    const context=JSON.stringify(data.period || {from:data.from,to:data.to});
    if (context!==state.context) { ++state.revision;applyingRevision=0;state.ids=[];state.invoices=[];state.result=null;state.comparison=null;state.previousIds=undefined;state.error='';state.notice='';state.busy=false;closeDialog(true,false); }
    state.context=context;state.data=data;state.scopes=[...scopes];
    if (state.ids.length || (state.compare && data.period)) analyze(state.ids); else paint();
  };
})();
