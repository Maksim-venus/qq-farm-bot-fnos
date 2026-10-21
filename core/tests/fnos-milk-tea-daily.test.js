// [fnos-fork] 2026.10.21：奶茶收益每小时自动领取、兑换商店每日兑换森野黄金芽种子。
// 使用真实 store（不 mock 配置读取函数）、真实 services/milk-tea（只 mock 网络/背包），真实物品表按名字识别种子。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-milk-tea-daily-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '7';

const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/activitypb.proto'), { keepCase: true });
const types = Object.fromEntries(['MilkTeaGetGroupReply', 'MilkTeaOperateReply', 'MilkTeaOperateRequest', 'GetGroupRequest'].map(name => [name, root.lookupType(`gamepb.activitypb.${name}`)]));
const encode = (type, data) => Buffer.from(type.encode(type.fromObject(data)).finish());
const dist = rel => require.resolve(path.join('..', 'dist', rel));
const mock = (rel, exports) => { const id = dist(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };

let now = 1792032000; // 服务器时间（秒）
const logs = [];
const writes = [];
const SEED_ID = 29005; // 仅用于构造模拟回包；被测代码按名字「森野黄金芽种子」从官方物品表识别
const state = {};
function resetState() {
    state.shopOpen = true;
    state.pending = [{ id: 1041, count: 12 }];
    state.goods = [
        { id: 401, item: [{ id: 49005, count: 1 }], cost: [{ id: 1041, count: 5 }], purchase_limit: 10, purchased_count: 0, category_tag: 'fruit', cond_hints: [] },
        { id: 402, item: [{ id: SEED_ID, count: 1 }], cost: [{ id: 1041, count: 30 }], purchase_limit: 2, purchased_count: 0, category_tag: 'seed', cond_hints: [] },
    ];
    state.bag = [{ id: 1041, count: 200 }];
    writes.length = 0;
    logs.length = 0;
}
resetState();

mock('utils/proto', { types });
const realUtils = require('../dist/utils/utils');
mock('utils/utils', {
    ...realUtils,
    getServerTimeSec: () => now,
    log: (tag, msg) => logs.push(`${tag}|${msg}`),
    logWarn: (tag, msg) => logs.push(`${tag}|WARN|${msg}`),
});
mock('services/pay', { getDiamondBalance: async () => 0 });
mock('services/warehouse', { getBag: async () => ({ items: state.bag }), getBagItems: b => b.items, isItemLocked: () => false });
mock('utils/network', { sendMsgAsync: async (_service, method, body) => {
    if (method === 'GetGroup') {
        const milk = { head: { activity_id: '2026110101', name: '奶茶热销中', begin_time: now - 3600, end_time: now + 86400 * 20, settle_start_time: now + 86400 * 18 },
            milk_tea: { summary: { shop_open_at: state.shopOpen ? now - 100 : 0, level: 1 } } };
        return { body: encode(types.MilkTeaGetGroupReply, { group: { head: { activity_id: '2026110100' }, children: [milk, { head: { activity_id: '2026110102' }, shop: { goods: state.goods } }] } }) };
    }
    const req = types.MilkTeaOperateRequest.toObject(types.MilkTeaOperateRequest.decode(body), { longs: String });
    const cmd = Number(req.operate_type);
    let field; let result;
    if (cmd === 55) { field = 'milk_tea_get_shop'; result = { shop: { level: 1, slots: [], pending_rewards: state.pending } }; }
    else if (cmd === 58) { field = 'milk_tea_get_workshop'; result = { recipes: [] }; }
    else if (cmd === 59) {
        field = 'milk_tea_claim_cashier'; writes.push({ cmd, activity: req.activity_id });
        result = { items: state.pending }; state.pending = [];
    } else if (cmd === 1) {
        field = 'shop_buy'; writes.push({ cmd, activity: req.activity_id, buy: req.shop_buy });
        const g = state.goods.find(v => String(v.id) === String(req.shop_buy.goods_id));
        const count = Number(req.shop_buy.count);
        g.purchased_count += count;
        state.bag[0].count -= g.cost[0].count * count;
        result = { awards: [{ id: g.item[0].id, count }], costs: [{ id: 1041, count: g.cost[0].count * count }] };
    } else throw new Error(`unexpected cmd ${cmd}`);
    return { body: encode(types.MilkTeaOperateReply, { activity_id: req.activity_id, operate_type: cmd, [field]: result }) };
} });

const store = require('../dist/models/store');
const daily = require('../dist/services/fnos-milk-tea-daily');
const { readFnosForkConfigs, onWorkerConfigApplied, logFnosForkStatus } = require('../dist/services/fnos-fork-config');

function workerApply(snapshot) {
    store.applyConfigSnapshot(snapshot, { persist: false, accountId: process.env.FARM_ACCOUNT_ID });
    onWorkerConfigApplied();
}

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('normalizeFnosMilkTeaDaily：默认两项都关闭；真实 store 默认值也是关闭', () => {
    assert.deepEqual(daily.normalizeFnosMilkTeaDaily(undefined), { autoClaim: false, autoExchangeSeed: false });
    assert.deepEqual(daily.normalizeFnosMilkTeaDaily({ autoClaim: 1, autoExchangeSeed: 0, junk: 1 }), { autoClaim: true, autoExchangeSeed: false });
    assert.deepEqual(store.getConfigSnapshot('7').fnosMilkTeaDaily, { autoClaim: false, autoExchangeSeed: false });
    assert.deepEqual(readFnosForkConfigs().daily, { autoClaim: false, autoExchangeSeed: false });
});

test('未开启时不发任何请求', async () => {
    resetState();
    daily.resetFnosMilkTeaDailyRuntime();
    await daily.runMilkTeaDailyTick({ nowMs: 1000 });
    assert.equal(writes.length, 0);
    assert.equal(logs.length, 0);
});

test('开启自动领取：领取收益（操作号 59）并打中文日志；无收益时只记一次跳过；一小时内不重复', async () => {
    resetState();
    daily.resetFnosMilkTeaDailyRuntime();
    workerApply({ fnosMilkTeaDaily: { autoClaim: true, autoExchangeSeed: false } });
    assert.deepEqual(readFnosForkConfigs().daily, { autoClaim: true, autoExchangeSeed: false });
    logs.length = 0;
    let r = await daily.runMilkTeaDailyTick({ nowMs: 1000 });
    assert.equal(r.claimed, true, logs.join('\n'));
    assert.deepEqual(writes, [{ cmd: 59, activity: '2026110101' }]);
    assert.ok(logs.some(l => l.startsWith('奶茶收益|奶茶收益已领取：奶茶券×12')), logs.join('\n'));
    r = await daily.runMilkTeaDailyTick({ nowMs: 1000 + 30 * 60 * 1000 });
    assert.equal(r.claimed, false);
    assert.equal(writes.length, 1);
    logs.length = 0;
    await daily.runMilkTeaDailyTick({ nowMs: 1000 + 61 * 60 * 1000 });
    await daily.runMilkTeaDailyTick({ nowMs: 1000 + 122 * 60 * 1000 });
    assert.equal(writes.length, 1);
    assert.deepEqual(logs, ['奶茶收益|奶茶收益领取跳过：暂无可领取收益']);
});

test('开启每日兑换：按名字找到森野黄金芽种子（不是果实），按剩余限购兑换；当天不再重复；次日再兑换', async () => {
    resetState();
    daily.resetFnosMilkTeaDailyRuntime();
    workerApply({ fnosMilkTeaDaily: { autoClaim: false, autoExchangeSeed: true } });
    logs.length = 0;
    let r = await daily.runMilkTeaDailyTick({ nowMs: 1000 });
    assert.equal(r.exchanged, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].cmd, 1);
    assert.equal(writes[0].activity, '2026110102');
    assert.equal(String(writes[0].buy.goods_id), '402');
    assert.equal(Number(writes[0].buy.count), 2);
    assert.ok(logs.includes('奶茶兑换|森野黄金芽种子已兑换：森野黄金芽种子×2，花费 奶茶券×60'), logs.join('\n'));
    r = await daily.runMilkTeaDailyTick({ nowMs: 2 * 3600 * 1000 });
    assert.equal(writes.length, 1);
    now += 86400;
    state.goods[1].purchased_count = 0;
    logs.length = 0;
    r = await daily.runMilkTeaDailyTick({ nowMs: 26 * 3600 * 1000 });
    assert.equal(r.exchanged, true);
    assert.equal(writes.length, 2);
    now -= 86400;
});

