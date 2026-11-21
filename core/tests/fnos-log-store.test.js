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

const BEIJING_NOON = Date.parse('2026-11-18T12:00:00+08:00');
const BEIJING_2359 = Date.parse('2026-11-17T23:59:59.500+08:00');
const BEIJING_0000 = Date.parse('2026-11-18T00:00:00.000+08:00');

test('牧场每日汇总：偷取次数、好友、物品；其他动作计数；跳过 / 失败不算成功', () => {
    const dir = tmpDir();
    const s = storeMod.createFnosLogStore({ dir, flushMs: 0, ranchCap: 2, now: () => BEIJING_NOON });
    s.record(ranch('1', '.岁月如歌：获得 鸭蛋 ×3', 'ranch_steal', 'ok', BEIJING_NOON));
    s.record(ranch('1', '琳琳：获得 鹅蛋 ×8、巨大鹅蛋 ×1', 'ranch_steal', 'ok', BEIJING_NOON + 1));
    s.record(ranch('1', '琳琳：获得 鹅蛋 ×2', 'ranch_steal', 'ok', BEIJING_NOON + 2));
    s.record(ranch('1', '收获完成', 'ranch_harvest', 'ok', BEIJING_NOON + 3));
    s.record(ranch('1', '暂不能拜访 小果', 'ranch_friend', 'skipped', BEIJING_NOON + 4));
    s.record(ranch('1', '购买 暂未执行', 'ranch_buy', 'skipped', BEIJING_NOON + 5));
    s.record(ranch('1', '放蚊子', 'ranch_putMosquito', 'ok', BEIJING_NOON + 6));
    const [today] = s.getRanchSummary('1', 1);
    assert.equal(today.date, '2026-11-18');
    assert.equal(today.steal.times, 3);
    assert.deepEqual(today.steal.friends, ['.岁月如歌', '琳琳']);
    assert.deepEqual(today.steal.items, { 鸭蛋: 3, 鹅蛋: 10, 巨大鹅蛋: 1 });
    assert.equal(today.harvest, 1);
    assert.equal(today.buy, 0);
    assert.equal(today.putMosquito, 1);
    // 汇总不受条数上限影响，且持久化
    const again = storeMod.createFnosLogStore({ dir, flushMs: 0, now: () => BEIJING_NOON });
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

function farmEvent(accountId, msg, event, result = 'ok', ts = BEIJING_NOON, extra = {}) {
    return { accountId, tag: event === '照顾好友' ? '好友' : '农场', msg, meta: { module: event === '照顾好友' ? 'friend' : 'farm', event, result, ...extra }, ts, time: '2026-11-18 12:00:00' };
}

test('北京时间 0 点切日：23:59 与 00:00 不混日，过 0 点今日汇总重新起算', () => {
    const dir = tmpDir();
    let clock = BEIJING_2359;
    const s = storeMod.createFnosLogStore({ dir, flushMs: 0, now: () => clock });
    s.record(ranch('1', '阿强：获得 鸭蛋 ×2', 'ranch_steal', 'ok', BEIJING_2359));
    s.record(farmEvent('1', '收获完成 3 块土地', '收获作物', 'ok', BEIJING_2359, { count: 3 }));
    const [beforeRanch] = s.getRanchSummary('1', 1);
    const [beforeFarm] = s.getFarmSummary('1', 1);
    assert.equal(beforeRanch.date, '2026-11-17');
    assert.equal(beforeRanch.steal.times, 1);
    assert.equal(beforeFarm.date, '2026-11-17');
    assert.equal(beforeFarm.harvest, 3);

    clock = BEIJING_0000;
    const [todayRanch, ydayRanch] = s.getRanchSummary('1', 2);
    const [todayFarm, ydayFarm] = s.getFarmSummary('1', 2);
    assert.equal(todayRanch.date, '2026-11-18');
    assert.equal(todayRanch.steal.times, 0);
    assert.equal(ydayRanch.date, '2026-11-17');
    assert.equal(ydayRanch.steal.times, 1);
    assert.equal(todayFarm.date, '2026-11-18');
    assert.equal(todayFarm.harvest, 0);
    assert.equal(ydayFarm.date, '2026-11-17');
    assert.equal(ydayFarm.harvest, 3);

    s.record(ranch('1', '阿强：获得 鹅蛋 ×1', 'ranch_steal', 'ok', BEIJING_0000));
    s.record(farmEvent('1', '收获完成 2 块土地', '收获作物', 'ok', BEIJING_0000, { count: 2 }));
    assert.equal(s.getRanchSummary('1', 1)[0].steal.times, 1);
    assert.deepEqual(s.getRanchSummary('1', 1)[0].steal.items, { 鹅蛋: 1 });
    assert.equal(s.getFarmSummary('1', 1)[0].harvest, 2);
    assert.equal(s.getFarmSummary('1', 2)[1].harvest, 3, '旧日统计仍保留');
    assert.equal(storeMod.fnosLocalDate(BEIJING_2359), '2026-11-17');
    assert.equal(storeMod.fnosLocalDate(BEIJING_0000), '2026-11-18');
    assert.equal(storeMod.fnosMsUntilNextBeijingMidnight(BEIJING_2359), 500);
    assert.equal(storeMod.fnosMsUntilNextBeijingMidnight(BEIJING_0000), 24 * 3600 * 1000);
});

test('农场每日汇总：收获/施肥/种植累加；照顾好友解析偷菜与帮忙；跳过不算；持久化', () => {
    const dir = tmpDir();
    const s = storeMod.createFnosLogStore({ dir, flushMs: 0, farmCap: 2, now: () => BEIJING_NOON });
    s.record(farmEvent('1', '收获完成 4 块土地', '收获作物', 'ok', BEIJING_NOON, { count: 4 }));
    s.record(farmEvent('1', '施肥后立即收获 2 块土地', '施肥后收获作物', 'ok', BEIJING_NOON + 1, { count: 2 }));
    s.record(farmEvent('1', '已为 5 块地施普通化肥', '常规施肥', 'ok', BEIJING_NOON + 2, { count: 5 }));
    s.record(farmEvent('1', '当前施肥策略为不施肥，跳过', '常规施肥', 'skip', BEIJING_NOON + 3));
    s.record(farmEvent('1', '已在 3 块地种植', '种植种子', 'ok', BEIJING_NOON + 4, { count: 3 }));
    s.record(farmEvent('1', '种植状态不确定', '种植种子', 'plant_uncertain', BEIJING_NOON + 5, { count: 2 }));
    s.record(farmEvent('1', '已铲除 1 块', '铲除植物', 'ok', BEIJING_NOON + 6, { count: 1 }));
    s.record(farmEvent('1', '琳琳: 偷3(白萝卜/胡萝卜)/一键务农2块/3项(草1/水2)/放草1', '照顾好友', 'ok', BEIJING_NOON + 7, {
        friendName: '琳琳', actions: ['偷3(白萝卜/胡萝卜)', '一键务农2块/3项(草1/水2)', '放草1'],
    }));
    s.record(farmEvent('1', '小果: 偷2(白萝卜)', '照顾好友', 'ok', BEIJING_NOON + 8, {
        friendName: '小果', actions: ['偷2(白萝卜)'],
    }));
    s.record(farmEvent('1', '收获失败', '收获作物', 'error', BEIJING_NOON + 9, { count: 4 }));
    const [today] = s.getFarmSummary('1', 1);
    assert.equal(today.date, '2026-11-18');
    assert.equal(today.harvest, 6);
    assert.equal(today.fertilize, 5);
    assert.equal(today.plant, 3);
    assert.equal(today.shovel, 1);
    assert.equal(today.steal.times, 5);
    assert.deepEqual(today.steal.friends, ['琳琳', '小果']);
    assert.deepEqual(today.steal.items, { 白萝卜: 4, 胡萝卜: 1 });
    assert.equal(today.helpWeed, 1);
    assert.equal(today.helpWater, 2);
    assert.equal(today.helpBug, 0);
    assert.equal(today.putWeed, 1);
    assert.equal(today.putBug, 0);
    assert.equal(today.errors, 1);
    // 不受农场日志条数上限影响，且读回文件一致
    const again = storeMod.createFnosLogStore({ dir, flushMs: 0, now: () => BEIJING_NOON });
    assert.equal(again.getFarmSummary('1', 1)[0].steal.times, 5);
    assert.equal(again.getFarmSummary('1', 1)[0].harvest, 6);
    assert.equal(again.getFarmSummary('1', 3).length, 3);
});

test('农场照顾好友消息解析：只从正文切分也能得出动作', () => {
    const parsed = storeMod.parseFnosFarmCareMessage('张三: 偷3(白萝卜/胡萝卜)/一键务农2块/3项(草1/虫1/水2)/放草1/放虫2');
    assert.equal(parsed.friend, '张三');
    assert.equal(parsed.stealTimes, 3);
    assert.deepEqual(parsed.items, { 白萝卜: 2, 胡萝卜: 1 });
    assert.equal(parsed.helpWeed, 1);
    assert.equal(parsed.helpBug, 1);
    assert.equal(parsed.helpWater, 2);
    assert.equal(parsed.putWeed, 1);
    assert.equal(parsed.putBug, 2);
    assert.deepEqual(storeMod.parseFnosFarmCareMessage('乱码'), {
        friend: '', stealTimes: 0, items: {}, helpWeed: 0, helpBug: 0, helpWater: 0, putWeed: 0, putBug: 0,
    });
});

test('切日与进程时区无关：TZ 设成洛杉矶 / 东京，北京时间 23:59 与 00:00 仍分属两天', () => {
    const { spawnSync } = require('node:child_process');
    const script = `
        const m = require(${JSON.stringify(require.resolve('../dist/runtime/fnos-log-store'))});
        process.stdout.write(JSON.stringify([
            m.fnosLocalDate(Date.parse('2026-11-17T23:59:59.999+08:00')),
            m.fnosLocalDate(Date.parse('2026-11-18T00:00:00.000+08:00')),
            m.fnosLocalDate(Date.parse('2026-12-31T23:59:59.999+08:00')),
            m.fnosLocalDate(Date.parse('2027-01-01T00:00:00.000+08:00')),
        ]));`;
    for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
        const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(JSON.parse(r.stdout), ['2026-11-17', '2026-11-18', '2026-12-31', '2027-01-01'], tz);
    }
});
