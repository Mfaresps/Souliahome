(function () {
  'use strict';
  // Capture the notification before startup navigation changes the current URL.
  let pending = new URL(location.href), opening = false;
  async function highlight(selector) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const element = document.querySelector(selector);
      if (element) {
        const details = element.closest('details'); if (details) details.open = true;
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.classList.add('comment-mention-highlight');
        setTimeout(() => element.classList.remove('comment-mention-highlight'), 4000);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  window.souliaOpenPendingPush = async function () {
    if (opening || !window.souliaPushAppReady || typeof currentUser === 'undefined' || !currentUser) return false;
    const params = pending?.searchParams;
    const record = params?.get('pushRecord');
    if (!record || !/^(tx|shopify|followup|mention):[a-f0-9]{24}$/.test(record)) return false;
    const [kind, id] = record.split(':');
    if (kind !== 'mention' && currentUser.role !== 'admin') return false;
    const type = params.get('pushType') || '';
    const rawEvent = params.get('pushEvent') || '';
    const event = /^[A-Za-z0-9_-]{1,80}$/.test(rawEvent) ? rawEvent : '';
    opening = true;
    try {
      if (kind === 'mention') {
        const mentions = await api('/mentions');
        const mention = mentions.find(m => String(m.id || m._id) === id);
        if (!mention) throw new Error(currentLang === 'en' ? 'Mention unavailable for this account.' : 'الإشارة غير متاحة لهذا الحساب.');
        saveMentionNotifs(mentions); await onMentionNotifClick(id, mention.txId, mention.commentId);
      } else if (kind === 'followup') {
        await goToFuAndHighlight(id, true, type === 'comment' ? event : '', true);
      } else if (kind === 'shopify') {
        await loadShopifyOrders();
        const order = _spOrderById(id);
        if (!order) throw new Error(currentLang === 'en' ? 'Order unavailable.' : 'الأوردر غير متاح.');
        if (type === 'deposit') {
          navigateTo('shopify-orders'); openSpOrderPeek(id);
          await highlight(event ? `#sp-peek [data-push-receipt-id="${CSS.escape(event)}"]` : '#sp-peek .spdep-section');
        } else if (type === 'comment' || !type) {
          await openShopifyOrderComments(id, /^\d+$/.test(event) ? event : undefined);
        } else { navigateTo('shopify-orders'); openSpOrderPeek(id); }
      } else {
        // Refresh the target even if this tab has an older cached transaction.
        const tx = await api('/transactions/' + id);
        if (!tx?._id) throw new Error(currentLang === 'en' ? 'Order unavailable.' : 'الأوردر غير متاح.');
        const index = transactions.findIndex(t => String(t._id) === id);
        if (index < 0) transactions.unshift(tx); else transactions[index] = tx;
        openOrderView(id);
        if (type === 'comment' && /^\d+$/.test(event)) {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          highlightInvComment(Number(event));
        } else if (type === 'deposit') {
          const receipt = (tx.depositReceipts || []).some(r => String(r.id) === event);
          if (receipt) await highlight(`[data-push-receipt-id="${CSS.escape(event)}"]`);
          else {
            showInvoicePaymentHistory(id);
            if (event) await highlight(`[data-push-payment-id="${CSS.escape(event)}"]`);
          }
        }
      }
      const clean = new URL(location.href);
      ['pushRecord', 'pushType', 'pushEvent'].forEach(key => clean.searchParams.delete(key));
      history.replaceState(null, '', clean);
    } catch (error) {
      navigateTo('movements'); toast(error.message, true);
    } finally { opening = false; pending = null; }
    return true;
  };
  if (window.souliaPushAppReady) window.souliaOpenPendingPush();
})();
