// [fnos-fork] 奶茶活动自动雇佣：选人/时长规则与一轮检查流程测试
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const dist = rel => require.resolve(path.join('..', 'dist', rel));
let accountSnapshot = {};
const logs = [];
require.cache[dist('models/store')] = { exports: { getConfigSnapshot: () => accountSnapshot } };
const realUtils = require('../dist/utils/utils');
require.cache[dist('utils/utils')] = {
    exports: { ...realUtils, log: (t, m) => logs.push(`${t}|${m}`), logWarn: (t, m) => logs.push(`${t}|WARN|${m}`) },
};

const {
    normalizeFnosMilkTeaAutoHire,
    getFreeSlots,
    chooseCandidate,
    planOneHire,
    allowedDurationIds,
    runMilkTeaAutoHireTick,
    resetFnosMilkTeaAutoHireRuntime,
    startFnosMilkTeaAutoHire,
    getFnosMilkTeaAutoHireNextCheckAtMs,
    MILK_TEA_HIRE_CHECK_INTERVAL_MS,
} = require('../dist/services/fnos-milk-tea-auto-hire');

const NOW = 1_792_000_000;
const MASTER = 4300123456;
const friend = (gid, extra = {}) => ({ friend: { gid: String(gid), name: `F${gid}` }, is_robot: false, talent_id: 9001, state: 0, rehire_available_at: '0', ...extra });

test('normalizeFnosMilkTeaAutoHire: 默认关闭、随机时长/不限职业，非法值回到默认', () => {
    assert.deepEqual(normalizeFnosMilkTeaAutoHire(undefined), { enabled: false, durationId: 0, priorityFriends: [], priorityGid: 0, priorityName: '', priorityConfigured: false, talentId: 0, allowRobots: false, autoWork: false, workType: 0 });
    assert.deepEqual(normalizeFnosMilkTeaAutoHire({ enabled: true, durationId: '3', talentId: 9002, allowRobots: 1 }),
        { enabled: true, durationId: 3, priorityFriends: [], priorityGid: 0, priorityName: '', priorityConfigured: false, talentId: 9002, allowRobots: true, autoWork: false, workType: 0 });
    assert.deepEqual(normalizeFnosMilkTeaAutoHire({ autoWork: 1, workType: '9' }).workType, 0);
    assert.deepEqual(normalizeFnosMilkTeaAutoHire({ autoWork: 1, workType: '2' }), { enabled: false, durationId: 0, priorityFriends: [], priorityGid: 0, priorityName: '', priorityConfigured: false, talentId: 0, allowRobots: false, autoWork: true, workType: 2 });
    const bad = normalizeFnosMilkTeaAutoHire({ enabled: true, durationId: 9, talentId: 1 });
    assert.equal(bad.durationId, 0);
    assert.equal(bad.talentId, 0);
});

test('getFreeSlots: 按店铺等级的员工位，未到期班次占位', () => {
    // 3 级店 2 个员工位
    assert.deepEqual(getFreeSlots({ level: 3, slots: [] }, NOW), [0, 1]);
    assert.deepEqual(getFreeSlots({ level: 3, slots: [{ slot_index: 0, end_at: String(NOW + 60) }] }, NOW), [1]);
    assert.deepEqual(getFreeSlots({ level: 3, slots: [{ slot_index: 0, end_at: String(NOW - 1) }, { slot_index: 1, end_at: NOW + 5 }] }, NOW), [0]);
    assert.deepEqual(getFreeSlots({ level: 1, slots: [] }, NOW), [0]);
});

test('allowedDurationIds: 按剩余营业时间限制时长档位', () => {
    assert.deepEqual(allowedDurationIds(100000), [1, 2, 3]);
    assert.deepEqual(allowedDurationIds(20000), [1, 2]);
    assert.deepEqual(allowedDurationIds(700), [1]);
    assert.deepEqual(allowedDurationIds(100), []);
});

