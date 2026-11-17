// [fnos-fork] 2026-11-17 农场、牧场轮流：纯状态机（轮次切换、每边至少 1 分钟、等自家收获、插队、下次唤醒时间、超时兜底、日志）
const assert = require('node:assert/strict');
const test = require('node:test');
const turns = require('../dist/services/fnos-turns');

const logs = [];
turns.setTurnLogger(msg => logs.push(msg));
const INF = Number.POSITIVE_INFINITY;
const D = turns.MIN_DWELL_MS;
const ev = (o) => turns.evaluateTurn({ nowMs: 0, ranchDue: false, ranchHasWork: true, friendActive: true, ...o });
/** 从农场切到牧场（时刻 at，至少 D） */
function toRanch(at) {
    turns.noteFarmTickDone(); turns.noteFriendDone();
    ev({ nowMs: at, ranchDue: true });
    assert.equal(turns.currentTurn(), 'ranch');
}

test('常量：每边至少 1 分钟、30 秒内有自家收获先等、最多多等 2 分钟', () => {
    assert.equal(turns.MIN_DWELL_MS, 60_000);
    assert.equal(turns.OWN_HOLD_MS, 30_000);
    assert.equal(turns.MAX_OWN_HOLD_MS, 120_000);
});

test('农场一轮 = 巡田 + 好友巡查；都做完、满 1 分钟且牧场可进才切牧场，日志写明', () => {
    turns.resetTurns(0); logs.length = 0;
    assert.equal(ev({ nowMs: D, ranchDue: true }), 'farm', '还没巡田');
    turns.noteFarmTickDone();
    assert.equal(ev({ nowMs: D, ranchDue: true }), 'farm', '好友巡查还没做');
    turns.noteFriendDone();
    assert.equal(ev({ nowMs: D - 1, ranchDue: true }), 'farm', '在农场还没满 1 分钟');
    assert.equal(ev({ nowMs: D, ranchDue: true }), 'ranch');
    assert.deepEqual(logs, ['轮次切换：农场 → 牧场（农场一轮完成（巡田 + 好友巡查））']);
});

test('好友巡查关闭时，巡田做完（满 1 分钟）就算一轮', () => {
    turns.resetTurns(0); logs.length = 0;
    turns.noteFarmTickDone();
    assert.equal(ev({ nowMs: D, ranchDue: true, friendActive: false }), 'ranch');
    assert.match(logs[0], /农场一轮完成（巡田）/);
});

test('农场一轮做完但牧场暂时不能进（出错退避）：留在农场开始新一轮（不写日志）', () => {
    turns.resetTurns(0); logs.length = 0;
    turns.noteFarmTickDone(); turns.noteFriendDone();
    assert.equal(ev({ nowMs: D, ranchDue: false }), 'farm');
    assert.equal(ev({ nowMs: D + 1, ranchDue: true }), 'farm', '新一轮还没做');
    assert.deepEqual(logs, []);
});

test('牧场轮：一轮做完后满 1 分钟才回农场；做完期间不重跑；让路不算完；出错 / 无事立即回农场；农场轮里插队的牧场不推动轮次', () => {
    turns.resetTurns(0); logs.length = 0;
    turns.noteRanchRun('done');
    assert.equal(turns.currentTurn(), 'farm', '农场轮里插队跑的牧场不影响');
    assert.equal(turns.ranchRoundDone(), false);
    toRanch(D);
    turns.noteRanchRun('yielded');
    assert.equal(turns.ranchRoundDone(), false);
    turns.noteRanchRun('done', D + 10_000);
    assert.equal(turns.currentTurn(), 'ranch', '牧场一轮 10 秒做完：还要在牧场待满 1 分钟');
    assert.equal(turns.ranchRoundDone(), true, '等待期间常规牧场例程不重跑');
    assert.equal(ev({ nowMs: 2 * D - 1 }), 'ranch');
    assert.equal(ev({ nowMs: 2 * D }), 'farm');
    assert.match(logs.at(-1), /牧场 → 农场（牧场一轮完成）/);
    // 牧场轮里巡田插队不算农场轮完成；出错立即回农场
    toRanch(3 * D);
    turns.noteFarmTickDone();
    turns.noteRanchRun('error');
    assert.equal(turns.currentTurn(), 'farm');
    assert.equal(turns.getTurnState().farmTickDone, false, '切回农场后从头算一轮');
});

