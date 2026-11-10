/* Shell presentation helpers; permissions and destinations remain owned by NAV_ITEMS. */
function shellText(ar, en) { return currentLang === 'en' ? en : ar; }
function shellPanelIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m7-11-3 3 3 3"/></svg>'; }
function syncSidebarToggle() {
  const mobile = window.innerWidth <= 768;
  const expanded = mobile ? qs('#sidebar')?.classList.contains('open') : !document.body.classList.contains('sidebar-collapsed');
  const label = expanded ? shellText('طي القائمة الجانبية', 'Collapse sidebar') : shellText('فتح القائمة الجانبية', 'Expand sidebar');
  qsa('#hamburger-btn,.shell-fold').forEach(button => {
    button.setAttribute('aria-controls', 'sidebar');
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', label);
    button.title = label;
  });
}
// Patch navigation in place so live badges do not reload the brand image,
// restart hover transitions, drop keyboard focus or reset the scroll container.
function syncShellChildren(parent, incoming) {
  const key = node => node.nodeType === 1
    ? node.tagName + ':' + (node.dataset.page || node.dataset.repSub || node.dataset.csSub || node.id || node.dataset.shellSection || node.className)
    : '#' + node.nodeType;
  const available = [...parent.childNodes];
  incoming.forEach((next, index) => {
    const matchIndex = available.findIndex(node => key(node) === key(next));
    const current = matchIndex < 0 ? next : available.splice(matchIndex, 1)[0];
    if (parent.childNodes[index] !== current) parent.insertBefore(current, parent.childNodes[index] || null);
    if (current === next) return;
    if (next.nodeType !== 1) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      return;
    }
    [...current.attributes].forEach(attr => { if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name); });
    [...next.attributes].forEach(attr => {
      if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    });
    syncShellChildren(current, [...next.childNodes]);
  });
  available.forEach(node => node.remove());
}
function renderSidebarContent(html) {
  const staging = document.createElement('div');
  staging.innerHTML = html;
  syncNavigationShell([...staging.children]);
}
function syncNavigationShell(incomingRows) {
  const sidebar = qs('#sidebar');
  if (!sidebar) return;
  if (incomingRows || (!sidebar.querySelector('.shell-brand') && sidebar.children.length)) {
    const rows = incomingRows || [...sidebar.children];
    const bottom = rows.find(el => el.classList.contains('nav-bottom-group'));
    if (!sidebar.querySelector('.shell-brand')) {
      const brand = document.createElement('div');
      brand.className = 'shell-brand';
      brand.innerHTML = '<a class="shell-brand-home" href="#dashboard" onclick="event.preventDefault();goHomeFromLogo();closeSidebar()"><img src="/soulia-logo.svg" alt="Soulia"><span class="shell-brand-name">Soulia<small>WORKSPACE</small></span></a><button class="shell-fold" type="button" onclick="toggleSidebar()">'+shellPanelIcon()+'</button>';
      sidebar.replaceChildren(brand);
      const expand = document.createElement('button');
      expand.className = 'shell-fold shell-expand'; expand.type = 'button'; expand.innerHTML = shellPanelIcon(); expand.addEventListener('click', toggleSidebar); sidebar.append(expand);
      const scroll = document.createElement('div'); scroll.className = 'shell-nav-scroll'; sidebar.append(scroll);
    }
    const scroll = sidebar.querySelector('.shell-nav-scroll');
    const content = document.createElement('div');
    const grouped = new Set();
    const sections = [
      [shellText('نظرة عامة','OVERVIEW'),['dashboard','transaction']],
      [shellText('المبيعات والطلبات','SALES & ORDERS'),['shopify-orders','movements','pickup-orders']],
      [shellText('الكتالوج','CATALOG'),['inventory','barcodes','products','categories']],
      [shellText('خدمة العملاء','CUSTOMER CARE'),['complaints','csp','clients']],
      [shellText('المالية والفريق','FINANCE & TEAM'),['approvals','suppliers','expenses','reports','vault','users']]
    ];
    for (const [label, ids] of sections) {
      const section = document.createElement('div'); section.className = 'shell-nav-section'; section.dataset.shellSection = ids[0];
      const title = document.createElement('div'); title.className = 'shell-nav-label'; title.textContent = label; section.append(title);
      for (const id of ids) {
        const row = rows.find(el => el.dataset.page === id);
        if (!row) continue;
        grouped.add(row);
        section.append(row);
        if (id === 'reports' || id === 'complaints') { const sub = rows.find(el => el.id === 'nav-sub-' + id); if (sub) { grouped.add(sub); section.append(sub); } }
      }
      if (section.children.length > 1) content.append(section);
    }
    // Keep future or plugin-provided rows visible even if absent from the grouping map.
    rows.filter(el => !el.classList.contains('nav-sep') && el !== bottom && !grouped.has(el)).forEach(el => content.append(el));
    syncShellChildren(scroll, [...content.children]);
    const previousBottom = sidebar.querySelector('.nav-bottom-group');
    if (bottom && previousBottom) syncShellChildren(previousBottom, [...bottom.children]);
    else if (bottom) sidebar.append(bottom);
    else previousBottom?.remove();
  }
  qsa('#sidebar .nav-item').forEach(row => {
    const label = row.querySelector('span:nth-child(2)')?.childNodes[0]?.textContent?.trim() || row.textContent.trim();
    row.title = label; row.setAttribute('aria-label', label);
    if (row.classList.contains('active') && !row.classList.contains('nav-parent')) row.setAttribute('aria-current','page'); else row.removeAttribute('aria-current');
    row.querySelectorAll('svg').forEach(icon => icon.setAttribute('aria-hidden','true'));
  });
  const left = qs('#header > .flex');
  let breadcrumb = qs('#shell-breadcrumb');
  if (!breadcrumb && left) { breadcrumb = document.createElement('nav'); breadcrumb.id = 'shell-breadcrumb'; breadcrumb.className = 'shell-breadcrumb'; left.append(breadcrumb); }
  if (breadcrumb) {
    let back = qs('#shell-back-btn');
    const backTarget = typeof navBackTarget === 'function' ? navBackTarget() : null;
    if (!back && backTarget) {
      back = document.createElement('button'); back.id = 'shell-back-btn'; back.type = 'button';
      back.className = 'back-btn is-icon shell-back-btn'; back.innerHTML = BACK_ARROW_SVG;
      back.addEventListener('click', () => navBack()); breadcrumb.before(back);
    }
    if (back) {
      back.hidden = !backTarget;
      const backLabel = backTarget ? tf('ivBackTo', { v: backTarget.label }) : '';
      back.title = backLabel; back.setAttribute('aria-label', backLabel);
    }
    breadcrumb.setAttribute('aria-label', shellText('المسار الحالي','Breadcrumb'));
    const entry = NAV_ITEMS.find(item => item.id === currentPage);
    const detailLabels = {
      complaints: shellText('الشكاوى', 'Complaints'),
      followups: shellText('متابعة الطلبات', 'Order Follow-ups'),
      'complaint-detail': qs('#cf-case-title')?.textContent || shellText('ملف الشكوى', 'Complaint file'),
      roles: shellText('الأدوار والصلاحيات', 'Roles & Permissions'),
      'supplier-profile': qs('#sp-name')?.textContent,
      'category-profile': qs('#catp-name')?.textContent,
      'collection-profile': qs('#colp-name')?.textContent,
    };
    const label = currentPage === 'userhub' ? 'UserHub' : currentPage === 'profile' ? t('profile') : detailLabels[currentPage] || (entry ? (currentLang === 'en' ? entry.labelEn || entry.label : entry.label) : qs('.page.active .page-title')?.textContent || currentPage);
    const sep = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
    let html = '<a class="shell-workspace" href="#dashboard" onclick="event.preventDefault();goHomeFromLogo()">'+esc(shellText('مساحة العمل','Workspace'))+'</a><span class="shell-root-sep">'+sep+'</span>';
    const sourcePath = currentPage === 'invoice-view' ? qs('#inv-view-content .shell-page-breadcrumb') : currentPage === 'category-profile' ? qs('#catp-breadcrumb') : currentPage === 'collection-profile' ? qs('#colp-breadcrumb') : null;
    if (sourcePath && sourcePath.children.length) {
      const children = [...sourcePath.children].slice(currentPage === 'invoice-view' ? 2 : 0);
      html += children.map((node, idx) => {
        if (node.tagName === 'SPAN' && node.textContent.trim() === '/') return '<span class="shell-path-sep">'+sep+'</span>';
        const clone = node.cloneNode(true);
        clone.removeAttribute('style');
        if (clone.tagName === 'A' && !clone.hasAttribute('href')) clone.setAttribute('href','#'+_pageSlug('categories'));
        if (clone.tagName === 'A') { const action = clone.getAttribute('onclick') || ''; if (!action.includes('preventDefault')) clone.setAttribute('onclick','event.preventDefault();'+action); }
        if (idx === children.length - 1) clone.setAttribute('aria-current','page');
        return clone.outerHTML;
      }).join('');
    }
    else if (currentPage === 'barcodes' && qs('#page-barcodes [data-iu-tab].active')) {
      const tab = qs('#page-barcodes [data-iu-tab].active');
      const section = tab.childNodes[0]?.textContent.trim() || tab.textContent.trim();
      const step = tab.dataset.iuTab === 'supplier-labels' ? qs('#sl-title')?.textContent.trim() : '';
      html += '<a href="#warehouse-management">'+esc(label)+'</a>'+sep;
      if (step && step !== section) html += '<a href="#warehouse-management/supplier-labels">'+esc(section)+'</a>'+sep;
      html += '<strong aria-current="page">'+esc(step || section)+'</strong>';
    }
    else if (currentPage === 'complaint-detail') html += '<a href="#complaints" onclick="handleNavClick(event,\'complaints\')">'+esc(shellText('الشكاوى','Complaints'))+'</a>'+sep+'<strong aria-current="page">'+esc(label)+'</strong>';
    else if (['complaints','followups'].includes(currentPage)) html += '<a href="#complaints" onclick="handleCustomerServiceNavClick(event)">'+esc(shellText('خدمة العملاء','Customer Service'))+'</a>'+sep+'<strong aria-current="page">'+esc(label)+'</strong>';
    else if (currentPage === 'reports' && typeof reportTabLabel === 'function' && activeReportTab) html += '<a href="#reports" onclick="handleReportsNavClick(event)">'+esc(label)+'</a>'+sep+'<strong aria-current="page">'+esc(reportTabLabel(activeReportTab))+'</strong>';
    else if (currentPage === 'clients' && window.SouliaClients?.currentProfile()) html += '<a href="#clients">'+esc(t('clients'))+'</a>'+sep+'<strong aria-current="page">'+esc(window.SouliaClients.currentProfile().name)+'</strong>';
    else if (currentPage === 'supplier-profile') html += '<a href="#suppliers" onclick="handleNavClick(event,\'suppliers\')">'+esc(t('suppliers'))+'</a>'+sep+'<strong aria-current="page">'+esc(label)+'</strong>';
    else if (currentPage === 'roles') html += '<a href="#users" onclick="handleNavClick(event,\'users\')">'+esc(t('users'))+'</a>'+sep+'<strong aria-current="page">'+esc(label)+'</strong>';
    else html += '<strong aria-current="page">'+esc(label)+'</strong>';
    // Repeated badge updates must not replace a focused breadcrumb link.
    const path = document.createElement('div');
    path.innerHTML = html;
    const current = path.querySelector('[aria-current="page"]');
    if (current) { current.setAttribute('role','heading'); current.setAttribute('aria-level','1'); current.tabIndex = -1; current.title = current.textContent.trim(); }
    syncShellChildren(breadcrumb, [...path.childNodes]);
  }
  const wrap = qs('#header .search-wrap');
  if (wrap && !wrap.querySelector('.shell-search-shortcut')) { const shortcut = document.createElement('kbd'); shortcut.className = 'shell-search-shortcut'; shortcut.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'; wrap.append(shortcut); }
  const input = qs('#global-search');
  if (input) { input.setAttribute('role','combobox'); input.setAttribute('aria-autocomplete','list'); input.setAttribute('aria-controls','search-dropdown'); input.setAttribute('aria-expanded',String(qs('#search-dropdown')?.classList.contains('active'))); }
  syncSidebarToggle();
}

function removeRecentSearch(term) {
  try { localStorage.setItem(recentSearchesKey(), JSON.stringify(getRecentSearches().filter(item => item !== term))); } catch (_) {}
  renderRecentSearches();
}
function syncSearchSelection() {
  qsa('#search-dropdown [role="option"]').forEach(row => {
    const selected = Number(row.dataset.idx) === searchSelectedIdx;
    row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected));
  });
  const input = qs('#global-search');
  const selected = qs('#search-option-' + searchSelectedIdx);
  if (selected) { input?.setAttribute('aria-activedescendant', selected.id); selected.scrollIntoView({block:'nearest'}); }
  else input?.removeAttribute('aria-activedescendant');
}

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && qs('#app')?.style.display !== 'none') {
    event.preventDefault();
    if (window.innerWidth <= 768 && !qs('.header-search')?.classList.contains('m-search-open')) toggleMobileSearch();
    qs('#global-search')?.focus();
    if (!qs('#search-dropdown')?.classList.contains('active')) {
      const value = qs('#global-search')?.value;
      if (value) handleGlobalSearch(value); else renderRecentSearches();
    }
  }
  if (event.key === 'Escape' && qs('#sidebar')?.classList.contains('open')) { closeSidebar(); qs('#hamburger-btn')?.focus(); }
});
document.addEventListener('focusin', event => { if (!event.target.closest('.header-search') && qs('#search-dropdown')?.classList.contains('active')) closeSearchDropdown(); });
window.matchMedia('(max-width:768px)').addEventListener('change', () => { closeSidebar(); syncSidebarToggle(); });
try { document.body.classList.toggle('sidebar-collapsed', localStorage.getItem('soulia_sidebar_collapsed') === '1'); } catch (_) {}
syncNavigationShell();
// Invoice contents are replaced when moving between orders or receiving live
// updates. Observe that one container so the header path follows its renderer.
const shellInvoiceHost = qs('#inv-view-content');
if (shellInvoiceHost) new MutationObserver(() => {
  if (currentPage === 'invoice-view') syncNavigationShell();
}).observe(shellInvoiceHost, {childList:true});
