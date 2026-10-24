/* Admin oversight uses guarded APIs; employee workspace and point messages stay separate. */
(() => {
  let team = null, detail = null, selected = '', filter = 'all';
  let owner = '', overviewRun = 0, detailRun = 0, busy = false, detailBusy = false, error = '', detailError = '';
  const host = () => document.getElementById('dash-admin-team');
  const identity = () => String(currentUser?._id || currentUser?.id || '');
  const label = (ar, en) => currentLang === 'en' ? en : ar;
  const issue = f => f.autoSource === 'shipping-issue' || ['FAILED_ATTEMPT', 'RETURNED'].includes(f.autoTrigger) || f.reason === 'مشكلة في الاستلام';
  const waiting = f => Date.parse(f.deferredUntil || '') > Date.now();
  const number = value => fmtN(Number(value) || 0);
  const btn = (action, text, extra = '') => `<button type="button" data-team-action="${action}" ${extra}>${text}</button>`;
  window.hideAdminTeamWorkspace = () => {
    overviewRun++; detailRun++; team = detail = null; selected = owner = ''; busy = detailBusy = false;
    if (host()) { host().style.display = 'none'; host().replaceChildren(); }
  };
  function metrics(user) {
    return [[label('طلبات مسندة', 'Assigned orders'), user.orders], [label('بانتظار التأكيد', 'Awaiting confirmation'), user.pending],
      [label('متابعات مفتوحة', 'Open follow-ups'), user.followUps], [label('مشكلات توصيل', 'Delivery issues'), user.issues]];
  }
  function taskRows() {
    if (!detail) return [];
    const followups = (detail.followUps || []).map(f => ({kind:'followup', id:f.id, ref:f.orderRef || f.ticketNo, name:f.clientName,
      status:f.status, reason:f.reason, issue:issue(f), waiting:waiting(f), until:f.deferredUntil, note:f.latestComment, at:f.lastActivityAt}));
    const orders = (detail.orders || []).map(o => ({kind:'order', id:o.id, ref:o.ref, name:o.client, status:o.status,
      reason:'', issue:false, waiting:false, at:o.assignedAt, pending:o.status === 'pending'}));
    let rows;
    if (filter === 'orders') rows = orders;
    else if (filter === 'issues') rows = followups.filter(f => f.issue);
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
    const totals = team?.totals || {}, users = team?.employees || [];
    const rows = taskRows(), user = users.find(u => u.id === selected);
    const summary = [[label('بانتظار التأكيد', 'Awaiting confirmation'),totals.pending],
      [label('متابعات مفتوحة', 'Open follow-ups'),totals.followUps], [label('مشكلات توصيل', 'Delivery issues'),totals.issues]];
    el.innerHTML = `<div class="ath-header"><div><h3>${label('متابعة الفريق', 'Team oversight')}</h3><p>${label('اعرف ما لدى كل موظف من طلبات ومتابعات ومشكلات.', 'Review each employee’s orders, follow-ups and delivery issues.')}</p></div>${btn('refresh',label('تحديث ↻','Refresh ↻'),busy ? 'disabled' : '')}</div>
      ${busy && !team ? `<p role="status">${label('جارٍ تحميل مهام الفريق…','Loading team workload…')}</p>` : ''}
      ${error ? `<p class="ath-error" role="alert">${esc(error)} ${btn('refresh',label('إعادة المحاولة','Retry'))}</p>` : ''}
      ${team ? `<div class="ath-totals">${summary.map(([text,value],i) => `<div class="${i===2?'is-issue':''}"><span>${text}</span><bdi>${number(value)}</bdi></div>`).join('')}</div>
      <div class="ath-layout"><aside class="ath-employees"><h4 class="ath-employees-title">${label('الموظفون','Employees')} <bdi>${number(users.length)}</bdi></h4><div class="ath-employee-list">${users.map(u => `<button type="button" class="ath-person ${u.id===selected?'is-selected':''}" data-team-action="select" data-id="${escHtml(u.id)}" aria-pressed="${u.id===selected}"><span class="ath-person-name">${esc(u.name)}</span><span class="ath-person-counts"><span>${number(u.pending)} ${label('تأكيد','to confirm')}</span><span>${number(u.followUps)} ${label('متابعة','follow-ups')}</span>${u.issues?`<b class="ath-issue-badge">${number(u.issues)} ${label('مشكلة','issues')}</b>`:''}</span></button>`).join('') || `<p>${label('لا يوجد موظفون نشطون.','No active employees.')}</p>`}</div></aside>
      <div class="ath-workspace">${user ? `<div class="ath-person-header"><div><h4>${esc(user.name)}</h4><small>${esc(user.jobTitle || '')}</small></div><span>${esc(team.periodLabel || '')}</span></div><div class="ath-performance"><span>${label('النقاط خلال الفترة','Points this period')} <bdi>${number(user.points)}</bdi></span><span>${label('تم تسليمها خلال الفترة','Delivered this period')} <bdi>${number(user.delivered)}</bdi></span></div><div class="ath-person-metrics">${metrics(user).map(([text,value])=>`<span>${text}<bdi>${number(value)}</bdi></span>`).join('')}</div>
      <div class="ath-filters" role="group" aria-label="${label('تصفية المهام','Filter tasks')}">${[['all',label('الأولوية','Priority')],['orders',label('الطلبات','Orders')],['followups',label('المتابعات','Follow-ups')],['issues',label('مشكلات التوصيل','Delivery issues')],['waiting',label('المؤجلة','Waiting')]].map(([key,text])=>btn('filter',text,`data-filter="${key}" aria-pressed="${filter===key}"`)).join('')}</div>
      ${detailBusy ? `<p role="status">${label('جارٍ تحميل مهام الموظف…','Loading employee tasks…')}</p>` : detailError ? `<p class="ath-error" role="alert">${esc(detailError)} ${btn('retry-detail',label('إعادة المحاولة','Retry'))}</p>` : detail ? `<div class="ath-tasks">${rows.map((row,i) => `<article class="ath-task ${row.issue?'is-issue':''}"><div class="ath-task-top"><strong><bdi>#${esc(row.ref || '—')}</bdi></strong><span>${row.issue?label('مشكلة توصيل','Delivery issue'):row.kind==='order'?label('طلب','Order'):label('متابعة','Follow-up')}</span>${row.waiting?`<span>${label('بانتظار الموعد','Scheduled')}</span>`:''}</div><div class="ath-task-main"><div><span dir="auto">${esc(row.name || '')}</span><p>${esc(row.kind==='order' ? row.pending ? label('بانتظار التأكيد','Awaiting confirmation') : row.status === 'approved' ? label('تم التأكيد','Confirmed') : row.status === 'rejected' ? label('مرفوض','Rejected') : row.status : row.status || '')}${row.reason?` · ${esc(row.reason)}`:''}</p></div>${btn('open',label('عرض التفاصيل ←','View details →'),`data-index="${i}"`)}</div>${row.waiting?`<small>${label('موعد المتابعة: ','Next follow-up: ')}${esc(fmtDateTime(row.until))}</small>`:''}${row.note?.text?`<div class="ath-note"><small>${label('آخر تعليق','Latest comment')} · ${esc(row.note.authorName || '')}</small><p dir="auto">${esc(row.note.text)}</p></div>`:''}</article>`).join('') || `<p class="ath-empty">${label('لا توجد مهام ضمن هذا العرض.','No tasks in this view.')}</p>`}</div><p class="ath-preview-note">${label('معاينة مختصرة لأحدث الطلبات والمتابعات. الأعداد أعلاه تشمل جميع المهام؛ افتح التفاصيل لمتابعة الطلب.', 'A bounded preview of orders and follow-ups. Counts above cover all tasks; open details to review an order.')}</p>`:''}` : `<p class="ath-empty">${label('اختر موظفًا لعرض مهامه.','Select an employee to review their work.')}</p>`}</div></div>`:''}`;
  };
  async function loadDetail() {
    const id=selected, account=identity(), run=++detailRun;
    detail=null;detailError='';detailBusy=true;window.renderAdminTeamWorkspace();
    try {
      const result=await api('/employee-performance/team-workspace/'+encodeURIComponent(id));
      if (!isAdmin()||account!==identity()||run!==detailRun||selected!==id) return;
      detail=result;
    } catch(e) { if(run===detailRun) detailError=label('تعذر تحميل مهام الموظف.','Could not load employee tasks.'); }
    finally { if(run===detailRun){detailBusy=false;window.renderAdminTeamWorkspace();} }
  }
  window.loadAdminTeamWorkspace = async () => {
    if(!isAdmin()){window.hideAdminTeamWorkspace();return;}
    const account=identity();if(owner!==account){team=detail=null;selected='';filter='all';detailRun++;}owner=account;
    const run=++overviewRun;busy=true;error='';window.renderAdminTeamWorkspace();
    try {
      const result=await api('/employee-performance/team-workspace');
      if(!isAdmin()||account!==identity()||run!==overviewRun)return;
      team={...result,employees:(result.employees||[]).filter(user=>user.active!==false)};selected=team.employees.some(u=>u.id===selected)?selected:team.employees[0]?.id||'';
      if(selected) await loadDetail();else detail=null;
    } catch(e){if(run===overviewRun)error=label('تعذر تحميل متابعة الفريق.','Could not load team oversight.');}
    finally{if(run===overviewRun){busy=false;window.renderAdminTeamWorkspace();}}
  };
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
