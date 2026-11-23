// [fnos-fork] 大号/小号、图鉴：账号配置写入后重新加载不丢（升级不丢）；
// 2026-11-15 奶茶 fork 功能下架：旧配置里的奶茶字段启动时被清理，其他设置不变。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const TEA_KEYS = ['fnosMilkTeaAutoHire', 'fnosMilkTeaDaily', 'fnosMilkTeaExtra'];

// [fnos-fork] 上游 2026-10-22 起账号配置拆分为 data/account-configs/<id>.json（store.json 只留公共配置）
function readAccountConfigFile(dataDir, id) {
    const name = /^\d+$/.test(id) ? id : `id-${Buffer.from(id, 'utf8').toString('hex')}`;
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'account-configs', `${name}.json`), 'utf8'));
}

function run(script, env) {
    const r = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('fnosAltAccount / fnosIllustratedAuto 持久化并在新进程中读回；其他设置不受影响', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-fork-store-'));
    const env = { ...process.env, QQ_FARM_DATA_DIR: dir };
    delete env.FARM_ACCOUNT_ID;
    run(`
        const store = require('./dist/models/store');
        store.applyConfigSnapshot({ stealDelaySeconds: 7 }, { accountId: 'a1' });
        store.applyConfigSnapshot({ fnosAltAccount: { enabled: true, masterGid: '4300123456', masterName: '大号', timeoutMinutes: 45 } }, { accountId: 'a1' });
        store.applyConfigSnapshot({ fnosIllustratedAuto: { autoClaimRewards: true, autoComplete: true } }, { accountId: 'a1' });
        console.log('{}');
    `, env);
    const raw = readAccountConfigFile(dir, 'a1');
    assert.equal(raw.fnosAltAccount.masterGid, 4300123456);
    for (const key of TEA_KEYS) assert.equal(raw[key], undefined, `新写入的配置不再含 ${key}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')).accountConfigs, undefined);
    const out = run(`
        const store = require('./dist/models/store');
        const s = store.getConfigSnapshot('a1');
        const other = store.getConfigSnapshot('a2');
        console.log(JSON.stringify({ alt: s.fnosAltAccount, ill: s.fnosIllustratedAuto, steal: s.stealDelaySeconds, otherAlt: other.fnosAltAccount, otherIll: other.fnosIllustratedAuto, tea: TEA(s) }));
        function TEA(c) { return ${JSON.stringify(TEA_KEYS)}.filter(k => c[k] !== undefined); }
    `, env);
    assert.deepEqual(out.alt, { enabled: true, masterGid: 4300123456, masterName: '大号', holdForMaster: true, timeoutMinutes: 45, skipStealMaster: false, badOnlyMaster: false });
    assert.deepEqual(out.ill, { autoClaimRewards: true, autoComplete: true });
    assert.deepEqual(out.tea, []);
    assert.equal(out.steal, 7);
    assert.equal(out.otherAlt.enabled, false);
    assert.equal(out.otherIll.autoClaimRewards, true); // [fnos-fork] 2026-11-17 默认开
    fs.rmSync(dir, { recursive: true, force: true });
});

const ALT2 = { enabled: true, masterGid: 1280585737, masterName: 'Maksim', holdForMaster: false, timeoutMinutes: 10, skipStealMaster: true, badOnlyMaster: true };
const TEA_LEFTOVER = {
    fnosMilkTeaAutoHire: { enabled: true, durationId: 0, priorityGid: 1280585737, priorityName: 'Maksim', priorityConfigured: true, talentId: 0, allowRobots: false, autoWork: true, workType: 2 },
    fnosMilkTeaDaily: { autoClaim: true, autoExchangeSeed: true, seedExchange: [{ id: 29005, enabled: true }] },
    fnosMilkTeaExtra: { autoCraft: true, craftGoldenCheese: false, autoClaimWages: true, autoUpgradeShop: true },
};

// [fnos-fork] 旧版 store.json（accountConfigs 聚合）升级：上游自动拆分迁移，fnos 字段保留，奶茶字段被清理
test('升级：旧版聚合 store.json 拆分迁移后 fnos 字段保留，奶茶 fork 字段被清掉', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-fork-migrate-'));
    const legacy = {
        accountConfigs: {
            2: { stealDelaySeconds: 3, fnosAltAccount: ALT2, fnosIllustratedAuto: { autoClaimRewards: true, autoComplete: false }, ...TEA_LEFTOVER },
            9: { fnosAltAccount: { enabled: true, masterGid: 1280585737, masterName: 'Maksim', timeoutMinutes: 10 }, fnosMilkTeaAutoHire: { enabled: true, durationId: 2, talentId: 0, allowRobots: false } },
        },
        defaultAccountConfig: { stealDelaySeconds: 5, fnosMilkTeaDaily: { autoClaim: true } },
        ui: { theme: 'light' },
    };
    fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify(legacy, null, 2));
    const env = { ...process.env, QQ_FARM_DATA_DIR: dir };
    delete env.FARM_ACCOUNT_ID; // 主进程才迁移 / 清理
    const out = run(`
        const store = require('./dist/models/store');
        const a = store.getConfigSnapshot('2');
        const b = store.getConfigSnapshot('9');
        console.log(JSON.stringify({ a: { alt: a.fnosAltAccount, ill: a.fnosIllustratedAuto, steal: a.stealDelaySeconds, tea: a.fnosMilkTeaAutoHire }, b: { alt: b.fnosAltAccount } }));
    `, env);
    assert.deepEqual(out.a.alt, ALT2);
    assert.deepEqual(out.a.ill, { autoClaimRewards: true, autoComplete: false });
    assert.equal(out.a.steal, 3);
    assert.equal(out.a.tea, undefined);
    assert.equal(out.b.alt.holdForMaster, true, '旧配置缺省 holdForMaster 为 true');
    const store = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
    assert.equal(store.accountConfigs, undefined);
    assert.equal(store.accountConfigStorageVersion, 1);
    assert.equal(store.ui.theme, 'light');
    for (const id of ['2', '9']) {
        const file = readAccountConfigFile(dir, id);
        for (const key of TEA_KEYS) assert.equal(file[key], undefined, `${id}.json 不应再有 ${key}`);
    }
    assert.deepEqual(readAccountConfigFile(dir, '2').fnosAltAccount, ALT2);
    assert.equal(readAccountConfigFile(dir, '2').stealDelaySeconds, 3);
    fs.rmSync(dir, { recursive: true, force: true });
});

// [fnos-fork] 2026-11-15：已拆分格式（2026.10.22 之后版本）的 account-configs/<id>.json 里残留奶茶字段
test('升级到 2026.11.15.1：账号配置文件里的奶茶 fork 字段启动时清掉，其他设置逐字不变，重复启动无副作用', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-fork-cleanup-'));
    const accountDir = path.join(dir, 'account-configs');
    fs.mkdirSync(accountDir, { recursive: true });
    fs.writeFileSync(path.join(accountDir, '.format.json'), JSON.stringify({ version: 1 }));
    const keep = {
        stealDelaySeconds: 4,
        emailClaimHour: 9,
        fnosAltAccount: ALT2,
        fnosIllustratedAuto: { autoClaimRewards: true, autoComplete: true },
        fnosStealRatio: { thresholdPercent: 60, ignoreApplications: true, listFilter: false, barkOnSteal: true, autoDelete: false, autoDeleteOnlineStealer: false },
        bagSeedPriority: [29005, 20021],
    };
    fs.writeFileSync(path.join(accountDir, '1.json'), JSON.stringify({ ...keep, ...TEA_LEFTOVER }, null, 2));
    fs.writeFileSync(path.join(accountDir, '3.json'), JSON.stringify({ stealDelaySeconds: 8 }, null, 2));
    fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ accountConfigStorageVersion: 1, ui: { theme: 'light' } }, null, 2));
    // 上游奶茶活动不落本地数据；图鉴待种文件要原样保留
    fs.mkdirSync(path.join(dir, 'fnos-illustrated'));
    fs.writeFileSync(path.join(dir, 'fnos-illustrated', '1.json'), '{"pending":[20021]}');
    const untouched3 = fs.readFileSync(path.join(accountDir, '3.json'), 'utf8');
    const env = { ...process.env, QQ_FARM_DATA_DIR: dir };
    delete env.FARM_ACCOUNT_ID;
    const read = `
        const store = require('./dist/models/store');
        const s = store.getConfigSnapshot('1');
        console.log(JSON.stringify({ ill: s.fnosIllustratedAuto, alt: s.fnosAltAccount, steal: s.stealDelaySeconds, ratio: s.fnosStealRatio, hour: s.emailClaimHour }));
    `;
    const out = run(read, env);
    const file1 = readAccountConfigFile(dir, '1');
    for (const key of TEA_KEYS) assert.equal(file1[key], undefined, `1.json 不应再有 ${key}`);
    for (const [key, value] of Object.entries(keep)) assert.deepEqual(file1[key], value, `${key} 原样保留`);
    assert.deepEqual(out.ill, { autoClaimRewards: true, autoComplete: true });
    assert.deepEqual(out.alt, ALT2);
    assert.equal(out.steal, 4);
    assert.equal(out.hour, 9);
    assert.deepEqual(out.ratio, { autoDeleteOnlineStealer: false }); // 旧偷收比字段读取时丢弃，文件里原样保留
    assert.equal(fs.readFileSync(path.join(accountDir, '3.json'), 'utf8'), untouched3, '没有奶茶字段的文件不改写');
    assert.equal(fs.readFileSync(path.join(dir, 'fnos-illustrated', '1.json'), 'utf8'), '{"pending":[20021]}');
    // 第二次启动：幂等
    const before = fs.readFileSync(path.join(accountDir, '1.json'), 'utf8');
    const out2 = run(read, env);
    assert.deepEqual(out2, out);
    assert.equal(fs.readFileSync(path.join(accountDir, '1.json'), 'utf8'), before);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanupFnosMilkTeaData：坏文件只跳过不抛错；目录不存在也不报错', () => {
    const { cleanupFnosMilkTeaData } = require('../dist/services/fnos-milk-tea-cleanup');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-fork-cleanup-bad-'));
    fs.mkdirSync(path.join(dir, 'account-configs'));
    fs.writeFileSync(path.join(dir, 'account-configs', '5.json'), '{broken');
    fs.writeFileSync(path.join(dir, 'account-configs', '6.json'), JSON.stringify({ a: 1, fnosMilkTeaExtra: { autoCraft: true } }));
    const r = cleanupFnosMilkTeaData(dir);
    assert.equal(r.removed, 1);
    assert.equal(r.errors.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'account-configs', '6.json'), 'utf8')), { a: 1 });
    assert.equal(fs.readFileSync(path.join(dir, 'account-configs', '5.json'), 'utf8'), '{broken');
    assert.deepEqual(cleanupFnosMilkTeaData(path.join(dir, 'missing')), { files: [], removed: 0, errors: [] });
    fs.rmSync(dir, { recursive: true, force: true });
});
