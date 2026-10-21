// [fnos-fork] 大号/小号：判定逻辑、协议字段解析、配置持久化与自动巡田挂钩测试
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

const dist = rel => require.resolve(path.join('..', 'dist', rel));

// ---------- 自动巡田挂钩需要的 mock（必须在 require scheduler 之前） ----------
const harvestCalls = [];
let currentLands = [];
let interactRecords = [];
let interactCalls = 0;
let altConfig = { enabled: false, masterGid: 0, masterName: '', timeoutMinutes: 0 };
const logs = [];

require.cache[dist('services/farm/api')] = {
    exports: {
        getAllLands: async () => ({ lands: currentLands }),
        harvest: async (landIds, options = {}) => {
            harvestCalls.push({ landIds: [...landIds], isAll: options.isAll !== false });
            return { land: [] };
        },
        farming: async () => ({}),
        unlockLand: async () => ({}),
        upgradeLand: async () => ({}),
    },
};
require.cache[dist('services/interact')] = {
    exports: {
        getInteractRecords: async () => { interactCalls++; return interactRecords; },
    },
};
require.cache[dist('models/store')] = {
    exports: {
        isAutomationOn: key => key === 'farm' || key === 'skip_own_weed_bug',
        getAutomation: () => ({ fertilizer: 'none', fertilizer_land_types: [] }),
        getConfigSnapshot: () => ({ fnosAltAccount: altConfig }),
        getFertilizerBuyOrganicCount: () => 0,
        getFertilizerBuyOrganicThresholdHours: () => 0,
        getFertilizerBuyNormalCount: () => 0,
        getFertilizerBuyNormalThresholdHours: () => 0,
        getFertilizerBuyCheckIntervalMinutes: () => 60,
    },
};
const { EventEmitter } = require('node:events');
require.cache[dist('utils/network')] = {
    exports: { getUserState: () => ({ gid: 1001 }), networkEvents: new EventEmitter() },
};
require.cache[dist('services/farm/planting')] = {
    exports: { autoPlantEmptyLands: async () => ({ plantedLands: [] }), runFertilizerByConfig: async () => ({ normal: 0, organic: 0 }) },
};
require.cache[dist('services/mall')] = { exports: { checkAndBuyFertilizerBoth: async () => {} } };
require.cache[dist('services/stats')] = { exports: { recordOperation: () => {} } };
const realUtils = require('../dist/utils/utils');
require.cache[dist('utils/utils')] = {
    exports: {
        ...realUtils,
        randomDelay: async () => {},
        log: (tag, msg) => logs.push(`${tag}|${msg}`),
        logWarn: (tag, msg) => logs.push(`${tag}|WARN|${msg}`),
    },
};

const {
    normalizeFnosAltAccount,
    decodeStealerGids,
    getMatureBeginSec,
    decideAltHarvest,
    resetFnosAltAccountRuntime,
} = require('../dist/services/farm/fnos-alt-account');
const { runFarmOperation } = require('../dist/services/farm/scheduler');

const MASTER = 4300123456;
const OTHER = 4300999999;
const RADISH_ID = 2020002;
const NOW = Math.floor(Date.now() / 1000);

function varint(n) {
    const out = [];
    let v = n;
    while (v >= 128) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
    out.push(v);
    return out;
}
function packed(...nums) { return Buffer.from(nums.flatMap(varint)); }

function matureLand(id, extra = {}) {
    return {
        id,
        unlocked: true,
        plant: {
            id: RADISH_ID,
            fruit_id: 40002,
            name: '白萝卜',
            season: 1,
            // 服务端只下发剩余阶段，phases[0] 即当前阶段（见 land-analysis.getCurrentPhase）
            phases: [
                { phase: 6, begin_time: NOW - 600 },
            ],
            ...extra,
        },
    };
}

// ---------- 配置规范化 ----------
test('normalizeFnosAltAccount: 默认关闭、清理非法值', () => {
    assert.deepEqual(normalizeFnosAltAccount(undefined), { enabled: false, masterGid: 0, masterName: '', holdForMaster: true, timeoutMinutes: 0, skipStealMaster: false, badOnlyMaster: false });
    assert.deepEqual(
        normalizeFnosAltAccount({ enabled: 1, masterGid: String(MASTER), masterName: '  大号  ', timeoutMinutes: '30' }),
        { enabled: true, masterGid: MASTER, masterName: '大号', holdForMaster: true, timeoutMinutes: 30, skipStealMaster: false, badOnlyMaster: false },
    );
    const bad = normalizeFnosAltAccount({ enabled: true, masterGid: -5, masterName: 'x', timeoutMinutes: -1 });
    assert.equal(bad.masterGid, 0);
    assert.equal(bad.masterName, '');
    assert.equal(bad.timeoutMinutes, 0);
    assert.equal(normalizeFnosAltAccount({ timeoutMinutes: 999999 }).timeoutMinutes, 7 * 24 * 60);
    // 局部更新保留原值
    const prev = { enabled: true, masterGid: MASTER, masterName: 'A', holdForMaster: true, timeoutMinutes: 5, skipStealMaster: true, badOnlyMaster: false };
    assert.deepEqual(normalizeFnosAltAccount({ timeoutMinutes: 10 }, prev), { ...prev, timeoutMinutes: 10 });
});

