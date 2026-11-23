// [fnos-fork] 2026-11-23 后台每次拿到农场 / 牧场数据就写概览缓存
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOverviewCache } = require('../dist/runtime/fnos-overview-cache');
const { createOverviewWriter } = require('../dist/runtime/fnos-overview-writer');
const hooks = require('../dist/runtime/fnos-overview-hooks');

function setup(intervalMs = 15000) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-ovw-'));
    let t = 1_000_000;
    const cache = createOverviewCache({ dir, now: () => t });
    const writer = createOverviewWriter({ cache, now: () => t, intervalMs });
    return { cache, writer, dir, advance: (ms) => { t += ms; } };
}
const farmStatus = (gold = 100, extra = {}) => ({
    connection: { connected: true },
    status: { level: 12, gold, coupon: 1, goldBean: 2 },
    levelProgress: { current: 5, needed: 50 },
    operations: { harvest: 3 },
    nextChecks: { farmRemainSec: 60, friendRemainSec: 120, ranchRemainSec: 300 },
    ...extra,
});
const ranchState = (grass = '10') => ({
    unlocked: true, level: 3, currentExp: 1, neededExp: 10, grass, serverTime: 1_000_000,
    currencies: [{ id: 1007, name: '金币', count: '5', image: 'x.png' }], buckets: [],
    facilities: [{ id: '1', moduleType: 6, name: '窝', level: 1, state: 1, capacity: 4, ranch: { count: 1, capacity: 4, animals: [{ canHarvest: true }], shelves: [], hazards: [] } }],
});

test('状态同步写农场快照；牧场没数据时不写牧场', () => {
    const { cache, writer } = setup();
    writer.onStatus('1', farmStatus());
    const c = cache.get('1');
    assert.equal(c.farm.level, 12);
    assert.equal(c.farm.assets[0].value, '100');
    assert.equal(c.ranch, null);
});

test('未连接 / 没等级的状态不写缓存', () => {
    const { cache, writer } = setup();
    writer.onStatus('1', { connection: { connected: false }, status: { level: 5 } });
    writer.onStatus('1', farmStatus(1, { status: { level: 0 } }));
    assert.equal(cache.get('1').farm, null);
});

test('背包、钻石读取后写入农场库存和资产', () => {
    const { cache, writer, advance } = setup(0);
    writer.onStatus('1', farmStatus());
    advance(1000);
    writer.onBag('1', [{ id: 1011, count: 100000, hoursText: '27.7小时' }, { id: 3001, count: 12 }]);
    writer.onDiamond('1', 88);
    const f = cache.get('1').farm;
    assert.equal(f.stock.find(t => t.key === 1011).value, '27.7h');
    assert.equal(f.stock.find(t => t.key === 3001).value, '12');
    assert.equal(f.assets.find(t => t.key === 'diamond').value, '88');
    // 之后只有状态刷新，库存与钻石沿用
    advance(1000);
    writer.onStatus('1', farmStatus(200));
    const g = cache.get('1').farm;
    assert.equal(g.assets[0].value, '200');
    assert.equal(g.assets.find(t => t.key === 'diamond').value, '88');
});

test('牧场数据读取后写牧场快照，今日收益和下次巡查来自状态同步', () => {
    const { cache, writer } = setup();
    writer.onStatus('1', farmStatus(100, { ranchOperations: { harvest: 4 } }));
    writer.onRanchState('1', ranchState());
    const r = cache.get('1').ranch;
    assert.equal(r.level, 3);
    assert.equal(r.todo.find(t => t.key === 'harvest').value, 1);
    assert.equal(r.today.find(t => t.key === 'harvest').count, 4);
    assert.equal(r.nextChecks[0].at, 1_300_000);
});

test('牧场概览带生涯后，普通读取不会把生涯清掉；未解锁不写', () => {
    const { cache, writer, advance } = setup(0);
    writer.onRanchState('1', { ...ranchState(), career: { harvest: 9, mature: 1, steal: 2 } });
    advance(1000);
    writer.onRanchState('1', ranchState('11'));
    assert.equal(cache.get('1').ranch.career.harvest, 9);
    assert.equal(cache.get('2').ranch, null);
    writer.onRanchState('2', { unlocked: false });
    assert.equal(cache.get('2').ranch, null);
});

