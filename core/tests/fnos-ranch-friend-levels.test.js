// [fnos-fork] 2026-11-17 好友牧场等级：缓存、默认 Lv1、按牧场等级排序、慢读挑选与节奏、好友列表字段 25
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-ranch-levels-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '5';
test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

const lv = require('../dist/services/ranch/fnos-friend-levels');

test('proto：GameFriend 字段 25 解码为 fnos_ranch_level', () => {
    const root = new protobuf.Root().loadSync(path.join(__dirname, '..', 'src', 'proto', 'friendpb.proto'), { keepCase: true });
    const T = root.lookupType('gamepb.friendpb.GameFriend');
    // 1: 1288605885, 6: 57, 25: 3, 26: 780（抓包 1116-6 GetAll「青蛙王子」）
    const w = protobuf.Writer.create();
    w.uint32(8).int64(1288605885).uint32(48).int64(57).uint32(200).int64(3).uint32(208).int64(780);
    const f = T.toObject(T.decode(w.finish()), { longs: Number });
    assert.equal(f.fnos_ranch_level, 3);
    assert.equal(f.fnos_ranch_exp, 780);
    assert.equal(f.level, 57);
});

test('decorateAndSort：列表等级 > 缓存 > 默认 Lv1，按牧场等级降序、同级保持原顺序', () => {
    const levels = { 2: { level: 9, at: 1, source: 'visit' }, 4: { level: 3, at: 1, source: 'visit' } };
    const list = [
        { gid: '1', level: 80 }, { gid: '2', level: 10 }, { gid: '3', level: 50, ranchLevel: 9 },
        { gid: '4', level: 1 }, { gid: '5', level: 99 }, { gid: '6', level: 2, ranchLevel: 0 },
    ];
    const out = lv.decorateAndSort(list, levels);
    assert.deepEqual(out.map(f => f.gid), ['2', '3', '4', '1', '5', '6']);
    assert.deepEqual(out.map(f => f.ranchLevel), [9, 9, 3, 1, 1, 1]);
    assert.deepEqual(out.map(f => f.ranchLevelKnown), [true, true, true, false, false, false]);
    assert.equal(list[0].ranchLevel, undefined, '不改原数组');
});

test('缓存：按账号写文件，读回，等级 ≤0 忽略', () => {
    lv.resetFnosFriendLevelsRuntime();
    assert.equal(lv.recordLevels([{ gid: 11, level: 7 }, { gid: 12, level: 0 }, { gid: 0, level: 5 }], 'test', 1000), 1);
    assert.match(lv.storeFile(), /fnos-ranch-friend-levels[\\/]5\.json$/);
    const saved = JSON.parse(fs.readFileSync(lv.storeFile(), 'utf8'));
    assert.deepEqual(saved.levels['11'], { level: 7, at: 1000, source: 'test' });
    lv.resetFnosFriendLevelsRuntime();
    assert.equal(lv.getEntry(11).level, 7);
    assert.equal(lv.getEntry(12), null);
    lv.recordFromFriendList([{ gid: 13, ranchLevel: 4 }, { gid: 14 }]);
    assert.equal(lv.getEntry(13).level, 4);
    assert.equal(lv.getEntry(14), null);
    assert.deepEqual(lv.decorateFriends([{ gid: '14' }, { gid: '11' }]).map(f => [f.gid, f.ranchLevel]), [['11', 7], ['14', 1]]);
});

test('pickReadCandidate：只挑没等级或超 7 天的，跳过冷却，农场等级高优先', () => {
    const now = 10 * 24 * 3600 * 1000;
    const levels = { 1: { level: 5, at: now - 1000 }, 2: { level: 5, at: now - lv.STALE_MS - 1 } };
    const list = [{ gid: 1, level: 99 }, { gid: 2, level: 10 }, { gid: 3, level: 50 }, { gid: 4, level: 70, ranchLevel: 6 }, { gid: 5, level: 60 }];
    assert.equal(lv.pickReadCandidate(list, levels, now).gid, 5);
    assert.equal(lv.pickReadCandidate(list, levels, now, new Map([['5', now + 1]])).gid, 3);
    assert.equal(lv.pickReadCandidate(list, levels, now, new Map([['5', now + 1], ['3', now + 1]])).gid, 2);
    assert.equal(lv.pickReadCandidate([{ gid: 1 }], levels, now), null);
});

test('节奏：间隔 60–120 秒随机，失败退避 2/4/8 分钟封顶 30 分钟', () => {
    assert.equal(lv.nextReadDelayMs(() => 0), 60_000);
    assert.equal(lv.nextReadDelayMs(() => 0.999999), 120_000);
    assert.deepEqual([0, 1, 2, 3, 9].map(lv.backoffMs), [0, 120_000, 240_000, 480_000, 30 * 60_000]);
});

test('runSlowReadOnce：不空闲时不进场', async () => {
    let entered = false;
    const friendsMod = require('../dist/services/ranch/friends');
    const orig = friendsMod.peekLevel;
    friendsMod.peekLevel = async () => { entered = true; return 3; };
    try {
        const delay = await lv.runSlowReadOnce(() => false);
        assert.ok(delay >= 60_000 && delay <= 120_000);
        assert.equal(entered, false);
    } finally { friendsMod.peekLevel = orig; }
});
