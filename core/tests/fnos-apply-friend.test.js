// [fnos-fork] 按 GID 加好友（测试）：ApplyFriend / EnterReply.apply_key 编解码，以及 Enter 失败不伪造凭证。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

const SAMPLE_GID = 1249288671;
const SAMPLE_KEY = '8c782759040cc63dbde4cfed8fbc8a7dd6cddf8798fd08d3a4b91bb0304e545c:1249288671';

function encodeVarint(value) {
    const bytes = [];
    let n = value;
    while (n > 127) {
        bytes.push((n & 0x7F) | 0x80);
        n = Math.floor(n / 128);
    }
    bytes.push(n);
    return Buffer.from(bytes);
}

function encodeStringField(fieldNumber, value) {
    const payload = Buffer.from(value, 'utf8');
    return Buffer.concat([
        encodeVarint((fieldNumber << 3) | 2),
        encodeVarint(payload.length),
        payload,
    ]);
}

function loadType(protoFile, fullName) {
    const root = new protobuf.Root();
    root.loadSync(path.join(__dirname, '../src/proto', protoFile), { keepCase: true });
    return root.lookupType(fullName);
}

test('ApplyFriendRequest 按抓包编码 field 1/2/3，回包空 body 可解码', async () => {
    const Request = loadType('friendpb.proto', 'gamepb.friendpb.ApplyFriendRequest');
    const Reply = loadType('friendpb.proto', 'gamepb.friendpb.ApplyFriendReply');
    const raw = Buffer.concat([
        encodeVarint(1 << 3),
        encodeVarint(SAMPLE_GID),
        encodeStringField(2, SAMPLE_KEY),
        encodeVarint((3 << 3) | 0),
        encodeVarint(0),
    ]);
    const decoded = Request.toObject(Request.decode(raw), { longs: Number });
    assert.equal(decoded.friend_gid, SAMPLE_GID);
    assert.equal(decoded.apply_key, SAMPLE_KEY);
    assert.equal(decoded.source, 0);

    const encoded = Buffer.from(Request.encode(Request.create({
        friend_gid: SAMPLE_GID,
        apply_key: SAMPLE_KEY,
        source: 0,
    })).finish());
    const roundTrip = Request.toObject(Request.decode(encoded), { longs: Number });
    assert.equal(roundTrip.friend_gid, SAMPLE_GID);
    assert.equal(roundTrip.apply_key, SAMPLE_KEY);
    assert.equal(Number(roundTrip.source || 0), 0);
    assert.deepEqual(Reply.decode(Buffer.alloc(0)).toJSON(), {});
});

test('EnterReply field 10 解出抓包里的加好友凭证，且不覆盖 field 3 的狗信息', async () => {
    const EnterReply = loadType('visitpb.proto', 'gamepb.visitpb.EnterReply');
    const raw = Buffer.concat([
        Buffer.from([0x1A, 0x04, 0x08, 0x9B, 0xBF, 0x05]),
        encodeStringField(10, SAMPLE_KEY),
    ]);
    const reply = EnterReply.decode(raw);
    assert.equal(reply.apply_key, SAMPLE_KEY);
    assert.equal(Number(reply.brief_dog_info.dog_id), 90011);

    const encoded = Buffer.from(EnterReply.encode(EnterReply.create({
        apply_key: SAMPLE_KEY,
    })).finish());
    assert.equal(EnterReply.decode(encoded).apply_key, SAMPLE_KEY);
});

test('类型表注册了 ApplyFriend，EnterReply 仍走 VisitEnterReply', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/utils/proto.ts'), 'utf8');
    assert.match(source, /types\.ApplyFriendRequest = root\.lookupType\('gamepb\.friendpb\.ApplyFriendRequest'\)/);
    assert.match(source, /types\.ApplyFriendReply = root\.lookupType\('gamepb\.friendpb\.ApplyFriendReply'\)/);
    assert.match(source, /types\.VisitEnterReply = root\.lookupType\('gamepb\.visitpb\.EnterReply'\)/);
    const worker = fs.readFileSync(path.join(__dirname, '../src/core/worker.ts'), 'utf8');
    const provider = fs.readFileSync(path.join(__dirname, '../src/runtime/data-provider.ts'), 'utf8');
    const routes = fs.readFileSync(path.join(__dirname, '../src/controllers/admin/friend-routes.ts'), 'utf8');
    assert.match(worker, /case 'applyFriendByGid'/);
    assert.match(provider, /applyFriendByGid:/);
    assert.match(routes, /\/api\/friend\/:gid\/apply/);
});

