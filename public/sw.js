// Notifications only. Never cache health pages, API responses or authentication.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  // Keep health details off lock screens, including for future server delivery.
  event.waitUntil(self.registration.showNotification('HMS update', {
    body: 'Open HMS to view your update.', tag: 'hms-update', data: { url: '/' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});