test('已兑换 / 货币不足 / 找不到商品：写跳过日志，当天不重试', async () => {
    resetState();
    daily.resetFnosMilkTeaDailyRuntime();
    workerApply({ fnosMilkTeaDaily: { autoClaim: false, autoExchangeSeed: true } });
    state.goods[1].purchased_count = 2;
    logs.length = 0;
    await daily.runMilkTeaDailyTick({ nowMs: 1000 });
    await daily.runMilkTeaDailyTick({ nowMs: 3 * 3600 * 1000 });
    assert.equal(writes.length, 0);
    assert.deepEqual(logs, ['奶茶兑换|森野黄金芽种子兑换跳过：今日「森野黄金芽种子」已兑换或已售罄']);

    daily.resetFnosMilkTeaDailyRuntime();
    state.goods[1].purchased_count = 0;
    state.bag[0].count = 10;
    logs.length = 0;
    await daily.runMilkTeaDailyTick({ nowMs: 1000 });
    assert.equal(writes.length, 0);
    assert.ok(logs[0].startsWith('奶茶兑换|森野黄金芽种子兑换跳过：兑换「森野黄金芽种子」货币不足：每个需要 奶茶券 30（现有 10）'), logs.join('\n'));

    daily.resetFnosMilkTeaDailyRuntime();
    state.bag[0].count = 45;
    logs.length = 0;
    await daily.runMilkTeaDailyTick({ nowMs: 1000 });
    assert.equal(Number(writes[0].buy.count), 1);
    assert.ok(logs.some(l => l.includes('森野黄金芽种子已兑换') && l.includes('货币只够兑换部分')), logs.join('\n'));

    daily.resetFnosMilkTeaDailyRuntime();
    writes.length = 0;
    state.goods = [state.goods[0]];
    logs.length = 0;
    await daily.runMilkTeaDailyTick({ nowMs: 1000 });
    assert.equal(writes.length, 0);
    assert.deepEqual(logs, ['奶茶兑换|森野黄金芽种子兑换跳过：兑换商店里没有找到「森野黄金芽种子」']);
});

