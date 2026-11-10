/* In-place page placeholders and local action feedback. */
(() => {
  const excluded = '.lfp-btn-login, .oam-button, .spdep-shipping-switch, .pw-tickhead';
  const routes = new Set(['shopify-orders', 'followups', 'complaints', 'clients', 'suppliers', 'reports', 'transaction', 'products']);
  let pending = null;
  const bar = (width = '70%', height = 14, extra = '') => `<span class="ss-skeleton ss-field-placeholder ${extra}" style="width:${width};height:${height}px" aria-hidden="true"></span>`;
  function mask(root, selector) {
    const items = [...root.querySelectorAll(selector)].filter(el => !el.closest('.ss-masked'));
    const cleanup = items.map(el => {
      const hidden = el.getAttribute('aria-hidden');
      const shimmer = document.createElement('span');
      shimmer.className = 'ss-skeleton ss-slot-placeholder'; shimmer.setAttribute('aria-hidden', 'true');
      el.classList.add('ss-masked'); el.setAttribute('aria-hidden', 'true'); el.append(shimmer);
      return () => { shimmer.remove(); el.classList.remove('ss-masked'); if (hidden === null) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', hidden); };
    });
    return () => cleanup.forEach(fn => fn());
  }
  function controls(root) {
    const items = [...root.querySelectorAll('input:not([type=hidden]),select,textarea,.pm-sel-btn,#shipco-trigger,.wh-picker > summary')].filter(el => {
      const rect = el.getBoundingClientRect(); return rect.width > 4 && rect.height > 4 && getComputedStyle(el).visibility !== 'hidden';
    });
    const slots = items.map((el,index) => {
      const host = el.tagName === 'SUMMARY' ? el.parentElement.parentElement : el.parentElement;
      const shimmer = document.createElement('span');
      shimmer.className = 'ss-skeleton ss-control-placeholder'; shimmer.setAttribute('aria-hidden', 'true');
      shimmer.dataset.control = el.id || el.name || String(index);
      host.classList.add('ss-control-host'); el.classList.add('ss-control-hidden'); host.append(shimmer);
      return { el, host, shimmer };
    });
    function fit() { slots.forEach(({el,host,shimmer}) => {
      const field = el.getBoundingClientRect(), frame = host.getBoundingClientRect();
      Object.assign(shimmer.style, { left: (field.left-frame.left-host.clientLeft+host.scrollLeft) + 'px', top: (field.top-frame.top-host.clientTop+host.scrollTop) + 'px', width: field.width + 'px', height: field.height + 'px' });
    }); }
    const resize = new ResizeObserver(fit); slots.forEach(({el}) => resize.observe(el)); fit();
    return () => { resize.disconnect(); slots.forEach(({el,host,shimmer}) => { shimmer.remove(); el.classList.remove('ss-control-hidden'); host.classList.remove('ss-control-host'); }); };
  }
  function table(table, count = 6) {
    if (!table) return;
    const headings = [...table.querySelectorAll('thead tr:first-child > th')];
    const cells = headings.map(th => {
      const key = th.dataset.i18n || th.querySelector('[data-i18n]')?.dataset.i18n;
      let field = bar();
      if (th.querySelector('input[type=checkbox]')) field = bar('16px',16);
      else if (key === 'colImage') field = '<span class="product-thumb inv-thumb ss-skeleton" aria-hidden="true"></span>';
      else if (key === 'colCode' || key === 'fuTableOrder') field = bar('56px',14);
      else if (key === 'colName' || key === 'fuTableClient') field = `<span style="display:grid;gap:6px">${bar('80%',16)}${bar('50%',11)}</span>`;
      else if (key === 'csStatus') field = bar('85%',24);
      else if (key === 'colActions' || key === 'csOptions') field = `${bar('26px',26)} ${bar('26px',26)}`;
      return `<td class="${th.className}"${th.dataset.col ? ` data-col="${th.dataset.col}"` : ''} style="${th.style.display === 'none' ? 'display:none;' : ''}">${field}</td>`;
    }).join('');
    table.querySelector('tbody').innerHTML = `<tr class="ss-placeholder-row">${cells}</tr>`.repeat(count);
  }
  function productsLoading(root) {
    if (typeof setProdViewMode === 'function') setProdViewMode(prodViewMode);
    table(root.querySelector('#prod-table'));
    const grid = root.querySelector('#prod-grid-view'), list = root.querySelector('#prod-list-view');
    if (grid) grid.innerHTML = `<div class="prod-grid-card" aria-hidden="true"><div class="product-thumb prod-grid-thumb ss-skeleton"></div><div class="pgc-body"><div class="pgc-name">${bar('80%',18)}</div><div class="pgc-code">${bar('45%',12)}</div><div class="pgc-meta"><span class="pgc-price">${bar('72px',20)}</span><span class="pgc-stock">${bar('58px',14)}</span></div></div><div class="pgc-actions">${bar('70px',30)}</div></div>`.repeat(6);
    if (list) list.innerHTML = `<div class="prod-list-row" aria-hidden="true">${bar('16px',16)}<span class="product-thumb prod-list-thumb ss-skeleton"></span><div class="plr-info"><div class="plr-name">${bar('75%',18)}</div><div class="plr-code">${bar('45%',12)}</div></div><div class="plr-supplier">${bar()}</div><div class="plr-price">${bar()}</div><div class="plr-stock">${bar()}</div><div class="plr-actions">${bar('60px',30)}</div></div>`.repeat(6);
  }
  function suppliersLoading(root) {
    const host = root.querySelector('#suppliers-grid');
    if (host) host.innerHTML = `<div class="sup-card2" aria-hidden="true"><div class="sup-card2-top"><div class="sup-card2-avatar ss-skeleton"></div><div class="sup-card2-id"><h4>${bar('140px',18)}</h4><div class="sup-meta-line">${bar('110px',12)}</div></div><span class="sup-pill empty">${bar('54px',14)}</span></div><div class="sup-card2-stats">${`<div class="sup-stat"><span class="sup-stat-val">${bar('64px',18)}</span><span class="sup-stat-label">${bar('48px',12)}</span></div>`.repeat(3)}</div><div class="sup-card2-actions">${bar('110px',32)}${bar('32px',32)}</div></div>`.repeat(6);
  }
  function followupsLoading(root = document.getElementById('page-complaints')) {
    if (!root) return;
    table(root.querySelector('#fu-table'));
    const cards = root.querySelector('#fu-cards');
    if (cards) cards.innerHTML = `<div class="fu-card" aria-hidden="true"><div class="fu-card-header"><div class="fu-card-headline"><span class="fu-card-order">${bar('64px',18)}</span><span class="fu-card-client">${bar('110px',16)}</span></div><div class="fu-card-head-end">${bar('40px',12)}</div></div><div class="fu-card-status-row">${bar('130px',26)}</div><div class="fu-card-meta-row">${bar('110px',14)}${bar('60px',14)}</div></div>`.repeat(3);
    if (typeof renderFuKpi === 'function') renderFuKpi([]);
    root.querySelectorAll('#fu-kpi .fu-kpi-val').forEach(value => { value.innerHTML = bar('20px',12); });
  }
  function clearRoute(page) {
    const main = document.getElementById('main');
    if (!main?.dataset.pendingRoute || page && main.dataset.pendingRoute !== page) return;
    if (pending) {
      pending.cleanup.forEach(fn => fn());
      pending.root.classList.remove('ss-pending-page'); pending.root.inert = pending.inert;
      if (pending.busy === null) pending.root.removeAttribute('aria-busy'); else pending.root.setAttribute('aria-busy', pending.busy);
      pending = null;
    }
    delete main.dataset.pendingRoute;
    main.removeAttribute('aria-busy');
    const status = document.getElementById('page-loading-status');
    if (status) { status.textContent = ''; status.hidden = true; }
  }
  function route(page) {
    if (!routes.has(page)) return;
    if (typeof currentPage !== 'undefined' && currentPage === 'transaction' && typeof txDirty !== 'undefined' && txDirty && page !== 'transaction') return;
    const main = document.getElementById('main');
    if (!main) return;
    clearRoute();
    const root = document.getElementById('page-' + (page === 'followups' ? 'complaints' : page));
    if (!root) return;
    pending = { root, inert: root.inert, busy: root.getAttribute('aria-busy'), cleanup: [] };
    main.dataset.pendingRoute = page;
    main.setAttribute('aria-busy', 'true');
    root.classList.add('ss-pending-page'); root.inert = true; root.setAttribute('aria-busy', 'true');
    let status = document.getElementById('page-loading-status');
    if (!status) { status = document.createElement('div'); status.id = 'page-loading-status'; status.setAttribute('role','status'); status.setAttribute('aria-live','polite'); main.append(status); }
    status.hidden = false; status.textContent = typeof currentLang !== 'undefined' && currentLang === 'en' ? 'Loading…' : 'جارٍ التحميل…';
    // Use the destination's real frame and component classes; never a generic loading page.
    const hosts = page === 'products' ? ['#prod-table tbody','#prod-grid-view','#prod-list-view'] : page === 'suppliers' ? ['#suppliers-grid'] : page === 'clients' ? ['#clients-grid'] : page === 'reports' ? ['#rep-stats'] : page === 'followups' ? ['#fu-tbody','#fu-cards','#fu-kpi'] : [];
    hosts.forEach(selector => {
      const host = root.querySelector(selector); if (!host) return;
      const busy = host.getAttribute('aria-busy');
      const saved = document.createDocumentFragment(); saved.append(...host.childNodes);
      pending.cleanup.push(() => { host.replaceChildren(saved); if (busy === null) host.removeAttribute('aria-busy'); else host.setAttribute('aria-busy',busy); });
    });
    if (page === 'products') productsLoading(root);
    else if (page === 'suppliers') suppliersLoading(root);
    else if (page === 'clients') window.SouliaClients?.showLoading();
    else if (page === 'reports' && typeof renderReportKPIs === 'function') {
      renderReportKPIs({}, true);
    } else if (page === 'transaction') {
      if (!root.querySelector('#tx-fields #tx-ref,#tx-fields #tx-client,#tx-fields #tx-supplier') && typeof renderTxFields === 'function' && typeof _spDepIcon === 'function') { renderTxFields(); renderTxItems(); calcTxSummary(); }
      pending.cleanup.push(controls(root));
      pending.cleanup.push(mask(root, '#tx-summary .row > :last-child,#tx-items .tx-empty-state'));
    } else if (page === 'shopify-orders' && typeof _spShowOrdersLoading === 'function') {
      _spShowOrdersLoading();
      if (typeof _spkRender === 'function') _spkRender('loading');
    } else if (page === 'followups') {
      [['#fu-orders-section','block'],['#cmp-complaints-section','none'],['#fu-kpi-toolbar-row','flex'],['#cmp-header-block','none']].forEach(([selector,display]) => {
        const node = root.querySelector(selector); if (!node) return;
        const original = node.style.display; node.style.display = display;
        pending.cleanup.push(() => { node.style.display = original; });
      });
      followupsLoading(root);
    }
    const breadcrumb = document.getElementById('shell-breadcrumb');
    if (breadcrumb) pending.cleanup.push(mask(breadcrumb, '[aria-current="page"]'));
    pending.cleanup.push(mask(root, '.fx-results-count,[id^="prod-count-"],#sup-count-label,.spk-val,.spk-sub'));
  }
  window.SouliaLoading = { route, clearRoute, mask, table, followups: followupsLoading };

  function sync(button) {
    if (!(button instanceof HTMLButtonElement) || button.matches(excluded)) return;
    const busy = button.getAttribute('aria-busy') === 'true';
    const loader = button.querySelector(':scope > .ss-action-loader');
    if (!busy) {
      button.classList.remove('ss-action-busy');
      loader?.remove();
      return;
    }
    if ((!button.textContent.trim() && !button.getAttribute('aria-label')) || button.getAttribute('role') === 'switch') return;
    button.classList.add('ss-action-busy');
    if (!loader) {
      const icon = document.createElement('span');
      icon.className = 'ss-action-loader';
      icon.setAttribute('aria-hidden', 'true');
      button.append(icon);
    }
  }

  function scan(root) {
    if (!(root instanceof Element)) return;
    if (root.matches('button[aria-busy]')) sync(root);
    root.querySelectorAll('button[aria-busy]').forEach(sync);
  }

  function init() {
    scan(document.body);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') sync(record.target);
        else for (const node of record.addedNodes) scan(node);
      }
    });
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-busy'],
      childList: true,
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
