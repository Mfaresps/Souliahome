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
function syncNavigationShell() {
  const sidebar = qs('#sidebar');
  if (!sidebar) return;
  if (!sidebar.querySelector('.shell-brand') && sidebar.children.length) {
    const rows = [...sidebar.children];
    const bottom = rows.find(el => el.classList.contains('nav-bottom-group'));
    const brand = document.createElement('div');
    brand.className = 'shell-brand';
    brand.innerHTML = '<a class="shell-brand-home" href="#dashboard" onclick="event.preventDefault();goHomeFromLogo();closeSidebar()"><img src="/soulia-logo.svg" alt="Soulia"><span class="shell-brand-name">Soulia<small>WORKSPACE</small></span></a><button class="shell-fold" type="button" onclick="toggleSidebar()">'+shellPanelIcon()+'</button>';
    sidebar.replaceChildren(brand);
    const expand = document.createElement('button');
    expand.className = 'shell-fold shell-expand'; expand.type = 'button'; expand.innerHTML = shellPanelIcon(); expand.addEventListener('click', toggleSidebar); sidebar.append(expand);
    const scroll = document.createElement('div'); scroll.className = 'shell-nav-scroll'; sidebar.append(scroll);
    const sections = [
      [shellText('نظرة عامة','OVERVIEW'),['dashboard','transaction']],
      [shellText('المبيعات والطلبات','SALES & ORDERS'),['shopify-orders','movements','pickup-orders']],
      [shellText('الكتالوج','CATALOG'),['inventory','products','categories']],
      [shellText('خدمة العملاء','CUSTOMER CARE'),['complaints','csp','clients']],
      [shellText('المالية والفريق','FINANCE & TEAM'),['approvals','suppliers','expenses','reports','vault','users']]
    ];
    for (const [label, ids] of sections) {
      const section = document.createElement('div'); section.className = 'shell-nav-section';
      const title = document.createElement('div'); title.className = 'shell-nav-label'; title.textContent = label; section.append(title);
      for (const id of ids) {
        const row = rows.find(el => el.dataset.page === id);
        if (!row) continue;
        section.append(row);
        if (id === 'reports') { const sub = rows.find(el => el.id === 'nav-sub-reports'); if (sub) section.append(sub); }
      }
      if (section.children.length > 1) scroll.append(section);
    }
    // Keep future or plugin-provided rows visible even if absent from the grouping map.
    rows.filter(el => !el.classList.contains('nav-sep') && el !== bottom && !sidebar.contains(el)).forEach(el => scroll.append(el));
    if (bottom) sidebar.append(bottom);
  }
  qsa('#sidebar .nav-item').forEach(row => {
    const label = row.querySelector('span:nth-child(2)')?.childNodes[0]?.textContent?.trim() || row.textContent.trim();
    row.title = label; row.setAttribute('aria-label', label);
    if (row.classList.contains('active')) row.setAttribute('aria-current','page'); else row.removeAttribute('aria-current');
    row.querySelectorAll('svg').forEach(icon => icon.setAttribute('aria-hidden','true'));
  });
  const left = qs('#header > .flex');
  let breadcrumb = qs('#shell-breadcrumb');
  if (!breadcrumb && left) { breadcrumb = document.createElement('nav'); breadcrumb.id = 'shell-breadcrumb'; breadcrumb.className = 'shell-breadcrumb'; left.append(breadcrumb); }
  if (breadcrumb) {
    breadcrumb.setAttribute('aria-label', shellText('المسار الحالي','Breadcrumb'));
    const entry = NAV_ITEMS.find(item => item.id === currentPage);
    const label = currentPage === 'userhub' ? 'UserHub' : currentPage === 'profile' ? t('profile') : entry ? (currentLang === 'en' ? entry.labelEn || entry.label : entry.label) : qs('.page.active .page-title')?.textContent || currentPage;
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
    else if (currentPage === 'reports' && typeof reportTabLabel === 'function' && activeReportTab) html += '<a href="#reports" onclick="handleNavClick(event,\'reports\')">'+esc(label)+'</a>'+sep+'<strong aria-current="page">'+esc(reportTabLabel(activeReportTab))+'</strong>';
    else html += '<strong aria-current="page">'+esc(label)+'</strong>';
    breadcrumb.innerHTML = html;
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
