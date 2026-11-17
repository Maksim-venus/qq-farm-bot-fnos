// [fnos-fork] 2026-11-17 运行日志按账号、农场 / 牧场分开并持久化
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const storeMod = require('../dist/runtime/fnos-log-store');
const { createDataProvider } = require('../dist/runtime/data-provider');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-log-store-'));
}

let seq = 0;
function farm(accountId, msg, ts = Date.now() + (seq++)) {
    return { accountId, tag: '农场', msg, meta: { module: 'farm', event: 'harvest_crop', result: 'ok' }, ts, time: '2026-11-17 10:00:00' };
}
function ranch(accountId, msg, event = 'ranch_harvest', result = 'ok', ts = Date.now() + (seq++)) {
    return { accountId, tag: '牧场', msg, meta: { module: 'ranch', event, result }, ts, time: '2026-11-17 10:00:00' };
}

test('农场刷屏不会挤掉牧场日志；按账号分开', () => {
    const s = storeMod.createFnosLogStore({ dir: tmpDir(), farmCap: 50, ranchCap: 20, flushMs: 0 });
    s.record(ranch('1', '收获 A'));
    for (let i = 0; i < 500; i++) s.record(farm('1', `农场 ${i}`));
    s.record(farm('2', '二号'));
    assert.equal(s.getLogs('1', 'ranch').length, 1);
    assert.equal(s.getLogs('1', 'farm').length, 50);
    assert.equal(s.getLogs('2', 'farm').length, 1);
    assert.equal(s.getLogs('1', 'ranch')[0].msg, '收获 A');
    const all = s.getLogs('1', '');
    assert.equal(all.length, 51);
    assert.equal(all[0].msg, '收获 A');
    const balanced = s.getBalanced({ farm: s.getLogs('1', 'farm'), ranch: s.getLogs('1', 'ranch') }, 5);
    assert.equal(balanced.length, 6);
});

test('重启后从文件读回；文件超上限会压缩；超过保留天数的丢弃；清空会清文件', () => {
    const dir = tmpDir();
    const a = storeMod.createFnosLogStore({ dir, farmCap: 10, ranchCap: 10, flushMs: 0 });
    a.record(ranch('7', '旧日志', 'ranch_harvest', 'ok', Date.now() - 5 * 24 * 3600 * 1000));
    for (let i = 0; i < 30; i++) a.record(ranch('7', `牧场 ${i}`));
    for (let i = 0; i < 3; i++) a.record(farm('7', `农场 ${i}`));
    const file = path.join(dir, '7', 'ranch.jsonl');
    assert.ok(fs.existsSync(file));
    const b = storeMod.createFnosLogStore({ dir, farmCap: 10, ranchCap: 10, flushMs: 0 });
    const ranchLogs = b.getLogs('7', 'ranch');
    assert.equal(ranchLogs.length, 10);
    assert.equal(ranchLogs[9].msg, '牧场 29');
    assert.ok(!ranchLogs.some(e => e.msg === '旧日志'));
    assert.equal(b.getLogs('7', 'farm').length, 3);
    assert.ok(ranchLogs[0]._searchText, '读回后可按关键词搜索');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('_searchText'), '文件里不存搜索索引');
    assert.ok(fs.readFileSync(file, 'utf8').trim().split('\n').length <= 10, '读回时按上限重写文件');
    b.clear('7');
    const c = storeMod.createFnosLogStore({ dir, flushMs: 0 });
    assert.equal(c.getLogs('7', '').length, 0);
});

