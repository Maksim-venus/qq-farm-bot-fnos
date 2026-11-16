// [fnos-fork] 2026-11-17 图鉴 / 牧场图鉴 / 巨大图鉴奖励自动领取：默认开启 + 一次性迁移、领取检查节奏、红点触发、牧场图鉴只在到期时进场。
// 真实 store / fnos-fork-config / fnos-ranch，mock 网络、日志、牧场图鉴与报价接口。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-ill-claim-'));
process.env.QQ_FARM_DATA_DIR = DATA_DIR;
process.env.FARM_ACCOUNT_ID = '7';
test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

const dist = rel => require.resolve(path.join('..', 'dist', rel));
const mock = (rel, exports) => { const id = dist(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const logs = [];
const realUtils = require('../dist/utils/utils');
mock('utils/utils', { ...realUtils, log: (tag, msg) => logs.push(`${tag}|${msg}`), logWarn: (tag, msg) => logs.push(`${tag}|WARN|${msg}`) });
mock('utils/network', { getUserState: () => ({ gid: 1001 }), getWsErrorState: () => ({}), getWs: () => null, invalidateGameScene: () => {}, networkEvents: { on() {}, off() {} } });
const book = { normal: { canClaim: false, rewards: [] }, giant: { levels: [] }, animals: [] };
mock('services/ranch/book', { getBook: async () => book });
const calls = [];
mock('services/ranch/actions', {
    prepareAction: async (action, input) => ({ count: input.kind === 'giant' ? book.giant.levels.filter(l => l.canClaim).length : 1, expected: 'x', label: '领取图鉴奖励' }),
    operate: async (action, input) => { calls.push(`${action}:${input.kind}`); return { status: 'confirmed', rewards: input.kind === 'giant' ? [{ id: 1002, name: '点券', count: '600' }, { id: 80023, name: '道具', count: '10' }] : [{ id: 1002, name: '点券', count: '200' }] }; },
});

const store = require('../dist/models/store');
const auto = require('../dist/services/fnos-illustrated-auto');
const ranch = require('../dist/services/ranch/fnos-ranch');
const { migrateIllustratedClaimDefaultOn } = require('../dist/services/fnos-claim-default-migration');
const apply = cfg => store.applyConfigSnapshot(cfg, { accountId: '7' });

test('迁移：老配置里的两个领取开关打开一次，写标记；之后用户关掉不再改回；自动完成和缺字段不动', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-ill-mig-'));
    fs.mkdirSync(path.join(dir, 'account-configs'));
    const a1 = { stealDelaySeconds: 3, fnosIllustratedAuto: { autoClaimRewards: false, autoComplete: false }, fnosRanch: { altHold: true, illustratedAutoClaim: false, illustratedAutoComplete: false } };
    const a2 = { stealDelaySeconds: 1 };
    fs.writeFileSync(path.join(dir, 'account-configs', 'a1.json'), JSON.stringify(a1));
    fs.writeFileSync(path.join(dir, 'account-configs', 'a2.json'), JSON.stringify(a2));
    fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ defaultAccountConfig: { fnosIllustratedAuto: { autoClaimRewards: false, autoComplete: true } } }));
    const r = migrateIllustratedClaimDefaultOn(dir);
    assert.equal(r.changed, 3);
    const got1 = JSON.parse(fs.readFileSync(path.join(dir, 'account-configs', 'a1.json'), 'utf8'));
    assert.equal(got1.fnosIllustratedAuto.autoClaimRewards, true);
    assert.equal(got1.fnosIllustratedAuto.autoComplete, false);
    assert.equal(got1.fnosRanch.illustratedAutoClaim, true);
    assert.equal(got1.fnosRanch.illustratedAutoComplete, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'account-configs', 'a2.json'), 'utf8')), a2, '缺字段不新建');
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
    assert.deepEqual(st.defaultAccountConfig.fnosIllustratedAuto, { autoClaimRewards: true, autoComplete: true });
    assert.ok(fs.existsSync(path.join(dir, 'fnos-migrations', 'illustrated-claim-default-on.json')));
    // 用户之后关掉 → 再次启动不改回
    got1.fnosIllustratedAuto.autoClaimRewards = false;
    fs.writeFileSync(path.join(dir, 'account-configs', 'a1.json'), JSON.stringify(got1));
    assert.equal(migrateIllustratedClaimDefaultOn(dir).skipped, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'account-configs', 'a1.json'), 'utf8')).fnosIllustratedAuto.autoClaimRewards, false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('迁移：相对路径（单测 mock）不动', () => {
    assert.equal(migrateIllustratedClaimDefaultOn('.').skipped, true);
});

