// [fnos-fork] 在线期间来偷菜的自动删除、配置落盘（偷收比相关功能已于 2026-11-23 下架）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
    normalizeFnosStealRatio,
    collectProtectedGids,
    beginOnlineStealSession,
    planOnlineStealDeletes,
    collectOnlineStealProtectedGids,
    shouldNotifyOnlineStealDelete,
    describeFnosStealRatio,
    ONLINE_STEAL_DELETE_INTERVAL_MS,
} = require('../dist/services/friend/fnos-steal-ratio');

test('缺省在线期间删除关；旧配置里的偷收比 / 筛选 / Bark / 自动删除字段读取时丢弃；没带的开关沿用已保存值', () => {
    assert.deepEqual(normalizeFnosStealRatio(undefined), { autoDeleteOnlineStealer: false });
    assert.deepEqual(normalizeFnosStealRatio({
        thresholdPercent: 90, ignoreApplications: true, listFilter: true, barkOnSteal: true, autoDelete: true,
    }), { autoDeleteOnlineStealer: false });
    assert.deepEqual(normalizeFnosStealRatio({ autoDeleteOnlineStealer: true, autoDelete: true, thresholdPercent: 90 }), { autoDeleteOnlineStealer: true });
    assert.deepEqual(normalizeFnosStealRatio({}, { autoDeleteOnlineStealer: true }), { autoDeleteOnlineStealer: true });
    assert.deepEqual(normalizeFnosStealRatio({ autoDeleteOnlineStealer: false }, { autoDeleteOnlineStealer: true }), { autoDeleteOnlineStealer: false });
});

test('已下架的偷收比功能不再导出', () => {
    const m = require('../dist/services/friend/fnos-steal-ratio');
    for (const name of ['stealRatioInfo', 'isStealRatioAbove', 'decideStealRatioApplication', 'planStealRatioDeletions', 'planStealAlerts', 'lookupStealRatios', 'formatStealRatioReason']) {
        assert.equal(m[name], undefined, name);
    }
});

