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
} = require('../dist/services/fnos-milk-tea-auto-hire');

const NOW = 1_792_000_000;
const MASTER = 4300123456;
const friend = (gid, extra = {}) => ({ friend: { gid: String(gid), name: `F${gid}` }, is_robot: false, talent_id: 9001, state: 0, rehire_available_at: '0', ...extra });

test('normalizeFnosMilkTeaAutoHire: 默认关闭、随机时长/不限职业，非法值回到默认', () => {
    assert.deepEqual(normalizeFnosMilkTeaAutoHire(undefined), { enabled: false, durationId: 0, talentId: 0, allowRobots: false });
    assert.deepEqual(normalizeFnosMilkTeaAutoHire({ enabled: true, durationId: '3', talentId: 9002, allowRobots: 1 }),
        { enabled: true, durationId: 3, talentId: 9002, allowRobots: true });
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
const ALT = { enabled: true, masterGid: MASTER, masterName: '大号' };
const CFG = { enabled: true, durationId: 2, talentId: 0, allowRobots: false };

test('planOneHire 小号模式：大号空闲 → 雇大号 24 小时', async () => {
    const plan = await planOneHire({ cfg: CFG, alt: ALT, remainBizSec: 200000, nowSec: NOW, getHireList: async id => lists[id] || { friends: [] } });
    assert.equal(plan.durationId, 3);
    assert.equal(plan.choice.targetGid, MASTER);
    assert.equal(plan.wage, 270);
});

test('planOneHire 小号模式：大号已被雇 → 随机雇其他好友 4 小时', async () => {
    const busy = { 1: lists[1], 3: { ...lists[3], friends: [friend(MASTER, { state: 2 }), friend(5)] } };
    const plan = await planOneHire({ cfg: CFG, alt: ALT, remainBizSec: 200000, nowSec: NOW, getHireList: async id => busy[id] });
    assert.equal(plan.durationId, 1);
    assert.equal(plan.choice.targetGid, 5);
    assert.equal(plan.wage, 40);
    assert.match(plan.choice.reason, /已被雇佣/);
});

test('planOneHire 小号模式：营业时间不够 24 小时时，大号按能雇的最长时长', async () => {
    const seen = [];
    const plan = await planOneHire({ cfg: CFG, alt: ALT, remainBizSec: 20000, nowSec: NOW, getHireList: async id => { seen.push(id); return { ...lists[3], duration_id: id, wage_total: '130' }; } });
    assert.equal(plan.durationId, 2);
    assert.equal(plan.choice.targetGid, MASTER);
    assert.deepEqual(seen, [2]);
});

test('planOneHire 通用模式：按设置时长；随机时长在允许档位内；无人可雇时跳过', async () => {
    const noAlt = { enabled: false, masterGid: 0, masterName: '' };
    let plan = await planOneHire({ cfg: CFG, alt: noAlt, remainBizSec: 200000, nowSec: NOW, getHireList: async id => ({ duration_id: id, wage_total: '130', friends: [friend(7)] }) });
    assert.equal(plan.durationId, 2);
    assert.equal(plan.choice.targetGid, 7);
    plan = await planOneHire({ cfg: { ...CFG, durationId: 0 }, alt: noAlt, remainBizSec: 200000, nowSec: NOW, random: () => 0.99, getHireList: async id => ({ duration_id: id, friends: [friend(7)] }) });
    assert.equal(plan.durationId, 3);
    assert.equal(plan.wage, 270, '回包没有 wage_total 时按官方配置价格');
    plan = await planOneHire({ cfg: CFG, alt: noAlt, remainBizSec: 200000, nowSec: NOW, getHireList: async () => ({ friends: [friend(7, { state: 1 })] }) });
    assert.ok(plan.skip);
    plan = await planOneHire({ cfg: { ...CFG, durationId: 3 }, alt: noAlt, remainBizSec: 20000, nowSec: NOW, getHireList: async () => ({ friends: [friend(7)] }) });
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

test('runMilkTeaAutoHireTick: 小号两个空位 → 先雇大号 24h，再随机雇其他好友 4h，带上预期花费', async () => {
    resetFnosMilkTeaAutoHireRuntime();
    logs.length = 0;
    accountSnapshot = {
        fnosMilkTeaAutoHire: { enabled: true, durationId: 0, talentId: 0 },
        fnosAltAccount: { enabled: true, masterGid: MASTER, masterName: '大号' },
    };
    let masterHired = false;
    const mt = fakeMilkTea({ shop: { level: 3, slots: [] }, balances: { 1041: 1000 }, listsById: {} });
    mt.getMilkTeaActivity = async (_p, input) => ({
        active: true, settling: false, serverTime: NOW, settleStartTime: NOW + 200000, summary: { shop_open_at: '1' },
        shop: { level: 3, slots: [] }, balances: { 1041: 1000 },
        hire: { duration_id: input.durationId, wage_total: input.durationId === 3 ? '270' : '40', friends: [friend(MASTER, { state: masterHired ? 2 : 0 }), friend(5)] },
    });
    mt.operateMilkTeaActivity = async (action, input) => { mt.hires.push({ action, ...input }); if (input.targetGid === String(MASTER)) masterHired = true; return {}; };
    const n = await runMilkTeaAutoHireTick({ milkTea: mt, force: true });
    assert.equal(n, 2);
    assert.deepEqual(mt.hires, [
        { action: 'hire', durationId: 3, targetGid: String(MASTER), expectedCosts: [{ id: 1041, count: 270 }] },
        { action: 'hire', durationId: 1, targetGid: '5', expectedCosts: [{ id: 1041, count: 40 }] },
    ]);
    assert.ok(logs.some(l => l.includes('已雇佣') && l.includes('24 小时')), logs.join('\n'));
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