test('chooseCandidate: 只选可雇、未冷却、符合职业的好友；机器人需开启', () => {
    const hire = {
        friends: [friend(1, { state: 1 }), friend(2, { rehire_available_at: String(NOW + 100) }), friend(3, { talent_id: 9002 }), friend(4)],
        robots: [friend(99, { is_robot: true, talent_id: 9003 })],
    };
    assert.equal(chooseCandidate({ hire, nowSec: NOW, talentId: 0, allowRobots: false, random: () => 0 }).targetGid, 3);
    assert.equal(chooseCandidate({ hire, nowSec: NOW, talentId: 9001, allowRobots: false, random: () => 0 }).targetGid, 4);
    assert.equal(chooseCandidate({ hire, nowSec: NOW, talentId: 9003, allowRobots: false }), null);
    const robot = chooseCandidate({ hire, nowSec: NOW, talentId: 9003, allowRobots: true });
    assert.equal(robot.targetGid, 99);
    assert.equal(robot.isRobot, true);
    assert.equal(chooseCandidate({ hire, nowSec: NOW, talentId: 0, allowRobots: false, excludeGids: [3, 4] }), null);
});

const lists = {
    1: { duration_id: 1, wage_total: '40', friends: [friend(MASTER, { state: 1 }), friend(5)] },
    3: { duration_id: 3, wage_total: '270', friends: [friend(MASTER), friend(5)] },
};
const CFG = { enabled: true, durationId: 2, priorityGid: 0, priorityName: '', priorityConfigured: true, talentId: 0, allowRobots: false };
const PRI = { ...CFG, priorityGid: MASTER, priorityName: '大号', durationId: 3 };

test('planOneHire 优先雇佣人空闲 → 按统一的雇佣时长雇他', async () => {
    const plan = await planOneHire({ cfg: PRI, remainBizSec: 200000, nowSec: NOW, getHireList: async id => lists[id] || { friends: [] } });
    assert.equal(plan.durationId, 3);
    assert.equal(plan.choice.targetGid, MASTER);
    assert.equal(plan.wage, 270);
    assert.match(plan.choice.reason, /优先雇佣人 大号当前空闲/);
});

test('planOneHire 优先雇佣人已被雇 → 同一个雇佣时长随机雇其他好友', async () => {
    const seen = [];
    const busy = { 3: { ...lists[3], friends: [friend(MASTER, { state: 2 }), friend(5)] } };
    const plan = await planOneHire({ cfg: PRI, remainBizSec: 200000, nowSec: NOW, getHireList: async (id) => { seen.push(id); return busy[id]; } });
    assert.equal(plan.durationId, 3);
    assert.equal(plan.choice.targetGid, 5);
    assert.equal(plan.wage, 270);
    assert.match(plan.choice.reason, /已被雇佣/);
    assert.deepEqual(seen, [3], '只请求一次雇佣列表');
});

test('planOneHire 雇佣时长随机：优先雇佣人也按随机到的档位；营业时间不足以雇指定档位时跳过（不换档）', async () => {
    let plan = await planOneHire({ cfg: { ...PRI, durationId: 0 }, remainBizSec: 200000, nowSec: NOW, random: () => 0, getHireList: async id => ({ ...lists[3], duration_id: id, wage_total: '40' }) });
    assert.equal(plan.durationId, 1);
    assert.equal(plan.choice.targetGid, MASTER);
    plan = await planOneHire({ cfg: PRI, remainBizSec: 20000, nowSec: NOW, getHireList: async () => { throw new Error('不应请求'); } });
    assert.match(plan.skip, /营业时间不足以雇佣 24 小时/);
});

