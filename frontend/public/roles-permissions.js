(function () {
  'use strict';
  const groups = [
    ['dashboard','Dashboard','الرئيسية',['dashboard','reports-kpis','reports-charts']],
    ['orders','Orders','الطلبات',['shopify-orders','transaction','pickup-orders','pickup-orders-edit','shopify-prepare-ship','shopify-reassign','shopify-cancel','shopify-cancel-request','shopify-edit-direct','shopify-bundle-discount-override','shopify-deposit-upload','shopify-deposit-no-image','shopify-deposit-no-image-otp','delivery-manual-confirm','delivery-view-audit']],
    ['inventory','Inventory','المخزون',['inventory','products','products-create','products-edit','products-delete','products-sku-manage','inventory-units-view','inventory-units-register','inventory-units-receive','inventory-units-allocate','inventory-units-condition','inventory-units-reconcile','inventory-units-reconcile-approve','inventory-units-print','inventory-units-manual-select','categories-view','categories-create','categories-edit','categories-delete','categories-assign-products','categories-link-suppliers']],
    ['promotions','Promotions','العروض والخصومات',['promotions-view','promotions-offers','promotions-codes','promotions-bundles','promotions-tags','promotions-audit']],
    ['movement','Movement','الحركات',['movements','approvals','carrier-import','carrier-settle-view','carrier-settle-run','carrier-settle-approve','carrier-settle-reverse']],
    ['cash','Cash Register','الخزنة',['vault','expenses','reports','reports-discounts','reports-orderaudit','reports-cancellations','reports-shipping','reports-export']],
    ['suppliers','Suppliers','الموردون',['suppliers','suppliers-create','suppliers-edit','suppliers-delete','purchase-view','purchase-create','purchase-edit-price','suppliers-tab-invoices','suppliers-tab-pos','suppliers-tab-sreturns','suppliers-tab-payments','suppliers-tab-ledger','suppliers-tab-activity','suppliers-pay','suppliers-deposit','suppliers-ledger-adjust','suppliers-write-off','suppliers-reverse','suppliers-returns','suppliers-rs-view','suppliers-rs-create','suppliers-rs-edit','suppliers-rs-status','suppliers-rs-delete','suppliers-rs-export']],
    ['employees','Employees','الموظفون',['users']],
    ['customer-service','Customer Service','خدمة العملاء',['clients','complaints','csp-view','csp-create','csp-edit','csp-delete','csp-manage-folders','csp-analytics','csp-export','csp-import']],
    ['settings','Settings','الإعدادات',['settings']],
  ];
  const restrictedRows = {
    orders:[['Confirm Orders','تأكيد الطلبات','Approve'],['Export Orders','تصدير الطلبات','Export']],
    inventory:[['Adjust Stock','تسوية المخزون','Edit'],['View Stock History','عرض سجل المخزون','View','inventory']],
    movement:[['Create Movements','إنشاء حركات','Create'],['Edit Movements','تعديل الحركات','Edit'],['Approve Movements','اعتماد الحركات','Approve']],
    cash:[['Add Transactions','إضافة عمليات للخزنة','Create'],['Edit Transactions','تعديل عمليات الخزنة','Edit'],['Delete Transactions','حذف عمليات الخزنة','Delete']],
    employees:[['View Employees','عرض الموظفين','View'],['Create Employees','إنشاء موظفين','Create'],['Edit Employees','تعديل الموظفين','Edit'],['Manage Roles & Permissions','إدارة الأدوار والصلاحيات','Approve']],
    settings:[['Edit Settings','تعديل الإعدادات','Edit'],['Manage Integrations','إدارة التكاملات','Edit']],
  };
  const specialNames = {
    dashboard:['View Dashboard','عرض الرئيسية'], 'reports-kpis':['View Analytics','عرض مؤشرات الأداء'],
    'shopify-orders':['View Orders','عرض طلبات شوبيفاي'], transaction:['Create Transactions / Orders','إنشاء معاملات وطلبات'],
    'shopify-edit-direct':['Edit Orders','تعديل الطلبات'], 'shopify-bundle-discount-override':['Discount on Shopify bundles (exception)','خصم على باقات Shopify (استثناء)'], 'shopify-cancel':['Cancel Orders','إلغاء الطلبات'],
    'shopify-deposit-no-image':['Add Deposit Without Image (direct)','إضافة عربون بدون صورة (مباشرة)'],
    'shopify-deposit-no-image-otp':['Add Deposit Without Image (manager OTP)','إضافة عربون بدون صورة (بكود OTP)'],
    'pickup-orders':['View Pick-Up Orders','عرض طلبات الاستلام'], 'pickup-orders-edit':['Edit Pick-Up Orders','تعديل طلبات الاستلام'],
    inventory:['View Inventory','عرض المخزون'], products:['View Products','عرض الأصناف'],
    'products-create':['Add Products','إضافة أصناف'], 'products-edit':['Edit Products','تعديل الأصناف'], 'products-delete':['Delete Products','حذف الأصناف'],
    movements:['View Movements','عرض الحركات'],
    vault:['View Cash Register','عرض الخزنة'], suppliers:['View Suppliers','عرض الموردين'],
    'suppliers-create':['Create Suppliers','إنشاء موردين'], 'suppliers-edit':['Edit Suppliers','تعديل الموردين'], 'suppliers-delete':['Delete Suppliers','حذف الموردين'],
    users:['Manage Users','إدارة المستخدمين'],
    settings:['View Settings','عرض الإعدادات'], reports:['View Financial Reports','عرض التقارير'],
    'promotions-view':['Open Promotions','فتح صفحة العروض والخصومات'], 'promotions-offers':['Manage Price Offers','إدارة عروض الأسعار'],
    'promotions-codes':['Manage Discount Codes','إدارة أكواد الخصم'], 'promotions-bundles':['Manage Smart Bundles','إدارة باقات الخصم'],
    'suppliers-rs-view':['View Return Statements','عرض بيانات المرتجعات'], 'suppliers-rs-create':['Create Return Statements','إنشاء بيان مرتجع'],
    'suppliers-rs-edit':['Edit Return Statements','تعديل بيانات المرتجعات'], 'suppliers-rs-status':['Change Statement Status','تغيير حالة بيان المرتجع'],
    'suppliers-rs-delete':['Delete Return Statements','حذف بيانات المرتجعات'], 'suppliers-rs-export':['Print / Export Statements','طباعة وتصدير بيانات المرتجعات'],
    'promotions-tags':['Manage Tags','إدارة التاجات'], 'promotions-audit':['View Promotions Audit Log','عرض سجل مراجعة العروض'],
  };
  const sensitive = new Set(['users','settings','vault','shopify-cancel','shopify-edit-direct','shopify-bundle-discount-override','shopify-deposit-no-image','products-delete','suppliers-delete','suppliers-pay','suppliers-deposit','suppliers-ledger-adjust','suppliers-write-off','suppliers-reverse','carrier-settle-run','carrier-settle-approve','carrier-settle-reverse']);
  const viewerAllowed = new Set(['dashboard','inventory','products','movements','clients','suppliers','complaints','reports','reports-kpis','reports-charts','reports-discounts','reports-orderaudit','reports-cancellations','reports-shipping','categories-view','pickup-orders','shopify-orders','csp-view','purchase-view','inventory-units-view','suppliers-tab-invoices','suppliers-tab-pos','suppliers-tab-sreturns','suppliers-tab-payments','suppliers-tab-ledger','suppliers-tab-activity','carrier-settle-view','delivery-view-audit','promotions-view','suppliers-rs-view']);
  const builtInAr = {
    'super-admin':['المدير الرئيسي','الحساب الرئيسي المحمي مع وصول كامل للنظام.'],
    admin:['مدير النظام','وصول إداري كامل لكل النظام.'], manager:['مدير عمليات','العمليات والطلبات والمخزون والموافقات.'],
    accountant:['محاسب','السجلات المالية والموردون والتقارير.'], sales:['مبيعات','الطلبات والعملاء ومعلومات الأصناف.'],
    warehouse:['المخزن','المخزون والوحدات وتجهيز الطلبات.'],
    'customer-service':['خدمة العملاء','حالات العملاء والطلبات والمتابعات.'], viewer:['مشاهد','عرض البيانات والتقارير فقط.'],
    fulfillment:['تجهيز وشحن','تجهيز الطلبات والشحن والتسليم.'], cashier:['أمين خزنة','الخزنة والمصاريف.'],
    purchasing:['مشتريات وموردون','الموردون وفواتير الشراء ومرتجعات الموردين.'], marketing:['تسويق ومحتوى','الأصناف والمجموعات وتقارير المبيعات.'],
  };
  const ui = { roles:[], unassigned:[], selected:'super-admin', draft:new Set(), original:new Set(), canManage:false,
    loaded:false, loading:null, saving:false, search:'', expanded:new Set(['dashboard','orders','inventory']), users:null };
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const en = () => typeof currentLang !== 'undefined' && currentLang === 'en';
  const tr = (english, arabic) => en() ? english : arabic;
  const role = () => ui.roles.find(item => item.slug === ui.selected);
  const count = value => new Intl.NumberFormat(en() ? 'en' : 'ar-EG-u-nu-latn').format(value);
  const date = value => value ? new Intl.DateTimeFormat(en() ? 'en' : 'ar-EG-u-nu-latn', {dateStyle:'medium'}).format(new Date(value)) : '—';
  const name = key => specialNames[key]?.[en() ? 0 : 1] || (en() ? key.replace(/-/g,' ').replace(/\b\w/g,char => char.toUpperCase()) : (typeof PERMS_AR !== 'undefined' && PERMS_AR[key]) || key);
  const action = key => /-view$|^dashboard$|^inventory$|^products$|^movements$|^vault$|^suppliers$|^reports$|^shopify-orders$|^pickup-orders$/.test(key) ? tr('View','عرض')
    : /-create$|-register$|-receive$/.test(key) ? tr('Create','إنشاء')
    : /-edit$|-allocate$|-condition$|-reassign$|-prepare-ship$|-adjust$/.test(key) ? tr('Edit','تعديل')
    : /-delete$/.test(key) ? tr('Delete','حذف')
    : /-approve$|^approvals$|-confirm$/.test(key) ? tr('Approve','اعتماد')
    : /-export$/.test(key) ? tr('Export','تصدير') : tr('Access','وصول');
  const dirty = () => ui.draft.size !== ui.original.size || [...ui.draft].some(key => !ui.original.has(key));
  const status = (message, error=false) => { const el=$('#rbac-status'); if (!el) return; el.textContent=message; el.dataset.error=String(error); if (error&&!ui.loaded) { const retry=document.createElement('button'); retry.type='button'; retry.id='rbac-retry'; retry.className='rbac-secondary'; retry.textContent=tr('Retry','إعادة المحاولة'); retry.style.marginInlineStart='12px'; el.append(retry); } };
  const canEdit = () => ui.canManage && role() && !role().locked;
  const editablePermission = key => !['users','settings'].includes(key) && (role()?.baseRole !== 'viewer' || viewerAllowed.has(key));
  const avatar = user => {
    const src = typeof sanitizeUrl === 'function' ? sanitizeUrl(user.avatar) : '';
    return src ? `<span class="rbac-avatar"><img src="${esc(src)}" alt=""></span>` : `<span class="rbac-avatar">${esc((user.name || user.username || '?').slice(0,2).toUpperCase())}</span>`;
  };
  const label = (english, arabic) => tr(english, arabic);
  const roleName = item => en() ? item.name : builtInAr[item.slug]?.[0] || item.name;
  const tierName = tier => tier === 'admin' ? tr('System admin','مدير النظام') : tier === 'viewer' ? tr('Viewer','مشاهد') : tr('Staff','موظف');
  const roleDescription = item => en() ? item.description : builtInAr[item.slug]?.[1] || item.description;
  function reconcile(changedKey, checked) {
    if (changedKey==='pickup-orders' && !checked) ui.draft.delete('pickup-orders-edit');
    if (changedKey==='shopify-orders' && !checked) ui.draft.delete('shopify-prepare-ship');
    if (ui.draft.has('pickup-orders-edit')) ui.draft.add('pickup-orders');
    if (ui.draft.has('shopify-prepare-ship')) ui.draft.add('shopify-orders');
    if (['products-create','products-edit','products-delete'].some(key=>ui.draft.has(key))) ui.draft.add('products');
    if (ui.draft.has('products-create')||ui.draft.has('products-delete')) ui.draft.add('products-sku-manage');
    if (['suppliers-create','suppliers-edit','suppliers-delete'].some(key=>ui.draft.has(key))) ui.draft.add('suppliers');
    if ([...ui.draft].some(key=>key.startsWith('reports-'))) ui.draft.add('reports');
  }

  function renderChrome() {
    const labels = { pageTitle:['Roles & Permissions','الأدوار والصلاحيات'], pageSubtitle:['Manage user roles and control system access.','إدارة أدوار المستخدمين والتحكم في الوصول للنظام.'],
      users:['Users','المستخدمون'], create:['Create New Role','إنشاء دور جديد'], roles:['Roles','الأدوار'] };
    Object.entries(labels).forEach(([key,pair]) => document.querySelectorAll(`[data-rbac="${key}"]`).forEach(el => el.textContent=pair[en()?0:1]));
    $('#rbac-root').dir = en() ? 'ltr' : 'rtl';
    $('#rbac-create').hidden = !ui.canManage;
    const refresh=$('#rbac-refresh'); refresh.title=label('Refresh roles','تحديث الأدوار'); refresh.setAttribute('aria-label',refresh.title);
  }

  function renderSidebar() {
    $('#rbac-role-count').textContent = count(ui.roles.length);
    $('#rbac-role-list').innerHTML = ui.roles.map(item => `<div class="rbac-role-item ${item.slug===ui.selected?'is-selected':''}">
      <button type="button" class="rbac-role-select" data-role="${esc(item.slug)}" aria-current="${item.slug===ui.selected?'true':'false'}"><strong>${esc(roleName(item))}</strong><small>${esc(roleDescription(item) || '—')}</small><span class="rbac-role-users">${count(item.users?.length || 0)} ${label('users','مستخدمين')} · ${esc(tierName(item.baseRole))}</span></button>
      <details class="rbac-role-menu"><summary aria-label="${label('Role actions','إجراءات الدور')}">⋯</summary><div class="rbac-menu-popover"><button data-role="${esc(item.slug)}">${label('View details','عرض التفاصيل')}</button>${ui.canManage&&!item.locked?`<button data-edit="${esc(item.slug)}">${label('Edit details','تعديل التفاصيل')}</button>${!item.system?`<button class="is-danger" data-delete="${esc(item.slug)}">${label('Delete role','حذف الدور')}</button>`:''}`:''}</div></details>
    </div>`).join('');
    if (matchMedia('(max-width: 900px)').matches) requestAnimationFrame(() => {
      $('#rbac-role-list .is-selected')?.scrollIntoView({block:'nearest',inline:'center'});
    });
  }

  function renderMatrix() {
    const editable = canEdit();
    const search = ui.search.trim().toLowerCase();
    const visible = groups.map(([key,english,arabic,keys]) => {
      const title = label(english,arabic);
      const matches = keys.filter(perm => !search || title.toLowerCase().includes(search) || perm.toLowerCase().includes(search) || name(perm).toLowerCase().includes(search));
      const staticMatch=(restrictedRows[key]||[]).some(row => row[en()?0:1].toLowerCase().includes(search));
      return matches.length || (search && staticMatch) ? {key,title,keys:matches} : null;
    }).filter(Boolean);
    const allKeys = groups.flatMap(group => group[3]).filter(editablePermission);
    const allChecked = allKeys.every(key => ui.draft.has(key));
    return `<section class="rbac-detail-card"><div class="rbac-section-head"><div><h3>${label('Permission matrix','مصفوفة الصلاحيات')}</h3><p>${label('Only capabilities enforced by SOULIA are editable.','الصلاحيات المفعّلة في SOULIA فقط قابلة للتعديل.')}</p></div>
      <div class="rbac-section-actions"><input class="rbac-search" id="rbac-search" type="search" value="${esc(ui.search)}" placeholder="${label('Search permissions…','ابحث عن صلاحية…')}" aria-label="${label('Search permissions','البحث في الصلاحيات')}"><button class="rbac-quiet" id="rbac-expand-all">${ui.expanded.size===groups.length?label('Collapse all','طي الكل'):label('Expand all','توسيع الكل')}</button>
      <label class="rbac-select-all"><input id="rbac-all" type="checkbox" ${allChecked?'checked':''} ${editable?'':'disabled'}> ${label('Select all','تحديد الكل')}</label></div></div>
      <div class="rbac-perm-header"><span>${label('Permission','الصلاحية')}</span><span>${label('Action','الإجراء')}</span><span>${label('Grant','منح')}</span></div>
      ${visible.map(group => { const grantable=group.keys.filter(editablePermission), selected=grantable.filter(key => ui.draft.has(key)).length;
        return `<section class="rbac-module ${ui.expanded.has(group.key)||search?'is-open':''}" data-module="${esc(group.key)}"><div class="rbac-module-head"><button type="button" class="rbac-module-toggle" data-expand="${esc(group.key)}" aria-expanded="${ui.expanded.has(group.key)||!!search}"><span class="rbac-chevron">›</span><span class="rbac-module-title">${esc(group.title)}</span><span class="rbac-module-count">${count(selected)} / ${count(grantable.length)}</span></button><label class="rbac-select-all" title="${label('Select all in module','تحديد كل صلاحيات القسم')}"><input type="checkbox" data-module-all="${esc(group.key)}" ${grantable.length&&selected===grantable.length?'checked':''} ${editable&&grantable.length?'':'disabled'} aria-label="${label('Select all','تحديد الكل')} ${esc(group.title)}"></label></div><div class="rbac-module-body">${group.keys.map(key => `<label class="rbac-perm-row ${role()?.locked?'is-inherited':''} ${!editablePermission(key)?'is-restricted':''}" title="${!editablePermission(key)?label('Restricted by server policy','مقيّدة بسياسة الخادم'):''}"><span class="rbac-perm-name"><strong>${esc(name(key))}</strong><small>${esc(key)}</small></span><span class="rbac-action-tag">${!editablePermission(key)?label('Restricted','مقيّدة'):esc(action(key))}</span><input type="checkbox" data-perm="${esc(key)}" ${ui.draft.has(key)?'checked':''} ${editable&&editablePermission(key)?'':'disabled'} aria-label="${esc(name(key))}"></label>`).join('')}${(restrictedRows[group.key]||[]).filter(row=>!search||group.title.toLowerCase().includes(search)||row[en()?0:1].toLowerCase().includes(search)).map(row=>{const inherited=!!row[3],granted=inherited?ui.draft.has(row[3]):role()?.slug==='super-admin'||(role()?.slug==='admin'&&row[0]!=='Manage Roles & Permissions'&&row[0]!=='Export Orders');return `<div class="rbac-perm-row ${inherited?'is-inherited':'is-restricted'}"><span class="rbac-perm-name"><strong>${esc(label(row[0],row[1]))}</strong><small>${inherited?label('Inherited from module access','موروثة من صلاحية القسم'):label('System policy · not delegated','سياسة النظام · غير قابلة للتفويض')}</small></span><span class="rbac-action-tag">${inherited?label('Inherited','موروثة'):label('Restricted','مقيّدة')}</span><input type="checkbox" disabled ${granted?'checked':''} aria-label="${esc(label(row[0],row[1]))}"></div>`;}).join('')}</div></section>`;
      }).join('') || `<div class="rbac-empty">${label('No matching permissions.','لا توجد صلاحيات مطابقة.')}</div>`}
      <div class="rbac-note">${role()?.locked ? label('Inherited: this protected administrator role has full access by system policy.','موروثة: هذا الدور الإداري المحمي يملك وصولاً كاملاً بسياسة النظام.') : label('Restricted actions without a server permission are intentionally unavailable here.','الإجراءات التي لا تملك صلاحية معتمدة في الخادم غير متاحة هنا.')}</div></section>`;
  }

  function renderUsers() {
    const item=role(), editable=ui.canManage && item?.slug!=='super-admin';
    return `<section class="rbac-detail-card"><div class="rbac-section-head"><div><h3>${label('Assigned users','المستخدمون المعينون')}</h3><p>${count(item.users?.length||0)} ${label('accounts','حسابات')}</p></div>${editable?`<button class="rbac-secondary" data-assign="${esc(item.slug)}">＋ ${label('Assign user','تعيين مستخدم')}</button>`:''}</div>
      ${item.users?.length ? `<div style="overflow-x:auto"><table class="rbac-users-table"><thead><tr><th>${label('Employee','الموظف')}</th><th>${label('Status','الحالة')}</th><th>${label('Assigned','التعيين')}</th><th></th></tr></thead><tbody>${item.users.map(user => `<tr><td><span class="rbac-person">${avatar(user)}<span><strong>${esc(user.name)}</strong><small>${user.email?esc(user.email):'@'+esc(user.username)}</small></span></span></td><td><span class="rbac-status-pill ${user.isActive?'is-active':''}">${user.isActive?label('Active','نشط'):label('Inactive','معطّل')}</span></td><td>${date(user.assignedAt)}</td><td>${editable?`<button class="rbac-quiet" data-unassign="${esc(user.id)}">${label('Remove','إزالة')}</button>`:''}</td></tr>`).join('')}</tbody></table></div>` : `<div class="rbac-empty">${label('No users are assigned to this role.','لم يُعيَّن أي مستخدم لهذا الدور.')}</div>`}</section>`;
  }

  function renderDetail() {
    const item=role();
    if (!item) { $('#rbac-detail').innerHTML=`<div class="rbac-empty">${label('Select a role.','اختر دورًا.')}</div>`; return; }
    const editable=ui.canManage&&!item.locked;
    $('#rbac-detail').innerHTML=`<section class="rbac-detail-card"><div class="rbac-detail-head"><div><p class="rbac-kicker">${item.locked?label('Protected role','دور محمي'):item.system?label('System role','دور أساسي'):label('Custom role','دور مخصص')}</p><h2>${esc(roleName(item))}</h2><p>${esc(roleDescription(item) || '—')}</p></div>${editable?`<div class="rbac-detail-actions"><button class="rbac-secondary" data-edit="${esc(item.slug)}">${label('Edit role','تعديل الدور')}</button>${!item.system?`<button class="rbac-danger" data-delete="${esc(item.slug)}">${label('Delete','حذف')}</button>`:''}</div>`:''}</div>
      <div class="rbac-meta"><div><small>${label('Assigned users','المستخدمون')}</small><strong>${count(item.users?.length||0)}</strong></div><div><small>${label('Created','تاريخ الإنشاء')}</small><strong>${date(item.createdAt)}</strong></div><div><small>${label('Last updated','آخر تحديث')}</small><strong>${date(item.updatedAt)}</strong></div></div></section>
      ${renderMatrix()}${renderUsers()}<div class="rbac-savebar"><span class="${dirty()?'rbac-unsaved':'rbac-saved'}">${dirty()?label('● Unsaved changes','● تغييرات غير محفوظة'):label('All changes saved','كل التغييرات محفوظة')}</span><div class="rbac-savebar-actions"><button class="rbac-secondary" id="rbac-discard" ${dirty()?'':'disabled'}>${label('Discard','تجاهل')}</button><button class="rbac-primary" id="rbac-save" ${dirty()&&!ui.saving?'':'disabled'}>${ui.saving?label('Saving…','جارٍ الحفظ…'):label('Save Changes','حفظ التغييرات')}</button></div></div>`;
    $('#rbac-detail').querySelectorAll('[data-module-all]').forEach(input => { const keys=groups.find(group=>group[0]===input.dataset.moduleAll)?.[3].filter(editablePermission)||[]; input.indeterminate=keys.some(key=>ui.draft.has(key))&&!keys.every(key=>ui.draft.has(key)); });
    const allKeys=groups.flatMap(group=>group[3]).filter(editablePermission), all=$('#rbac-all');
    if (all) all.indeterminate=allKeys.some(key=>ui.draft.has(key))&&!allKeys.every(key=>ui.draft.has(key));
  }

  function syncGrantUI() {
    const detail=$('#rbac-detail');
    detail.querySelectorAll('[data-perm]').forEach(input => { input.checked=ui.draft.has(input.dataset.perm); });
    detail.querySelectorAll('.rbac-module').forEach(module => {
      const keys=[...module.querySelectorAll('[data-perm]:not(:disabled)')].map(input=>input.dataset.perm);
      const selected=keys.filter(key=>ui.draft.has(key)).length;
      const master=module.querySelector('[data-module-all]');
      master.checked=keys.length>0&&selected===keys.length;
      master.indeterminate=selected>0&&selected<keys.length;
      module.querySelector('.rbac-module-count').textContent=`${count(selected)} / ${count(keys.length)}`;
    });
    const keys=groups.flatMap(group=>group[3]).filter(editablePermission);
    const selected=keys.filter(key=>ui.draft.has(key)).length, all=$('#rbac-all');
    all.checked=keys.length>0&&selected===keys.length; all.indeterminate=selected>0&&selected<keys.length;
    const changed=dirty(), mark=detail.querySelector('.rbac-unsaved,.rbac-saved');
    mark.className=changed?'rbac-unsaved':'rbac-saved';
    mark.textContent=changed?label('● Unsaved changes','● تغييرات غير محفوظة'):label('All changes saved','كل التغييرات محفوظة');
    $('#rbac-discard').disabled=!changed; $('#rbac-save').disabled=!changed||ui.saving;
  }

  function renderLegacy() {
    let box=$('#rbac-legacy');
    if (!box) { box=document.createElement('div'); box.id='rbac-legacy'; $('#rbac-layout').before(box); }
    // Disabled accounts are left as they are by the move, so they are not counted here.
    const list=(ui.unassigned||[]).filter(user=>user.isActive!==false);
    box.hidden=!list.length;
    box.innerHTML=list.length?`<div class="rbac-legacy"><span><strong>${count(list.length)} ${label('accounts have no role','حساب بدون دور')}</strong> — ${label('they still hold permissions set one by one, before roles existed. Move them onto roles so every account is managed here.','لسه شايلين صلاحيات متحددة لكل واحد لوحده من قبل الأدوار. انقلهم لأدوار عشان كل الحسابات تتدار من هنا.')}</span><button type="button" class="rbac-secondary" id="rbac-migrate">${label('Review and move','مراجعة ونقل')}</button></div>`:'';
  }
  function render() { renderChrome(); renderSidebar(); renderLegacy(); renderDetail(); $('#rbac-layout').hidden=false; }
  function select(slug) {
    if (dirty() && !confirm(label('Discard unsaved permission changes?','تجاهل تغييرات الصلاحيات غير المحفوظة؟'))) return;
    ui.selected=slug; const item=role(); ui.original=new Set(item?.perms||[]); ui.draft=new Set(item?.perms||[]); ui.search=''; render();
  }
  async function refresh(keepSelection=true) {
    if (ui.loading) return ui.loading;
    status(label('Loading roles…','جارٍ تحميل الأدوار…'));
    ui.loading=api('/roles').then(result => {
      ui.roles=result.roles||[]; ui.unassigned=result.unassigned||[]; ui.canManage=!!result.canManage; ui.loaded=true;
      if (!keepSelection || !ui.roles.some(item => item.slug===ui.selected)) ui.selected=ui.roles[0]?.slug;
      const item=role(); ui.original=new Set(item?.perms||[]); ui.draft=new Set(item?.perms||[]);
      status(''); render();
    }).catch(error => { status(error.message||label('Unable to load roles.','تعذر تحميل الأدوار.'),true); $('#rbac-layout').hidden=true; throw error; }).finally(() => { ui.loading=null; });
    return ui.loading;
  }
  window.rbacOpen = () => { if (!ui.loaded) refresh().catch(() => {}); else render(); };
  /** Keeps the Users page (and the user window) in step after an assignment or a role edit. */
  async function syncAccounts() {
    try { if (typeof users !== 'undefined') { users = await api('/users'); if (typeof renderUsers === 'function') renderUsers(); } } catch (_) {}
  }
  /** Shared surface for the user window and the Users table: they SHOW a role, never edit one. */
  window.SouliaRBAC = {
    ensure: () => ui.loaded ? Promise.resolve(ui.roles) : refresh().then(() => ui.roles),
    reload: () => refresh().then(() => ui.roles),
    roles: () => ui.roles,
    find: slug => ui.roles.find(item => item.slug === slug) || null,
    slugOf: account => account?.username === 'admin' ? 'super-admin' : account?.role === 'admin' ? 'admin' : (account?.roleId || ''),
    roleName, roleDescription, tierName, permName: key => name(key),
    groups: () => groups.map(([key,english,arabic,keys]) => ({ key, title: label(english,arabic), keys })),
    open: slug => {
      if (typeof navigateTo === 'function') navigateTo('roles');
      const go = () => { if (!ui.roles.some(item => item.slug === slug)) return; ui.selected = slug; const item = role(); ui.original = new Set(item?.perms||[]); ui.draft = new Set(item?.perms||[]); render(); };
      ui.loaded ? go() : refresh().then(go).catch(() => {});
    },
  };
  const dialog = document.createElement('dialog'); dialog.className='rbac-dialog'; dialog.id='rbac-dialog'; document.body.append(dialog);
  function showDialog(content) { dialog.innerHTML=`<div class="rbac-dialog-inner">${content}</div>`; dialog.showModal(); }
  function closeDialog() { dialog.close(); dialog.innerHTML=''; }
  function confirmDialog(title, detail, onYes, danger=false) {
    showDialog(`<h3>${esc(title)}</h3><p>${esc(detail)}</p><div class="rbac-dialog-actions"><button class="rbac-secondary" data-close>${label('Cancel','إلغاء')}</button><button class="${danger?'rbac-danger':'rbac-primary'}" id="rbac-confirm">${danger?label('Delete','حذف'):label('Confirm','تأكيد')}</button></div>`);
    $('#rbac-confirm').onclick=async () => { const button=$('#rbac-confirm'); button.disabled=true; try { await onYes(); closeDialog(); } catch(error) { button.disabled=false; dialog.querySelector('p').textContent=error.message; } };
  }
  async function save() {
    const item=role(); if (!canEdit() || !dirty() || ui.saving) return;
    const changed=[...new Set([...ui.original,...ui.draft])].filter(key => ui.original.has(key)!==ui.draft.has(key));
    const persist=async () => { ui.saving=true; renderDetail(); try { await api('/roles/'+encodeURIComponent(item.slug),{method:'PATCH',body:JSON.stringify({perms:[...ui.draft]})}); await refresh(); syncAccounts(); status(label('Role permissions saved.','تم حفظ صلاحيات الدور.')); } catch(error) { status(error.message,true); throw error; } finally { ui.saving=false; renderDetail(); } };
    // A role edit changes access for everyone on it, so it names them before saving.
    const holders=(item.users||[]).map(user=>user.name||user.username);
    if (changed.some(key => sensitive.has(key)) || holders.length) confirmDialog(
      changed.some(key => sensitive.has(key)) ? label('Confirm sensitive access change','تأكيد تغيير صلاحيات حساسة') : label('Update this role','تحديث الدور'),
      holders.length ? `${count(holders.length)} ${label('accounts get the new access now: ','حساب هياخدوا الصلاحيات الجديدة دلوقتي: ')}${holders.join('، ')}` : label('This updates access for every user assigned to this role.','سيُحدّث هذا وصول كل مستخدم معيّن لهذا الدور.'),
      persist);
    else await persist().catch(() => {});
  }
  function form(item) {
    const creating=!item;
    showDialog(`<h3>${creating?label('Create new role','إنشاء دور جديد'):label('Edit role','تعديل الدور')}</h3><p>${label('Use a clear name and describe the responsibility.','اختر اسمًا واضحًا ووصفًا للمسؤولية.')}</p>
      <form id="rbac-form"><label>${label('Role name','اسم الدور')}<input name="name" required minlength="2" maxlength="60" value="${esc(item?.name||'')}"></label><label>${label('Description','الوصف')}<textarea name="description" maxlength="240">${esc(item?.description||'')}</textarea></label><label>${label('Access tier','مستوى الوصول')}<select name="baseRole"><option value="staff" ${item?.baseRole==='staff'?'selected':''}>${label('Staff','موظف')}</option><option value="viewer" ${item?.baseRole==='viewer'?'selected':''}>${label('Viewer','مشاهد')}</option></select></label>
      <div class="rbac-dialog-actions"><button class="rbac-secondary" type="button" data-close>${label('Cancel','إلغاء')}</button><button class="rbac-primary" type="submit">${creating?label('Create role','إنشاء الدور'):label('Save details','حفظ التفاصيل')}</button></div></form>`);
    $('#rbac-form').onsubmit=async event => { event.preventDefault(); const button=dialog.querySelector('[type="submit"]'); button.disabled=true;
      const data=Object.fromEntries(new FormData(event.currentTarget)); if (creating) data.perms=[];
      try { const result=await api(creating?'/roles':'/roles/'+encodeURIComponent(item.slug),{method:creating?'POST':'PATCH',body:JSON.stringify(data)}); closeDialog(); if (creating) ui.selected=result.slug; await refresh(); status(creating?label('Role created. Choose its permissions and assign users.','تم إنشاء الدور. اختر صلاحياته وعيّن المستخدمين.'):label('Role details saved.','تم حفظ تفاصيل الدور.')); }
      catch(error) { button.disabled=false; dialog.querySelector('p').textContent=error.message; }
    };
  }
  function currentRoleLabel(user) {
    const slug=window.SouliaRBAC.slugOf(user); const found=slug&&ui.roles.find(item=>item.slug===slug);
    return found ? roleName(found) : label('no role','بدون دور');
  }
  /** Dry run first: every account, the role it lands on, and what changes (nothing is lost). */
  async function migrate() {
    showDialog(`<h3>${label('Move accounts onto roles','نقل الحسابات لأدوار')}</h3><p>${label('Checking…','جارٍ الفحص…')}</p>`);
    try {
      const plan=await api('/roles/migrate-legacy',{method:'POST',body:JSON.stringify({dryRun:true})});
      const roleCell=row=>{
        if (row.action==='skip') return `<span class="rbac-quiet-note">${row.reason==='inactive'?label('Disabled — left as it is; give it a role when you enable it','معطّل — هيفضل زي ما هو؛ اديله دور لما تفعّله'):label('No permissions — stays without a role','بدون صلاحيات — هيفضل بدون دور')}</span>`;
        const known=ui.roles.find(item=>item.slug===row.role.slug);
        return row.action==='create' ? `${label('New role: ','دور جديد: ')}<strong>${esc(row.role.name)}</strong>` : `<strong>${esc(roleName(known||row.role))}</strong>`;
      };
      const permCell=row=>row.action==='skip'?'—':`${count(row.after.length)}${row.added?.length?` <small class="rbac-added" title="${esc(row.added.map(name).join('، '))}">+${count(row.added.length)} ${label('equivalent','مكافئة')}</small>`:''}${row.dropped?.length?` <small class="rbac-dropped" title="${esc(row.dropped.join(', '))}">${count(row.dropped.length)} ${label('not grantable','غير قابلة للمنح')}</small>`:''}`;
      const rows=plan.users.map(row=>`<tr><td><strong>${esc(row.name||row.username)}</strong><small>@${esc(row.username)}</small></td><td>${roleCell(row)}</td><td>${permCell(row)}</td></tr>`).join('');
      dialog.innerHTML=`<div class="rbac-dialog-inner rbac-migrate"><h3>${label('Move accounts onto roles','نقل الحسابات لأدوار')}</h3>
        <p>${label('Each account joins the role that has exactly its permissions; where none exists a role is created for it. Nobody gains or loses access: product and supplier edit keys are added only where the account already used those screens.','كل حساب بيتنقل للدور اللي صلاحياته مطابقة لصلاحياته بالظبط، ولو مفيش دور كده بيتعمل له دور. محدش هيكسب أو يخسر صلاحية: مفاتيح تعديل الأصناف والموردين بتتضاف بس لو الحساب كان بيستخدم الشاشات دي أصلاً.')}</p>
        <div style="overflow-x:auto"><table class="rbac-users-table"><thead><tr><th>${label('Employee','الموظف')}</th><th>${label('Role','الدور')}</th><th>${label('Permissions','الصلاحيات')}</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${plan.createdRoles.length?`<p class="rbac-quiet-note">${count(plan.createdRoles.length)} ${label('new roles will be created — rename or merge them afterwards.','دور جديد هيتعمل — تقدر تغيّر أسماءهم أو تدمجهم بعدين.')}</p>`:''}
        <div class="rbac-dialog-actions"><button class="rbac-secondary" data-close>${label('Cancel','إلغاء')}</button><button class="rbac-primary" id="rbac-migrate-go" ${plan.users.some(row=>row.action!=='skip')?'':'disabled'}>${label('Move accounts','نقل الحسابات')}</button></div></div>`;
      $('#rbac-migrate-go').onclick=async()=>{ const button=$('#rbac-migrate-go'); button.disabled=true;
        try { const done=await api('/roles/migrate-legacy',{method:'POST',body:JSON.stringify({dryRun:false})}); closeDialog(); await refresh(); syncAccounts(); status(`${count(done.moved)} ${label('accounts moved onto roles.','حساب اتنقل لأدوار.')}`); }
        catch(error) { button.disabled=false; dialog.querySelector('p').textContent=error.message; } };
    } catch(error) { const p=dialog.querySelector('p'); if (p) p.textContent=error.message; }
  }
  async function assign(slug) {
    try {
      if (!ui.users) ui.users=await api('/users');
      const assigned=new Set(role()?.users?.map(user => user.id)||[]);
      const me=String((typeof currentUser!=='undefined'&&(currentUser?._id||currentUser?.id))||'');
      const candidates=ui.users.filter(user => user.username!=='admin'&&!assigned.has(String(user._id))&&String(user._id)!==me);
      showDialog(`<h3>${label('Assign user','تعيين مستخدم')}</h3><p>${label('The selected role replaces the user’s current permission grants.','سيحل هذا الدور محل صلاحيات المستخدم الحالية.')}</p>${candidates.length?`<form id="rbac-assign-form"><label>${label('Employee','الموظف')}<select name="userId">${candidates.map(user => `<option value="${esc(user._id)}">${esc(user.name)} (@${esc(user.username)}) — ${esc(currentRoleLabel(user))}</option>`).join('')}</select></label><div class="rbac-dialog-actions"><button class="rbac-secondary" type="button" data-close>${label('Cancel','إلغاء')}</button><button class="rbac-primary" type="submit">${label('Assign','تعيين')}</button></div></form>`:`<div class="rbac-empty">${label('No available users.','لا يوجد مستخدمون متاحون.')}</div><div class="rbac-dialog-actions"><button class="rbac-secondary" data-close>${label('Close','إغلاق')}</button></div>`}`);
      const formEl=$('#rbac-assign-form'); if (formEl) formEl.onsubmit=async event => { event.preventDefault(); const button=formEl.querySelector('[type="submit"]'); button.disabled=true; try { await api('/roles/'+encodeURIComponent(slug)+'/assign',{method:'POST',body:JSON.stringify({userId:new FormData(formEl).get('userId')})}); ui.users=null; closeDialog(); await refresh(); syncAccounts(); status(label('User assigned.','تم تعيين المستخدم.')); } catch(error) { button.disabled=false; dialog.querySelector('p').textContent=error.message; } };
    } catch(error) { status(error.message,true); }
  }
  $('#rbac-root').addEventListener('input', event => { if (event.target.id==='rbac-search') { const start=event.target.selectionStart; ui.search=event.target.value; renderDetail(); const input=$('#rbac-search'); input.focus(); input.setSelectionRange(start,start); } });
  $('#rbac-root').addEventListener('change', event => {
    const target=event.target;
    if (target.dataset.perm) { target.checked?ui.draft.add(target.dataset.perm):ui.draft.delete(target.dataset.perm); reconcile(target.dataset.perm,target.checked); syncGrantUI(); }
    else if (target.dataset.moduleAll) { const group=groups.find(item=>item[0]===target.dataset.moduleAll); group?.[3].filter(editablePermission).forEach(key=>target.checked?ui.draft.add(key):ui.draft.delete(key)); reconcile(); syncGrantUI(); }
    else if (target.id==='rbac-all') { groups.flatMap(group=>group[3]).filter(editablePermission).forEach(key=>target.checked?ui.draft.add(key):ui.draft.delete(key)); reconcile(); syncGrantUI(); }
  });
  $('#rbac-root').addEventListener('click', event => {
    const target=event.target.closest('button'); if (!target) return;
    if (target.dataset.role) select(target.dataset.role);
    else if (target.dataset.expand) { const key=target.dataset.expand; ui.expanded.has(key)?ui.expanded.delete(key):ui.expanded.add(key); const module=target.closest('.rbac-module'); module.classList.toggle('is-open',ui.expanded.has(key)); target.setAttribute('aria-expanded',String(ui.expanded.has(key))); }
    else if (target.id==='rbac-expand-all') { ui.expanded=ui.expanded.size===groups.length?new Set():new Set(groups.map(group=>group[0])); document.querySelectorAll('#rbac-detail .rbac-module').forEach(module=>{const open=ui.expanded.has(module.dataset.module);module.classList.toggle('is-open',open);module.querySelector('[data-expand]').setAttribute('aria-expanded',String(open));});target.textContent=ui.expanded.size===groups.length?label('Collapse all','طي الكل'):label('Expand all','توسيع الكل'); }
    else if (target.id==='rbac-create') form(null);
    else if (target.id==='rbac-migrate') migrate();
    else if (target.id==='rbac-refresh') { if (!dirty() || confirm(label('Discard unsaved changes and refresh?','تجاهل التغييرات غير المحفوظة وتحديث الصفحة؟'))) refresh().catch(()=>{}); }
    else if (target.id==='rbac-retry') refresh().catch(()=>{});
    else if (target.dataset.edit) form(ui.roles.find(item=>item.slug===target.dataset.edit));
    else if (target.dataset.delete) { const item=ui.roles.find(role=>role.slug===target.dataset.delete); confirmDialog(label('Delete role','حذف الدور'),label('This role can only be deleted when no users are assigned.','يمكن حذف الدور فقط بعد إزالة جميع المستخدمين المعيّنين له.'),async()=>{ await api('/roles/'+encodeURIComponent(item.slug),{method:'DELETE'}); await refresh(); status(label('Role deleted.','تم حذف الدور.')); },true); }
    else if (target.dataset.assign) assign(target.dataset.assign);
    else if (target.dataset.unassign) { const item=role(); confirmDialog(label('Remove user from role','إزالة مستخدم من الدور'),label('The account will have no role and no access until it is assigned another role.','الحساب هيبقى بدون دور ومن غير أي صلاحية لحد ما تعيّنه لدور تاني.'),async()=>{ await api('/roles/'+encodeURIComponent(item.slug)+'/unassign',{method:'POST',body:JSON.stringify({userId:target.dataset.unassign})}); ui.users=null; await refresh(); syncAccounts(); status(label('User removed from role.','تمت إزالة المستخدم من الدور.')); }); }
    else if (target.id==='rbac-discard') { ui.draft=new Set(ui.original); syncGrantUI(); }
    else if (target.id==='rbac-save') save();
  });
  dialog.addEventListener('click', event => { if (event.target.closest('[data-close]')) closeDialog(); });
  if (typeof currentPage !== 'undefined' && currentPage==='roles') queueMicrotask(()=>window.rbacOpen());
})();
