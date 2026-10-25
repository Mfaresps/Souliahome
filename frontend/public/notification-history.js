(function () {
  'use strict';
  let rows = [], next = '', owner = '', busy = false, loadedOlder = false, unread = 0, readRevision = 0;
  const accountId = () => String(currentUser?.userId || currentUser?._id || currentUser?.id || '');
  function syncOwner() {
    const id = accountId();
    if (id !== owner) { owner = id; rows = []; next = ''; loadedOlder = false; unread = 0; busy = false; }
    return id;
  }
  function repaint() {
    if (typeof buildNotifications === 'function') buildNotifications();
    if (qs('#nc-overlay')?.classList.contains('active')) {
      _ncAllNotifs = _buildNcUpdates(); _renderNcTabBar();
      if (_ncTab === 'updates') { _renderNcContent(); const selected = _ncAllNotifs.find(n => n.id === _ncSelectedId); if (selected) _renderNcDetail(selected); }
    }
  }
  window.souliaRefreshNotificationHistory = async function (more = false) {
    const id = syncOwner();
    if (!id || busy || (more && !next)) return;
    busy = true;
    const revision = readRevision;
    try {
      const result = await api('/notifications/history' + (more ? '?before=' + encodeURIComponent(next) : ''));
      if (id !== accountId() || revision !== readRevision) return;
      const merged = new Map(rows.map(r => [r._id, r]));
      for (const item of result.items || []) merged.set(item._id, item);
      rows = [...merged.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      if (more || !loadedOlder) next = result.next || '';
      if (more) loadedOlder = true;
      unread = Number.isFinite(result.unread) ? result.unread : rows.filter(r => !r.readAt).length;
      repaint();
    } catch (e) {
      if (more) toast(e.message, true);
    } finally { if (id === owner) busy = false; }
  };
  window.souliaHistoryNotifs = function () {
    syncOwner();
    return rows.map(r => ({ id: 'history-' + r._id, history: true, historyRead: !!r.readAt, icon: ICON(r.type === 'comment' ? 'info' : 'alarm'), type: 'info',
      eventType: r.type, eventId: r.eventId, recordId: r.recordId, event: r.event, actorUserId: r.actorUserId, actorName: r.actorName, actorAvatar: r.actorAvatar,
      title: r.title + (r.ref ? ' · #' + r.ref : ''), desc: r.commentText ? [r.actorName, r.commentText].filter(Boolean).join(' · ') : r.body,
      ts: r.createdAt, page: r.recordId?.startsWith('followup:') ? 'complaints' : r.recordId?.startsWith('shopify:') ? 'shopify-orders' : 'movements',
      refType: 'history', refId: r._id }));
  };
  window.souliaHistoryMoreButton = () => next ? `<button type="button" class="btn btn-outline btn-sm" style="margin:12px" onclick="souliaRefreshNotificationHistory(true)">${currentLang === 'en' ? 'Load older notifications' : 'عرض إشعارات أقدم'}</button>` : '';
  window.souliaHistoryUnread = () => { syncOwner(); return unread; };
  window.souliaApplyHistoryReadAll = function (before, remainingUnread) {
    syncOwner(); readRevision++;
    const cutoff = Date.parse(before);
    for (const row of rows) if (Date.parse(row.createdAt) <= cutoff) row.readAt = row.readAt || before;
    unread = Number.isFinite(remainingUnread) ? remainingUnread : rows.filter(row => !row.readAt).length;
  };
  window.souliaMarkHistoryRead = async function (id) {
    const account = syncOwner();
    const row = rows.find(r => 'history-' + r._id === id);
    if (!row || row.readAt) return;
    await api('/notifications/history/' + row._id + '/read', { method: 'POST' });
    if (account !== accountId()) return;
    readRevision++;
    if (!row.readAt) unread = Math.max(0, unread - 1);
    row.readAt = new Date().toISOString();
    if (typeof _ncAllNotifs !== 'undefined') { const item = _ncAllNotifs.find(n => n.id === id); if (item) item.historyRead = true; }
  };
  window.souliaOpenHistory = async function (id) {
    const row = rows.find(r => r._id === id);
    if (!row) return;
    // Opening the event must not wait for the read-receipt request.
    window.souliaMarkHistoryRead('history-' + id).catch(() => {
      toast(currentLang === 'en' ? 'Could not save read status. Please try again.' : 'تعذّر حفظ حالة القراءة. حاول مجددًا.', true);
    });
    qs('#notif-panel')?.classList.remove('show');
    if (typeof closeNotifCenter === 'function') closeNotifCenter({ navigation: true });
    const target = new URL(row.url || '/', location.href);
    if (row.recordId) {
      target.searchParams.set('pushRecord', row.recordId);
      target.searchParams.set('pushType', row.type || '');
      if (row.event != null) target.searchParams.set('pushEvent', String(row.event));
    }
    if (!await window.souliaNavigateNotification(target.href)) {
      toast(currentLang === 'en' ? 'This event is no longer available or you do not have access.' : 'الحدث لم يعد متاحًا أو ليس لديك صلاحية لفتحه.', true);
    }
    repaint();
  };
  setInterval(() => { if (typeof currentUser !== 'undefined' && currentUser && !document.hidden) window.souliaRefreshNotificationHistory(); }, 20000);
  if (typeof window.addEventListener === 'function') window.addEventListener('focus', () => window.souliaRefreshNotificationHistory());
  if (typeof currentUser !== 'undefined' && currentUser) window.souliaRefreshNotificationHistory();
})();
