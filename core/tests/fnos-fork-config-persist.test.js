// [fnos-fork] 大号/小号、奶茶自动雇佣：账号配置写入 store.json 后重新加载不丢（升级不丢）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

test('fnosAltAccount / fnosMilkTeaAutoHire 持久化并在新进程中读回；其他设置不受影响', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-fork-store-'));
    const env = { ...process.env, QQ_FARM_DATA_DIR: dir };
    const write = `
        const store = require('./dist/models/store');
        store.applyConfigSnapshot({ stealDelaySeconds: 7 }, { accountId: 'a1' });
        store.applyConfigSnapshot({ fnosAltAccount: { enabled: true, masterGid: '4300123456', masterName: '大号', timeoutMinutes: 45 } }, { accountId: 'a1' });
        store.applyConfigSnapshot({ fnosMilkTeaAutoHire: { enabled: true, durationId: 3, talentId: 9002 } }, { accountId: 'a1' });
    `;
    const read = `
        const store = require('./dist/models/store');
        store.loadGlobalConfig && store.loadGlobalConfig();
        const s = store.getConfigSnapshot('a1');
        const other = store.getConfigSnapshot('a2');
        console.log(JSON.stringify({ alt: s.fnosAltAccount, tea: s.fnosMilkTeaAutoHire, steal: s.stealDelaySeconds, otherAlt: other.fnosAltAccount, otherTea: other.fnosMilkTeaAutoHire }));
    `;
    const cwd = path.join(__dirname, '..');
    const w = spawnSync(process.execPath, ['-e', write], { cwd, env, encoding: 'utf8' });
    assert.equal(w.status, 0, w.stderr);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
    assert.equal(raw.accountConfigs.a1.fnosAltAccount.masterGid, 4300123456);
    const r = spawnSync(process.execPath, ['-e', read], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual(out.alt, { enabled: true, masterGid: 4300123456, masterName: '大号', timeoutMinutes: 45 });
    assert.deepEqual(out.tea, { enabled: true, durationId: 3, priorityGid: 0, priorityName: '', priorityConfigured: false, talentId: 9002, allowRobots: false, autoWork: false, workType: 0 });
    assert.equal(out.steal, 7);
    assert.equal(out.otherAlt.enabled, false);
    assert.equal(out.otherTea.enabled, false);
    fs.rmSync(dir, { recursive: true, force: true });
});
