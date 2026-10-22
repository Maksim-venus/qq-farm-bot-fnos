// [fnos-fork] 大号/小号、奶茶自动雇佣：账号配置写入 store.json 后重新加载不丢（升级不丢）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

// [fnos-fork] 上游 2026-10-22 起账号配置拆分为 data/account-configs/<id>.json（store.json 只留公共配置）
function readAccountConfigFile(dataDir, id) {
    const name = /^\d+$/.test(id) ? id : `id-${Buffer.from(id, 'utf8').toString('hex')}`;
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'account-configs', `${name}.json`), 'utf8'));
}

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
    const raw = readAccountConfigFile(dir, 'a1');
    assert.equal(raw.fnosAltAccount.masterGid, 4300123456);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')).accountConfigs, undefined);
    const r = spawnSync(process.execPath, ['-e', read], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual(out.alt, { enabled: true, masterGid: 4300123456, masterName: '大号', holdForMaster: true, timeoutMinutes: 45, skipStealMaster: false, badOnlyMaster: false });
    assert.deepEqual(out.tea, { enabled: true, durationId: 3, priorityGid: 0, priorityName: '', priorityConfigured: false, talentId: 9002, allowRobots: false, autoWork: false, workType: 0 });
    assert.equal(out.steal, 7);
    assert.equal(out.otherAlt.enabled, false);
    assert.equal(out.otherTea.enabled, false);
    fs.rmSync(dir, { recursive: true, force: true });
});

// [fnos-fork] 2026-10-22 合并上游「配置存储拆分」：旧版 store.json（accountConfigs 聚合）升级后由主进程自动拆分，
// 所有飞牛 fork 字段原样迁移到 account-configs/<id>.json，读回不丢、不被归一化成默认值。
test('升级：旧版 store.json 里的 fnos 字段经上游自动拆分迁移后全部保留', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-fork-migrate-'));
    const legacy = {
        accountConfigs: {
            2: {
                stealDelaySeconds: 3,
                fnosAltAccount: { enabled: true, masterGid: 1280585737, masterName: 'Maksim', holdForMaster: false, timeoutMinutes: 10, skipStealMaster: true, badOnlyMaster: true },
                fnosMilkTeaAutoHire: { enabled: true, durationId: 0, priorityGid: 1280585737, priorityName: 'Maksim', priorityConfigured: true, talentId: 0, allowRobots: false, autoWork: true, workType: 2 },
                fnosMilkTeaDaily: { autoClaim: true, autoExchangeSeed: true },
            },
            // 2026.10.21.2 之前的旧小号配置：没有 priority* / holdForMaster 字段
            9: {
                fnosAltAccount: { enabled: true, masterGid: 1280585737, masterName: 'Maksim', timeoutMinutes: 10 },
                fnosMilkTeaAutoHire: { enabled: true, durationId: 2, talentId: 0, allowRobots: false },
            },
        },
        ui: { theme: 'light' },
    };
    fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify(legacy, null, 2));
    const env = { ...process.env, QQ_FARM_DATA_DIR: dir };
    delete env.FARM_ACCOUNT_ID; // 主进程才迁移
    const read = `
        const store = require('./dist/models/store');
        const h = require('./dist/services/fnos-milk-tea-auto-hire');
        const a = store.getConfigSnapshot('2');
        const b = store.getConfigSnapshot('9');
        console.log(JSON.stringify({ a: { alt: a.fnosAltAccount, tea: a.fnosMilkTeaAutoHire, daily: a.fnosMilkTeaDaily, steal: a.stealDelaySeconds },
            b: { alt: b.fnosAltAccount, eff: h.resolveEffectiveHireConfig(b.fnosMilkTeaAutoHire, b.fnosAltAccount) } }));
    `;
    const r = spawnSync(process.execPath, ['-e', read], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual(out.a.alt, legacy.accountConfigs[2].fnosAltAccount);
    assert.deepEqual(out.a.tea, legacy.accountConfigs[2].fnosMilkTeaAutoHire);
    assert.equal(out.a.daily.autoClaim, true);
    assert.equal(out.a.daily.autoExchangeSeed, true);
    assert.equal(out.a.steal, 3);
    assert.equal(out.b.alt.holdForMaster, true, '旧配置缺省 holdForMaster 为 true');
    assert.equal(out.b.eff.migratedFromAlt, true);
    assert.equal(out.b.eff.priorityGid, 1280585737);
    assert.equal(out.b.eff.durationId, 2);
    // 已拆分落盘：store.json 不再含账号配置，逐账号文件里有 fnos 字段，并留有迁移前备份
    const store = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
    assert.equal(store.accountConfigs, undefined);
    assert.equal(store.accountConfigStorageVersion, 1);
    assert.deepEqual(readAccountConfigFile(dir, '2').fnosAltAccount, legacy.accountConfigs[2].fnosAltAccount);
    assert.equal(readAccountConfigFile(dir, '9').fnosMilkTeaAutoHire.durationId, 2);
    assert.ok(fs.readdirSync(dir).some(f => /^store\.json\..+\.bak$/.test(f)), '迁移前 store.json 备份');
    fs.rmSync(dir, { recursive: true, force: true });
});
