// [fnos-fork] 2026-10-28：奶茶自动制作（可排除金露云酪）、自动领取工资。
// 真实 store（不 mock 配置读取）、真实 services/milk-tea（只 mock 网络/背包）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-milk-tea-extra-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '7';

const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/activitypb.proto'), { keepCase: true });
const types = Object.fromEntries(['MilkTeaGetGroupReply', 'MilkTeaOperateReply', 'MilkTeaOperateRequest', 'GetGroupRequest'].map(name => [name, root.lookupType(`gamepb.activitypb.${name}`)]));
const encode = (type, data) => Buffer.from(type.encode(type.fromObject(data)).finish());
const dist = rel => require.resolve(path.join('..', 'dist', rel));
const mock = (rel, exports) => { const id = dist(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };

const now = 1792032000;
const logs = [];
const writes = [];
const state = {};
function resetState() {
    state.shopOpen = true;
    state.settling = false;
    state.recipes = [
        { recipe_id: 1, recipe_name: '普通奶茶', unlocked: true },
        { recipe_id: 2, recipe_name: '甜莓奶茶', unlocked: true },
        { recipe_id: 3, recipe_name: '白桃乌龙', unlocked: false },
        { recipe_id: 9, recipe_name: '金露云酪', unlocked: true },
    ];
    state.bag = [
        { id: 1041, count: 200, uid: 1 },
        { id: 40525, count: 5, uid: 11 }, // 森野甜莓 → 甜莓奶茶
        { id: 40525, count: 1, uid: 12, locked: true }, // 用户锁定的不做
        { id: 49005, count: 2, uid: 13 }, // 森野黄金芽 → 金露云酪
        { id: 40526, count: 3, uid: 14 }, // 白桃（配方未解锁）
    ];
    state.level = 13;
    state.revenue = 0;
    state.slips = [{ shift_id: 5, wage_status: 1, wages: { base_wage: 30, final_wage: 30 } }, { shift_id: 6, wage_status: 2 }];
    writes.length = 0;
    logs.length = 0;
}
resetState();

// [fnos-fork] 需求 27：按活动等级表判断营业额是否够升下一级
const LEVELS = require('../src/activity-data/milk-tea-20261015.json').MilkTeaStoreLevelConfig;
function nextRevenue() { return (LEVELS.find(v => v.level === state.level + 1) || {}).revenue_required || 0; }
function canUpgrade() { const n = LEVELS.find(v => v.level === state.level + 1); return !!n && state.revenue >= n.revenue_required; }
mock('utils/proto', { types });
const realUtils = require('../dist/utils/utils');
mock('utils/utils', {
    ...realUtils,
    getServerTimeSec: () => now,
    log: (tag, msg) => logs.push(`${tag}|${msg}`),
    logWarn: (tag, msg) => logs.push(`${tag}|WARN|${msg}`),
});
mock('services/pay', { getDiamondBalance: async () => 0 });
mock('services/warehouse', { getBag: async () => ({ items: state.bag }), getBagItems: b => b.items, isItemLocked: v => !!v.locked });
mock('utils/network', { sendMsgAsync: async (_service, method, body) => {
    if (method === 'GetGroup') {
        const milk = { head: { activity_id: '2026110101', name: '奶茶热销中', begin_time: now - 3600, end_time: now + 86400 * 20, settle_start_time: state.settling ? now - 10 : now + 86400 * 18 },
            milk_tea: { summary: { shop_open_at: state.shopOpen ? now - 100 : 0, level: state.level, can_upgrade: canUpgrade(), has_unclaimed_wage: state.slips.some(v => v.wage_status === 1) } } };
        return { body: encode(types.MilkTeaGetGroupReply, { group: { head: { activity_id: '2026110100' }, children: [milk] } }) };
    }
    const req = types.MilkTeaOperateRequest.toObject(types.MilkTeaOperateRequest.decode(body), { longs: String });
    const cmd = Number(req.operate_type);
    let field; let result;
    if (cmd === 55) { field = 'milk_tea_get_shop'; result = { shop: { level: state.level, total_revenue: state.revenue, next_level_revenue: nextRevenue(), slots: [], is_settling: state.settling } }; }
    else if (cmd === 58) { field = 'milk_tea_get_workshop'; result = { recipes: state.recipes }; }
    else if (cmd === 62) {
        field = 'milk_tea_craft'; writes.push({ cmd, uids: req.milk_tea_craft.fruit_uids.map(String) });
        const cups = {};
        for (const uid of req.milk_tea_craft.fruit_uids.map(String)) {
            const item = state.bag.find(v => String(v.uid) === uid);
            const recipe = { 40525: 2, 49005: 9 }[item.id];
            cups[recipe] = (cups[recipe] || 0) + item.count;
        }
        state.bag = state.bag.filter(v => !req.milk_tea_craft.fruit_uids.map(String).includes(String(v.uid)));
        result = { crafted_cups: cups, drink_cups: cups };
    } else if (cmd === 63) { field = 'milk_tea_get_work_page'; result = { slips: state.slips }; }
    else if (cmd === 64) {
        field = 'milk_tea_claim_wages'; writes.push({ cmd });
        const n = state.slips.filter(v => v.wage_status === 1).length;
        state.slips = state.slips.map(v => ({ ...v, wage_status: 2 }));
        result = { items: [{ id: 1041, count: 30 }], claimed_count: n };
    } else if (cmd === 61) {
        // [fnos-fork] 需求 27：店铺升级
        field = 'milk_tea_upgrade'; writes.push({ cmd, from: state.level });
        if (!canUpgrade()) throw new Error('server: not ready');
        state.level += 1;
        result = { level: state.level, rewards: [{ id: 29005, count: 2 }, { id: 1042, count: 2 }] };
    } else throw new Error(`unexpected cmd ${cmd}`);
    return { body: encode(types.MilkTeaOperateReply, { activity_id: req.activity_id, operate_type: cmd, [field]: result }) };
} });

const store = require('../dist/models/store');
const extra = require('../dist/services/fnos-milk-tea-extra');
const { onWorkerConfigApplied, readFnosForkConfigs } = require('../dist/services/fnos-fork-config');

function workerApply(snapshot) {
    store.applyConfigSnapshot(snapshot, { persist: false, accountId: process.env.FARM_ACCOUNT_ID });
    onWorkerConfigApplied();
}

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('normalize：默认全部关闭；缺字段沿用 fallback；真实 store 默认关闭', () => {
    assert.deepEqual(extra.normalizeFnosMilkTeaExtra(undefined), { autoCraft: false, craftGoldenCheese: false, autoClaimWages: false, autoUpgradeShop: false });
    assert.deepEqual(extra.normalizeFnosMilkTeaExtra({ autoCraft: 1 }, { autoCraft: false, craftGoldenCheese: true, autoClaimWages: true, autoUpgradeShop: false }), { autoCraft: true, craftGoldenCheese: true, autoClaimWages: true, autoUpgradeShop: false });
    assert.deepEqual(store.getConfigSnapshot('7').fnosMilkTeaExtra, { autoCraft: false, craftGoldenCheese: false, autoClaimWages: false, autoUpgradeShop: false });
    assert.deepEqual(readFnosForkConfigs().extra, { autoCraft: false, craftGoldenCheese: false, autoClaimWages: false, autoUpgradeShop: false });
});

test('未开启：一轮不发任何请求', async () => {
    resetState();
    const r = await extra.runMilkTeaExtraTick();
    assert.deepEqual(r, { crafted: false, wages: false, upgraded: 0 });
    assert.equal(writes.length, 0);
});

test('自动制作，排除金露云酪：只用已解锁配方、未锁定的果实；黄金芽留着', async () => {
    resetState();
    extra.resetFnosMilkTeaExtraRuntime();
    workerApply({ fnosMilkTeaExtra: { autoCraft: true, craftGoldenCheese: false, autoClaimWages: false, autoUpgradeShop: false } });
    const r = await extra.runMilkTeaExtraTick();
    assert.equal(r.crafted, true);
    assert.deepEqual(writes, [{ cmd: 62, uids: ['11'] }]);
    assert.ok(state.bag.some(v => v.id === 49005), '黄金芽不应被消耗');
    assert.ok(logs.some(l => l.startsWith('奶茶制作|奶茶已自动制作：消耗 甜莓奶茶（') && l.includes('做出 甜莓奶茶×5 杯') && l.includes('森野黄金芽 2 个按设置不做金露云酪')), logs.join('\n'));
    // 再跑一轮：只剩黄金芽 → 跳过且只记一次日志
    writes.length = 0; logs.length = 0;
    await extra.runMilkTeaExtraTick();
    await extra.runMilkTeaExtraTick();
    assert.equal(writes.length, 0);
    assert.equal(logs.filter(l => l.includes('只有森野黄金芽')).length, 1, logs.join('\n'));
});

test('自动制作，包括金露云酪：黄金芽和其他果实一起做', async () => {
    resetState();
    extra.resetFnosMilkTeaExtraRuntime();
    workerApply({ fnosMilkTeaExtra: { autoCraft: true, craftGoldenCheese: true, autoClaimWages: false, autoUpgradeShop: false } });
    await extra.runMilkTeaExtraTick();
    assert.deepEqual(writes, [{ cmd: 62, uids: ['11', '13'] }]);
    assert.ok(logs.some(l => l.includes('金露云酪×2 杯')), logs.join('\n'));
});

test('未开业 / 结算期：不制作', async () => {
    resetState();
    extra.resetFnosMilkTeaExtraRuntime();
    workerApply({ fnosMilkTeaExtra: { autoCraft: true, craftGoldenCheese: true, autoClaimWages: false, autoUpgradeShop: false } });
    state.shopOpen = false;
    await extra.runMilkTeaExtraTick();
    state.shopOpen = true; state.settling = true;
    await extra.runMilkTeaExtraTick();
    assert.equal(writes.length, 0);
    assert.ok(logs.some(l => l.includes('奶茶店尚未开业')));
    assert.ok(logs.some(l => l.includes('结算期不可制作')), logs.join('\n'));
});

test('自动领取工资：有 wage_status=1 的工资单才发操作号 64，领完不再发', async () => {
    resetState();
    extra.resetFnosMilkTeaExtraRuntime();
    workerApply({ fnosMilkTeaExtra: { autoCraft: false, craftGoldenCheese: false, autoClaimWages: true, autoUpgradeShop: false } });
    let r = await extra.runMilkTeaExtraTick();
    assert.equal(r.wages, true);
    assert.deepEqual(writes, [{ cmd: 64 }]);
    assert.ok(logs.some(l => l.startsWith('奶茶工资|奶茶工资已领取 1 笔：奶茶券×30')), logs.join('\n'));
    writes.length = 0;
    r = await extra.runMilkTeaExtraTick();
    assert.equal(r.wages, false);
    assert.equal(writes.length, 0);
    assert.ok(logs.some(l => l.includes('暂无可领取工资')));
});

test('planCraft 纯函数：没有已解锁配方 / 背包为空', () => {
    assert.equal(extra.planCraft({ active: true, summary: { shop_open_at: 1 }, recipes: [{ recipe_id: '1', unlocked: true, fruitId: 0 }], fruits: [] }, true).kind, 'no_recipe');
    assert.equal(extra.planCraft({ active: true, summary: { shop_open_at: 1 }, recipes: [{ recipe_id: '2', unlocked: true, fruitId: 40525 }], fruits: [] }, true).kind, 'empty');
    assert.equal(extra.planCraft({ active: false }, true).kind, 'inactive');
});

test('调度：10 分钟一次；设置变化约 8 秒后先跑一次；持久化到账号配置文件', async () => {
    const tasks = [];
    const fakeScheduler = { setTimeoutTask: (name, ms, fn) => tasks.push({ name, ms, fn }), setIntervalTask: (name, ms, fn) => tasks.push({ name, ms, fn, interval: true }) };
    extra.startFnosMilkTeaExtra(fakeScheduler, async (_n, fn) => fn());
    assert.ok(tasks.some(t => t.interval && t.ms === 10 * 60 * 1000));
    tasks.length = 0;
    workerApply({ fnosMilkTeaExtra: { autoCraft: false, craftGoldenCheese: true, autoClaimWages: false, autoUpgradeShop: false } });
    assert.ok(tasks.some(t => t.name === 'fnos_milk_tea_extra_first' && t.ms <= 10000));
    store.applyConfigSnapshot({ fnosMilkTeaExtra: { autoCraft: true, craftGoldenCheese: false, autoClaimWages: true, autoUpgradeShop: false } }, { accountId: '8' });
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, ['-e', `const s=require(${JSON.stringify(path.join(__dirname, '../dist/models/store'))});console.log(JSON.stringify([s.getConfigSnapshot('8').fnosMilkTeaExtra, s.getConfigSnapshot('9').fnosMilkTeaExtra]))`], { env: { ...process.env, QQ_FARM_DATA_DIR: DATA_DIR } }).toString().trim().split('\n').pop();
    assert.deepEqual(JSON.parse(out), [{ autoCraft: true, craftGoldenCheese: false, autoClaimWages: true, autoUpgradeShop: false }, { autoCraft: false, craftGoldenCheese: false, autoClaimWages: false, autoUpgradeShop: false }]);
});