test('Enter 失败时如实返回服务器错误，不伪造凭证，也不发送 ApplyFriend', async () => {
    const Request = loadType('friendpb.proto', 'gamepb.friendpb.ApplyFriendRequest');
    const Reply = loadType('friendpb.proto', 'gamepb.friendpb.ApplyFriendReply');
    const calls = [];
    const logs = [];
    const state = {
        enterReply: { apply_key: SAMPLE_KEY },
        enterError: null,
        leaveError: null,
        applyError: null,
    };

    const dist = rel => require.resolve(path.join(__dirname, '..', 'dist', rel));
    const mock = (rel, exports) => {
        const id = dist(rel);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    };
    const realUtils = require('../dist/utils/utils');
    mock('utils/utils', {
        ...realUtils,
        log: (tag, msg, meta) => logs.push({ tag, msg, meta }),
    });
    mock('utils/proto', { types: { ApplyFriendRequest: Request, ApplyFriendReply: Reply } });
    mock('utils/network', {
        sendMsgAsync: async (service, method, body) => {
            calls.push(['send', service, method, Buffer.from(body)]);
            if (state.applyError) throw state.applyError;
            return { body: Buffer.alloc(0) };
        },
    });
    mock('services/friend/api', {
        enterFriendFarm: async (gid) => {
            calls.push(['enter', gid]);
            if (state.enterError) throw state.enterError;
            return state.enterReply;
        },
        leaveFriendFarm: async (gid) => {
            calls.push(['leave', gid]);
            if (state.leaveError) throw state.leaveError;
        },
    });

    const { applyFriendByGid } = require('../dist/services/friend/fnos-apply-friend');

    state.enterError = Object.assign(new Error('gamepb.visitpb.VisitService.Enter 错误: code=1001001 不是好友'), {
        code: 1001001,
        errorMessage: '不是好友',
        name: 'GatewayError',
    });
    const denied = await applyFriendByGid(SAMPLE_GID);
    assert.equal(denied.ok, false);
    assert.equal(denied.enterOk, false);
    assert.equal(denied.applySent, false);
    assert.equal(denied.applyKeyPrefix, '');
    assert.equal(denied.errorMessage, '不是好友');
    assert.equal(denied.errorCode, 1001001);
    assert.deepEqual(calls.map(item => item[0]), ['enter']);
    assert.match(logs.at(-1).msg, new RegExp(`gid=${SAMPLE_GID}`));
    assert.match(logs.at(-1).msg, /Enter 失败/);
    assert.match(logs.at(-1).msg, /凭证 无/);
    assert.match(logs.at(-1).msg, /ApplyFriend 未发送/);
    assert.match(logs.at(-1).msg, /错误码 1001001/);
    assert.match(logs.at(-1).msg, /不是好友/);
    assert.equal(logs.some(item => item.msg.includes(SAMPLE_KEY)), false);

    calls.length = 0;
    state.enterError = null;
    state.enterReply = {};
    const missing = await applyFriendByGid(String(SAMPLE_GID));
    assert.equal(missing.ok, false);
    assert.equal(missing.enterOk, true);
    assert.equal(missing.applySent, false);
    assert.equal(missing.applyKeyPrefix, '');
    assert.match(missing.error, /没有加好友凭证/);
    assert.deepEqual(calls.map(item => item[0]), ['enter', 'leave']);

    calls.length = 0;
    state.enterReply = { apply_key: SAMPLE_KEY };
    state.leaveError = new Error('离开失败');
    state.applyError = Object.assign(new Error('gamepb.friendpb.FriendService.ApplyFriend 错误: code=88 已经申请过'), {
        code: 88,
        errorMessage: '已经申请过',
        name: 'GatewayError',
    });
    const rejected = await applyFriendByGid(SAMPLE_GID);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.enterOk, true);
    assert.equal(rejected.applySent, true);
    assert.equal(rejected.applyKeyPrefix, SAMPLE_KEY.slice(0, 8));
    assert.equal(rejected.errorMessage, '已经申请过');
    assert.equal(rejected.errorCode, 88);
    assert.equal(calls[2][1], 'gamepb.friendpb.FriendService');
    assert.equal(calls[2][2], 'ApplyFriend');
    const sent = Request.toObject(Request.decode(calls[2][3]), { longs: Number });
    assert.equal(sent.friend_gid, SAMPLE_GID);
    assert.equal(sent.apply_key, SAMPLE_KEY);
    assert.equal(Number(sent.source || 0), 0);
    assert.match(logs.at(-1).msg, /Enter 成功/);
    assert.match(logs.at(-1).msg, new RegExp(`凭证 ${SAMPLE_KEY.slice(0, 8)}`));
    assert.match(logs.at(-1).msg, /ApplyFriend 失败/);
    assert.equal(logs.some(item => item.msg.includes(SAMPLE_KEY)), false);

    calls.length = 0;
    state.leaveError = null;
    state.applyError = null;
    const ok = await applyFriendByGid(SAMPLE_GID);
    assert.equal(ok.ok, true);
    assert.equal(ok.enterOk, true);
    assert.equal(ok.applySent, true);
    assert.equal(ok.applyKeyPrefix, '8c782759');
    assert.equal(ok.error, undefined);
    assert.match(logs.at(-1).msg, /ApplyFriend 成功/);
    assert.deepEqual(calls.map(item => item[0]), ['enter', 'leave', 'send']);

    calls.length = 0;
    const invalid = await applyFriendByGid(0);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error, '无效的 GID');
    assert.equal(calls.length, 0);
});
