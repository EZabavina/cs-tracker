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

    isConfigured() {
        const cfg = typeof CST_CONFIG !== 'undefined' ? CST_CONFIG : null;
        if (!cfg || cfg.syncEnabled === false) return false;
        return !!(cfg.supabaseUrl && cfg.supabaseAnonKey
            && !cfg.supabaseUrl.includes('YOUR_PROJECT')
            && !cfg.supabaseAnonKey.includes('YOUR_SUPABASE'));
    },

    getConfigError() {
        if (typeof CST_CONFIG === 'undefined') {
            return 'Не найден config.js на сервере. Для GitHub Pages добавьте Secrets и задеплойте через Actions (см. .github/workflows/deploy.yml)';
        }
        const cfg = CST_CONFIG;
        if (!cfg.supabaseUrl || cfg.supabaseUrl.includes('YOUR_PROJECT')) {
            return 'В config.js укажите supabaseUrl из Supabase → Settings → API';
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

        const cfg = CST_CONFIG;
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

    /** Повторная загрузка config.js (обход сбоев PWA / service worker на iOS). */
    async ensureConfig() {
        if (this.isConfigured()) return true;

        try {
            const res = await fetch(this.getConfigUrl(), { cache: 'no-store' });
            if (!res.ok) throw new Error(`config.js: HTTP ${res.status}`);
            const code = await res.text();
            // eslint-disable-next-line no-new-func
            new Function(code)();
        } catch (err) {
            console.warn('[CST sync] ensureConfig:', err.message || err);
            return false;
        }

        return this.isConfigured();
    },

    resetClient() {
        this.client = null;
        this.enabled = false;
    },

    bindLifecycle() {
        if (this._lifecycleBound) return;
        this._lifecycleBound = true;

        window.addEventListener('online', () => {
            this.setStatus('syncing', 'Сеть восстановлена');
            this.schedulePush(0);
            this.retrySync('online').catch(() => {});
        });

        window.addEventListener('offline', () => {
            this.setStatus('offline', 'Нет сети — изменения сохраняются локально');
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.retrySync('visible').catch(() => {});
            }
        });

        window.addEventListener('pageshow', () => {
            this.retrySync('pageshow').catch(() => {});
        });
    },

    async retrySync(reason) {
        if (this.pulling || this.pushing) return { merged: false };

        await this.ensureConfig();
        if (!this.client && !this.initClient()) {
            const hint = this.getConfigError() || 'Supabase не настроен';
            this.setStatus('disabled', hint);
            return { merged: false };
        }

        try {
            const result = await this.pullAndMerge();
            if (result.merged && typeof refreshAppFromStorage === 'function') {
                refreshAppFromStorage();
            }
            return result;
        } catch (err) {
            console.warn('[CST sync] retrySync (' + reason + '):', err);
            return { merged: false };
        }
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
        this.bindLifecycle();

        // iOS PWA: config.js иногда не успевает через <script> — догружаем fetch-ом
        if (window.__cstConfigMissing || !this.isConfigured()) {
            await this.ensureConfig();
        }

        if (!this.initClient()) {
            const hint = this.getConfigError() || 'Supabase не настроен — данные только на этом устройстве';
            this.setStatus('disabled', hint);
            console.warn('[CST sync]', hint);
            return { merged: false };
        }

        // navigator.onLine на iOS в standalone часто врёт — всё равно пробуем
        try {
            return await this.pullAndMerge();
        } catch (err) {
            this.setStatus('error', err.message || 'Не удалось синхронизировать');
            return { merged: false };
        }
    },

    schedulePush(delayMs) {
        if (!this.enabled) return;
        clearTimeout(this.pushTimer);
        this.pushTimer = setTimeout(() => {
            this.push().catch(() => {});
        }, delayMs ?? SYNC_PUSH_DELAY_MS);
    },

    async pullAndMerge() {
        if (!this.enabled || this.pulling) return { merged: false };
        this.pulling = true;
        this.setStatus('syncing', 'Загрузка данных из облака…');

        try {
            const { data, error } = await this.client
                .from(SYNC_TABLE)
                .select('entries, profile, profile_updated_at')
                .eq('id', SYNC_ROW_ID)
                .maybeSingle();

            if (error) throw error;

            if (!data) {
                await this.push(true);
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

            const entriesChanged = JSON.stringify(localEntries) !== JSON.stringify(mergedEntries);
            const profileChanged = JSON.stringify(localProfile) !== JSON.stringify(mergedProfile);

            if (entriesChanged) storage.saveEntries(mergedEntries, { skipSync: true });
            if (profileChanged) storage.saveProfile(mergedProfile, { skipSync: true });

            if (entriesChanged || profileChanged) {
                await this.push(true);
                this.setStatus('synced', 'Данные объединены с облаком');
                return { merged: true };
            }

            this.setStatus('synced', 'Данные актуальны');
            return { merged: false };
        } catch (err) {
            this.setStatus('error', err.message || 'Не удалось синхронизировать');
            return { merged: false };
        } finally {
            this.pulling = false;
        }
    },

    async push(force) {
        if (!this.enabled || this.pushing) return;

        this.pushing = true;
        if (!force) this.setStatus('syncing', 'Отправка в облако…');

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

            if (!force) this.setStatus('synced', 'Сохранено в облаке');
        } catch (err) {
            this.setStatus('error', err.message || 'Не удалось отправить в облако');
            throw err;
        } finally {
            this.pushing = false;
        }
    },
};
