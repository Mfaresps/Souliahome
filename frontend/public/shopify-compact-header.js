/* Reuse the existing section permissions, routes, counters and refresh request. */
(() => {
  const host = document.getElementById('page-shopify-orders');
  if (!host) return;
  const menus = [...host.querySelectorAll('.sp-header-menu')];
  function sync() {
    const active = host.querySelector('#sp-subnav .active span[data-i18n]');
    const label = document.getElementById('sp-section-label');
    if (active && label) {
      label.textContent = active.textContent;
      label.dataset.i18n = active.dataset.i18n;
    }
    const badge = document.getElementById('sp-subnav-deposits-n');
    const count = document.getElementById('sp-section-count');
    count.textContent = badge?.textContent || '';
    count.hidden = !isAdmin() || !badge || badge.hidden;
    count.title = t('spDepTabHint');
    count.setAttribute('aria-label', `${t('spDepTab')}: ${count.textContent}`);
  }
  window.spCompactHeader = { sync };
  const bar = document.getElementById('sp-subnav');
  new MutationObserver(sync).observe(bar, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['class','hidden']});
  menus.forEach(menu => {
    menu.addEventListener('toggle', () => {
      if (menu.open) menus.forEach(other => { if (other !== menu) other.open = false; });
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { menu.open = false; menu.querySelector('summary').focus(); }
    });
  });
  document.addEventListener('click', event => {
    menus.forEach(menu => {
      if (!menu.contains(event.target) || event.target.closest('button')) menu.open = false;
    });
  });

  const indicator = document.createElement('div');
  indicator.className = 'sp-pull-indicator';
  indicator.setAttribute('role', 'status');
  indicator.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v6h-6"/></svg>';
  host.append(indicator);
  let gesture = null, busy = false;
  const mobile = () => matchMedia('(max-width:768px)').matches;
  function atTop(target) {
    for (let el = target; el && el !== document; el = el.parentElement) {
      if (el.scrollTop > 1) return false;
    }
    return (document.scrollingElement?.scrollTop || window.scrollY || 0) <= 1;
  }
  function reset() {
    gesture = null;
    indicator.classList.remove('is-visible', 'is-loading');
    indicator.style.transform = '';
    indicator.setAttribute('aria-label', '');
  }
  host.addEventListener('touchstart', event => {
    if (!mobile() || busy || currentPage !== 'shopify-orders' || event.touches.length !== 1 || !atTop(event.target) ||
      event.target.closest('input,textarea,select,button,a,summary,dialog,[role="dialog"],.sp-header-menu')) return;
    gesture = {x:event.touches[0].clientX, y:event.touches[0].clientY, distance:0};
  }, {passive:true});
  host.addEventListener('touchmove', event => {
    if (!gesture || busy) return;
    if (event.touches.length !== 1 || !atTop(event.target)) { reset(); return; }
    const dy = event.touches[0].clientY - gesture.y, dx = event.touches[0].clientX - gesture.x;
    if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) { reset(); return; }
    if (dy < 10) return;
    if (event.cancelable) event.preventDefault();
    gesture.distance = Math.min(90, dy * .5);
    indicator.classList.add('is-visible');
    indicator.style.transform = `translate(-50%,${gesture.distance}px)`;
    indicator.querySelector('svg').style.transform = `rotate(${gesture.distance * 3}deg)`;
  }, {passive:false});
  host.addEventListener('touchcancel', reset, {passive:true});
  host.addEventListener('touchend', async () => {
    if (!gesture || busy) return;
    if (gesture.distance < 60) { reset(); return; }
    busy = true;
    gesture = null;
    indicator.classList.add('is-loading');
    indicator.querySelector('svg').style.transform = '';
    indicator.setAttribute('aria-label', t('spRefresh'));
    try {
      await withHeaderRefresh('shopify-orders', () => loadShopifyOrders());
      if (_spSubnavTab === 'perf') await renderPerformanceDashboard();
      if (_spSubnavTab === 'deposit-log') await renderSpDepositHistory(true);
    } catch (error) { toast(error.message || t('spLoadFailed'), true); }
    finally { busy = false; reset(); }
  }, {passive:true});
  sync();
})();
