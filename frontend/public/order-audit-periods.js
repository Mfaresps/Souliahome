const AUDIT_MONTH_NAMES = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
let auditPeriodInitialised = false, auditPeriodDefault = true, auditPeriodLastToday = '', auditPeriodPending = null;
let auditMonthYear = 0, auditSelectedMonths = new Set(), auditUseMonths = true;
function auditCairoToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = type => parts.find(value => value.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function syncAuditMonthSummary() {
  const label = document.getElementById('oa-month-summary');
  if (!label) return;
  const months = [...auditSelectedMonths].sort((a,b) => a-b);
  label.textContent = !auditUseMonths ? 'نطاق تاريخ مخصص' : !months.length ? 'اختر الشهور' : months.length <= 2 ? months.map(month => AUDIT_MONTH_NAMES[month-1]).join('، ') + ' ' + auditMonthYear : `${months.length} شهور · ${auditMonthYear}`;
}
function renderAuditMonths() {
  const today = auditCairoToday(), currentYear = Number(today.slice(0,4)), currentMonth = Number(today.slice(5,7));
  const year = document.getElementById('oa-month-year');
  if (!year) return;
  if (!year.options.length || Number(year.options[0].value) !== currentYear) year.innerHTML = Array.from({length:11},(_,i) => `<option value="${currentYear-i}">${currentYear-i}</option>`).join('');
  if (auditMonthYear !== Number(year.value)) { auditMonthYear = Number(year.value); auditSelectedMonths = new Set([auditMonthYear === currentYear ? currentMonth : 1]); }
  const list = document.getElementById('oa-month-options');
  if (list) list.innerHTML = AUDIT_MONTH_NAMES.map((name,i) => `<label><input type="checkbox" value="${i+1}" ${auditSelectedMonths.has(i+1)?'checked':''} ${auditMonthYear===currentYear && i+1>currentMonth?'disabled':''} onchange="toggleAuditMonth(Number(this.value),this.checked)"><span>${name}</span></label>`).join('');
  syncAuditMonthSummary();
}
function toggleAuditMonth(month, checked) {
  if (checked) auditSelectedMonths.add(month); else auditSelectedMonths.delete(month);
  auditUseMonths = true; syncAuditMonthSummary();
}
function selectCurrentAuditMonth() {
  const today = auditCairoToday();
  auditMonthYear = Number(today.slice(0,4)); auditSelectedMonths = new Set([Number(today.slice(5,7))]); auditUseMonths = true;
  document.getElementById('oa-month-year').value = String(auditMonthYear); renderAuditMonths();
}
function selectAllAuditMonths() {
  const today = auditCairoToday(), max = auditMonthYear === Number(today.slice(0,4)) ? Number(today.slice(5,7)) : 12;
  auditSelectedMonths = new Set(Array.from({length:max},(_,i) => i+1)); auditUseMonths = true; renderAuditMonths();
}
function auditPeriodDateChanged() { auditUseMonths = false; auditPeriodDefault = false; syncAuditMonthSummary(); }
async function runAuditDateSelection(options = {}) {
  let fromDate = document.getElementById('oa-date-from')?.value || '', toDate = document.getElementById('oa-date-to')?.value || '';
  const params = new URLSearchParams();
  if (auditUseMonths) {
    const months = [...auditSelectedMonths].sort((a,b) => a-b);
    if (!months.length) { toast('اختر شهراً واحداً على الأقل', true); return; }
    fromDate = `${auditMonthYear}-${String(months[0]).padStart(2,'0')}-01`;
    const last = months[months.length-1], days = new Date(Date.UTC(auditMonthYear,last,0)).getUTCDate();
    toDate = `${auditMonthYear}-${String(last).padStart(2,'0')}-${days}`;
    if (toDate > auditCairoToday()) toDate = auditCairoToday();
    params.set('months', months.join(',')); params.set('year', String(auditMonthYear));
    document.getElementById('oa-date-from').value = fromDate; document.getElementById('oa-date-to').value = toDate;
  }
  if (!fromDate || !toDate || toDate < fromDate) { toast('اختر نطاق تاريخ صحيح', true); return; }
  params.set('fromDate',fromDate); params.set('toDate',toDate); params.set('persist',options.auto?'false':'true');
  if (!options.auto) auditPeriodDefault = false;
  return runOrderAudit(params.toString());
}
async function applyAuditMonths() {
  auditUseMonths = true; setAuditRangeMode('date');
  if (!auditSelectedMonths.size) { toast('اختر شهراً واحداً على الأقل', true); return; }
  document.getElementById('oa-month-picker').open = false;
  return runAuditDateSelection();
}
window.ensureAuditDefaultPeriod = function () {
  const today = auditCairoToday();
  if (auditPeriodPending) return auditPeriodPending;
  if (auditPeriodInitialised && (!auditPeriodDefault || auditPeriodLastToday === today) && currentAuditData) return;
  if (!auditPeriodInitialised || auditPeriodDefault) {
    document.getElementById('oa-date-from').value = today.slice(0,7) + '-01'; document.getElementById('oa-date-to').value = today;
    setAuditRangeMode('date'); renderAuditMonths(); selectCurrentAuditMonth();
    auditPeriodLastToday = today; auditPeriodInitialised = true;
  }
  // Exports and history stay reachable in both date and number modes.
  const tools = document.querySelector('.oa-export-btns'), card = document.querySelector('.oa-range-bar');
  if (tools && card && tools.parentElement !== card) card.appendChild(tools);
  auditPeriodPending = runAuditDateSelection({auto:true}).finally(() => {auditPeriodPending=null;});
  return auditPeriodPending;
};
document.addEventListener('click', event => { const picker = document.getElementById('oa-month-picker'); if (picker?.open && !picker.contains(event.target)) picker.open = false; });
document.addEventListener('keydown', event => { const picker = document.getElementById('oa-month-picker'); if (event.key==='Escape' && picker?.open) {picker.open=false;picker.querySelector('summary').focus();} });
if (typeof currentPage !== 'undefined' && currentPage === 'reports' && typeof activeReportTab !== 'undefined' && activeReportTab === 'orderaudit') window.ensureAuditDefaultPeriod();