test('迁移：全新安装（没有配置文件）只写标记', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnos-ill-mig-'));
    const r = migrateIllustratedClaimDefaultOn(dir);
    assert.equal(r.changed, 0);
    assert.equal(r.errors.length, 0);
    assert.ok(fs.existsSync(path.join(dir, 'fnos-migrations', 'illustrated-claim-default-on.json')));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('农场：领取检查每 30 分钟一次；红点 normal / premium 提前', () => {
    auto.resetFnosIllustratedRuntime();
    const t0 = 1_000_000;
    assert.equal(auto.takeClaimTurn(t0), true);
    assert.equal(auto.takeClaimTurn(t0 + 10 * 60_000), false);
    assert.equal(auto.takeClaimTurn(t0 + auto.CLAIM_INTERVAL_MS - 1), false);
    assert.equal(auto.takeClaimTurn(t0 + auto.CLAIM_INTERVAL_MS), true);
    assert.deepEqual(auto.onIllustratedRewardRedDot({ normal_reward_available: false, premium_reward_available: false, ranch_reward_available: false }), { farm: false, ranch: false });
    assert.equal(auto.takeClaimTurn(t0 + auto.CLAIM_INTERVAL_MS + 1), false);
    assert.equal(auto.onIllustratedRewardRedDot({ premium_reward_available: true }).farm, true);
    assert.equal(auto.takeClaimTurn(t0 + auto.CLAIM_INTERVAL_MS + 2), true);
    apply({ fnosIllustratedAuto: { autoClaimRewards: false } });
    assert.equal(auto.onIllustratedRewardRedDot({ normal_reward_available: true }).farm, false, '开关关着不触发');
    apply({ fnosIllustratedAuto: { autoClaimRewards: true } });
});

test('农场：runIllustratedAutoTick({claim:false}) 不读图鉴等级', async () => {
    let reads = 0;
    const deps = { illustrated: { getIllustratedLevels: async () => { reads++; return { level_list: [] }; }, claimIllustratedRewards: async () => ({}) } };
    await auto.runIllustratedAutoTick({ deps, claim: false });
    assert.equal(reads, 0);
    await auto.runIllustratedAutoTick({ deps });
    assert.equal(reads, 2, '作物 + 变异两本');
});

test('红点通知解码：IllustratedRewardRedDotNotifyV2 三个布尔', () => {
    const root = new protobuf.Root().loadSync(path.join(__dirname, '..', 'src', 'proto', 'illustratedpb.proto'), { keepCase: true });
    const T = root.lookupType('gamepb.illustratedpb.IllustratedRewardRedDotNotifyV2');
    const n = T.decode(T.encode({ normal_reward_available: false, premium_reward_available: true, ranch_reward_available: true }).finish());
    assert.equal(n.premium_reward_available, true);
    assert.equal(n.ranch_reward_available, true);
    assert.equal(T.decode(new Uint8Array()).ranch_reward_available, false, '官方登录时推送空包 = 全部无');
});

test('牧场：默认开；只开图鉴领取时到期才算有活，领过后 30 分钟内不进场；红点 ranch 提前', async () => {
    ranch.resetFnosRanchRuntime();
    assert.equal(store.getConfigSnapshot('7').fnosRanch.illustratedAutoClaim, true);
    const now = Date.now();
    assert.equal(ranch.hasForkWork(now), true);
    calls.length = 0;
    assert.equal(await ranch.runBook(now), false, '没有可领时不调用领取');
    assert.deepEqual(calls, []);
    assert.equal(ranch.hasForkWork(now + 60_000), false);
    assert.equal(ranch.hasForkWork(now + 30 * 60_000), true);
    assert.equal(auto.onIllustratedRewardRedDot({ ranch_reward_available: true }).ranch, true);
    assert.equal(ranch.hasForkWork(now + 60_000), true);
});

test('牧场：普通图鉴 + 巨大图鉴可领时各领一次，日志写明物品，归牧场日志', async () => {
    ranch.resetFnosRanchRuntime();
    book.normal = { canClaim: true, rewards: [{ id: 1002, count: '200' }] };
    book.giant = { levels: [{ id: 1, canClaim: true }, { id: 2, canClaim: true }, { id: 3, canClaim: false }] };
    calls.length = 0; logs.length = 0;
    assert.equal(await ranch.runBook(Date.now()), true);
    assert.deepEqual(calls, ['claimIllustrated:normal', 'claimIllustrated:giant']);
    assert.ok(logs.includes('牧场|牧场图鉴奖励已领取：点券 ×200'), logs.join('\n'));
    assert.ok(logs.includes('牧场|巨大图鉴奖励已领取（2 级）：点券 ×600、道具 ×10'), logs.join('\n'));
    // 关掉开关不领
    apply({ fnosRanch: { illustratedAutoClaim: false } });
    ranch.resetFnosRanchRuntime(); calls.length = 0;
    await ranch.runBook(Date.now());
    assert.deepEqual(calls, []);
    assert.equal(ranch.markBookDue(), false);
    apply({ fnosRanch: { illustratedAutoClaim: true } });
});
