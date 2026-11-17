// [fnos-fork] 2026-11-17 好友时间表 / 自家提前蹲点 / 杂项只在空闲时做（services/fnos-timetable.ts）
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const tt = require('../dist/services/fnos-timetable');

const NOW_SEC = 1_794_826_000;
const NOW_MS = 5_000_000;
const land = (id, begins) => ({ id, unlocked: true, plant: { phases: begins.map(b => ({ begin_time: b })) } });

test('成熟时间：每块地 phases 最晚开始的阶段 = 成熟；已成熟 / 空地 / 未解锁不算', () => {
    const lands = [
        land(1, [NOW_SEC - 100, NOW_SEC + 600]),
        land(2, [NOW_SEC - 100, NOW_SEC + 300]),
        land(3, [NOW_SEC - 900, NOW_SEC - 10]), // 已成熟
        { id: 4, unlocked: false, plant: { phases: [{ begin_time: NOW_SEC + 10 }] } },
        { id: 5 },
    ];
    assert.equal(tt.nextMatureSec(lands, NOW_SEC), NOW_SEC + 300);
    assert.equal(tt.nextMatureSec([land(1, [(NOW_SEC + 50) * 1000])], NOW_SEC), NOW_SEC + 50, '毫秒时间戳也认');
    assert.equal(tt.nextMatureSec([], NOW_SEC), 0);
});

test('好友列表 plant 字段 1/2/3 是绝对时间（抓包核对）：取最近的未来时间作「下次需要帮忙」；小数值按倒计时', () => {
    assert.equal(tt.nextHelpSecFromPlant({ dry_time_sec: NOW_SEC + 892, weed_time_sec: NOW_SEC + 263, insect_time_sec: NOW_SEC - 5 }, NOW_SEC), NOW_SEC + 263);
    assert.equal(tt.nextHelpSecFromPlant({ dry_time_sec: 120 }, NOW_SEC), NOW_SEC + 120);
    assert.equal(tt.nextHelpSecFromPlant(null, NOW_SEC), 0);
});

test('好友牧场：动物 produce / mature_ready_at_ms 最近的未来时间', () => {
    const ranches = [{ animals: [{ produce_ready_at_ms: (NOW_SEC + 90) * 1000 }, { mature_ready_at_ms: (NOW_SEC + 30) * 1000, produce_ready_at_ms: (NOW_SEC - 1) * 1000 }] }];
    assert.equal(tt.nextRanchReadyMs(ranches, NOW_SEC), (NOW_SEC + 30) * 1000);
});

test('扫列表记帮忙时间、删掉不在列表里的好友；进农场记成熟时间；到点排队（偷优先）；出发后去重', () => {
    const s = tt.emptyState();
    s.farm['999'] = { name: '旧好友', ripeAt: 1, helpAt: 0, seenAt: 1, visitedAt: 0 };
    tt.applyFarmList(s, [
        { gid: 1, name: '自己' },
        { gid: 11, name: 'A', plant: { weed_time_sec: NOW_SEC + 60 } },
        { gid: 12, remark: 'B备注', name: 'B', plant: {} },
    ], NOW_MS, NOW_SEC, 1);
    assert.equal(s.farm['1'], undefined, '不记自己');
    assert.equal(s.farm['999'], undefined, '删好友后清掉');
    assert.equal(s.farm['11'].helpAt, NOW_MS + 60_000);
    assert.equal(s.farm['12'].name, 'B备注');

    const ripeAt = tt.applyFarmLands(s, 12, 'B备注', [land(1, [NOW_SEC - 10, NOW_SEC + 10])], NOW_MS, NOW_SEC);
    assert.equal(ripeAt, NOW_MS + 10_000);
    // 刚进去过：30 秒内不重复去
    assert.deepEqual(tt.listDueFarm(s, NOW_MS + 10_000 + tt.FRIEND_ARRIVE_AFTER_MS), []);
    const later = NOW_MS + 61_000 + tt.FRIEND_ARRIVE_AFTER_MS;
    const due = tt.listDueFarm(s, later);
    assert.deepEqual(due.map(d => [d.gid, d.kind]), [[12, 'steal'], [11, 'help']], '偷优先，其次帮忙');
    assert.equal(tt.nextFarmDueAt(s), NOW_MS + tt.REVISIT_GAP_MS, '下一个到点时间（含去重间隔）');
    tt.markFarmVisiting(s, 12, later, 'steal');
    assert.deepEqual(tt.listDueFarm(s, later + 60_000).map(d => d.gid), [11], '出发后成熟时间清零，不会重复去');
    assert.deepEqual(tt.listDueFarm(s, later, 5, new Set([11])).map(d => d.gid), [], '黑名单 / 排除');
});

test('多位好友同时到点：每批最多 MAX_DUE_PER_BATCH 位，其余下一批', () => {
    const s = tt.emptyState();
    for (let i = 0; i < 8; i++) s.farm[String(100 + i)] = { name: `F${i}`, ripeAt: NOW_MS - i, helpAt: 0, seenAt: 1, visitedAt: 0 };
    const due = tt.listDueFarm(s, NOW_MS + 5000);
    assert.equal(due.length, tt.MAX_DUE_PER_BATCH);
    assert.equal(due[0].gid, 107, '最早成熟的先去');
});

