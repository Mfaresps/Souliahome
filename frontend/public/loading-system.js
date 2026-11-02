/* Presentation only: mirrors existing aria-busy states inside their own buttons. */
(() => {
  const excluded = '.lfp-btn-login, .oam-button, .spdep-shipping-switch, .pw-tickhead';

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
