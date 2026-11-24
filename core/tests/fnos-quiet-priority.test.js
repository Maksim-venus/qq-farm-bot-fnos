// [fnos-fork] 2026-11-16「自己收菜优先」「空闲时只保留心跳」：归一化、持久化、纯函数，以及与真实 store + 巡田流程的联动。
// 重点：大小号协作里开启「成熟作物先留给大号偷」的小号，自己收菜优先不能绕过、提前或缩短「等大号偷过（或超时）再收」。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-quiet-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '7';

const dist = rel => require.resolve(path.join('..', 'dist', rel));
const MASTER = 1280585737;
const NOW0 = 1_792_000_000;
let nowSec = NOW0;
const harvestCalls = [];
const plantCalls = [];
let lastLands = [];
let interactRecords = [];
const logs = [];
const networkEvents = new EventEmitter();

require.cache[dist('services/farm/api')] = {
    exports: {
        getAllLands: async () => ({ lands: lastLands }),
        harvest: async (landIds, isAll = true) => { // 上游 #185 起第二个参数为 isAll 布尔值
            const options = { isAll };
            harvestCalls.push({ landIds: [...landIds], isAll: options.isAll !== false });
            return { land: [] };
        },
        farming: async () => ({}),
        unlockLand: async () => ({}),
        upgradeLand: async () => ({}),
    },
};
require.cache[dist('services/interact')] = { exports: { getInteractRecords: async () => interactRecords } };
require.cache[dist('utils/network')] = { exports: { getUserState: () => ({ gid: 1001 }), networkEvents } };
require.cache[dist('services/farm/planting')] = {
    exports: {
        autoPlantEmptyLands: async (dead, empty) => { plantCalls.push({ dead: [...dead], empty: [...empty] }); return { plantedLands: [] }; },
        runFertilizerByConfig: async () => ({ normal: 0, organic: 0 }),
        getRemainingPlantDelayMs: () => 0,
    },
};
require.cache[dist('services/mall')] = { exports: { checkAndBuyFertilizerBoth: async () => {} } };
require.cache[dist('services/stats')] = { exports: { recordOperation: () => {} } };
const realUtils = require('../dist/utils/utils');
require.cache[dist('utils/utils')] = {
    exports: {
        ...realUtils,
        getServerTimeSec: () => nowSec,
        randomDelay: async () => {},
        log: (tag, msg) => logs.push(`${tag}|${msg}`),
        logWarn: (tag, msg) => logs.push(`${tag}|WARN|${msg}`),
    },
};

const store = require('../dist/models/store');
const quiet = require('../dist/services/fnos-quiet-priority');
const { resetFnosAltAccountRuntime } = require('../dist/services/farm/fnos-alt-account');
const { readFnosForkConfigs, describeAlt } = require('../dist/services/fnos-fork-config');
const scheduler = require('../dist/services/farm/scheduler');

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

function matureLand(id) {
    return { id, unlocked: true, plant: { id: 2020002, fruit_id: 40002, name: '白萝卜', season: 1, phases: [{ phase: 6, begin_time: NOW0 - 100 }] } };
}
function growingLand(id, matureInSec) {
    return { id, unlocked: true, plant: { id: 2020002, fruit_id: 40002, name: '白萝卜', season: 1, phases: [{ phase: 3, begin_time: NOW0 - 60 }, { phase: 6, begin_time: NOW0 + matureInSec }] } };
}
function emptyLand(id) {
    return { id, unlocked: true };
}
function apply(patch) {
    store.applyConfigSnapshot(patch, { persist: false, accountId: '7' });
}
function reset(lands) {
    harvestCalls.length = 0;
    plantCalls.length = 0;
    logs.length = 0;
    lastLands = lands;
    interactRecords = [];
    nowSec = NOW0;
    quiet.resetFnosQuietRuntime();
    resetFnosAltAccountRuntime();
}
const BASE_AUTO = { farm: true, farm_push: false, skip_own_weed_bug: true, fertilizer: 'none', land_upgrade: false, fertilizer_multi_season: false, friend: false };
const ALT_HOLD = { enabled: true, masterGid: MASTER, masterName: 'Maksim', holdForMaster: true, timeoutMinutes: 10 };

// ---------- 归一化与持久化 ----------

// [fnos-fork] 2026-11-17 按时间表偷菜 / 好友扫描间隔 / 自家提前秒数（同一份 fnosQuietPriority）
const FNOS_TT_DEFAULTS = { timetableSteal: true, friendScanMinutes: 5, ownLeadSec: 2 };

