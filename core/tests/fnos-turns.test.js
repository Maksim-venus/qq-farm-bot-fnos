// [fnos-fork] 2026-11-17 农场、牧场轮流：纯状态机（轮次切换、插队、下次唤醒时间、超时兜底、日志）
const assert = require('node:assert/strict');
const test = require('node:test');
const turns = require('../dist/services/fnos-turns');

const logs = [];
turns.setTurnLogger(msg => logs.push(msg));
const INF = Number.POSITIVE_INFINITY;
const ev = (o) => turns.evaluateTurn({ nowMs: 0, ranchDue: false, ranchHasWork: true, friendActive: true, ...o });

test('农场一轮 = 巡田 + 好友巡查；都做完且牧场到点才切牧场，日志写明', () => {
    turns.resetTurns(0); logs.length = 0;
    assert.equal(ev({ nowMs: 1, ranchDue: true }), 'farm', '还没巡田');
    turns.noteFarmTickDone();
    assert.equal(ev({ nowMs: 2, ranchDue: true }), 'farm', '好友巡查还没做');
    turns.noteFriendDone();
    assert.equal(ev({ nowMs: 3, ranchDue: true }), 'ranch');
    assert.deepEqual(logs, ['轮次切换：农场 → 牧场（农场一轮完成（巡田 + 好友巡查））']);
});

test('好友巡查关闭时，巡田做完就算一轮', () => {
    turns.resetTurns(0); logs.length = 0;
    turns.noteFarmTickDone();
    assert.equal(ev({ nowMs: 1, ranchDue: true, friendActive: false }), 'ranch');
    assert.match(logs[0], /农场一轮完成（巡田）/);
});

test('农场一轮做完但牧场还在场景重进间隔里：留在农场开始新一轮（不写日志），之后要重新做完一轮', () => {
    turns.resetTurns(0); logs.length = 0;
    turns.noteFarmTickDone(); turns.noteFriendDone();
    assert.equal(ev({ nowMs: 1, ranchDue: false }), 'farm');
    assert.equal(ev({ nowMs: 2, ranchDue: true }), 'farm', '新一轮还没做');
    assert.deepEqual(logs, []);
});

test('牧场轮：一轮做完回农场；让路（yielded）不算完；出错 / 无事也回农场；农场轮里插队的牧场不推动轮次', () => {
    turns.resetTurns(0); logs.length = 0;
    turns.noteRanchRun('done');
    assert.equal(turns.currentTurn(), 'farm', '农场轮里插队跑的牧场不影响');
    turns.noteFarmTickDone(); turns.noteFriendDone(); ev({ nowMs: 1, ranchDue: true });
    turns.noteRanchRun('yielded');
    assert.equal(turns.currentTurn(), 'ranch');
    turns.noteRanchRun('done');
    assert.equal(turns.currentTurn(), 'farm');
    assert.match(logs.at(-1), /牧场 → 农场（牧场一轮完成）/);
    // 牧场轮里巡田插队不算农场轮完成
    turns.noteFarmTickDone(); turns.noteFriendDone(); ev({ nowMs: 2, ranchDue: true });
    turns.noteFarmTickDone();
    turns.noteRanchRun('error');
    assert.equal(turns.currentTurn(), 'farm');
    assert.equal(turns.getTurnState().farmTickDone, false, '切回农场后从头算一轮');
});

test('牧场轮：牧场没事了 / 超时 → 回农场', () => {
    turns.resetTurns(0);
    turns.noteFarmTickDone(); turns.noteFriendDone(); ev({ nowMs: 1, ranchDue: true });
    assert.equal(ev({ nowMs: 2, ranchHasWork: false }), 'farm');
    turns.noteFarmTickDone(); turns.noteFriendDone(); ev({ nowMs: 10, ranchDue: true });
    assert.equal(ev({ nowMs: 10 + turns.RANCH_TURN_MAX_MS }), 'ranch');
    assert.equal(ev({ nowMs: 11 + turns.RANCH_TURN_MAX_MS }), 'farm');
});

