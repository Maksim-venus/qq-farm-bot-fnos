export {};
/**
 * [fnos-fork] 奶茶活动：本账号被雇佣（有兼职班次）时自动做「工作事项」（2026.10.21.1，上游没有）
 *
 * 语义（来自上游实现与官方配置）：工作事项是**员工**在「我的工作」页面为**雇主**选择的一次互动，
 * 每个班次 interact_limit 次（官方为 1 次），共五种（MilkTeaInteractionType）：
 *   1 宣传推广（帮老板立即卖出 N 杯，员工得本班工资 20% 奖金）、2 花式摇杯（老板 3 小时奶茶券收益 +10%，员工 30% 奖金）、
 *   3 招牌试饮（老板 2 小时收益 +20%，员工随机得 N 杯高级奶茶）、4 划水摸鱼（40% 得喇叭 / 60% 工资减半）、
 *   5 申请涨薪（60% 工资翻倍 / 40% 工资减半）。
 * 所以要在**被雇佣的账号**（例如被小号雇佣的大号）上开启；雇主一方没有工作事项可做。
 *
 * 协议（services/milk-tea.ts、proto/milk-tea.proto，均为上游已有）：ActivityService.Operate，活动 2026110101，
 *   读取：操作号 63 milk_tea_get_work_page（MilkTeaGetWorkPageRsp：my_shift、interact_done、slips）；
 *   提交：操作号 65 milk_tea_interact（MilkTeaInteractReq{target_gid=雇主 gid, interaction_type}；
 *         MilkTeaInteractRsp{success, items_gained, friend.bonus_amount, ...}）。
 * 真正的请求经上游 operateMilkTeaActivity('interact') 发出：它会再次复核班次 ID、剩余次数、结束时间、结算期与事项数据完整性。
 */

const config = require('../activity-data/milk-tea-20261015.json');

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const FIRST_DELAY_MS = 5 * 1000;
const FAIL_BACKOFF_MS = 30 * 60 * 1000;
const SAFE_TYPES = [1, 2, 3];

function num(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    return Number(value) || 0;
}

function typeName(id: number): string {
    return config.MilkTeaInteractionType.find((v: any) => Number(v.interaction_id) === id)?.name || `事项${id}`;
}

/**
 * 选择本班次要做的工作事项（纯函数）。workType=0 时在 ready 的 1/2/3 中随机；指定类型不可用时不改做别的。
 */
function chooseWorkType(workType: number, interactions: any[], random: () => number = Math.random): { type: number } | { skip: string } {
    const ready = (Array.isArray(interactions) ? interactions : []).filter(v => v && v.ready).map(v => Number(v.interaction_id));
    if (workType > 0) {
        if (!ready.includes(workType)) return { skip: `「${typeName(workType)}」数据不完整（游戏未返回所需预览），本班次不提交` };
        return { type: workType };
    }
    const pool = SAFE_TYPES.filter(t => ready.includes(t));
    if (!pool.length) return { skip: '工作事项数据不完整，本班次不提交' };
    return { type: pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] };
}

/** 本班次能否做工作事项（与上游前端 canInteract 一致）。 */
interface WorkableResult { ok: boolean; shift?: any; reason?: string; nextAtSec?: number }

function workableShift(state: any, nowSec: number): WorkableResult {
    const shift = state?.work?.my_shift;
    if (!shift || num(shift.end_at) <= nowSec) return { ok: false, reason: '当前没有兼职班次（未被雇佣）' };
    if (state.work.interact_done || num(shift.interact_count) >= num(shift.interact_limit)) {
        return { ok: false, reason: `本班次（老板 ${shift.employer?.name || shift.employer?.gid || '—'}）工作事项已做过`, nextAtSec: num(shift.end_at) + 30 };
    }
    if (state.settling) return { ok: false, reason: '奶茶活动结算期，不能做工作事项', nextAtSec: num(shift.end_at) + 30 };
    return { ok: true, shift };
}

// ============ 运行时 ============
let nextCheckAtMs = 0;
let lastLog = '';
let activeScheduler: any = null;
let activeTick: (() => Promise<any>) | null = null;
let lastTickErrorLogAt = 0;

function resetFnosMilkTeaAutoWorkRuntime(): void {
    nextCheckAtMs = 0;
    lastLog = '';
}

function readCfg() {
    return require('./fnos-fork-config').readFnosForkConfigs().tea;
}

function logSkip(message: string, warn = false): void {
    if (message === lastLog) return;
    lastLog = message;
    const u = require('../utils/utils');
    (warn ? u.logWarn : u.log)('奶茶工作', `工作事项跳过：${message}`, { module: 'activity', event: '奶茶工作事项', result: warn ? 'error' : 'skip' });
}

