export {};
/**
 * [fnos-fork] 奶茶活动：收益每小时自动领取、兑换商店每天兑换「森野黄金芽种子」（本 fork 新增，上游没有）
 *
 * 只复用上游已实现并核对过的协议（services/milk-tea.ts、proto/milk-tea.proto）：
 * - 领取收益：ActivityService.Operate，活动 2026110101，操作号 59 milk_tea_claim_cashier
 *   （MilkTeaClaimCashierReq 为空，MilkTeaClaimCashierRsp.items 为获得物品）；
 *   可领数量来自操作号 55 milk_tea_get_shop 的 shop.pending_rewards。
 * - 兑换：ActivityService.Operate，活动 2026110102，操作号 1 shop_buy（ShopBuyReq goods_id/count，
 *   ShopBuyRsp awards/costs）；商品列表来自 ActivityService.GetGroup 中兑换商店的 ShopGoodsInfo
 *   （name、item、cost、purchase_limit、purchased_count、cond_hints）。
 * - 商品不硬编码 id：按商品名或奖励物品名（官方 ItemInfo 表）等于「森野黄金芽种子」匹配。
 * - 限购：purchase_limit > 0 时剩余 = purchase_limit - purchased_count（与上游兑换页一致）；剩余 0 视为今日已兑换/售罄。
 *
 * 真正的请求都经 milkTea.operateMilkTeaActivity 发出：上游在提交前会重新读取活动、核验费用、余额、限购和条件，
 * 且所有消耗操作串行。本文件只决定“何时做、做多少”，并写中文日志。
 *
 * [fnos-fork] 2026-10-30 需求 27：森野种子自动兑换（最大数量）
 * - 同一个接口（活动 2026110102 操作号 1 shop_buy），在原「每日兑换森野黄金芽种子」上扩展：可勾选 8 种森野种子
 *   （FNOS_EXCHANGE_SEEDS，物品 id 取自官方 ItemInfo.json），按用户排好的顺序依次兑换。
 * - 数量一律按「最大」：min(剩余限购, 当前货币买得起的数量, 9999 − 背包已有)；没有限购时也按货币买满
 *   （上游 shop_buy 单次最多 9999，物品表 max_own 9999）。价格、币种以服务端 ShopGoodsInfo.cost 为准，不硬编码；
 *   多个勾选共用同一种货币时按顺序扣减预算，排在后面的可能只换到一部分或换不到，余额不会为负。
 * - 旧配置（只有 autoExchangeSeed）迁移：列表缺省时只勾森野黄金芽种子，原来开着的账号行为不变，只是数量改为最大。
 * - 频率不变：每天（北京时间）一次；读取/提交失败 1 小时后重试。
 */

const SEED_NAME = '森野黄金芽种子';
const CLAIM_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 5 * 1000;
const FAIL_RETRY_MS = 60 * 60 * 1000;

/** [fnos-fork] 需求 27：可自动兑换的 8 种森野种子（默认顺序按用户给定；id 来自 gameConfig/ItemInfo.json，type 5 种子） */
const FNOS_EXCHANGE_SEEDS: ReadonlyArray<{ id: number; name: string }> = [
    { id: 20529, name: '森野芭乐种子' },
    { id: 29005, name: '森野黄金芽种子' },
    { id: 21435, name: '森野柿子种子' },
    { id: 20021, name: '森野可可豆种子' },
    { id: 20528, name: '森野红柚种子' },
    { id: 20527, name: '森野甜橙种子' },
    { id: 20526, name: '森野白桃种子' },
    { id: 20525, name: '森野甜莓种子' },
];
const GOLDEN_SEED_ID = 29005;
const MAX_BUY_COUNT = 9999; // 上游 shop_buy 单次上限
const MAX_OWN = 9999; // 物品表 max_own

export interface FnosSeedExchangeEntry { id: number; enabled: boolean }

export interface FnosMilkTeaDailyConfig {
    /** 奶茶收益每小时自动领取 */
    autoClaim: boolean;
    /** 兑换商店每天自动兑换勾选的森野种子（2026-10-30 起按最大数量；字段名沿用旧版） */
    autoExchangeSeed: boolean;
    /** [fnos-fork] 需求 27：8 种森野种子的兑换顺序与是否勾选（总是 8 项） */
    seedExchange: FnosSeedExchangeEntry[];
}

