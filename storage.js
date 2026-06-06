/**
 * Локальное хранение (localStorage).
 * Резервное копирование: exportBackup() / importBackup().
 */
const STORAGE_KEYS = {
    ENTRIES: 'cst_data',
    PROFILE: 'cst_profile',
    META: 'cst_sync_meta',
};

const BACKUP_VERSION = 1;
const BACKUP_APP_ID = 'cst';
const SYMPTOM_KEYS = ['pain', 'fatigue', 'sleep', 'cognitive', 'sensory', 'digestive', 'emotional'];
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXERCISES = 20;

function clampSymptom(v) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return 0;
    return Math.min(10, Math.max(0, n));
}

function normalizeProfile(raw) {
    if (!raw || typeof raw !== 'object') {
        return { name: '', gender: '', age: '' };
    }
    const gender = String(raw.gender || '');
    return {
        name: String(raw.name ?? '').trim(),
        gender: ['', 'male', 'female', 'other'].includes(gender) ? gender : '',
        age: String(raw.age ?? '').trim(),
    };
}

function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const entry = {
        notes: String(raw.notes ?? ''),
        meds: String(raw.meds ?? ''),
        exercises: [],
    };
    SYMPTOM_KEYS.forEach(sym => {
        entry[sym] = clampSymptom(raw[sym]);
    });
    if (Array.isArray(raw.exercises)) {
        entry.exercises = raw.exercises
            .map(item => {
                if (!item || typeof item !== 'object') return null;
                const name = String(item.name ?? '').trim();
                const reps = Math.max(0, parseInt(item.reps, 10) || 0);
                const sets = Math.max(0, parseInt(item.sets, 10) || 0);
                if (!name && reps <= 0 && sets <= 0) return null;
                return { name, reps, sets };
            })
            .filter(Boolean)
            .slice(0, MAX_EXERCISES);
    }
    if (raw.saved) entry.saved = true;
    if (raw.ts) entry.ts = String(raw.ts);
    return entry;
}

function normalizeEntries(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Неверный формат записей симптомов');
    }
    const entries = {};
    for (const [key, val] of Object.entries(raw)) {
        if (!DATE_KEY_RE.test(key)) continue;
        const entry = normalizeEntry(val);
        if (entry) entries[key] = entry;
    }
    return entries;
}

function isEntriesOnlyObject(data) {
    const keys = Object.keys(data);
    if (!keys.length) return false;
    return keys.every(k => DATE_KEY_RE.test(k));
}

const storage = {
    loadEntries() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.ENTRIES);
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    },

    loadMeta() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.META);
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    },

    saveMeta(meta) {
        localStorage.setItem(STORAGE_KEYS.META, JSON.stringify(meta || {}));
    },

    touchProfileMeta() {
        const meta = this.loadMeta();
        meta.profileUpdatedAt = new Date().toISOString();
        this.saveMeta(meta);
    },

    saveEntries(data, options) {
        localStorage.setItem(STORAGE_KEYS.ENTRIES, JSON.stringify(data));
        if (!options?.skipSync && typeof sync !== 'undefined') sync.schedulePush();
    },

    loadProfile() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.PROFILE);
            return raw ? JSON.parse(raw) : { name: '', gender: '', age: '' };
        } catch {
            return { name: '', gender: '', age: '' };
        }
    },

    saveProfile(profile, options) {
        const normalized = normalizeProfile(profile);
        localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(normalized));
        this.touchProfileMeta();
        if (!options?.skipSync && typeof sync !== 'undefined') sync.schedulePush();
    },

    exportBackup() {
        return {
            version: BACKUP_VERSION,
            app: BACKUP_APP_ID,
            exportedAt: new Date().toISOString(),
            entries: this.loadEntries(),
            profile: this.loadProfile(),
        };
    },

    parseBackup(raw) {
        let data = raw;
        if (typeof raw === 'string') {
            try {
                data = JSON.parse(raw);
            } catch {
                throw new Error('Файл не является корректным JSON');
            }
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('Неверный формат резервной копии');
        }

        if (isEntriesOnlyObject(data)) {
            return {
                entries: normalizeEntries(data),
                profile: { name: '', gender: '', age: '' },
            };
        }

        if (data.app && data.app !== BACKUP_APP_ID) {
            throw new Error('Файл не от Central Sensitization Tracker');
        }

        const entries = normalizeEntries(data.entries ?? data.data ?? data.cst_data ?? {});
        const profile = normalizeProfile(data.profile ?? data.cst_profile ?? {});

        return { entries, profile };
    },

    importBackup(raw) {
        const { entries, profile } = this.parseBackup(raw);
        this.saveEntries(entries, { skipSync: true });
        this.saveProfile(profile, { skipSync: true });
        this.touchProfileMeta();
        if (typeof sync !== 'undefined') sync.schedulePush(0);
        return {
            entryCount: Object.keys(entries).length,
            profile,
        };
    },
};
