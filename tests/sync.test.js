const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadSyncSandbox() {
    const sandbox = {};
    vm.createContext(sandbox);
    let code = fs.readFileSync('storage.js', 'utf8');
    code += fs.readFileSync('sync.js', 'utf8');
    code += '\nthis.__mergeEntries = mergeEntries; this.__mergeProfile = mergeProfile;';
    vm.runInContext(code, sandbox);
    return sandbox;
}

test('mergeEntries берёт более новую запись по ts', () => {
    const sb = loadSyncSandbox();
    const local = {
        '2026-05-01': { pain: 2, ts: '2026-05-01T10:00:00.000Z', saved: true },
        '2026-05-02': { pain: 5, ts: '2026-05-02T12:00:00.000Z', saved: true },
    };
    const remote = {
        '2026-05-01': { pain: 8, ts: '2026-05-01T11:00:00.000Z', saved: true },
        '2026-05-03': { pain: 1, ts: '2026-05-03T09:00:00.000Z', saved: true },
    };

    const merged = sb.__mergeEntries(local, remote);
    assert.equal(merged['2026-05-01'].pain, 8);
    assert.equal(merged['2026-05-02'].pain, 5);
    assert.equal(merged['2026-05-03'].pain, 1);
});

test('mergeProfile выбирает профиль с более поздним updated_at', () => {
    const sb = loadSyncSandbox();
    const local = { name: 'Аня', gender: 'female', age: '30' };
    const remote = { name: 'Оля', gender: 'female', age: '28' };

    const keepLocal = sb.__mergeProfile(local, remote, '2026-05-02T12:00:00.000Z', '2026-05-01T12:00:00.000Z');
    assert.equal(keepLocal.name, 'Аня');

    const keepRemote = sb.__mergeProfile(local, remote, '2026-05-01T12:00:00.000Z', '2026-05-02T12:00:00.000Z');
    assert.equal(keepRemote.name, 'Оля');
});