test('配置写入账号文件后读回；大小号 GID 不在删除保护名单之外', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-steal-ratio-'));
    const env = { ...process.env, QQ_FARM_DATA_DIR: dir, FARM_ACCOUNT_ID: '2' };
    const script = `
        const store = require('./dist/models/store');
        const m = require('./dist/services/friend/fnos-steal-ratio');
        store.applyConfigSnapshot({
            fnosAltAccount: { enabled: true, masterGid: 100, masterName: '大号' },
            fnosStealRatio: { ignoreApplications: true, thresholdPercent: 75, autoDelete: true },
        }, { accountId: '2' });
        store.applyConfigSnapshot({
            fnosAltAccount: { enabled: true, masterGid: 200, masterName: '另一大号' },
        }, { accountId: '3' });
        store.applyConfigSnapshot({}, { accountId: '4' });
        m.writeSelfGid('2', 222);
        m.writeSelfGid('3', 333);
        m.writeSelfGid('4', 444);
        store.applyConfigSnapshot({
            fnosStealRatio: { autoDeleteOnlineStealer: true },
        }, { accountId: '2' });
        const snap = store.getConfigSnapshot('2');
        const other = store.getConfigSnapshot('9');
        const after = store.getConfigSnapshot('2');
        console.log(JSON.stringify({
            ratio: snap.fnosStealRatio,
            other: other.fnosStealRatio,
            protected: m.readProtectedGidList().sort((a, b) => a - b),
            after: after.fnosStealRatio,
            onlineProtected: m.readOnlineStealProtectedGids().sort((a, b) => a - b),
        }));
    `;
    const r = spawnSync(process.execPath, ['-e', script], {
        cwd: path.join(__dirname, '..'),
        env,
        encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    // 旧字段（偷收比阈值、忽略申请、自动删除）读取时丢弃，只剩在线期间删除这一个开关
    assert.deepEqual(Object.keys(out.ratio), ['autoDeleteOnlineStealer']);
    assert.deepEqual(out.after, { autoDeleteOnlineStealer: true });
    assert.equal(out.onlineProtected.includes(777), false); // 奶茶「优先雇佣人」排除已随奶茶 fork 功能下架
    assert.ok(out.onlineProtected.includes(100));
    assert.ok(out.onlineProtected.includes(222));
    assert.equal(out.onlineProtected.includes(444), false);
    assert.deepEqual(out.other, { autoDeleteOnlineStealer: false });
    assert.deepEqual(out.protected, [100, 200, 222, 333]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'fnos-account-gids.json'), 'utf8'));
    assert.equal(saved['3'], 333);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('在线期间偷菜：上线前和掉线期间不删，上线后才删；重连重新计时；排除名单；节流；同一 gid 不重复', () => {
    const cats = require('../dist/runtime/fnos-log-categories');
    assert.equal(cats.isFnosStealLog({
        msg: '准备删除好友 张三（GID 9）：2026-11-01 12:00:00 来偷菜，原因：在线期间偷菜',
        meta: { event: '在线期间偷菜' },
    }), true);
    assert.equal(ONLINE_STEAL_DELETE_INTERVAL_MS, 60 * 1000);
    assert.match(describeFnosStealRatio({
        autoDeleteOnlineStealer: false,
    }), /未启用/);
    assert.match(describeFnosStealRatio({
        autoDeleteOnlineStealer: true,
    }), /在线期间/);
    assert.equal(shouldNotifyOnlineStealDelete({ barkOnSteal: false }, { channel: 'bark', token: 'k' }), true);
    assert.equal(shouldNotifyOnlineStealDelete({ barkOnSteal: true }, { channel: 'bark', token: 'k' }), true);
    assert.equal(shouldNotifyOnlineStealDelete({ barkOnSteal: true }, { channel: 'pushplus', token: 'k' }), false);
    assert.equal(shouldNotifyOnlineStealDelete({ barkOnSteal: false }, { channel: 'bark', token: '' }), false);
    assert.equal(shouldNotifyOnlineStealDelete({ barkOnSteal: false }, null), false);

    const protectedGids = collectOnlineStealProtectedGids({
        snaps: [
            { accountId: '2', selfGid: 222, enabled: true, masterGid: 100 },
            { accountId: '3', selfGid: 333, enabled: false, masterGid: 200 },
            { accountId: '4', selfGid: 444, enabled: false, masterGid: 0 },
        ],
        extraGids: [222],
        priorityGids: [777, 0, 777],
    }).sort((a, b) => a - b);
    assert.deepEqual(protectedGids, [100, 200, 222, 333, 777]);

    let session = beginOnlineStealSession(1000);
    let step = planOnlineStealDeletes({
        session,
        records: [
            { actionType: 1, visitorGid: 9, serverTimeSec: 900, nick: '上线前' },
            { actionType: 2, visitorGid: 8, serverTimeSec: 950, nick: '帮忙' },
        ],
        protectedGids,
        nowMs: 1_000_000,
    });
    assert.equal(step.baselined, true);
    assert.equal(step.deleteNow, null);
    assert.equal(step.session.watermarkSec, 900);

    step = planOnlineStealDeletes({
        session: step.session,
        records: [
            { actionType: 1, visitorGid: 9, serverTimeSec: 900, nick: '上线前' },
            { actionType: 1, visitorGid: 8, serverTimeSec: 950, nick: '仍在上线前' },
        ],
        protectedGids,
        nowMs: 1_100_000,
    });
    assert.equal(step.deleteNow, null);
    assert.equal(step.session.queue.length, 0);

    step = planOnlineStealDeletes({
        session: step.session,
        records: [
            { actionType: 1, visitorGid: 777, serverTimeSec: 1100, nick: '优先雇佣人', actionDetail: '偷取作物' },
            { actionType: 1, visitorGid: 100, serverTimeSec: 1101, nick: '大号' },
            { actionType: 1, visitorGid: 7, serverTimeSec: 1102, nick: '在线甲', actionDetail: '偷取 白菜 × 1' },
            { actionType: 1, visitorGid: 6, serverTimeSec: 1103, nick: '在线乙' },
            { actionType: 1, visitorGid: 7, serverTimeSec: 1104, nick: '在线甲又偷' },
        ],
        protectedGids,
        nowMs: 2_000_000,
    });
    assert.equal(step.skipped.map(item => item.gid).sort((a, b) => a - b).join(','), '100,777');
    assert.equal(step.deleteNow && step.deleteNow.gid, 7);
    assert.equal(step.deleteNow.reason, '在线期间偷菜');
    assert.equal(step.session.queue.length, 1);
    assert.equal(step.session.queue[0].gid, 6);
    assert.equal(step.session.nextDeleteAt, 2_000_000 + ONLINE_STEAL_DELETE_INTERVAL_MS);

    step = planOnlineStealDeletes({
        session: step.session,
        records: [{ actionType: 1, visitorGid: 6, serverTimeSec: 1103, nick: '在线乙' }],
        protectedGids,
        nowMs: 2_000_000 + 30 * 1000,
    });
    assert.equal(step.deleteNow, null);
    assert.equal(step.session.queue.length, 1);

    step = planOnlineStealDeletes({
        session: step.session,
        records: [
            { actionType: 1, visitorGid: 7, serverTimeSec: 1300, nick: '在线甲再偷' },
            { actionType: 1, visitorGid: 6, serverTimeSec: 1103, nick: '在线乙' },
        ],
        protectedGids,
        nowMs: 2_000_000 + ONLINE_STEAL_DELETE_INTERVAL_MS,
    });
    assert.equal(step.deleteNow && step.deleteNow.gid, 6);
    assert.equal(step.session.queue.length, 0);

    // 重连：上线时刻重置，掉线期间和重连后第一次拉取都不删
    session = beginOnlineStealSession(2000);
    step = planOnlineStealDeletes({
        session,
        records: [
            { actionType: 1, visitorGid: 4, serverTimeSec: 1500, nick: '掉线期间' },
            { actionType: 1, visitorGid: 3, serverTimeSec: 2100, nick: '重连后首次拉取' },
        ],
        protectedGids,
        nowMs: 3_000_000,
    });
    assert.equal(step.baselined, true);
    assert.equal(step.deleteNow, null);
    step = planOnlineStealDeletes({
        session: step.session,
        records: [
            { actionType: 1, visitorGid: 4, serverTimeSec: 1500, nick: '掉线期间' },
            { actionType: 1, visitorGid: 3, serverTimeSec: 2100, nick: '基线' },
            { actionType: 1, visitorGid: 2, serverTimeSec: 2200, nick: '重连后新的' },
        ],
        protectedGids,
        nowMs: 3_000_000 + ONLINE_STEAL_DELETE_INTERVAL_MS,
    });
    assert.equal(step.deleteNow && step.deleteNow.gid, 2);

    // 没有可靠时间戳：第一次拉取作基线，之后新增的才算；重连后重新建基线，断线期间新增的不算
    session = beginOnlineStealSession(5000);
    const oldUntimed = { actionType: 1, visitorGid: 9, serverTimeSec: 0, nick: '无时间', actionDetail: '偷取作物', landId: 1, cropId: 2, cropCount: 1 };
    const newUntimed = { actionType: 1, visitorGid: 8, serverTimeSec: 0, nick: '新的', actionDetail: '偷取 白菜', landId: 3, cropId: 4, cropCount: 1 };
    step = planOnlineStealDeletes({ session, records: [oldUntimed], protectedGids: [], nowMs: 1 });
    assert.equal(step.deleteNow, null);
    step = planOnlineStealDeletes({ session: step.session, records: [oldUntimed, newUntimed], protectedGids: [], nowMs: 2 });
    assert.equal(step.deleteNow && step.deleteNow.gid, 8);
    session = beginOnlineStealSession(9000);
    step = planOnlineStealDeletes({ session, records: [newUntimed], protectedGids: [], nowMs: 3 });
    assert.equal(step.baselined, true);
    assert.equal(step.deleteNow, null);
    step = planOnlineStealDeletes({ session: step.session, records: [newUntimed], protectedGids: [], nowMs: 4 });
    assert.equal(step.deleteNow, null);
});
