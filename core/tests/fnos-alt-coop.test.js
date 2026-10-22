// [fnos-fork] 2026.10.21.3 大小号协作：不偷大号的菜、只给大号放捣乱。
// 真实 store（不 mock 配置读取）+ 真实 friend/scheduler、visit-plan、visit-strategy，只模拟网络（friend/api）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-alt-coop-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '5';

const dist = rel => require.resolve(path.join('..', 'dist', rel));
const NOW = 1_792_000_000;
const MY_GID = 1001;
const MASTER = 1280585737;
const OTHER = 4300000888;
const logs = [];
const calls = [];

const realUtils = require('../dist/utils/utils');
require.cache[dist('utils/utils')] = { id: dist('utils/utils'), filename: dist('utils/utils'), loaded: true, exports: {
    ...realUtils, getServerTimeSec: () => NOW, randomDelay: async () => {}, sleep: async () => {},
    log: (t, m) => logs.push(`${t}|${m}`), logWarn: (t, m) => logs.push(`${t}|WARN|${m}`),
} };
require.cache[dist('utils/network')] = { id: dist('utils/network'), filename: dist('utils/network'), loaded: true,
    exports: { getUserState: () => ({ gid: MY_GID, accountId: '5', exp: 0 }), networkEvents: new EventEmitter(), sendMsgAsync: async () => { throw new Error('不应直接发网络请求'); } } };
require.cache[dist('services/stats')] = { id: dist('services/stats'), filename: dist('services/stats'), loaded: true, exports: { recordOperation: () => {} } };
require.cache[dist('services/warehouse')] = { id: dist('services/warehouse'), filename: dist('services/warehouse'), loaded: true, exports: { sellAllFruits: async () => {} } };
require.cache[dist('services/career')] = { id: dist('services/career'), filename: dist('services/career'), loaded: true, exports: { getCareerInfo: async () => null, getCareerInfoOrNull: () => null } };

// 上游对同一份土地快照的帮忙有去重缓存，每个用例用不同的 round（第 3 块地的 dry_num）生成不同快照
let round = 0;
// 服务端只下发剩余阶段，phases[0] 为当前阶段
const PLANT = 2020002;
const growing = (id, extra = {}) => ({ id, unlocked: true, plant: { id: PLANT, name: '白萝卜', phases: [{ phase: 2, begin_time: NOW - 100 }, { phase: 6, begin_time: NOW + 50000 }], weed_owners: [], insect_owners: [], ...extra } });
const mature = id => ({ id, unlocked: true, plant: { id: PLANT, name: '白萝卜', stealable: true, phases: [{ phase: 6, begin_time: NOW - 10 }] } });
let farms = {};
let friendsReply = {};
const friendEntry = (gid, name, plant) => ({ gid, name, level: 30, plant });

require.cache[dist('services/friend/api')] = { id: dist('services/friend/api'), filename: dist('services/friend/api'), loaded: true, exports: {
    getAllFriends: async () => friendsReply,
    acceptFriends: async () => ({}), rejectFriends: async () => ({}), getApplications: async () => ({ applications: [] }), delFriend: async () => ({}),
    enterFriendFarm: async (gid) => { calls.push(`enter:${gid}`); return { basic: { gid }, lands: farms[gid] || [] }; },
    leaveFriendFarm: async (gid) => { calls.push(`leave:${gid}`); },
    helpFarming: async (gid, ids) => { calls.push(`help:${gid}:${ids.join(',')}`); return { effect: 'confirmed', operationCount: ids.length, landCount: ids.length, landIds: ids, operationLimits: [], dogSkillGiftCount: 0 }; },
    stealHarvest: async (gid, ids) => { calls.push(`steal:${gid}:${ids.join(',')}`); return {}; },
    putWeeds: async (gid, ids) => { calls.push(`weed:${gid}:${ids.join(',')}`); return ids.length; },
    putInsects: async (gid, ids) => { calls.push(`bug:${gid}:${ids.join(',')}`); return ids.length; },
    putWeedsDetailed: async () => ({ ok: 0, failed: [] }), putInsectsDetailed: async () => ({ ok: 0, failed: [] }),
} };

const store = require('../dist/models/store');
const scheduler = require('../dist/services/friend/scheduler');
const coop = require('../dist/services/friend/fnos-alt-coop');
const { normalizeFnosAltAccount } = require('../dist/services/farm/fnos-alt-account');