test('planOneHire 未指定优先雇佣人：按设置时长；随机时长在允许档位内；无人可雇时跳过', async () => {
    let plan = await planOneHire({ cfg: CFG, remainBizSec: 200000, nowSec: NOW, getHireList: async id => ({ duration_id: id, wage_total: '130', friends: [friend(7)] }) });
    assert.equal(plan.durationId, 2);
    assert.equal(plan.choice.targetGid, 7);
    plan = await planOneHire({ cfg: { ...CFG, durationId: 0 }, remainBizSec: 200000, nowSec: NOW, random: () => 0.99, getHireList: async id => ({ duration_id: id, friends: [friend(7)] }) });
    assert.equal(plan.durationId, 3);
    assert.equal(plan.wage, 270, '回包没有 wage_total 时按官方配置价格');
    plan = await planOneHire({ cfg: CFG, remainBizSec: 200000, nowSec: NOW, getHireList: async () => ({ friends: [friend(7, { state: 1 })] }) });
    assert.ok(plan.skip);
    plan = await planOneHire({ cfg: { ...CFG, durationId: 3 }, remainBizSec: 20000, nowSec: NOW, getHireList: async () => ({ friends: [friend(7)] }) });
    assert.match(plan.skip, /营业时间不足/);
});

function fakeMilkTea({ shop, balances, listsById }) {
    const hires = [];
    return {
        hires,
        getMilkTeaActivity: async (_page, input) => ({
            active: true, settling: false, serverTime: NOW, settleStartTime: NOW + 200000,
            summary: { shop_open_at: '1' }, shop, balances, hire: listsById[input.durationId],
        }),
        operateMilkTeaActivity: async (action, input) => { hires.push({ action, ...input }); return { result: {} }; },
    };
}

test('runMilkTeaAutoHireTick: 未开启不发请求', async () => {
    resetFnosMilkTeaAutoHireRuntime();
    accountSnapshot = { fnosMilkTeaAutoHire: { enabled: false } };
    let called = false;
    const n = await runMilkTeaAutoHireTick({ milkTea: { getMilkTeaActivity: async () => { called = true; } } });
    assert.equal(n, 0);
    assert.equal(called, false);
});

test('runMilkTeaAutoHireTick: 老配置小号两个空位（迁移）→ 先雇大号，再随机雇其他好友，都按该账号的雇佣时长，带上预期花费', async () => {
    resetFnosMilkTeaAutoHireRuntime();
    logs.length = 0;
    accountSnapshot = {
        fnosMilkTeaAutoHire: { enabled: true, durationId: 2, talentId: 0 },
        fnosAltAccount: { enabled: true, masterGid: MASTER, masterName: '大号' },
    };
    let masterHired = false;
    const mt = fakeMilkTea({ shop: { level: 3, slots: [] }, balances: { 1041: 1000 }, listsById: {} });
    mt.getMilkTeaActivity = async (_p, input) => ({
        active: true, settling: false, serverTime: NOW, settleStartTime: NOW + 200000, summary: { shop_open_at: '1' },
        shop: { level: 3, slots: [] }, balances: { 1041: 1000 },
        hire: { duration_id: input.durationId, wage_total: { 1: '40', 2: '130', 3: '270' }[input.durationId], friends: [friend(MASTER, { state: masterHired ? 2 : 0 }), friend(5)] },
    });
    mt.operateMilkTeaActivity = async (action, input) => { mt.hires.push({ action, ...input }); if (input.targetGid === String(MASTER)) masterHired = true; return {}; };
    const n = await runMilkTeaAutoHireTick({ milkTea: mt, force: true });
    assert.equal(n, 2);
    assert.deepEqual(mt.hires, [
        { action: 'hire', durationId: 2, targetGid: String(MASTER), expectedCosts: [{ id: 1041, count: 130 }] },
        { action: 'hire', durationId: 2, targetGid: '5', expectedCosts: [{ id: 1041, count: 130 }] },
    ]);
    assert.ok(logs.some(l => l.includes('已雇佣') && l.includes('12 小时')), logs.join('\n'));
});

