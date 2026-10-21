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
 */

const SEED_NAME = '森野黄金芽种子';
const CLAIM_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 5 * 1000;
const FAIL_RETRY_MS = 60 * 60 * 1000;

export interface FnosMilkTeaDailyConfig {
    /** 奶茶收益每小时自动领取 */
    autoClaim: boolean;
    /** 兑换商店每天兑换森野黄金芽种子 */
    autoExchangeSeed: boolean;
}

const DEFAULT_FNOS_MILK_TEA_DAILY: FnosMilkTeaDailyConfig = { autoClaim: false, autoExchangeSeed: false };

function normalizeFnosMilkTeaDaily(input: unknown, fallback: FnosMilkTeaDailyConfig = DEFAULT_FNOS_MILK_TEA_DAILY): FnosMilkTeaDailyConfig {
    const base = { ...DEFAULT_FNOS_MILK_TEA_DAILY, ...(fallback || {}) };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { autoClaim: !!base.autoClaim, autoExchangeSeed: !!base.autoExchangeSeed };
    const src = input as Record<string, any>;
    return {
        autoClaim: src.autoClaim !== undefined ? !!src.autoClaim : !!base.autoClaim,
        autoExchangeSeed: src.autoExchangeSeed !== undefined ? !!src.autoExchangeSeed : !!base.autoExchangeSeed,
    };
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

/** 在兑换商店商品里找森野黄金芽种子（商品名或奖励物品名匹配，不依赖固定 id）。 */
function findSeedGoods(goods: any[]): any[] {
    return (Array.isArray(goods) ? goods : []).filter(g => String(g?.name || '').trim() === SEED_NAME
        || (Array.isArray(g?.rewards) && g.rewards.some((r: any) => String(r?.name || '').trim() === SEED_NAME)));
}

/**
 * 决定兑换数量（纯函数）。remaining 为 null 表示无限购 → 每天只兑 1 个。
 * 返回 { count, costs } 或 { skip, reason }。
 */
function planSeedExchange(goodsList: any[], balances: Record<string, number>): { goods: any; count: number; partial: boolean } | { skip: string; kind: string } {
    const matches = findSeedGoods(goodsList);
    if (!matches.length) return { skip: `兑换商店里没有找到「${SEED_NAME}」`, kind: 'missing' };
    const open = matches.filter(g => g.remaining !== 0);
    if (!open.length) return { skip: `今日「${SEED_NAME}」已兑换或已售罄`, kind: 'done' };
    const goods = open.find(g => g.available) || open[0];
    if (!goods.available) {
        const unmet = (goods.conditions || []).filter((c: any) => !c.satisfied).map((c: any) => `${c.type} ${c.current}/${c.target}`);
        return { skip: `「${SEED_NAME}」当前不可兑换${unmet.length ? `（条件未满足：${unmet.join('，')}）` : '（结算期或条件未满足）'}`, kind: 'unavailable' };
    }
    const want = goods.remaining === null ? 1 : Math.max(0, num(goods.remaining));
    let afford = want;
    for (const cost of goods.costs || []) {
        const each = num(cost.count);
        if (each <= 0) continue;
        afford = Math.min(afford, Math.floor((balances[String(cost.id)] || 0) / each));
    }
    if (afford <= 0) {
        const need = (goods.costs || []).map((c: any) => `${c.name || `物品 #${c.id}`} ${num(c.count)}（现有 ${balances[String(c.id)] || 0}）`).join('、');
        return { skip: `兑换「${SEED_NAME}」货币不足：每个需要 ${need}`, kind: 'poor' };
    }
    return { goods, count: afford, partial: afford < want };
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

async function runExchange(milkTea: any, nowMs: number, serverSec: number): Promise<boolean> {
    const { log, logWarn } = require('../utils/utils');
    const meta = { module: 'activity', event: '奶茶兑换种子' };
    const today = beijingDayKey(serverSec);
    if (exchangeDoneDay === today) return false;
    if (exchangeRetryAtMs > nowMs) return false;
    let state: any;
    try {
        state = await milkTea.getMilkTeaActivity('exchange');
    } catch (e: any) {
        exchangeRetryAtMs = nowMs + FAIL_RETRY_MS;
        logOnce('exchange', '奶茶兑换', `森野黄金芽种子兑换跳过：读取兑换商店失败（${e.message}），1 小时后再试`, { ...meta, result: 'error' });
        return false;
    }
    if (!state?.active) {
        exchangeDoneDay = today;
        logOnce('exchange', '奶茶兑换', '森野黄金芽种子兑换跳过：奶茶活动未开放或已结束', { ...meta, result: 'skip' });
        return false;
    }
    const plan = planSeedExchange(state.goods, state.balances || {});
    if ('skip' in plan) {
        // 已兑换/售罄/货币不足/不可兑换/找不到：今天不再尝试，明天再看
        exchangeDoneDay = today;
        logOnce('exchange', '奶茶兑换', `森野黄金芽种子兑换跳过：${plan.skip}`, { ...meta, result: 'skip', kind: plan.kind });
        return false;
    }
    const { goods, count, partial } = plan;
    try {
        const res = await milkTea.operateMilkTeaActivity('exchange', {
            goodsId: goods.id,
            count,
            expectedCosts: (goods.costs || []).map((c: any) => ({ id: num(c.id), count: num(c.count) })),
        });
        exchangeDoneDay = today;
        lastLog.exchange = '';
        const costText = (goods.costs || []).map((c: any) => `${c.name || `物品 #${c.id}`}×${num(c.count) * count}`).join('、');
        const got = res?.rewards && res.rewards.length ? describeItems(res.rewards) : `${SEED_NAME}×${count}`;
        log('奶茶兑换', `森野黄金芽种子已兑换：${got}，花费 ${costText || '（无）'}${partial ? '（货币只够兑换部分，剩余今日不再尝试）' : ''}`, {
            ...meta, result: 'ok', goodsId: goods.id, count,
        });
        return true;
    } catch (e: any) {
        // 上游在提交前会复核限购/余额，失败可能是状态刚变化；1 小时后再试一次，失败日志同样只记一次
        exchangeRetryAtMs = nowMs + FAIL_RETRY_MS;
        const message = `森野黄金芽种子兑换失败：${e.message}，1 小时后再试`;
        if (lastLog.exchange !== message) { lastLog.exchange = message; logWarn('奶茶兑换', message, { ...meta, result: 'error' }); }
        return false;
    }
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
    if (cfg.autoExchangeSeed) result.exchanged = await runExchange(milkTea, nowMs, serverSec);
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
    DEFAULT_FNOS_MILK_TEA_DAILY,
    normalizeFnosMilkTeaDaily,
    findSeedGoods,
    planSeedExchange,
    beijingDayKey,
    runMilkTeaDailyTick,
    startFnosMilkTeaDaily,
    onFnosMilkTeaDailyConfigChanged,
    resetFnosMilkTeaDailyRuntime,
};
