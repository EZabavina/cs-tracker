const CACHE_VERSION = 'cst-v13';
const APP_SHELL = [
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
        caches.open(CACHE_VERSION)
            .then((cache) => Promise.all(
                APP_SHELL.map((url) => cache.add(url).catch(() => {}))
            ))
            .then(() => self.skipWaiting())
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

function shouldCache(url) {
    return !url.pathname.endsWith('config.js');
}

function cachePut(request, response) {
    if (response && response.status === 200 && response.type === 'basic' && shouldCache(new URL(request.url))) {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
    }
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (isSupabaseRequest(url)) return;
    if (!isAppAsset(url)) return;
    if (url.pathname.endsWith('config.js')) return;

    // Stale-while-revalidate: отдаём кэш сразу, обновляем в фоне
    event.respondWith(
        caches.match(request).then((cached) => {
            const networkFetch = fetch(request)
                .then((response) => {
                    cachePut(request, response);
                    return response;
                })
                .catch(() => cached);

            if (cached) {
                networkFetch.catch(() => {});
                return cached;
            }
            return networkFetch;
        })
    );
});
