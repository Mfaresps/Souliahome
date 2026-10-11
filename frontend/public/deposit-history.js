/* Deposit audit view. Financial data is loaded from the admin-only history API. */
const _depLogLabels = {
  title:['سجل العربون','Deposit history'], desc:['كل الإيصالات المسجلة ومراجعتها، مرتبّة حسب تاريخ التسجيل.','Registered receipts and their review, ordered by registration date.'],
  review:['قيد المراجعة','Awaiting review'], all:['كل التواريخ','All dates'], today:['اليوم','Today'], yesterday:['أمس','Yesterday'], custom:['فترة محددة','Date range'],
  from:['من تاريخ','From date'], to:['إلى تاريخ','To date'], vault:['الخزنة / طريقة الدفع','Vault / payment method'], allVaults:['كل الخزن','All vaults'],
  min:['المبلغ من','Minimum amount'], max:['المبلغ إلى','Maximum amount'], sender:['اسم المرسل أو الهاتف أو InstaPay','Sender name, phone or InstaPay'],
  search:['الطلب أو العميل أو الموظف','Order, customer or employee'], status:['الحالة','Status'], allStatuses:['كل الحالات','All statuses'], reset:['مسح الفلاتر','Reset filters'],
  refresh:['تحديث','Refresh'], date:['تاريخ التسجيل','Registered on'], order:['الطلب / العميل','Order / customer'], amount:['المبلغ / الخزنة','Amount / vault'],
  person:['المحوّل','Sender'], employee:['سجّل بواسطة','Registered by'], approver:['راجعه / وافق عليه','Reviewed / approved by'], receipt:['الإيصال','Receipt'],
  count:['إيصالات مسجلة','Registered receipts'], sum:['إجمالي مبالغ النتائج','Total receipt amounts'], pending:['قيد المراجعة','Awaiting review'], approved:['معتمد','Approved'],
  empty:['لا توجد إيصالات مطابقة للفلاتر.','No receipts match these filters.'], loading:['جارٍ تحميل السجل…','Loading history…'], previous:['السابق','Previous'], next:['التالي','Next'],
  unavailable:['الصورة غير متاحة','Image unavailable'], manual:['عملية بيع يدوية','Manual sale'], withdrawn:['مسحوب','Withdrawn'],
  senderName:['اسم المحوّل كما في الإيصال (اختياري)','Sender name on receipt (optional)'], senderHandle:['عنوان المحوّل في InstaPay (اختياري)','Sender InstaPay address (optional)'],
  senderPhone:['رقم هاتف المرسل (اختياري)','Sender phone number (optional)'], details:['تفاصيل التحويل','Transfer details'], transfer:['التحويل','Transfer'],
  reference:['مرجع التحويل','Transfer reference'], identifier:['معرّف السجل','Record ID'], destination:['الخزنة المستقبلة','Receiving vault'],
  viewDetails:['عرض التفاصيل','View details'], close:['إغلاق','Close'], currency:['جنيه مصري','EGP'], ledger:['رقم حركة الخزنة','Vault transaction number'],
  reviewDate:['تاريخ المراجعة','Reviewed on'],
  screenTime:['وقت الشاشة التقريبي','Approx. screenshot clock'],
  screenTimeHint:['قراءة ساعة الهاتف من الصورة؛ لا تحدد التاريخ أو صباحًا/مساءً، ولا تعني وقت تسجيل العربون أو إرساله.','Phone clock read from the image; does not establish a date, AM/PM, deposit registration or sending time.'],
  embeddedClock:['ساعة لقطة العميل الداخلية','Clock on the embedded customer screenshot'],
  outerClock:['ساعة الهاتف الظاهرة أعلى الصورة','Phone clock at the top of the image'],
  reviewedClock:['وقت شاشة راجعه الموظف','Screenshot clock reviewed by the employee'],
  sumsHint:['يشمل كل حالات الإيصالات في النتائج، وليس صافي رصيد الخزنة.','Includes all receipt statuses in the results; this is not the net vault balance.'],
};
function _depLogText(key) { return _depLogLabels[key]?.[currentLang === 'en' ? 1 : 0] || key; }
let _depLogSequence=0, _depLogTimer, _depLogState={period:'today',page:'1'};
let _depLogRows=new Map();
let _depLogFingerprint='',_depLogFinancialSnapshot='',_depLogBackgroundTimer;
const _depLogRequests=new Map();
let _depLogImageSequence=0,_depLogDetailImageUrl='';
const _depLogFields=['period','from','to','method','min','max','sender','search','status','screenshotTime','page'];
function _depLogUrl() {
  const query=new URLSearchParams();
  _depLogFields.forEach(key=>{if(_depLogState[key] && !(key==='period'&&_depLogState[key]==='today') && !(key==='page'&&_depLogState[key]==='1'))query.set(key,_depLogState[key]);});
  return '#shopify-orders/deposits/log'+(query.size?'?'+query.toString():'');
}
function renderSpDepositHistory(readUrl=false) {
  const host=qs('#sp-deposit-log-content'); if(!host||!isAdmin())return;
  _depLogFingerprint='';
  if(readUrl){const query=new URLSearchParams(location.hash.split('?')[1]||'');_depLogState={period:'today',page:'1'};_depLogFields.forEach(k=>{if(query.has(k))_depLogState[k]=query.get(k);});}
  const L=k=>esc(_depLogText(k));
  const input=(key,label,type='text')=>`<label class="dep-log-field"><span>${L(label)}</span><input id="dep-log-${key}" type="${type}" ${type==='number'?'min="0" step="0.01" inputmode="decimal"':''} ${key==='sender'?'maxlength="120" placeholder="01xxxxxxxxx / name@instapay"':''} value="${esc(_depLogState[key]||'')}" oninput="_depLogFilter('${key}',this.value,true)"></label>`;
  host.innerHTML=`<section class="dep-log"><header class="dep-log-header"><div><h2>${L('title')}</h2><p>${L('desc')}</p></div><div class="dep-log-actions"><a class="btn btn-outline" href="#shopify-orders/deposits" onclick="event.preventDefault();switchShopifySubnav('deposits')">${L('review')}</a><button class="btn btn-outline" onclick="_depLogLoad()">${L('refresh')}</button></div></header>
    <div class="dep-log-summary" id="dep-log-summary" aria-live="polite"></div>
    <div class="dep-log-filters"><div class="dep-log-period" role="group" aria-label="${L('date')}">${['all','today','yesterday','custom'].map(p=>`<button class="btn btn-outline ${_depLogState.period===p?'selected':''}" data-period="${p}" aria-pressed="${_depLogState.period===p}" onclick="_depLogFilter('period','${p}')">${L(p)}</button>`).join('')}</div>
    <div class="dep-log-dates" id="dep-log-dates" ${_depLogState.period==='custom'?'':'hidden'}>${input('from','from','date')}${input('to','to','date')}</div>
    <div class="dep-log-filter-grid"><label class="dep-log-field"><span>${L('vault')}</span><select id="dep-log-method" onchange="_depLogFilter('method',this.value)"><option value="">${L('allVaults')}</option>${['كاش','فودافون كاش','Instapay','تحويل بنكي'].map(m=>`<option value="${esc(m)}" ${_depLogState.method===m?'selected':''}>${esc(_payMethodLabel(m))}</option>`).join('')}</select></label>
    ${input('min','min','number')}${input('max','max','number')}${input('sender','sender')}${input('search','search')}${input('screenshotTime','screenTime','time')}
    <label class="dep-log-field"><span>${L('status')}</span><select id="dep-log-status" onchange="_depLogFilter('status',this.value)"><option value="">${L('allStatuses')}</option>${['معلق','معتمد','مرفوض','ملغي','مُسترد','مسحوب'].map(s=>`<option value="${esc(s)}" ${_depLogState.status===s?'selected':''}>${esc(s==='مسحوب'?_depLogText('withdrawn'):_spReceiptStatus(s))}</option>`).join('')}</select></label></div>
    <button class="btn btn-outline dep-log-reset" onclick="_depLogState={period:'today',page:'1'};history.replaceState(null,'',_depLogUrl());renderSpDepositHistory()">${L('reset')}</button></div>
    <div id="dep-log-error" class="dep-log-error" role="alert" hidden></div><div id="dep-log-progress" role="status" aria-live="polite">${L('loading')}</div>
    <div id="dep-log-results"></div><footer id="dep-log-pagination" class="dep-log-pagination"></footer></section>`;
  _depLogLoad();
}
function _depLogFilter(key,value,debounce=false) {
  _depLogState[key]=value;_depLogState.page='1';
  if(key==='period'){
    if(value!=='custom'){delete _depLogState.from;delete _depLogState.to;qs('#dep-log-from').value='';qs('#dep-log-to').value='';}
    qs('#dep-log-dates').hidden=value!=='custom';
    document.querySelectorAll('.dep-log-period button').forEach(b=>{b.classList.toggle('selected',b.dataset.period===value);b.setAttribute('aria-pressed',String(b.dataset.period===value));});
  }
  history.replaceState(null,'',_depLogUrl());clearTimeout(_depLogTimer);
  ++_depLogSequence; // An old response must not replace results for newly typed filters.
  if(debounce)_depLogTimer=setTimeout(_depLogLoad,300);else _depLogLoad();
}
function _depLogPage(page) {_depLogState.page=String(page);history.replaceState(null,'',_depLogUrl());_depLogLoad();}
function _depLogDate(value) {
  if(!value)return '—';const date=new Date(value);if(!Number.isFinite(date.getTime()))return '—';
  return date.toLocaleString(currentLang==='en'?'en-GB':'ar-EG',{timeZone:'Africa/Cairo',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function _depLogId(value) { return encodeURIComponent(String(value || '')).replace(/'/g,'%27'); }
function _depLogTransferLabel(r) {
  const reference=String(r.reference||'');
  if(reference)return reference.length>18?reference.slice(0,8)+'…'+reference.slice(-6):reference;
  const id=String(r.id||'');
  return (id.startsWith('deposit:')?'DEP · ':'DR · ')+id.slice(-8);
}
function _depLogStatusHtml(r) {
  return `<span class="dep-log-status ${r.status==='معتمد'?'approved':r.status==='معلق'?'pending':'neutral'}"><i aria-hidden="true"></i>${esc(r.status==='مسحوب'?_depLogText('withdrawn'):_spReceiptStatus(r.status))}</span>`;
}
function _depLogSenderHtml(r) {
  return `<div class="dep-log-sender"><span class="dep-log-person-icon" aria-hidden="true">${esc((r.senderName||r.senderHandle||'').slice(0,1).toUpperCase()||'↗')}</span><div>${esc(r.senderName||'—')}${r.senderPhone?`<small><bdi class="dep-log-phone">${esc(r.senderPhone)}</bdi></small>`:''}${r.senderHandle?`<small><bdi>${esc(r.senderHandle)}</bdi></small>`:''}</div></div>`;
}
function _depLogReceiptSenderHtml(receipt) {
  const r={senderName:receipt.senderName??receipt.ocr?.senderName??'',senderHandle:receipt.senderHandle??receipt.ocr?.senderHandle??'',senderPhone:receipt.senderPhone??receipt.ocr?.senderPhone??''};
  if(!r.senderName&&!r.senderHandle&&!r.senderPhone)return '';
  return `<div class="spdep-sender-block"><small>${esc(_depLogText('person'))}</small>${_depLogSenderHtml(r)}</div>`;
}
function _depLogScreenTimeHtml(receipt, compact=false) {
  const value=receipt.screenshotTime??receipt.ocr?.screenshotTime;
  if(!value||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))return '';
  return `<small class="dep-screen-time" title="${esc(_depLogText('screenTimeHint'))}">${compact?'':esc(_depLogText('screenTime'))+': '}<bdi>${esc(value)}</bdi> ≈</small>`;
}
function _depLogOpenDetails(id) {
  const r=_depLogRows.get(id);if(!r||!isAdmin())return;
  const L=k=>esc(_depLogText(k));
  const field=(label,value)=>`<div><dt>${L(label)}</dt><dd>${esc(value||'—')}</dd></div>`;
  openModal(`<section class="dep-transfer"><header class="dep-transfer-header"><div><small>${L('details')}</small><h3>${esc(_payMethodLabel(r.method))}</h3></div>${_depLogStatusHtml(r)}</header>
    <div class="dep-transfer-image" data-receipt-id="${esc(r.id)}">${r.imageDeleted?`<small>${L('unavailable')}</small>`:`<span role="status">${L('loading')}</span>`}</div>
    <div class="dep-transfer-amount"><bdi>${esc(fmtN(r.amount))}</bdi><span>${L('currency')}</span></div>
    <div class="dep-transfer-route"><div><small>${L('person')}</small>${_depLogSenderHtml(r)}</div><span class="dep-transfer-arrow" aria-hidden="true">↓</span><div><small>${L('destination')}</small><strong>${payMethodIcon(r.method,24)}${esc(_payMethodLabel(r.method))}</strong></div></div>
    ${r.screenshotTime?`<div class="dep-screen-time-panel"><small>${L('screenTime')}</small><bdi>${esc(r.screenshotTime)} ≈</bdi><small>${L(r.screenshotTimeSource==='reviewed'?'reviewedClock':r.screenshotTimeSource==='embedded-status-bar'?'embeddedClock':'outerClock')}</small><p>${L('screenTimeHint')}</p></div>`:''}
    <dl class="dep-transfer-fields">${field('reference',r.reference)}${field('identifier',r.id)}${field('order',r.orderNumber?'#'+String(r.orderNumber).replace(/^#+/,''):_depLogText('manual'))}${field('date',_depLogDate(r.submittedAt))}${field('employee',r.submittedBy)}${field('approver',r.reviewedBy)}${r.reviewedAt?field('reviewDate',_depLogDate(r.reviewedAt)):''}${r.vaultTxNo?field('ledger',r.vaultTxNo):''}</dl>
    <footer class="dep-transfer-footer"><button class="btn btn-primary" onclick="_depLogCloseDetails()">${L('close')}</button></footer></section>`,'max-width:560px');
  _depLogReleaseImage();
  if(!r.imageDeleted)_depLogLoadImage(r.id);
}
function _depLogReleaseImage(){++_depLogImageSequence;if(_depLogDetailImageUrl)URL.revokeObjectURL(_depLogDetailImageUrl);_depLogDetailImageUrl='';}
function _depLogCloseDetails(){_depLogReleaseImage();closeModal();}
async function _depLogLoadImage(id){
  const sequence=++_depLogImageSequence,host=qs('.dep-transfer-image');if(!host||host.dataset.receiptId!==id)return;
  try{
    const blob=await api(`/shopify/deposit-receipts/${encodeURIComponent(id)}/image`,{responseType:'blob'});
    if(sequence!==_depLogImageSequence||!host.isConnected)return;
    _depLogDetailImageUrl=URL.createObjectURL(blob);
    const button=document.createElement('button');button.type='button';button.className='dep-transfer-image-open';button.setAttribute('aria-label',t('spDepView'));button.onclick=()=>_spViewReceipt(id,button);
    const img=document.createElement('img');img.alt=t('spDepReceipts');img.src=_depLogDetailImageUrl;button.appendChild(img);host.replaceChildren(button);
  }catch(error){if(sequence!==_depLogImageSequence||!host.isConnected)return;host.textContent=error.message||_depLogText('unavailable');const retry=document.createElement('button');retry.type='button';retry.className='btn btn-outline';retry.textContent=_depLogText('refresh');retry.onclick=()=>_depLogLoadImage(id);host.appendChild(retry);}
}
function _depLogBackgroundRefresh(){
  if(_spSubnavTab!=='deposit-log'||!isAdmin())return;
  const snapshot=JSON.stringify([(_shopifyOrders||[]).filter(o=>o.depositReceipts?.length).map(o=>[o._id,o.ref,o.client,o.depositReceipts]),
    (transactions||[]).filter(t=>t.depositReceipts?.length||t.deposits?.length).map(t=>[t._id,t.ref,t.client,t.cancelled,t.deposits,t.depositReceipts])]);
  if(snapshot===_depLogFinancialSnapshot)return;
  _depLogFinancialSnapshot=snapshot;clearTimeout(_depLogBackgroundTimer);
  _depLogBackgroundTimer=setTimeout(()=>_depLogLoad(true),400);
}
async function _depLogLoad(silent=false) {
  if(_spSubnavTab!=='deposit-log'||!isAdmin()||!qs('#dep-log-results'))return;
  const sequence=++_depLogSequence, progress=qs('#dep-log-progress');progress.hidden=!!silent;qs('#dep-log-error').hidden=true;
  const query=new URLSearchParams();_depLogFields.forEach(k=>{if(_depLogState[k])query.set(k,_depLogState[k]);});
  try{
    const key=query.toString();
    if(!_depLogRequests.has(key)){
      const request=api('/shopify/deposit-receipts/history?'+key);_depLogRequests.set(key,request);
      request.finally(()=>{if(_depLogRequests.get(key)===request)_depLogRequests.delete(key);}).catch(()=>{});
    }
    const data=await _depLogRequests.get(key);
    if(sequence!==_depLogSequence||_spSubnavTab!=='deposit-log')return;
    _depLogState.page=String(data.page);history.replaceState(null,'',_depLogUrl());
    const fingerprint=JSON.stringify(data);if(fingerprint===_depLogFingerprint)return;_depLogFingerprint=fingerprint;
    _depLogRows=new Map(data.rows.map(r=>[r.id,r]));
    const L=k=>esc(_depLogText(k));
    qs('#dep-log-summary').innerHTML=[['count',data.total],['sum',data.summary.totalAmount],['pending',data.summary.pending],['approved',data.summary.approved]].map(([k,v])=>`<div class="dep-log-kpi" data-kpi="${k}"><small>${L(k)}${k==='sum'?` <span class="dep-log-kpi-info" tabindex="0" title="${L('sumsHint')}" aria-label="${L('sumsHint')}">ⓘ</span>`:''}</small><strong><bdi>${esc(fmtN(v))}</bdi>${k==='sum'?'<span class="dep-log-kpi-currency">EGP</span>':''}</strong></div>`).join('');
    const columns=['transfer','screenTime','order','amount','person','employee','approver','status','details'];
    qs('#dep-log-results').innerHTML=data.rows.length?`<div class="dep-log-table-wrap"><table class="dep-log-table"><thead><tr>${columns.map(k=>`<th scope="col">${L(k)}</th>`).join('')}</tr></thead><tbody>${data.rows.map(r=>{
      const link=r.source==='shopify'?`openSpOrderPeek(decodeURIComponent('${_depLogId(r.orderId)}'))`:r.orderId?`openOrderView(decodeURIComponent('${_depLogId(r.orderId)}'))`:'';
      const cells=[`<button class="dep-log-reference" title="${esc(r.reference||r.id)}" onclick="_depLogOpenDetails(decodeURIComponent('${_depLogId(r.id)}'))"><bdi>${esc(_depLogTransferLabel(r))}</bdi></button><small><time datetime="${esc(r.submittedAt)}">${esc(_depLogDate(r.submittedAt))}</time></small>`,_depLogScreenTimeHtml(r,true) || '—',`${link?`<button class="dep-log-order" onclick="${link}">#${esc(String(r.orderNumber).replace(/^#+/,''))||'—'}</button>`:`<b>${L('manual')}</b>`}<small>${esc(r.client||'—')}</small>`,
        `<bdi class="dep-log-money">${fmtJ(r.amount)}</bdi><small class="dep-log-method">${payMethodIcon(r.method,16)}${esc(_payMethodLabel(r.method))}</small>`,_depLogSenderHtml(r),
        esc(r.submittedBy||'—'),`${esc(r.reviewedBy||'—')}${r.reviewedAt?`<small>${esc(_depLogDate(r.reviewedAt))}</small>`:''}`,
        _depLogStatusHtml(r),
        `<button class="btn btn-outline dep-log-view" onclick="_depLogOpenDetails(decodeURIComponent('${_depLogId(r.id)}'))">${L('viewDetails')}</button>`];
      return `<tr>${cells.map((cell,i)=>`<td data-label="${L(columns[i])}">${cell}</td>`).join('')}</tr>`;
    }).join('')}</tbody></table></div>`:`<div class="dep-log-empty">${L('empty')}</div>`;
    qs('#dep-log-pagination').innerHTML=`<span>${data.total} · ${data.page} / ${data.pages}</span><div><button class="btn btn-outline" ${data.page<=1?'disabled':''} onclick="_depLogPage(${data.page-1})">${L('previous')}</button><button class="btn btn-outline" ${data.page>=data.pages?'disabled':''} onclick="_depLogPage(${data.page+1})">${L('next')}</button></div>`;
  }catch(error){if(sequence!==_depLogSequence||_spSubnavTab!=='deposit-log')return;const e=qs('#dep-log-error');e.textContent=error.message||String(error);e.hidden=false;}
  finally{if(sequence===_depLogSequence&&_spSubnavTab==='deposit-log')progress.hidden=true;}
}
