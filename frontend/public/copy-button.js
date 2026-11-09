/* Hirael Copy Button behavior adapted to Soulia's plain JavaScript frontend.
   Source: https://github.com/MohammadShehadeh/hirael/blob/main/registry/hirael/bases/radix/components/copy-button.tsx (MIT) */
window.SouliaCopyButton = (() => {
  const timers = new WeakMap();
  const icons = '<span class="hcb-icons" aria-hidden="true"><svg class="hcb-copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><svg class="hcb-check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></span>';

  async function writeText(value) {
    const text = String(typeof value === 'function' ? value() : value);
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return text; }
      catch (_) { /* The clipboard API may be denied in an unfocused or insecure page. */ }
    }
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const field = document.createElement('textarea');
    field.value = text;
    field.readOnly = true;
    field.style.cssText = 'position:fixed;inset:0 auto auto 0;opacity:0;pointer-events:none';
    document.body.appendChild(field);
    try {
      field.focus();
      field.select();
      if (!document.execCommand?.('copy')) throw new Error('Copy command was rejected');
      return text;
    } finally {
      field.remove();
      previousFocus?.focus({ preventScroll: true });
    }
  }

  function setState(button, state, message) {
    button.dataset.state = state;
    button.setAttribute('aria-label', message);
    button.title = message;
    let status = button.querySelector('.hcb-status');
    if (!status) {
      status = document.createElement('span');
      status.className = 'hcb-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      button.appendChild(status);
    }
    status.textContent = state === 'idle' ? '' : message;
  }

  async function copy(button, value, options = {}) {
    if (!button || button.disabled || button.dataset.state === 'copying') return false;
    const label = options.label || button.dataset.copyLabel || button.getAttribute('aria-label') || 'Copy to clipboard';
    const copiedLabel = options.copiedLabel || button.dataset.copiedLabel || 'Copied';
    const errorLabel = options.errorLabel || button.dataset.errorLabel || 'Copy failed';
    const timeout = Number(options.timeout ?? button.dataset.copyTimeout ?? 1500);
    clearTimeout(timers.get(button));
    button.dataset.state = 'copying';
    try {
      const text = await writeText(value);
      if (button.isConnected) setState(button, 'copied', copiedLabel);
      options.onCopy?.(text);
      if (button.isConnected) timers.set(button, setTimeout(() => setState(button, 'idle', label), timeout));
      return true;
    } catch (error) {
      if (button.isConnected) setState(button, 'error', errorLabel);
      options.onCopyError?.(error);
      if (button.isConnected) timers.set(button, setTimeout(() => setState(button, 'idle', label), timeout));
      return false;
    }
  }

  return { icons, writeText, copy };
})();
