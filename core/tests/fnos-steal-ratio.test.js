// [fnos-fork] 偷收比：公式、申请拒绝、删除排除大小号、Bark 节流、配置落盘
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
    normalizeFnosStealRatio,
    stealRatioInfo,
    isStealRatioAbove,
    decideStealRatioApplication,
    collectProtectedGids,
    planStealRatioDeletions,
    planStealAlerts,
    formatStealRatioReason,
} = require('../dist/services/friend/fnos-steal-ratio');

test('缺省四项全关、阈值 80；非法阈值回退；没带的开关沿用已保存值', () => {
    assert.deepEqual(normalizeFnosStealRatio(undefined), {
        thresholdPercent: 80,
        ignoreApplications: false,
        listFilter: false,
        barkOnSteal: false,
        autoDelete: false,
    });
    const kept = normalizeFnosStealRatio({ autoDelete: true }, {
        thresholdPercent: 90,
        ignoreApplications: true,
        listFilter: true,
        barkOnSteal: false,
        autoDelete: false,
    });
    assert.equal(kept.thresholdPercent, 90);
    assert.equal(kept.ignoreApplications, true);
    assert.equal(kept.listFilter, true);
    assert.equal(kept.barkOnSteal, false);
    assert.equal(kept.autoDelete, true);
    assert.equal(normalizeFnosStealRatio({ thresholdPercent: 0 }).thresholdPercent, 80);
    assert.equal(normalizeFnosStealRatio({ thresholdPercent: 80.6 }).thresholdPercent, 81);
});

test('偷收比 = 生涯偷菜 / 生涯收获；等于阈值不触发，只偷不收触发', () => {
    assert.equal(stealRatioInfo(100, 80).text, '80%');
    assert.equal(isStealRatioAbove(100, 80, 80), false);
    assert.equal(isStealRatioAbove(1000, 801, 80), true);
    assert.equal(isStealRatioAbove(0, 0, 80), false);
    assert.equal(stealRatioInfo(0, 3).text, '只偷不收');
    assert.equal(isStealRatioAbove(0, 3, 1), true);
    assert.equal(decideStealRatioApplication(100, 90, 80, false).action, 'pass');
    const rejected = decideStealRatioApplication(100, 90, 80, true);
    assert.equal(rejected.action, 'reject');
    assert.match(rejected.reason, /90%/);
    assert.match(formatStealRatioReason(0, 4, 80), /只偷不收/);
    assert.equal(decideStealRatioApplication(10, 8, 80, true).action, 'pass');
});

test('自动删除排除大号 GID 和小号自身 GID，每轮最多删 1 人', () => {
    const protectedGids = collectProtectedGids([
        { accountId: '2', selfGid: 222, enabled: true, masterGid: 100 },
        { accountId: '3', selfGid: 333, enabled: false, masterGid: 200 },
        { accountId: '4', selfGid: 444, enabled: false, masterGid: 0 },
    ], [222]);
    assert.deepEqual(protectedGids.sort((a, b) => a - b), [100, 200, 222, 333]);
    assert.equal(protectedGids.includes(444), false);

    const friends = [
        { gid: 100, name: '大号' },
        { gid: 333, name: '小号' },
        { gid: 444, name: '普通低' },
        { gid: 555, name: '高甲' },
        { gid: 666, name: '高乙' },
    ];
    const ratios = {
        100: { harvest: 10, steal: 10 },
        333: { harvest: 10, steal: 10 },
        444: { harvest: 100, steal: 10 },
        555: { harvest: 100, steal: 90 },
        666: { harvest: 0, steal: 2 },
    };
    const planned = planStealRatioDeletions({ friends, ratios, thresholdPercent: 80, protectedGids, maxDeletes: 1 });
    assert.equal(planned.length, 1);
    assert.equal(planned[0].gid, 555);
    assert.match(planned[0].reason, /超过 80%/);
    const none = planStealRatioDeletions({
        friends: [{ gid: 100, name: '大号' }],
        ratios,
        thresholdPercent: 80,
        protectedGids,
    });
    assert.deepEqual(none, []);
});

