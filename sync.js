/**
 * Синхронизация localStorage ↔ Supabase (один пользователь, без авторизации).
 */
const SYNC_TABLE = 'cst_app_data';
const SYNC_ROW_ID = 'main';
const SYNC_PUSH_DELAY_MS = 800;

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
    client: null,
    enabled: false,
    pushTimer: null,
    pushing: false,
    pulling: false,
    status: 'idle',
    statusMessage: '',

    getSupabaseLib() {
        if (typeof supabase !== 'undefined' && typeof supabase.createClient === 'function') {
            return supabase;
        }
        if (typeof window !== 'undefined' && window.supabase?.createClient) {
            return window.supabase;
        }
        return null;
    },

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
        if (!this.getSupabaseLib()) {
            return 'Не загрузилась библиотека Supabase (проверьте интернет и блокировщики)';
        }
        return '';
    },

    initClient() {
        if (this.client) return true;
        if (!this.isConfigured()) return false;

        const lib = this.getSupabaseLib();
        if (!lib) return false;

        const cfg = this.getConfig();
        this.client = lib.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
            },
        });
        this.enabled = true;
        return true;
    },

    getConfigUrl() {
        return new URL('config.js', document.baseURI).href;
    },

    async ensureConfig() {
        if (this.isConfigured()) return true;
        try {
            const res = await fetch(this.getConfigUrl(), { cache: 'no-store' });
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

    async init() {
        await this.ensureConfig();

        if (!this.initClient()) {
            const hint = this.getConfigError() || 'Supabase не настроен — данные только на этом устройстве';
            this.setStatus('disabled', hint);
            console.warn('[CST sync]', hint);
            return { merged: false };
        }

        if (!this._onlineBound) {
            this._onlineBound = true;
            window.addEventListener('online', () => {
                this.setStatus('syncing', 'Сеть восстановлена');
                this.schedulePush(0);
                this.syncNow().catch(() => {});
            });
            window.addEventListener('offline', () => {
                this.setStatus('offline', 'Нет сети — изменения сохраняются локально');
            });
        }

        if (!navigator.onLine) {
            this.setStatus('offline', 'Нет сети — изменения сохраняются локально');
            return { merged: false };
        }

        return this.syncNow();
    },

    /** Одна точка входа для синхронизации — без параллельных вызовов. */
    async syncNow(opts) {
        if (this._syncPromise) return this._syncPromise;

        this._syncPromise = this.pullAndMerge(opts).finally(() => {
            this._syncPromise = null;
        });

        return this._syncPromise;
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
            const { data, error } = await this.client
                .from(SYNC_TABLE)
                .select('entries, profile, profile_updated_at')
                .eq('id', SYNC_ROW_ID)
                .maybeSingle();

            if (error) throw error;

            if (!data) {
                await this.push(true, { skipEmptyGuard: true });
                this.setStatus('synced', 'Данные отправлены в облако');
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
                        await this.push(true, { skipEmptyGuard: true });
                    } catch (pushErr) {
                        this.setStatus('synced', 'Загружено из облака; отправка: ' + (pushErr.message || 'ошибка'));
                        return { merged: true };
                    }
                    this.setStatus('synced', 'Данные объединены с облаком');
                } else {
                    this.setStatus('synced', 'Данные загружены из облака');
                }
                meta.lastPullAt = new Date().toISOString();
                storage.saveMeta(meta);
                return { merged: true };
            }

            meta.lastPullAt = new Date().toISOString();
            storage.saveMeta(meta);
            this.setStatus('synced', 'Данные актуальны');
            return { merged: false };
        } catch (err) {
            const msg = err.message || String(err);
            if (!quiet) {
                this.setStatus('error', msg);
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
        if (!navigator.onLine) {
            if (!quiet) this.setStatus('offline', 'Нет сети — отправка отложена');
            return;
        }

        if (!skipGuard) {
            const localEntries = storage.loadEntries();
            const localDates = Object.keys(localEntries).filter((k) => DATE_KEY_RE.test(k));

            if (localDates.length === 0) {
                try {
                    const { data: remote, error } = await this.client
                        .from(SYNC_TABLE)
                        .select('entries')
                        .eq('id', SYNC_ROW_ID)
                        .maybeSingle();
                    if (error) throw error;
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

            const { error } = await this.client
                .from(SYNC_TABLE)
                .upsert(payload, { onConflict: 'id' });

            if (error) throw error;

            meta.lastPushAt = new Date().toISOString();
            storage.saveMeta(meta);

            if (!force && !quiet) this.setStatus('synced', 'Сохранено в облаке');
        } catch (err) {
            if (!quiet) {
                this.setStatus('error', err.message || 'Не удалось отправить в облако');
            } else {
                console.warn('[CST sync] push (quiet):', err.message || err);
            }
            throw err;
        } finally {
            this.pushing = false;
        }
    },
};
