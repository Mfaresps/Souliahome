/* Admin oversight uses guarded APIs; employee workspace and point messages stay separate. */
(() => {
  let team = null, detail = null, selected = '', filter = 'all', detailKey = '';
  let owner = '', overviewRun = 0, detailRun = 0, busy = false, detailBusy = false, error = '', detailError = '';
  const now = new Date();
  let periodKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const periodQuery = () => '?period=month&periodKey=' + encodeURIComponent(periodKey);
  const host = () => document.getElementById('dash-admin-team');
  const identity = () => String(currentUser?._id || currentUser?.id || '');
  const label = (ar, en) => currentLang === 'en' ? en : ar;
  const issue = f => f.isDeliveryIssue ?? (f.autoSource === 'shipping-issue' || ['FAILED_ATTEMPT', 'RETURNED', 'DELIVERY_FAILED'].includes(f.autoTrigger) || f.reason === 'مشكلة في الاستلام');
  const waiting = f => Date.parse(f.deferredUntil || '') > Date.now();
  const number = value => fmtN(Number(value) || 0);
  const btn = (action, text, extra = '') => `<button type="button" data-team-action="${action}" ${extra}>${text}</button>`;
  const skeleton = (kind='') => `<i class="ss-skeleton ath-skeleton-line ${kind}"></i>`;
  function taskSkeleton() {
    return `<div class="ath-loading-tasks" role="status" aria-label="${label('جارٍ تحميل مهام الموظف','Loading employee tasks')}"><div class="ath-tasks" aria-hidden="true">${Array.from({length:2},()=>`<article class="ath-task"><div class="ath-task-top">${skeleton('is-ref')}${skeleton('is-short')}</div><div class="ath-task-main"><div>${skeleton()}${skeleton('is-short')}</div>${skeleton('is-button')}</div></article>`).join('')}</div></div>`;
  }
  function teamSkeleton(summary) {
    return `<div class="ath-loading" role="status" aria-label="${label('جارٍ تحميل مهام الفريق','Loading team workload')}"><div aria-hidden="true"><div class="ath-totals">${summary.map(([text])=>`<div><span>${text}</span><bdi>${skeleton('is-value')}</bdi><small>${skeleton()}</small></div>`).join('')}</div><div class="ath-layout"><aside class="ath-employees"><h4 class="ath-employees-title">${label('الموظفون','Employees')}</h4><div class="ath-employee-list">${Array.from({length:3},()=>`<div class="ath-person">${skeleton()}${skeleton('is-short')}</div>`).join('')}</div></aside><div class="ath-workspace"><div class="ath-person-header">${skeleton('is-ref')}${skeleton('is-short')}</div><div class="ath-performance">${skeleton('is-button')}${skeleton('is-button')}</div><div class="ath-person-metrics">${summary.map(([text])=>`<span>${text}<bdi>${skeleton('is-value')}</bdi></span>`).join('')}</div><div class="ath-filters">${skeleton('is-button')}${skeleton('is-button')}</div>${taskSkeleton()}</div></div></div></div>`;
  }
  function compactDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat(currentLang === 'en' ? 'en-GB' : 'ar-EG', {
      timeZone: 'Africa/Cairo', day: 'numeric', month: 'short',
      year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(date);
  }
  function taskContext(row) {
    const scheduled = row.waiting && compactDate(row.until);
    let note = String(row.note?.text || '');
    // Only omit a generated reminder when the same time is shown separately.
    if (scheduled) note = note.replace(/\s*\u2014\s*\u0645\u0648\u0639\u062f \u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/g,
      (match, value) => Date.parse(value) === Date.parse(row.until) ? '' : match);
    const text = note.split(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/g)
      .map((part, index) => index % 2 && compactDate(part) ? `<bdi>${esc(compactDate(part))}</bdi>` : esc(part)).join('');
    if (!note && !scheduled) return '';
    return `<div class="ath-context">${note ? `<div class="ath-note"><div class="ath-note-meta"><span>${label('آخر تعليق', 'Latest comment')}</span>${row.note.authorName ? `<bdi>${esc(row.note.authorName)}</bdi>` : ''}</div><p dir="auto">${text}</p></div>` : ''}${scheduled ? `<div class="ath-schedule"><span>${label('المتابعة', 'Follow-up')}</span><time datetime="${escHtml(row.until)}"><bdi>${esc(scheduled)}</bdi></time></div>` : ''}</div>`;
  }
  window.hideAdminTeamWorkspace = () => {
    overviewRun++; detailRun++; team = detail = null; selected = owner = ''; busy = detailBusy = false;
    if (host()) { host().style.display = 'none'; host().replaceChildren(); }
  };
  function metrics(user) {
    return [[label('بانتظار التأكيد', 'Awaiting confirmation'), user.pending],
      [label('متابعات مفتوحة', 'Open follow-ups'), user.followUps], [label('مشكلات توصيل', 'Delivery issues'), user.issues]];
  }
  function taskRows() {
    if (!detail) return [];
    const followups = (detail.followUps || []).map(f => ({kind:'followup', id:f.id, ref:f.orderRef || f.ticketNo, name:f.clientName,
      status:f.status, reason:f.reason, issue:issue(f), waiting:waiting(f), until:f.deferredUntil, note:f.latestComment, at:f.lastActivityAt}));
    const orders = (detail.orders || []).map(o => ({kind:'order', id:o.id, ref:o.ref, name:o.client, status:o.status,
      reason:'', issue:false, waiting:false, at:o.assignedAt, pending:o.needsConfirmation ?? (o.status === 'pending')}));
    let rows;
    if (filter === 'issues') {
      const seen = new Set();
      rows = followups.filter(f => {
        if (!f.issue) return false;
        const key = String(f.ref || f.id).replace(/^#+/,'');
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
    }
    else if (filter === 'waiting') rows = followups.filter(f => f.waiting);
    else if (filter === 'followups') rows = followups;
    else {
      const refs = new Set(followups.map(f => String(f.ref || '').replace(/^#+/,'')));
      rows = [...followups, ...orders.filter(o => o.pending && !refs.has(String(o.ref || '').replace(/^#+/,'')))];
    }
    return rows.sort((a,b) => Number(b.issue)-Number(a.issue) || Number(a.waiting)-Number(b.waiting) || (Date.parse(a.at)||0)-(Date.parse(b.at)||0));
  }
  window.renderAdminTeamWorkspace = () => {
    const el = host(); if (!el) return;
    if (!isAdmin() || owner && owner !== identity()) { window.hideAdminTeamWorkspace(); return; }
    el.style.display = '';
    el.setAttribute('aria-busy', String(busy || detailBusy));
    const totals = team?.totals || {}, users = team?.employees || [];
    const rows = taskRows(), user = users.find(u => u.id === selected);
    const summary = [[label('بانتظار التأكيد', 'Awaiting confirmation'),totals.pending],
      [label('متابعات مفتوحة', 'Open follow-ups'),totals.followUps], [label('مشكلات توصيل', 'Delivery issues'),totals.issues]];
    el.innerHTML = `<div class="ath-header"><div><h3>${label('متابعة الفريق', 'Team oversight')}</h3><p>${label('اعرف ما لدى كل موظف من طلبات ومتابعات ومشكلات.', 'Review each employee’s orders, follow-ups and delivery issues.')}</p></div><div class="ath-controls"><label>${label('الفترة (الشهر)','Period (month)')}<input type="month" data-team-period value="${escHtml(periodKey)}" aria-label="${label('الفترة (الشهر)','Period (month)')}"></label>${btn('refresh',label('تحديث ↻','Refresh ↻'),busy ? 'disabled' : '')}</div></div><p class="ath-period-help">${label('الأعداد والقوائم للفترة المختارة: الطلبات حسب تاريخ الإسناد، والمتابعات حسب تاريخ الإنشاء، والنقاط والتسليم حسب تاريخ تسجيلها. الحالات المعروضة هي الحالات الحالية.', 'Counts and lists cover the selected period: orders by assignment date, follow-ups by creation date, points and deliveries by recording date. Statuses reflect their current state.')}</p>
      ${busy && !team ? teamSkeleton(summary) : ''}
      ${error ? `<p class="ath-error" role="alert">${esc(error)} ${btn('refresh',label('إعادة المحاولة','Retry'))}</p>` : ''}
      ${team ? `<div class="ath-totals">${summary.map(([text,value],i) => `<div class="${i===2?'is-issue':''}"><span>${text}</span><bdi>${number(value)}</bdi>${i<2?`<small>${i===0?label('طلبات لم يتم تأكيدها بعد.','Orders that have not been confirmed.'):label('تذاكر لم تُغلق، تشمل المؤجلة ومشكلات التوصيل. قد تخص طلبًا بانتظار التأكيد.','Unclosed tickets, including deferred tickets and delivery issues. May refer to an order awaiting confirmation.')}</small>`:''}</div>`).join('')}</div>
      <div class="ath-layout"><aside class="ath-employees"><h4 class="ath-employees-title">${label('الموظفون','Employees')} <bdi>${number(users.length)}</bdi></h4><div class="ath-employee-list">${users.map(u => `<button type="button" class="ath-person ${u.id===selected?'is-selected':''}" data-team-action="select" data-id="${escHtml(u.id)}" aria-pressed="${u.id===selected}"><span class="ath-person-name">${esc(u.name)}</span><span class="ath-person-counts"><span>${number(u.pending)} ${label('تأكيد','to confirm')}</span><span>${number(u.followUps)} ${label('متابعة','follow-ups')}</span>${u.issues?`<b class="ath-issue-badge">${number(u.issues)} ${label('مشكلة','issues')}</b>`:''}</span></button>`).join('') || `<p>${label('لا يوجد موظفون نشطون.','No active employees.')}</p>`}</div></aside>
      <div class="ath-workspace">${user ? `<div class="ath-person-header"><div><h4>${esc(user.name)}</h4><small>${esc(user.jobTitle || '')}</small></div><span>${esc(team.periodLabel || '')}</span></div><div class="ath-performance"><span>${label('النقاط خلال الفترة','Points this period')} <bdi>${number(user.points)}</bdi></span><span>${label('تم تسليمها خلال الفترة','Delivered this period')} <bdi>${number(user.delivered)}</bdi></span></div><div class="ath-person-metrics">${metrics(user).map(([text,value])=>`<span>${text}<bdi>${number(value)}</bdi></span>`).join('')}</div>
      <div class="ath-filters" role="group" aria-label="${label('تصفية المهام','Filter tasks')}">${[['all',label('الأولوية','Priority')],['followups',label('المتابعات','Follow-ups')],['issues',label('مشكلات التوصيل','Delivery issues')],['waiting',label('المؤجلة','Waiting')]].map(([key,text])=>btn('filter',text,`data-filter="${key}" aria-pressed="${filter===key}"`)).join('')}</div>
      ${detailError ? `<p class="ath-error" role="alert">${esc(detailError)} ${btn('retry-detail',label('إعادة المحاولة','Retry'))}</p>` : ''}${detailBusy && !detail ? taskSkeleton() : detail ? `<div class="ath-tasks">${rows.map((row,i) => `<article class="ath-task ${row.issue?'is-issue':''}"><div class="ath-task-top"><strong><bdi>#${esc(row.ref || '—')}</bdi></strong><span>${row.issue?label('مشكلة توصيل','Delivery issue'):row.kind==='order'?label('طلب','Order'):label('متابعة','Follow-up')}</span>${row.waiting?`<span>${label('بانتظار الموعد','Scheduled')}</span>`:''}</div><div class="ath-task-main"><div><span dir="auto">${esc(row.name || '')}</span><p>${esc(row.kind==='order' ? row.pending ? label('بانتظار التأكيد','Awaiting confirmation') : row.status === 'approved' ? label('تم التأكيد','Confirmed') : row.status === 'rejected' ? label('مرفوض','Rejected') : row.status : row.status || '')}${row.reason?` · ${esc(row.reason)}`:''}</p></div>${btn('open',label('عرض التفاصيل ←','View details →'),`data-index="${i}"`)}</div>${taskContext(row)}</article>`).join('') || `<p class="ath-empty">${label('لا توجد مهام ضمن هذا العرض.','No tasks in this view.')}</p>`}</div><p class="ath-preview-note">${label('معاينة مختصرة لأحدث الطلبات والمتابعات. الأعداد أعلاه تشمل جميع المهام في الفترة المختارة؛ افتح التفاصيل لمتابعة الطلب.', 'A bounded preview of orders and follow-ups. Counts above cover all tasks in the selected period; open details to review an order.')}</p>`:''}` : `<p class="ath-empty">${label('اختر موظفًا لعرض مهامه.','Select an employee to review their work.')}</p>`}</div></div>`:''}`;
  };
  async function loadDetail() {
    const id=selected, account=identity(), run=++detailRun;
    const key=id+':'+periodKey;
    if(detailKey!==key)detail=null;
    detailError='';detailBusy=true;window.renderAdminTeamWorkspace();
    try {
      const result=await api('/employee-performance/team-workspace/'+encodeURIComponent(id)+periodQuery());
      if (!isAdmin()||account!==identity()||run!==detailRun||selected!==id) return;
      detail=result;detailKey=key;
    } catch(e) { if(run===detailRun) detailError=label('تعذر تحميل مهام الموظف.','Could not load employee tasks.'); }
    finally { if(run===detailRun){detailBusy=false;window.renderAdminTeamWorkspace();} }
  }
  window.loadAdminTeamWorkspace = async () => {
    if(!isAdmin()){window.hideAdminTeamWorkspace();return;}
    const account=identity();if(owner!==account){team=detail=null;selected='';filter='all';detailRun++;}owner=account;
    const run=++overviewRun;detailRun++;detailBusy=false;busy=true;error='';window.renderAdminTeamWorkspace();
    try {
      const result=await api('/employee-performance/team-workspace'+periodQuery());
      if(!isAdmin()||account!==identity()||run!==overviewRun)return;
      team={...result,employees:(result.employees||[]).filter(user=>user.active!==false)};selected=team.employees.some(u=>u.id===selected)?selected:team.employees[0]?.id||'';
      if(selected) await loadDetail();else detail=null;
    } catch(e){if(run===overviewRun)error=label('تعذر تحميل متابعة الفريق.','Could not load team oversight.');}
    finally{if(run===overviewRun){busy=false;window.renderAdminTeamWorkspace();}}
  };
  document.addEventListener('change',event=>{
    const input=event.target;
    if(!input.matches('[data-team-period]')||!host()?.contains(input)||!isAdmin())return;
    if(!/^\d{4}-\d{2}$/.test(input.value)){input.value=periodKey;return;}
    periodKey=input.value;team=detail=null;filter='all';
    window.loadAdminTeamWorkspace();
  });
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-team-action]');if(!button||!host()?.contains(button)||!isAdmin())return;
    const action=button.dataset.teamAction;
    if(action==='refresh')return window.loadAdminTeamWorkspace();
    if(action==='select'){selected=button.dataset.id;filter='all';return loadDetail();}
    if(action==='retry-detail')return loadDetail();
    if(action==='filter'){filter=button.dataset.filter;return window.renderAdminTeamWorkspace();}
    if(action==='open'){
      const row=taskRows()[Number(button.dataset.index)];if(!row)return;
      if(row.kind==='followup')goToFuAndHighlight(row.id,true,'',true);
      else {
        const account=identity();button.disabled=true;
        try {await loadShopifyOrders();if(!isAdmin()||account!==identity())return;navigateTo('shopify-orders');openSpOrderPeek(row.id);}
        catch(e){toast(label('تعذر تحميل الطلب.','Could not load the order.'),true);button.disabled=false;}
      }
    }
  });
  setInterval(()=>{if(isAdmin()&&currentPage==='dashboard'&&!document.hidden&&!busy)window.loadAdminTeamWorkspace();},60000);
})();
