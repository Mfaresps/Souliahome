(function () {
  'use strict';
  // Capture the notification before startup navigation changes the current URL.
  let pending = new URL(location.href), opening = false;
  window.souliaNavigateNotification = async function (url) {
    if (opening) return false;
    const target = new URL(url, location.href);
    if (target.origin !== new URL(location.href).origin) return false;
    if (!target.searchParams.has('pushRecord')) {
      const slug = target.hash.slice(1).split('/')[0];
      const page = typeof _pageIdFromSlug === 'function' ? _pageIdFromSlug(slug) : slug;
      const item = NAV_ITEMS.find(item => item.id === page);
      if (!item || (item.adminOnly && !isAdmin()) || (item.perm && !hasPerm(item.perm))) return false;
      navigateTo(page);
      return true;
    }
    pending = target;
    return window.souliaOpenPendingPush();
  };
  async function highlight(selector) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const element = document.querySelector(selector);
      if (element) {
        const details = element.closest('details'); if (details) details.open = true;
        element.scrollIntoView({ behavior: matchMedia('(max-width:760px), (prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth', block: 'center' });
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
    if (!record || !/^(tx|shopify|followup|mention|otp|audit|return|vault|product|expense|supplierReturn|performance|announcement):[a-f0-9]{24}$/.test(record)) return false;
    const [kind, id] = record.split(':');
    if (!['admin', 'staff', 'viewer'].includes(currentUser.role)) return false;
    const type = params.get('pushType') || '';
    if ((['otp', 'audit', 'return', 'vault', 'product', 'expense', 'supplierReturn'].includes(kind) || ['otp', 'approval', 'security', 'shopifyChange'].includes(type)) && currentUser.role !== 'admin') return false;
    const rawEvent = params.get('pushEvent') || '';
    const event = /^[A-Za-z0-9_-]{1,80}$/.test(rawEvent) ? rawEvent : '';
    opening = true;
    try {
      if (kind === 'performance') {
        if (String(currentUser.userId || currentUser._id || currentUser.id) !== id) throw new Error('Performance notification unavailable for this account.');
        navigateTo('userhub');
      } else if (kind === 'otp') {
        const otp = await api('/discount-otp/record/' + id);
        const rows = await api('/discount-otp');
        if (otp && !rows.some(row => String(row._id) === id)) rows.unshift(otp);
        if (!otp) throw new Error('OTP request unavailable.');
        navigateTo('approvals');
        ['otp-audit-kind', 'otp-audit-status', 'otp-audit-from', 'otp-audit-to', 'otp-audit-emp', 'otp-audit-code'].forEach(key => { const el = document.getElementById(key); if (el) el.value = ''; });
        switchApprTab('otp', document.getElementById('appr-tab-otp-btn'), false);
        _otpAuditAllRows = rows; _otpAuditPage = Math.floor(rows.findIndex(row => String(row._id) === id) / OTP_PAGE_SIZE) + 1;
        renderOtpTablePage();
        await highlight('[data-push-otp-id="' + id + '"]');
      } else if (kind === 'audit') {
        const log = await api('/security-audit/logs/' + id);
        if (!log?._id) throw new Error('Security event unavailable.');
        window.souliaPushSecurityRecord = log;
        navigateTo('users'); await loadSecurityPanel();
        _securityLogs = [log, ..._securityLogs.filter(row => String(row._id) !== id)];
        _securityLogPage = 0; _renderSecurityLogPage();
        await highlight('[data-push-audit-id="' + id + '"]');
      } else if (['product', 'expense', 'supplierReturn'].includes(kind)) {
        const endpoint = { product: '/products/', expense: '/expenses/', supplierReturn: '/supplier-returns/' }[kind];
        const record = await api(endpoint + id);
        if (!record?._id) throw new Error('Approval record unavailable.');
        const list = kind === 'product' ? products : kind === 'expense' ? expenses : supplierReturns;
        const index = list.findIndex(row => String(row._id) === id);
        if (index < 0) list.unshift(record); else list[index] = record;
        const row = buildApprRow({ ...record, _type: { product: 'product-edit', expense: 'expense', supplierReturn: 'supplier-return' }[kind] });
        navigateTo('approvals');
        openModal('<h3>' + esc(row.kindLabel) + '</h3><strong>' + row.title + '</strong><p>' + esc(row.statusLabel) + '</p><div class="appr-detail">' + row.detail + '</div>' + (row.actions || ''));
      } else if (kind === 'return') {
        const record = await api('/returns/' + id);
        if (!record?._id) throw new Error('Return request unavailable.');
        const index = returnRequests.findIndex(row => String(row._id) === id);
        if (index < 0) returnRequests.unshift(record); else returnRequests[index] = record;
        navigateTo('movements'); showReturnRequestMovementDetail(id);
      } else if (kind === 'vault') {
        const entry = await api('/vault/' + id);
        if (!entry?._id) throw new Error('Cash register entry unavailable.');
        const index = vaultLog.findIndex(row => String(row._id) === id);
        if (index < 0) vaultLog.unshift(entry); else vaultLog[index] = entry;
        navigateTo('vault');
        if (typeof vaultUnlocked !== 'undefined' && !vaultUnlocked) openVaultTx(entry.txNo);
        else openVaultTransactionDetail(id);
      } else if (kind === 'announcement') {
        // The server only returns announcements addressed to this account.
        if (typeof window.souliaOpenAnnouncement !== 'function' || !(await window.souliaOpenAnnouncement(id)))
          throw new Error(currentLang === 'en' ? 'Announcement unavailable for this account.' : 'الإعلان غير متاح لهذا الحساب.');
      } else if (kind === 'mention') {
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
        if (type === 'orderEdit' || (type === 'approval' && event && (order.editRequest?.id === event || (order.editRequestHistory || []).some(r => r.id === event)))) {
          navigateTo('shopify-orders'); openShopifyEditReview(id, event);
        } else if (type === 'deposit' || (type === 'approval' && event)) {
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
        if (typeof closeInvoiceDetail === 'function') closeInvoiceDetail();
        await openOrderView(id);
        if (type === 'comment' && /^\d+$/.test(event)) {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          let found = false;
          for (let attempt = 0; attempt < 30; attempt++) {
            if (highlightInvComment(Number(event)) !== false) { found = true; break; }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!found) toast(currentLang === 'en' ? 'This comment is no longer available.' : 'هذا التعليق لم يعد متاحًا.', true);
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
      const notificationId = params.get('pushNotification') || '';
      if (/^[a-f0-9]{64}$/.test(notificationId)) {
        try { await api('/notifications/history/' + notificationId + '/read', { method: 'POST' }); } catch (_) {}
        window.souliaRefreshNotificationHistory?.();
      }
      ['pushRecord', 'pushType', 'pushEvent', 'pushNotification'].forEach(key => clean.searchParams.delete(key));
      history.replaceState(null, '', clean);
    } catch (error) {
      navigateTo('movements'); toast(error.message, true);
    } finally { opening = false; pending = null; }
    return true;
  };
  if (window.souliaPushAppReady) window.souliaOpenPendingPush();
})();
