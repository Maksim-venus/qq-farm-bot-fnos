// [fnos-fork] 「成熟作物先留给大号偷」开关 holdForMaster：开 / 关 / 缺省三种情况（归一化、持久化、接口读写）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-hold-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
const MASTER = 1280585737;

const store = require('../dist/models/store');
const { normalizeFnosAltAccount, DEFAULT_FNOS_ALT_ACCOUNT } = require('../dist/services/farm/fnos-alt-account');
const { describeAlt } = require('../dist/services/fnos-fork-config');
const { mountFnosForkRoutes } = require('../dist/controllers/admin/fnos-fork-routes');

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('归一化：缺省为 true（默认值、旧配置无该字段、新启用小号）；显式 false 保留；部分更新时沿用已有值', () => {
    assert.equal(DEFAULT_FNOS_ALT_ACCOUNT.holdForMaster, true);
    assert.equal(normalizeFnosAltAccount(undefined).holdForMaster, true);
    // 旧版配置（没有该字段）
    assert.equal(normalizeFnosAltAccount({ enabled: true, masterGid: MASTER, masterName: 'Maksim', timeoutMinutes: 10 }).holdForMaster, true);
    // fallback 是旧版存储对象（也没有该字段）
    assert.equal(normalizeFnosAltAccount({ timeoutMinutes: 5 }, { enabled: true, masterGid: MASTER, masterName: 'M', timeoutMinutes: 1 }).holdForMaster, true);
    assert.equal(normalizeFnosAltAccount({ holdForMaster: false }).holdForMaster, false);
    assert.equal(normalizeFnosAltAccount({ holdForMaster: 0 }).holdForMaster, false);
    assert.equal(normalizeFnosAltAccount({ holdForMaster: true }).holdForMaster, true);
    const prevOff = normalizeFnosAltAccount({ enabled: true, masterGid: MASTER, holdForMaster: false });
    assert.equal(normalizeFnosAltAccount({ skipStealMaster: true }, prevOff).holdForMaster, false);
    assert.equal(normalizeFnosAltAccount({ holdForMaster: true }, prevOff).holdForMaster, true);
});

// [fnos-fork] 上游 2026-10-22 起账号配置拆分为 data/account-configs/<id>.json（store.json 只留公共配置）
function readAccountConfigFile(dataDir, id) {
    const name = /^\d+$/.test(id) ? id : `id-${Buffer.from(id, 'utf8').toString('hex')}`;
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'account-configs', `${name}.json`), 'utf8'));
}

test('持久化：旧版配置里没有该字段时读出 true；关掉后保存并读回 false；其他字段不受影响', () => {
    store.applyConfigSnapshot({ fnosAltAccount: { enabled: true, masterGid: MASTER, masterName: 'Maksim', timeoutMinutes: 10, skipStealMaster: true } }, { accountId: 'h1' });
    assert.equal(store.getConfigSnapshot('h1').fnosAltAccount.holdForMaster, true);
    store.applyConfigSnapshot({ fnosAltAccount: { holdForMaster: false } }, { accountId: 'h1' });
    const cfg = store.getConfigSnapshot('h1').fnosAltAccount;
    assert.equal(cfg.holdForMaster, false);
    assert.equal(cfg.skipStealMaster, true);
    assert.equal(cfg.timeoutMinutes, 10);
    const raw = readAccountConfigFile(DATA_DIR, 'h1');
    assert.equal(raw.fnosAltAccount.holdForMaster, false);
});

test('状态日志：开 / 关时描述不同，关时不提超时', () => {
    const base = { enabled: true, masterGid: MASTER, masterName: 'Maksim', timeoutMinutes: 10, skipStealMaster: true, badOnlyMaster: false };
    const on = describeAlt({ ...base, holdForMaster: true });
    assert.ok(on.includes('成熟作物先留给大号偷，超时 10 分钟') && on.includes('只收大号偷过的地'), on);
    const off = describeAlt({ ...base, holdForMaster: false });
    assert.ok(off.includes('「成熟作物先留给大号偷」未开启，自动巡田正常收获自己的地') && !off.includes('超时'), off);
    assert.ok(off.includes('不偷大号的菜'), off);
});

// ---------- 接口 ----------
function makeApp(saved) {
    const routes = {};
    const app = {
        get: (p, h) => { routes[`GET ${p}`] = h; },
        post: (p, h) => { routes[`POST ${p}`] = h; },
    };
    const ctx = {
        provider: {
            resolveAccountId: id => id,
            saveSettings: async (id, patch) => {
                saved.push(patch);
                store.applyConfigSnapshot(patch, { accountId: id });
                return { saved: true, status: 'applied', ...store.getConfigSnapshot(id) };
            },
        },
    };
    mountFnosForkRoutes(app, ctx);
    return routes;
}
async function call(handler, body) {
    let statusCode = 200; let payload;
    const res = { status(c) { statusCode = c; return this; }, json(d) { payload = d; return this; } };
    await handler({ body, headers: { 'x-account-id': 'h2' }, query: {}, params: {} }, res);
    return { statusCode, payload };
}

test('接口：GET 缺省返回 true；POST 开 / 关能存能读；POST 不带该字段时沿用已保存的值', async () => {
    const saved = [];
    const routes = makeApp(saved);
    // 旧配置（无字段）
    store.applyConfigSnapshot({ fnosAltAccount: { enabled: true, masterGid: MASTER, masterName: 'Maksim', timeoutMinutes: 10 } }, { accountId: 'h2' });
    const got = (await call(routes['GET /api/fnos/alt-account'])).payload;
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.data.holdForMaster, true);

    let r = await call(routes['POST /api/fnos/alt-account'], { enabled: true, masterGid: MASTER, masterName: 'Maksim', holdForMaster: false, timeoutMinutes: 10 });
    assert.equal(r.payload.ok, true, JSON.stringify(r.payload));
    assert.equal(r.payload.data.holdForMaster, false);
    assert.equal((await call(routes['GET /api/fnos/alt-account'])).payload.data.holdForMaster, false);

    // 不带字段：沿用已保存的 false
    r = await call(routes['POST /api/fnos/alt-account'], { enabled: true, masterGid: MASTER, masterName: 'Maksim', skipStealMaster: true });
    assert.equal(r.payload.data.holdForMaster, false);
    assert.equal(r.payload.data.skipStealMaster, true);

    r = await call(routes['POST /api/fnos/alt-account'], { enabled: true, masterGid: MASTER, masterName: 'Maksim', holdForMaster: true });
    assert.equal(r.payload.data.holdForMaster, true);
});
