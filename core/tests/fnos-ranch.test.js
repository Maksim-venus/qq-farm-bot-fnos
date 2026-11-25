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
mock('utils/network', { networkEvents: new (require('node:events'))(), getUserState: () => user, getWsErrorState: () => ({}), getWs: () => null, invalidateGameScene: () => {} });

const store = require('../dist/models/store');
const ranch = require('../dist/services/ranch/fnos-ranch');
const apply = cfg => store.applyConfigSnapshot(cfg, { accountId: '7' });

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('normalize：默认值与范围夹取、旧字段（被上游取代）丢弃；真实 store 默认带 fnosRanch', () => {
    const d = ranch.normalizeFnosRanch(undefined);
    assert.deepEqual(d, { altHold: true, altHoldFallbackMinutes: 60, illustratedAutoClaim: true, illustratedAutoComplete: false, mugeAutoClaim: true,
        friendFeed: false, friendFeedSource: 'warehouse', friendFeedPerTime: 10, friendFeedGoldKeep: 10000 });
    const c = ranch.normalizeFnosRanch({ altHoldFallbackMinutes: 1, friendFeedPerTime: 0, friendFeedGoldKeep: -5, friendHelpProduce: true,
        rotation: false, friendSteal: true, friendPutMosquito: true, friendFeedKeep: 200 });
    assert.equal(c.altHoldFallbackMinutes, 5);
    assert.equal(c.friendFeedPerTime, 1);
    assert.equal(c.friendFeedGoldKeep, 0);
    assert.equal('friendHelpProduce' in c, false); // 2026-11-25 并入上游 ranch_friend_produce，旧字段丢弃
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
        s.applyConfigSnapshot({ fnosRanch: { friendFeed: true, friendFeedPerTime: 3 } }, { accountId: 'a1' });
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
    assert.equal('friendHelpProduce' in out.r, false);
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

test('好友额外动作纯函数：加牧草按金币保留值和容量', () => {
    assert.equal(ranch.helpableAnimals, undefined); // 2026-11-25 fork 帮忙生产已删除
    assert.equal(ranch.helpFriendProduce, undefined);
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

test('上游 automateFriend + [fnos-fork]：大号（小号视角）不偷不清只放蚊子；其他好友先偷、再帮生产（只走上游 produceFriend）、再清；加牧草扣金币', async () => {
    ranch.resetFnosRanchRuntime();
    apply({ fnosAltAccount: { enabled: true, masterGid: 3, masterName: '大号', holdForMaster: false, skipStealMaster: true, badOnlyMaster: true },
        fnosRanch: { friendFeed: true, friendFeedSource: 'gold', friendFeedPerTime: 10, friendFeedGoldKeep: 10000 } });
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
                case 'produce': world.animals = [{ ...world.animals[0], can_deliver: false }]; return { ranches: ranchView(), op_results: [{ facility_inst_id: '10001', kind: 1, target_id: 1, costs: [], rewards: [{ id: 1102, count: 5 }] }] };
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
    // 2026-11-25 帮忙生产只剩上游「自动帮忙生产」（ranch_friend_produce → produceFriend）
    const all = () => true;
    // 1）大号 3
    world = fresh();
    let r = await friends.automateFriend(3, fr.wrapFriendWanted(3, all));
    let writes = sent.filter(([x]) => ['clean', 'produce', 'steal', 'putMosquito', 'addGrass'].includes(x)).map(([x]) => x);
    assert.deepEqual(writes, ['produce', 'putMosquito', 'putMosquito', 'addGrass']); // 已有 1 只别人的蚊子 → 上限 3 还能放 2
    assert.deepEqual(sent.find(([x]) => x === 'produce')[1], { host_gid: '3', targets: [] }); // 上游 produceFriend：只指定主人，由服务端挑就绪动物
    assert.deepEqual(sent.find(([x]) => x === 'addGrass')[1], { instance_id: '10002', add_count: 3, use_gold: true, host_gid: '3' });
    assert.ok(r.results.some(o => o.action === 'produceFriend') && r.results.some(o => o.action === 'fnosFeedFriend'));
    assert.ok(!r.results.some(o => o.action === 'fnosHelpProduce'));
    assert.equal(fr._rt.wallet.gold, 48929 - 180);
    // 2）普通好友 9：上游 #185/#187 先偷、再帮生产、再清理，不放蚊子
    sent.length = 0;
    world = fresh();
    r = await friends.automateFriend(9, fr.wrapFriendWanted(9, all));
    writes = sent.filter(([x]) => ['clean', 'produce', 'steal', 'putMosquito', 'addGrass'].includes(x)).map(([x]) => x);
    assert.deepEqual(writes, ['steal', 'produce', 'clean', 'addGrass']);
    assert.ok(sent.findIndex(([x]) => x === 'steal') < sent.findIndex(([x]) => x === 'produce'));
    // 3）上游帮忙生产、加牧草都关着 → 不发（旧 fork 字段即使带上也不再生效）
    apply({ fnosRanch: { friendHelpProduce: true, friendFeed: false } });
    sent.length = 0;
    world = fresh();
    await friends.automateFriend(9, fr.wrapFriendWanted(9, a => a === 'steal'));
    writes = sent.filter(([x]) => ['clean', 'produce', 'steal', 'putMosquito', 'addGrass'].includes(x)).map(([x]) => x);
    assert.deepEqual(writes, ['steal']);
    // 4）上游「帮忙生产」开关打开：只走上游一次 produce
    sent.length = 0;
    world = fresh();
    r = await friends.automateFriend(9, fr.wrapFriendWanted(9, a => a === 'produceFriend'));
    writes = sent.filter(([x]) => ['clean', 'produce', 'steal', 'putMosquito', 'addGrass'].includes(x)).map(([x]) => x);
    assert.deepEqual(writes, ['produce']);
    assert.ok(r.results.some(o => o.action === 'produceFriend') && !r.results.some(o => o.action === 'fnosHelpProduce'));
    apply({ fnosAltAccount: { enabled: false, skipStealMaster: false, badOnlyMaster: false } });
});

// [fnos-fork] 2026-11-17 牧场好友列表行内「偷取 / 捣乱」按钮：置灰原因与「捣乱」放蚊子计划
test('friendActionBlockReason：手动按钮置灰原因与 friendActionAllowed 一致', () => {
    const why = (gid, action, alt, relatedGids = []) => ranch.friendActionBlockReason({ gid, action, alt, relatedGids });
    const small = { enabled: true, masterGid: 2002, skipStealMaster: true, badOnlyMaster: false };
    assert.match(why(2002, 'steal', small), /不偷大号/);
    assert.equal(why(3003, 'steal', small), '');
    assert.match(why(2002, 'putMosquito', small), /之间不放蚊子/);
    assert.match(why(4004, 'putMosquito', small, [4004]), /之间不放蚊子/);
    assert.equal(why(3003, 'putMosquito', small), '');
    const onlyMaster = { ...small, badOnlyMaster: true };
    assert.equal(why(2002, 'putMosquito', onlyMaster), '');
    assert.match(why(3003, 'putMosquito', onlyMaster), /只给大号放蚊子/);
    assert.match(why(2002, 'cleanFriend', onlyMaster), /留给大号/);
    assert.equal(why(2002, 'steal', null), '');
    assert.equal(why(2002, 'putMosquito', null), '');
});

test('badPlan：放满各栏舍蚊子，受每日剩余次数限制', () => {
    const friends = require('../dist/services/ranch/friends');
    const pen = (id, type, mosquitoes) => ({ ranch_inst_id: id, husbandry_type: type, hazards: Array.from({ length: mosquitoes }, (_, i) => ({ hazard_type: 1, hazard_id: i + 1 })) });
    const ranches = [pen(11, 1, 0), pen(12, 2, 0)];
    const full = friends.badPlan(ranches, '2002', { putMosquito: 100 });
    assert.ok(full.count > 0);
    assert.equal(full.count, full.pens.reduce((sum, p) => sum + p.room, 0));
    assert.equal(friends.badPlan(ranches, '2002', { putMosquito: 1 }).count, 1);
    assert.equal(friends.badPlan(ranches, '2002', { putMosquito: 0 }).count, 0);
});

test('[fnos-fork] 2026-11-17 给好友加牧草来源：默认仓库牧草 7001（不带 use_gold），不够只加够库存后暂停并记日志，不改用金币；instance_id 取自好友 facilities', async () => {
    // normalize：旧配置缺字段 → warehouse；无效值 → 沿用已存值
    assert.equal(ranch.normalizeFnosRanch({ friendFeed: true }).friendFeedSource, 'warehouse');
    assert.equal(ranch.normalizeFnosRanch({ friendFeedSource: 'gold' }).friendFeedSource, 'gold');
    assert.equal(ranch.normalizeFnosRanch({ friendFeedSource: 'x' }, { ...ranch.DEFAULT_FNOS_RANCH, friendFeedSource: 'gold' }).friendFeedSource, 'gold');
    // 纯函数：仓库来源只看牧草库存，不看金币
    const cfg = { friendFeedPerTime: 10, friendFeedGoldKeep: 10000, friendFeedSource: 'warehouse' };
    assert.equal(ranch.planFriendFeed({ capacity: 100, feedCount: 97 }, { gold: 0, grass: 3236 }, cfg), 3);
    assert.equal(ranch.planFriendFeed({ capacity: 100, feedCount: 0 }, { gold: 999999, grass: 4 }, cfg), 4);
    assert.equal(ranch.planFriendFeed({ capacity: 100, feedCount: 0 }, { gold: 999999, grass: 0 }, cfg), 0);
    assert.equal(ranch.GRASS_ITEM_ID, 7001);

    apply({ fnosAltAccount: { enabled: false }, fnosRanch: { friendFeed: true, friendFeedSource: 'warehouse', friendFeedPerTime: 3 } });
    const sent = [];
    let feedCount = 0;
    mock('services/ranch/operation-state', { forCurrentAccount: () => ({ spend: (_p, fn) => fn(), reserved: () => 0 }) });
    mock('services/ranch/transport', {
        inScene: fn => fn(null),
        rpc: async (route, input) => {
            sent.push([route, JSON.parse(JSON.stringify(input))]);
            switch (route) {
                case 'enterFriend': return { basic: { gid: input.host_gid, name: 'f' }, homestead_cells: { facilities: [{ instance_id: '20007', state: 1, capacity: 600, feed_machine: { feed_count: feedCount } }] } };
                case 'leaveFriend': return {};
                case 'animals': return { ranches: [] };
                case 'opTimes': return { ops: [] };
                case 'addGrass': return { detail: { feed_count: feedCount + input.add_count } };
                default: throw new Error(`unexpected ${route}`);
            }
        },
    });
    for (const k of ['services/ranch/friends', 'services/ranch/fnos-ranch']) delete require.cache[dist(k)];
    const fr = require('../dist/services/ranch/fnos-ranch');
    const friends = require('../dist/services/ranch/friends');
    fr.beginFriendPhase({ gold: 0, grass: 5 });
    logs.length = 0;
    const feeds = () => sent.filter(([x]) => x === 'addGrass').map(([, input]) => input);
    // 好友 1：要 3 份，仓库 5 → 加 3，不带 use_gold，instance_id 来自好友 facilities
    feedCount = 554;
    const r = await friends.automateFriend(1269220833, fr.wrapFriendWanted(1269220833, () => false));
    assert.deepEqual(feeds(), [{ instance_id: '20007', add_count: 3, host_gid: '1269220833' }]);
    assert.ok(r.results.some(o => o.action === 'fnosFeedFriend' && /用农场仓库牧草，剩 2 份/.test(o.notice)));
    // 好友 2：要 3 份，仓库剩 2 → 只加 2，记日志
    sent.length = 0; feedCount = 477;
    await friends.automateFriend(1171432325, fr.wrapFriendWanted(1171432325, () => false));
    assert.deepEqual(feeds(), [{ instance_id: '20007', add_count: 2, host_gid: '1171432325' }]);
    assert.equal(logs.filter(l => /仓库牧草（7001）不够/.test(l)).length, 1);
    // 好友 3：仓库没了 → 不加、不用金币；日志不重复
    sent.length = 0;
    await friends.automateFriend(5, fr.wrapFriendWanted(5, () => false));
    assert.deepEqual(feeds(), []);
    assert.equal(logs.filter(l => /剩 0 份/.test(l)).length, 1);
    await friends.automateFriend(6, fr.wrapFriendWanted(6, () => false));
    assert.equal(logs.filter(l => /剩 0 份/.test(l)).length, 1, '同样的提示只记一次');
    assert.ok(!sent.some(([x, input]) => x === 'addGrass' && input.use_gold));
    apply({ fnosRanch: { friendFeed: false } });
});

test('[fnos-fork] 2026-11-25 帮忙生产并入上游：旧 friendHelpProduce=true 且上游开关未设置 → ranch_friend_produce 打开，旧字段丢弃', () => {
    // 纯函数
    assert.deepEqual(ranch.migrateFnosHelpProduce({ fnosRanch: { friendHelpProduce: true } }), { ranch_friend_produce: true });
    assert.deepEqual(ranch.migrateFnosHelpProduce({ automation: { ranch_harvest: false }, fnosRanch: { friendHelpProduce: true } }), { ranch_harvest: false, ranch_friend_produce: true });
    assert.deepEqual(ranch.migrateFnosHelpProduce({ automation: { ranch_friend_produce: false }, fnosRanch: { friendHelpProduce: true } }), { ranch_friend_produce: false });
    assert.deepEqual(ranch.migrateFnosHelpProduce({ automation: { ranch_harvest: true }, fnosRanch: { friendHelpProduce: false } }), { ranch_harvest: true });
    assert.equal(ranch.migrateFnosHelpProduce({ fnosRanch: {} }), undefined);
    assert.equal(ranch.migrateFnosHelpProduce(undefined), undefined);

    // 磁盘上的旧配置：新进程读回
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-help-produce-'));
    const env = { ...process.env, QQ_FARM_DATA_DIR: dir };
    delete env.FARM_ACCOUNT_ID;
    const run = script => {
        const r = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    run(`const s=require('./dist/models/store');
        for (const id of ['m1','m2','m3']) s.applyConfigSnapshot({ fnosRanch: { friendFeed: true } }, { accountId: id });
        console.log('{}');`);
    const fileOf = id => path.join(dir, 'account-configs', `id-${Buffer.from(id).toString('hex')}.json`);
    const patch = (id, edit) => {
        const file = fileOf(id);
        assert.ok(fs.existsSync(file), id);
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const holder = j.fnosRanch ? j : (j.config || j);
        edit(holder);
        fs.writeFileSync(file, JSON.stringify(j));
    };
    // m1：旧版只开着 fork 开关，上游字段不存在 → 迁移为开
    patch('m1', h => { h.fnosRanch.friendHelpProduce = true; if (h.automation) delete h.automation.ranch_friend_produce; });
    // m2：fork 开着，但上游已显式关 → 尊重上游
    patch('m2', h => { h.fnosRanch.friendHelpProduce = true; h.automation = { ...(h.automation || {}), ranch_friend_produce: false }; });
    // m3：fork 关着 → 上游保持默认关
    patch('m3', h => { h.fnosRanch.friendHelpProduce = false; if (h.automation) delete h.automation.ranch_friend_produce; });
    const out = run(`const s=require('./dist/models/store');const g=id=>s.getConfigSnapshot(id);
        console.log(JSON.stringify(['m1','m2','m3'].map(id => ({ p: g(id).automation.ranch_friend_produce, r: g(id).fnosRanch }))));`);
    assert.deepEqual(out.map(o => o.p), [true, false, false]);
    for (const o of out) { assert.equal('friendHelpProduce' in o.r, false); assert.equal(o.r.friendFeed, true); }
    // 保存一次后旧字段从磁盘清掉，迁移结果写成显式上游开关
    run(`const s=require('./dist/models/store'); s.applyConfigSnapshot({ fnosRanch: { friendFeedPerTime: 5 } }, { accountId: 'm1' }); console.log('{}');`);
    const raw = fs.readFileSync(fileOf('m1'), 'utf8');
    const m1 = run(`const s=require('./dist/models/store');const c=s.getConfigSnapshot('m1');console.log(JSON.stringify({ p: c.automation.ranch_friend_produce, n: c.fnosRanch.friendFeedPerTime }));`);
    assert.deepEqual(m1, { p: true, n: 5 });
    assert.equal(raw.includes('friendHelpProduce'), false);
    assert.match(raw, /"ranch_friend_produce": true/);
    fs.rmSync(dir, { recursive: true, force: true });
});