function defaultSeedExchange(): FnosSeedExchangeEntry[] {
    return FNOS_EXCHANGE_SEEDS.map(v => ({ id: v.id, enabled: v.id === GOLDEN_SEED_ID }));
}

const DEFAULT_FNOS_MILK_TEA_DAILY: FnosMilkTeaDailyConfig = { autoClaim: false, autoExchangeSeed: false, seedExchange: defaultSeedExchange() };

/** 规整种子列表：只保留 8 种已知种子、去重、保持给定顺序，缺的按默认顺序补在后面（不勾选）。 */
function normalizeSeedExchange(input: unknown, fallback?: FnosSeedExchangeEntry[]): FnosSeedExchangeEntry[] {
    if (!Array.isArray(input)) return Array.isArray(fallback) ? normalizeSeedExchange(fallback) : defaultSeedExchange();
    const known = new Set(FNOS_EXCHANGE_SEEDS.map(v => v.id));
    const out: FnosSeedExchangeEntry[] = [];
    for (const row of input) {
        const id = Number(row && typeof row === 'object' ? (row as any).id : row);
        if (!known.has(id) || out.some(v => v.id === id)) continue;
        out.push({ id, enabled: row && typeof row === 'object' ? !!(row as any).enabled : true });
    }
    for (const v of FNOS_EXCHANGE_SEEDS) if (!out.some(o => o.id === v.id)) out.push({ id: v.id, enabled: false });
    return out;
}

function normalizeFnosMilkTeaDaily(input: unknown, fallback: Partial<FnosMilkTeaDailyConfig> = DEFAULT_FNOS_MILK_TEA_DAILY): FnosMilkTeaDailyConfig {
    const base = { ...DEFAULT_FNOS_MILK_TEA_DAILY, ...(fallback || {}) };
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { autoClaim: !!base.autoClaim, autoExchangeSeed: !!base.autoExchangeSeed, seedExchange: normalizeSeedExchange(base.seedExchange) };
    }
    const src = input as Record<string, any>;
    return {
        autoClaim: src.autoClaim !== undefined ? !!src.autoClaim : !!base.autoClaim,
        autoExchangeSeed: src.autoExchangeSeed !== undefined ? !!src.autoExchangeSeed : !!base.autoExchangeSeed,
        seedExchange: normalizeSeedExchange(src.seedExchange, base.seedExchange),
    };
}

function seedInfo(id: number): { id: number; name: string } {
    return FNOS_EXCHANGE_SEEDS.find(v => v.id === id) || { id, name: `物品 #${id}` };
}

function num(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    return Number(value) || 0;
}

