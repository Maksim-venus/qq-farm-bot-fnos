// [fnos-fork] 2026.10.20.3 回归测试：用「真实」store（不 mock models/store），模拟 worker 运行中收到新配置、
// 土地推送触发巡田、施肥后跟随收获、催熟后立即成熟的地，以及奶茶自动雇佣读取配置。
// 2026.10.20.1 的测试 mock 了一个 store 并不存在的方法，导致真机上小号/奶茶设置从未生效却全部测试通过。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-fork-worker-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '2';

const dist = rel => require.resolve(path.join('..', 'dist', rel));
const MASTER = 1280585737;
const NOW0 = 1_792_000_000;
let nowSec = NOW0;
const harvestCalls = [];
let landsQueue = [];
let lastLands = [];
let interactRecords = [];
let organicResult = 0;
const logs = [];
const networkEvents = new EventEmitter();

require.cache[dist('services/farm/api')] = {
    exports: {
        getAllLands: async () => {
            if (landsQueue.length) lastLands = landsQueue.shift();
            return { lands: lastLands };
        },
        harvest: async (landIds, options = {}) => {
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
        autoPlantEmptyLands: async () => ({ plantedLands: [] }),
        runFertilizerByConfig: async () => ({ normal: 0, organic: organicResult }),
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
const { onWorkerConfigApplied, logFnosForkStatus, readFnosForkConfigs } = require('../dist/services/fnos-fork-config');
const { resetFnosAltAccountRuntime } = require('../dist/services/farm/fnos-alt-account');
const scheduler = require('../dist/services/farm/scheduler');
const tea = require('../dist/services/fnos-milk-tea-auto-hire');

/** 与 worker.ts applyRuntimeConfig 相同：applyConfigSnapshot(persist:false, accountId) 后调用 [fnos-fork] 挂钩 */
function workerApply(snapshot) {
    store.applyConfigSnapshot(snapshot, { persist: false, accountId: process.env.FARM_ACCOUNT_ID });
    onWorkerConfigApplied();
}

/** 催熟后立刻成熟的地：服务端成熟时间戳可能是很早以前（这里设为 3 天前） */
function boostedLand(id) {
    return {
        id, unlocked: true,
        plant: { id: 2020002, fruit_id: 40002, name: '白萝卜', season: 1, phases: [{ phase: 6, begin_time: NOW0 - 86400 * 3 }] },
    };
}
function growingLand(id) {
    return {
        id, unlocked: true,
        plant: { id: 2020002, fruit_id: 40002, name: '白萝卜', season: 1, phases: [{ phase: 3, begin_time: NOW0 - 60 }, { phase: 6, begin_time: NOW0 + 40000 }] },
    };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
function reset(lands) {
    harvestCalls.length = 0;
    logs.length = 0;
    landsQueue = [];
    lastLands = lands;
    interactRecords = [];
    organicResult = 0;
}

test.after(() => {
    scheduler.stopFarmCheckLoop();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('worker 初始配置未开小号 → 照常收获；运行中保存开启小号 → 立即生效并打印状态', async () => {
    resetFnosAltAccountRuntime();
    // worker 启动时 config_sync（小号关、奶茶开）
    workerApply({
        automation: { farm: true, farm_push: true, skip_own_weed_bug: true, fertilizer: 'none', land_upgrade: false, fertilizer_multi_season: false },
        fnosAltAccount: { enabled: false },
        fnosMilkTeaAutoHire: { enabled: true, durationId: 0, talentId: 0, allowRobots: true },
    });
    // 登录完成时强制打印状态
    logs.length = 0;
    assert.equal(logFnosForkStatus('账号已登录', true), true);
    assert.ok(logs.some(l => l.startsWith('小号|账号已登录：小号模式未启用')), logs.join('\n'));
    assert.ok(logs.some(l => l.startsWith('奶茶雇佣|账号已登录：奶茶自动雇佣已启用')), logs.join('\n'));

    reset([boostedLand(15)]);
    await scheduler.runFarmOperation('all');
    assert.deepEqual(harvestCalls, [{ landIds: [15], isAll: true }]);

    // 运行中保存（data-provider.saveSettings → applyRuntimeConfigSnapshot，下发的是完整配置快照）
    const saved = { ...store.getConfigSnapshot('2'), fnosAltAccount: { enabled: true, masterGid: MASTER, masterName: 'Maksim', timeoutMinutes: 10 } };
    logs.length = 0;
    workerApply(saved);
    assert.ok(logs.includes(`小号|设置已更新：小号模式已启用，大号 Maksim(${MASTER})，超时 10 分钟（从本进程首次发现可收时算起）；自动巡田只收大号偷过的地，手动收获不受限`), logs.join('\n'));
    assert.deepEqual(readFnosForkConfigs().alt, { enabled: true, masterGid: MASTER, masterName: 'Maksim', timeoutMinutes: 10 });
    // 同样的配置再下发一次不重复打印
    logs.length = 0;
    workerApply(saved);
    assert.equal(logs.length, 0);

    reset([boostedLand(15)]);
    await scheduler.runFarmOperation('all');
    assert.deepEqual(harvestCalls, [], '小号不应收获大号还没偷的地');
    assert.ok(logs.some(l => l.startsWith('小号|留给大号 Maksim')), logs.join('\n'));
});

test('土地推送触发的巡田（如手动施肥催熟后）同样留给大号；10 分钟超时从首次发现可收算起', async () => {
    resetFnosAltAccountRuntime();
    reset([boostedLand(15)]);
    nowSec = NOW0;
    scheduler.startFarmCheckLoop({ externalScheduler: true });
    networkEvents.emit('landsChanged', [{ id: 15 }]);
    await wait(400);
    assert.ok(logs.some(l => l.includes('收到推送')), logs.join('\n'));
    assert.deepEqual(harvestCalls, [], '推送触发的检查也不能直接收');
    assert.ok(logs.some(l => l.includes('留给大号') && l.includes('已等0 分钟')), logs.join('\n'));

    // 9 分钟后再推送：仍不收（服务端成熟时间戳虽是 3 天前，也不能判超时）
    nowSec = NOW0 + 540;
    networkEvents.emit('landsChanged', [{ id: 15 }]);
    await wait(400);
    assert.deepEqual(harvestCalls, []);

    // 发现可收 10 分钟后：超时兜底收获
    nowSec = NOW0 + 600;
    logs.length = 0;
    networkEvents.emit('landsChanged', [{ id: 15 }]);
    await wait(400);
    assert.deepEqual(harvestCalls, [{ landIds: [15], isAll: true }]);
    assert.ok(logs.some(l => l.includes('超时兜底')), logs.join('\n'));
    scheduler.stopFarmCheckLoop();
    nowSec = NOW0;
});

test('大号偷过后推送触发 → 只逐块收偷过的地；手动「收获」不受限', async () => {
    resetFnosAltAccountRuntime();
    reset([boostedLand(15), boostedLand(16)]);
    interactRecords = [{ actionType: 1, visitorGid: MASTER, serverTimeSec: NOW0 + 5, landId: 16 }];
    nowSec = NOW0 + 10;
    await scheduler.runFarmOperation('all');
    assert.deepEqual(harvestCalls, [{ landIds: [16], isAll: false }]);

    reset([boostedLand(15)]);
    await scheduler.runFarmOperation('harvest', null, true);
    assert.deepEqual(harvestCalls, [{ landIds: [15], isAll: true }]);
    nowSec = NOW0;
});

test('智能有机肥让作物立即成熟后的跟随收获也留给大号', async () => {
    resetFnosAltAccountRuntime();
    const cfg = store.getConfigSnapshot('2');
    store.applyConfigSnapshot({ automation: { ...cfg.automation, fertilizer: 'smart' } }, { persist: false, accountId: '2' });
    reset([growingLand(15)]);
    landsQueue = [[growingLand(15)], [boostedLand(15)]];
    organicResult = 1;
    await scheduler.runFarmOperation('all');
    assert.deepEqual(harvestCalls, []);
    assert.ok(logs.some(l => l.startsWith('小号|留给大号')), logs.join('\n'));
    store.applyConfigSnapshot({ automation: { ...cfg.automation, fertilizer: 'none' } }, { persist: false, accountId: '2' });
});

test('奶茶自动雇佣从真实 store 读到运行中保存的配置并雇佣（老配置小号迁移：优先大号 24 小时）', async () => {
    tea.resetFnosMilkTeaAutoHireRuntime();
    logs.length = 0;
    const hires = [];
    const friend = (gid, extra = {}) => ({ friend: { gid: String(gid), name: `F${gid}` }, is_robot: false, talent_id: 9001, state: 0, rehire_available_at: '0', ...extra });
    const mt = {
        getMilkTeaActivity: async (_p, input) => ({
            active: true, settling: false, serverTime: NOW0, settleStartTime: NOW0 + 200000, summary: { shop_open_at: '1' },
            shop: { level: 1, slots: [] }, balances: { 1041: 1000 },
            hire: { duration_id: input.durationId, wage_total: input.durationId === 3 ? '270' : '40', friends: [friend(MASTER), friend(5)] },
        }),
        operateMilkTeaActivity: async (action, input) => { hires.push({ action, ...input }); return {}; },
    };
    assert.equal(await tea.runMilkTeaAutoHireTick({ milkTea: mt, force: true }), 1);
    assert.deepEqual(hires, [{ action: 'hire', durationId: 3, targetGid: String(MASTER), expectedCosts: [{ id: 1041, count: 270 }] }]);
    assert.ok(logs.some(l => l.startsWith('奶茶雇佣|已雇佣')), logs.join('\n'));
});

test('奶茶设置运行中变化 → 几秒后检查一次；tick 出错会写日志而不是静默', async () => {
    const tasks = [];
    const fakeScheduler = {
        setTimeoutTask: (name, ms, fn) => tasks.push({ name, ms, fn }),
        setIntervalTask: (name, ms, fn) => tasks.push({ name, ms, fn, interval: true }),
    };
    logs.length = 0;
    tea.startFnosMilkTeaAutoHire(fakeScheduler, async (_n, fn) => fn());
    assert.ok(logs.some(l => l.startsWith('小号|账号已登录：小号模式已启用')), logs.join('\n'));
    assert.ok(logs.some(l => l.startsWith('奶茶雇佣|账号已登录：奶茶自动雇佣已启用（优先雇佣人 Maksim(1280585737) 24 小时，否则随机雇其他好友 4 小时，沿用旧版小号设置')), logs.join('\n'));
    tasks.length = 0;
    logs.length = 0;
    workerApply({ fnosMilkTeaAutoHire: { enabled: true, durationId: 1, talentId: 9002, allowRobots: false } });
    assert.ok(tasks.some(t => t.name === 'fnos_milk_tea_auto_hire_first' && t.ms <= 10000), JSON.stringify(tasks));
    assert.ok(logs.some(l => l.startsWith('奶茶雇佣|设置已更新：奶茶自动雇佣已启用')), logs.join('\n'));
    // 不相关的设置保存不会重复触发
    tasks.length = 0;
    workerApply({ stealDelaySeconds: 3 });
    assert.equal(tasks.length, 0);

    // tick 抛错时写警告
    const tick = (() => { tea.startFnosMilkTeaAutoHire(fakeScheduler, async () => { throw new Error('boom'); }); return tasks.find(t => t.interval).fn; })();
    logs.length = 0;
    await tick();
    assert.ok(logs.some(l => l.includes('WARN') && l.includes('boom')), logs.join('\n'));
});
