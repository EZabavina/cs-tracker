const CACHE_VERSION = 'cst-v15';
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

self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

function isSupabaseRequest(url) {
    return url.hostname.includes('supabase.co');
}

function isAppAsset(url) {
    return url.origin === self.location.origin;
}

function shouldCache(url) {
    return !url.pathname.endsWith('config.js') && !url.pathname.endsWith('sw.js');
}

function cachePut(request, response) {
    if (response && response.status === 200 && response.type === 'basic' && shouldCache(new URL(request.url))) {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
    }
}

function isNavigateRequest(request) {
    return request.mode === 'navigate'
        || request.headers.get('accept')?.includes('text/html');
}

function isNetworkFirstAsset(url) {
    const p = url.pathname;
    if (p.endsWith('config.js') || p.endsWith('sw.js')) return false;
    if (p.endsWith('/') || p.endsWith('index.html')) return true;
    return /\.(css|js)$/.test(p);
}

async function networkFirst(request) {
    try {
        const response = await fetch(request);
        cachePut(request, response);
        return response;
    } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw err;
    }
}

async function staleWhileRevalidate(request) {
    const cached = await caches.match(request);
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
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (isSupabaseRequest(url)) return;
    if (!isAppAsset(url)) return;
    if (url.pathname.endsWith('config.js')) return;

    const strategy = isNavigateRequest(request) || isNetworkFirstAsset(url)
        ? networkFirst
        : staleWhileRevalidate;

    event.respondWith(strategy(request));
});
