// [fnos-fork] 2026-11-16 牧场增强：小号等大号、牧场图鉴、上游好友牧场自动化的大小号规则与额外动作（帮生产 / 加牧草）、设置持久化。
// 真实 store / fnos-fork-config / fnos-ranch，只 mock 网络与日志。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-ranch-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '7';

const dist = rel => require.resolve(path.join('..', 'dist', rel));
const mock = (rel, exports) => { const id = dist(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const logs = [];
const user = { gid: 1001, gold: 0, level: 30 };
const realUtils = require('../dist/utils/utils');
mock('utils/utils', { ...realUtils, log: (tag, msg) => logs.push(`${tag}|${msg}`), logWarn: (tag, msg) => logs.push(`${tag}|WARN|${msg}`) });
mock('utils/network', { getUserState: () => user, getWsErrorState: () => ({}), getWs: () => null, invalidateGameScene: () => {} });

const store = require('../dist/models/store');
const ranch = require('../dist/services/ranch/fnos-ranch');
const apply = cfg => store.applyConfigSnapshot(cfg, { accountId: '7' });

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('normalize：默认值与范围夹取、旧字段（被上游取代）丢弃；真实 store 默认带 fnosRanch', () => {
    const d = ranch.normalizeFnosRanch(undefined);
    assert.deepEqual(d, { altHold: true, altHoldFallbackMinutes: 60, illustratedAutoClaim: false, illustratedAutoComplete: false,
        friendHelpProduce: false, friendFeed: false, friendFeedPerTime: 10, friendFeedGoldKeep: 10000 });
    const c = ranch.normalizeFnosRanch({ altHoldFallbackMinutes: 1, friendFeedPerTime: 0, friendFeedGoldKeep: -5, friendHelpProduce: 1,
        rotation: false, friendSteal: true, friendPutMosquito: true, friendFeedKeep: 200 });
    assert.equal(c.altHoldFallbackMinutes, 5);
    assert.equal(c.friendFeedPerTime, 1);
    assert.equal(c.friendFeedGoldKeep, 0);
    assert.equal(c.friendHelpProduce, true);
    for (const k of ranch.REMOVED_FNOS_RANCH_KEYS) assert.equal(k in c, false, k);
    assert.deepEqual(store.getConfigSnapshot('7').fnosRanch, d);
});

test('decideShelfHold：大号偷过 / 没剩余 / 超时 放行，否则等待', () => {
    const lot = (extra = {}) => ({ can_steal: true, remain_num: 3, stealers: [], ...extra });
    assert.equal(ranch.decideShelfHold({ lots: [lot({ stealers: [9] })] }, 9, 0, 1000, 60_000).reason, 'master_stole');
    assert.equal(ranch.decideShelfHold({ lots: [lot({ remain_num: 0 })] }, 9, 0, 1000, 60_000).reason, 'unstealable');
    assert.equal(ranch.decideShelfHold({ can_steal: false, lots: [lot({ can_steal: false })] }, 9, 0, 1000, 60_000).reason, 'waiting');
    assert.equal(ranch.decideShelfHold({ lots: [lot()] }, 9, 0, 61_000, 60_000).reason, 'timeout');
    const w = ranch.decideShelfHold({ lots: [lot({ stealers: [5] })] }, 9, 0, 10_000, 60_000);
    assert.equal(w.release, false);
    assert.equal(w.waitMs, 50_000);
});

const rawWith = shelves => ({ cells: { facilities: [{ instance_id: '10001', ranch: { shelves, animals: [] } }] } });

test('planOwnHarvest：非小号照常一键收；小号货架等大号时只收动物，超时用农场 timeout，0 时用牧场兜底', () => {
    ranch.resetFnosRanchRuntime();
    const shelf = { slot_index: 1, can_collect: true, can_steal: true, lots: [{ can_steal: true, remain_num: 2, stealers: [] }] };
    assert.equal(ranch.planOwnHarvest(rawWith([shelf]), 0).mode, 'all');

    apply({ fnosAltAccount: { enabled: true, masterGid: 2002, masterName: '大号', holdForMaster: true, timeoutMinutes: 10 } });
    let p = ranch.planOwnHarvest(rawWith([shelf]), 1_000);
    assert.equal(p.mode, 'animals');
    assert.equal(p.held, 1);
    assert.equal(p.wakeAtMs, 1_000 + 10 * 60_000);
    assert.ok(logs.some(l => l.includes('先留给大号')), logs.join('\n'));
    p = ranch.planOwnHarvest(rawWith([shelf]), 1_000 + 10 * 60_000);
    assert.equal(p.mode, 'all');

    ranch.resetFnosRanchRuntime();
    const stolen = { ...shelf, lots: [{ can_steal: true, remain_num: 1, stealers: [2002] }] };
    assert.equal(ranch.planOwnHarvest(rawWith([stolen]), 5).mode, 'all');

    ranch.resetFnosRanchRuntime();
    apply({ fnosAltAccount: { timeoutMinutes: 0 }, fnosRanch: { altHoldFallbackMinutes: 30 } });
    p = ranch.planOwnHarvest(rawWith([shelf]), 0);
    assert.equal(p.wakeAtMs, 30 * 60_000);

    apply({ fnosRanch: { altHold: false } });
    assert.equal(ranch.planOwnHarvest(rawWith([shelf]), 0).mode, 'all');
    apply({ fnosRanch: { altHold: true }, fnosAltAccount: { holdForMaster: false } });
    assert.equal(ranch.planOwnHarvest(rawWith([shelf]), 0).mode, 'all');
    apply({ fnosAltAccount: { enabled: false, holdForMaster: true } });
});

test('pickAnimalForBook：开启且有缺失产物时优先选缺的（最便宜）；否则交还上游', () => {
    const goods = [
        { id: 1, price: { count: 50 }, animal: { id: 60002, product_item: { id: 2060002 } } },
        { id: 2, price: { count: 10 }, animal: { id: 60003, product_item: { id: 2060003 } } },
        { id: 3, price: { count: 5 }, animal: { id: 60001, product_item: { id: 2060001 } } },
    ];
    ranch._rt.uncollectedProducts = new Set([2060002, 2060003]);
    assert.equal(ranch.pickAnimalForBook(goods), null);
    apply({ fnosRanch: { illustratedAutoComplete: true } });
    assert.equal(ranch.pickAnimalForBook(goods).id, 2);
    ranch._rt.uncollectedProducts = new Set();
    assert.equal(ranch.pickAnimalForBook(goods), null);
    apply({ fnosRanch: { illustratedAutoComplete: false } });
});

test('fnosRanch 持久化：新进程读回；磁盘上的旧字段启动时清掉；其他字段不受影响', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-ranch-store-'));
    const env = { ...process.env, QQ_FARM_DATA_DIR: dir };
    delete env.FARM_ACCOUNT_ID;
    const run = script => {
        const r = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    run(`const s=require('./dist/models/store');
        s.applyConfigSnapshot({ fnosIllustratedAuto: { autoClaimRewards: true } }, { accountId: 'a1' });
        s.applyConfigSnapshot({ fnosRanch: { friendFeed: true, friendFeedPerTime: 3, friendHelpProduce: true } }, { accountId: 'a1' });
        s.applyConfigSnapshot({ fnosGrassLands: { count: 4, autoBuy: false } }, { accountId: 'a1' });
        console.log('{}');`);
    // 模拟草稿版写过的旧字段
    const file = fs.readdirSync(path.join(dir, 'account-configs')).map(f => path.join(dir, 'account-configs', f)).find(f => /id-[^.]+\.json$/.test(f));
    assert.ok(file, 'account-configs 文件');
    {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const holder = j.fnosRanch ? j : (j.config || j);
        holder.fnosRanch = { ...holder.fnosRanch, rotation: false, friendSteal: true, friendMaxPerPatrol: 3 };
        fs.writeFileSync(file, JSON.stringify(j));
    }
    const out = run(`const s=require('./dist/models/store');const c=s.getConfigSnapshot('a1');const o=s.getConfigSnapshot('a2');
        console.log(JSON.stringify({ r: c.fnosRanch, g: c.fnosGrassLands, ill: c.fnosIllustratedAuto, or: o.fnosRanch, og: o.fnosGrassLands }));`);
    assert.equal(out.r.friendFeed, true);
    assert.equal(out.r.friendFeedPerTime, 3);
    assert.equal(out.r.friendHelpProduce, true);
    assert.equal('rotation' in out.r, false);
    assert.equal('friendSteal' in out.r, false);
    assert.deepEqual(out.g, { count: 4, autoBuy: false });
    assert.equal(out.ill.autoClaimRewards, true);
    assert.equal(out.or.friendFeed, false);
    assert.deepEqual(out.og, { count: 0, autoBuy: true });
    fs.rmSync(dir, { recursive: true, force: true });
});

test('friendActionAllowed：上游好友互动的大小号规则（类比农场）', () => {
    const allow = (gid, action, alt, relatedGids = []) => ranch.friendActionAllowed({ gid, action, alt, relatedGids });
    // 普通账号：只是不给自己的小号放蚊子
    assert.equal(allow(5, 'putMosquito', null, [5]), false);
    assert.equal(allow(9, 'putMosquito', null, [5]), true);
    assert.equal(allow(5, 'steal', null, [5]), true);
    assert.equal(allow(5, 'cleanFriend', null, [5]), true);
    // 小号（大号 3），没开额外选项：不给大号 / 同大号的其它小号放蚊子，照常偷和清理
    const alt = { enabled: true, masterGid: 3 };
    assert.equal(allow(3, 'putMosquito', alt, [4]), false);
    assert.equal(allow(4, 'putMosquito', alt, [4]), false);
    assert.equal(allow(9, 'putMosquito', alt, [4]), true);
    assert.equal(allow(3, 'steal', alt), true);
    assert.equal(allow(3, 'cleanFriend', alt), true);
    // 不偷大号的菜
    assert.equal(allow(3, 'steal', { ...alt, skipStealMaster: true }), false);
    assert.equal(allow(9, 'steal', { ...alt, skipStealMaster: true }), true);
    // 只给大号放捣乱：只给大号放蚊子、不帮大号清理
    const bad = { ...alt, badOnlyMaster: true };
    assert.equal(allow(3, 'putMosquito', bad, [4]), true);
    assert.equal(allow(9, 'putMosquito', bad, [4]), false);
    assert.equal(allow(4, 'putMosquito', bad, [4]), false);
    assert.equal(allow(3, 'cleanFriend', bad), false);
    assert.equal(allow(9, 'cleanFriend', bad), true);
    assert.equal(allow(3, 'stroke', bad), true);
});

test('好友额外动作纯函数：可帮生产、加牧草按金币保留值和容量', () => {
    assert.equal(ranch.helpableAnimals([{ animals: [{ can_deliver: true }, { can_deliver: true }, { can_feed: true }] }]), 2);
    assert.equal(ranch.helpableAnimals([{}]), 0);
    const cfg = { friendFeedPerTime: 10, friendFeedGoldKeep: 10000 };
    assert.equal(ranch.FEED_GOLD_PER_UNIT, 60);
    assert.equal(ranch.planFriendFeed({ capacity: 100, feedCount: 97 }, 48929, cfg), 3); // 1116-7 #172：97/100 → 加 3
    assert.equal(ranch.planFriendFeed({ capacity: 100, feedCount: 0 }, 48929, cfg), 10);
    assert.equal(ranch.planFriendFeed({ capacity: 100, feedCount: 0 }, 10300, cfg), 5);
    assert.equal(ranch.planFriendFeed({ capacity: 100, feedCount: 0 }, 10059, cfg), 0);
    assert.equal(ranch.planFriendFeed(null, 48929, cfg), 0);
    const entry = { homestead_cells: { facilities: [{ instance_id: '10001', state: 1, ranch: {} }, { instance_id: '10002', state: 1, capacity: 100, feed_machine: { feed_count: 97 } }] } };
    assert.deepEqual(ranch.friendFeedMachine(entry), { id: '10002', capacity: 100, feedCount: 97 });
});

test('上游 automateFriend + [fnos-fork]：大号（小号视角）不偷不清只放蚊子；其他好友偷+清不放；帮生产在偷之前、加牧草扣金币', async () => {
    ranch.resetFnosRanchRuntime();
    apply({ fnosAltAccount: { enabled: true, masterGid: 3, masterName: '大号', holdForMaster: false, skipStealMaster: true, badOnlyMaster: true },
        fnosRanch: { friendHelpProduce: true, friendFeed: true, friendFeedPerTime: 10, friendFeedGoldKeep: 10000 } });
    const sent = [];
    let world;
    const fresh = () => ({
        hazards: [{ hazard_id: 7, owner: 8888, hazard_type: 1 }],
        animals: [{ ranch_inst_id: '10001', animal_inst_id: 1, animal_id: 60001, stage: 3, can_deliver: true }],
        shelves: [{ slot_index: 1, can_steal: true, lots: [{ item_id: 1060001, can_steal: true, remain_num: 5, stealers: [] }] }],
        put: 0, remaining: 50,
    });
    const ranchView = () => JSON.parse(JSON.stringify([{ ranch_inst_id: '10001', husbandry_type: 1, capacity: 3, animal_count: 1, animals: world.animals, shelves: world.shelves, hazards: world.hazards }]));
    mock('services/ranch/operation-state', { forCurrentAccount: () => ({ spend: (_p, fn) => fn(), reserved: () => 0 }) });
    mock('services/ranch/transport', {
        inScene: fn => fn(null),
        rpc: async (route, input) => {
            sent.push([route, JSON.parse(JSON.stringify(input))]);
            switch (route) {
                case 'enterFriend': return { basic: { gid: input.host_gid, name: 'f' }, homestead_cells: { facilities: [{ instance_id: '10002', state: 1, capacity: 100, feed_machine: { feed_count: 97 } }] } };
                case 'leaveFriend': return {};
                case 'animals': return { ranches: ranchView() };
                case 'opTimes': return { ops: [{ op_id: 11003, remaining_times: world.remaining }, { op_id: 11008, remaining_times: 20 }, { op_id: 11009, remaining_times: 0 }] };
                case 'clean': { const rows = world.hazards.map(h => ({ facility_inst_id: '10001', kind: 3, target_id: h.hazard_id, costs: [], rewards: [{ id: 1102, count: 5 }] })); world.hazards = []; return { op_results: rows }; }
                case 'produce': world.animals = [{ ...world.animals[0], can_deliver: false }]; return { ranches: ranchView(), op_results: [{ kind: 1, target_id: 1, rewards: [{ id: 1102, count: 5 }] }] };
                case 'steal': world.shelves[0].lots[0].stealers = [1001]; return { op_results: [{ facility_inst_id: '10001', kind: 2, target_id: 1, costs: [], rewards: [{ id: 1060001, count: 1 }] }] };
                case 'putMosquito': world.put++; world.remaining--; world.hazards = [...world.hazards, { hazard_id: 100 + world.put, owner: 1001, hazard_type: 1 }]; return { actual_count: 1, remaining_times: world.remaining, hazards: world.hazards, rewards: [{ id: 1102, count: 5 }] };
                case 'addGrass': return { detail: { feed_count: 100 } };
                default: throw new Error(`unexpected ${route}`);
            }
        },
    });
    for (const k of ['services/ranch/friends', 'services/ranch/fnos-ranch']) delete require.cache[dist(k)];
    const fr = require('../dist/services/ranch/fnos-ranch');
    const friends = require('../dist/services/ranch/friends');
    fr.beginFriendPhase({ gold: 48929 });
    const all = () => true;
    // 1）大号 3
    world = fresh();
    let r = await friends.automateFriend(3, fr.wrapFriendWanted(3, all));
    let writes = sent.filter(([x]) => ['clean', 'produce', 'steal', 'putMosquito', 'addGrass'].includes(x)).map(([x]) => x);
    assert.deepEqual(writes, ['produce', 'putMosquito', 'putMosquito', 'addGrass']); // 已有 1 只别人的蚊子 → 上限 3 还能放 2
    assert.deepEqual(sent.find(([x]) => x === 'produce')[1], { host_gid: '3' });
    assert.deepEqual(sent.find(([x]) => x === 'addGrass')[1], { instance_id: '10002', add_count: 3, use_gold: true, host_gid: '3' });
    assert.ok(r.results.some(o => o.action === 'fnosHelpProduce') && r.results.some(o => o.action === 'fnosFeedFriend'));
    assert.equal(fr._rt.wallet.gold, 48929 - 180);
    // 2）普通好友 9：清理、帮生产、偷，不放蚊子
    sent.length = 0;
    world = fresh();
    r = await friends.automateFriend(9, fr.wrapFriendWanted(9, all));
    writes = sent.filter(([x]) => ['clean', 'produce', 'steal', 'putMosquito', 'addGrass'].includes(x)).map(([x]) => x);
    assert.deepEqual(writes, ['clean', 'produce', 'steal', 'addGrass']);
    assert.ok(sent.findIndex(([x]) => x === 'produce') < sent.findIndex(([x]) => x === 'steal'));
    // 3）额外动作开关关着 → 不发
    apply({ fnosRanch: { friendHelpProduce: false, friendFeed: false } });
    sent.length = 0;
    world = fresh();
    await friends.automateFriend(9, fr.wrapFriendWanted(9, a => a === 'steal'));
    writes = sent.filter(([x]) => ['clean', 'produce', 'steal', 'putMosquito', 'addGrass'].includes(x)).map(([x]) => x);
    assert.deepEqual(writes, ['steal']);
    apply({ fnosAltAccount: { enabled: false, skipStealMaster: false, badOnlyMaster: false } });
});
