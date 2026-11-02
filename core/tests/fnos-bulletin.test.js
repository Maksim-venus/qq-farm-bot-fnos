// [fnos-fork] 游戏公告：用抓包回放核对 proto 字段，并确认只调用两个只读接口。
process.env.QQ_FARM_GATEWAY_PREFIX = '/app/qq-farm-bot';

const assert = require('node:assert/strict');
const test = require('node:test');
const frames = require('./fixtures/bulletin-frames.json').frames;
const { loadProto, types } = require('../dist/utils/proto');
const bulletin = require('../dist/services/fnos-bulletin');

function ensureProto() {
    return loadProto();
}

function frameBody(frameNo) {
    const frame = frames.find(item => item.frame === frameNo);
    assert.ok(frame, `缺少 ${frameNo} 号帧`);
    const gate = types.GateMessage.decode(Buffer.from(frame.raw_gate_message_b64, 'base64'));
    assert.equal(gate.meta.service_name, 'gamepb.bulletinboardpb.BulletinBoardService');
    assert.equal(gate.meta.method_name, frameNo === 59 ? 'GetBulletinList' : 'GetBulletinDetail');
    assert.equal(gate.meta.message_type, 2);
    return Buffer.from(gate.body);
}

test('相对路径的公告图片补上网关前缀，外链保持原样', () => {
    assert.equal(bulletin.bulletinImageUrl('/uploads/a.png'), '/app/qq-farm-bot/uploads/a.png');
    assert.equal(bulletin.bulletinImageUrl('https://cdn-resource.nqf.qq.com/uploads/a.png'), 'https://cdn-resource.nqf.qq.com/uploads/a.png');
    assert.equal(bulletin.bulletinImageUrl(''), '');
});

test('账号未运行、未登录时给出可直接展示的错误，其他错误不改写', () => {
    assert.match(bulletin.describeBulletinAccessError(new Error('账号未运行')), /未运行/);
    assert.match(bulletin.describeBulletinAccessError(new Error('账号已离线')), /未运行/);
    assert.match(bulletin.describeBulletinAccessError(new Error('账号未连接')), /尚未登录/);
    assert.match(bulletin.describeBulletinAccessError(new Error('连接未打开')), /尚未登录/);
    assert.equal(bulletin.describeBulletinAccessError(new Error('游戏服务响应超时')), '');
    assert.equal(bulletin.parseBulletinId('26110101'), 26110101);
    assert.equal(bulletin.parseBulletinId(0), 0);
    assert.equal(bulletin.parseBulletinId('abc'), 0);
    assert.equal(bulletin.parseBulletinId('-1'), 0);
});

test('GetBulletinDetail 类型已注册，列表 field 6 与详情 110 号帧字段编号和抓包一致', async () => {
    await ensureProto();
    assert.equal(typeof types.GetBulletinListRequest.encode, 'function');
    assert.equal(typeof types.GetBulletinDetailRequest.encode, 'function');
    assert.equal(typeof types.GetBulletinDetailReply.decode, 'function');

    const itemType = types.GetBulletinListReply.fields.bulletins.resolvedType;
    assert.equal(itemType.fields.id.id, 1);
    assert.equal(itemType.fields.title.id, 2);
    assert.equal(itemType.fields.status.id, 3);
    assert.equal(itemType.fields.type.id, 5);
    assert.equal(itemType.fields.image_url.id, 6);

    const detail = types.GetBulletinDetailReply.fields;
    assert.equal(detail.title.id, 1);
    assert.equal(detail.content.id, 2);
    assert.equal(detail.begin_time.id, 3);
    assert.equal(detail.end_time.id, 4);
    assert.equal(detail.image_url.id, 5);
});

