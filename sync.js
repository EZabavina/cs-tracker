/**
 * Синхронизация localStorage ↔ Supabase (один пользователь, без авторизации).
 * Запросы через REST API (fetch) — без CDN supabase-js.
 */
const SYNC_TABLE = 'cst_app_data';
const SYNC_ROW_ID = 'main';
const SYNC_PUSH_DELAY_MS = 800;
const SYNC_FETCH_TIMEOUT_MS = 12000;

function countStoredDates(entries) {
    const data = entries && typeof entries === 'object' ? entries : {};
    return Object.keys(data).filter((k) => DATE_KEY_RE.test(k)).length;
}

function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message || 'Таймаут запроса')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isNetworkErrorMessage(msg) {
    return /failed to fetch|networkerror|network error|load failed|таймаут|timeout|aborted/i.test(msg);
}

function parseTs(value) {
    if (!value) return 0;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
}

function stableJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

function mergeEntries(local, remote) {
    const merged = { ...local };
    const remoteEntries = remote && typeof remote === 'object' ? remote : {};

    for (const [key, remoteEntry] of Object.entries(remoteEntries)) {
        if (!DATE_KEY_RE.test(key)) continue;
        const normalizedRemote = normalizeEntry(remoteEntry);
        if (!normalizedRemote) continue;

        const localEntry = merged[key];
        if (!localEntry || parseTs(normalizedRemote.ts) >= parseTs(localEntry.ts)) {
            merged[key] = normalizedRemote;
        }
    }

    return merged;
}

function mergeProfile(local, remote, localUpdatedAt, remoteUpdatedAt) {
    const localMs = parseTs(localUpdatedAt);
    const remoteMs = parseTs(remoteUpdatedAt);
    return remoteMs > localMs ? normalizeProfile(remote) : normalizeProfile(local);
}

