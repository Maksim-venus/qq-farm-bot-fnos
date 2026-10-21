// [fnos-fork] 2026.10.21.2：奶茶自动雇佣「优先雇佣人」与大小号解耦，及老配置迁移。真实 store，不 mock 配置读取。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-milk-tea-priority-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '3';

const dist = rel => require.resolve(path.join('..', 'dist', rel));
const logs = [];
const realUtils = require('../dist/utils/utils');
require.cache[dist('utils/utils')] = { id: dist('utils/utils'), filename: dist('utils/utils'), loaded: true,
    exports: { ...realUtils, getServerTimeSec: () => NOW, log: (t, m) => logs.push(`${t}|${m}`), logWarn: (t, m) => logs.push(`${t}|WARN|${m}`) } };

const NOW = 1_792_000_000;
const PRIORITY = 4300000777;
const MASTER = 1280585737;
const store = require('../dist/models/store');
const hire = require('../dist/services/fnos-milk-tea-auto-hire');
const { onWorkerConfigApplied } = require('../dist/services/fnos-fork-config');
const apply = snap => { store.applyConfigSnapshot(snap, { persist: false, accountId: '3' }); onWorkerConfigApplied(); };
const friend = (gid, extra = {}) => ({ friend: { gid: String(gid), name: `F${gid}` }, talent_id: 9001, state: 0, rehire_available_at: '0', ...extra });

function fakeMilkTea(busyGids = []) {
    const hires = [];
    return {
        hires,
        getMilkTeaActivity: async (_p, input) => ({
            active: true, settling: false, serverTime: NOW, settleStartTime: NOW + 200000, summary: { shop_open_at: '1' },
            shop: { level: 1, slots: [] }, balances: { 1041: 1000 },
            hire: { duration_id: input.durationId, wage_total: { 1: '40', 2: '130', 3: '270' }[input.durationId],
                friends: [PRIORITY, MASTER, 5].map(g => friend(g, { state: busyGids.includes(g) ? 2 : 0 })) },
        }),
        operateMilkTeaActivity: async (action, input) => { hires.push({ durationId: input.durationId, target: input.targetGid }); return {}; },
    };
}

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('不是小号也能用：优先雇佣人空闲 → 按统一的雇佣时长雇他', async () => {
    apply({ fnosAltAccount: { enabled: false }, fnosMilkTeaAutoHire: { enabled: true, priorityConfigured: true, priorityGid: PRIORITY, priorityName: '阿七', durationId: 2 } });
    hire.resetFnosMilkTeaAutoHireRuntime();
    const mt = fakeMilkTea();
    assert.equal(await hire.runMilkTeaAutoHireTick({ milkTea: mt, force: true }), 1);
    assert.deepEqual(mt.hires, [{ durationId: 2, target: String(PRIORITY) }]);
    assert.ok(logs.some(l => l.includes('已雇佣 F4300000777') && l.includes('12 小时') && l.includes('优先雇佣人 阿七当前空闲')), logs.join('\n'));
});

test('优先雇佣人已被雇 → 同一个雇佣时长雇随机好友（不会选优先雇佣人）', async () => {
    apply({ fnosMilkTeaAutoHire: { enabled: true, priorityConfigured: true, priorityGid: PRIORITY, durationId: 1 } });
    hire.resetFnosMilkTeaAutoHireRuntime();
    const mt = fakeMilkTea([PRIORITY]);
    await hire.runMilkTeaAutoHireTick({ milkTea: mt, force: true, });
    assert.equal(mt.hires.length, 1);
    assert.equal(mt.hires[0].durationId, 1);
    assert.notEqual(mt.hires[0].target, String(PRIORITY));
});

