import milkTeaConfig from '../activity-data/milk-tea-20261015.json';

export {};
/**
 * [fnos-fork] 奶茶活动：自动制作奶茶、自动领取工资（本 fork 新增，上游没有；2026-10-28）
 *
 * 只复用上游已实现并核对过的协议（services/milk-tea.ts、proto/milk-tea.proto，官方 1.15.1.4_20261001 编码器）：
 * - 制作奶茶：ActivityService.Operate，活动 2026110101，操作号 62 milk_tea_craft
 *   （MilkTeaCraftReq.fruit_uids = 背包果实的 uid 列表，每个 uid 整组消耗；
 *   MilkTeaCraftRsp.crafted_cups 为本次做出的杯数 recipe_id → 杯）。
 *   可做的果实来自操作号 58 milk_tea_get_workshop 的 recipes（unlocked）与背包（上游 workshop 页的 fruits，
 *   已排除锁定物品）。制作是即时的：协议里没有「制作位」「制作中」或冷却字段，做出的杯数直接进店里库存。
 *   配方表 activity-data/milk-tea-20261015.json：普通奶茶（recipe 1）不需要果实、不限量，不用做；
 *   金露云酪按配方名识别（消耗森野黄金芽），不硬编码 id。
 * - 领取工资：同活动操作号 64 milk_tea_claim_wages（MilkTeaClaimWagesReq 为空，
 *   MilkTeaClaimWagesRsp items/claimed_count）；可领依据为操作号 63 milk_tea_get_work_page 的
 *   slips[].wage_status === 1（与上游工作页「领取工资」按钮的判断一致）。
 *
 * 真正的请求都经 milkTea.operateMilkTeaActivity 发出：上游在提交前会重新读取活动、核对果实数量/锁定状态、
 * 活动是否开放/结算期，并且所有奶茶操作串行。本文件只决定「何时做、做哪些」，并写中文日志。
 * 检查间隔 10 分钟（与奶茶雇人/工作事项一致）。
 */

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 8 * 1000;
const GOLDEN_RECIPE_NAME = '金露云酪';
const MAX_CRAFT_UIDS = 200; // 上游 craft 接口单次最多 200 组

export interface FnosMilkTeaExtraConfig {
    /** 自动制作奶茶 */
    autoCraft: boolean;
    /** 是否也制作金露云酪（false = 排除金露云酪，只做其他奶茶） */
    craftGoldenCheese: boolean;
    /** 自动领取工资（被雇佣打工的工资） */
    autoClaimWages: boolean;
}

const DEFAULT_FNOS_MILK_TEA_EXTRA: FnosMilkTeaExtraConfig = { autoCraft: false, craftGoldenCheese: false, autoClaimWages: false };

function normalizeFnosMilkTeaExtra(input: unknown, fallback: FnosMilkTeaExtraConfig = DEFAULT_FNOS_MILK_TEA_EXTRA): FnosMilkTeaExtraConfig {
    const base = { ...DEFAULT_FNOS_MILK_TEA_EXTRA, ...(fallback || {}) };
    const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, any> : {};
    const pick = (key: keyof FnosMilkTeaExtraConfig) => (src[key] !== undefined ? !!src[key] : !!base[key]);
    return { autoCraft: pick('autoCraft'), craftGoldenCheese: pick('craftGoldenCheese'), autoClaimWages: pick('autoClaimWages') };
}

function num(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    return Number(value) || 0;
}