test('归一化：默认「自己收菜优先」开、合并 10 秒，「空闲时只保留心跳」关、1～10 分钟；越界收拢；缺字段沿用已保存值', () => {
    assert.deepEqual(quiet.normalizeFnosQuietPriority(undefined), { ownHarvestFirst: true, mergeWindowSec: 10, idleKeepaliveOnly: false, idleMinMinutes: 1, idleMaxMinutes: 10, ...FNOS_TT_DEFAULTS });
    assert.deepEqual(quiet.normalizeFnosQuietPriority({ mergeWindowSec: 99, idleMinMinutes: 0, idleMaxMinutes: 999 }), { ownHarvestFirst: true, mergeWindowSec: 30, idleKeepaliveOnly: false, idleMinMinutes: 1, idleMaxMinutes: 180, ...FNOS_TT_DEFAULTS });
    assert.deepEqual(quiet.normalizeFnosQuietPriority({ idleMinMinutes: 20, idleMaxMinutes: 5 }).idleMinMinutes, 5, '最短大于最长时互换');
    const prev = quiet.normalizeFnosQuietPriority({ ownHarvestFirst: false, idleKeepaliveOnly: true, idleMaxMinutes: 30, ...FNOS_TT_DEFAULTS });
    assert.deepEqual(quiet.normalizeFnosQuietPriority({ mergeWindowSec: 0 }, prev), { ownHarvestFirst: false, mergeWindowSec: 0, idleKeepaliveOnly: true, idleMinMinutes: 1, idleMaxMinutes: 30, ...FNOS_TT_DEFAULTS });
});

function readAccountConfigFile(id) {
    const name = /^\d+$/.test(id) ? id : `id-${Buffer.from(id, 'utf8').toString('hex')}`;
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'account-configs', `${name}.json`), 'utf8'));
}

test('持久化：保存后写进 data/account-configs/<id>.json，读回一致；只改一项时其余不变；worker 读到同一份', () => {
    store.applyConfigSnapshot({ fnosQuietPriority: { idleKeepaliveOnly: true, idleMinMinutes: 3, idleMaxMinutes: 15 } }, { accountId: 'q1' });
    let raw = readAccountConfigFile('q1');
    assert.deepEqual(raw.fnosQuietPriority, { ownHarvestFirst: true, mergeWindowSec: 10, idleKeepaliveOnly: true, idleMinMinutes: 3, idleMaxMinutes: 15, ...FNOS_TT_DEFAULTS });
    store.applyConfigSnapshot({ fnosQuietPriority: { ownHarvestFirst: false } }, { accountId: 'q1' });
    raw = readAccountConfigFile('q1');
    assert.equal(raw.fnosQuietPriority.ownHarvestFirst, false);
    assert.equal(raw.fnosQuietPriority.idleMaxMinutes, 15);
    assert.deepEqual(store.getConfigSnapshot('q1').fnosQuietPriority, raw.fnosQuietPriority);
    assert.deepEqual(readFnosForkConfigs('q1').quiet, raw.fnosQuietPriority);
    // 新账号没有该字段 → 默认值
    assert.deepEqual(store.getConfigSnapshot('q-new').fnosQuietPriority, quiet.DEFAULT_FNOS_QUIET_PRIORITY);
});

// ---------- 纯函数 ----------

test('纯函数：下一块成熟时间、合并判断、小号留菜判定', () => {
    assert.equal(quiet.nextOwnMatureSec([matureLand(1), growingLand(2, 50), growingLand(3, 20)], NOW0), NOW0 + 20);
    assert.equal(quiet.nextOwnMatureSec([matureLand(1)], NOW0), 0, '已经成熟的不算“将要成熟”');
    assert.equal(quiet.nextOwnMatureSec([growingLand(3, 20)], NOW0, [3]), 0);
    const base = { enabled: true, altHolding: false, harvestedCount: 1, nextMatureAtMs: 5_000, nowMs: 0, windowSec: 10, streak: 0 };
    assert.equal(quiet.planMergeAfterHarvest(base), true);
    assert.equal(quiet.planMergeAfterHarvest({ ...base, nextMatureAtMs: 11_000 }), false);
    assert.equal(quiet.planMergeAfterHarvest({ ...base, windowSec: 0 }), false);
    assert.equal(quiet.planMergeAfterHarvest({ ...base, streak: quiet.MAX_MERGE_STREAK }), false, '最多连续合并 3 次');
    assert.equal(quiet.planMergeAfterHarvest({ ...base, altHolding: true }), false, '留菜小号不合并');
    assert.equal(quiet.isAltHoldingForMaster(ALT_HOLD), true);
    assert.equal(quiet.isAltHoldingForMaster({ ...ALT_HOLD, holdForMaster: false }), false);
    assert.equal(quiet.isAltHoldingForMaster({ ...ALT_HOLD, masterGid: 0 }), false);
});