test('planSeedExchange：条件未满足不兑换；无限购每天只兑 1 个；果实不误判', () => {
    const seed = { id: '9', name: '', rewards: [{ id: 1, name: '森野黄金芽种子', count: 1 }], costs: [{ id: 1041, name: '奶茶券', count: 3 }] };
    const blocked = daily.planSeedExchange([{ ...seed, remaining: 5, available: false, conditions: [{ type: 'level', satisfied: false, current: 2, target: 5 }] }], { 1041: 100 });
    assert.equal(blocked.kind, 'unavailable');
    const unlimited = daily.planSeedExchange([{ ...seed, remaining: null, available: true, conditions: [] }], { 1041: 100 });
    assert.equal(unlimited.count, 1);
    assert.equal(daily.findSeedGoods([{ name: '黄金·森野黄金芽', rewards: [{ name: '黄金·森野黄金芽' }] }, { name: '', rewards: [{ name: '森野黄金芽' }] }]).length, 0);
});

test('设置运行中变化 → 约 5 秒后执行一次，并打印状态日志；不相关设置不触发', async () => {
    const tasks = [];
    const fakeScheduler = {
        setTimeoutTask: (name, ms, fn) => tasks.push({ name, ms, fn }),
        setIntervalTask: (name, ms, fn) => tasks.push({ name, ms, fn, interval: true }),
    };
    daily.startFnosMilkTeaDaily(fakeScheduler, async (_n, fn) => fn());
    assert.ok(tasks.some(t => t.name === 'fnos_milk_tea_daily_first' && t.ms <= 10000));
    assert.ok(tasks.some(t => t.interval && t.ms === 3600 * 1000));
    tasks.length = 0;
    logs.length = 0;
    workerApply({ fnosMilkTeaDaily: { autoClaim: true, autoExchangeSeed: true } });
    assert.ok(tasks.some(t => t.name === 'fnos_milk_tea_daily_first' && t.ms <= 10000), JSON.stringify(tasks));
    assert.ok(logs.includes('奶茶收益|设置已更新：奶茶收益每小时自动领取已启用；森野黄金芽种子每日兑换已启用（会消耗兑换商店货币）'), logs.join('\n'));
    tasks.length = 0;
    workerApply({ stealDelaySeconds: 3 });
    assert.equal(tasks.length, 0);
    logs.length = 0;
    assert.equal(logFnosForkStatus('账号已登录', true), true);
    assert.ok(logs.some(l => l.startsWith('奶茶收益|账号已登录：')), logs.join('\n'));
});

test('持久化：保存后新进程读回（真实 store 写 store.json）', () => {
    store.applyConfigSnapshot({ fnosMilkTeaDaily: { autoClaim: true, autoExchangeSeed: false } }, { accountId: '8' });
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, ['-e', `const s=require(${JSON.stringify(path.join(__dirname, '../dist/models/store'))});console.log(JSON.stringify([s.getConfigSnapshot('8').fnosMilkTeaDaily, s.getConfigSnapshot('9').fnosMilkTeaDaily]))`], { env: { ...process.env, QQ_FARM_DATA_DIR: DATA_DIR } }).toString().trim().split('\n').pop();
    assert.deepEqual(JSON.parse(out), [{ autoClaim: true, autoExchangeSeed: false }, { autoClaim: false, autoExchangeSeed: false }]);
});
