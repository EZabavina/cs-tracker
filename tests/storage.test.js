const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadStorageSandbox() {
    const store = new Map();
    const sandbox = {
        localStorage: {
            getItem(key) {
                return store.has(key) ? store.get(key) : null;
            },
            setItem(key, value) {
                store.set(key, String(value));
            },
        },
    };

    vm.createContext(sandbox);
    let code = fs.readFileSync('storage.js', 'utf8');
    code += '\nthis.__storage = storage;';
    vm.runInContext(code, sandbox);
    return sandbox;
}

test('exportBackup формирует резервную копию с profile и entries', () => {
    const sb = loadStorageSandbox();
    const storage = sb.__storage;
    storage.saveEntries({ '2026-05-27': { pain: 3, saved: true } });
    storage.saveProfile({ name: 'Иван', gender: 'male', age: '30' });

    const backup = storage.exportBackup();
    assert.equal(backup.app, 'cst');
    assert.equal(backup.version, 1);
    assert.equal(backup.entries['2026-05-27'].pain, 3);
    assert.equal(backup.profile.name, 'Иван');
});

test('importBackup нормализует значения и сохраняет данные', () => {
    const sb = loadStorageSandbox();
    const storage = sb.__storage;
    const backup = {
        app: 'cst',
        entries: {
            '2026-05-27': {
                pain: 99,
                fatigue: -1,
                notes: 'ok',
                saved: true,
                exercises: [{ name: '  Планка ', reps: '12', sets: 3 }, { name: '', reps: 0, sets: 0 }],
            },
        },
        profile: { name: '  Оля  ', gender: 'female', age: 28 },
    };

    const result = storage.importBackup(JSON.stringify(backup));
    assert.equal(result.entryCount, 1);

    const entries = storage.loadEntries();
    assert.equal(entries['2026-05-27'].pain, 10);
    assert.equal(entries['2026-05-27'].fatigue, 0);
    assert.equal(entries['2026-05-27'].exercises.length, 1);
    assert.equal(entries['2026-05-27'].exercises[0].name, 'Планка');
    assert.equal(entries['2026-05-27'].exercises[0].reps, 12);

    const profile = storage.loadProfile();
    assert.equal(profile.name, 'Оля');
    assert.equal(profile.gender, 'female');
    assert.equal(profile.age, '28');
});

test('parseBackup поддерживает legacy формат только с датами', () => {
    const sb = loadStorageSandbox();
    const storage = sb.__storage;
    const parsed = storage.parseBackup({
        '2026-05-01': { pain: 2, saved: true },
        '2026-05-02': { fatigue: 4, saved: true },
    });
    assert.equal(Object.keys(parsed.entries).length, 2);
    assert.equal(parsed.profile.name, '');
});