test('纯函数：空闲静默只在两边都空闲时进入，成熟前 10 秒结束，小号有留菜最多 60 秒，不足 60 秒不静默', () => {
    const base = { enabled: true, nowMs: 0, farmIdle: true, friendIdle: true, nextOwnMatureAtMs: 0, altHeldCount: 0, minMinutes: 1, maxMinutes: 10, rand: () => 0.999999 };
    assert.ok(Math.abs(quiet.planIdleUntil(base) - 600_000) < 2);
    assert.equal(quiet.planIdleUntil({ ...base, rand: () => 0 }), 60_000);
    assert.equal(quiet.planIdleUntil({ ...base, enabled: false }), 0);
    assert.equal(quiet.planIdleUntil({ ...base, farmIdle: false }), 0);
    assert.equal(quiet.planIdleUntil({ ...base, friendIdle: false }), 0);
    assert.ok(quiet.planIdleUntil({ ...base, nextOwnMatureAtMs: 200_000 }) <= 190_000);
    assert.equal(quiet.planIdleUntil({ ...base, nextOwnMatureAtMs: 65_000 }), 0, '成熟前可静默时间不足 60 秒');
    assert.equal(quiet.planIdleUntil({ ...base, altHeldCount: 2 }), 60_000);
});

// ---------- 自己收菜优先：普通账号 ----------

test('普通账号：收完后下一块 5 秒内成熟 → 本轮不补种、合并到下一轮，并在成熟后 0.3 秒安排巡田；关掉开关则照常补种', async () => {
    apply({ automation: BASE_AUTO, fnosAltAccount: { enabled: false }, fnosQuietPriority: { ownHarvestFirst: true, mergeWindowSec: 10, idleKeepaliveOnly: false } });
    reset([matureLand(15), growingLand(16, 5), emptyLand(17)]);
    await scheduler.checkFarm();
    assert.deepEqual(harvestCalls, [{ landIds: [15], isAll: true }]);
    assert.equal(plantCalls.length, 0, '合并时本轮不补种');
    assert.ok(logs.some(l => l.includes('补种并入下一轮')), logs.join('\n'));
    const matureAt = quiet.ownPriorityMatureAt();
    assert.ok(matureAt > Date.now() + 3000 && matureAt <= Date.now() + 5000, String(matureAt - Date.now()));
    const now = Date.now();
    const adj = quiet.adjustUnifiedSchedule({ nowMs: now, nextFarmRunAt: now + 60_000, nextFriendRunAt: now + 6000, farmBusy: false, friendBusy: false, auto: { farm: true, friend: true, friend_steal: true } });
    assert.equal(adj.nextFarmRunAt, matureAt + 300, '成熟后 0.3 秒巡田');
    assert.ok(adj.nextFriendRunAt >= matureAt + 8000, '好友巡查推到自家收完之后');
    assert.equal(quiet.shouldYieldToOwnHarvest(now), true);

    apply({ fnosQuietPriority: { ownHarvestFirst: false } });
    reset([matureLand(15), growingLand(16, 5), emptyLand(17)]);
    await scheduler.checkFarm();
    assert.deepEqual(harvestCalls, [{ landIds: [15], isAll: true }]);
    assert.equal(plantCalls.length, 1, '关闭后照常补种');
    assert.equal(quiet.ownPriorityMatureAt(), 0);
    apply({ fnosQuietPriority: { ownHarvestFirst: true } });
});

test('连续合并最多 3 次，第 4 次照常补种', async () => {
    apply({ automation: BASE_AUTO, fnosAltAccount: { enabled: false }, fnosQuietPriority: { ownHarvestFirst: true, mergeWindowSec: 10 } });
    reset([matureLand(15), growingLand(16, 5), emptyLand(17)]);
    for (let i = 0; i < 3; i++) await scheduler.checkFarm();
    assert.equal(plantCalls.length, 0);
    await scheduler.checkFarm();
    assert.equal(plantCalls.length, 1);
});

// ---------- 自己收菜优先：小号等大号（用户硬要求） ----------

