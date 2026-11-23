// [fnos-fork] 2026-11-23 首页合并概览缓存
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOverviewCache } = require('../dist/runtime/fnos-overview-cache');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-ov-'));

test('没有缓存时返回两边都为空', () => {
    const c = createOverviewCache({ dir: tmp() });
    assert.deepEqual(c.get('1'), { farm: null, ranch: null });
});

test('农场、牧场分别保存，按账号隔离，带更新时间，重新创建后还在', () => {
    const dir = tmp();
    let t = 1000;
    const c = createOverviewCache({ dir, now: () => t });
    c.set('1', 'farm', { level: 30 });
    t = 2000;
    c.set('1', 'ranch', { level: 5 });
    c.set('2', 'farm', { level: 9 });
    const again = createOverviewCache({ dir }).get('1');
    assert.equal(again.farm.level, 30);
    assert.equal(again.farm.updatedAt, 1000);
    assert.equal(again.ranch.updatedAt, 2000);
    assert.equal(createOverviewCache({ dir }).get('2').ranch, null);
});

test('覆盖同一边不影响另一边；坏文件当作没有缓存；非法输入被拒绝', () => {
    const dir = tmp();
    const c = createOverviewCache({ dir });
    c.set('1', 'farm', { level: 1 });
    c.set('1', 'ranch', { level: 2 });
    c.set('1', 'farm', { level: 3 });
    assert.equal(c.get('1').ranch.level, 2);
    assert.equal(c.get('1').farm.level, 3);
    fs.writeFileSync(path.join(dir, '1.json'), '{oops');
    assert.deepEqual(c.get('1'), { farm: null, ranch: null });
    assert.throws(() => c.set('1', 'moon', {}));
    assert.throws(() => c.set('1', 'farm', null));
    assert.throws(() => c.set('1', 'farm', { big: 'x'.repeat(300 * 1024) }));
});
