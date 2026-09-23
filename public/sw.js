const CACHE_NAME = "bkt-messenger-v2";
self.addEventListener("install", event => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const isCall = data.type === "incoming-call";
  const title = data.title || (isCall ? "📞 Входящий звонок" : "БКТ");
  const body = data.body || (isCall ? "Вам звонят" : "Новое сообщение");
  const url = isCall ? `/?incomingCall=${encodeURIComponent(data.callId || "")}` : (data.senderId ? `/?chat=${encodeURIComponent(data.senderId)}` : "/");
  event.waitUntil(self.registration.showNotification(title, {
    body, icon: "/icon.svg", badge: "/icon.svg",
    tag: isCall ? `bkt-call-${data.callId || "incoming"}` : (data.senderId ? `bkt-message-${data.senderId}` : "bkt-message"),
    requireInteraction: isCall,
    vibrate: isCall ? [250,100,250,100,400] : [100],
    data: { url, type: data.type || "message", callId: data.callId || null }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({type:"window", includeUncontrolled:true});
    for (const client of clients) {
      if ("focus" in client) { try { await client.navigate(target); } catch {} return client.focus(); }
    }
    return self.clients.openWindow(target);
  })());
});