test('runMilkTeaAutoHireTick: 奶茶券不足时跳过并写日志；员工位满时不雇', async () => {
    resetFnosMilkTeaAutoHireRuntime();
    logs.length = 0;
    accountSnapshot = { fnosMilkTeaAutoHire: { enabled: true, durationId: 3 } };
    let mt = fakeMilkTea({ shop: { level: 1, slots: [] }, balances: { 1041: 100 }, listsById: { 1: { friends: [] }, 3: { wage_total: '270', friends: [friend(5)] } } });
    assert.equal(await runMilkTeaAutoHireTick({ milkTea: mt, force: true }), 0);
    assert.deepEqual(mt.hires, []);
    assert.ok(logs.some(l => l.includes('奶茶券不足')));

    mt = fakeMilkTea({ shop: { level: 1, slots: [{ slot_index: 0, end_at: NOW + 3600 }] }, balances: { 1041: 1000 }, listsById: { 1: { friends: [friend(5)] } } });
    assert.equal(await runMilkTeaAutoHireTick({ milkTea: mt, force: true }), 0);
    assert.deepEqual(mt.hires, []);
});

test('runMilkTeaAutoHireTick: 雇佣失败后退避，不连续重试', async () => {
    resetFnosMilkTeaAutoHireRuntime();
    accountSnapshot = { fnosMilkTeaAutoHire: { enabled: true, durationId: 1 } };
    const mt = fakeMilkTea({ shop: { level: 1, slots: [] }, balances: { 1041: 1000 }, listsById: { 1: { wage_total: '40', friends: [friend(5)] } } });
    let calls = 0;
    mt.operateMilkTeaActivity = async () => { calls++; throw new Error('该员工当前不可雇佣'); };
    const t0 = Date.now();
    await runMilkTeaAutoHireTick({ milkTea: mt, nowMs: t0 });
    await runMilkTeaAutoHireTick({ milkTea: mt, nowMs: t0 + 60_000 });
    assert.equal(calls, 1);
});

