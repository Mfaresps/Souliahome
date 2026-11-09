/* Hirael Floating Action Button interaction adapted to Shopify deposit choices.
   Source: https://github.com/MohammadShehadeh/hirael/blob/main/registry/hirael/bases/radix/components/floating-action-button.tsx (MIT) */
window.ShopifyDepositFab = (() => {
  let trigger = null;
  let menu = null;
  let observer = null;
  const icons = {
    deposit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M7 3h10M17 14v4M15 16h4"/></svg>',
    shipping: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z"/><circle cx="7.5" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  };

  function close(restoreFocus = false) {
    const previous = trigger;
    observer?.disconnect();
    observer = null;
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll, true);
    menu?.remove();
    menu = null;
    if (previous?.isConnected) {
      previous.setAttribute('aria-expanded', 'false');
      previous.removeAttribute('aria-controls');
    }
    trigger = null;
    if (restoreFocus && previous?.isConnected) previous.focus({ preventScroll: true });
  }

  /* The orders table redraws on every live update (another employee, a Shopify webhook, a
     socket event), which replaces the plus button under an open menu. Follow the redrawn
     button for the same order; only when that order is no longer on screen does the menu close. */
  function liveTrigger() {
    if (trigger?.isConnected) return trigger;
    const id = trigger?.dataset.orderId;
    if (!id) return null;
    const next = [...document.querySelectorAll('.spdep-fab-trigger')]
      .find(button => button.dataset.orderId === id && !button.disabled && button.getClientRects().length);
    if (!next) return null;
    next.setAttribute('aria-expanded', 'true');
    if (menu) next.setAttribute('aria-controls', menu.id);
    trigger = next;
    return next;
  }

  function outside(event) {
    if (!trigger?.contains(event.target) && !menu?.contains(event.target)) close();
  }
  // A phone's address bar resizes the viewport on scroll; reposition, never close on that.
  function onResize() { if (!liveTrigger()) close(); else position(); }
  function onScroll() {
    if (!liveTrigger()) return close();
    const rect = trigger.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) close();
    else position();
  }

  function position() {
    if (!liveTrigger() || !menu) return close();
    const rect = trigger.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const rtl = document.documentElement.dir === 'rtl';
    const left = rtl ? rect.left : rect.right - width;
    menu.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
    const above = rect.top >= height + 12 || innerHeight - rect.bottom < height + 12;
    menu.style.top = `${above ? Math.max(8, rect.top - height - 6) : rect.bottom + 6}px`;
  }

  function choose(action) {
    const orderId = (liveTrigger() || trigger)?.dataset.orderId;
    if (!orderId) return close();
    close();
    if (action === 'deposit') openSpReceiptForm(orderId);
    else if (action === 'shipping') _spToggleShipWithoutDeposit(orderId);
  }

  function open(button) {
    trigger = button;
    menu = document.createElement('div');
    menu.id = 'spdep-fab-menu';
    menu.className = 'spdep-fab-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', button.dataset.menuLabel || 'Deposit options');
    const actions = [
      { action: 'deposit', label: button.dataset.depositLabel },
      { action: 'shipping', label: button.dataset.shippingLabel },
    ];
    for (const item of actions) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = `spdep-fab-item is-${item.action}`;
      option.setAttribute('role', 'menuitem');
      option.dataset.action = item.action;
      option.innerHTML = icons[item.action] + '<span></span>';
      option.querySelector('span').textContent = item.label;
      option.addEventListener('click', () => choose(item.action));
      menu.append(option);
    }
    document.body.append(menu);
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', menu.id);
    position();
    requestAnimationFrame(() => menu?.classList.add('is-open'));
    menu.querySelector('button')?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    observer = new MutationObserver(() => {
      if (!trigger || trigger.isConnected) return;
      if (liveTrigger()) position(); else close();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function toggle(button) {
    if (trigger === button) { close(true); return; }
    if (trigger) close();
    if (!button?.isConnected || button.disabled) return;
    open(button);
  }

  document.addEventListener('keydown', event => {
    if (!menu) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close(true); return;
    }
    if (!menu.contains(document.activeElement)) return;
    const items = [...menu.querySelectorAll('button')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length
      : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); items[next].focus(); }
  }, true);

  return { toggle, close };
})();