function apply(snap) { store.applyConfigSnapshot(snap, { persist: false, accountId: '5' }); }
function setAutomation(patch) {
    const cfg = store.getConfigSnapshot('5');
    apply({ automation: { ...cfg.automation, friend_help_exp_limit: false, ...patch } });
}
function reset() { calls.length = 0; logs.length = 0; coop.resetFnosAltCoopRuntime(); }

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

// [fnos-fork] 上游 2026-10-22 起账号配置拆分为 data/account-configs/<id>.json（store.json 只留公共配置）
function readAccountConfigFile(dataDir, id) {
    const name = /^\d+$/.test(id) ? id : `id-${Buffer.from(id, 'utf8').toString('hex')}`;
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'account-configs', `${name}.json`), 'utf8'));
}

test('配置：新字段默认关闭，保存后从账号配置文件读回', () => {
    assert.deepEqual(normalizeFnosAltAccount(undefined), { enabled: false, masterGid: 0, masterName: '', holdForMaster: true, timeoutMinutes: 0, skipStealMaster: false, badOnlyMaster: false });
    store.applyConfigSnapshot({ fnosAltAccount: { enabled: true, masterGid: MASTER, masterName: 'Maksim', timeoutMinutes: 10, skipStealMaster: true, badOnlyMaster: 1 } }, { accountId: '7' });
    const raw = readAccountConfigFile(DATA_DIR, '7');
    assert.deepEqual(raw.fnosAltAccount, { enabled: true, masterGid: MASTER, masterName: 'Maksim', holdForMaster: true, timeoutMinutes: 10, skipStealMaster: true, badOnlyMaster: true });
    // 只改一个字段时保留其他字段
    store.applyConfigSnapshot({ fnosAltAccount: { badOnlyMaster: false } }, { accountId: '7' });
    assert.equal(store.getConfigSnapshot('7').fnosAltAccount.skipStealMaster, true);
    assert.equal(store.getConfigSnapshot('7').fnosAltAccount.badOnlyMaster, false);
});

function setupFarms() {
    round += 1;
    farms = {
        [MASTER]: [mature(1), growing(2), growing(3, { dry_num: round }), growing(4, { dry_num: 1, weed_owners: [OTHER] })],
        [OTHER]: [mature(1), growing(2)],
    };
    friendsReply = { game_friends: [
        friendEntry(MASTER, 'Maksim', { steal_plant_num: 1, dry_num: 2, weed_num: 1, insect_num: 0 }),
        friendEntry(OTHER, '路人', { steal_plant_num: 1, dry_num: 0, weed_num: 0, insect_num: 0 }),
    ] };
}

test('选项都关：与上游一致，大号和其他好友都偷、帮、放（自动捣乱开着时）', async () => {
    reset(); setupFarms();
    setAutomation({ friend: true, friend_steal: true, friend_help: true, friend_bad: true });
    apply({ fnosAltAccount: { enabled: true, masterGid: MASTER, masterName: 'Maksim', timeoutMinutes: 0, skipStealMaster: false, badOnlyMaster: false } });
    await scheduler.checkFriends();
    assert.ok(calls.includes(`steal:${MASTER}:1`), calls.join('\n'));
    assert.ok(calls.includes(`steal:${OTHER}:1`), calls.join('\n'));
    assert.ok(calls.some(c => c.startsWith(`help:${MASTER}:`) && c.includes('4')), '默认会帮大号除草（含第 4 块）');
});

test('不偷大号的菜：大号不偷，其他好友照偷；帮大号照常', async () => {
    reset(); setupFarms();
    apply({ fnosAltAccount: { skipStealMaster: true, badOnlyMaster: false } });
    await scheduler.checkFriends();
    assert.ok(!calls.some(c => c.startsWith(`steal:${MASTER}`)), calls.join('\n'));
    assert.ok(calls.includes(`steal:${OTHER}:1`), calls.join('\n'));
    assert.ok(calls.some(c => c.startsWith(`help:${MASTER}:`)), calls.join('\n'));
    assert.ok(logs.some(l => l.startsWith('小号|大号 Maksim(1280585737) 有 1 块可偷，按「不偷大号的菜」跳过')), logs.join('\n'));
});

