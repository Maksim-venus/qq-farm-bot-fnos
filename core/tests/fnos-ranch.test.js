// [fnos-fork] 2026-11-16 牧场增强：小号等大号、轮换值守、好友牧场巡查选人、牧场图鉴选动物、设置持久化。
// 真实 store / fnos-fork-config / fnos-ranch，只 mock 网络与日志。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-ranch-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '7';

const dist = rel => require.resolve(path.join('..', 'dist', rel));
const mock = (rel, exports) => { const id = dist(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const logs = [];
const user = { gid: 1001, gold: 0, level: 30 };
const realUtils = require('../dist/utils/utils');
mock('utils/utils', { ...realUtils, log: (tag, msg) => logs.push(`${tag}|${msg}`), logWarn: (tag, msg) => logs.push(`${tag}|WARN|${msg}`) });
mock('utils/network', { getUserState: () => user, getWsErrorState: () => ({}) });

const store = require('../dist/models/store');
const ranch = require('../dist/services/ranch/fnos-ranch');
const apply = cfg => store.applyConfigSnapshot(cfg, { accountId: '7' });

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('normalize：默认值与范围夹取；真实 store 默认带 fnosRanch', () => {
    const d = ranch.normalizeFnosRanch(undefined);
    assert.equal(d.rotation, true);
    assert.equal(d.rotationIdleMinutes, 1);
    assert.equal(d.rotationMinGapSeconds, 30);
    assert.equal(d.altHold, true);
    assert.equal(d.friendSteal, false);
    assert.equal(d.friendClean, false);
    assert.equal(d.friendMosquito, false);
    assert.equal(d.friendFeed, false);
    const c = ranch.normalizeFnosRanch({ rotationIdleMinutes: 999, rotationMinGapSeconds: 1, friendMaxPerPatrol: 0, friendSteal: 1 });
    assert.equal(c.rotationIdleMinutes, 60);
    assert.equal(c.rotationMinGapSeconds, 30);
    assert.equal(c.friendMaxPerPatrol, 1);
    assert.equal(c.friendSteal, true);
    assert.deepEqual(store.getConfigSnapshot('7').fnosRanch, d);
});

test('decideShelfHold：大号偷过 / 没剩余 / 超时 放行，否则等待', () => {
    const lot = (extra = {}) => ({ can_steal: true, remain_num: 3, stealers: [], ...extra });
    assert.equal(ranch.decideShelfHold({ lots: [lot({ stealers: [9] })] }, 9, 0, 1000, 60_000).reason, 'master_stole');
    assert.equal(ranch.decideShelfHold({ lots: [lot({ remain_num: 0 })] }, 9, 0, 1000, 60_000).reason, 'unstealable');
    assert.equal(ranch.decideShelfHold({ can_steal: false, lots: [lot({ can_steal: false })] }, 9, 0, 1000, 60_000).reason, 'waiting');
    assert.equal(ranch.decideShelfHold({ lots: [lot()] }, 9, 0, 61_000, 60_000).reason, 'timeout');
    const w = ranch.decideShelfHold({ lots: [lot({ stealers: [5] })] }, 9, 0, 10_000, 60_000);
    assert.equal(w.release, false);
    assert.equal(w.waitMs, 50_000);
});

const rawWith = shelves => ({ cells: { facilities: [{ instance_id: '10001', ranch: { shelves, animals: [] } }] } });

test('planOwnHarvest：非小号照常一键收；小号货架等大号时只收动物，超时用农场 timeout，0 时用牧场兜底', () => {
    ranch.resetFnosRanchRuntime();
    const shelf = { slot_index: 1, can_collect: true, can_steal: true, lots: [{ can_steal: true, remain_num: 2, stealers: [] }] };
    assert.equal(ranch.planOwnHarvest(rawWith([shelf]), 0).mode, 'all');

    apply({ fnosAltAccount: { enabled: true, masterGid: 2002, masterName: '大号', holdForMaster: true, timeoutMinutes: 10 } });
    let p = ranch.planOwnHarvest(rawWith([shelf]), 1_000);
    assert.equal(p.mode, 'animals');
    assert.equal(p.held, 1);
    assert.equal(p.wakeAtMs, 1_000 + 10 * 60_000);
    assert.ok(logs.some(l => l.includes('先留给大号')), logs.join('\n'));
    p = ranch.planOwnHarvest(rawWith([shelf]), 1_000 + 10 * 60_000);
    assert.equal(p.mode, 'all');

    ranch.resetFnosRanchRuntime();
    const stolen = { ...shelf, lots: [{ can_steal: true, remain_num: 1, stealers: [2002] }] };
    assert.equal(ranch.planOwnHarvest(rawWith([stolen]), 5).mode, 'all');

    ranch.resetFnosRanchRuntime();
    apply({ fnosAltAccount: { timeoutMinutes: 0 }, fnosRanch: { altHoldFallbackMinutes: 30 } });
    p = ranch.planOwnHarvest(rawWith([shelf]), 0);
    assert.equal(p.wakeAtMs, 30 * 60_000);

    apply({ fnosRanch: { altHold: false } });
    assert.equal(ranch.planOwnHarvest(rawWith([shelf]), 0).mode, 'all');
    apply({ fnosRanch: { altHold: true }, fnosAltAccount: { holdForMaster: false } });
    assert.equal(ranch.planOwnHarvest(rawWith([shelf]), 0).mode, 'all');
    apply({ fnosAltAccount: { enabled: false, holdForMaster: true } });
});

test('rotationDue：最小间隔、作物将熟让路、农场有活立即、空闲按分钟、上游到点', () => {
    ranch.resetFnosRanchRuntime();
    const cfg = ranch.normalizeFnosRanch({ rotationIdleMinutes: 2, rotationMinGapSeconds: 30 });
    const rt = ranch._rt;
    ranch.markRanchVisited(100_000);
    assert.equal(ranch.rotationDue(0, 110_000, cfg).reason, 'min_gap');
    rt.pendingAfterFarmWork = true;
    assert.equal(ranch.rotationDue(0, 140_000, cfg).reason, 'after_farm_work');
    rt.ownNextMatureAtMs = 170_000;
    const y = ranch.rotationDue(0, 140_000, cfg);
    assert.equal(y.reason, 'own_mature_soon');
    assert.equal(y.nextAt, 200_000);
    rt.ownNextMatureAtMs = 0;
    ranch.markRanchVisited(100_000);
    assert.equal(ranch.rotationDue(0, 140_000, cfg).reason, 'waiting');
    assert.equal(ranch.rotationDue(130_000, 140_000, cfg).reason, 'upstream_wake');
    assert.equal(ranch.rotationDue(0, 100_000 + 120_000, cfg).reason, 'idle_interval');
    ranch.recordFarmRound({ lands: [], hadWork: true }, 1);
    assert.equal(rt.pendingAfterFarmWork, true);
    ranch.markRanchVisited(2);
    assert.equal(rt.pendingAfterFarmWork, false);
    ranch.recordFriendRound(true);
    assert.equal(rt.pendingAfterFarmWork, true);
});

test('nextOwnMatureSec：取未来最早成熟阶段（兼容毫秒）', () => {
    const lands = [
        { plant: { phases: [{ begin_time: 100 }, { begin_time: 500 }] } },
        { plant: { phases: [{ begin_time: 100 }, { begin_time: 300_000 }] } },
        { plant: { phases: [{ begin_time: 200 }, { begin_time: 400 * 1000 + 1e12 }] } },
        { plant: null },
    ];
    assert.equal(ranch.nextOwnMatureSec(lands, 200), 500);
});

test('pickFriendTargets：黑名单、小号不偷大号、大号优先自己的小号、冷却、轮转游标；清理类恒不选', () => {
    const cfg = ranch.normalizeFnosRanch({ friendSteal: true });
    const friends = [1, 2, 3, 4, 5, 1001].map(gid => ({ gid, name: `f${gid}` }));
    const base = { friends, myGid: 1001, blacklist: [2], alt: null, myAltGids: [], cfg, cooldown: new Map(), cursor: 0, nowMs: 0, limit: 2 };
    let r = ranch.pickFriendTargets(base);
    assert.deepEqual(r.targets.map(t => t.gid), [1, 3]);
    assert.ok(r.targets.every(t => t.steal && !t.clean));
    r = ranch.pickFriendTargets({ ...base, cursor: r.cursor });
    assert.deepEqual(r.targets.map(t => t.gid), [4, 5]);
    // 小号且不偷大号：大号 3 被跳过
    r = ranch.pickFriendTargets({ ...base, alt: { enabled: true, masterGid: 3, skipStealMaster: true }, limit: 5 });
    assert.deepEqual(r.targets.map(t => t.gid), [1, 4, 5]);
    // 大号：自己的小号 5 优先
    r = ranch.pickFriendTargets({ ...base, myAltGids: [5], limit: 2 });
    assert.deepEqual(r.targets.map(t => t.gid), [5, 1]);
    assert.equal(r.targets[0].priority, true);
    // 冷却
    r = ranch.pickFriendTargets({ ...base, cooldown: new Map([[1, 10]]), nowMs: 5, limit: 5 });
    assert.deepEqual(r.targets.map(t => t.gid), [3, 4, 5]);
    // 偷关掉 → 没有目标（清理等抓包后再做）
    r = ranch.pickFriendTargets({ ...base, cfg: ranch.normalizeFnosRanch({ friendSteal: false, friendClean: true }), limit: 5 });
    assert.equal(r.targets.length, 0);
});

test('pickAnimalForBook：开启且有缺失产物时优先选缺的（最便宜）；否则交还上游', () => {
    const goods = [
        { id: 1, price: { count: 50 }, animal: { id: 60002, product_item: { id: 2060002 } } },
        { id: 2, price: { count: 10 }, animal: { id: 60003, product_item: { id: 2060003 } } },
        { id: 3, price: { count: 5 }, animal: { id: 60001, product_item: { id: 2060001 } } },
    ];
    ranch._rt.uncollectedProducts = new Set([2060002, 2060003]);
    assert.equal(ranch.pickAnimalForBook(goods), null);
    apply({ fnosRanch: { illustratedAutoComplete: true } });
    assert.equal(ranch.pickAnimalForBook(goods).id, 2);
    ranch._rt.uncollectedProducts = new Set();
    assert.equal(ranch.pickAnimalForBook(goods), null);
    apply({ fnosRanch: { illustratedAutoComplete: false } });
});

test('runFriendPatrol：关闭时不读好友、不发请求', async () => {
    ranch.resetFnosRanchRuntime();
    assert.equal(await ranch.runFriendPatrol(0), 0);
    assert.equal(ranch._rt.dayVisits, 0);
});

test('fnosRanch 持久化：新进程读回，其他字段不受影响', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-ranch-store-'));
    const env = { ...process.env, QQ_FARM_DATA_DIR: dir };
    delete env.FARM_ACCOUNT_ID;
    const run = script => {
        const r = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    run(`const s=require('./dist/models/store');
        s.applyConfigSnapshot({ fnosIllustratedAuto: { autoClaimRewards: true } }, { accountId: 'a1' });
        s.applyConfigSnapshot({ fnosRanch: { rotation: false, rotationIdleMinutes: 5, friendSteal: true, friendMaxPerPatrol: 3 } }, { accountId: 'a1' });
        s.applyConfigSnapshot({ fnosGrassLands: { count: 4, autoBuy: false } }, { accountId: 'a1' });
        console.log('{}');`);
    const out = run(`const s=require('./dist/models/store');const c=s.getConfigSnapshot('a1');const o=s.getConfigSnapshot('a2');
        console.log(JSON.stringify({ r: c.fnosRanch, g: c.fnosGrassLands, ill: c.fnosIllustratedAuto, or: o.fnosRanch, og: o.fnosGrassLands }));`);
    assert.equal(out.r.rotation, false);
    assert.equal(out.r.rotationIdleMinutes, 5);
    assert.equal(out.r.friendSteal, true);
    assert.equal(out.r.friendMaxPerPatrol, 3);
    assert.deepEqual(out.g, { count: 4, autoBuy: false });
    assert.equal(out.ill.autoClaimRewards, true);
    assert.equal(out.or.rotation, true);
    assert.deepEqual(out.og, { count: 0, autoBuy: true });
    fs.rmSync(dir, { recursive: true, force: true });
});