// ============ [fnos-fork] 需求 27：店铺自动升级 ============

test('店铺自动升级：未达营业额 → 跳过并退避 30 分钟；达到后发操作号 61，可连升多级，日志「Lv.x → Lv.y」', async () => {
    resetState();
    extra.resetFnosMilkTeaExtraRuntime();
    state.level = 3; state.revenue = 50000; // Lv.4 需要 53000
    workerApply({ fnosMilkTeaExtra: { autoCraft: false, craftGoldenCheese: false, autoClaimWages: false, autoUpgradeShop: true } });
    logs.length = 0;
    let r = await extra.runMilkTeaExtraTick({ nowMs: 1000 });
    assert.equal(r.upgraded, 0);
    assert.equal(writes.length, 0);
    assert.ok(logs.includes('奶茶升级|店铺自动升级跳过：尚未达到升级条件（Lv.3 → Lv.4，营业额 50,000/53,000）'), logs.join('\n'));
    state.revenue = 80000; // 够 Lv.4、Lv.5（75000），不够 Lv.6
    r = await extra.runMilkTeaExtraTick({ nowMs: 1000 + 10 * 60 * 1000 });
    assert.equal(r.upgraded, 0, '退避期内不读不升');
    r = await extra.runMilkTeaExtraTick({ nowMs: 1000 + 31 * 60 * 1000 });
    assert.equal(r.upgraded, 2);
    assert.deepEqual(writes, [{ cmd: 61, from: 3 }, { cmd: 61, from: 4 }]);
    assert.ok(logs.some(l => l.startsWith('奶茶升级|店铺自动升级：Lv.3 → Lv.4，获得 森野黄金芽种子×2')), logs.join('\n'));
    assert.ok(logs.some(l => l.startsWith('奶茶升级|店铺自动升级：Lv.4 → Lv.5')), logs.join('\n'));
});

test('店铺自动升级：未开业 / 满级 / 关闭时不发请求', async () => {
    resetState();
    extra.resetFnosMilkTeaExtraRuntime();
    workerApply({ fnosMilkTeaExtra: { autoCraft: false, craftGoldenCheese: false, autoClaimWages: false, autoUpgradeShop: true } });
    state.shopOpen = false;
    await extra.runMilkTeaExtraTick({ nowMs: 1000 });
    assert.ok(logs.some(l => l.includes('店铺自动升级跳过：本账号奶茶店尚未开业')), logs.join('\n'));
    extra.resetFnosMilkTeaExtraRuntime();
    state.shopOpen = true; state.level = extra.MAX_SHOP_LEVEL; state.revenue = 1e12;
    await extra.runMilkTeaExtraTick({ nowMs: 1000 });
    assert.ok(logs.some(l => l.includes(`店铺已满级（Lv.${extra.MAX_SHOP_LEVEL}）`)), logs.join('\n'));
    assert.equal(writes.length, 0);
    assert.equal(extra.planUpgrade({ active: false }).kind, 'inactive');
    assert.deepEqual(extra.planUpgrade({ active: true, summary: { shop_open_at: 1, level: 2, can_upgrade: true } }), { level: 2 });
});
