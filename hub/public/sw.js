// ページ本体だけを保存しておき、電波が切れても画面は開けるようにする。API はキャッシュしない
const CACHE = "sessions-v1";
const SHELL = ["/", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate") {
    // 常に最新を取りに行く。Access のログイン画面へのリダイレクトもそのまま通す
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok && res.type === "basic") caches.open(CACHE).then((c) => c.put("/", res.clone()));
        return res;
      }).catch(() => caches.match("/")),
    );
  }
});
