/* Presentation shared by the financial and advertising sections. */
(() => {
  'use strict';
  const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n=value=>Number(value).toLocaleString('en-US',{maximumFractionDigits:2});
  const cash=value=>value==null?'—':`${n(value)} EGP`;
  const paths={
    chart:'<path d="M3 3v18h18M7 15l4-5 4 3 5-8"/>',
    sales:'<path d="M3 3h2l2 12h12l2-8H6M9 20h.01M18 20h.01"/>',
    box:'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9M7 5.8l9 5"/>',
    truck:'<path d="M3 5h11v12H3zM14 9h4l3 4v4h-7M6 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/>',
    profit:'<path d="m3 17 6-6 4 4 8-10M15 5h6v6"/>',
    percent:'<path d="m5 19 14-14"/><circle cx="7" cy="7" r="3"/><circle cx="17" cy="17" r="3"/>',
    target:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    ads:'<path d="m3 10 14-6v16L3 14v-4Zm14-2 4-2v12l-4-2M6 15l2 6h4l-2-5"/>',
    wallet:'<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 8V5a2 2 0 0 1 2-2h12M16 11h5v5h-5a2.5 2.5 0 0 1 0-5Z"/>',
    orders:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2M15 4V2M9 10h6M9 14h6M9 18h3"/>',
    compare:'<path d="M3 7h17l-4-4M21 17H4l4 4M20 7l-4 4M4 17l4-4"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2"/>',
    report:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8M8 17h5"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
  };
  const icon=name=>`<svg class="oai-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.chart}</svg>`;
  const date=value=>{const d=new Date(value);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('ar-EG',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(d):'—';};
  const period=s=>s.data?.period?`${date(s.data.period.fromDate)} — ${date(s.data.period.toDate)}`:`أوردر ${s.data?.from??'—'} — ${s.data?.to??'—'}`;
  const previousLabel=s=>(s.comparison?.windows||[]).map(w=>`${date(w.fromDate)} — ${date(w.toDate)}`).join(' / ');
  function currentFinancial(s) {
    const rows=typeof auditFinScopeRows==='function'?auditFinScopeRows(s.data,s.scopes):s.data.rows||[];
    const sum=(list,key)=>list.reduce((total,row)=>total+(Number(row[key])||0),0),registered=rows.filter(row=>row.registered);
    const sales=sum(rows,'orderTotal'),profit=sum(registered,'netProfit'),registeredSales=sum(registered,'orderTotal');
    const pending=rows.filter(row=>!row.registered&&row.syncStatus==='pending'&&!row.cancelled);
    const estimatedProfit=profit+sum(pending,'orderTotal')-sum(pending,'productCost')-sum(pending,'shippingCost');
    const profitSales=registeredSales+sum(pending,'orderTotal');
    return {orders:rows.length,sales,productCost:sum(rows,'productCost'),shippingCost:rows.reduce((total,row)=>total+(row.actualShippingKnown?Number(row.actualShipCost)||0:0),0),shippingKnown:rows.filter(row=>row.actualShippingKnown).length,shippingUnknown:rows.filter(row=>row.actualShippingKnown===false||!row.registered).length,profit:registered.length?profit:null,margin:registeredSales>0?profit/registeredSales*100:null,estimatedProfit:registered.length||pending.length?estimatedProfit:null,estimatedMargin:profitSales>0?estimatedProfit/profitSales*100:null,average:rows.length?sales/rows.length:null,registeredOrders:registered.length,pendingOrders:pending.length};
  }
  const profit=m=>m?(m.pendingOrders?m.estimatedProfitAfterAdvertising:m.profitAfterAdvertising):null;
  const margin=m=>m?(m.pendingOrders?(m.revenue>0&&profit(m)!=null?profit(m)/m.revenue*100:null):m.netMargin):null;
  const beforeAdvertising=m=>profit(m)==null?null:Math.round((profit(m)+m.spend)*100)/100;
  function change(s,current,previous,{lower=false,points=false}={}) {
    if (!s.compare||!s.data.period) return '';
    if (s.busy) return '<div class="oai-change neutral">جارٍ المقارنة…</div>';
    if (!s.comparison?.financials||current==null||previous==null||!Number.isFinite(current)||!Number.isFinite(previous)) return '<div class="oai-change neutral">لا تتوفر مقارنة</div>';
    const difference=current-previous;
    const text=points?`${difference>0?'+':''}${n(difference)} نقطة`:previous===0?(difference===0?'دون تغيير':'بدون أساس سابق للنسبة'):`${difference>0?'+':''}${n(difference/Math.abs(previous)*100)}%`;
    const tone=difference===0?'neutral':(lower?difference<0:difference>0)?'good':'bad';
    return `<div class="oai-change ${tone}" title="السابق: ${e(n(previous))}"><span aria-hidden="true">${difference===0?'−':difference>0?'↗':'↘'}</span> ${text}<small>السابق: <bdi>${n(previous)}</bdi></small></div>`;
  }
  function metric(s,{key,label,value,hint,type='money',glyph='chart',previous,lower=false,featured=false}) {
    const display=value==null?'—':type==='percent'?`${n(value)}%`:type==='ratio'?`${n(value)}×`:type==='number'?n(value):cash(value);
    return `<article class="oam-kpi ${featured?'profit':''}" data-metric="${key}" title="${e(hint)}"><div class="oai-kpi-top"><span>${label}</span><i>${icon(glyph)}</i></div><strong class="${value<0?'oam-negative':''}" dir="ltr">${display}</strong>${change(s,value,previous,{lower,points:type==='percent'})}<small class="oai-kpi-hint">${hint}</small></article>`;
  }
  function comparisonInfo(s,advertising=false) {
    if (!s.compare||!s.data.period) return '';
    if (s.busy) return '<div class="oai-comparison-info" role="status">جارٍ تجهيز الفترة السابقة بنفس حالات الطلبات…</div>';
    if(s.comparison?.error)return `<div class="oam-error" role="alert">${e(s.comparison.error)} <button type="button" class="oam-button" data-comparison-retry>إعادة المحاولة</button></div>`;
    if(!s.comparison)return '';
    const basis=s.comparison.basis==='previous-days'?'فترة سابقة بنفس عدد الأيام':s.comparison.basis==='selected-months'?'شهور سابقة بنفس توزيع الاختيار':'الشهر الكامل يقارن بكامل السابق، والجزئي بنفس الأيام';
    const profitPeriods=advertising&&s.result?`<div class="oai-profit-periods" data-period-comparison><div data-comparison-current><small>الفترة الحالية${s.result.pendingOrders?' · تقديري':''}</small><bdi>${cash(profit(s.result))}</bdi><small>${e(period(s))}</small></div><div data-comparison-previous><small>الفترة السابقة${s.comparison.metrics.pendingOrders?' · تقديري':''}</small><bdi>${cash(profit(s.comparison.metrics))}</bdi><small>${e(previousLabel(s))}</small></div></div>`:'';
    return `<div class="oai-comparison-info">${icon('compare')}<div><b>${advertising?'مقارنة ربح الفترتين بعد الإعلان':'المقارنة: '+e(previousLabel(s))}</b>${profitPeriods}<small>نفس حالات الطلبات · ${basis}.${!s.comparison.financials.orders?' لا توجد طلبات ضمن الحالات المختارة في الفترة السابقة.':''}</small>${advertising?`<small>الحالي: ${s.ids.length} فواتير مختارة · السابق: ${s.comparison.metrics.expenseCount} فواتير ${s.comparison.expenseMode==='selected'?'مختارة':'إعلانات معتمدة تلقائيًا'}. راجع الفواتير لتوحيد نطاق المقارنة.${!s.comparison.metrics.expenseCount?' لا توجد فواتير سابقة؛ ROAS السابق غير محسوب.':''}${s.comparison.outsideExpenseCount?` توجد ${n(s.comparison.outsideExpenseCount)} فواتير خارج فترة المقارنة.`:''}</small>`:''}</div>${advertising?'<button type="button" class="oam-button" data-previous>فواتير الفترة السابقة</button>':''}</div>`;
  }
  function financial(s,actions) {
    const root=document.getElementById('oa-financials');if(!root)return;
    root.classList.add('oai-financial-grid');
    root.closest('.card')?.classList.add('oai-financial-card');
    const f=currentFinancial(s),p=s.comparison?.financials;
    const estimated=!!f.pendingOrders,matched=s.busy?null:s.result;
    const before=matched?beforeAdvertising(matched):estimated?f.estimatedProfit:f.profit;
    const beforeMargin=matched?(matched.revenue>0&&before!=null?before/matched.revenue*100:null):estimated?f.estimatedMargin:f.margin;
    const previousBefore=s.comparison?.metrics?beforeAdvertising(s.comparison.metrics):p?.profit;
    const previousBeforeMargin=s.comparison?.metrics?(s.comparison.metrics.revenue>0&&previousBefore!=null?previousBefore/s.comparison.metrics.revenue*100:null):p?.margin;
    root.innerHTML=`<div class="oai-fin-toolbar"><span>${icon('calendar')}${e(period(s))}<b>${n(f.orders)} طلب</b></span><label class="oai-compare-toggle"><input type="checkbox" data-fin-compare ${s.compare?'checked':''} ${s.data.period?'':'disabled'}>${icon('compare')} مقارنة بالفترة السابقة</label></div>
      ${!s.data.period?'<p class="oai-wide oai-muted">اختر العرض بالتاريخ لتفعيل المقارنة بالفترة السابقة.</p>':''}
      ${[
        {key:'sales',label:'قيمة الطلبات',value:f.sales,previous:p?.sales,glyph:'sales',hint:f.pendingOrders?'تشمل الطلبات المنتظرة المختارة':'مبيعات الحالات المختارة'},
        {key:'productCost',label:'تكلفة المنتجات',value:f.productCost,previous:p?.productCost,glyph:'box',lower:true,hint:'حسب تكاليف المنتجات المتاحة'},
        {key:'shippingCost',label:'تكلفة الشحن الفعلية',value:f.shippingKnown?f.shippingCost:null,previous:p?.shippingCost,glyph:'truck',lower:true,hint:`تكلفة مؤكدة لـ${f.shippingKnown} طلبات${f.shippingUnknown?' · '+f.shippingUnknown+' بدون تكلفة مؤكدة':''}؛ مبلغ العميل غير محتسب`},
        {key:'profit',label:estimated?'الربح التقديري قبل الإعلان':'الربح قبل الإعلان',value:before,previous:previousBefore,glyph:'profit',featured:true,hint:estimated?'المسجل + المنتظر المختار؛ نفس نطاق الربح بعد الإعلان':'نفس الطلبات المستخدمة في الربح بعد الإعلان'},
        {key:'average',label:'متوسط قيمة الطلب',value:f.average,previous:p?.average,glyph:'orders',hint:'قيمة الطلبات ÷ عددها'},
        {key:'margin',label:estimated?'هامش الربح التقديري قبل الإعلان':'هامش الربح قبل الإعلان',value:beforeMargin,previous:previousBeforeMargin,glyph:'percent',type:'percent',hint:'لنفس الطلبات المختارة قبل خصم الإعلانات'},
      ].map(item=>metric(s,item)).join('')}
      <div class="oai-wide">${comparisonInfo(s)}${estimated?`<p class="oai-muted">الربح التقديري أعلاه يشمل ${n(f.registeredOrders)} طلبات مسجلة + ${n(f.pendingOrders)} طلبات منتظرة. ربح المسجل وحده قبل الإعلان: <b>${cash(f.profit)}</b>؛ ويُضاف إليه تقدير المنتظر قبل خصم الإعلان.</p>`:''}</div>`;
    root.querySelector('[data-fin-compare]').onchange=event=>actions.compare(event.target.checked);
    root.querySelector('[data-comparison-retry]')?.addEventListener('click',actions.retry);
  }
  function summary(s,m) {
    const f=currentFinancial(s),value=profit(m),quality=!!(m?.missingCostOrders||m?.unconfirmedShippingOrders),estimated=!!m?.pendingOrders;
    const headline=!m?'ملخص الفترة':!m.orders?'لا توجد طلبات قابلة للتحليل':quality?'الربح يحتاج استكمال بيانات التكلفة':value==null?'الربح غير متاح':value<0?'الإنفاق يتجاوز الربح المتاح':estimated?'نتيجة تقديرية للطلبات المختارة':'نتيجة الطلبات المسجلة';
    return `<footer class="oai-summary"><div class="oai-summary-icon">${icon('report')}</div><div><div class="oai-eyebrow">ملخص التقرير</div><h4>${headline}</h4><p>${m?`قيمة ${n(m.orders)} طلبات <b>${cash(m.revenue)}</b>، مقابل إعلانات <b>${cash(m.spend)}</b>. ${value==null?'لا توجد بيانات كافية لحساب الربح.':`الربح ${estimated?'التقديري ':''}بعد الإعلان <b class="${value<0?'oam-negative':''}">${cash(value)}</b>، وتكلفة الإعلان للطلب <b>${cash(m.costPerOrder)}</b>.`}`:`${n(f.orders)} طلبات بقيمة <b>${cash(f.sales)}</b>. ربح المسجل قبل الإعلان <b>${cash(f.profit)}</b>. اختر فواتير الإعلان لمعرفة أثرها على الربح.`}</p>${s.compare&&s.comparison?.metrics&&m?`<p class="oai-muted">ربح الفترة السابقة بعد الإعلان: <b>${cash(profit(s.comparison.metrics))}</b>${s.comparison.metrics.pendingOrders?' (تقديري)':''}. تُخصم مصروفات كل فترة بشكل مستقل.</p>`:''}${quality?`<p class="oai-quality">${icon('info')}${m.missingCostOrders?n(m.missingCostOrders)+' طلبات بتكلفة منتجات غير مكتملة. ':''}${m.unconfirmedShippingOrders?n(m.unconfirmedShippingOrders)+' طلبات بشحن فعلي غير مؤكد.':''}</p>`:''}</div></footer>`;
  }
  function profitReconciliation(s,m) {
    const before=beforeAdvertising(m),after=profit(m);
    if (before==null||after==null) return '';
    const pendingProfit=m.pendingOrders&&m.profitBeforeAdvertising!=null?before-m.profitBeforeAdvertising:null;
    return `<div class="oai-profit-reconciliation" data-profit-reconciliation><b>${icon('profit')} تفصيل حساب الفترة الحالية${m.pendingOrders?' · تقديري':''}</b><small>${e(period(s))} · ${n(m.orders)} طلبات · توضيح لنفس مؤشر الربح أعلاه</small><p><span>قبل الإعلان <bdi>${cash(before)}</bdi></span><span aria-hidden="true">−</span><span>الإعلانات <bdi>${cash(m.spend)}</bdi></span><span aria-hidden="true">=</span><span>بعد الإعلان <bdi>${cash(after)}</bdi></span></p>${pendingProfit!=null?`<small>الربح قبل الإعلان = ربح المسجل ${cash(m.profitBeforeAdvertising)} + تقدير ربح المنتظر ${cash(pendingProfit)}.</small>`:''}</div>`;
  }
  function marketing(s,h) {
    const m=s.result,p=s.comparison?.metrics,estimated=!!m?.pendingOrders;
    const outside=s.data.period?s.invoices.filter(i=>{const d=String(i.date||'').slice(0,10),period=s.data.period;return d<period.fromDate||d>period.toDate||(period.months?.length&&!period.months.includes(Number(d.slice(5,7))));}).length:0;
    return `<div class="oam-head"><div class="oai-section-title"><i>${icon('ads')}</i><div><div class="oai-eyebrow">قياس الإنفاق والعائد</div><h3>إعلانات وتسويق</h3><p>من تكلفة الإعلان إلى الربح بعد المصروفات المختارة.</p></div></div><button type="button" class="oam-button primary" data-oam="open">${icon('plus')}${s.ids.length?'تعديل فواتير الإعلان':'اختيار فواتير الإعلان'}</button></div>
      <div class="oam-scope"><span>${icon('target')} حالات التحليل: <strong>${e(h.scopeNames())}</strong></span><button type="button" class="oam-button" data-oam="scopes">تغيير الحالات</button></div>
      ${s.notice?`<div class="oam-success" role="status">✓ ${e(s.notice)}</div>`:''}
      ${s.error?`<div class="oam-error" role="alert">${e(s.error)} <button type="button" class="oam-button" data-oam="retry">إعادة المحاولة</button></div>`:''}
      ${s.busy?'<div class="oam-status" role="status">جارٍ مراجعة الفواتير وتحديث المؤشرات…</div>':''}
      ${s.invoices.length?`<details class="oai-invoices"><summary>${icon('wallet')} ${n(s.invoices.length)} فواتير مختارة <b>${cash(s.invoices.reduce((total,i)=>total+Number(i.amount||0),0))}</b><span>عرض الفواتير</span></summary><div class="oam-chips">${s.invoices.map(i=>`<span class="oam-chip">${e(i.desc||i.expenseNo||'إعلان')} · ${cash(i.amount)} · ${e(String(i.date||'').slice(0,10))}<button type="button" data-remove="${e(i._id)}" aria-label="إزالة ${e(i.desc||'المصروف')}" ${s.busy?'disabled':''}>×</button></span>`).join('')}</div></details>`:''}
      ${outside?`<div class="oai-quality">${icon('info')} ${n(outside)} فواتير خارج فترة التقرير. راجع ارتباطها بالطلبات قبل المقارنة.</div>`:''}
      ${m&&!s.busy?`<div class="oai-result-meta"><span>${icon('orders')}${n(m.orders)} طلب</span><span>${n(m.registeredOrders)} مسجل</span>${m.pendingOrders?`<span class="oai-estimate">${n(m.pendingOrders)} منتظر · النتائج تقديرية</span>`:''}</div><div class="oam-grid">${[
        {key:'spend',label:'الإنفاق الإعلاني',value:m.spend,previous:p?.spend,glyph:'wallet',lower:true,hint:'مجموع الفواتير المختارة'},
        {key:'roas',label:'العائد الإعلاني · ROAS',value:m.roas,previous:p?.roas,glyph:'target',type:'ratio',hint:'كل جنيه إعلان يقابله هذا المبلغ من قيمة الطلبات'},
        {key:'costPerOrder',label:'تكلفة الإعلان للطلب',value:m.costPerOrder,previous:p?.costPerOrder,glyph:'orders',lower:true,hint:'الإنفاق ÷ عدد الطلبات المختارة'},
        {key:'salesAfterAdvertising',label:'القيمة بعد الإعلان',value:m.salesAfterAdvertising,previous:p?.salesAfterAdvertising,glyph:'sales',hint:'قبل المنتجات والشحن؛ ليست الربح'},
        {key:'profitAfterAdvertising',label:estimated?'الربح التقديري بعد الإعلان':'الربح بعد الإعلان',value:profit(m),previous:profit(p),glyph:'profit',featured:true,hint:estimated?'يشمل الطلبات المنتظرة المختارة':'بعد تكلفة المنتجات والشحن والإعلانات'},
        {key:'netMargin',label:estimated?'هامش الربح التقديري':'هامش الربح بعد الإعلان',value:margin(m),previous:margin(p),glyph:'percent',type:'percent',hint:'الربح بعد الإعلان ÷ قيمة الطلبات'},
      ].map(item=>metric(s,item)).join('')}</div><div class="oai-mini-stats"><span>${icon('percent')} نسبة الإعلان من قيمة الطلبات <b>${m.advertisingPercent==null?'—':n(m.advertisingPercent)+'%'}</b></span><span>${icon('target')} ROAS التعادل <b>${m.breakEvenRoas==null?'—':n(m.breakEvenRoas)+'×'}</b></span></div>${comparisonInfo(s,true)}`:!s.busy?`<div class="oai-ad-empty">${icon('wallet')}<div><b>ابدأ بفواتير الإعلان</b><p>اختر فاتورة أو أكثر؛ سنحسب العائد وتكلفة الطلب وأثر الإعلان على الربح.</p></div></div>`:''}
      ${m&&!s.busy?profitReconciliation(s,m):''}
      <details class="oai-method"><summary>${icon('info')} كيف نقرأ هذه الأرقام؟</summary><p>ROAS هنا يخص الطلبات المختارة، ولا يثبت نسبتها إلى حملة إعلانية. الربح يعتمد على تكلفة المنتجات الحالية والشحن المسجل ويستثني المصروفات الأخرى. الربح قبل الإعلان وبعده يشمل نفس الطلبات؛ عند اختيار المنتظر يظهر كلاهما تقديريًا. المقارنة تستخدم نفس حالات الطلبات، مع مصروفات مستقلة لكل فترة. انخفاض إجمالي التكاليف لا يكفي وحده للحكم على تحسن الأداء.</p></details>
      ${!s.busy?summary(s,m):''}`;
  }
  window.AuditInsights={financial,marketing};
})();
