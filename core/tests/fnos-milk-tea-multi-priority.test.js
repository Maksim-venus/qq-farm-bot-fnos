// [fnos-fork] 2026-10-27：奶茶自动雇佣「优先雇佣人」可多选（有序列表 priorityFriends），旧单个字段兼容。真实 store，不 mock 配置读取。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-milk-tea-multi-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '3';

const dist = rel => require.resolve(path.join('..', 'dist', rel));
const logs = [];
const realUtils = require('../dist/utils/utils');
require.cache[dist('utils/utils')] = { id: dist('utils/utils'), filename: dist('utils/utils'), loaded: true,
    exports: { ...realUtils, getServerTimeSec: () => NOW, log: (t, m) => logs.push(`${t}|${m}`), logWarn: (t, m) => logs.push(`${t}|WARN|${m}`) } };

const NOW = 1_792_000_000;
const A = 4300000001;
const B = 4300000002;
const C = 4300000003;
const MASTER = 1280585737;
const store = require('../dist/models/store');
const hire = require('../dist/services/fnos-milk-tea-auto-hire');
const { onWorkerConfigApplied, readFnosForkConfigs } = require('../dist/services/fnos-fork-config');
const apply = snap => { store.applyConfigSnapshot(snap, { persist: false, accountId: '3' }); onWorkerConfigApplied(); };
const friend = (gid, extra = {}) => ({ friend: { gid: String(gid), name: `F${gid}` }, talent_id: 9001, state: 0, rehire_available_at: '0', ...extra });
const PF = [{ gid: A, name: '阿一' }, { gid: B, name: '阿二' }, { gid: C, name: '阿三' }];

/** 两个空位（3 级店）；busy 里的人已被雇；雇成功后该好友在列表里变成已被雇 */
function fakeMilkTea(busyGids = [], level = 3) {
    const hires = [];
    const hired = new Set();
    return {
        hires,
        getMilkTeaActivity: async (_p, input) => ({
            active: true, settling: false, serverTime: NOW, settleStartTime: NOW + 200000, summary: { shop_open_at: '1' },
            shop: { level, slots: [] }, balances: { 1041: 1000 },
            hire: { duration_id: input.durationId, wage_total: { 1: '40', 2: '130', 3: '270' }[input.durationId],
                friends: [A, B, C, MASTER, 5].map(g => friend(g, { state: busyGids.includes(g) || hired.has(String(g)) ? 2 : 0 })) },
        }),
        operateMilkTeaActivity: async (_a, input) => { hired.add(input.targetGid); hires.push({ durationId: input.durationId, target: input.targetGid }); return {}; },
    };
}

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('normalize：旧单个 priorityGid → 一人列表；新列表去重/去无效/最多 20 人，旧字段同步为第一位', () => {
    const n = hire.normalizeFnosMilkTeaAutoHire;
    let c = n({ priorityGid: A, priorityName: '阿一' });
    assert.deepEqual(c.priorityFriends, [{ gid: A, name: '阿一' }]);
    assert.equal(c.priorityGid, A);
    c = n({ priorityFriends: [{ gid: B, name: '阿二' }, { gid: String(A), name: '阿一' }, { gid: B, name: 'dup' }, { gid: 'x' }, { gid: -1 }], priorityGid: C });
    assert.deepEqual(c.priorityFriends, [{ gid: B, name: '阿二' }, { gid: A, name: '阿一' }], '新字段优先，忽略旧字段');
    assert.equal(c.priorityGid, B);
    assert.equal(c.priorityName, '阿二');
    c = n({ priorityFriends: [], priorityGid: A });
    assert.deepEqual(c.priorityFriends, []);
    assert.equal(c.priorityGid, 0, '清空列表时旧字段也清零');
    const many = Array.from({ length: 30 }, (_, i) => ({ gid: 1000 + i, name: `x${i}` }));
    assert.equal(n({ priorityFriends: many }).priorityFriends.length, hire.MAX_PRIORITY_FRIENDS);
    assert.equal(hire.MAX_PRIORITY_FRIENDS, 20);
    assert.equal(n({ priorityFriends: [{ gid: A, name: 'n'.repeat(100) }] }).priorityFriends[0].name.length, 64);
});

test('normalize：请求没带优先雇佣人字段时沿用传入的当前配置（POST 不清空已保存的列表）', () => {
    const base = { ...hire.DEFAULT_FNOS_MILK_TEA_AUTO_HIRE, priorityFriends: PF };
    const c = hire.normalizeFnosMilkTeaAutoHire({ enabled: true, durationId: 2 }, base);
    assert.deepEqual(c.priorityFriends, PF);
    assert.equal(c.priorityGid, A);
    assert.equal(c.durationId, 2);
    const cleared = hire.normalizeFnosMilkTeaAutoHire({ enabled: true, priorityFriends: [] }, base);
    assert.deepEqual(cleared.priorityFriends, [], '明确传空列表才清空');
});

