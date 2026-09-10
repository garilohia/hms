// Notifications only. Never cache health pages, API responses or authentication.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  // Keep health details off lock screens, including for future server delivery.
  event.waitUntil(self.registration.showNotification('HMS update', {
    body: 'Open HMS to view an unusual reading.', tag: 'hms-update', requireInteraction: true, data: { url: typeof data.url === 'string' ? data.url : '/' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || '/'));
});
