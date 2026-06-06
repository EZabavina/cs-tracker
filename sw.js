const CACHE_VERSION = 'cst-v7';
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

const NETWORK_FIRST = /\.(html?|js|webmanifest)$|\/config\.js$/;

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then((cache) => Promise.all(
                APP_SHELL.map((url) => cache.add(url).catch((err) => {
                    console.warn('[CST sw] skip cache', url, err);
                }))
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

function isCdnRequest(url) {
    return url.hostname.includes('cdn.jsdelivr.net') || url.hostname.includes('cdnjs.cloudflare.com');
}

function isAppAsset(url) {
    return url.origin === self.location.origin;
}

function isNavigation(request) {
    return request.mode === 'navigate'
        || (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

function networkFirst(request) {
    return fetch(request, { cache: 'no-store' })
        .then((response) => {
            if (response && response.status === 200 && response.type === 'basic') {
                const copy = response.clone();
                caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
            }
            return response;
        })
        .catch(() => caches.match(request));
}

function cacheFirst(request) {
    return caches.match(request).then((cached) => {
        if (cached) return cached;
        return networkFirst(request);
    });
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Supabase и CDN — напрямую, без перехвата
    if (isSupabaseRequest(url) || isCdnRequest(url)) return;

    if (!isAppAsset(url)) {
        event.respondWith(fetch(request).catch(() => caches.match(request)));
        return;
    }

    // config.js — только с сети
    if (url.pathname.endsWith('config.js')) {
        event.respondWith(
            fetch(request, { cache: 'no-store' }).catch(() =>
                Response.error()
            )
        );
        return;
    }

    // HTML и JS — сначала сеть (важно для PWA на iOS)
    if (isNavigation(request) || NETWORK_FIRST.test(url.pathname)) {
        event.respondWith(networkFirst(request));
        return;
    }

    event.respondWith(cacheFirst(request));
});
