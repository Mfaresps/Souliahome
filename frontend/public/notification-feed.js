(function () {
  'use strict';
  let owner = '', stateRequest = null, refreshTimer, lastReadErrorAt = 0, openedTask = null;
  const entries = new Map(), pending = new Map(), openedUnreadIds = new Set(), failedAvatars = new Map();
  const account = () => String(currentUser?._id || currentUser?.userId || currentUser?.sub || currentUser?.id || '');
  const loadLocal = key => { try { const value = JSON.parse(localStorage.getItem(_notifStorageKey(key)) || '[]'); return Array.isArray(value) ? value : []; } catch (_) { return []; } };
  function repaint() {
    buildNotifications();
    if (window._notifTab === 'stock') renderStockNotifsList();
    if (qs('#nc-overlay')?.classList.contains('active')) {
      _ncAllNotifs = _buildNcUpdates(); _ncAllStock = buildStockNotifs();
      _renderNcTabBar(); _renderNcContent();
      const selected = _ncAllNotifs.find(n => n.id === _ncSelectedId);
      if (selected) _renderNcDetail(selected);
    }
  }
  function scheduleRepaint() { clearTimeout(refreshTimer); refreshTimer = setTimeout(repaint, 40); }
  window.souliaSyncNotificationAccount = function () {
    const id = account();
    if (id !== owner) {
      if (owner) _mentionsCache = [];
      owner = id; entries.clear(); pending.clear(); openedUnreadIds.clear(); failedAvatars.clear(); stateRequest = null; lastReadErrorAt = 0; openedTask = null;
      _notifReadIds = loadLocal('notifReadIds'); notifDismissed = loadLocal('notifDismissed');
    }
    if (!id || stateRequest) return;
    stateRequest = api('/notifications/read-state').then(result => {
      if (id !== account()) return;
      _notifReadIds = [...new Set([..._notifReadIds, ...(result.ids || [])])];
      localStorage.setItem(_notifStorageKey('notifReadIds'), JSON.stringify(_notifReadIds));
      scheduleRepaint();
    }).catch(() => { if (id === account()) stateRequest = null; });
  };
  window.souliaIsNotificationUnread = n => !_notifReadIds.includes(n.id) && (n.mention ? !n.mention.read : n.history ? !n.historyRead : true);
  window.souliaIsNotificationHighlighted = n => window.souliaIsNotificationUnread(n) ||
    (openedUnreadIds.has(n.id) && (qs('#notif-panel')?.classList.contains('show') || qs('#nc-overlay')?.classList.contains('active')));
  window.souliaNotificationRelativeTime = function (iso, now = Date.now()) {
    const timestamp = new Date(iso).getTime();
    if (!Number.isFinite(timestamp)) return '';
    const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (seconds < 1) return currentLang === 'en' ? 'Just now' : 'منذ لحظات';
    const units = seconds < 60 ? [seconds, 'second', 'ثانية', 'ثانيتين', 'ثوانٍ'] :
      seconds < 3600 ? [Math.floor(seconds / 60), 'minute', 'دقيقة', 'دقيقتين', 'دقائق'] :
      seconds < 86400 ? [Math.floor(seconds / 3600), 'hour', 'ساعة', 'ساعتين', 'ساعات'] :
      seconds < 2592000 ? [Math.floor(seconds / 86400), 'day', 'يوم', 'يومين', 'أيام'] :
      seconds < 31536000 ? [Math.floor(seconds / 2592000), 'month', 'شهر', 'شهرين', 'أشهر'] :
      [Math.floor(seconds / 31536000), 'year', 'سنة', 'سنتين', 'سنوات'];
    const [n, unit, one, two, few] = units;
    if (currentLang === 'en') return n + ' ' + unit + (n === 1 ? '' : 's') + ' ago';
    return 'منذ ' + (n === 1 ? one : n === 2 ? two : n + ' ' + (n % 100 >= 3 && n % 100 <= 10 ? few : one));
  };
  window.souliaNotificationTimeHtml = function (iso) {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '';
    return '<time data-notification-time="' + escHtml(date.toISOString()) + '" datetime="' + escHtml(date.toISOString()) + '" title="' +
      escHtml(date.toLocaleString(currentLang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn')) + '">' + window.souliaNotificationRelativeTime(iso) + '</time>';
  };
  window.souliaNotificationTone = n => n.eventType === 'delivered' ? 'notification-delivered' : n.eventType === 'deliveryProblem' ? 'notification-delivery-issue' : '';
  window.souliaNotificationTitle = n => escHtml(['delivered', 'deliveryProblem'].includes(n.eventType) ? String(n.title || '').replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '') : n.title || '');
  window.souliaNotificationDescription = n => {
    const check = '<svg class="notification-check" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
    const description = !n.history && !n.mention && typeof _stripHtml === 'function' ? _stripHtml(n.desc || '') : n.desc || '';
    return n.eventType === 'delivered' ? '<span class="notification-delivered-copy">' + check + escHtml(description) + '</span>' : escHtml(description);
  };
  window.souliaMarkNotificationsOpened = function (openedAt = Date.now()) {
    window.souliaSyncNotificationAccount();
    if (!account()) return Promise.resolve();
    if (openedTask) return openedTask;
    const user = account();
    const snapshot = [...entries.values()].filter(n => !n.ts || Date.parse(n.ts) <= openedAt);
    openedUnreadIds.clear();
    snapshot.filter(window.souliaIsNotificationUnread).forEach(n => openedUnreadIds.add(n.id));
    const ids = [...new Set(snapshot.map(n => n.id))];
    const task = api('/notifications/read-all', { method: 'POST', body: JSON.stringify({ before: new Date(openedAt).toISOString(), ids }) }).then(result => {
      if (user !== account()) return;
      _notifReadIds = [...new Set([..._notifReadIds, ...ids])];
      localStorage.setItem(_notifStorageKey('notifReadIds'), JSON.stringify(_notifReadIds));
      snapshot.forEach(n => { if (n.mention) n.mention.read = true; if (n.history) n.historyRead = true; });
      window.souliaApplyHistoryReadAll?.(result.before, result.unread);
      if (typeof _updateMentionBadge === 'function') _updateMentionBadge();
      scheduleRepaint();
    }).catch(() => {
      if (user === account()) toast(currentLang === 'en' ? 'Could not save read status. Please try again.' : 'تعذّر حفظ حالة القراءة. حاول مجددًا.', true);
    }).finally(() => { if (user === account()) openedTask = null; });
    openedTask = task; return task;
  };
  window.souliaMergeNotifications = function (input) {
    const history = input.filter(n => n.history), consumed = new Set(), merged = [];
    for (const mention of buildMentionNotifsList()) {
      const id = String(mention.id || mention._id || '');
      if (!id) continue;
      const related = history.filter(n => n.recordId === 'mention:' + id ||
        (n.eventType === 'comment' && mention.commentId != null && String(n.event) === String(mention.commentId) && String(n.recordId || '').split(':').pop() === String(mention.txId)));
      related.forEach(n => consumed.add(n.id));
      const item = { id: 'mention-' + id, mention, historyIds: related.map(n => n.id),
        title: (typeof _sysSenderLabel === 'function' ? _sysSenderLabel(mention.fromName) : mention.fromName) || t('notifTabUpdates'),
        desc: typeof _localizeSysText === 'function' ? _localizeSysText(mention.commentText || '') : mention.commentText || '',
        actorUserId: mention.fromUserId, actorName: mention.fromName, actorAvatar: related.find(n => n.actorAvatar)?.actorAvatar,
        eventType: 'mention', type: 'info', icon: ICON('info'), ts: mention.ts,
        page: 'movements', refType: 'mention', refId: id };
      merged.push(item);
    }
    merged.push(...input.filter(n => !consumed.has(n.id)));
    const unique = [...new Map(merged.map(n => [n.id, n])).values()];
    unique.forEach(n => entries.set(n.id, n));
    return unique.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0) || a.id.localeCompare(b.id));
  };
  window.souliaNotificationUnread = function (items, stock) {
    stock.forEach(n => entries.set(n.id, n));
    const loadedHistoryUnread = (window.souliaHistoryNotifs?.() || []).filter(n => !n.historyRead).length;
    const olderUnread = Math.max(0, (window.souliaHistoryUnread?.() || 0) - loadedHistoryUnread);
    return items.filter(window.souliaIsNotificationUnread).length + stock.filter(window.souliaIsNotificationUnread).length + olderUnread + (window.souliaAnnUnread || 0);
  };
  const symbols = {
    delivered: '<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
    deliveryProblem: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3h.01"/>',
    mention: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    comment: '<path d="M21 11a8 8 0 0 1-8 8H6l-4 3 1-7a8 8 0 1 1 18-4Z"/>',
    approval: '<path d="m5 12 4 4L19 6"/><circle cx="12" cy="12" r="10"/>',
    security: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z"/><path d="M12 7v6m0 3h.01"/>',
    followup: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    default: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M10 21h4"/>',
  };
  window.souliaNotificationAvatarFailed = function (img) {
    failedAvatars.set(img.getAttribute('src'), Date.now());
    img.parentNode?.classList.remove('has-photo');
    img.remove();
  };
  window.souliaNotificationAvatar = function (n) {
    const list = typeof users !== 'undefined' && Array.isArray(users) ? users : [];
    const person = n.actorUserId ? list.find(u => String(u._id) === String(n.actorUserId)) : null;
    const rawUrl = String(n.actorAvatar || person?.avatar || '').trim();
    const url = sanitizeUrl(rawUrl) || (rawUrl.startsWith('/') && !rawUrl.startsWith('//') ? rawUrl : '');
    const glyph = !n.eventType && n.icon ? n.icon : '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (symbols[n.eventType] || symbols.default) + '</svg>';
    const fallback = '<span class="notification-avatar-fallback">' + glyph + '</span>';
    const showPhoto = url && (!failedAvatars.has(url) || Date.now() - failedAvatars.get(url) > 60000);
    return '<span class="notification-avatar" title="' + escHtml(n.actorName || n.title || '') + '">' +
      fallback + (showPhoto ? '<img src="' + escHtml(url) + '" alt="" onload="this.parentNode.classList.add(\'has-photo\')" onerror="souliaNotificationAvatarFailed(this)">' : '') + '</span>';
  };
  window.souliaReadNotification = function (id) {
    window.souliaSyncNotificationAccount();
    if (pending.has(id)) return pending.get(id);
    const n = entries.get(id) || (window.souliaHistoryNotifs?.() || []).find(item => item.id === id) || { id };
    if (!window.souliaIsNotificationUnread(n)) return Promise.resolve();
    const user = account();
    const task = (async () => {
      if (n.mention) {
        await api('/mentions/' + encodeURIComponent(n.refId) + '/read', { method: 'POST' });
        await Promise.all((n.historyIds || []).map(key => window.souliaMarkHistoryRead(key)));
      } else if (n.history) await window.souliaMarkHistoryRead(id);
      else await api('/notifications/read-state', { method: 'POST', body: JSON.stringify({ ids: [id] }) });
      if (user !== account()) return;
      if (n.mention) n.mention.read = true;
      _notifReadIds = [...new Set([..._notifReadIds, id])];
      localStorage.setItem(_notifStorageKey('notifReadIds'), JSON.stringify(_notifReadIds));
      scheduleRepaint();
    })().catch(() => {
      if (user === account() && Date.now() - lastReadErrorAt > 5000) {
        lastReadErrorAt = Date.now();
        toast(currentLang === 'en' ? 'Could not save read status. Please try again.' : 'تعذّر حفظ حالة القراءة. حاول مجددًا.', true);
      }
    }).finally(() => { if (user === account()) pending.delete(id); });
    pending.set(id, task); return task;
  };
  window.souliaOpenMentionNotification = async function (id) {
    window.souliaReadNotification('mention-' + id);
    const mention = getMentionNotifs().find(m => String(m.id || m._id) === String(id));
    if (!mention) return;
    closeNotifCenter({ navigation: true });
    await onMentionNotifClick(id, mention.txId, mention.commentId);
  };
  // Only cards actually in the visible, open list qualify, after a full second.
  function watch(root, isOpen) {
    if (!root || !window.IntersectionObserver) return;
    const timers = new Map();
    const observer = new IntersectionObserver(changes => changes.forEach(change => {
      const node = change.target;
      clearTimeout(timers.get(node)); timers.delete(node);
      if (!change.isIntersecting || change.intersectionRatio < .6 || !isOpen() || document.hidden) return;
      const id = node.dataset.notificationId, n = entries.get(id);
      if (!n || !window.souliaIsNotificationUnread(n)) return;
      const user = account();
      timers.set(node, setTimeout(() => {
        timers.delete(node);
        if (user !== account() || !node.isConnected || !isOpen() || document.hidden) return;
        const bounds = node.getBoundingClientRect();
        const foreground = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        if (foreground && node.contains(foreground)) window.souliaReadNotification(id);
      }, 1000));
    }), { root, threshold: [.6] });
    const bind = () => {
      for (const [node, timer] of timers) if (!node.isConnected || !isOpen() || document.hidden) { clearTimeout(timer); timers.delete(node); }
      observer.disconnect();
      if (isOpen() && !document.hidden) root.querySelectorAll('[data-notification-id]').forEach(node => observer.observe(node));
    };
    // Relative timestamps change every second without replacing notification cards.
    // Rebinding for those text updates would continually restart visibility timers.
    new MutationObserver(changes => {
      if (changes.some(change => [...change.addedNodes, ...change.removedNodes].some(node =>
        node.nodeType === 1 && (node.matches('[data-notification-id]') || node.querySelector('[data-notification-id]'))))) bind();
    }).observe(root, { childList: true, subtree: true });
    new MutationObserver(bind).observe(root.closest('#nc-overlay,#notif-panel'), { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', bind);
    bind();
  }
  watch(qs('#notif-list'), () => qs('#notif-panel')?.classList.contains('show'));
  watch(qs('#nc-main'), () => qs('#nc-overlay')?.classList.contains('active'));
  // State changes in another tab, plus server reconciliation for another device.
  window.addEventListener('storage', event => {
    if (event.key === _notifStorageKey('notifReadIds') || event.key === _notifStorageKey('notifDismissed')) {
      _notifReadIds = loadLocal('notifReadIds'); notifDismissed = loadLocal('notifDismissed'); scheduleRepaint();
    }
  });
  setInterval(() => { if (account() && !document.hidden) { stateRequest = null; window.souliaSyncNotificationAccount(); refreshMentionsFromServer(); } }, 20000);
  setInterval(() => {
    if (document.hidden || !account()) return;
    document.querySelectorAll('[data-notification-time]').forEach(node => { node.textContent = window.souliaNotificationRelativeTime(node.dataset.notificationTime); });
  }, 1000);
})();