test('未指定优先雇佣人 → 按「雇佣时长」随机雇好友；新卡片保存过（priorityConfigured）后不再参考小号设置', async () => {
    apply({ fnosAltAccount: { enabled: true, masterGid: MASTER, masterName: 'Maksim', timeoutMinutes: 10 },
        fnosMilkTeaAutoHire: { enabled: true, priorityConfigured: true, priorityGid: 0, durationId: 2 } });
    hire.resetFnosMilkTeaAutoHireRuntime();
    const mt = fakeMilkTea([5, PRIORITY]);
    await hire.runMilkTeaAutoHireTick({ milkTea: mt, force: true });
    assert.deepEqual(mt.hires, [{ durationId: 2, target: String(MASTER) }]);
    const eff = hire.resolveEffectiveHireConfig(store.getConfigSnapshot('3').fnosMilkTeaAutoHire, store.getConfigSnapshot('3').fnosAltAccount);
    assert.equal(eff.migratedFromAlt, false);
    assert.equal(eff.priorityGid, 0);
});

test('老配置迁移：store.json 里旧版小号 + 自动雇佣（无优先雇佣人字段）→ 优先雇大号，时长沿用该账号的雇佣时长', async () => {
    // 模拟 2026.10.21.2 之前写入 store.json 的配置（新进程读回）
    store.applyConfigSnapshot({ fnosAltAccount: { enabled: true, masterGid: MASTER, masterName: 'Maksim', timeoutMinutes: 10 } }, { accountId: '9' });
    const file = path.join(DATA_DIR, 'store.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.accountConfigs['9'].fnosMilkTeaAutoHire = { enabled: true, durationId: 2, talentId: 0, allowRobots: false };
    fs.writeFileSync(file, JSON.stringify(raw));
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, ['-e', `const s=require(${JSON.stringify(path.join(__dirname, '../dist/models/store'))});const h=require(${JSON.stringify(path.join(__dirname, '../dist/services/fnos-milk-tea-auto-hire'))});const c=s.getConfigSnapshot('9');console.log(JSON.stringify(h.resolveEffectiveHireConfig(c.fnosMilkTeaAutoHire,c.fnosAltAccount)))`], { env: { ...process.env, QQ_FARM_DATA_DIR: DATA_DIR } }).toString().trim().split('\n').pop();
    const eff = JSON.parse(out);
    assert.equal(eff.migratedFromAlt, true);
    assert.equal(eff.priorityGid, MASTER);
    assert.equal(eff.priorityName, 'Maksim');
    assert.equal(eff.durationId, 2, '时长沿用原配置，不强制 24 小时');
    assert.equal(eff.priorityDurationId, undefined);

    // 本进程按同样的老配置跑一轮：两个空位（3 级店）→ 大号 + 其他人，都用该账号的 4 小时设置
    apply({ fnosAltAccount: { enabled: true, masterGid: MASTER, masterName: 'Maksim', timeoutMinutes: 10 },
        fnosMilkTeaAutoHire: { enabled: true, priorityConfigured: false, priorityGid: 0, durationId: 1 } });
    hire.resetFnosMilkTeaAutoHireRuntime();
    let masterHired = false;
    const mt = fakeMilkTea();
    const base = mt.getMilkTeaActivity;
    mt.getMilkTeaActivity = async (p, input) => {
        const r = await base(p, input);
        r.shop = { level: 3, slots: [] };
        r.hire.friends = r.hire.friends.map(f => (Number(f.friend.gid) === MASTER && masterHired ? { ...f, state: 2 } : f));
        return r;
    };
    const op = mt.operateMilkTeaActivity;
    mt.operateMilkTeaActivity = async (a, input) => { if (input.targetGid === String(MASTER)) masterHired = true; return op(a, input); };
    assert.equal(await hire.runMilkTeaAutoHireTick({ milkTea: mt, force: true }), 2);
    assert.deepEqual(mt.hires[0], { durationId: 1, target: String(MASTER) });
    assert.equal(mt.hires[1].durationId, 1);
    assert.notEqual(mt.hires[1].target, String(MASTER));
});
