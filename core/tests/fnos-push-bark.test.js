// [fnos-fork] Bark 推送：成功码 200 不再误判为失败；下线提醒支持重要警告（level=critical）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const axios = require('axios').default;
const {
    buildBarkRequest,
    isChannelSuccessCode,
    sendBarkMessage,
} = require('../dist/services/fnos-push-bark');
const { sendPushooMessage } = require('../dist/services/push');
const { createReloginReminderService } = require('../dist/runtime/relogin-reminder');

test('buildBarkRequest: 设备 Key 走官方服务器，普通推送不带 level', () => {
    const { url, body } = buildBarkRequest({ token: 'abcKEY', title: 'T', content: 'C' });
    assert.equal(url, 'https://api.day.app/abcKEY');
    assert.deepEqual(body, { body: 'C', title: 'T' });
});

test('buildBarkRequest: 完整地址（含自建服务器、末尾斜杠）原样使用', () => {
    assert.equal(buildBarkRequest({ token: 'https://api.day.app/abcKEY/', title: 'T', content: 'C' }).url, 'https://api.day.app/abcKEY');
    assert.equal(buildBarkRequest({ token: 'http://192.168.0.2:8080/k1', title: 'T', content: 'C' }).url, 'http://192.168.0.2:8080/k1');
});

test('buildBarkRequest: 重要警告带 level=critical、volume=5、call=1', () => {
    const { body } = buildBarkRequest({ token: 'k', title: 'T', content: 'C', critical: true });
    assert.equal(body.level, 'critical');
    assert.equal(body.volume, '5');
    assert.equal(body.call, '1');
});

test('sendBarkMessage: POST JSON 到 Bark，HTTP 400 时返回错误结构', async () => {
    const calls = [];
    const ok = await sendBarkMessage({ token: 'k', title: 'T', content: 'C', critical: true }, async (url, body) => {
        calls.push({ url, body });
        return { status: 200, data: { code: 200, message: 'success', timestamp: 1 } };
    });
    assert.deepEqual(ok, { code: 200, message: 'success', timestamp: 1 });
    assert.equal(calls[0].url, 'https://api.day.app/k');
    assert.equal(calls[0].body.level, 'critical');

    const bad = await sendBarkMessage({ token: 'k', title: 'T', content: 'C' }, async () => {
        const err = new Error('Request failed with status code 400');
        err.response = { status: 400, data: { code: 400, message: 'failed to get device token' } };
        throw err;
    });
    assert.equal(bad.code, 400);
    assert.equal(bad.error.message, 'failed to get device token');
});

test('isChannelSuccessCode: Bark/PushPlus 200、WxPusher 1000 视为成功，其余渠道不受影响', () => {
    assert.equal(isChannelSuccessCode('bark', 200), true);
    assert.equal(isChannelSuccessCode('pushplus', '200'), true);
    assert.equal(isChannelSuccessCode('wxpusher', 1000), true);
    assert.equal(isChannelSuccessCode('bark', 400), false);
    assert.equal(isChannelSuccessCode('serverchan', 200), false);
    assert.equal(isChannelSuccessCode('pushdeer', 200), false);
});

test('sendPushooMessage(bark): Bark 返回 {code:200,message:"success"} 判定为成功，并真的带上 critical 参数', async (t) => {
    const original = axios.post;
    const calls = [];
    axios.post = async (url, body) => {
        calls.push({ url, body });
        return { status: 200, data: { code: 200, message: 'success', timestamp: 1 } };
    };
    t.after(() => { axios.post = original; });

    const ret = await sendPushooMessage({ channel: 'bark', token: 'k', title: 'T', content: 'C', barkCritical: true });
    assert.equal(ret.ok, true);
    assert.equal(ret.msg, 'success');
    assert.equal(calls[0].url, 'https://api.day.app/k');
    assert.deepEqual(calls[0].body, { body: 'C', title: 'T', level: 'critical', volume: '5', call: '1' });

    const plain = await sendPushooMessage({ channel: 'bark', token: 'k', title: 'T', content: 'C' });
    assert.equal(plain.ok, true);
    assert.equal(calls[1].body.level, undefined);
});