test('planOneHire：按顺序雇第一个空闲的；排除已在本店上班的；都不空闲时随机雇其他好友（不选列表里的人）', async () => {
    const cfg = { enabled: true, durationId: 2, priorityFriends: PF, priorityGid: A, priorityName: '阿一', priorityConfigured: true, talentId: 0, allowRobots: false };
    const list = busy => async id => ({ duration_id: id, wage_total: '130', friends: [A, B, C, 5].map(g => friend(g, { state: busy.includes(g) ? 2 : 0 })) });
    let plan = await hire.planOneHire({ cfg, remainBizSec: 200000, nowSec: NOW, getHireList: list([]) });
    assert.equal(plan.choice.targetGid, A);
    assert.match(plan.choice.reason, /优先雇佣人 阿一（第 1 位）当前空闲/);
    plan = await hire.planOneHire({ cfg, remainBizSec: 200000, nowSec: NOW, getHireList: list([A]) });
    assert.equal(plan.choice.targetGid, B);
    assert.match(plan.choice.reason, /阿二（第 2 位）/);
    plan = await hire.planOneHire({ cfg, remainBizSec: 200000, nowSec: NOW, excludeGids: [B], getHireList: list([A]) });
    assert.equal(plan.choice.targetGid, C);
    plan = await hire.planOneHire({ cfg, remainBizSec: 200000, nowSec: NOW, getHireList: list([A, B, C]) });
    assert.equal(plan.choice.targetGid, 5);
    assert.match(plan.choice.reason, /优先雇佣人都不空闲/);
    plan = await hire.planOneHire({ cfg, remainBizSec: 200000, nowSec: NOW, getHireList: async () => ({ friends: [A, B, C].map(g => friend(g, { state: g === A ? 2 : 0, rehire_available_at: g === A ? '0' : String(NOW + 60) })) }) });
    assert.ok(plan.skip, '列表里的人冷却中、没有其他好友 → 跳过，不硬雇');
});

test('一轮检查：两个空位按列表顺序依次雇空闲的优先雇佣人（跳过已被雇的），时长不变', async () => {
    apply({ fnosAltAccount: { enabled: false }, fnosMilkTeaAutoHire: { enabled: true, priorityConfigured: true, priorityFriends: PF, durationId: 1 } });
    hire.resetFnosMilkTeaAutoHireRuntime();
    logs.length = 0;
    const mt = fakeMilkTea([A]);
    assert.equal(await hire.runMilkTeaAutoHireTick({ milkTea: mt, force: true }), 2);
    assert.deepEqual(mt.hires, [{ durationId: 1, target: String(B) }, { durationId: 1, target: String(C) }]);
    assert.ok(logs.some(l => l.includes('阿二（第 2 位）当前空闲')), logs.join('\n'));
});

test('一轮检查：列表只剩一个空闲 → 先雇他，剩下的空位随机雇其他好友', async () => {
    apply({ fnosMilkTeaAutoHire: { enabled: true, priorityConfigured: true, priorityFriends: PF, durationId: 2 } });
    hire.resetFnosMilkTeaAutoHireRuntime();
    const mt = fakeMilkTea([A, B]);
    assert.equal(await hire.runMilkTeaAutoHireTick({ milkTea: mt, force: true }), 2);
    assert.deepEqual(mt.hires[0], { durationId: 2, target: String(C) });
    assert.ok([String(MASTER), '5'].includes(mt.hires[1].target), mt.hires[1].target);
});

test('旧配置（只有 priorityGid）照常工作；保存后持久化含 priorityFriends 与旧字段（第一位）', async () => {
    apply({ fnosMilkTeaAutoHire: { enabled: true, priorityConfigured: true, priorityGid: B, priorityName: '阿二', durationId: 2 } });
    hire.resetFnosMilkTeaAutoHireRuntime();
    const mt = fakeMilkTea([], 1);
    assert.equal(await hire.runMilkTeaAutoHireTick({ milkTea: mt, force: true }), 1);
    assert.deepEqual(mt.hires, [{ durationId: 2, target: String(B) }]);
    const eff = hire.resolveEffectiveHireConfig(store.getConfigSnapshot('3').fnosMilkTeaAutoHire, store.getConfigSnapshot('3').fnosAltAccount);
    assert.deepEqual(eff.priorityFriends, [{ gid: B, name: '阿二' }]);

    store.applyConfigSnapshot({ fnosMilkTeaAutoHire: hire.normalizeFnosMilkTeaAutoHire({ enabled: true, priorityFriends: PF, priorityConfigured: true }) }, { accountId: '3' });
    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'account-configs', '3.json'), 'utf8')).fnosMilkTeaAutoHire;
    assert.deepEqual(saved.priorityFriends, PF);
    assert.equal(saved.priorityGid, A, '降级到旧版时仍有第一位');
    assert.equal(saved.priorityName, '阿一');
});

test('未保存过新卡片的老小号配置：列表迁移为 [大号]', () => {
    const eff = hire.resolveEffectiveHireConfig({ enabled: true, durationId: 1 }, { enabled: true, masterGid: MASTER, masterName: 'Maksim' });
    assert.deepEqual(eff.priorityFriends, [{ gid: MASTER, name: 'Maksim' }]);
    assert.equal(eff.migratedFromAlt, true);
});

test('设置摘要：多人时列出顺序与提示', () => {
    apply({ fnosMilkTeaAutoHire: { enabled: true, priorityConfigured: true, priorityFriends: PF, durationId: 2 } });
    const out = readFnosForkConfigs();
    assert.deepEqual(out.tea.priorityFriends, PF);
});
