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
            return 'Не найден config.js на сервере. Для GitHub Pages добавьте Secrets и задеплойте через Actions';
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
    async syncNow() {
        if (this._syncPromise) return this._syncPromise;

        this._syncPromise = this.pullAndMerge().finally(() => {
            this._syncPromise = null;
        });

        return this._syncPromise;
    },

    schedulePush(delayMs) {
        if (!this.enabled) return;
        clearTimeout(this.pushTimer);
        this.pushTimer = setTimeout(() => {
            this.push().catch(() => {});
        }, delayMs ?? SYNC_PUSH_DELAY_MS);
    },

    async pullAndMerge() {
        if (!this.enabled) return { merged: false };
        if (this.pulling) return this._syncPromise || { merged: false };

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
                try {
                    await this.push(true);
                } catch (pushErr) {
                    this.setStatus('synced', 'Загружено из облака; отправка: ' + (pushErr.message || 'ошибка'));
                    return { merged: true };
                }
                this.setStatus('synced', 'Данные объединены с облаком');
                return { merged: true };
            }

            this.setStatus('synced', 'Данные актуальны');
            return { merged: false };
        } catch (err) {
            const msg = err.message || String(err);
            this.setStatus('error', msg);
            console.error('[CST sync]', msg, err);
            return { merged: false };
        } finally {
            this.pulling = false;
        }
    },

    async push(force) {
        if (!this.enabled || this.pushing) return;
        if (!navigator.onLine) {
            this.setStatus('offline', 'Нет сети — отправка отложена');
            return;
        }

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