test('sendPushooMessage(bark): Bark 报错时判定为失败', async (t) => {
    const original = axios.post;
    axios.post = async () => {
        const err = new Error('Request failed with status code 400');
        err.response = { status: 400, data: { code: 400, message: 'failed to get device token' } };
        throw err;
    };
    t.after(() => { axios.post = original; });
    const ret = await sendPushooMessage({ channel: 'bark', token: 'k', title: 'T', content: 'C' });
    assert.equal(ret.ok, false);
    assert.equal(ret.msg, 'failed to get device token');
});

function makeReminder(cfg) {
    const sent = [];
    const logs = [];
    const service = createReloginReminderService({
        store: { getOfflineReminder: () => cfg },
        sendPushooMessage: async (payload) => { sent.push(payload); return { ok: true }; },
        log: (tag, msg) => logs.push(`${tag}:${msg}`),
    });
    return { service, sent, logs };
}

test('下线提醒：Bark 默认（缺字段）走重要警告，显式关闭则不走；事件提醒不走', async () => {
    const base = { channel: 'bark', token: 'k', title: '农场', msg: '掉线了' };

    const legacy = makeReminder({ ...base });
    await legacy.service.triggerOfflineReminder({ accountId: '1', accountName: 'A', reason: 'x' });
    assert.equal(legacy.sent[0].barkCritical, true);

    const off = makeReminder({ ...base, barkCritical: false });
    await off.service.triggerOfflineReminder({ accountId: '1', accountName: 'A', reason: 'x' });
    assert.equal(off.sent[0].barkCritical, false);

    const ev = makeReminder({ ...base });
    await ev.service.sendConfiguredPush({ title: '事件', content: '内容', accountId: '1', accountName: 'A' });
    assert.equal(ev.sent[0].barkCritical, false);
});

test('offlineReminder.barkCritical：老配置缺字段读回为 true，保存 false 后保持 false', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-bark-store-'));
    fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({
        offlineReminder: { channel: 'bark', endpoint: '', token: 'k', secret: '', title: 't', msg: 'm', offlineDeleteSec: 0 },
    }));
    const env = { ...process.env, QQ_FARM_DATA_DIR: dir };
    const cwd = path.join(__dirname, '..');
    const read = `const store = require('./dist/models/store'); console.log(JSON.stringify(store.getOfflineReminder()));`;
    const r1 = spawnSync(process.execPath, ['-e', read], { cwd, env, encoding: 'utf8' });
    assert.equal(r1.status, 0, r1.stderr);
    const cfg1 = JSON.parse(r1.stdout.trim().split('\n').pop());
    assert.equal(cfg1.barkCritical, true);
    assert.equal(cfg1.msg, 'm');

    const write = `const store = require('./dist/models/store'); store.setOfflineReminder({ barkCritical: false });`;
    const w = spawnSync(process.execPath, ['-e', write], { cwd, env, encoding: 'utf8' });
    assert.equal(w.status, 0, w.stderr);
    const r2 = spawnSync(process.execPath, ['-e', read], { cwd, env, encoding: 'utf8' });
    const cfg2 = JSON.parse(r2.stdout.trim().split('\n').pop());
    assert.equal(cfg2.barkCritical, false);

    const w2 = spawnSync(process.execPath, ['-e', `const store = require('./dist/models/store'); store.setOfflineReminder({ title: 'x' });`], { cwd, env, encoding: 'utf8' });
    assert.equal(w2.status, 0, w2.stderr);
    const r3 = spawnSync(process.execPath, ['-e', read], { cwd, env, encoding: 'utf8' });
    assert.equal(JSON.parse(r3.stdout.trim().split('\n').pop()).barkCritical, false);
});
