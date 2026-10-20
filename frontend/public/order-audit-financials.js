/* Each row belongs to one category; selecting several categories is a union. */
const AUDIT_FIN_SCOPES = [
  { id: 'synced', label: 'المتزامن', hint: 'طلبات مسجّلة في سوليا' },
  { id: 'pending-deposit', label: 'في انتظار الموافقة بديبوزت', hint: 'عربون معتمد أو قيد المراجعة' },
  { id: 'pending-without-deposit', label: 'في انتظار الموافقة — شحن بدون ديبوزت', hint: 'تم اختيار الشحن بدون عربون' },
  { id: 'pending-no-choice', label: 'لم يسجل ويحتاج متابعة', hint: 'طلبات ستفقد تحتاج قرار' },
  { id: 'cancelled', label: 'المرفوض / الملغي', hint: 'الطلبات الملغاة أو المرفوضة' },
  { id: 'unsynced', label: 'غير المتزامن / المفقود', hint: 'طلبات مفقودة أو فشل تسجيلها' },
];
let auditFinScopes = ['synced'];
function normalizeAuditFinScopes(scope) {
  if (scope === undefined) return [...auditFinScopes];
  const ids = Array.isArray(scope) ? scope : [scope];
  if (ids.includes('all')) return AUDIT_FIN_SCOPES.map(option => option.id);
  const expanded = ids.flatMap(id => id === 'pending' ? ['pending-deposit', 'pending-without-deposit', 'pending-no-choice'] : [id]);
  return AUDIT_FIN_SCOPES.map(option => option.id).filter(id => expanded.includes(id));
}
function auditFinRowScope(row) {
  if (row.cancelled || row.syncStatus === 'cancelled') return 'cancelled';
  if (row.registered) return 'synced';
  if (row.syncStatus === 'pending') {
    if (Number(row.depositApproved) > 0 || Number(row.depositPending) > 0) return 'pending-deposit';
    if (row.shipWithoutDeposit) return 'pending-without-deposit';
    return 'pending-no-choice';
  }
  return 'unsynced';
}
function setAuditFinScopes(scope) {
  auditFinScopes = normalizeAuditFinScopes(scope);
  if (currentAuditData) renderAuditFinancials(currentAuditData);
}
function toggleAuditFinScope(id) {
  setAuditFinScopes(auditFinScopes.includes(id) ? auditFinScopes.filter(value => value !== id) : [...auditFinScopes, id]);
}
function syncAuditFinScopePicker(data) {
  const options = document.getElementById('oa-fin-scope-options');
  if (!options) return;
  if (!options.children.length) options.innerHTML = AUDIT_FIN_SCOPES.map(option => `
    <label class="oa-fin-picker-option">
      <input type="checkbox" value="${option.id}" onchange="toggleAuditFinScope(this.value)">
      <span class="oa-fin-picker-option-text"><strong>${option.label}</strong><small>${option.hint}</small></span>
      <span class="oa-fin-picker-count" data-fin-count="${option.id}">0</span>
    </label>`).join('');
  const counts = new Map(AUDIT_FIN_SCOPES.map(option => [option.id, 0]));
  (data.rows || []).forEach(row => { const id = auditFinRowScope(row); counts.set(id, counts.get(id) + 1); });
  for (const option of AUDIT_FIN_SCOPES) {
    options.querySelector(`input[value="${option.id}"]`).checked = auditFinScopes.includes(option.id);
    options.querySelector(`[data-fin-count="${option.id}"]`).textContent = fmtNum(counts.get(option.id));
  }
  const selected = AUDIT_FIN_SCOPES.filter(option => auditFinScopes.includes(option.id));
  const label = document.getElementById('oa-fin-scope-label');
  if (label) label.textContent = !selected.length ? 'اختر حالات الطلبات' : selected.length === AUDIT_FIN_SCOPES.length ? 'كل الحالات' : selected.length === 1 ? selected[0].label : `${fmtNum(selected.length)} حالات محددة`;
  const chips = document.getElementById('oa-fin-selected');
  if (chips) chips.innerHTML = selected.map(option => `<button type="button" onclick="toggleAuditFinScope('${option.id}')" aria-label="إزالة ${option.label}">${option.label}<span aria-hidden="true">×</span></button>`).join('');
}
document.addEventListener('click', event => {
  const picker = document.getElementById('oa-fin-scope');
  if (picker?.open && !picker.contains(event.target)) picker.open = false;
});
document.addEventListener('keydown', event => {
  const picker = document.getElementById('oa-fin-scope');
  if (event.key === 'Escape' && picker?.open) { picker.open = false; picker.querySelector('summary').focus(); }
});