test('只给大号放捣乱：其他好友不放；「自动捣乱」关着也对大号放；帮大号只帮只缺水的地；10 分钟内不重复专门进大号农场', async () => {
    reset(); setupFarms();
    setAutomation({ friend: true, friend_steal: true, friend_help: true, friend_bad: false });
    apply({ fnosAltAccount: { skipStealMaster: true, badOnlyMaster: true } });
    // 其他好友没有偷/帮需求时上游会把他当纯捣乱对象；本选项下不能去
    friendsReply.game_friends.push(friendEntry(4300000999, '纯捣乱候选', { steal_plant_num: 0, dry_num: 0, weed_num: 0, insect_num: 0 }));
    farms[4300000999] = [growing(1)];
    await scheduler.checkFriends();
    assert.ok(!calls.some(c => c.startsWith('weed:4300000999') || c.startsWith('bug:4300000999') || c === 'enter:4300000999'), calls.join('\n'));
    assert.ok(!calls.some(c => c.startsWith(`weed:${OTHER}`) || c.startsWith(`bug:${OTHER}`)), calls.join('\n'));
    assert.ok(calls.includes(`help:${MASTER}:3`), `只帮只缺水的第 3 块：\n${calls.join('\n')}`);
    assert.ok(calls.some(c => c.startsWith(`weed:${MASTER}:`)), calls.join('\n'));
    assert.ok(calls.some(c => c.startsWith(`bug:${MASTER}:`)), calls.join('\n'));
    assert.ok(!calls.some(c => c.startsWith(`steal:${MASTER}`)));

    // 大号没有偷/帮需求时：刚放过（10 分钟内）不再专门进大号农场
    calls.length = 0;
    friendsReply = { game_friends: [friendEntry(MASTER, 'Maksim', { steal_plant_num: 0, dry_num: 0, weed_num: 0, insect_num: 0 })] };
    await scheduler.checkFriends();
    assert.ok(!calls.includes(`enter:${MASTER}`), calls.join('\n'));
    coop.resetFnosAltCoopRuntime();
    await scheduler.checkFriends();
    assert.ok(calls.includes(`enter:${MASTER}`), calls.join('\n'));
});

test('[fnos-fork] 关闭「成熟作物先留给大号偷」不影响「不偷大号的菜」「只给大号放捣乱」', async () => {
    reset(); setupFarms();
    setAutomation({ friend: true, friend_steal: true, friend_help: true, friend_bad: false });
    apply({ fnosAltAccount: { enabled: true, masterGid: MASTER, masterName: 'Maksim', holdForMaster: false, skipStealMaster: true, badOnlyMaster: true } });
    assert.equal(store.getConfigSnapshot('5').fnosAltAccount.holdForMaster, false);
    assert.deepEqual(coop.getAltCoopSettings(), { masterGid: MASTER, masterName: 'Maksim', skipSteal: true, badOnly: true });
    await scheduler.checkFriends();
    assert.ok(!calls.some(c => c.startsWith(`steal:${MASTER}`)), calls.join('\n'));
    assert.ok(calls.includes(`steal:${OTHER}:1`), calls.join('\n'));
    apply({ fnosAltAccount: { holdForMaster: true } });
});

test('不是小号（或没选大号）时选项不生效', async () => {
    reset(); setupFarms();
    setAutomation({ friend: true, friend_steal: true, friend_help: true, friend_bad: true });
    apply({ fnosAltAccount: { enabled: false, skipStealMaster: true, badOnlyMaster: true } });
    await scheduler.checkFriends();
    assert.ok(calls.includes(`steal:${MASTER}:1`), calls.join('\n'));
    assert.equal(coop.getAltCoopSettings(), null);
});

test('adjustVisitPlanForAltCoop：大号不在好友列表时写日志，不影响其他好友', () => {
    reset();
    const plan = { visits: [{ gid: OTHER, wantSteal: true, wantHelp: false, wantBad: false, stealNum: 1 }, { gid: 9, wantSteal: false, wantHelp: false, wantBad: true }] };
    const out = coop.adjustVisitPlanForAltCoop(plan, { coop: { masterGid: MASTER, masterName: '', skipSteal: true, badOnly: true }, friends: [], badActive: true, badBudget: 5, log: m => logs.push(m) });
    assert.deepEqual(out.visits.map(v => v.gid), [OTHER]);
    assert.equal(out.badOnlyCount, 0);
    assert.ok(logs.some(l => l.includes('好友列表里没有大号')));
});
