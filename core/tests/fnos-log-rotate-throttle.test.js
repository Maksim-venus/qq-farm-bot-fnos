// [fnos-fork] 2026-11-17 combined.log 按天切分 / 刷屏日志每小时一次
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const logger = require('../dist/services/logger');
const { createFnosLogThrottle } = require('../dist/utils/fnos-log-throttle');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-log-rotate-'));
}

test('旧 combined.log：小文件直接改名归档', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'combined.log'), 'a\nb\n');
    const name = logger.fnosArchiveLegacyCombinedLog(dir, Date.now(), 1024);
    assert.match(name, /^combined-legacy-\d{4}-\d{2}-\d{2}\.log$/);
    assert.equal(fs.existsSync(path.join(dir, 'combined.log')), false);
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'a\nb\n');
    assert.equal(logger.fnosArchiveLegacyCombinedLog(dir), '', '没有旧文件时什么都不做');
});

test('旧 combined.log 超大：只留末尾、从整行开始；同名归档自动加序号', () => {
    const dir = tmpDir();
    const lines = [];
    for (let i = 0; i < 1000; i++) lines.push(JSON.stringify({ i, message: `line ${i}` }));
    fs.writeFileSync(path.join(dir, 'combined.log'), `${lines.join('\n')}\n`);
    fs.writeFileSync(path.join(dir, `combined-legacy-${logger.fnosLocalDateKey()}.log`), 'old');
    const name = logger.fnosArchiveLegacyCombinedLog(dir, Date.now(), 2000);
    assert.match(name, /-1\.log$/);
    const kept = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.ok(kept.length <= 2000);
    const keptLines = kept.trim().split('\n');
    assert.doesNotThrow(() => keptLines.forEach(l => JSON.parse(l)), '第一行不是半行');
    assert.equal(JSON.parse(keptLines[keptLines.length - 1]).i, 999);
    assert.equal(fs.existsSync(path.join(dir, 'combined.log')), false);
});

test('只留 7 天：按文件名日期删除，其他文件不动', () => {
    const dir = tmpDir();
    const now = new Date(2026, 10, 17, 12, 0, 0).getTime();
    for (const name of ['combined-2026-11-17.log', 'combined-2026-11-11.log', 'combined-2026-11-10.log', 'combined-legacy-2026-11-09.log', 'combined-2026-11-09-1.log', 'error.log', 'other.txt']) {
        fs.writeFileSync(path.join(dir, name), 'x');
    }
    const removed = logger.fnosCleanupCombinedLogs(dir, now, 7).sort();
    assert.deepEqual(removed, ['combined-2026-11-09-1.log', 'combined-2026-11-10.log', 'combined-legacy-2026-11-09.log']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['combined-2026-11-11.log', 'combined-2026-11-17.log', 'error.log', 'other.txt']);
    assert.equal(path.basename(logger.fnosCombinedLogFile(dir, now)), 'combined-2026-11-17.log');
});

test('刷屏提示同账号同内容每小时只记一次，之后注明省略次数', () => {
    let t = 1_000_000;
    const th = createFnosLogThrottle(3600_000, () => t);
    const msg = '暂不能拜访 小果：gamepb.visitpb.VisitService.EnterHomestead 错误: code=1002002 不是好友无法拜访';
    const meta = { module: 'ranch', event: 'ranch_friend', result: 'skipped' };
    assert.equal(th.check('牧场', msg, meta), msg);
    t += 5 * 60_000;
    assert.equal(th.check('牧场', msg, meta), null);
    assert.equal(th.check('牧场', msg, meta), null);
    // 不同好友、不同内容照常记
    assert.equal(th.check('牧场', '暂不能拜访 小花：不是好友无法拜访', meta), '暂不能拜访 小花：不是好友无法拜访');
    const buy = '购买鹅 ×4 暂未执行：该操作的上次结果未知，请在牧场页面核对后解除保护';
    assert.equal(th.check('牧场', buy, { module: 'ranch', event: 'ranch_buy', result: 'skipped' }), buy);
    assert.equal(th.check('牧场', buy, { module: 'ranch', event: 'ranch_buy', result: 'skipped' }), null);
    t += 60 * 60_000;
    assert.equal(th.check('牧场', msg, meta), `${msg}（过去 1 小时同样提示省略 2 次）`);
    assert.equal(th.check('牧场', msg, meta), null);
});

test('非跳过类日志、成功日志不受限', () => {
    const th = createFnosLogThrottle(3600_000, () => 1);
    const ok = { module: 'ranch', event: 'ranch_addGrass', result: 'ok' };
    assert.equal(th.check('牧场', '补充牧草完成', ok), '补充牧草完成');
    assert.equal(th.check('牧场', '补充牧草完成', ok), '补充牧草完成');
    assert.equal(th.check('牧场', '暂未执行 x', { result: 'error' }), '暂未执行 x');
    assert.equal(th.check('牧场', '暂未执行 x', { result: 'error' }), '暂未执行 x');
    assert.equal(th.isSpam('清理完成', { result: 'skipped' }), false);
});