test('小号（先留给大号偷）：大号没偷的成熟地不收；下一块马上成熟也不抢点、不合并、不让好友巡查等待', async () => {
    apply({ automation: BASE_AUTO, fnosAltAccount: ALT_HOLD, fnosQuietPriority: { ownHarvestFirst: true, mergeWindowSec: 30, idleKeepaliveOnly: false } });
    reset([matureLand(15), growingLand(16, 5)]);
    await scheduler.checkFarm();
    assert.deepEqual(harvestCalls, [], '留给大号的地不能因为自己收菜优先而提前收');
    assert.ok(logs.some(l => l.startsWith('小号|留给大号')), logs.join('\n'));
    assert.equal(quiet.ownPriorityMatureAt(), 0, '小号不按成熟时间抢点巡田');
    assert.equal(quiet.shouldYieldToOwnHarvest(), false);
    const now = Date.now();
    const adj = quiet.adjustUnifiedSchedule({ nowMs: now, nextFarmRunAt: now + 60_000, nextFriendRunAt: now + 1000, farmBusy: false, friendBusy: false, auto: { farm: true } });
    assert.deepEqual(adj, { nextFarmRunAt: now + 60_000, nextFriendRunAt: now + 1000 });
});

test('小号：大号偷了一块后只逐块收那一块（is_all=false），即使下一块马上成熟也照常补种不合并', async () => {
    apply({ automation: BASE_AUTO, fnosAltAccount: ALT_HOLD, fnosQuietPriority: { ownHarvestFirst: true, mergeWindowSec: 30 } });
    reset([matureLand(15), matureLand(16), growingLand(17, 5), emptyLand(18)]);
    interactRecords = [{ actionType: 1, visitorGid: MASTER, serverTimeSec: NOW0 - 50, landId: 16 }];
    await scheduler.checkFarm();
    assert.deepEqual(harvestCalls, [{ landIds: [16], isAll: false }]);
    assert.equal(plantCalls.length, 1);
    assert.ok(!logs.some(l => l.includes('补种并入下一轮')), logs.join('\n'));
});

test('小号：超时不被缩短——9 分钟时即使开着两个新功能也不收，满 10 分钟才收', async () => {
    apply({ automation: BASE_AUTO, fnosAltAccount: ALT_HOLD, fnosQuietPriority: { ownHarvestFirst: true, idleKeepaliveOnly: true } });
    reset([matureLand(15)]);
    await scheduler.checkFarm();
    nowSec = NOW0 + 540;
    await scheduler.checkFarm();
    assert.deepEqual(harvestCalls, []);
    nowSec = NOW0 + 600;
    await scheduler.checkFarm();
    assert.deepEqual(harvestCalls, [{ landIds: [15], isAll: true }]);
    assert.ok(describeAlt(readFnosForkConfigs().alt).includes('只收大号偷过的地'));
});

test('不开「先留给大号偷」的小号按普通账号处理（可以合并）', async () => {
    apply({ automation: BASE_AUTO, fnosAltAccount: { ...ALT_HOLD, holdForMaster: false }, fnosQuietPriority: { ownHarvestFirst: true, mergeWindowSec: 10, idleKeepaliveOnly: false } });
    reset([matureLand(15), growingLand(16, 5)]);
    await scheduler.checkFarm();
    assert.deepEqual(harvestCalls, [{ landIds: [15], isAll: true }]);
    assert.equal(plantCalls.length, 0);
});

// ---------- 空闲时只保留心跳 ----------

test('空闲：巡田无动作 + 好友无访问 → 静默（成熟前 10 秒结束），期间统一调度推迟；推送巡田有动作立刻结束', async () => {
    apply({ automation: BASE_AUTO, fnosAltAccount: { enabled: false }, fnosQuietPriority: { ownHarvestFirst: true, idleKeepaliveOnly: true, idleMinMinutes: 1, idleMaxMinutes: 10, ...FNOS_TT_DEFAULTS } });
    reset([growingLand(15, 1800)]);
    await scheduler.checkFarm();
    let now = Date.now();
    // 好友还没跑过一轮 → 好友功能开着时不静默
    let adj = quiet.adjustUnifiedSchedule({ nowMs: now, nextFarmRunAt: now + 3000, nextFriendRunAt: now + 1000, farmBusy: false, friendBusy: false, auto: { farm: true, friend: true, friend_steal: true } });
    assert.equal(quiet.isFnosIdleActive(), false);
    quiet.recordFriendRound(0);
    now = Date.now();
    adj = quiet.adjustUnifiedSchedule({ nowMs: now, nextFarmRunAt: now + 3000, nextFriendRunAt: now + 1000, farmBusy: false, friendBusy: false, auto: { farm: true, friend: true, friend_steal: true } });
    assert.equal(quiet.isFnosIdleActive(), true);
    const until = quiet.getFnosIdleUntil();
    assert.ok(until - now >= 60_000 && until - now <= 600_000, String(until - now));
    assert.equal(adj.nextFarmRunAt, until);
    assert.equal(adj.nextFriendRunAt, until);
    assert.ok(logs.some(l => l.includes('只保留心跳')), logs.join('\n'));
    assert.equal(quiet.shouldPauseBackgroundSync(), true);

    // 静默中土地推送触发巡田、发现可收 → 结束静默
    let interrupted = 0;
    quiet.setIdleInterruptedListener(() => { interrupted += 1; });
    lastLands = [matureLand(15)];
    await scheduler.checkFarm();
    assert.equal(quiet.isFnosIdleActive(), false);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(interrupted, 1);
    quiet.setIdleInterruptedListener(null);
});

