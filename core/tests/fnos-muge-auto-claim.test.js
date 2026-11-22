// [fnos-fork] 牧歌初启成长手册奖励自动领取：任务 + 积分档位全部领取、开关、静默处理。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-muge-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '7';
const dist = rel => require.resolve(path.join('..', 'dist', rel));
const mock = (rel, exports) => { const id = dist(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const logs = [];
const realUtils = require('../dist/utils/utils');
mock('utils/utils', { ...realUtils, log: (t, m) => logs.push(m), logWarn: (t, m) => logs.push(`WARN|${m}`) });
mock('utils/network', { getUserState: () => ({ gid: 1 }), getWsErrorState: () => ({}), getWs: () => null, invalidateGameScene: () => {} });

const st = { active: true, tasks: [], tiers: [], ops: [], fail: null };
mock('services/muge-activity', {
    getMugeActivity: async () => ({ active: st.active, endTime: 0, handbook: { tasks: st.tasks, tiers: st.tiers } }),
    operateMugeActivity: async action => {
        st.ops.push(action);
        if (st.fail) throw Object.assign(new Error('x'), { code: st.fail });
        if (action === 'claimTask') { st.tasks.forEach(t => { if (t.status === 2) t.status = 3; }); st.tiers.forEach(t => { if (t.status === 1 && st.unlockTier) t.status = 2; }); return { rewards: [{ name: '金币', count: 100 }] }; }
        st.tiers.forEach(t => { if (t.status === 2) t.status = 3; });
        return { rewards: [{ id: 9, count: 1 }] };
    },
});
const store = require('../dist/models/store');
const ranch = require('../dist/services/ranch/fnos-ranch');
test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));
function reset() { logs.length = 0; st.ops = []; st.fail = null; st.active = true; st.unlockTier = true; ranch.runtime ? 0 : 0; }

test('默认开启；任务奖励后新解锁的档位奖励一并领完', async () => {
    assert.equal(ranch.normalizeFnosRanch(undefined).mugeAutoClaim, true);
    store.applyConfigSnapshot({}, { accountId: '7' });
    reset();
    st.tasks = [{ status: 2 }, { status: 2 }, { status: 1 }];
    st.tiers = [{ status: 1 }, { status: 3 }];
    assert.equal(await ranch.runMuge(1e12), true);
    assert.deepEqual(st.ops, ['claimTask', 'claimHandbook']);
    assert.equal(logs.filter(m => m.includes('牧歌初启')).length, 2);
    assert.equal(await ranch.runMuge(1e12 + 1000), false, '30 分钟内不重复读取');
});

test('没有可领 / 已领 / 活动未开始：静默', async () => {
    reset();
    st.tasks = [{ status: 3 }]; st.tiers = [{ status: 3 }];
    assert.equal(await ranch.runMuge(2e12), false);
    assert.deepEqual(st.ops, []);
    st.tasks = [{ status: 2 }];
    st.fail = 'MUGE_NOT_CLAIMABLE';
    assert.equal(await ranch.runMuge(3e12), false);
    assert.equal(logs.length, 0);
    st.fail = 'BOOM';
    assert.equal(await ranch.runMuge(4e12), false);
    assert.equal(logs.filter(m => m.includes('领取失败')).length, 1);
});

test('开关关闭不调用', async () => {
    reset();
    store.applyConfigSnapshot({ fnosRanch: { mugeAutoClaim: false } }, { accountId: '7' });
    st.tasks = [{ status: 2 }];
    assert.equal(await ranch.runMuge(5e12), false);
    assert.deepEqual(st.ops, []);
});