test('59 号帧解码出三条公告，只有第一条带 image_url，空回包得到空列表', async () => {
    await ensureProto();
    const calls = [];
    const listed = await bulletin.getBulletinList(async (service, method, body) => {
        calls.push({ service, method, body: Buffer.from(body) });
        const request = types.GetBulletinListRequest.decode(body);
        assert.equal(Number(request.count), 0);
        assert.equal(Number(request.page_size), 6);
        assert.equal(Number(request.page_size), bulletin.BULLETIN_LIST_PAGE_SIZE);
        assert.equal(Buffer.from(body).toString("hex"), "08001006");
        return { body: frameBody(59) };
    });

    assert.deepEqual(calls.map(call => `${call.service}.${call.method}`), [
        'gamepb.bulletinboardpb.BulletinBoardService.GetBulletinList',
    ]);
    assert.equal(listed.bulletins.length, 3);
    assert.deepEqual(listed.bulletins.map(item => item.id), [26110101, 26101501, 26101401]);
    assert.equal(listed.bulletins[0].title, '游戏更新公告');
    assert.equal(listed.bulletins[0].status, 1);
    assert.equal(listed.bulletins[0].read, true);
    assert.equal(listed.bulletins[0].type, 2);
    assert.equal(listed.bulletins[0].imageUrl, 'https://cdn-resource.nqf.qq.com/uploads/gengxingonggao_bn.png');
    assert.equal(listed.bulletins[1].title, '游戏更新公告');
    assert.equal(listed.bulletins[1].imageUrl, '');
    assert.equal(listed.bulletins[2].title, '奶茶热销中');
    assert.equal(listed.bulletins[2].imageUrl, '');

    const empty = await bulletin.getBulletinList(async () => ({ body: Buffer.alloc(0) }));
    assert.deepEqual(empty, { bulletins: [] });
    assert.deepEqual(bulletin.normalizeBulletinList(null), { bulletins: [] });
    assert.deepEqual(bulletin.normalizeBulletinList({}), { bulletins: [] });
});

test('110、112、114 号帧按详情 proto 解出标题、正文、时间和图片，且不会调用其他接口', async () => {
    await ensureProto();
    const expectations = [
        {
            frame: 110,
            id: 26110101,
            title: '游戏更新公告',
            beginTime: '2026-10-31 00:00:00',
            endTime: '2026-11-16 23:59:59',
            imageUrl: 'https://cdn-resource.nqf.qq.com/uploads/gengxingonggao_bn.png',
            content: /蓝晶土地/,
        },
        {
            frame: 112,
            id: 26101501,
            title: '游戏更新公告',
            beginTime: '2026-10-15 00:00:00',
            endTime: '2026-11-16 23:59:59',
            imageUrl: 'https://cdn-resource.nqf.qq.com/uploads/gengxingonggao_bn.png',
            content: /兑换商店调整/,
        },
        {
            frame: 114,
            id: 26101401,
            title: '奶茶热销中',
            beginTime: '2026-10-14 00:00:00',
            endTime: '2026-11-16 23:59:59',
            imageUrl: 'https://cdn-resource.nqf.qq.com/uploads/naicharexiaozhong_bn.png',
            content: /快乐不独享/,
        },
    ];

    for (const expected of expectations) {
        const calls = [];
        const detail = await bulletin.getBulletinDetail(expected.id, async (service, method, body) => {
            calls.push({ service, method });
            const request = types.GetBulletinDetailRequest.decode(body);
            assert.equal(Number(request.id), expected.id);
            return { body: frameBody(expected.frame) };
        });
        assert.deepEqual(calls, [{
            service: 'gamepb.bulletinboardpb.BulletinBoardService',
            method: 'GetBulletinDetail',
        }]);
        assert.equal(detail.id, expected.id);
        assert.equal(detail.title, expected.title);
        assert.equal(detail.beginTime, expected.beginTime);
        assert.equal(detail.endTime, expected.endTime);
        assert.equal(detail.imageUrl, expected.imageUrl);
        assert.match(detail.content, expected.content);
        assert.match(detail.content, /\n/);
        assert.equal(detail.content.includes('<script'), false);
    }

    await assert.rejects(() => bulletin.getBulletinDetail(0, async () => {
        throw new Error('不应发起请求');
    }), /公告编号无效/);
});