// ---------- 协议字段解析 ----------
test('decodeStealerGids: packed varint、旧版 StealPlayer、空值', () => {
    assert.deepEqual(decodeStealerGids(packed(MASTER, OTHER)).sort(), [MASTER, OTHER].sort());
    // StealPlayer { gid=1, num=2 }
    const sp = Buffer.from([0x08, ...varint(MASTER), 0x10, 0x01]);
    assert.ok(decodeStealerGids(sp).includes(MASTER));
    assert.deepEqual(decodeStealerGids(null), []);
    assert.deepEqual(decodeStealerGids(Buffer.alloc(0)), []);
    assert.deepEqual(decodeStealerGids([{ gid: MASTER, num: 1 }]), [MASTER]);
    // 截断的 varint 不应抛异常
    assert.doesNotThrow(() => decodeStealerGids(Buffer.from([0xFF, 0xFF])));
});

test('用上游 plantpb.proto 解码：stealers(bytes) 能取出 repeated int64 编码的 GID', () => {
    const protoDir = path.join(__dirname, '..', 'src', 'proto');
    const root = new protobuf.Root();
    root.resolvePath = (_origin, target) => path.join(protoDir, path.basename(target));
    root.loadSync(path.join(protoDir, 'plantpb.proto'), { keepCase: true });
    const PlantInfo = root.lookupType('gamepb.plantpb.PlantInfo');
    // 参照其他项目的定义 `repeated int64 stealers = 14`（proto3 默认 packed）手工构造服务端报文：
    // field 1 (id) varint、field 9 (stole_num) varint、field 14 LEN + packed varint GID 列表
    const packedGids = packed(MASTER, OTHER);
    const wire = Buffer.from([
        0x08, ...varint(RADISH_ID),
        0x48, 0x02,
        0x72, ...varint(packedGids.length), ...packedGids,
    ]);
    const decoded = PlantInfo.decode(wire);
    assert.ok(decoded.stealers instanceof Uint8Array);
    assert.equal(Number(decoded.stole_num), 2);
    assert.deepEqual(decodeStealerGids(decoded.stealers).sort(), [MASTER, OTHER].sort());
});

test('getMatureBeginSec: 取已开始的成熟阶段，忽略未来阶段', () => {
    assert.equal(getMatureBeginSec(matureLand(1).plant, NOW), NOW - 600);
    const plant = { phases: [{ phase: 6, begin_time: NOW - 100 }, { phase: 6, begin_time: NOW + 3600 }] };
    assert.equal(getMatureBeginSec(plant, NOW), NOW - 100);
    assert.equal(getMatureBeginSec({ phases: [{ phase: 3, begin_time: (NOW - 50) * 1000 }] }, NOW), NOW - 50);
});

// ---------- 判定 ----------
const CFG = { enabled: true, masterGid: MASTER, masterName: '大号', timeoutMinutes: 0 };

test('decideAltHarvest: 未开启或未选大号时全部照常收获', () => {
    const lands = [matureLand(1)];
    for (const config of [{ ...CFG, enabled: false }, { ...CFG, masterGid: 0 }]) {
        const [d] = decideAltHarvest({ lands, harvestableIds: [1], config, records: [], nowSec: NOW });
        assert.equal(d.harvest, true);
        assert.equal(d.reason, 'not_configured');
    }
});

test('decideAltHarvest: 土地偷菜者里有大号 → 收；只有别人 → 等', () => {
    const lands = [matureLand(1, { stealers: packed(MASTER) }), matureLand(2, { stealers: packed(OTHER) }), matureLand(3)];
    const ds = decideAltHarvest({ lands, harvestableIds: [1, 2, 3], config: CFG, records: [], nowSec: NOW });
    assert.deepEqual(ds.map(d => [d.landId, d.harvest, d.reason]), [
        [1, true, 'stolen_by_master'],
        [2, false, 'waiting'],
        [3, false, 'waiting'],
    ]);
});

