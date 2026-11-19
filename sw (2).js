// ══════════════════════════════════════
// WashCRM — Service Worker
// Lavage Auto des Vérités · Lapalisse
// ══════════════════════════════════════

const CACHE_NAME = 'washcrm-v2';
const STATION_LAT = 46.2497; // Latitude Lapalisse
const STATION_LNG = 3.6365;  // Longitude Lapalisse
const RAYON_METRES = 500;     // Rayon de notification : 500m

// ── Installation du service worker ──
self.addEventListener('install', event => {
  console.log('WashCRM Service Worker installé');
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  console.log('WashCRM Service Worker activé');
  event.waitUntil(clients.claim());
});

// ── Réception de notifications push ──
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Lavage Auto des Vérités';
  const options = {
    body: data.body || 'Du nouveau à la station — ouvrez l\'app pour voir.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/client' },
    tag: data.tag || undefined,
    renotify: !!data.tag,
    actions: [
      { action: 'open', title: '📱 Ouvrir l\'app' },
      { action: 'close', title: 'Plus tard' }
    ]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Clic sur notification ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'open' || !event.action) {
    const cible = (event.notification.data && event.notification.data.url) || '/client';
    event.waitUntil((async () => {
      const liste = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const base = cible.split('?')[0];
      for (const c of liste) {
        if (c.url.indexOf(base) !== -1 && 'focus' in c) {
          try { if ('navigate' in c) await c.navigate(cible); } catch (e) {}
          return c.focus();
        }
      }
      return clients.openWindow(cible);
    })());
  }
});

// ── Calcul distance GPS ──
function distanceMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Message depuis l'app principale ──
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'CHECK_PROXIMITY') {
    const { lat, lng, cashback } = event.data;
    const distance = distanceMetres(lat, lng, STATION_LAT, STATION_LNG);

    if (distance <= RAYON_METRES) {
      const msg = 'Consultez l\'état de la station et tentez le tirage au sort 🎁';

      self.registration.showNotification('🚗 Lavage Auto des Vérités', {
        body: msg,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        vibrate: [200, 100, 200],
        data: { url: '/client' },
        tag: 'proximite', // évite les doublons
        renotify: false,
      });
    }
  }
});
