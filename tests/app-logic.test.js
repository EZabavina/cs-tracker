const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createDummyElement() {
    return {
        addEventListener() {},
        classList: { add() {}, remove() {}, toggle() {} },
        style: {},
        hidden: false,
        value: '',
        textContent: '',
        innerHTML: '',
        dataset: {},
        disabled: false,
    };
}

function loadAppSandbox() {
    const elementStore = new Map();
    const document = {
        addEventListener() {},
        querySelectorAll() { return []; },
        getElementById(id) {
            if (!elementStore.has(id)) elementStore.set(id, createDummyElement());
            return elementStore.get(id);
        },
    };

    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        Date,
        document,
        storage: {
            loadEntries: () => ({}),
            loadProfile: () => ({ name: '', gender: '', age: '' }),
            saveEntries() {},
            saveProfile() {},
            exportBackup: () => ({ entries: {} }),
            importBackup: () => ({ entryCount: 0 }),
        },
    };

    vm.createContext(sandbox);
    const appCode = fs.readFileSync('app.js', 'utf8');
    const statsCode = fs.readFileSync('app.stats.js', 'utf8');
    vm.runInContext(appCode, sandbox);
    vm.runInContext(statsCode, sandbox);
    vm.runInContext('this.__state = state;', sandbox);
    return sandbox;
}

test('hasRecord корректно определяет пустые и заполненные записи', () => {
    const app = loadAppSandbox();
    assert.equal(app.hasRecord(null), false);
    assert.equal(app.hasRecord({}), false);
    assert.equal(app.hasRecord({ notes: '  ', meds: '' }), false);
    assert.equal(app.hasRecord({ pain: 1 }), true);
    assert.equal(app.hasRecord({ exercises: [{ name: 'Планка', reps: 1, sets: 3 }] }), true);
    assert.equal(app.hasRecord({ notes: 'есть заметка' }), true);
    assert.equal(app.hasRecord({ saved: true }), true);
});

test('calcEntrySum суммирует 7 симптомов', () => {
    const app = loadAppSandbox();
    const entry = {
        pain: 10,
        fatigue: 9,
        sleep: 8,
        cognitive: 7,
        sensory: 6,
        digestive: 5,
        emotional: 4,
    };
    assert.equal(app.calcEntrySum(entry), 49);
    assert.equal(app.calcEntrySum({}), 0);
});

test('getDatesForStats возвращает 7 дат для режима week', () => {
    const app = loadAppSandbox();
    app.__state.currentRange = 'week';
    const dates = app.getDatesForStats();
    assert.equal(dates.length, 7);
    assert.ok(dates.every(d => d instanceof Date));
});

test('getDatesForStats возвращает пользовательский диапазон', () => {
    const app = loadAppSandbox();
    app.__state.currentRange = 'custom';
    app.__state.customFrom = new Date('2026-05-01T00:00:00');
    app.__state.customTo = new Date('2026-05-03T00:00:00');
    const dates = app.getDatesForStats();
    assert.equal(dates.map(d => app.dateKey(d)).join(','), '2026-05-01,2026-05-02,2026-05-03');
});

test('calcTrend показывает рост при увеличении симптома', () => {
    const app = loadAppSandbox();
    const dates = [
        new Date('2026-05-01T00:00:00'),
        new Date('2026-05-02T00:00:00'),
        new Date('2026-05-03T00:00:00'),
        new Date('2026-05-04T00:00:00'),
    ];
    app.__state.data = {
        '2026-05-01': { pain: 1, saved: true },
        '2026-05-02': { pain: 1, saved: true },
        '2026-05-03': { pain: 3, saved: true },
        '2026-05-04': { pain: 3, saved: true },
    };
    const trend = app.calcTrend('pain', dates);
    assert.equal(trend.cls.includes('trend-up'), true);
});