test('decideAltHarvest: 访客记录按地块/作物/时间匹配大号偷菜', () => {
    const lands = [matureLand(1), matureLand(2), { ...matureLand(3), plant: { ...matureLand(3).plant, id: 9999, fruit_id: 8888 } }];
    const records = [
        { actionType: 1, visitorGid: MASTER, serverTimeSec: NOW - 60, landId: 1, cropId: RADISH_ID },
        { actionType: 1, visitorGid: OTHER, serverTimeSec: NOW - 30, landId: 2, cropId: RADISH_ID },
        { actionType: 2, visitorGid: MASTER, serverTimeSec: NOW - 30, landId: 2 }, // 帮忙不算
        { actionType: 1, visitorGid: MASTER, serverTimeSec: NOW - 86400, landId: 2 }, // 上一季的偷菜不算
    ];
    let ds = decideAltHarvest({ lands, harvestableIds: [1, 2, 3], config: CFG, records, nowSec: NOW });
    assert.deepEqual(ds.map(d => d.harvest), [true, false, false]);

    // 记录没有地块号时按作物（植物 ID 或果实 ID）匹配
    ds = decideAltHarvest({
        lands,
        harvestableIds: [1, 2, 3],
        config: CFG,
        records: [{ actionType: 1, visitorGid: MASTER, serverTimeSec: NOW - 10, landId: 0, cropId: 40002 }],
        nowSec: NOW,
    });
    assert.deepEqual(ds.map(d => d.harvest), [true, true, false]);
});

test('decideAltHarvest: 超时兜底从「首次发现可收」算起（0 = 一直等），不看服务端成熟时间', () => {
    // 服务端成熟时间戳是 3 天前（催熟等情况可能出现），但本进程刚发现可收：不能直接判超时
    const lands = [{ ...matureLand(1), plant: { ...matureLand(1).plant, phases: [{ phase: 6, begin_time: NOW - 86400 * 3 }] } }];
    const seen = new Map([[1, NOW]]);
    let [d] = decideAltHarvest({ lands, harvestableIds: [1], config: { ...CFG, timeoutMinutes: 10 }, records: [], nowSec: NOW, firstSeenSecByLand: seen });
    assert.equal(d.harvest, false);
    assert.equal(d.waitedSec, 0);
    // 没传首次发现时间时同样视为刚发现
    [d] = decideAltHarvest({ lands, harvestableIds: [1], config: { ...CFG, timeoutMinutes: 10 }, records: [], nowSec: NOW });
    assert.equal(d.harvest, false);
    // 发现后 9 分钟：还不到
    [d] = decideAltHarvest({ lands, harvestableIds: [1], config: { ...CFG, timeoutMinutes: 10 }, records: [], nowSec: NOW + 540, firstSeenSecByLand: seen });
    assert.equal(d.harvest, false);
    // 发现后 10 分钟：超时兜底
    [d] = decideAltHarvest({ lands, harvestableIds: [1], config: { ...CFG, timeoutMinutes: 10 }, records: [], nowSec: NOW + 600, firstSeenSecByLand: seen });
    assert.equal(d.harvest, true);
    assert.equal(d.reason, 'timeout');
    // 0 = 一直等
    [d] = decideAltHarvest({ lands, harvestableIds: [1], config: { ...CFG, timeoutMinutes: 0 }, records: [], nowSec: NOW + 86400 * 3, firstSeenSecByLand: seen });
    assert.equal(d.harvest, false);
});

test('decideAltHarvest: [fnos-fork] holdForMaster 关 → 全部正常收（含超时设置）；开 / 缺省 → 等大号', () => {
    const lands = [matureLand(1), matureLand(2, { stealers: packed(OTHER) })];
    let ds = decideAltHarvest({ lands, harvestableIds: [1, 2], config: { ...CFG, holdForMaster: false, timeoutMinutes: 10 }, records: [], nowSec: NOW });
    assert.deepEqual(ds.map(d => [d.landId, d.harvest, d.reason]), [[1, true, 'hold_disabled'], [2, true, 'hold_disabled']]);
    for (const config of [{ ...CFG, holdForMaster: true }, CFG]) {
        ds = decideAltHarvest({ lands, harvestableIds: [1, 2], config, records: [], nowSec: NOW });
        assert.deepEqual(ds.map(d => d.reason), ['waiting', 'waiting']);
    }
});

test('decideAltHarvest: 取不到成熟时间时，大号很早以前在这块地的偷菜记录不算', () => {
    const lands = [{ ...matureLand(1), plant: { ...matureLand(1).plant, phases: [] } }];
    const seen = new Map([[1, NOW]]);
    const old = [{ actionType: 1, visitorGid: MASTER, serverTimeSec: NOW - 86400, landId: 1 }];
    let [d] = decideAltHarvest({ lands, harvestableIds: [1], config: CFG, records: old, nowSec: NOW, firstSeenSecByLand: seen });
    assert.equal(d.harvest, false);
    const fresh = [{ actionType: 1, visitorGid: MASTER, serverTimeSec: NOW + 30, landId: 1 }];
    [d] = decideAltHarvest({ lands, harvestableIds: [1], config: CFG, records: fresh, nowSec: NOW + 60, firstSeenSecByLand: seen });
    assert.equal(d.harvest, true);
});