/** 一轮检查：有可做的班次就按设置做工作事项。返回是否提交成功。 */
async function runMilkTeaAutoWorkTick(options: { milkTea?: any; nowMs?: number; random?: () => number } = {}): Promise<boolean> {
    const cfg = readCfg();
    if (!cfg.autoWork) return false;
    const nowMs = options.nowMs || Date.now();
    if (nextCheckAtMs > nowMs) return false;
    const { log, logWarn, getServerTimeSec } = require('../utils/utils');
    const milkTea = options.milkTea || require('./milk-tea');
    nextCheckAtMs = nowMs + CHECK_INTERVAL_MS;
    let state: any;
    try {
        state = await milkTea.getMilkTeaActivity('work');
    } catch (e: any) {
        nextCheckAtMs = nowMs + FAIL_BACKOFF_MS;
        logSkip(`读取「我的工作」失败（${e.message}），30 分钟后再试`, true);
        return false;
    }
    const nowSec = num(state?.serverTime) || getServerTimeSec();
    if (!state?.active) { nextCheckAtMs = nowMs + 6 * 3600 * 1000; logSkip('奶茶活动未开放或已结束'); return false; }
    if (!num(state.summary?.shop_open_at)) { nextCheckAtMs = nowMs + 3600 * 1000; logSkip('本账号的奶茶店尚未开业（游戏要求先开业才能提交工作事项）'); return false; }
    if (!state.work) { logSkip('「我的工作」未返回'); return false; }
    const check = workableShift(state, nowSec);
    if (!check.ok) {
        if (check.nextAtSec && check.nextAtSec > nowSec) nextCheckAtMs = Math.max(nextCheckAtMs, nowMs + Math.min(check.nextAtSec - nowSec, 24 * 3600) * 1000);
        logSkip(String(check.reason));
        return false;
    }
    const { shift } = check;
    const boss = String(shift.employer?.name || '').trim() || `GID ${shift.employer?.gid}`;
    const pick = chooseWorkType(cfg.workType, state.interactions, options.random);
    if ('skip' in pick) { nextCheckAtMs = nowMs + Math.min(num(shift.end_at) - nowSec + 30, 3600) * 1000; logSkip(pick.skip); return false; }
    try {
        const res = await milkTea.operateMilkTeaActivity('interact', { interactionType: pick.type, expectedShiftId: String(shift.shift_id) });
        const r = res?.result || {};
        const gains = (res?.rewards || []).filter((v: any) => num(v.count) > 0).map((v: any) => `${v.name}×${num(v.count)}`);
        const bonus = num(r.friend?.bonus_amount);
        const extra = [gains.length ? `获得 ${gains.join('、')}` : '', bonus ? `工资奖金 ${bonus > 0 ? '+' : ''}${bonus} 奶茶券` : '', r.wage_adjusted ? '工资已调整' : ''].filter(Boolean).join('，');
        lastLog = '';
        nextCheckAtMs = nowMs + Math.max(60, num(shift.end_at) - nowSec + 30) * 1000;
        log('奶茶工作', `工作事项已完成：为老板 ${boss} 做「${typeName(pick.type)}」，${r.success ? '成功' : '未成功'}${extra ? `，${extra}` : ''}`, {
            module: 'activity', event: '奶茶工作事项', result: 'ok', interactionType: pick.type, success: !!r.success, employerGid: String(shift.employer?.gid || ''),
        });
        return true;
    } catch (e: any) {
        nextCheckAtMs = nowMs + FAIL_BACKOFF_MS;
        const message = `为老板 ${boss} 做「${typeName(pick.type)}」失败：${e.message}，30 分钟后再试`;
        if (message !== lastLog) { lastLog = message; logWarn('奶茶工作', `工作事项${message}`, { module: 'activity', event: '奶茶工作事项', result: 'error' }); }
        return false;
    }
}

function startFnosMilkTeaAutoWork(scheduler: any, runExclusive: (name: string, fn: () => Promise<any>) => Promise<any>): void {
    resetFnosMilkTeaAutoWorkRuntime();
    const runTick = () => runExclusive('fnos_milk_tea_auto_work', () => runMilkTeaAutoWorkTick()).catch((e: any) => {
        if (Date.now() - lastTickErrorLogAt > 30 * 60 * 1000) {
            lastTickErrorLogAt = Date.now();
            try { require('../utils/utils').logWarn('奶茶工作', `工作事项检查出错：${e && e.message ? e.message : e}`, { module: 'activity', event: '奶茶工作事项', result: 'error' }); } catch { /* ignore */ }
        }
        return null;
    });
    const tick = () => {
        // 未开启或未到检查时间时不进入自动化队列，避免每分钟排队
        try { if (!readCfg().autoWork || nextCheckAtMs > Date.now()) return Promise.resolve(null); } catch { /* 交给 tick 内部处理 */ }
        return runTick();
    };
    activeScheduler = scheduler;
    activeTick = tick;
    scheduler.setTimeoutTask('fnos_milk_tea_auto_work_first', FIRST_DELAY_MS, tick);
    // 每分钟只做本地时间判断，真正读取「我的工作」按 nextCheckAtMs（默认 10 分钟一次，已做过则等到班次结束）
    scheduler.setIntervalTask('fnos_milk_tea_auto_work', 60 * 1000, tick);
}

function onFnosMilkTeaAutoWorkConfigChanged(): void {
    resetFnosMilkTeaAutoWorkRuntime();
    if (activeScheduler && activeTick) {
        try { activeScheduler.setTimeoutTask('fnos_milk_tea_auto_work_first', FIRST_DELAY_MS, activeTick); } catch { /* ignore */ }
    }
}

module.exports = {
    chooseWorkType,
    workableShift,
    runMilkTeaAutoWorkTick,
    startFnosMilkTeaAutoWork,
    onFnosMilkTeaAutoWorkConfigChanged,
    resetFnosMilkTeaAutoWorkRuntime,
};
