// [fnos-fork] 2026-11-17 牧场最近访客：InteractRecords scene_id=2 的请求编码、回包字段与动作类型对照、按账号合并保存
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-ranch-visitors-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '9';
test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

const visitors = require('../dist/services/ranch/fnos-visitors');

test('proto：农场请求仍为空包，牧场请求编码为 1: 2；回包 22 = 动物 id', () => {
    const root = new protobuf.Root().loadSync(path.join(__dirname, '..', 'src', 'proto', 'interactpb.proto'), { keepCase: true });
    const Req = root.lookupType('gamepb.interactpb.InteractRecordsRequest');
    assert.equal(Buffer.from(Req.encode(Req.create({})).finish()).toString('hex'), '');
    assert.equal(Buffer.from(Req.encode(Req.fromObject({ scene_id: 2 })).finish()).toString('hex'), '0802');
    const Rec = root.lookupType('gamepb.interactpb.InteractRecord');
    const bytes = Rec.encode(Rec.fromObject({ server_time: 1794801972, action_type: 11, visitor_gid: 1285449118, times: 1, from_type: 2, level: 75, fnos_field19: 15, fnos_animal_id: 60002 })).finish();
    const back = Rec.toObject(Rec.decode(bytes), { longs: Number });
    assert.equal(back.fnos_animal_id, 60002);
    assert.equal(back.action_type, 11);
});

test('normalizeRanchVisitor：13 偷取（产物+数量）、3 放蚊子、9 帮忙、11 抚摸、未知类型原样', () => {
    const names = { 1060002: '鸭蛋', 60002: '鸭' };
    const n = r => visitors.normalizeRanchVisitor(r, id => names[id] || '');
    const steal = n({ server_time: 1794800967, action_type: 13, visitor_gid: 1277708204, nick: '苦咖啡', crop_id: 1060002, crop_count: 9, times: 2, level: 99 });
    assert.equal(steal.actionKey, 'steal');
    assert.equal(steal.actionCertain, true);
    assert.equal(steal.actionDetail, '偷取 鸭蛋 × 9');
    assert.equal(steal.serverTimeMs, 1794800967000);
    assert.equal(n({ action_type: 3, visitor_gid: 1, times: 3 }).actionDetail, '放蚊子 3 次');
    assert.equal(n({ action_type: 3, visitor_gid: 1, times: 1 }).actionLabel, '放蚊子');
    assert.match(n({ action_type: 9, visitor_gid: 1, times: 2 }).actionDetail, /^帮忙 2 次/);
    assert.equal(n({ action_type: 11, visitor_gid: 1, fnos_animal_id: 60002 }).actionDetail, '抚摸 鸭');
    const other = n({ action_type: 7, visitor_gid: 1 });
    assert.equal(other.actionKey, 'other');
    assert.equal(other.actionDetail, '互动（类型 7）');
    assert.equal(n({ action_type: 3, visitor_gid: 5 }).nick, 'GID:5');
});

test('mergeVisitors：去重、新覆盖旧、时间倒序、上限', () => {
    const a = { key: 'a', serverTimeSec: 10, visitorGid: 1, actionType: 3, v: 1 };
    const b = { key: 'b', serverTimeSec: 20, visitorGid: 1, actionType: 3 };
    const a2 = { ...a, v: 2 };
    const merged = visitors.mergeVisitors([a], [b, a2]);
    assert.deepEqual(merged.map(r => r.key), ['b', 'a']);
    assert.equal(merged[1].v, 2);
    assert.equal(visitors.mergeVisitors([a, b], [], 1).length, 1);
    assert.match(visitors.storeFile(), /fnos-ranch-visitors[\\/]9\.json$/);
});
