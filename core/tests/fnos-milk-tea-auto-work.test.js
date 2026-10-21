// [fnos-fork] 2026.10.21.1：本账号被雇佣时自动做奶茶「工作事项」。
// 真实 store（不 mock 配置读取）、真实 services/milk-tea（含上游提交前复核），只模拟网络与背包。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-milk-tea-work-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '5';

const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/activitypb.proto'), { keepCase: true });
const types = Object.fromEntries(['MilkTeaGetGroupReply', 'MilkTeaOperateReply', 'MilkTeaOperateRequest', 'GetGroupRequest'].map(name => [name, root.lookupType(`gamepb.activitypb.${name}`)]));
const encode = (type, data) => Buffer.from(type.encode(type.fromObject(data)).finish());
const dist = rel => require.resolve(path.join('..', 'dist', rel));
const mock = (rel, exports) => { const id = dist(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };

const NOW = 1792032000;
const now = NOW;
const logs = [];
const writes = [];
const st = {};
function reset() {
    st.shopOpen = true;
    st.settling = false;
    st.interactCount = 0;
    st.interactDone = false;
    st.hasShift = true;
    st.failInteract = false;
    writes.length = 0;
    logs.length = 0;
}
reset();
const MASTER_BOSS = 4300000001;
function shift() {
    return { employer: { gid: MASTER_BOSS, name: '小号' }, shop_name: '小号的店', shift_id: 777, talent_id: 9001, begin_at: NOW - 3600, end_at: NOW - 3600 + 86400,
        interact_count: st.interactCount, interact_limit: 1, wage_total: 270, interact_previews: [{ interaction_type: 1, promote_cups: 40 }] };
}

mock('utils/proto', { types });
const realUtils = require('../dist/utils/utils');
mock('utils/utils', { ...realUtils, getServerTimeSec: () => now, log: (t, m) => logs.push(`${t}|${m}`), logWarn: (t, m) => logs.push(`${t}|WARN|${m}`) });
mock('services/pay', { getDiamondBalance: async () => 0 });
mock('services/warehouse', { getBag: async () => ({ items: [{ id: 1041, count: 10 }] }), getBagItems: b => b.items, isItemLocked: () => false });
mock('utils/network', { sendMsgAsync: async (_s, method, body) => {
    if (method === 'GetGroup') {
        const milk = { head: { activity_id: '2026110101', name: '奶茶热销中', begin_time: NOW - 86400, end_time: NOW + 86400 * 20,
            settle_start_time: st.settling ? now - 10 : NOW + 86400 * 18 }, milk_tea: { summary: { shop_open_at: st.shopOpen ? NOW - 100 : 0, level: 1 } } };
        return { body: encode(types.MilkTeaGetGroupReply, { group: { head: { activity_id: '2026110100' }, children: [milk] } }) };
    }
    const req = types.MilkTeaOperateRequest.toObject(types.MilkTeaOperateRequest.decode(body), { longs: String });
    const cmd = Number(req.operate_type);
    let field; let result;
    if (cmd === 63) { field = 'milk_tea_get_work_page'; result = { my_shift: st.hasShift ? shift() : null, slips: [], talent_id: 9001, interact_done: st.interactDone }; }
    else if (cmd === 65) {
        field = 'milk_tea_interact';
        writes.push({ target: String(req.milk_tea_interact.target_gid), type: Number(req.milk_tea_interact.interaction_type) });
        if (st.failInteract) throw new Error('服务器繁忙');
        st.interactCount = 1; st.interactDone = true;
        result = { interaction_type: req.milk_tea_interact.interaction_type, success: true, interaction_id: 90011, friend: { bonus_amount: 54 } };
    } else throw new Error(`unexpected ${cmd}`);
    return { body: encode(types.MilkTeaOperateReply, { activity_id: req.activity_id, operate_type: cmd, [field]: result }) };
} });

const store = require('../dist/models/store');
const work = require('../dist/services/fnos-milk-tea-auto-work');
const { onWorkerConfigApplied, readFnosForkConfigs, logFnosForkStatus } = require('../dist/services/fnos-fork-config');
const hire = require('../dist/services/fnos-milk-tea-auto-hire');
const workerApply = snap => { store.applyConfigSnapshot(snap, { persist: false, accountId: '5' }); onWorkerConfigApplied(); };

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('默认关闭：真实 store 读到 autoWork=false，不发请求', async () => {
    reset();
    assert.equal(readFnosForkConfigs().tea.autoWork, false);
    work.resetFnosMilkTeaAutoWorkRuntime();
    assert.equal(await work.runMilkTeaAutoWorkTick({ nowMs: 1 }), false);
    assert.equal(writes.length, 0);
});

test('开启（自动雇佣开关可以关着）：为老板提交指定事项（操作号 65，target_gid=雇主），中文日志；本班次不再重复', async () => {
    reset();
    work.resetFnosMilkTeaAutoWorkRuntime();
    workerApply({ fnosMilkTeaAutoHire: { enabled: false, autoWork: true, workType: 1 } });
    assert.deepEqual(readFnosForkConfigs().tea, { enabled: false, durationId: 0, priorityGid: 0, priorityName: '', priorityConfigured: false, talentId: 0, allowRobots: false, autoWork: true, workType: 1 });
    logs.length = 0;
    assert.equal(await work.runMilkTeaAutoWorkTick({ nowMs: 1000 }), true);
    assert.deepEqual(writes, [{ target: String(MASTER_BOSS), type: 1 }]);
    assert.ok(logs.some(l => l.startsWith('奶茶工作|工作事项已完成：为老板 小号 做「宣传推广」，成功') && l.includes('工资奖金 +54 奶茶券')), logs.join('\n'));
    // 做完后等到班次结束才再查
    assert.equal(await work.runMilkTeaAutoWorkTick({ nowMs: 1000 + 3600 * 1000 }), false);
    work.resetFnosMilkTeaAutoWorkRuntime();
    logs.length = 0;
    await work.runMilkTeaAutoWorkTick({ nowMs: 1000 });
    await work.runMilkTeaAutoWorkTick({ nowMs: 1000 + 25 * 3600 * 1000 });
    assert.equal(writes.length, 1);
    assert.deepEqual(logs, ['奶茶工作|工作事项跳过：本班次（老板 小号）工作事项已做过']);
});

test('随机只在无风险的 1/2/3 里选；未被雇佣、未开业、结算期只记一次跳过', async () => {
    reset();
    work.resetFnosMilkTeaAutoWorkRuntime();
    workerApply({ fnosMilkTeaAutoHire: { autoWork: true, workType: 0 } });
    await work.runMilkTeaAutoWorkTick({ nowMs: 1000, random: () => 0.99 });
    assert.equal(writes.length, 1);
    assert.ok([1, 2, 3].includes(writes[0].type));
    for (let i = 0; i < 50; i++) {
        const r = work.chooseWorkType(0, [1, 2, 3, 4, 5].map(id => ({ interaction_id: id, ready: true })), () => i / 50);
        assert.ok([1, 2, 3].includes(r.type));
    }
    assert.ok('skip' in work.chooseWorkType(3, [{ interaction_id: 3, ready: false }]));

    for (const [setup, expect] of [
        [() => { st.hasShift = false; }, '当前没有兼职班次（未被雇佣）'],
        [() => { st.shopOpen = false; }, '本账号的奶茶店尚未开业（游戏要求先开业才能提交工作事项）'],
        [() => { st.settling = true; }, '奶茶活动结算期，不能做工作事项'],
    ]) {
        reset();
        setup();
        work.resetFnosMilkTeaAutoWorkRuntime();
        await work.runMilkTeaAutoWorkTick({ nowMs: 1000 });
        await work.runMilkTeaAutoWorkTick({ nowMs: 1000 + 7 * 3600 * 1000 });
        assert.equal(writes.length, 0);
        assert.deepEqual(logs, [`奶茶工作|工作事项跳过：${expect}`]);
    }
});

test('提交失败写警告且 10 分钟内不重试；同一失败不重复写', async () => {
    reset();
    st.failInteract = true;
    work.resetFnosMilkTeaAutoWorkRuntime();
    workerApply({ fnosMilkTeaAutoHire: { autoWork: true, workType: 2 } });
    logs.length = 0;
    await work.runMilkTeaAutoWorkTick({ nowMs: 1000 });
    await work.runMilkTeaAutoWorkTick({ nowMs: 1000 + 9 * 60 * 1000 });
    assert.equal(writes.length, 1);
    await work.runMilkTeaAutoWorkTick({ nowMs: 1000 + 10 * 60 * 1000 });
    assert.equal(writes.length, 2);
    await work.runMilkTeaAutoWorkTick({ nowMs: 1000 + 20 * 60 * 1000 });
    assert.equal(writes.length, 3);
    assert.equal(logs.filter(l => l.includes('WARN')).length, 1, logs.join('\n'));
    assert.ok(logs[0].includes('为老板 小号 做「花式摇杯」失败'), logs.join('\n'));
    assert.ok(logs[0].includes('10 分钟后再试'), logs.join('\n'));
});

// [fnos-fork] 2026.10.22 工作事项检测统一 10 分钟
test('检测间隔：未被雇佣/未开业 10 分钟后再查；已做过等到班次结束', async () => {
    const MIN = 60 * 1000;
    for (const setup of [() => { st.hasShift = false; }, () => { st.shopOpen = false; }]) {
        reset();
        setup();
        work.resetFnosMilkTeaAutoWorkRuntime();
        workerApply({ fnosMilkTeaAutoHire: { autoWork: true, workType: 1 } });
        await work.runMilkTeaAutoWorkTick({ nowMs: 1000 });
        // 9 分钟内不再读取；10 分钟时改为可做 → 立即提交
        st.hasShift = true; st.shopOpen = true;
        await work.runMilkTeaAutoWorkTick({ nowMs: 1000 + 9 * MIN });
        assert.equal(writes.length, 0);
        await work.runMilkTeaAutoWorkTick({ nowMs: 1000 + 10 * MIN });
        assert.equal(writes.length, 1);
    }
    // 已做过：等到班次结束（约 23 小时后）才再查，期间不提交
    await work.runMilkTeaAutoWorkTick({ nowMs: 1000 + 10 * MIN + 20 * 3600 * 1000 });
    assert.equal(writes.length, 1);
});

test('启动挂上调度；设置变化约 5 秒后检查；状态日志包含工作事项', async () => {
    const tasks = [];
    const sched = { setTimeoutTask: (name, ms, fn) => tasks.push({ name, ms, fn }), setIntervalTask: (name, ms, fn) => tasks.push({ name, ms, fn, interval: true }) };
    hire.startFnosMilkTeaAutoHire(sched, async (_n, fn) => fn());
    assert.ok(tasks.some(t => t.name === 'fnos_milk_tea_auto_work_first' && t.ms <= 10000));
    assert.ok(tasks.some(t => t.name === 'fnos_milk_tea_auto_work' && t.interval));
    tasks.length = 0;
    logs.length = 0;
    workerApply({ fnosMilkTeaAutoHire: { autoWork: true, workType: 3 } });
    assert.ok(tasks.some(t => t.name === 'fnos_milk_tea_auto_work_first' && t.ms <= 10000), JSON.stringify(tasks.map(t => t.name)));
    assert.ok(logs.some(l => l.startsWith('奶茶雇佣|设置已更新：') && l.includes('被雇佣时自动做工作事项已启用（招牌试饮）')), logs.join('\n'));
    logs.length = 0;
    logFnosForkStatus('账号已登录', true);
    assert.ok(logs.some(l => l.includes('被雇佣时自动做工作事项已启用')), logs.join('\n'));
});

test('持久化：autoWork/workType 写入 store.json 后新进程读回', () => {
    store.applyConfigSnapshot({ fnosMilkTeaAutoHire: { enabled: true, durationId: 1, autoWork: true, workType: 5 } }, { accountId: '6' });
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, ['-e', `const s=require(${JSON.stringify(path.join(__dirname, '../dist/models/store'))});console.log(JSON.stringify(s.getConfigSnapshot('6').fnosMilkTeaAutoHire))`], { env: { ...process.env, QQ_FARM_DATA_DIR: DATA_DIR } }).toString().trim().split('\n').pop();
    assert.deepEqual(JSON.parse(out), { enabled: true, durationId: 1, priorityGid: 0, priorityName: '', priorityConfigured: false, talentId: 0, allowRobots: false, autoWork: true, workType: 5 });
});