test('牧场轮：牧场没事了 / 超时 → 回农场', () => {
    turns.resetTurns(0);
    toRanch(D);
    assert.equal(ev({ nowMs: D + 1, ranchHasWork: false }), 'farm');
    toRanch(3 * D);
    assert.equal(ev({ nowMs: 3 * D + turns.RANCH_TURN_MAX_MS }), 'ranch');
    assert.equal(ev({ nowMs: 3 * D + 1 + turns.RANCH_TURN_MAX_MS }), 'farm');
});

test('切换前 30 秒内这一边有自家收获：先不切，等收完；最多多等 2 分钟', () => {
    turns.resetTurns(0); logs.length = 0;
    turns.noteFarmTickDone(); turns.noteFriendDone();
    assert.equal(ev({ nowMs: D, ranchDue: true, ownFarmAt: D + 20_000 }), 'farm', '自家作物 20 秒后成熟');
    assert.match(logs[0], /农场一轮已完成，自家 .* 到期，先等收完再切换/);
    assert.equal(ev({ nowMs: D + 21_000, ranchDue: true, ownFarmAt: D + 20_000 }), 'farm', '刚过点 10 秒内还没收也等');
    assert.equal(ev({ nowMs: D + 22_000, ranchDue: true, ownFarmAt: D + 22_000 + 3_600_000 }), 'ranch', '收完了（下一次成熟很久以后）');
    // 牧场这边同理
    turns.noteRanchRun('done', D + 30_000);
    assert.equal(ev({ nowMs: 2 * D + 22_000, ownRanchAt: 2 * D + 40_000 }), 'ranch', '自家动物 18 秒后成熟');
    assert.equal(ev({ nowMs: 2 * D + 41_000, ownRanchAt: 2 * D + 41_000 + 600_000 }), 'farm');
    // 作物一个接一个成熟：最多多等 2 分钟
    toRanch(10 * D); turns.noteRanchRun('done', 10 * D + 1);
    for (let t = 11 * D; t < 11 * D + turns.MAX_OWN_HOLD_MS; t += 10_000) assert.equal(ev({ nowMs: t, ownRanchAt: t + 5_000 }), 'ranch');
    assert.equal(ev({ nowMs: 11 * D + turns.MAX_OWN_HOLD_MS, ownRanchAt: 11 * D + turns.MAX_OWN_HOLD_MS + 5_000 }), 'farm');
});

test('自家收获在 30 秒以外：满 1 分钟照常切', () => {
    turns.resetTurns(0);
    turns.noteFarmTickDone(); turns.noteFriendDone();
    assert.equal(ev({ nowMs: D, ranchDue: true, ownFarmAt: D + 31_000 }), 'ranch');
});

test('allowedNow：轮到谁谁跑，插队无论轮次都放行', () => {
    turns.resetTurns(0);
    assert.deepEqual(turns.allowedNow({ farmTimedDue: false, ranchTimedDue: false }), { farm: true, friend: true, ranch: false, farmInsert: false, ranchInsert: false, friendInsert: false });
    assert.deepEqual(turns.allowedNow({ farmTimedDue: false, ranchTimedDue: true }), { farm: true, friend: true, ranch: true, farmInsert: false, ranchInsert: true, friendInsert: false });
    toRanch(D);
    assert.deepEqual(turns.allowedNow({ farmTimedDue: false, ranchTimedDue: false }), { farm: false, friend: false, ranch: true, farmInsert: false, ranchInsert: false, friendInsert: false });
    assert.deepEqual(turns.allowedNow({ farmTimedDue: true, ranchTimedDue: false }), { farm: true, friend: false, ranch: true, farmInsert: true, ranchInsert: false, friendInsert: false });
    assert.deepEqual(turns.allowedNow({ farmTimedDue: false, ranchTimedDue: false, friendTimedDue: true }), { farm: false, friend: false, ranch: true, farmInsert: false, ranchInsert: false, friendInsert: true }, '牧场轮里好友时间表到点也插队');
});

