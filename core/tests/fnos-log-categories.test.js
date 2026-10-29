// [fnos-fork] 运行日志分类（偷菜 / 报错）测试
const assert = require('node:assert/strict');
const test = require('node:test');

const cats = require('../dist/runtime/fnos-log-categories');
const { createDataProvider } = require('../dist/runtime/data-provider');

function entry(accountId, tag, msg, meta = {}, extra = {}) {
    return { accountId, tag, msg, meta, ts: Date.now(), time: '2026-10-29 10:00:00', ...extra };
}

test('偷菜分类：照顾好友 actions / 巡查总结 summary / 偷菜后出售 / 小号留菜 / msg 兜底', () => {
    assert.equal(cats.isFnosStealLog(entry('1', '好友', '张三: 偷3(白萝卜)/放草1', { event: '照顾好友', actions: ['偷3(白萝卜)', '放草1'] })), true);
    assert.equal(cats.isFnosStealLog(entry('1', '好友', '偷心: 放草1', { event: '照顾好友', actions: ['放草1'] })), false);
    assert.equal(cats.isFnosStealLog(entry('1', '好友', '巡查完成 → 偷5/放虫1', { event: '好友巡查循环', summary: ['偷5', '放虫1'] })), true);
    assert.equal(cats.isFnosStealLog(entry('1', '好友', '巡查完成 → 一键务农2', { event: '好友巡查循环', summary: ['一键务农2'] })), false);
    assert.equal(cats.isFnosStealLog(entry('1', '仓库', '手动偷取后自动出售失败: x', { event: '偷菜后出售', result: 'error' }, { isWarn: true })), true);
    assert.equal(cats.isFnosStealLog(entry('1', '小号', '留给大号 A 偷，暂不收获 2 块', { event: '小号留菜', result: 'waiting' })), true);
    assert.equal(cats.isFnosStealLog(entry('1', '好友', '大号 A 有 3 块可偷，按「不偷大号的菜」跳过')), true);
    // 巡查开始的「可偷 3」只是计划数，不算偷菜结果
    assert.equal(cats.isFnosStealLog(entry('1', '好友', '开始好友巡查，本轮 8 位（可偷 3 / 需帮 2 / 纯捣乱 0）', { event: '开始好友巡查' })), false);
    assert.equal(cats.isFnosStealLog(entry('1', '农场', '收获 5 块')), false);
    assert.equal(cats.isFnosStealLog(null), false);
});

test('报错分类：错误级 / 警告级', () => {
    assert.equal(cats.getFnosErrorLevel(entry('', '错误', '账号进程报错')), 'error');
    assert.equal(cats.getFnosErrorLevel(entry('1', '好友', '访客记录接口失败', { result: 'error' }, { isWarn: true })), 'error');
    assert.equal(cats.getFnosErrorLevel(entry('1', '农场', 'x', { result: 'failed' })), 'error');
    assert.equal(cats.getFnosErrorLevel(entry('1', '系统', 'x', {}, { result: 'fail' })), 'error');
    assert.equal(cats.getFnosErrorLevel(entry('1', '好友', '巡查异常', {}, { isWarn: true })), 'warn');
    assert.equal(cats.getFnosErrorLevel(entry('1', '警告', 'x')), 'warn');
    assert.equal(cats.getFnosErrorLevel(entry('1', '农场', '跳过', { result: 'skip' })), '');
    assert.equal(cats.getFnosErrorLevel(entry('1', '农场', '收获', { result: 'ok' }, { isWarn: false })), '');
    assert.deepEqual(cats.classifyFnosLog(entry('1', '仓库', '手动偷取后自动出售失败', { event: '偷菜后出售', result: 'error' }, { isWarn: true })), ['steal', 'error']);
});