/** 北京时间日期键（按服务器时间）。 */
function beijingDayKey(sec: number): string {
    const d = new Date((sec + 8 * 3600) * 1000);
    return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

function describeItems(list: any[]): string {
    const parts = (Array.isArray(list) ? list : []).filter(v => num(v.count) > 0).map(v => `${v.name || `物品 #${v.id}`}×${num(v.count)}`);
    return parts.length ? parts.join('、') : '（回包未列出物品）';
}

/** 在兑换商店商品里找某种种子（奖励物品 id、商品名或奖励物品名匹配，不依赖商品 id）。默认找森野黄金芽种子。 */
function findSeedGoods(goods: any[], seed: { id: number; name: string } = seedInfo(GOLDEN_SEED_ID)): any[] {
    return (Array.isArray(goods) ? goods : []).filter(g => String(g?.name || '').trim() === seed.name
        || (Array.isArray(g?.rewards) && g.rewards.some((r: any) => num(r?.id) === seed.id || String(r?.name || '').trim() === seed.name)));
}

/**
 * 决定某种种子的兑换数量（纯函数）：按最大数量 = min(剩余限购, 货币买得起, 9999 − 已有)。
 * remaining 为 null 表示无限购（只受货币和持有上限限制）。balances 不会被修改。
 * 返回 { goods, count, partial } 或 { skip, kind }。
 */
function planSeedExchange(goodsList: any[], balances: Record<string, number>, seed: { id: number; name: string } = seedInfo(GOLDEN_SEED_ID)): { goods: any; count: number; partial: boolean } | { skip: string; kind: string } {
    const name = seed.name;
    const matches = findSeedGoods(goodsList, seed);
    if (!matches.length) return { skip: `兑换商店里没有找到「${name}」`, kind: 'missing' };
    const open = matches.filter(g => g.remaining !== 0);
    if (!open.length) return { skip: `今日「${name}」已兑换或已售罄`, kind: 'done' };
    const goods = open.find(g => g.available) || open[0];
    if (!goods.available) {
        const unmet = (goods.conditions || []).filter((c: any) => !c.satisfied).map((c: any) => `${c.type} ${c.current}/${c.target}`);
        return { skip: `「${name}」当前不可兑换${unmet.length ? `（条件未满足：${unmet.join('，')}）` : '（结算期或条件未满足）'}`, kind: 'unavailable' };
    }
    const perGoods = Math.max(1, ...((goods.rewards || []).filter((r: any) => num(r?.id) === seed.id || String(r?.name || '').trim() === name).map((r: any) => num(r.count))), 1);
    const ownRoom = Math.floor(Math.max(0, MAX_OWN - (balances[String(seed.id)] || 0)) / perGoods);
    const limit = goods.remaining === null ? MAX_BUY_COUNT : Math.max(0, num(goods.remaining));
    const want = Math.min(limit, MAX_BUY_COUNT, ownRoom);
    if (want <= 0) return { skip: `背包里「${name}」已达持有上限 ${MAX_OWN}`, kind: 'full' };
    let afford = want;
    for (const cost of goods.costs || []) {
        const each = num(cost.count);
        if (each <= 0) continue;
        afford = Math.min(afford, Math.floor(Math.max(0, balances[String(cost.id)] || 0) / each));
    }
    if (afford <= 0) {
        const need = (goods.costs || []).map((c: any) => `${c.name || `物品 #${c.id}`} ${num(c.count)}（现有 ${Math.max(0, balances[String(c.id)] || 0)}）`).join('、');
        return { skip: `兑换「${name}」货币不足：每个需要 ${need}`, kind: 'poor' };
    }
    // 无限购时「买满货币」不算部分兑换
    return { goods, count: afford, partial: goods.remaining !== null && afford < want };
}

/**
 * 按勾选顺序为多种种子做兑换计划（纯函数）：共用的货币按顺序扣减，后面的种子用剩下的预算。
 * 返回每种种子一项：{ seed, plan }。
 */
function planSeedExchanges(goodsList: any[], balances: Record<string, number>, entries: FnosSeedExchangeEntry[]) {
    const budget: Record<string, number> = { ...(balances || {}) };
    const out: Array<{ seed: { id: number; name: string }; plan: ReturnType<typeof planSeedExchange> }> = [];
    for (const entry of normalizeSeedExchange(entries)) {
        if (!entry.enabled) continue;
        const seed = seedInfo(entry.id);
        const plan = planSeedExchange(goodsList, budget, seed);
        if (!('skip' in plan)) {
            for (const cost of plan.goods.costs || []) budget[String(cost.id)] = (budget[String(cost.id)] || 0) - num(cost.count) * plan.count;
        }
        out.push({ seed, plan });
    }
    return out;
}

// ============ 运行时（worker 内，每个账号一个进程） ============

let claimNextAtMs = 0;
let exchangeDoneDay = '';
let exchangeRetryAtMs = 0;
const lastLog: Record<string, string> = {};

function resetFnosMilkTeaDailyRuntime(): void {
    claimNextAtMs = 0;
    exchangeDoneDay = '';
    exchangeRetryAtMs = 0;
    for (const k of Object.keys(lastLog)) delete lastLog[k];
}

function readConfig(): FnosMilkTeaDailyConfig {
    // 统一经 store.getConfigSnapshot() 读取（见 services/fnos-fork-config.ts）
    return require('./fnos-fork-config').readFnosForkConfigs().daily;
}

/** 同一条跳过原因只记一次（直到原因变化或设置变更），避免每小时刷屏。 */
function logOnce(channel: string, tag: string, message: string, meta: any): void {
    if (lastLog[channel] === message) return;
    lastLog[channel] = message;
    require('../utils/utils').log(tag, message, meta);
}

async function runClaim(milkTea: any, nowMs: number): Promise<boolean> {
    const { log, logWarn } = require('../utils/utils');
    const meta = { module: 'activity', event: '奶茶收益领取' };
    claimNextAtMs = nowMs + CLAIM_INTERVAL_MS;
    let state: any;
    try {
        // 'upgrade' 页只读店铺（操作号 55），不额外读工坊
        state = await milkTea.getMilkTeaActivity('upgrade');
    } catch (e: any) {
        logOnce('claim', '奶茶收益', `奶茶收益领取跳过：读取奶茶店失败（${e.message}），1 小时后再试`, { ...meta, result: 'error' });
        return false;
    }
    if (!state?.active) { logOnce('claim', '奶茶收益', '奶茶收益领取跳过：奶茶活动未开放或已结束', { ...meta, result: 'skip' }); return false; }
    if (!num(state.summary?.shop_open_at) || !state.shop) { logOnce('claim', '奶茶收益', '奶茶收益领取跳过：奶茶店尚未开业', { ...meta, result: 'skip' }); return false; }
    const pending = (state.shop.pending_rewards || []).filter((v: any) => num(v.count) > 0);
    if (!pending.length) { logOnce('claim', '奶茶收益', '奶茶收益领取跳过：暂无可领取收益', { ...meta, result: 'skip' }); return false; }
    try {
        const res = await milkTea.operateMilkTeaActivity('claim', {});
        const got = res?.rewards && res.rewards.length ? res.rewards : pending;
        lastLog.claim = '';
        log('奶茶收益', `奶茶收益已领取：${describeItems(got)}`, { ...meta, result: 'ok' });
        return true;
    } catch (e: any) {
        logWarn('奶茶收益', `奶茶收益领取失败：${e.message}，1 小时后再试`, { ...meta, result: 'error' });
        return false;
    }
}

async function runExchange(milkTea: any, nowMs: number, serverSec: number, entries: FnosSeedExchangeEntry[]): Promise<boolean> {
    const { log, logWarn } = require('../utils/utils');
    const meta = { module: 'activity', event: '奶茶兑换种子' };
    const today = beijingDayKey(serverSec);
    if (exchangeDoneDay === today) return false;
    if (exchangeRetryAtMs > nowMs) return false;
    const selected = normalizeSeedExchange(entries).filter(v => v.enabled);
    if (!selected.length) {
        exchangeDoneDay = today;
        logOnce('exchange', '奶茶兑换', '森野种子兑换跳过：没有勾选要兑换的种子', { ...meta, result: 'skip' });
        return false;
    }
    let state: any;
    try {
        state = await milkTea.getMilkTeaActivity('exchange');
    } catch (e: any) {
        exchangeRetryAtMs = nowMs + FAIL_RETRY_MS;
        logOnce('exchange', '奶茶兑换', `森野种子兑换跳过：读取兑换商店失败（${e.message}），1 小时后再试`, { ...meta, result: 'error' });
        return false;
    }
    if (!state?.active) {
        exchangeDoneDay = today;
        logOnce('exchange', '奶茶兑换', '森野种子兑换跳过：奶茶活动未开放或已结束', { ...meta, result: 'skip' });
        return false;
    }
    const plans = planSeedExchanges(state.goods, state.balances || {}, selected);
    let exchanged = false;
    let failed = false;
    for (const { seed, plan } of plans) {
        const channel = `exchange:${seed.id}`;
        if ('skip' in plan) {
            // 已兑换/售罄/货币不足/不可兑换/找不到：今天不再尝试，明天再看
            logOnce(channel, '奶茶兑换', `${seed.name}兑换跳过：${plan.skip}`, { ...meta, result: 'skip', kind: plan.kind, seedId: seed.id });
            continue;
        }
        const { goods, count, partial } = plan;
        try {
            const res = await milkTea.operateMilkTeaActivity('exchange', {
                goodsId: goods.id,
                count,
                expectedCosts: (goods.costs || []).map((c: any) => ({ id: num(c.id), count: num(c.count) })),
            });
            exchanged = true;
            lastLog[channel] = '';
            const costText = (goods.costs || []).map((c: any) => `${c.name || `物品 #${c.id}`}×${num(c.count) * count}`).join('、');
            const got = res?.rewards && res.rewards.length ? describeItems(res.rewards) : `${seed.name}×${count}`;
            log('奶茶兑换', `${seed.name}已兑换：${got}，花费 ${costText || '（无）'}${partial ? '（货币只够兑换部分，剩余今日不再尝试）' : ''}`, {
                ...meta, result: 'ok', goodsId: goods.id, count, seedId: seed.id,
            });
        } catch (e: any) {
            // 上游在提交前会复核限购/余额，失败可能是状态刚变化；1 小时后再试一次，失败日志同样只记一次
            failed = true;
            const message = `${seed.name}兑换失败：${e.message}，1 小时后再试`;
            if (lastLog[channel] !== message) { lastLog[channel] = message; logWarn('奶茶兑换', message, { ...meta, result: 'error', seedId: seed.id }); }
        }
    }
    if (failed) exchangeRetryAtMs = nowMs + FAIL_RETRY_MS;
    else exchangeDoneDay = today;
    return exchanged;
}

/** 一轮：按设置领取收益、兑换种子。返回 { claimed, exchanged }。 */
async function runMilkTeaDailyTick(options: { force?: boolean; milkTea?: any; nowMs?: number; serverSec?: number } = {}) {
    const cfg = readConfig();
    const result = { claimed: false, exchanged: false };
    if (!cfg.autoClaim && !cfg.autoExchangeSeed) return result;
    const nowMs = options.nowMs || Date.now();
    const milkTea = options.milkTea || require('./milk-tea');
    const serverSec = options.serverSec || require('../utils/utils').getServerTimeSec();
    if (cfg.autoClaim && (options.force || claimNextAtMs <= nowMs)) result.claimed = await runClaim(milkTea, nowMs);
    if (cfg.autoExchangeSeed) result.exchanged = await runExchange(milkTea, nowMs, serverSec, cfg.seedExchange);
    return result;
}

let activeScheduler: any = null;
let activeTick: (() => Promise<any>) | null = null;
let lastTickErrorLogAt = 0;

/** 登录完成后由 worker 调用；任务挂在 workerScheduler 上，停号时随 clearAll 清理。 */
function startFnosMilkTeaDaily(scheduler: any, runExclusive: (name: string, fn: () => Promise<any>) => Promise<any>): void {
    resetFnosMilkTeaDailyRuntime();
    const tick = () => runExclusive('fnos_milk_tea_daily', () => runMilkTeaDailyTick()).catch((e: any) => {
        if (Date.now() - lastTickErrorLogAt > 30 * 60 * 1000) {
            lastTickErrorLogAt = Date.now();
            try { require('../utils/utils').logWarn('奶茶收益', `奶茶收益/兑换检查出错：${e && e.message ? e.message : e}`, { module: 'activity', event: '奶茶收益领取', result: 'error' }); } catch { /* ignore */ }
        }
        return null;
    });
    activeScheduler = scheduler;
    activeTick = tick;
    scheduler.setTimeoutTask('fnos_milk_tea_daily_first', FIRST_TICK_DELAY_MS, tick);
    scheduler.setIntervalTask('fnos_milk_tea_daily', CLAIM_INTERVAL_MS, tick);
}

/** 保存设置后：清掉今日标记与退避，约 5 秒后跑一次。 */
function onFnosMilkTeaDailyConfigChanged(): void {
    claimNextAtMs = 0;
    exchangeDoneDay = '';
    exchangeRetryAtMs = 0;
    for (const k of Object.keys(lastLog)) delete lastLog[k];
    if (activeScheduler && activeTick) {
        try { activeScheduler.setTimeoutTask('fnos_milk_tea_daily_first', FIRST_TICK_DELAY_MS, activeTick); } catch { /* ignore */ }
    }
}

module.exports = {
    SEED_NAME,
    FNOS_EXCHANGE_SEEDS,
    DEFAULT_FNOS_MILK_TEA_DAILY,
    normalizeFnosMilkTeaDaily,
    normalizeSeedExchange,
    findSeedGoods,
    planSeedExchange,
    planSeedExchanges,
    beijingDayKey,
    runMilkTeaDailyTick,
    startFnosMilkTeaDaily,
    onFnosMilkTeaDailyConfigChanged,
    resetFnosMilkTeaDailyRuntime,
};