function describeItems(list: any[]): string {
    const parts = (Array.isArray(list) ? list : []).filter(v => num(v.count) > 0).map(v => `${v.name || `物品 #${v.id}`}×${num(v.count)}`);
    return parts.length ? parts.join('、') : '（回包未列出物品）';
}

/** 金露云酪对应的果实 id（按配方名从活动配置读取）。 */
function goldenFruitIds(recipes: any[]): Set<number> {
    const ids = new Set<number>();
    for (const r of Array.isArray(recipes) ? recipes : []) {
        if (String(r?.recipe_name || '').trim() === GOLDEN_RECIPE_NAME && num(r?.fruitId) > 0) ids.add(num(r.fruitId));
    }
    // 同时按本地活动配置的配方名补充（服务端配方名为空或有差异时仍能识别）
    for (const row of milkTeaConfig.MilkTeaRecipeConfig || []) {
        if (String(row.recipe_name).trim() === GOLDEN_RECIPE_NAME) ids.add(Number(String(row.fruit_item_id).split(':')[0]) || 0);
    }
    for (const r of Array.isArray(recipes) ? recipes : []) {
        const row = (milkTeaConfig.MilkTeaRecipeConfig || []).find((v: any) => String(v.recipe_id) === String(num(r?.recipe_id)));
        if (row && String(row.recipe_name).trim() === GOLDEN_RECIPE_NAME && num(r?.fruitId) > 0) ids.add(num(r.fruitId));
    }
    ids.delete(0);
    return ids;
}

/**
 * 决定这一轮制作哪些果实（纯函数，输入为上游 getMilkTeaActivity('workshop') 的结果）。
 * 返回 { fruits:[{uid,count}], text } 或 { skip, kind }。
 */
function planCraft(state: any, craftGoldenCheese: boolean): { fruits: Array<{ uid: string; count: number }>; text: string; excludedGolden: number } | { skip: string; kind: string } {
    if (!state?.active) return { skip: '奶茶活动未开放或已结束', kind: 'inactive' };
    if (!num(state.summary?.shop_open_at)) return { skip: '奶茶店尚未开业', kind: 'closed' };
    if (state.settling || state.shop?.is_settling) return { skip: '结算期不可制作', kind: 'settling' };
    const recipes: any[] = Array.isArray(state.recipes) ? state.recipes : [];
    const unlocked = recipes.filter(r => r && r.unlocked && num(r.fruitId) > 0);
    if (!unlocked.length) return { skip: '没有已解锁且需要果实的配方', kind: 'no_recipe' };
    const golden = goldenFruitIds(recipes);
    const byFruit = new Map<number, any>(unlocked.map(r => [num(r.fruitId), r]));
    const picked: Array<{ uid: string; count: number; id: number; name: string }> = [];
    let excludedGolden = 0;
    for (const fruit of Array.isArray(state.fruits) ? state.fruits : []) {
        const id = num(fruit?.id);
        const count = num(fruit?.count);
        if (!byFruit.has(id) || count <= 0 || fruit.locked || !fruit.uid) continue;
        if (!craftGoldenCheese && golden.has(id)) { excludedGolden += count; continue; }
        picked.push({ uid: String(fruit.uid), count, id, name: String(fruit.name || `物品 #${id}`) });
    }
    if (!picked.length) {
        return { skip: excludedGolden > 0 ? `只有森野黄金芽（金露云酪已设为不制作，共 ${excludedGolden} 个）` : '背包里没有可制作奶茶的果实', kind: 'empty' };
    }
    const chosen = picked.slice(0, MAX_CRAFT_UIDS);
    const totals = new Map<string, number>();
    for (const f of chosen) {
        const recipe = byFruit.get(f.id);
        const key = `${recipe?.recipe_name || '奶茶'}（${f.name}）`;
        totals.set(key, (totals.get(key) || 0) + f.count);
    }
    const text = [...totals.entries()].map(([k, v]) => `${k}×${v}`).join('、');
    return { fruits: chosen.map(f => ({ uid: f.uid, count: f.count })), text, excludedGolden };
}

/** 是否有可领取工资（纯函数，输入为上游 getMilkTeaActivity('work') 的结果）。 */
function claimableWageSlips(state: any): any[] {
    return (Array.isArray(state?.work?.slips) ? state.work.slips : []).filter((v: any) => num(v?.wage_status) === 1);
}

// ============ 运行时（worker 内，每个账号一个进程） ============

const lastLog: Record<string, string> = {};

function resetFnosMilkTeaExtraRuntime(): void {
    for (const k of Object.keys(lastLog)) delete lastLog[k];
}

function readConfig(): FnosMilkTeaExtraConfig {
    return require('./fnos-fork-config').readFnosForkConfigs().extra;
}

function logOnce(channel: string, tag: string, message: string, meta: any, warn = false): void {
    if (lastLog[channel] === message) return;
    lastLog[channel] = message;
    const u = require('../utils/utils');
    (warn ? u.logWarn : u.log)(tag, message, meta);
}

async function runCraft(milkTea: any, cfg: FnosMilkTeaExtraConfig): Promise<boolean> {
    const { log } = require('../utils/utils');
    const meta = { module: 'activity', event: '奶茶自动制作' };
    let state: any;
    try {
        state = await milkTea.getMilkTeaActivity('workshop');
    } catch (e: any) {
        logOnce('craft', '奶茶制作', `奶茶自动制作跳过：读取奶茶工坊失败（${e.message}），10 分钟后再试`, { ...meta, result: 'error' }, true);
        return false;
    }
    const plan = planCraft(state, cfg.craftGoldenCheese);
    if ('skip' in plan) {
        logOnce('craft', '奶茶制作', `奶茶自动制作跳过：${plan.skip}`, { ...meta, result: 'skip', kind: plan.kind });
        return false;
    }
    try {
        const res = await milkTea.operateMilkTeaActivity('craft', { fruits: plan.fruits });
        const cups = res?.result?.crafted_cups || {};
        const recipes: any[] = state.recipes || [];
        const made = Object.entries(cups).filter(([, v]) => num(v) > 0)
            .map(([id, v]) => `${recipes.find(r => String(num(r.recipe_id)) === String(id))?.recipe_name || `配方 #${id}`}×${num(v)} 杯`);
        lastLog.craft = '';
        log('奶茶制作', `奶茶已自动制作：消耗 ${plan.text}${made.length ? `，做出 ${made.join('、')}` : ''}${plan.excludedGolden > 0 ? `（森野黄金芽 ${plan.excludedGolden} 个按设置不做金露云酪）` : ''}`, {
            ...meta, result: 'ok', fruits: plan.fruits.length,
        });
        return true;
    } catch (e: any) {
        logOnce('craft', '奶茶制作', `奶茶自动制作失败：${e.message}，10 分钟后再试`, { ...meta, result: 'error' }, true);
        return false;
    }
}

async function runWages(milkTea: any): Promise<boolean> {
    const { log } = require('../utils/utils');
    const meta = { module: 'activity', event: '奶茶工资领取' };
    let state: any;
    try {
        state = await milkTea.getMilkTeaActivity('work');
    } catch (e: any) {
        logOnce('wages', '奶茶工资', `奶茶工资领取跳过：读取「我的工作」失败（${e.message}），10 分钟后再试`, { ...meta, result: 'error' }, true);
        return false;
    }
    if (!state?.active) { logOnce('wages', '奶茶工资', '奶茶工资领取跳过：奶茶活动未开放或已结束', { ...meta, result: 'skip' }); return false; }
    if (!num(state.summary?.shop_open_at) || !state.work) {
        logOnce('wages', '奶茶工资', '奶茶工资领取跳过：本账号奶茶店尚未开业（游戏需开业后才能进入「我的工作」）', { ...meta, result: 'skip' });
        return false;
    }
    const slips = claimableWageSlips(state);
    if (!slips.length) { logOnce('wages', '奶茶工资', '奶茶工资领取跳过：暂无可领取工资', { ...meta, result: 'skip' }); return false; }
    try {
        const res = await milkTea.operateMilkTeaActivity('wages', {});
        const count = num(res?.result?.claimed_count) || slips.length;
        lastLog.wages = '';
        log('奶茶工资', `奶茶工资已领取 ${count} 笔：${describeItems(res?.rewards || [])}`, { ...meta, result: 'ok', count });
        return true;
    } catch (e: any) {
        logOnce('wages', '奶茶工资', `奶茶工资领取失败：${e.message}，10 分钟后再试`, { ...meta, result: 'error' }, true);
        return false;
    }
}

/** 一轮：按设置领取工资、制作奶茶。返回 { crafted, wages }。 */
async function runMilkTeaExtraTick(options: { milkTea?: any } = {}) {
    const cfg = readConfig();
    const result = { crafted: false, wages: false };
    if (!cfg.autoCraft && !cfg.autoClaimWages) return result;
    const milkTea = options.milkTea || require('./milk-tea');
    if (cfg.autoClaimWages) result.wages = await runWages(milkTea);
    if (cfg.autoCraft) result.crafted = await runCraft(milkTea, cfg);
    return result;
}

let activeScheduler: any = null;
let activeTick: (() => Promise<any>) | null = null;
let lastTickErrorLogAt = 0;

function startFnosMilkTeaExtra(scheduler: any, runExclusive: (name: string, fn: () => Promise<any>) => Promise<any>): void {
    resetFnosMilkTeaExtraRuntime();
    const tick = () => runExclusive('fnos_milk_tea_extra', () => runMilkTeaExtraTick()).catch((e: any) => {
        if (Date.now() - lastTickErrorLogAt > 30 * 60 * 1000) {
            lastTickErrorLogAt = Date.now();
            try { require('../utils/utils').logWarn('奶茶制作', `奶茶制作/工资检查出错：${e && e.message ? e.message : e}`, { module: 'activity', event: '奶茶自动制作', result: 'error' }); } catch { /* ignore */ }
        }
        return null;
    });
    activeScheduler = scheduler;
    activeTick = tick;
    scheduler.setTimeoutTask('fnos_milk_tea_extra_first', FIRST_TICK_DELAY_MS, tick);
    scheduler.setIntervalTask('fnos_milk_tea_extra', CHECK_INTERVAL_MS, tick);
}

function onFnosMilkTeaExtraConfigChanged(): void {
    resetFnosMilkTeaExtraRuntime();
    if (activeScheduler && activeTick) {
        try { activeScheduler.setTimeoutTask('fnos_milk_tea_extra_first', FIRST_TICK_DELAY_MS, activeTick); } catch { /* ignore */ }
    }
}

module.exports = {
    CHECK_INTERVAL_MS,
    GOLDEN_RECIPE_NAME,
    DEFAULT_FNOS_MILK_TEA_EXTRA,
    normalizeFnosMilkTeaExtra,
    planCraft,
    claimableWageSlips,
    runMilkTeaExtraTick,
    startFnosMilkTeaExtra,
    onFnosMilkTeaExtraConfigChanged,
    resetFnosMilkTeaExtraRuntime,
};
