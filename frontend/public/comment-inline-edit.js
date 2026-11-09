/* Hirael Inline Edit interaction adapted for Soulia's existing comment views.
   Source: https://github.com/MohammadShehadeh/hirael/blob/main/registry/hirael/bases/radix/components/inline-edit.tsx (MIT) */
window.CommentInlineEdit = (() => {
  const check = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>';
  const cross = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  function open({ host, value, inputId, onSave, onCancel, label, saveLabel, cancelLabel, requiredMessage, errorMessage }) {
    if (!host || host.classList.contains('cie-editing')) return;
    const original = host.innerHTML;
    const cardId = host.closest('.tx-cmt, .inv-cmt-item')?.id;
    const restore = () => {
      if (!host.isConnected) return;
      host.innerHTML = original;
      host.classList.remove('cie-editing', 'cie-pending');
      host.removeAttribute('data-state');
      host.closest('.tx-cmt, .inv-cmt-item')?.querySelector('.tx-cmt-actions .tx-cmt-btn')?.focus({ preventScroll: true });
      onCancel?.();
    };

    host.classList.add('cie-editing');
    host.dataset.state = 'editing';
    host.innerHTML = `<div class="cie-field"><textarea class="cie-input" rows="2"></textarea><div class="cie-controls"><button type="button" class="cie-save" data-action="save">${check}<span></span></button><button type="button" class="cie-cancel" data-action="cancel">${cross}<span></span></button></div></div><p class="cie-error" role="alert" hidden></p>`;
    const input = host.querySelector('textarea');
    const save = host.querySelector('[data-action="save"]');
    const cancel = host.querySelector('[data-action="cancel"]');
    const error = host.querySelector('.cie-error');
    input.id = inputId;
    input.setAttribute('aria-label', label);
    input.value = value;
    save.querySelector('span').textContent = saveLabel;
    cancel.querySelector('span').textContent = cancelLabel;
    save.setAttribute('aria-label', saveLabel);
    cancel.setAttribute('aria-label', cancelLabel);

    const showError = message => {
      error.textContent = message;
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', `${inputId}-error`);
      error.id = `${inputId}-error`;
    };
    const submit = async () => {
      if (host.classList.contains('cie-pending')) return;
      const next = input.value.trim();
      if (!next) { showError(requiredMessage); input.focus(); return; }
      if (next === value.trim()) { restore(); return; }
      error.hidden = true;
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
      host.classList.add('cie-pending');
      host.dataset.state = 'saving';
      input.disabled = save.disabled = cancel.disabled = true;
      try {
        const result = await onSave(next);
        if (result === false) throw new Error(errorMessage);
        const nextCard = cardId && document.getElementById(cardId);
        if (nextCard) {
          const bubble = nextCard.querySelector('.tx-cmt-text');
          bubble?.classList.add('cie-saved');
          bubble?.addEventListener('animationend', () => bubble.classList.remove('cie-saved'), { once: true });
        }
      } catch (reason) {
        if (!host.isConnected) return;
        showError(reason?.message || errorMessage);
        input.disabled = save.disabled = cancel.disabled = false;
        host.classList.remove('cie-pending');
        host.dataset.state = 'editing';
        input.focus();
      }
    };
    save.addEventListener('click', submit);
    cancel.addEventListener('click', restore);
    input.addEventListener('input', () => { error.hidden = true; input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); });
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); restore(); }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
    });
    input.focus();
    input.select();
  }

  return { open };
})();