// [fnos-fork] 2026.10.22 雇人检测改为每 10 分钟一次
test('检测间隔：常规/跳过/失败/未开业都是 10 分钟后再查；员工位满时精确到最早下班后 30 秒', async () => {
    const MIN = 60_000;
    assert.equal(MILK_TEA_HIRE_CHECK_INTERVAL_MS, 10 * MIN);
    accountSnapshot = { fnosMilkTeaAutoHire: { enabled: true, durationId: 1 } };
    const t0 = 1_000_000_000_000;
    const reads = mt => { let n = 0; const g = mt.getMilkTeaActivity; mt.getMilkTeaActivity = async (...a) => { n++; return g(...a); }; return () => n; };

    // 雇佣成功 → 10 分钟后
    resetFnosMilkTeaAutoHireRuntime();
    let mt = fakeMilkTea({ shop: { level: 1, slots: [] }, balances: { 1041: 1000 }, listsById: { 1: { wage_total: '40', friends: [friend(5)] } } });
    assert.equal(await runMilkTeaAutoHireTick({ milkTea: mt, nowMs: t0 }), 1);
    assert.equal(getFnosMilkTeaAutoHireNextCheckAtMs(), t0 + 10 * MIN);

    // 无人可雇（跳过）→ 10 分钟（原 15 分钟）；9 分钟时不读、10 分钟时再读
    resetFnosMilkTeaAutoHireRuntime();
    mt = fakeMilkTea({ shop: { level: 1, slots: [] }, balances: { 1041: 1000 }, listsById: { 1: { friends: [] } } });
    const n = reads(mt);
    await runMilkTeaAutoHireTick({ milkTea: mt, nowMs: t0 });
    assert.equal(getFnosMilkTeaAutoHireNextCheckAtMs(), t0 + 10 * MIN);
    await runMilkTeaAutoHireTick({ milkTea: mt, nowMs: t0 + 9 * MIN });
    assert.equal(n(), 1);
    await runMilkTeaAutoHireTick({ milkTea: mt, nowMs: t0 + 10 * MIN });
    assert.equal(n(), 2);

    // 奶茶券不足 / 雇佣失败 / 读取失败 → 10 分钟（原 30 分钟）
    resetFnosMilkTeaAutoHireRuntime();
    mt = fakeMilkTea({ shop: { level: 1, slots: [] }, balances: { 1041: 1 }, listsById: { 1: { wage_total: '40', friends: [friend(5)] } } });
    await runMilkTeaAutoHireTick({ milkTea: mt, nowMs: t0 });
    assert.equal(getFnosMilkTeaAutoHireNextCheckAtMs(), t0 + 10 * MIN);
    resetFnosMilkTeaAutoHireRuntime();
    mt.getMilkTeaActivity = async () => { throw new Error('网络错误'); };
    logs.length = 0;
    await runMilkTeaAutoHireTick({ milkTea: mt, nowMs: t0 });
    assert.equal(getFnosMilkTeaAutoHireNextCheckAtMs(), t0 + 10 * MIN);
    assert.ok(logs.some(l => l.includes('10 分钟后再试')), logs.join('\n'));

    // 未开业 → 10 分钟（原 1 小时）
    resetFnosMilkTeaAutoHireRuntime();
    mt = fakeMilkTea({ shop: null, balances: {}, listsById: {} });
    await runMilkTeaAutoHireTick({ milkTea: mt, nowMs: t0 });
    assert.equal(getFnosMilkTeaAutoHireNextCheckAtMs(), t0 + 10 * MIN);

    // 员工位满 → 精确到最早下班后 30 秒（保留）
    resetFnosMilkTeaAutoHireRuntime();
    mt = fakeMilkTea({ shop: { level: 1, slots: [{ slot_index: 0, end_at: NOW + 3 * 3600 }] }, balances: { 1041: 1000 }, listsById: { 1: { friends: [friend(5)] } } });
    await runMilkTeaAutoHireTick({ milkTea: mt, nowMs: t0 });
    assert.equal(getFnosMilkTeaAutoHireNextCheckAtMs(), t0 + (3 * 3600 + 30) * 1000);

    // 重复的跳过原因仍去重：连续多轮无人可雇只记一次
    resetFnosMilkTeaAutoHireRuntime();
    logs.length = 0;
    mt = fakeMilkTea({ shop: { level: 1, slots: [] }, balances: { 1041: 1000 }, listsById: { 1: { friends: [] } } });
    for (let i = 0; i < 6; i++) await runMilkTeaAutoHireTick({ milkTea: mt, nowMs: t0 + i * 10 * MIN });
    assert.equal(logs.filter(l => l.includes('跳过')).length, 1, logs.join('\n'));
});

test('调度：每分钟本地判断，未到检查时间不进入自动化队列', async () => {
    accountSnapshot = { fnosMilkTeaAutoHire: { enabled: true, durationId: 1 } };
    const tasks = [];
    const sched = { setTimeoutTask: (name, ms, fn) => tasks.push({ name, ms, fn }), setIntervalTask: (name, ms, fn) => tasks.push({ name, ms, fn, interval: true }) };
    let queued = 0;
    startFnosMilkTeaAutoHire(sched, async (_n, fn) => { queued++; return fn(); });
    const iv = tasks.find(t => t.name === 'fnos_milk_tea_auto_hire');
    assert.equal(iv.ms, 60_000);
    assert.ok(tasks.some(t => t.name === 'fnos_milk_tea_auto_hire_first' && t.ms === 90_000));
    // 模拟刚检查过：10 分钟内的每分钟 tick 不排队
    const mt = fakeMilkTea({ shop: { level: 1, slots: [] }, balances: { 1041: 1000 }, listsById: { 1: { friends: [] } } });
    await runMilkTeaAutoHireTick({ milkTea: mt, nowMs: Date.now() });
    await iv.fn();
    assert.equal(queued, 0);
    accountSnapshot = { fnosMilkTeaAutoHire: { enabled: false } };
    resetFnosMilkTeaAutoHireRuntime();
    await iv.fn();
    assert.equal(queued, 0);
});
