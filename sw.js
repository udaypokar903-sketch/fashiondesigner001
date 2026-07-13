// Fashion Designer — service worker
// Caches the app shell so the app loads and works with zero network connection.

const CACHE_NAME = 'tagged-cache-v3';
const ASSETS = [
  './index.html',
  './app.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js'
];

self.addEventListener('install', (event)=>{
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache)=> cache.addAll(ASSETS)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event)=>{
  event.waitUntil(
    caches.keys().then((keys)=>
      Promise.all(keys.filter(k=> k!==CACHE_NAME).map(k=> caches.delete(k)))
    ).then(()=> self.clients.claim())
  );
});

// Network-first for the app shell (HTML/JS) so updates (new features/fixes) show up
// immediately instead of one load behind. Falls back to cache when offline.
self.addEventListener('fetch', (event)=>{
  if(event.request.method !== 'GET') return;
  const url = event.request.url;
  const isAppShell = url.endsWith('index.html') || url.endsWith('app.js') || event.request.mode === 'navigate';

  if(isAppShell){
    event.respondWith(
      fetch(event.request).then((response)=>{
        if(response && response.status === 200){
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache)=> cache.put(event.request, copy));
        }
        return response;
      }).catch(()=> caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached)=>{
      const networkFetch = fetch(event.request).then((response)=>{
        if(response && response.status === 200){
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache)=> cache.put(event.request, copy));
        }
        return response;
      }).catch(()=> cached);

      return cached || networkFetch;
    })
  );
});
