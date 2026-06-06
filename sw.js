const CACHE_VERSION = 'cst-v6';
const APP_SHELL = [
    './',
    './index.html',
    './styles.css',
    './storage.js',
    './sync.js',
    './app.js',
    './app.stats.js',
    './manifest.webmanifest',
    './icons/icon.svg',
    './icons/favicon.svg',
    './icons/favicon-32.png',
    './icons/apple-touch-icon.png',
    './favicon.ico',
    './robots.txt',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
        ).then(() => self.clients.claim())
    );
});

function isSupabaseRequest(url) {
    return url.hostname.includes('supabase.co');
}

function isAppAsset(url) {
    return url.origin === self.location.origin;
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (isSupabaseRequest(url)) return;

    if (!isAppAsset(url)) {
        event.respondWith(fetch(request).catch(() => caches.match(request)));
        return;
    }

    // config.js всегда с сети (ключи Supabase не кэшируем)
    if (url.pathname.endsWith('config.js')) {
        event.respondWith(fetch(request, { cache: 'no-store' }));
        return;
    }

    event.respondWith(
        caches.match(request).then((cached) => {
            const networkFetch = fetch(request)
                .then((response) => {
                    if (response && response.status === 200 && response.type === 'basic') {
                        const copy = response.clone();
                        caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => cached);

            return cached || networkFetch;
        })
    );
});
