const CACHE_NAME = "bkt-messenger-v1";

self.addEventListener("install", event => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || "БКТ";
  const body = data.body || "Новое сообщение";
  const url = data.senderId ? `/?chat=${encodeURIComponent(data.senderId)}` : "/";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: data.senderId ? `bkt-message-${data.senderId}` : "bkt-message",
    data: { url }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({type:"window", includeUncontrolled:true});
    for (const client of clients) {
      if ("focus" in client) {
        try { await client.navigate(target); } catch {}
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