test('节流：间隔内不重复写，到点后补写最新数据；内容没变不写', () => {
    const { cache, writer, advance } = setup(15000);
    writer.onStatus('1', farmStatus(100));
    const first = cache.get('1').farm.updatedAt;
    advance(5000);
    writer.onStatus('1', farmStatus(150));
    assert.equal(cache.get('1').farm.assets[0].value, '100');
    assert.equal(cache.get('1').farm.updatedAt, first);
    advance(11000);
    writer.onStatus('1', farmStatus(150));
    assert.equal(cache.get('1').farm.assets[0].value, '150');
    const second = cache.get('1').farm.updatedAt;
    advance(20000);
    writer.onStatus('1', farmStatus(150)); // 只有倒计时变化 -> 不写
    assert.equal(cache.get('1').farm.updatedAt, second);
    writer.dispose();
});

test('取数钩子：没有 sink 什么都不做，有 sink 就转发，sink 抛错不外泄', () => {
    hooks.emitOverviewData('bag', []);
    const got = [];
    hooks.setOverviewSink((k, d) => got.push([k, d]));
    hooks.emitOverviewData('diamond', 5);
    assert.deepEqual(got, [['diamond', 5]]);
    hooks.setOverviewSink(() => { throw new Error('boom'); });
    assert.doesNotThrow(() => hooks.emitOverviewData('ranch', {}));
    hooks.setOverviewSink(null);
});

test('牧场巡查单独拉到的生涯：补进牧场快照，不需要牧场概览视图', () => {
    const { cache, writer, advance } = setup(0);
    writer.onRanchState('1', ranchState());
    assert.equal(cache.get('1').ranch.career, null);
    advance(1000);
    writer.onRanchCareer('1', { harvest: 7, mature: 5, steal: 3, products: [] });
    assert.deepEqual(cache.get('1').ranch.career, { harvest: 7, mature: 5, steal: 3 });
    // 之后的普通牧场读取沿用这份生涯
    advance(1000);
    writer.onRanchState('1', ranchState('99'));
    assert.deepEqual(cache.get('1').ranch.career, { harvest: 7, mature: 5, steal: 3 });
});

test('生涯先于牧场状态到达：已有缓存时直接补，没有缓存时不写', () => {
    const { cache, writer } = setup(0);
    writer.onRanchCareer('2', { harvest: 1, mature: 1, steal: 1 });
    assert.equal(cache.get('2').ranch, null);
});

test('农场生涯：巡查拉到后写进农场快照，之后状态刷新沿用', () => {
    const { cache, writer, advance } = setup(0);
    writer.onStatus('1', farmStatus());
    assert.equal(cache.get('1').farm.career, null);
    advance(1000);
    writer.onFarmCareer('1', { harvest: 12345, steal: 678 });
    assert.deepEqual(cache.get('1').farm.career, { harvest: 12345, steal: 678 });
    advance(1000);
    writer.onStatus('1', farmStatus(300));
    assert.deepEqual(cache.get('1').farm.career, { harvest: 12345, steal: 678 });
});

test('refreshFarmCareer：节流，取不到生涯不发送', async () => {
    const career = require('../dist/services/career');
    const net = require('../dist/utils/network');
    const mod = require('../dist/services/fnos-farm-career');
    const origCareer = career.getCareerInfoOrNull;
    const origState = net.getUserState;
    const got = [];
    hooks.setOverviewSink((k, d) => got.push([k, d]));
    try {
        net.getUserState = () => ({ gid: 7 });
        career.getCareerInfoOrNull = async () => ({ harvest: 10, steal: 3, level: 1 });
        mod.resetFarmCareerRefreshForTest();
        assert.equal(await mod.refreshFarmCareer(100000, 60000), true);
        assert.equal(await mod.refreshFarmCareer(101000, 60000), false);
        assert.equal(await mod.refreshFarmCareer(200000, 60000), true);
        career.getCareerInfoOrNull = async () => null;
        assert.equal(await mod.refreshFarmCareer(400000, 60000), false);
    } finally {
        career.getCareerInfoOrNull = origCareer;
        net.getUserState = origState;
        hooks.setOverviewSink(null);
    }
    assert.deepEqual(got, [['farmCareer', { harvest: 10, steal: 3 }], ['farmCareer', { harvest: 10, steal: 3 }]]);
});
