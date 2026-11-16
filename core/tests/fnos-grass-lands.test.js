// [fnos-fork] 2026-11-16 农场「最后 X 块地只种牧草」：选地、背包够/不够、自动补买、关闭补买时留空；播种挂钩接入。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-grass-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '7';
const dist = rel => require.resolve(path.join('..', 'dist', rel));
const mock = (rel, exports) => { const id = dist(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const logs = [];
const realUtils = require('../dist/utils/utils');
mock('utils/utils', { ...realUtils, log: (tag, msg) => logs.push(`${tag}|${msg}`), logWarn: (tag, msg) => logs.push(`${tag}|WARN|${msg}`) });

const grass = require('../dist/services/farm/fnos-grass-lands');
const gameConfig = require('../dist/config/gameConfig');
test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('游戏配置：牧草种子 20040 → 作物 1020040，收获牧草 7001', () => {
    const plant = gameConfig.getPlantBySeedId(grass.GRASS_SEED_ID);
    assert.equal(plant.id, 1020040);
    assert.equal(plant.name, '牧草');
    assert.equal(plant.fruit.id, 7001);
    const goods = require('../dist/gameConfig/Goods.json').find(g => g.id === grass.GRASS_GOODS_ID);
    assert.equal(goods.item_id, 20040);
    assert.equal(goods.shop_id, 4);
});

test('normalize 与 pickGrassLandIds：按编号取最后 X 块已解锁地', () => {
    assert.deepEqual(grass.normalizeFnosGrassLands(undefined), { count: 0, autoBuy: true });
    assert.deepEqual(grass.normalizeFnosGrassLands({ count: 99, autoBuy: 0 }), { count: 24, autoBuy: false });
    const lands = [5, 1, 3, 2, 4, 6].map(id => ({ id, unlocked: id !== 6 }));
    assert.deepEqual(grass.pickGrassLandIds(lands, 2), [4, 5]);
    assert.deepEqual(grass.pickGrassLandIds(lands, 0), []);
    assert.deepEqual(grass.pickGrassLandIds(lands, 10), [1, 2, 3, 4, 5]);
});

function makeDeps(st) {
    return {
        farmApi: {
            getAllLands: async () => ({ lands: st.lands }),
            getShopInfo: async id => { st.calls.push(`shop:${id}`); return { goods_list: [{ id: 2129, item_id: 20040, price: 20, unlocked: true }] }; },
            buyGoods: async (id, n, price) => { st.calls.push(`buy:${id}x${n}@${price}`); st.bag += n; return { get_items: [{ id: 20040, count: n }], cost_items: [{ id: 1001, count: n * price }] }; },
        },
        warehouse: { getBagSeeds: async () => (st.bag > 0 ? [{ seedId: 20040, count: st.bag }] : []) },
        planting: { plantSeeds: async (seedId, ids) => { st.calls.push(`plant:${seedId}:${ids.join(',')}`); return { planted: ids.length, plantedLandIds: ids, uncertain: false }; } },
        getUserState: () => st.user,
    };
}
const lands = [1, 2, 3, 4, 5, 6].map(id => ({ id, unlocked: true }));

test('关闭（X=0）：原样返回，不发请求', async () => {
    const st = { lands, bag: 0, calls: [], user: { gold: 1000 } };
    const r = await grass.plantFnosGrassLands([1, 6], { deps: makeDeps(st), config: { count: 0, autoBuy: true } });
    assert.deepEqual(r.remainingLandIds, [1, 6]);
    assert.deepEqual(st.calls, []);
});

test('背包够：牧草地只种牧草，其余地交还原逻辑', async () => {
    const st = { lands, bag: 5, calls: [], user: { gold: 0 } };
    const r = await grass.plantFnosGrassLands([1, 2, 5, 6], { lands, deps: makeDeps(st), config: { count: 2, autoBuy: true } });
    assert.deepEqual(r.remainingLandIds, [1, 2]);
    assert.deepEqual(r.plantedLandIds, [5, 6]);
    assert.deepEqual(st.calls, ['plant:20040:5,6']);
});

test('背包不够 + 自动补买：只买差额；关闭补买：差的地留空且不交给原逻辑', async () => {
    let st = { lands, bag: 1, calls: [], user: { gold: 1000 } };
    let r = await grass.plantFnosGrassLands([4, 5, 6], { deps: makeDeps(st), config: { count: 3, autoBuy: true } });
    assert.deepEqual(st.calls, ['shop:4', 'buy:2129x2@20', 'plant:20040:4,5,6']);
    assert.equal(st.user.gold, 960);
    assert.deepEqual(r.remainingLandIds, []);

    st = { lands, bag: 1, calls: [], user: { gold: 1000 } };
    logs.length = 0;
    r = await grass.plantFnosGrassLands([1, 5, 6], { deps: makeDeps(st), config: { count: 2, autoBuy: false } });
    assert.deepEqual(st.calls, ['plant:20040:5']);
    assert.deepEqual(r.remainingLandIds, [1]);
    assert.ok(logs.some(l => l.includes('先空着')), logs.join('\n'));

    st = { lands, bag: 0, calls: [], user: { gold: 10 } };
    r = await grass.plantFnosGrassLands([6], { deps: makeDeps(st), config: { count: 1, autoBuy: true } });
    assert.deepEqual(st.calls, ['shop:4']);
    assert.deepEqual(r.plantedLandIds, []);
    assert.deepEqual(r.remainingLandIds, []);
});

test('播种挂钩：planting.ts 在图鉴优先播种之前调用牧草地', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'farm', 'planting.ts'), 'utf8');
    const g = src.indexOf("require('./fnos-grass-lands').plantFnosGrassLands");
    const i = src.indexOf("require('../fnos-illustrated-auto').plantFnosIllustratedSeeds");
    assert.ok(g > 0 && i > g);
});

test('[2026-11-16] 牧草地不施肥：剔除正在长牧草的地；牧草收获物 7001 标记不出售', () => {
    const lands = [
        { id: 1, unlocked: true, plant: { id: 1020040 } },
        { id: 2, unlocked: true, plant: { id: 1020001 } },
        { id: 3, unlocked: true },
        { id: 4, unlocked: true, plant: { id: 0, seed_id: 20040 } },
    ];
    assert.equal(grass.isGrassLand(lands[0]), true);
    assert.equal(grass.isGrassLand(lands[2]), false);
    assert.deepEqual(grass.excludeGrassLandIds([1, 2, 3, 4], lands), [2, 3]);
    assert.deepEqual(grass.excludeGrassLandIds([1, 2], []), [1, 2]);
    assert.equal(grass.GRASS_FRUIT_ID, gameConfig.getPlantBySeedId(grass.GRASS_SEED_ID).fruit.id);
});