test('Bark：第一次只记水位不推送；新的高偷收比偷菜推送；30 分钟内同一人不重复；生涯未知不推进水位', () => {
    const records = [
        { actionType: 1, visitorGid: 9, serverTimeSec: 100, nick: '旧', actionDetail: '偷取作物' },
        { actionType: 2, visitorGid: 9, serverTimeSec: 200, nick: '帮忙' },
    ];
    const first = planStealAlerts({
        records,
        watermarkSec: 0,
        initialized: false,
        ratios: {},
        thresholdPercent: 80,
        notifiedAt: {},
        nowMs: 1_000_000,
    });
    assert.deepEqual(first.alerts, []);
    assert.equal(first.initialized, true);
    assert.equal(first.watermarkSec, 100);

    const fresh = planStealAlerts({
        records: [
            ...records,
            { actionType: 1, visitorGid: 9, serverTimeSec: 300, nick: '高', actionDetail: '偷取 白菜 × 1' },
            { actionType: 1, visitorGid: 8, serverTimeSec: 301, nick: '低', actionDetail: '偷取作物' },
        ],
        watermarkSec: first.watermarkSec,
        initialized: true,
        ratios: { 9: { harvest: 10, steal: 9 }, 8: { harvest: 100, steal: 1 } },
        thresholdPercent: 80,
        notifiedAt: {},
        nowMs: 2_000_000,
    });
    assert.equal(fresh.alerts.length, 1);
    assert.equal(fresh.alerts[0].gid, 9);
    assert.match(fresh.alerts[0].detail, /白菜/);
    assert.equal(fresh.watermarkSec, 301);

    const throttled = planStealAlerts({
        records: [
            { actionType: 1, visitorGid: 9, serverTimeSec: 400, nick: '高', actionDetail: '偷取作物' },
        ],
        watermarkSec: 301,
        initialized: true,
        ratios: { 9: { harvest: 10, steal: 9 } },
        thresholdPercent: 80,
        notifiedAt: fresh.notifiedAt,
        nowMs: 2_000_000 + 10 * 60 * 1000,
    });
    assert.deepEqual(throttled.alerts, []);
    assert.equal(throttled.watermarkSec, 400);

    const held = planStealAlerts({
        records: [
            { actionType: 1, visitorGid: 7, serverTimeSec: 500, nick: '未知', actionDetail: '偷取作物' },
            { actionType: 1, visitorGid: 9, serverTimeSec: 501, nick: '高', actionDetail: '偷取作物' },
        ],
        watermarkSec: 400,
        initialized: true,
        ratios: { 9: { harvest: 10, steal: 9 } },
        unknownGids: [7],
        thresholdPercent: 80,
        notifiedAt: {},
        nowMs: 9_000_000,
    });
    assert.deepEqual(held.alerts, []);
    assert.equal(held.watermarkSec, 400);
});

test('配置写入账号文件后读回；大小号 GID 不在删除保护名单之外', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-steal-ratio-'));
    const env = { ...process.env, QQ_FARM_DATA_DIR: dir, FARM_ACCOUNT_ID: '2' };
    const script = `
        const store = require('./dist/models/store');
        const m = require('./dist/services/friend/fnos-steal-ratio');
        store.applyConfigSnapshot({
            fnosAltAccount: { enabled: true, masterGid: 100, masterName: '大号' },
            fnosStealRatio: { ignoreApplications: true, thresholdPercent: 75 },
        }, { accountId: '2' });
        store.applyConfigSnapshot({
            fnosAltAccount: { enabled: true, masterGid: 200, masterName: '另一大号' },
        }, { accountId: '3' });
        store.applyConfigSnapshot({}, { accountId: '4' });
        m.writeSelfGid('2', 222);
        m.writeSelfGid('3', 333);
        m.writeSelfGid('4', 444);
        const snap = store.getConfigSnapshot('2');
        const other = store.getConfigSnapshot('9');
        console.log(JSON.stringify({
            ratio: snap.fnosStealRatio,
            other: other.fnosStealRatio,
            protected: m.readProtectedGidList().sort((a, b) => a - b),
        }));
    `;
    const r = spawnSync(process.execPath, ['-e', script], {
        cwd: path.join(__dirname, '..'),
        env,
        encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.ratio.ignoreApplications, true);
    assert.equal(out.ratio.thresholdPercent, 75);
    assert.equal(out.ratio.listFilter, false);
    assert.equal(out.ratio.barkOnSteal, false);
    assert.equal(out.ratio.autoDelete, false);
    assert.equal(out.other.ignoreApplications, false);
    assert.equal(out.other.thresholdPercent, 80);
    assert.deepEqual(out.protected, [100, 200, 222, 333]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'fnos-account-gids.json'), 'utf8'));
    assert.equal(saved['3'], 333);
    fs.rmSync(dir, { recursive: true, force: true });
});
