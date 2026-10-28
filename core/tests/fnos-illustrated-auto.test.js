// [fnos-fork] 2026-10-28：图鉴奖励自动领取、自动完成图鉴（买未收藏作物的种子并优先播种）。
// 真实 store、真实 services/fnos-illustrated-auto 与 farm/planting.ts（autoPlantEmptyLands 挂钩），只 mock 网络、背包、土地/商店 RPC。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-illustrated-auto-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '7';

const dist = rel => require.resolve(path.join('..', 'dist', rel));
const mock = (rel, exports) => { const id = dist(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };

const gameConfig = require('../dist/config/gameConfig');
const singles = gameConfig.getAllSeeds().filter(s => Number(gameConfig.getPlantBySeedId(s.seedId)?.size || 1) === 1);
const [A, B, C, D] = singles.slice(0, 4).map(s => ({ seedId: s.seedId, plantId: gameConfig.getPlantBySeedId(s.seedId).id, name: gameConfig.getPlantBySeedId(s.seedId).name }));

const logs = [];
const calls = [];
const st = {};
function reset() {
    st.user = { gold: 1000, level: 50 };
    st.bag = [];
    st.lands = [];
    st.book = [];
    st.shop = [];
    logs.length = 0;
    calls.length = 0;
}
reset();

const realUtils = require('../dist/utils/utils');
mock('utils/utils', { ...realUtils, log: (tag, msg) => logs.push(`${tag}|${msg}`), logWarn: (tag, msg) => logs.push(`${tag}|WARN|${msg}`) });
mock('utils/network', {
    getUserState: () => st.user,
    getWsErrorState: () => ({}),
    sendMsgAsync: async (service, method, body) => { calls.push(method); return { body }; },
});
mock('utils/proto', { types: { PlantReply: { decode: () => ({ land: [{ id: st.lastPlant.landId, plant: { id: st.lastPlant.plantId, phases: [{ phase: 1 }] } }] }) } } });
mock('services/warehouse', {
    getBag: async () => ({ items: st.bag }),
    getBagItems: b => b.items,
    isItemLocked: v => !!v.locked,
    getBagSeeds: async () => st.bag.filter(v => !v.locked && gameConfig.getPlantBySeedId(v.id)).map(v => ({ seedId: v.id, name: gameConfig.getPlantBySeedId(v.id).name, count: v.count, plantSize: 1 })),
});
mock('services/farm/api', {
    getAllLands: async () => ({ lands: st.lands }),
    getShopInfo: async () => ({ goods_list: [] }),
    buyGoods: async () => { throw new Error('不应走商店购买'); },
    removePlant: async () => ({}),
    fertilizeOne: async () => ({}),
    fertilize: async () => 0,
    fertilizeOrganicLoop: async () => 0,
});
mock('services/career', { getCareerInfoOrNull: async () => null });
mock('services/analytics', { getPlantRankings: () => [] });
mock('services/stats', { recordOperation: () => {} });

const store = require('../dist/models/store');
const auto = require('../dist/services/fnos-illustrated-auto');
const planting = require('../dist/services/farm/planting');
const { onWorkerConfigApplied } = require('../dist/services/fnos-fork-config');

// 原 plantSeeds 走真实实现（经 mock 网络）；记录 Plant 的种子与地块
const realPlantSeeds = planting.plantSeeds;
const plantingProxy = {
    ...planting,
    plantSeeds: async (seedId, landIds, opts) => {
        const plant = gameConfig.getPlantBySeedId(seedId);
        st.lastPlant = { landId: opts.layouts[0].anchorLandId, plantId: plant.id };
        calls.push(`plant:${seedId}@${st.lastPlant.landId}`);
        return realPlantSeeds(seedId, landIds, opts);
    },
    getAvailableSeeds: async () => st.shop,
    purchaseSeed: async (goodsId, count) => {
        const s = st.shop.find(v => v.goodsId === goodsId);
        calls.push(`buy:${s.seedId}x${count}`);
        st.user.gold -= s.price;
        st.bag.push({ id: s.seedId, count: 1 });
        return { get_items: [{ id: s.seedId, count: 1 }], cost_items: [{ id: 1001, count: s.price }] };
    },
};
const illustratedMock = {
    getIllustratedList: async () => ({ list: st.book }),
    getIllustratedLevels: async type => ({ level_list: st.levels?.[type] || [] }),
    claimIllustratedRewards: async (type) => { calls.push(`claim:${type}`); st.levels[type] = []; return { rewards: [{ itemId: 1001, name: '金币', count: 500 }], claimedLevels: [2] }; },
};
const deps = { illustrated: illustratedMock, planting: plantingProxy, farmApi: require('../dist/services/farm/api'), warehouse: require('../dist/services/warehouse'), getUserState: () => st.user };

function workerApply(snapshot) {
    store.applyConfigSnapshot(snapshot, { persist: false, accountId: process.env.FARM_ACCOUNT_ID });
    onWorkerConfigApplied();
}
const shopItem = (s, extra = {}) => ({ seedId: s.seedId, goodsId: 100 + s.seedId, name: s.name, price: 10, itemCount: 1, requiredLevel: 1, locked: false, soldOut: false, requiresUnlockCard: false, ...extra });

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('normalize：默认关闭；真实 store 默认关闭', () => {
    assert.deepEqual(auto.normalizeFnosIllustratedAuto(undefined), { autoClaimRewards: false, autoComplete: false });
    assert.deepEqual(auto.normalizeFnosIllustratedAuto({ autoComplete: 1 }, { autoClaimRewards: true, autoComplete: false }), { autoClaimRewards: true, autoComplete: true });
    assert.deepEqual(store.getConfigSnapshot('7').fnosIllustratedAuto, { autoClaimRewards: false, autoComplete: false });
});

test('未开启：不发请求；播种挂钩原样返回', async () => {
    reset();
    const r = await auto.runIllustratedAutoTick({ deps });
    assert.deepEqual(r, { claimed: 0, bought: false });
    const p = await auto.plantFnosIllustratedSeeds([1, 2], { deps });
    assert.deepEqual(p.remainingLandIds, [1, 2]);
    assert.equal(calls.length, 0);
});

test('图鉴奖励：只领有 can_claim 的图鉴类型', async () => {
    reset();
    workerApply({ fnosIllustratedAuto: { autoClaimRewards: true, autoComplete: false } });
    st.levels = { 1: [{ level: 2, can_claim: true, claimed: false }], 2: [{ level: 1, can_claim: true, claimed: true }] };
    const r = await auto.runIllustratedAutoTick({ deps });
    assert.equal(r.claimed, 1);
    assert.deepEqual(calls, ['claim:1']);
    assert.ok(logs.includes('图鉴|作物图鉴奖励已领取（等级 2）：金币×500'), logs.join('\n'));
    calls.length = 0;
    await auto.runIllustratedAutoTick({ deps });
    assert.equal(calls.length, 0);
});

test('自动完成图鉴：跳过已收藏/背包有/地里有/不可买，买 1 个最便宜可买的；不重复购买', async () => {
    reset();
    auto.resetFnosIllustratedRuntime({ clearPending: true });
    workerApply({ fnosIllustratedAuto: { autoClaimRewards: false, autoComplete: true } });
    st.book = [A, B, C, D].map((s, i) => ({ fruit_id: s.seedId, unlocked: i === 0 }));
    st.bag = [{ id: B.seedId, count: 1, locked: true }]; // B 背包有（锁定也算有）
    st.lands = [{ id: 1, plant: { id: C.plantId, phases: [{ phase: 2 }] } }]; // C 正在地里
    st.shop = [shopItem(A), shopItem(B), shopItem(C), shopItem(D, { price: 30 })];
    let r = await auto.runIllustratedAutoTick({ deps });
    assert.equal(r.bought, true);
    assert.deepEqual(calls, [`buy:${D.seedId}x1`]);
    assert.deepEqual(auto.getPendingSeedIds(), [D.seedId]);
    assert.ok(logs.some(l => l.startsWith(`图鉴|自动完成图鉴：${D.name} 未收藏，已买种子 ×1（30 金币）`)), logs.join('\n'));
    // 再检查：D 已在背包 → 不再买
    calls.length = 0;
    r = await auto.runIllustratedAutoTick({ deps });
    assert.equal(r.bought, false);
    assert.equal(calls.length, 0);
    assert.ok(logs.some(l => l.includes('未收藏的作物都已在背包或地里')), logs.join('\n'));
    // 待种记录持久化：重新加载后仍在
    auto.resetFnosIllustratedRuntime();
    assert.deepEqual(auto.getPendingSeedIds(), [D.seedId]);
    assert.ok(fs.existsSync(path.join(DATA_DIR, 'fnos-illustrated', '7.json')));
});

test('不可买：未解锁/需要解锁卡/售罄/等级不够/金币不够 都不买', async () => {
    reset();
    auto.resetFnosIllustratedRuntime({ clearPending: true });
    workerApply({ fnosIllustratedAuto: { autoClaimRewards: false, autoComplete: true } });
    st.book = [A, B, C, D].map(s => ({ fruit_id: s.seedId, unlocked: false }));
    st.user.gold = 5;
    st.shop = [shopItem(A, { locked: true }), shopItem(B, { requiresUnlockCard: true }), shopItem(C, { soldOut: true }), shopItem(D, { requiredLevel: 99 })];
    await auto.runIllustratedAutoTick({ deps });
    st.shop = [shopItem(A)];
    await auto.runIllustratedAutoTick({ deps });
    assert.equal(calls.length, 0);
    assert.ok(logs.some(l => l.includes('商店里都不能买')), logs.join('\n'));
    assert.ok(logs.some(l => l.includes('金币不足')), logs.join('\n'));
});

test('播种挂钩（真实 autoPlantEmptyLands）：待种种子先种 1 块，种下后取消优先、剩余空地交原策略', async () => {
    reset();
    auto.resetFnosIllustratedRuntime({ clearPending: true });
    workerApply({ fnosIllustratedAuto: { autoClaimRewards: false, autoComplete: true } });
    st.book = [{ fruit_id: D.seedId, unlocked: false }];
    st.shop = [shopItem(D)];
    await auto.runIllustratedAutoTick({ deps }); // 买 D
    assert.deepEqual(auto.getPendingSeedIds(), [D.seedId]);
    calls.length = 0;
    const res = await auto.plantFnosIllustratedSeeds([5, 6], { deps: { planting: plantingProxy } });
    assert.deepEqual(res.plantedLandIds, [5]);
    assert.deepEqual(res.remainingLandIds, [6]);
    assert.deepEqual(auto.getPendingSeedIds(), []);
    assert.ok(calls.includes(`plant:${D.seedId}@5`) && calls.includes('Plant'), calls.join(','));
    assert.ok(logs.some(l => l.startsWith(`图鉴|自动完成图鉴：已优先种下 ${D.name}（土地 5）`)), logs.join('\n'));

    // 真实 autoPlantEmptyLands：再买一个 C，1 块空地 → 只种 C，不走商店购买
    st.bag = [];
    st.book = [{ fruit_id: C.seedId, unlocked: false }];
    st.shop = [shopItem(C)];
    await auto.runIllustratedAutoTick({ deps });
    calls.length = 0;
    st.lastPlant = { landId: 9, plantId: C.plantId };
    const out = await planting.autoPlantEmptyLands([], [9], { knownLands: [] });
    assert.deepEqual(out.plantedLands, [9]);
    assert.deepEqual(calls.filter(c => c === 'Plant'), ['Plant']);
    assert.deepEqual(auto.getPendingSeedIds(), []);
});

test('待种清理：已收藏 → 移除；同一种子最多买 3 次', async () => {
    reset();
    auto.resetFnosIllustratedRuntime({ clearPending: true });
    workerApply({ fnosIllustratedAuto: { autoClaimRewards: false, autoComplete: true } });
    st.book = [{ fruit_id: A.seedId, unlocked: false }];
    st.shop = [shopItem(A)];
    for (let i = 0; i < 5; i++) {
        await auto.runIllustratedAutoTick({ deps });
        st.bag = []; // 模拟种掉了但没进图鉴
    }
    assert.equal(calls.filter(c => c.startsWith('buy:')).length, 3);
    assert.ok(logs.some(l => l.includes('已达自动购买次数上限')), logs.join('\n'));
    st.bag = [{ id: A.seedId, count: 1 }];
    st.book = [{ fruit_id: A.seedId, unlocked: true }];
    await auto.runIllustratedAutoTick({ deps });
    assert.deepEqual(auto.getPendingSeedIds(), []);
});

test('pickSeedToBuy 纯函数：全部已收藏', () => {
    const r = auto.pickSeedToBuy({ uncollectedSeedIds: [], bagSeedIds: new Set(), landSeedIds: new Set(), pendingSeedIds: new Set(), attempts: {}, shopSeeds: [], gold: 0, level: 1 });
    assert.equal(r.kind, 'complete');
});

test('持久化：账号配置文件读回', () => {
    store.applyConfigSnapshot({ fnosIllustratedAuto: { autoClaimRewards: true, autoComplete: false } }, { accountId: '8' });
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, ['-e', `const s=require(${JSON.stringify(path.join(__dirname, '../dist/models/store'))});console.log(JSON.stringify([s.getConfigSnapshot('8').fnosIllustratedAuto, s.getConfigSnapshot('9').fnosIllustratedAuto]))`], { env: { ...process.env, QQ_FARM_DATA_DIR: DATA_DIR } }).toString().trim().split('\n').pop();
    assert.deepEqual(JSON.parse(out), [{ autoClaimRewards: true, autoComplete: false }, { autoClaimRewards: false, autoComplete: false }]);
});