test('空闲：上一轮有动作或好友有人要访问时不静默；关掉开关立即结束；到点后立即巡田', async () => {
    apply({ automation: BASE_AUTO, fnosAltAccount: { enabled: false }, fnosQuietPriority: { idleKeepaliveOnly: true } });
    reset([growingLand(15, 1800)]);
    await scheduler.checkFarm();
    quiet.recordFriendRound(2);
    let now = Date.now();
    quiet.adjustUnifiedSchedule({ nowMs: now, nextFarmRunAt: now + 3000, nextFriendRunAt: now + 1000, farmBusy: false, friendBusy: false, auto: { farm: true, friend: true, friend_steal: true } });
    assert.equal(quiet.isFnosIdleActive(), false, '好友这轮还有人要访问');

    quiet.recordFriendRound(0);
    now = Date.now();
    quiet.adjustUnifiedSchedule({ nowMs: now, nextFarmRunAt: now + 3000, nextFriendRunAt: now + 1000, farmBusy: false, friendBusy: false, auto: { farm: true, friend: true, friend_steal: true } });
    assert.equal(quiet.isFnosIdleActive(), true);
    // 到点：返回“立即巡田/巡查”
    const until = quiet.getFnosIdleUntil();
    const adj = quiet.adjustUnifiedSchedule({ nowMs: until + 1, nextFarmRunAt: until, nextFriendRunAt: until, farmBusy: false, friendBusy: false, auto: { farm: true } });
    assert.deepEqual(adj, { nextFarmRunAt: until + 1, nextFriendRunAt: until + 1 });
    assert.equal(quiet.getFnosIdleUntil(), 0);
    // 刚醒来，需要重新跑完一轮巡田和好友才可能再次静默
    now = Date.now();
    quiet.adjustUnifiedSchedule({ nowMs: now, nextFarmRunAt: now + 3000, nextFriendRunAt: now + 1000, farmBusy: false, friendBusy: false, auto: { farm: true, friend: true, friend_steal: true } });
    assert.equal(quiet.isFnosIdleActive(), false);

    // 关掉开关：结束静默
    await scheduler.checkFarm();
    quiet.recordFriendRound(0);
    now = Date.now();
    quiet.adjustUnifiedSchedule({ nowMs: now, nextFarmRunAt: now + 3000, nextFriendRunAt: now + 1000, farmBusy: false, friendBusy: false, auto: { farm: true } });
    assert.equal(quiet.isFnosIdleActive(), true);
    apply({ fnosQuietPriority: { idleKeepaliveOnly: false } });
    quiet.adjustUnifiedSchedule({ nowMs: Date.now(), nextFarmRunAt: now + 3000, nextFriendRunAt: now + 1000, farmBusy: false, friendBusy: false, auto: { farm: true } });
    assert.equal(quiet.isFnosIdleActive(), false);
});

test('空闲 + 小号有留给大号的地：最多静默 60 秒就复查（不会因为静默提前收）', async () => {
    apply({ automation: BASE_AUTO, fnosAltAccount: ALT_HOLD, fnosQuietPriority: { ownHarvestFirst: true, idleKeepaliveOnly: true, idleMinMinutes: 5, idleMaxMinutes: 30, ...FNOS_TT_DEFAULTS } });
    reset([matureLand(15), growingLand(16, 3600)]);
    await scheduler.checkFarm();
    assert.deepEqual(harvestCalls, []);
    const now = Date.now();
    quiet.adjustUnifiedSchedule({ nowMs: now, nextFarmRunAt: now + 3000, nextFriendRunAt: now + 1000, farmBusy: false, friendBusy: false, auto: { farm: true, friend: false } });
    assert.equal(quiet.isFnosIdleActive(), true);
    assert.equal(quiet.getFnosIdleUntil() - now, quiet.ALT_HELD_RECHECK_MS);
});