test('环形缓冲各自 1000 条上限，不被普通日志挤掉；清空按账号', () => {
    cats.clearFnosCategoryLogs('');
    for (let i = 0; i < 1200; i++) cats.recordFnosLogCategories(entry('1', '好友', `x${i}`, {}, { isWarn: true }));
    for (let i = 0; i < 5000; i++) cats.recordFnosLogCategories(entry('1', '农场', `普通${i}`));
    cats.recordFnosLogCategories(entry('2', '好友', 'B: 偷1', { event: '照顾好友', actions: ['偷1'] }));
    const errors = cats.getFnosCategoryLogs('error', '1');
    assert.equal(errors.length, cats.FNOS_LOG_CATEGORY_CAP);
    assert.equal(errors[0].msg, 'x200');
    assert.equal(cats.getFnosCategoryLogs('steal', '').length, 1);
    assert.equal(cats.getFnosCategoryLogs('steal', '1').length, 0);
    cats.clearFnosCategoryLogs('1');
    assert.equal(cats.getFnosCategoryLogs('error', '').length, 0);
    assert.equal(cats.getFnosCategoryLogs('steal', '2').length, 1);
    cats.clearFnosCategoryLogs('');
    assert.equal(cats.getFnosCategoryLogs('steal', '').length, 0);
});

test('查询参数规范化', () => {
    assert.deepEqual(cats.fnosLogQueryOptions({ category: 'STEAL', level: 'x' }), { fnosCategory: 'steal', fnosLevel: '' });
    assert.deepEqual(cats.fnosLogQueryOptions({ category: 'error', level: 'warn' }), { fnosCategory: 'error', fnosLevel: 'warn' });
    assert.deepEqual(cats.fnosLogQueryOptions({ category: 'other' }), { fnosCategory: '', fnosLevel: '' });
    assert.deepEqual(cats.fnosLogQueryOptions(null), { fnosCategory: '', fnosLevel: '' });
});

test('provider.getLogs 支持 fnosCategory / fnosLevel，clearLogs 同步清分类缓冲', () => {
    cats.clearFnosCategoryLogs('');
    const globalLogs = [];
    const push = (e) => {
        globalLogs.push(e);
        if (globalLogs.length > 1000) globalLogs.shift();
        cats.recordFnosLogCategories(e);
    };
    push(entry('1', '好友', 'A: 偷2', { event: '照顾好友', actions: ['偷2'] }));
    push(entry('1', '好友', '巡查异常', {}, { isWarn: true }));
    push(entry('1', '错误', '进程报错'));
    for (let i = 0; i < 1500; i++) push(entry('1', '农场', `普通${i}`));
    const filterLogs = (list, f = {}) => list.filter(l => !f.keyword || String(l.msg).includes(f.keyword));
    const provider = createDataProvider({
        workers: {},
        globalLogs,
        accountLogs: [],
        store: {},
        getAccounts: () => ({ accounts: [{ id: '1', name: 'A' }] }),
        callWorkerApi: async () => null,
        buildDefaultStatus: () => ({}),
        normalizeStatusForPanel: d => d,
        filterLogs,
        addAccountLog: () => {},
        nextConfigRevision: () => 1,
        broadcastConfigToWorkers: () => {},
        buildConfigSnapshotForAccount: () => ({}),
        startWorker: () => true,
        stopWorker: () => {},
        restartWorker: () => {},
    });
    // 全量视图已被普通日志挤掉
    assert.equal(provider.getLogs('1', { limit: 1000 }).some(l => l.msg === 'A: 偷2'), false);
    assert.deepEqual(provider.getLogs('1', { limit: 100, fnosCategory: 'steal' }).map(l => l.msg), ['A: 偷2']);
    assert.deepEqual(provider.getLogs('1', { limit: 100, fnosCategory: 'error' }).map(l => l.msg), ['巡查异常', '进程报错']);
    assert.deepEqual(provider.getLogs('1', { limit: 100, fnosCategory: 'error', fnosLevel: 'error' }).map(l => l.msg), ['进程报错']);
    assert.deepEqual(provider.getLogs('1', { limit: 100, fnosCategory: 'error', fnosLevel: 'warn' }).map(l => l.msg), ['巡查异常']);
    assert.deepEqual(provider.getLogs('1', { limit: 100, fnosCategory: 'error', keyword: '进程' }).map(l => l.msg), ['进程报错']);
    assert.equal(provider.getLogs('all', { limit: 100, fnosCategory: 'error' }).length, 2);
    provider.clearLogs('1');
    assert.equal(provider.getLogs('1', { limit: 100, fnosCategory: 'error' }).length, 0);
    assert.equal(provider.getLogs('1', { limit: 100, fnosCategory: 'steal' }).length, 0);
});