const sync = {
    enabled: false,
    pushTimer: null,
    pushing: false,
    pulling: false,
    status: 'idle',
    statusMessage: '',

    getConfig() {
        if (typeof CST_CONFIG !== 'undefined') return this.normalizeConfig(CST_CONFIG);
        if (typeof window !== 'undefined' && window.CST_CONFIG) return this.normalizeConfig(window.CST_CONFIG);
        return null;
    },

    normalizeConfig(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const strip = (v) => String(v ?? '').trim().replace(/^['"]+|['"]+$/g, '');
        const supabaseUrl = strip(raw.supabaseUrl).replace(/\/$/, '');
        const supabaseAnonKey = strip(raw.supabaseAnonKey);
        return {
            ...raw,
            supabaseUrl,
            supabaseAnonKey,
        };
    },

    isConfigured() {
        const cfg = this.getConfig();
        if (!cfg || cfg.syncEnabled === false) return false;
        return !!(cfg.supabaseUrl && cfg.supabaseAnonKey
            && !cfg.supabaseUrl.includes('YOUR_PROJECT')
            && !cfg.supabaseAnonKey.includes('YOUR_SUPABASE'));
    },

    getConfigError() {
        if (!this.getConfig()) {
            return 'Не найден config.js — проверьте ' + new URL('config.js', document.baseURI).href;
        }
        const cfg = this.getConfig();
        if (!cfg.supabaseUrl || cfg.supabaseUrl.includes('YOUR_PROJECT')) {
            return 'В config.js укажите supabaseUrl из Supabase → Settings → API';
        }
        if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cfg.supabaseUrl)) {
            return 'Неверный supabaseUrl: «' + cfg.supabaseUrl + '» — проверьте GitHub Secret SUPABASE_URL (без лишних кавычек)';
        }
        if (!cfg.supabaseAnonKey || cfg.supabaseAnonKey.includes('YOUR_SUPABASE')) {
            return 'В config.js укажите anon или publishable ключ из Supabase → Settings → API';
        }
        if (cfg.syncEnabled === false) return 'В config.js установите syncEnabled: true';
        return '';
    },

    restHeaders(cfg, extra) {
        return {
            apikey: cfg.supabaseAnonKey,
            Authorization: 'Bearer ' + cfg.supabaseAnonKey,
            ...(extra || {}),
        };
    },

    async restFetch(path, options) {
        const cfg = this.getConfig();
        if (!cfg) throw new Error('Supabase не настроен');

        const url = cfg.supabaseUrl + '/rest/v1/' + path;
        const fetchOpts = {
            cache: 'no-store',
            method: 'GET',
            ...options,
            headers: this.restHeaders(cfg, options?.headers),
        };

        const res = await fetch(url, fetchOpts);
        if (!res.ok) {
            let detail = '';
            try { detail = await res.text(); } catch (_) { /* ignore */ }
            throw new Error('HTTP ' + res.status + (detail ? ': ' + detail.slice(0, 180) : ''));
        }

        if (res.status === 204) return null;
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    },

    async fetchAppRow(columns) {
        const cols = columns || 'entries,profile,profile_updated_at';
        const rows = await this.restFetch(
            SYNC_TABLE + '?id=eq.' + encodeURIComponent(SYNC_ROW_ID) + '&select=' + encodeURIComponent(cols)
        );
        return Array.isArray(rows) && rows.length ? rows[0] : null;
    },

    async upsertAppRow(payload) {
        await this.restFetch(SYNC_TABLE + '?on_conflict=id', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Prefer: 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(payload),
        });
    },

    async initClient() {
        if (this.enabled) return true;
        if (!this.isConfigured()) return false;
        this.enabled = true;
        return true;
    },

    bindOnlineHandlers() {
        if (this._onlineBound) return;
        this._onlineBound = true;
        window.addEventListener('online', () => {
            this.schedulePush(0);
            this.syncNow({ quiet: true }).catch(() => {});
        });
    },

    /** Ранний pull сразу после config + storage + sync (до app.js). */
    beginEarlySync() {
        if (this.earlySyncPromise) return this.earlySyncPromise;

        this.earlySyncPromise = (async () => {
            await this.ensureConfig();
            this.bindOnlineHandlers();
            if (!(await this.initClient())) {
                const hint = this.getConfigError() || 'Supabase не настроен — данные только на этом устройстве';
                this.setStatus('disabled', hint);
                console.warn('[CST sync]', hint);
                return { merged: false };
            }

            const quiet = countStoredDates(storage.loadEntries()) > 0;
            if (!quiet) this.setStatus('syncing', 'Загрузка данных из облака…');
            return this.syncNow({ quiet });
        })().catch((err) => {
            console.warn('[CST sync] early sync:', err.message || err);
            return { merged: false };
        });

        return this.earlySyncPromise;
    },

    getConfigUrl() {
        return new URL('config.js', document.baseURI).href;
    },

    async ensureConfig() {
        if (this.isConfigured()) return true;
        try {
            const fetchOpts = { cache: 'no-store' };
            if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
                fetchOpts.signal = AbortSignal.timeout(8000);
            }
            const res = await fetch(this.getConfigUrl(), fetchOpts);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const code = await res.text();
            const script = document.createElement('script');
            script.textContent = code;
            document.head.appendChild(script);
            script.remove();
        } catch (err) {
            console.warn('[CST sync] ensureConfig:', err.message || err);
            return false;
        }
        return this.isConfigured();
    },

    setStatus(status, message) {
        this.status = status;
        this.statusMessage = message || '';
        this.updateStatusUi();
    },

    updateStatusUi() {
        const el = document.getElementById('syncStatus');
        if (!el) return;

        const labels = {
            idle: 'Облако',
            syncing: 'Синхронизация…',
            synced: 'Синхронизировано',
            offline: 'Офлайн',
            error: 'Ошибка синхронизации',
            disabled: 'Только локально',
        };

        el.className = 'sync-status sync-status-' + this.status;
        el.title = this.statusMessage || labels[this.status] || '';
        el.setAttribute('aria-label', el.title);

        const icon = el.querySelector('i');
        if (!icon) return;

        icon.className = 'fas ' + ({
            idle: 'fa-cloud',
            syncing: 'fa-arrows-rotate fa-spin',
            synced: 'fa-check',
            offline: 'fa-cloud',
            error: 'fa-triangle-exclamation',
            disabled: 'fa-hard-drive',
        }[this.status] || 'fa-cloud');
    },

    async init(opts) {
        this.bindOnlineHandlers();

        if (this.earlySyncPromise) {
            return this.earlySyncPromise;
        }

        await this.ensureConfig();

        if (!(await this.initClient())) {
            const hint = this.getConfigError() || 'Supabase не настроен — данные только на этом устройстве';
            this.setStatus('disabled', hint);
            console.warn('[CST sync]', hint);
            return { merged: false };
        }

        const quiet = opts && opts.quiet;
        return this.syncNow({ quiet });
    },

    /** Одна точка входа для синхронизации — без параллельных вызовов. */
    async syncNow(opts) {
        if (this._syncPromise) return this._syncPromise;

        this._syncPromise = this.pullAndMerge(opts).finally(() => {
            this._syncPromise = null;
        });

        return this._syncPromise;
    },

    cancelScheduledPush() {
        clearTimeout(this.pushTimer);
        this.pushTimer = null;
    },

    schedulePush(delayMs) {
        if (!this.enabled) return;
        clearTimeout(this.pushTimer);
        this.pushTimer = setTimeout(() => {
            this.push(false, { quiet: true }).catch(() => {});
        }, delayMs ?? SYNC_PUSH_DELAY_MS);
    },

    async waitForSync() {
        if (this._syncPromise) {
            try { await this._syncPromise; } catch (_) { /* ignore */ }
        }
    },

    async pullAndMerge(opts) {
        if (!this.enabled) return { merged: false };
        if (this.pulling) return this._syncPromise || { merged: false };

        const quiet = opts && opts.quiet;

        this.pulling = true;
        if (!quiet) this.setStatus('syncing', 'Загрузка данных из облака…');

        try {
            const data = await withTimeout(
                this.fetchAppRow(),
                SYNC_FETCH_TIMEOUT_MS,
                'Таймаут загрузки из облака'
            );

            if (!data) {
                const localDates = countStoredDates(storage.loadEntries());
                if (localDates > 0) {
                    await this.push(true, { skipEmptyGuard: true });
                    if (!quiet) this.setStatus('synced', 'Данные отправлены в облако');
                } else if (!quiet) {
                    this.setStatus('synced', 'В облаке пока нет данных');
                }
                return { merged: false };
            }

            const localEntries = storage.loadEntries();
            const localProfile = storage.loadProfile();
            const meta = storage.loadMeta();

            const mergedEntries = mergeEntries(localEntries, data.entries);
            const mergedProfile = mergeProfile(
                localProfile,
                data.profile,
                meta.profileUpdatedAt,
                data.profile_updated_at
            );

            const entriesChanged = stableJson(localEntries) !== stableJson(mergedEntries);
            const profileChanged = stableJson(localProfile) !== stableJson(mergedProfile);

            if (entriesChanged) storage.saveEntries(mergedEntries, { skipSync: true });
            if (profileChanged) storage.saveProfile(mergedProfile, { skipSync: true });

            if (entriesChanged || profileChanged) {
                const remoteEntries = data.entries && typeof data.entries === 'object' ? data.entries : {};
                const remoteProfile = normalizeProfile(data.profile);
                const needsPush = (entriesChanged && stableJson(mergedEntries) !== stableJson(remoteEntries))
                    || (profileChanged && stableJson(mergedProfile) !== stableJson(remoteProfile));

                if (needsPush) {
                    try {
                        await this.push(true, { skipEmptyGuard: true, quiet: !!quiet });
                    } catch (pushErr) {
                        if (!quiet) {
                            this.setStatus('synced', 'Загружено из облака; отправка: ' + (pushErr.message || 'ошибка'));
                        }
                        return { merged: true };
                    }
                    if (!quiet) this.setStatus('synced', 'Данные объединены с облаком');
                } else if (!quiet) {
                    this.setStatus('synced', 'Данные загружены из облака');
                }
                meta.lastPullAt = new Date().toISOString();
                storage.saveMeta(meta);
                if (quiet && this.status !== 'error') this.setStatus('synced', 'Синхронизировано');
                return { merged: true };
            }

            meta.lastPullAt = new Date().toISOString();
            storage.saveMeta(meta);
            if (!quiet) {
                this.setStatus('synced', 'Данные актуальны');
            } else if (this.status !== 'error') {
                this.setStatus('synced', 'Синхронизировано');
            }
            return { merged: false };
        } catch (err) {
            const msg = err.message || String(err);
            const localEmpty = countStoredDates(storage.loadEntries()) === 0;
            const networkErr = isNetworkErrorMessage(msg);
            if (!quiet || localEmpty) {
                this.setStatus(networkErr ? 'offline' : 'error', networkErr
                    ? 'Не удалось связаться с облаком — нажмите облако для повтора'
                    : msg);
                console.error('[CST sync]', msg, err);
            } else {
                console.warn('[CST sync] pull (quiet):', msg);
            }
            return { merged: false };
        } finally {
            this.pulling = false;
        }
    },

    async push(force, opts) {
        if (!this.enabled) return;

        const quiet = opts && opts.quiet;
        const skipGuard = opts && opts.skipEmptyGuard;

        await this.waitForSync();

        if (this.pushing) return;

        if (!skipGuard) {
            const localEntries = storage.loadEntries();
            const localDates = Object.keys(localEntries).filter((k) => DATE_KEY_RE.test(k));

            if (localDates.length === 0) {
                try {
                    const remote = await withTimeout(
                        this.fetchAppRow('entries'),
                        SYNC_FETCH_TIMEOUT_MS,
                        'Таймаут проверки облака'
                    );
                    const remoteEntries = remote?.entries && typeof remote.entries === 'object' ? remote.entries : {};
                    const remoteDates = Object.keys(remoteEntries).filter((k) => DATE_KEY_RE.test(k));
                    if (remoteDates.length > 0) {
                        console.warn('[CST sync] Локально пусто — загружаем из облака');
                        return this.syncNow({ quiet: true });
                    }
                } catch (err) {
                    console.warn('[CST sync] push guard:', err.message || err);
                }
            }
        }

        this.pushing = true;
        if (!force && !quiet) this.setStatus('syncing', 'Отправка в облако…');

        try {
            const meta = storage.loadMeta();
            const payload = {
                id: SYNC_ROW_ID,
                entries: storage.loadEntries(),
                profile: storage.loadProfile(),
                profile_updated_at: meta.profileUpdatedAt || new Date().toISOString(),
            };

            await withTimeout(
                this.upsertAppRow(payload),
                SYNC_FETCH_TIMEOUT_MS,
                'Таймаут отправки в облако'
            );

            meta.lastPushAt = new Date().toISOString();
            storage.saveMeta(meta);

            if (!force && !quiet) this.setStatus('synced', 'Сохранено в облаке');
        } catch (err) {
            const msg = err.message || 'Не удалось отправить в облако';
            const networkErr = isNetworkErrorMessage(msg);
            if (!quiet) {
                this.setStatus(networkErr ? 'offline' : 'error', networkErr
                    ? 'Не удалось связаться с облаком — отправка отложена'
                    : msg);
            } else {
                console.warn('[CST sync] push (quiet):', msg);
            }
            throw err;
        } finally {
            this.pushing = false;
        }
    },
};
