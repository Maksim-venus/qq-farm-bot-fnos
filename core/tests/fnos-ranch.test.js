// [fnos-fork] 2026-11-16 牧场增强：小号等大号、轮换值守、好友牧场巡查选人、牧场图鉴选动物、设置持久化。
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
mock('utils/network', { getUserState: () => user, getWsErrorState: () => ({}) });

const store = require('../dist/models/store');
const ranch = require('../dist/services/ranch/fnos-ranch');
const apply = cfg => store.applyConfigSnapshot(cfg, { accountId: '7' });

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('normalize：默认值与范围夹取；真实 store 默认带 fnosRanch', () => {
    const d = ranch.normalizeFnosRanch(undefined);
    assert.equal(d.rotation, true);
    assert.equal(d.rotationIdleMinutes, 1);
    assert.equal(d.rotationMinGapSeconds, 30);
    assert.equal(d.altHold, true);
    assert.equal(d.friendSteal, false);
    assert.equal(d.friendClean, false);
    assert.equal(d.friendMosquito, false);
    assert.equal(d.friendFeed, false);
    const c = ranch.normalizeFnosRanch({ rotationIdleMinutes: 999, rotationMinGapSeconds: 1, friendMaxPerPatrol: 0, friendSteal: 1 });
    assert.equal(c.rotationIdleMinutes, 60);
    assert.equal(c.rotationMinGapSeconds, 30);
    assert.equal(c.friendMaxPerPatrol, 1);
    assert.equal(c.friendSteal, true);
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

test('rotationDue：最小间隔、作物将熟让路、农场有活立即、空闲按分钟、上游到点', () => {
    ranch.resetFnosRanchRuntime();
    const cfg = ranch.normalizeFnosRanch({ rotationIdleMinutes: 2, rotationMinGapSeconds: 30 });
    const rt = ranch._rt;
    ranch.markRanchVisited(100_000);
    assert.equal(ranch.rotationDue(0, 110_000, cfg).reason, 'min_gap');
    rt.pendingAfterFarmWork = true;
    assert.equal(ranch.rotationDue(0, 140_000, cfg).reason, 'after_farm_work');
    rt.ownNextMatureAtMs = 170_000;
    const y = ranch.rotationDue(0, 140_000, cfg);
    assert.equal(y.reason, 'own_mature_soon');
    assert.equal(y.nextAt, 200_000);
    rt.ownNextMatureAtMs = 0;
    ranch.markRanchVisited(100_000);
    assert.equal(ranch.rotationDue(0, 140_000, cfg).reason, 'waiting');
    assert.equal(ranch.rotationDue(130_000, 140_000, cfg).reason, 'upstream_wake');
    assert.equal(ranch.rotationDue(0, 100_000 + 120_000, cfg).reason, 'idle_interval');
    ranch.recordFarmRound({ lands: [], hadWork: true }, 1);
    assert.equal(rt.pendingAfterFarmWork, true);
    ranch.markRanchVisited(2);
    assert.equal(rt.pendingAfterFarmWork, false);
    ranch.recordFriendRound(true);
    assert.equal(rt.pendingAfterFarmWork, true);
});

test('nextOwnMatureSec：取未来最早成熟阶段（兼容毫秒）', () => {
    const lands = [
        { plant: { phases: [{ begin_time: 100 }, { begin_time: 500 }] } },
        { plant: { phases: [{ begin_time: 100 }, { begin_time: 300_000 }] } },
        { plant: { phases: [{ begin_time: 200 }, { begin_time: 400 * 1000 + 1e12 }] } },
        { plant: null },
    ];
    assert.equal(ranch.nextOwnMatureSec(lands, 200), 500);
});

test('pickFriendTargets：黑名单、小号不偷大号/不帮大号清、大号优先自己的小号、冷却、轮转游标', () => {
    const cfg = ranch.normalizeFnosRanch({ friendSteal: true });
    const friends = [1, 2, 3, 4, 5, 1001].map(gid => ({ gid, name: `f${gid}` }));
    const base = { friends, myGid: 1001, blacklist: [2], alt: null, myAltGids: [], cfg, cooldown: new Map(), cursor: 0, nowMs: 0, limit: 2 };
    let r = ranch.pickFriendTargets(base);
    assert.deepEqual(r.targets.map(t => t.gid), [1, 3]);
    assert.ok(r.targets.every(t => t.steal && !t.clean));
    r = ranch.pickFriendTargets({ ...base, cursor: r.cursor });
    assert.deepEqual(r.targets.map(t => t.gid), [4, 5]);
    // 小号且不偷大号：大号 3 被跳过
    r = ranch.pickFriendTargets({ ...base, alt: { enabled: true, masterGid: 3, skipStealMaster: true }, limit: 5 });
    assert.deepEqual(r.targets.map(t => t.gid), [1, 4, 5]);
    // 大号：自己的小号 5 优先
    r = ranch.pickFriendTargets({ ...base, myAltGids: [5], limit: 2 });
    assert.deepEqual(r.targets.map(t => t.gid), [5, 1]);
    assert.equal(r.targets[0].priority, true);
    // 冷却
    r = ranch.pickFriendTargets({ ...base, cooldown: new Map([[1, 10]]), nowMs: 5, limit: 5 });
    assert.deepEqual(r.targets.map(t => t.gid), [3, 4, 5]);
    // 只开清理：清理目标；小号 badOnlyMaster 时不帮大号清
    const cleanCfg = ranch.normalizeFnosRanch({ friendSteal: false, friendMosquito: true });
    r = ranch.pickFriendTargets({ ...base, cfg: cleanCfg, limit: 5 });
    assert.deepEqual(r.targets.map(t => t.gid), [1, 3, 4, 5]);
    assert.ok(r.targets.every(t => t.clean && !t.steal && !t.feed));
    r = ranch.pickFriendTargets({ ...base, cfg: cleanCfg, alt: { enabled: true, masterGid: 3, badOnlyMaster: true }, limit: 5 });
    assert.deepEqual(r.targets.map(t => t.gid), [1, 4, 5]);
    // 清理次数用完 → 没有目标
    r = ranch.pickFriendTargets({ ...base, cfg: cleanCfg, cleanAllowed: false, limit: 5 });
    assert.equal(r.targets.length, 0);
    // 全关 → 没有目标
    r = ranch.pickFriendTargets({ ...base, cfg: ranch.normalizeFnosRanch({ friendSteal: false }), limit: 5 });
    assert.equal(r.targets.length, 0);
    // 放蚊子：不给大小号关系的账号放（我的大号 3、我的小号 5、同大号的小号 4），其余照放；放蚊子次数用完 → 没有目标
    const putCfg = ranch.normalizeFnosRanch({ friendSteal: false, friendPutMosquito: true });
    r = ranch.pickFriendTargets({ ...base, cfg: putCfg, alt: { enabled: true, masterGid: 3 }, myAltGids: [5], relatedGids: [4], limit: 5 });
    assert.deepEqual(r.targets.map(t => t.gid), [1]);
    assert.ok(r.targets.every(t => t.put && !t.steal && !t.help));
    r = ranch.pickFriendTargets({ ...base, cfg: putCfg, putAllowed: false, limit: 5 });
    assert.equal(r.targets.length, 0);
    // 帮忙生产 + 放蚊子：大小号只帮不放
    r = ranch.pickFriendTargets({ ...base, cfg: ranch.normalizeFnosRanch({ friendSteal: false, friendPutMosquito: true, friendHelpProduce: true }), alt: { enabled: true, masterGid: 3 }, limit: 5 });
    assert.deepEqual(r.targets.map(t => [t.gid, t.help, t.put]), [[1, true, true], [3, true, false], [4, true, true], [5, true, true]]);
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

test('runFriendPatrol：关闭时不读好友、不发请求', async () => {
    ranch.resetFnosRanchRuntime();
    assert.equal(await ranch.runFriendPatrol(0), 0);
    assert.equal(ranch._rt.dayVisits, 0);
});

test('fnosRanch 持久化：新进程读回，其他字段不受影响', () => {
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
        s.applyConfigSnapshot({ fnosRanch: { rotation: false, rotationIdleMinutes: 5, friendSteal: true, friendMaxPerPatrol: 3 } }, { accountId: 'a1' });
        s.applyConfigSnapshot({ fnosGrassLands: { count: 4, autoBuy: false } }, { accountId: 'a1' });
        console.log('{}');`);
    const out = run(`const s=require('./dist/models/store');const c=s.getConfigSnapshot('a1');const o=s.getConfigSnapshot('a2');
        console.log(JSON.stringify({ r: c.fnosRanch, g: c.fnosGrassLands, ill: c.fnosIllustratedAuto, or: o.fnosRanch, og: o.fnosGrassLands }));`);
    assert.equal(out.r.rotation, false);
    assert.equal(out.r.rotationIdleMinutes, 5);
    assert.equal(out.r.friendSteal, true);
    assert.equal(out.r.friendMaxPerPatrol, 3);
    assert.deepEqual(out.g, { count: 4, autoBuy: false });
    assert.equal(out.ill.autoClaimRewards, true);
    assert.equal(out.or.rotation, true);
    assert.deepEqual(out.og, { count: 0, autoBuy: true });
    fs.rmSync(dir, { recursive: true, force: true });
});

test('好友牧场照顾纯函数：害的种类（1 蚊子 / 2 便便）、可帮生产、放蚊子计划、加牧草数量、牧草机', () => {
    assert.equal(ranch.hazardKind(1), 'mosquito');
    assert.equal(ranch.hazardKind(2), 'poop');
    assert.equal(ranch.hazardKind(9), 'other');
    // 1116-7 #212：sail 的牧场只有一坨便便（type 2、无 owner）
    const ranches = [{ hazards: [{ hazard_id: 2, hazard_type: 1 }, { hazard_id: 3, hazard_type: 1 }] }, { hazards: [{ hazard_id: 10, hazard_type: 2 }] }];
    assert.deepEqual(ranch.hazardsToClean(ranches, { friendMosquito: true, friendClean: false }), { total: 3, wanted: 2, kinds: { mosquito: 2, poop: 1 } });
    assert.equal(ranch.hazardsToClean(ranches, { friendMosquito: false, friendClean: true }).wanted, 1);
    assert.equal(ranch.hazardsToClean(ranches, { friendMosquito: false, friendClean: false }).wanted, 0);
    assert.equal(ranch.hazardsToClean([{}], { friendMosquito: true, friendClean: true }).total, 0);
    // 1116-6 #160：3 只 60001 can_deliver
    assert.equal(ranch.helpableAnimals([{ animals: [{ can_deliver: true }, { can_deliver: true }, { can_feed: true }] }]), 2);
    assert.equal(ranch.helpableAnimals([{}]), 0);
    // 放蚊子：每窝棚最多 3 只，按已有蚊子扣；便便不占
    assert.deepEqual(ranch.planPutMosquito([{ ranch_inst_id: '10001', animal_count: 3, hazards: [] }], 3), [{ ranchId: '10001', count: 3 }]);
    assert.deepEqual(ranch.planPutMosquito([{ ranch_inst_id: '10001', animal_count: 3, hazards: [{ hazard_type: 1 }, { hazard_type: 2 }] }], 3), [{ ranchId: '10001', count: 2 }]);
    assert.deepEqual(ranch.planPutMosquito([{ ranch_inst_id: '10001', animal_count: 3, hazards: [{ hazard_type: 1 }, { hazard_type: 1 }, { hazard_type: 1 }] }], 3), []);
    assert.deepEqual(ranch.planPutMosquito([{ ranch_inst_id: '10001', animal_count: 3 }, { ranch_inst_id: '10003', animal_count: 2 }], 4), [{ ranchId: '10001', count: 3 }, { ranchId: '10003', count: 1 }]);
    assert.deepEqual(ranch.planPutMosquito([{ ranch_inst_id: '10001', animal_count: 0 }], 3), []);
    const cfg = { friendFeedPerTime: 10, friendFeedKeep: 200 };
    assert.equal(ranch.planFriendFeed({ capacity: 100, feedCount: 97 }, 1000, cfg), 3); // 1116-7 #172：97/100 → 加 3
    assert.equal(ranch.planFriendFeed({ capacity: 100, feedCount: 0 }, 1000, cfg), 10);
    assert.equal(ranch.planFriendFeed({ capacity: 100, feedCount: 0 }, 205, cfg), 5);
    assert.equal(ranch.planFriendFeed({ capacity: 100, feedCount: 0 }, 150, cfg), 0);
    assert.equal(ranch.planFriendFeed(null, 1000, cfg), 0);
    const entry = { homestead_cells: { facilities: [{ instance_id: '10001', state: 1, ranch: {} }, { instance_id: '10002', state: 1, capacity: 100, feed_machine: { feed_count: 97 } }] } };
    assert.deepEqual(ranch.friendFeedMachine(entry), { id: '10002', capacity: 100, feedCount: 97 });
    assert.equal(ranch.OP_PUT_HAZARD, 11003);
});

test('好友牧场照顾：按 1116-6/1116-7 的请求写法，帮生产后再偷、清理、放蚊子到「够多」为止、加牧草；放蚊子按 11003 额度', async () => {
    ranch.resetFnosRanchRuntime();
    const sent = [];
    const ops = { 11003: { op_id: 11003, times_limit: 100, used_times: 98, remaining_times: 2 }, 11008: { op_id: 11008, times_limit: 20, remaining_times: 20 }, 11009: { op_id: 11009, times_limit: 10, used_times: 10 } };
    let detailCalls = 0;
    const friendHazards = [];
    mock('services/ranch/transport', {
        rpc: async (route, input) => {
            sent.push([route, JSON.parse(JSON.stringify(input))]);
            if (route === 'opTimes') return { ops: Object.values(ops).map(o => ({ ...o })) };
            if (route === 'produce') return { ranches: [{ animals: [{ delivering_until_ms: 0 }] }], op_results: [{ kind: 1, target_id: 1, rewards: [{ id: 1102, count: 5 }] }] };
            if (route === 'animals') { detailCalls++; return { ranches: [{ ranch_inst_id: '10001', animal_count: 3, hazards: [{ hazard_id: 2, hazard_type: 1 }], shelves: [{ can_steal: true, lots: [{ can_steal: true, remain_num: 5, stealers: [] }] }] }] }; }
            if (route === 'steal') return { op_results: [{ kind: 2, rewards: [{ id: 1060001, count: 1 }] }] };
            if (route === 'clean') return { ranches: [{ hazards: [] }], op_results: [{ kind: 3, target_id: 2, rewards: [{ id: 1102, count: 5 }] }] };
            if (route === 'putHazard') {
                if (friendHazards.length >= 3) { const e = new Error('gamepb.animalpb.RanchService.PutHazard 错误: code=1045230 这里的蚊子已经够多啦，换一处试试吧'); e.code = 1045230; throw e; }
                friendHazards.push(1);
                const o = ops[11003]; o.used_times++; o.remaining_times--;
                return { actual_count: 1, remaining_times: o.remaining_times, hazards: [], rewards: [{ id: 1102, count: 5 }] };
            }
            if (route === 'addGrass') return { detail: { feed_count: 100 } };
            throw new Error(`unexpected ${route}`);
        },
    });
    const entry = { homestead_cells: { facilities: [{ instance_id: '10002', state: 1, capacity: 100, feed_machine: { feed_count: 97 } }] } };
    let ranchesForVisit = [{ ranch_inst_id: '10001', animal_count: 3, animals: [{ can_deliver: true }], shelves: [], hazards: [{ hazard_id: 2, hazard_type: 1 }] }];
    mock('services/ranch/friends', {
        targets: list => list.flatMap(r => (r.shelves || []).filter(s => s.can_steal)),
        visit: async (gid, run) => run(entry, ranchesForVisit, String(gid)),
    });
    mock('services/ranch/model', { sumItems: list => list.map(i => ({ ...i, name: `#${i.id}` })), quantity: v => String(v) });
    const cfg = ranch.normalizeFnosRanch({ friendSteal: true, friendHelpProduce: true, friendMosquito: true, friendPutMosquito: true, friendFeed: true, friendFeedKeep: 100 });
    ranch._rt.dayKey = 'd1';
    const grass = { left: 500 };
    // 1）帮生产 → 重新查详情 → 偷；有蚊子 → 清理；清过就不放；加牧草 3
    let r = await ranch._visitFriend({ gid: 1288605885, name: 'a', steal: true, clean: true, feed: true, help: true, put: true }, cfg, grass);
    assert.deepEqual([r.helped, r.stolen, r.cleaned, r.put, r.fed], [1, 1, 1, 0, 3]);
    assert.equal(detailCalls, 1);
    assert.equal(grass.left, 497);
    assert.deepEqual(sent, [
        ['produce', { host_gid: '1288605885' }],
        ['animals', { host_gid: '1288605885' }],
        ['steal', { host_gid: '1288605885', targets: [] }],
        ['clean', { host_gid: '1288605885' }],
        ['addGrass', { instance_id: '10002', add_count: 3, use_gold: false, host_gid: '1288605885' }],
    ]);
    // 2）只放蚊子：额度只剩 2 → 放 2 只后当天停止
    sent.length = 0;
    ranch._rt.opTimes = new Map([[11003, { limit: 100, used: 98, remaining: 2 }]]);
    ranchesForVisit = [{ ranch_inst_id: '10001', animal_count: 3, animals: [], shelves: [], hazards: [] }];
    r = await ranch._visitFriend({ gid: 1261327968, name: 'b', steal: false, clean: false, feed: false, help: false, put: true }, cfg, grass);
    assert.equal(r.put, 2);
    assert.deepEqual(sent, [
        ['putHazard', { ranch_inst_id: '10001', host_gid: '1261327968', op_id: 11003, count: 1 }],
        ['putHazard', { ranch_inst_id: '10001', host_gid: '1261327968', op_id: 11003, count: 1 }],
    ]);
    assert.equal(ranch._rt.exhausted.put, 'd1');
    sent.length = 0;
    r = await ranch._visitFriend({ gid: 3, name: 'c', steal: false, clean: false, feed: false, help: false, put: true }, cfg, grass);
    assert.equal(r.put, 0);
    assert.deepEqual(sent, []);
    // 3）额度够、窝棚「够多」报错 1045230 → 停在这个窝棚，不算失败、不停当天
    ranch.resetFnosRanchRuntime();
    ranch._rt.dayKey = 'd2';
    friendHazards.length = 1;
    ops[11003].remaining_times = 50;
    sent.length = 0;
    r = await ranch._visitFriend({ gid: 4, name: 'd', steal: false, clean: false, feed: false, help: false, put: true }, cfg, grass);
    assert.equal(r.put, 2);
    assert.equal(sent.filter(([x]) => x === 'putHazard').length, 3);
    assert.notEqual(ranch._rt.exhausted.put, 'd2');
    // 4）只开清便便、但只有蚊子 → 不清
    ranch.resetFnosRanchRuntime();
    sent.length = 0;
    ranchesForVisit = [{ ranch_inst_id: '10001', animal_count: 3, animals: [], shelves: [], hazards: [{ hazard_id: 2, hazard_type: 1 }] }];
    r = await ranch._visitFriend({ gid: 5, name: 'e', steal: false, clean: true, feed: false, help: false, put: false }, ranch.normalizeFnosRanch({ friendClean: true }), grass);
    assert.deepEqual(sent, []);
    // 5）清理请求报次数上限 → 当天停止
    ranch.resetFnosRanchRuntime();
    ranch._rt.dayKey = 'd3';
    mock('services/ranch/transport', { rpc: async route => { if (route === 'clean') throw new Error('今日次数已达上限'); return { ops: [] }; } });
    await assert.rejects(ranch._visitFriend({ gid: 6, name: 'f', steal: false, clean: true, feed: false, help: false, put: false }, cfg, grass));
    assert.equal(ranch._rt.exhausted.clean, 'd3');
});
