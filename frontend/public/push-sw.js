'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// No fetch handler: authenticated pages, receipts and API responses are never cached.
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data.json(); } catch (_) {}
  const url = new URL(payload.url || '/', self.location.origin);
  event.waitUntil(self.registration.showNotification(String(payload.title || (payload.lang === 'en' ? 'Notification' : 'إشعار')).slice(0, 80), {
    body: String(payload.body || '').slice(0, 160), icon: '/push-icon-192.png',
    tag: String(payload.tag || 'soulia').slice(0, 80),
    lang: payload.lang === 'en' ? 'en' : 'ar', dir: payload.lang === 'en' ? 'ltr' : 'rtl',
    ...(payload.reminder === true ? { requireInteraction: true, renotify: true, vibrate: [200, 100, 200, 100, 400] } : {}),
    ...(Number.isFinite(payload.timestamp) ? { timestamp: payload.timestamp } : {}),
    data: { url: url.origin === self.location.origin ? url.pathname + url.search : '/' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    const client = clients.find(c => new URL(c.url).origin === self.location.origin);
    if (client) {
      try {
        const navigated = await client.navigate(url.href);
        if (navigated) return await navigated.focus();
      } catch (_) { /* A tab may close while the notification is being opened. */ }
    }
    return self.clients.openWindow(url.href);
  }));
});