test('列表里可偷数为 0、成熟时间过期很久：作废（已被收 / 偷完）', () => {
    const s = tt.emptyState();
    s.farm['5'] = { name: 'X', ripeAt: NOW_MS - 11 * 60_000, helpAt: 0, seenAt: 1, visitedAt: 0 };
    tt.applyFarmList(s, [{ gid: 5, name: 'X', plant: { steal_plant_num: 0 } }], NOW_MS, NOW_SEC, 1);
    assert.equal(s.farm['5'].ripeAt, 0);
});

test('好友土地推送：只把成熟时间往前更新', () => {
    const s = tt.emptyState();
    s.farm['7'] = { name: 'P', ripeAt: NOW_MS + 100_000, helpAt: 0, seenAt: 1, visitedAt: 0 };
    tt.applyPushLands(s, 7, [land(1, [NOW_SEC + 500])], NOW_MS, NOW_SEC);
    assert.equal(s.farm['7'].ripeAt, NOW_MS + 100_000, '推送里更晚的不覆盖');
    tt.applyPushLands(s, 7, [land(1, [NOW_SEC + 20])], NOW_MS, NOW_SEC);
    assert.equal(s.farm['7'].ripeAt, NOW_MS + 20_000);
});

test('好友牧场时间表：进去记可偷时间，到点排队，出发后去重', () => {
    const s = tt.emptyState();
    tt.applyRanch(s, 21, 'R', [{ animals: [{ produce_ready_at_ms: (NOW_SEC + 120) * 1000 }] }], NOW_MS, NOW_SEC);
    assert.equal(s.ranch['21'].readyAt, NOW_MS + 120_000);
    const at = NOW_MS + 120_000 + tt.FRIEND_ARRIVE_AFTER_MS;
    assert.equal(tt.nextRanchDueAt(s), at);
    assert.deepEqual(tt.listDueRanch(s, at - 1), []);
    assert.deepEqual(tt.listDueRanch(s, at).map(d => d.gid), [21]);
    tt.markRanchVisiting(s, 21, at);
    assert.deepEqual(tt.listDueRanch(s, at + 999_999), []);
});

test('[2026-11-17] 好友状态轮巡选人：没进过的先（等级高的先）；已知成熟时间跳过；空地过 15 分钟再看（最久没看的先）；试过的 15 分钟内不再试；最多 N 位', () => {
    const s = tt.emptyState();
    s.farm['2'] = { name: '', ripeAt: NOW_MS + 1000, helpAt: 0, seenAt: NOW_MS - 99 * 3600_000, visitedAt: 0 };
    s.farm['3'] = { name: '', ripeAt: 0, helpAt: 0, seenAt: NOW_MS - tt.FARM_EMPTY_RECHECK_MS, visitedAt: 0 };
    s.farm['4'] = { name: '', ripeAt: 0, helpAt: 0, seenAt: NOW_MS - 1000, visitedAt: 0 };
    s.farm['6'] = { name: '', ripeAt: 0, helpAt: 0, seenAt: NOW_MS - tt.FARM_EMPTY_RECHECK_MS - 5000, visitedAt: 0 };
    s.farm['7'] = { name: '', ripeAt: NOW_MS - 5000, helpAt: 0, seenAt: NOW_MS - 99 * 3600_000, visitedAt: 0 };
    const friends = [{ gid: 1, level: 50 }, { gid: 2, level: 60 }, { gid: 3, level: 10 }, { gid: 4, level: 99 }, { gid: 5, level: 70 }, { gid: 6, level: 1 }, { gid: 7 }, { gid: 8, level: 80 }];
    assert.deepEqual(tt.pickProbes(s, friends, NOW_MS, 100, new Set([1])).map(f => f.gid), [8, 5, 6, 3], '2 已知未来成熟、7 已过点交给时间表、4 空地刚看过');
    assert.deepEqual(tt.pickProbes(s, friends, NOW_MS, 1).map(f => f.gid), [8]);
    assert.deepEqual(tt.pickProbes(s, friends, NOW_MS, 100, new Set(), new Map([[8, NOW_MS - 1000], [5, NOW_MS - tt.PROBE_RETRY_MS]])).map(f => f.gid), [5, 1, 6, 3], '8 刚试过');
    assert.equal(tt.PROBE_MAX_PER_ROUND, 100);
});

test('[2026-11-17] 好友牧场状态轮巡选人：同规则，暂无可偷 10 分钟后再看', () => {
    const s = tt.emptyState();
    s.ranch['1'] = { name: '', readyAt: NOW_MS + 60_000, seenAt: NOW_MS - 1, visitedAt: 0 };
    s.ranch['2'] = { name: '', readyAt: 0, seenAt: NOW_MS - tt.RANCH_EMPTY_RECHECK_MS, visitedAt: 0 };
    s.ranch['3'] = { name: '', readyAt: 0, seenAt: NOW_MS - 60_000, visitedAt: 0 };
    assert.deepEqual(tt.pickRanchProbes(s, [{ gid: 1 }, { gid: 2 }, { gid: 3 }, { gid: 4 }], NOW_MS).map(f => f.gid), [4, 2]);
});