// ---------- 自动巡田挂钩 ----------
function resetRun(config, lands, records = []) {
    altConfig = config;
    currentLands = lands;
    interactRecords = records;
    interactCalls = 0;
    harvestCalls.length = 0;
    logs.length = 0;
    resetFnosAltAccountRuntime();
}

test('runFarmOperation: 非小号账号一次性全部收获（is_all=true，行为不变）', async () => {
    resetRun({ enabled: false, masterGid: 0, masterName: '', timeoutMinutes: 0 }, [matureLand(1), matureLand(2)]);
    await runFarmOperation('all');
    assert.deepEqual(harvestCalls, [{ landIds: [1, 2], isAll: true }]);
    assert.equal(interactCalls, 0);
});

test('runFarmOperation: 小号自动巡田只逐块收大号偷过的地（is_all=false），其余留着并写日志', async () => {
    resetRun(CFG, [matureLand(1, { stealers: packed(MASTER) }), matureLand(2), matureLand(3)], [
        { actionType: 1, visitorGid: MASTER, serverTimeSec: NOW + 1e9, landId: 3 },
    ]);
    await runFarmOperation('all');
    assert.deepEqual(harvestCalls, [{ landIds: [1], isAll: false }, { landIds: [3], isAll: false }]);
    assert.equal(interactCalls, 1);
    assert.ok(logs.some(l => l.startsWith('小号|') && l.includes('暂不收获 1 块') && l.includes('#2')), logs.join('\n'));
});

test('runFarmOperation: 小号全部未被偷时不发收获请求', async () => {
    resetRun(CFG, [matureLand(1), matureLand(2)]);
    await runFarmOperation('all');
    assert.deepEqual(harvestCalls, []);
});

test('runFarmOperation: 大号把所有成熟地都偷过时照常一次收获', async () => {
    resetRun(CFG, [matureLand(1, { stealers: packed(MASTER) }), matureLand(2, { stealers: packed(OTHER, MASTER) })]);
    await runFarmOperation('all');
    assert.deepEqual(harvestCalls, [{ landIds: [1, 2], isAll: true }]);
    assert.equal(interactCalls, 0, '土地数据已足够判定时不再请求访客记录');
});

test('runFarmOperation: 手动「收获」「一键全收」不受小号限制', async () => {
    resetRun(CFG, [matureLand(1), matureLand(2)]);
    await runFarmOperation('harvest', null, true);
    await runFarmOperation('all', null, true);
    assert.deepEqual(harvestCalls, [{ landIds: [1, 2], isAll: true }, { landIds: [1, 2], isAll: true }]);
});

test('runFarmOperation: 访客记录读取失败时保守不收，并在日志里说明', async () => {
    resetRun(CFG, [matureLand(1)]);
    require.cache[dist('services/interact')].exports.getInteractRecords = async () => { throw new Error('timeout'); };
    try {
        await runFarmOperation('all');
    } finally {
        require.cache[dist('services/interact')].exports.getInteractRecords = async () => { interactCalls++; return interactRecords; };
    }
    assert.deepEqual(harvestCalls, []);
    assert.ok(logs.some(l => l.includes('访客记录读取失败')));
});

test('runFarmOperation: [fnos-fork] 小号关闭「成熟作物先留给大号偷」→ 像普通账号一样一次全收（is_all=true），不读访客记录、不写留菜日志', async () => {
    resetRun({ ...CFG, holdForMaster: false, timeoutMinutes: 30, skipStealMaster: true }, [matureLand(1), matureLand(2)]);
    await runFarmOperation('all');
    assert.deepEqual(harvestCalls, [{ landIds: [1, 2], isAll: true }]);
    assert.equal(interactCalls, 0);
    assert.ok(!logs.some(l => l.includes('留给大号')), logs.join('\n'));
});

test('runFarmOperation: [fnos-fork] holdForMaster 显式打开 / 缺省（旧配置）→ 都留给大号', async () => {
    for (const config of [{ ...CFG, holdForMaster: true }, CFG]) {
        resetRun(config, [matureLand(1, { stealers: packed(MASTER) }), matureLand(2)]);
        await runFarmOperation('all');
        assert.deepEqual(harvestCalls, [{ landIds: [1], isAll: false }]);
        assert.ok(logs.some(l => l.includes('暂不收获 1 块')), logs.join('\n'));
    }
});