test('allowedNow：轮到谁谁跑，插队无论轮次都放行', () => {
    turns.resetTurns(0);
    assert.deepEqual(turns.allowedNow({ farmTimedDue: false, ranchTimedDue: false }), { farm: true, friend: true, ranch: false, farmInsert: false, ranchInsert: false, friendInsert: false });
    assert.deepEqual(turns.allowedNow({ farmTimedDue: false, ranchTimedDue: true }), { farm: true, friend: true, ranch: true, farmInsert: false, ranchInsert: true, friendInsert: false });
    turns.noteFarmTickDone(); turns.noteFriendDone(); ev({ nowMs: 1, ranchDue: true });
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
    assert.equal(turns.nextWakeAt({ ...base, ranchDue: true }), 100, '一轮做完且牧场到点：马上切');
    ev({ nowMs: 100, ranchDue: true });
    assert.equal(turns.nextWakeAt(base), 300, '牧场轮不看农场常规时间');
    assert.equal(turns.nextWakeAt({ ...base, farmTimedAt: 150 }), 150, '自家作物将熟插队');
    assert.equal(turns.nextWakeAt({ ...base, ranchNextRunAt: INF }), INF, '牧场例程排队中：等它结束再排');
});

test('[2026-11-17] 严格交替：好友巡查这一轮没到点（按时间表几分钟一次）时，巡田做完就切牧场，不等 ranch_check_minutes', () => {
    turns.resetTurns(0); logs.length = 0;
    turns.noteFarmTickDone();
    assert.equal(ev({ nowMs: 1, ranchDue: true, friendPending: false }), 'ranch');
    assert.match(logs[0], /农场一轮完成（巡田）/);
    turns.noteRanchRun('done', 2);
    assert.equal(turns.currentTurn(), 'farm', '牧场一轮做完立刻回农场');
    turns.noteFarmTickDone();
    assert.equal(ev({ nowMs: 3, ranchDue: true, friendPending: true }), 'farm', '好友巡查到点了：等它做完');
    turns.noteFriendDone();
    assert.equal(ev({ nowMs: 4, ranchDue: true, friendPending: true }), 'ranch');
});

test('[2026-11-17] 牧场今天没事可做：农场一轮做完也不切牧场', () => {
    turns.resetTurns(0); logs.length = 0;
    turns.noteFarmTickDone();
    assert.equal(ev({ nowMs: 1, ranchDue: true, ranchHasWork: false, friendPending: false }), 'farm');
    assert.deepEqual(logs, []);
});

test('[2026-11-17] nextWakeAt：农场轮也按自家提前蹲点时间唤醒；好友时间表任何轮次都唤醒；牧场在重进间隔里等到间隔结束', () => {
    const base = { nowMs: 100, nextFarmRunAt: 500, nextFriendRunAt: 800, ranchNextRunAt: 300, farmTimedAt: 0, ranchTimedAt: 0, farmBusy: false, friendBusy: false, ranchDue: false, friendActive: true };
    turns.resetTurns(0);
    assert.equal(turns.nextWakeAt({ ...base, farmTimedAt: 150 }), 150, '自家作物到期前 2 秒');
    assert.equal(turns.nextWakeAt({ ...base, friendTimedAt: 120 }), 120, '好友时间表到点');
    assert.equal(turns.nextWakeAt({ ...base, friendTimedAt: 120, friendBusy: true }), 500, '好友任务在跑：由巡查自己插队');
    turns.noteFarmTickDone();
    assert.equal(turns.nextWakeAt({ ...base, nextFriendRunAt: 9000 }), 300, '一轮做完、好友没到点：等牧场重进间隔');
    assert.equal(turns.nextWakeAt({ ...base, nextFriendRunAt: 9000, ranchHasWork: false }), 500, '牧场无事：不等牧场');
    ev({ nowMs: 300, ranchDue: true, friendPending: false });
    assert.equal(turns.currentTurn(), 'ranch');
    assert.equal(turns.nextWakeAt({ ...base, friendTimedAt: 200 }), 200, '牧场轮里好友时间表到点');
});