test('牧场每日汇总：偷取次数、好友、物品；其他动作计数；跳过 / 失败不算成功', () => {
    const dir = tmpDir();
    const s = storeMod.createFnosLogStore({ dir, flushMs: 0, ranchCap: 2 });
    s.record(ranch('1', '.岁月如歌：获得 鸭蛋 ×3', 'ranch_steal'));
    s.record(ranch('1', '琳琳：获得 鹅蛋 ×8、巨大鹅蛋 ×1', 'ranch_steal'));
    s.record(ranch('1', '琳琳：获得 鹅蛋 ×2', 'ranch_steal'));
    s.record(ranch('1', '收获完成', 'ranch_harvest'));
    s.record(ranch('1', '暂不能拜访 小果', 'ranch_friend', 'skipped'));
    s.record(ranch('1', '购买 暂未执行', 'ranch_buy', 'skipped'));
    s.record(ranch('1', '放蚊子', 'ranch_putMosquito'));
    const [today] = s.getRanchSummary('1', 1);
    assert.equal(today.steal.times, 3);
    assert.deepEqual(today.steal.friends, ['.岁月如歌', '琳琳']);
    assert.deepEqual(today.steal.items, { 鸭蛋: 3, 鹅蛋: 10, 巨大鹅蛋: 1 });
    assert.equal(today.harvest, 1);
    assert.equal(today.buy, 0);
    assert.equal(today.putMosquito, 1);
    // 汇总不受条数上限影响，且持久化
    const again = storeMod.createFnosLogStore({ dir, flushMs: 0 });
    assert.equal(again.getRanchSummary('1', 1)[0].steal.times, 3);
    assert.equal(again.getRanchSummary('1', 3).length, 3);
});

test('偷取消息解析：好友名带冒号、多个物品', () => {
    assert.deepEqual(storeMod.parseFnosRanchStealMessage('A：B：获得 小兔崽 ×2、巨大火鸡蛋 ×1'), { friend: 'A：B', items: { 小兔崽: 2, 巨大火鸡蛋: 1 } });
    assert.deepEqual(storeMod.parseFnosRanchStealMessage('乱码'), { friend: '', items: {} });
});

test('data-provider：指定账号走持久化日志，space=farm|ranch|all，分类视图也能看到', () => {
    const s = storeMod.createFnosLogStore({ dir: tmpDir(), flushMs: 0 });
    storeMod.setFnosLogStoreForTest(s);
    try {
        s.record(ranch('1', '.岁月如歌：获得 鸭蛋 ×3', 'ranch_steal'));
        for (let i = 0; i < 20; i++) s.record(farm('1', `农场 ${i}`));
        s.record({ accountId: '1', tag: '好友', msg: '张三: 偷3(白萝卜)', meta: { event: '照顾好友', actions: ['偷3(白萝卜)'] }, ts: Date.now() + (seq++), time: 'x' });
        const provider = createDataProvider({
            workers: {},
            globalLogs: [],
            accountLogs: [],
            store: {},
            getAccounts: () => ({ accounts: [{ id: '1', name: 'A' }] }),
            callWorkerApi: async () => null,
            buildDefaultStatus: () => ({}),
            normalizeStatusForPanel: (x) => x,
            filterLogs: (list) => list,
            addAccountLog: () => {},
            nextConfigRevision: () => 1,
            broadcastConfigToWorkers: () => {},
            buildConfigSnapshotForAccount: () => ({}),
        });
        assert.equal(provider.getLogs('1', { limit: 5, fnosSpace: 'ranch' }).length, 1);
        assert.equal(provider.getLogs('1', { limit: 5, fnosSpace: 'farm' }).length, 5);
        const all = provider.getLogs('1', { limit: 5, fnosSpace: 'all' });
        assert.equal(all.length, 6, '全部：农场、牧场各取 limit 条');
        assert.ok(all.some(e => e.meta.event === 'ranch_steal'));
        assert.equal(provider.getLogs('1', { limit: 5 }).length, 5, '不带 space 时保持上游的总条数限制');
        const steal = provider.getLogs('1', { limit: 50, fnosCategory: 'steal' });
        assert.equal(steal.length, 2);
        provider.clearLogs('1');
        assert.equal(provider.getLogs('1', { limit: 50, fnosSpace: 'all' }).length, 0);
    } finally {
        storeMod.setFnosLogStoreForTest(null);
    }
});
