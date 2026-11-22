// [fnos-fork] 2026-11-23 偷菜被拒（被人摘走/未成熟等）不写「错误」日志：stealHarvest 把这些码登记为预期错误。
const assert = require('node:assert/strict');
const test = require('node:test');

test('stealHarvest 声明偷菜常见拒绝码为预期错误，且异常仍抛给调用方', async t => {
    const calls = [];
    const mock = (name, exports) => {
        const id = require.resolve(name);
        const original = require.cache[id];
        require.cache[id] = { id, filename: id, loaded: true, exports };
        t.after(() => { if (original) require.cache[id] = original; else delete require.cache[id]; });
    };
    const codec = (decoded = {}) => ({ create: v => v, encode: v => ({ finish: () => v }), decode: () => decoded });
    mock('../dist/utils/network', {
        GatewayError: class extends Error {}, getUserState: () => ({ gid: 1 }),
        sendMsgAsync: async (service, method, body, opts) => {
            calls.push({ service, method, opts });
            if (calls.length === 2) throw new Error('code=1001040 果实被人摘走');
            return { body: Buffer.alloc(0) };
        },
    });
    mock('../dist/utils/proto', { types: { HarvestRequest: codec(), HarvestReply: codec({}) } });
    const id = require.resolve('../dist/services/friend/api');
    const original = require.cache[id];
    delete require.cache[id];
    t.after(() => { if (original) require.cache[id] = original; else delete require.cache[id]; });
    const api = require('../dist/services/friend/api');
    // 调度器引用只在 reply 后用到，这里提供最小桩
    const sched = require.resolve('../dist/services/friend/scheduler');
    mock('../dist/services/friend/scheduler', { updateOperationLimits() {} });
    void sched;
    await api.stealHarvest(1, [1]);
    await assert.rejects(api.stealHarvest(1, [1]), /果实被人摘走/);
    for (const c of calls) {
        assert.equal(c.method, 'Harvest');
        assert.deepEqual([...c.opts.expectedErrorCodes].sort(), [1001011, 1001021, 1001040, 1001045]);
    }
});
