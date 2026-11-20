// PropPickz alerts: show a notification when the server sends one, and open the page it points
// to when it's tapped. Nothing is cached here; the site works the same with or without it.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'PropPickz', body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'PropPickz', {
      body: data.body || '',
      tag: data.tag || undefined,
      data: { url: data.url || '/' },
      icon: '/icon-192.png',
      badge: '/favicon-64.png',
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const w of wins) {
        if (w.url.startsWith(self.location.origin)) {
          await w.focus()
          if ('navigate' in w) await w.navigate(url)
          return
        }
      }
      await self.clients.openWindow(url)
    })(),
  )
})