test('[2026-11-17] 翻阅节奏：每位 500～1000 毫秒，每 300 位休息 15～25 秒', () => {
    assert.deepEqual(tt.pageTurnDelay(1, () => 0), { gapMs: 500, restMs: 0 });
    assert.deepEqual(tt.pageTurnDelay(299, () => 0.999999), { gapMs: 1000, restMs: 0 });
    assert.deepEqual(tt.pageTurnDelay(300, () => 0), { gapMs: 500, restMs: 15_000 });
    assert.deepEqual(tt.pageTurnDelay(600, () => 0.5), { gapMs: 750, restMs: 20_000 });
});

test('杂项让路：30 秒内有到点事项或高优先级任务在跑就先不做', () => {
    assert.equal(tt.shouldMiscWait({ nowMs: NOW_MS, times: [0, NOW_MS + 31_000] }), false);
    assert.equal(tt.shouldMiscWait({ nowMs: NOW_MS, times: [NOW_MS + 29_000] }), true);
    assert.equal(tt.shouldMiscWait({ nowMs: NOW_MS, times: [NOW_MS - 5000] }), true, '已过点还没处理的也算');
    assert.equal(tt.shouldMiscWait({ nowMs: NOW_MS, busy: true, times: [] }), true);
});

test('时间格式', () => {
    const d = new Date(2026, 10, 17, 9, 5, 7).getTime();
    assert.equal(tt.formatClock(d), '09:05:07');
    assert.equal(tt.formatClock(0), '--:--:--');
    assert.equal(tt.formatRemain(65_000), '1 分 5 秒');
});

test('设置：按时间表偷菜默认开、扫描 5 分钟、提前 2 秒；范围收拢', () => {
    const { normalizeFnosQuietPriority } = require('../dist/services/fnos-quiet-priority');
    const d = normalizeFnosQuietPriority(undefined);
    assert.equal(d.timetableSteal, true);
    assert.equal(d.friendScanMinutes, 5);
    assert.equal(d.ownLeadSec, 2);
    const c = normalizeFnosQuietPriority({ timetableSteal: false, friendScanMinutes: 999, ownLeadSec: -3 });
    assert.deepEqual([c.timetableSteal, c.friendScanMinutes, c.ownLeadSec], [false, 60, 0]);
    const kept = normalizeFnosQuietPriority({ ownHarvestFirst: false }, c);
    assert.equal(kept.timetableSteal, false, '部分更新保留原值');
});

test('源码约束：时间表访问走同一套访问计划 + 大小号规则、不捣乱；牧场时间表走 wrapFriendWanted；日志写明「按时间表前往」', () => {
    const read = rel => fs.readFileSync(path.join(__dirname, '../src', rel), 'utf8');
    const sched = read('services/friend/scheduler.ts');
    assert.match(sched, /adjustVisitPlanForAltCoop\(ttPlan, \{\s*coop: altCoop, friends: rows, blacklist, badActive: false/);
    assert.match(sched, /badEnabled: false/);
    assert.match(sched, /按时间表前往 \$\{v\.name\}/);
    const ranch = read('services/ranch/automation.ts');
    assert.match(ranch, /automateFriend\(friend\.gid, fnosRanch\.wrapFriendWanted\(friend\.gid, wanted\), shouldYield\)/);
    assert.match(ranch, /按时间表前往 \$\{friend\.name \|\| due\.name\}（预计可偷/);
    assert.match(read('services/friend/visit-strategy.ts'), /noteFarmLands\(gid, name, lands\)/);
    assert.match(read('services/ranch/friends.ts'), /noteRanch\(host, '', ranches\)/);
});

test('[2026-11-17] buildSnapshot：前端「还多久可偷」行带上成熟 / 帮忙 / 牧场可偷时间和是否扫描过', () => {
    const tt = require('../dist/services/fnos-timetable');
    const rows = tt.buildSnapshot({
        farm: { 11: { name: '甲', ripeAt: 5000, helpAt: 6000, seenAt: 100, visitedAt: 100 } },
        ranch: { 11: { name: '', readyAt: 7000, seenAt: 200, visitedAt: 200 }, 22: { name: '乙', readyAt: 0, seenAt: 0, visitedAt: 0 } },
    });
    assert.deepEqual(rows.find(r => r.gid === 11), { gid: 11, name: '甲', farmRipeAt: 5000, farmHelpAt: 6000, farmSeenAt: 100, farmVisitedAt: 100, ranchReadyAt: 7000, ranchSeenAt: 200, ranchVisitedAt: 200 });
    assert.deepEqual(rows.find(r => r.gid === 22), { gid: 22, name: '乙', farmRipeAt: 0, farmHelpAt: 0, farmSeenAt: 0, farmVisitedAt: 0, ranchReadyAt: 0, ranchSeenAt: 0, ranchVisitedAt: 0 });
    assert.deepEqual(tt.readSnapshotForAccount('no-such-account-xyz'), [], '没有文件时返回空');
});