test('nextWakeAt：只等当前轮次和对方插队时间，不空转', () => {
    const base = { nowMs: 100, nextFarmRunAt: 500, nextFriendRunAt: 800, ranchNextRunAt: 300, farmTimedAt: 0, ranchTimedAt: 0, farmBusy: false, friendBusy: false, ranchDue: false, friendActive: true };
    turns.resetTurns(0);
    assert.equal(turns.nextWakeAt(base), 500, '农场轮不看牧场常规时间');
    assert.equal(turns.nextWakeAt({ ...base, ranchTimedAt: 200 }), 200, '牧场插队时间');
    assert.equal(turns.nextWakeAt({ ...base, farmBusy: true, friendBusy: true }), INF);
    turns.noteFarmTickDone(); turns.noteFriendDone();
    assert.equal(turns.nextWakeAt({ ...base, nextFarmRunAt: 9e9, nextFriendRunAt: 9e9, ranchDue: true }), D, '一轮做完：等到满 1 分钟');
    const t = { ...base, nowMs: D + 100, nextFarmRunAt: D + 500, nextFriendRunAt: D + 800, ranchNextRunAt: D + 300 };
    assert.equal(turns.nextWakeAt({ ...t, ranchDue: true }), D + 100, '满 1 分钟且牧场可进：马上切');
    ev({ nowMs: D + 100, ranchDue: true });
    assert.equal(turns.nextWakeAt(t), D + 300, '牧场轮不看农场常规时间');
    assert.equal(turns.nextWakeAt({ ...t, farmTimedAt: D + 150 }), D + 150, '自家作物将熟插队');
    assert.equal(turns.nextWakeAt({ ...t, ranchNextRunAt: INF }), INF, '牧场例程排队中：等它结束再排');
    turns.noteRanchRun('done', D + 200);
    assert.equal(turns.nextWakeAt({ ...t, nowMs: D + 200, ranchNextRunAt: D + 200 }), 2 * D + 100, '牧场做完：等满 1 分钟再回农场，不重跑');
    assert.equal(turns.nextWakeAt({ ...t, nowMs: D + 200, ranchNextRunAt: D + 200, ranchTimedAt: D + 900 }), D + 900, '等待期间自家动物到期照样插队');
    assert.equal(turns.nextWakeAt({ ...t, nowMs: 3 * D, ranchNextRunAt: 3 * D }), 3 * D + 5000, '满 1 分钟后（在等自家收获）5 秒兜底复查');
});

test('[2026-11-17] 严格交替：好友巡查这一轮没到点时，巡田做完（满 1 分钟）就切牧场，不等 ranch_check_minutes', () => {
    turns.resetTurns(0); logs.length = 0;
    turns.noteFarmTickDone();
    assert.equal(ev({ nowMs: D, ranchDue: true, friendPending: false }), 'ranch');
    assert.match(logs[0], /农场一轮完成（巡田）/);
    turns.noteRanchRun('done', D + 1);
    assert.equal(ev({ nowMs: 2 * D }), 'farm');
    turns.noteFarmTickDone();
    assert.equal(ev({ nowMs: 3 * D, ranchDue: true, friendPending: true }), 'farm', '好友巡查到点了：等它做完');
    turns.noteFriendDone();
    assert.equal(ev({ nowMs: 3 * D, ranchDue: true, friendPending: true }), 'ranch');
});

test('[2026-11-17] 牧场今天没事可做：农场一轮做完也不切牧场', () => {
    turns.resetTurns(0); logs.length = 0;
    turns.noteFarmTickDone();
    assert.equal(ev({ nowMs: D, ranchDue: true, ranchHasWork: false, friendPending: false }), 'farm');
    assert.deepEqual(logs, []);
});

test('[2026-11-17] nextWakeAt：农场轮也按自家提前蹲点时间唤醒；好友时间表任何轮次都唤醒', () => {
    const base = { nowMs: 100, nextFarmRunAt: 500, nextFriendRunAt: 800, ranchNextRunAt: 300, farmTimedAt: 0, ranchTimedAt: 0, farmBusy: false, friendBusy: false, ranchDue: false, friendActive: true };
    turns.resetTurns(0);
    assert.equal(turns.nextWakeAt({ ...base, farmTimedAt: 150 }), 150, '自家作物到期前 2 秒');
    assert.equal(turns.nextWakeAt({ ...base, friendTimedAt: 120 }), 120, '好友时间表到点');
    assert.equal(turns.nextWakeAt({ ...base, friendTimedAt: 120, friendBusy: true }), 500, '好友任务在跑：由巡查自己插队');
    turns.noteFarmTickDone();
    assert.equal(turns.nextWakeAt({ ...base, nextFriendRunAt: 9000, ranchHasWork: false }), 500, '牧场无事：不等牧场');
    ev({ nowMs: D, ranchDue: true, friendPending: false });
    assert.equal(turns.currentTurn(), 'ranch');
    assert.equal(turns.nextWakeAt({ ...base, nowMs: D, friendTimedAt: 200 }), 200, '牧场轮里好友时间表到点');
});

test('[fnos-fork] 2026-11-17 上游牧场每日福利按杂项（空闲时）领取', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/services/ranch/automation.ts'), 'utf8');
    assert.match(src, /if \(!miscWait\) await phase\('benefit'/);
    assert.match(src, /'ranch_daily_benefit', 'ranch_grass_buy'\]\.includes\(key\) && auto\[key\]\) \|\| fnosRanch\.hasForkWork\(\)/);
});
