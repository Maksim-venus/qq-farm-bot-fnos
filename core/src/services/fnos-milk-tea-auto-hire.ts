import config from '../activity-data/milk-tea-20261015.json';

export {};
/**
 * [fnos-fork] 奶茶活动自动雇佣（本 fork 新增功能，上游没有）
 *
 * 复用上游已在官方客户端验证过的雇佣流程（services/milk-tea.ts：
 * 操作号 56 雇佣列表 milk_tea_get_hire_list、57 雇佣 milk_tea_hire），本文件只负责“雇谁、雇多久”：
 *
 * - 通用模式：雇佣时长可选（4/12/24 小时或随机）、职业（特长 talent）可选或不限；
 *   从可雇佣的好友里随机选一个；员工位空出（到期）后自动再雇。
 * - 小号模式（账号设置了「这是小号」并选了大号）：大号当前可雇 → 雇大号 24 小时；
 *   大号已被雇（或不在可雇列表）→ 随机雇一个其他好友 4 小时。4 小时到期后若大号空出，下一轮优先雇大号。
 *
 * 雇佣会消耗奶茶券（物品 1041，按时长：4h 40、12h 130、24h 270，以服务端雇佣列表返回的 wage_total 为准）。
 * 余额不足、活动未开放/结算期、剩余营业时间不足时跳过并写日志，不会重试刷请求。
 */

const TOKEN_ITEM_ID = 1041;
const DURATIONS: Array<{ duration_id: number; duration_sec: number; duration_cost: string; min_remaining_business_sec: number }> = config.MilkTeaHireDurationConfig;
const TALENTS: Array<{ talent_id: number; talent_name: string }> = config.MilkTeaTalentConfig;
const DURATION_LABEL: Record<number, string> = { 1: '4 小时', 2: '12 小时', 3: '24 小时' };
const MASTER_DURATION_ID = 3; // 24 小时
const FALLBACK_DURATION_ID = 1; // 4 小时

export interface FnosMilkTeaAutoHireConfig {
    enabled: boolean;
    /** 0 = 随机；1/2/3 = 4/12/24 小时 */
    durationId: number;
    /** 0 = 不限（随机）；否则只雇该特长（职业）的好友 */
    talentId: number;
    /** 好友都不可雇时是否雇佣系统员工（机器人） */
    allowRobots: boolean;
}

const DEFAULT_FNOS_MILK_TEA_AUTO_HIRE: FnosMilkTeaAutoHireConfig = {
    enabled: false,
    durationId: 0,
    talentId: 0,
    allowRobots: false,
};

function normalizeFnosMilkTeaAutoHire(input: unknown, fallback: FnosMilkTeaAutoHireConfig = DEFAULT_FNOS_MILK_TEA_AUTO_HIRE): FnosMilkTeaAutoHireConfig {
    const base = { ...DEFAULT_FNOS_MILK_TEA_AUTO_HIRE, ...(fallback || {}) };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...base };
    const src = input as Record<string, any>;
    const durationId = src.durationId !== undefined ? Number.parseInt(String(src.durationId), 10) : base.durationId;
    const talentId = src.talentId !== undefined ? Number.parseInt(String(src.talentId), 10) : base.talentId;
    return {
        enabled: src.enabled !== undefined ? !!src.enabled : !!base.enabled,
        durationId: DURATIONS.some(d => d.duration_id === durationId) ? durationId : 0,
        talentId: TALENTS.some(t => t.talent_id === talentId) ? talentId : 0,
        allowRobots: src.allowRobots !== undefined ? !!src.allowRobots : !!base.allowRobots,
    };
}

function num(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    return Number(value) || 0;
}

function talentName(id: number): string {
    return TALENTS.find(t => t.talent_id === id)?.talent_name || (id ? `特长${id}` : '');
}

function durationCost(id: number): number {
    const row = DURATIONS.find(d => d.duration_id === id);
    return row ? Number(String(row.duration_cost).split(':')[1]) || 0 : 0;
}

/** 剩余营业时间允许的时长（按配置 min_remaining_business_sec）。 */
function allowedDurationIds(remainBizSec: number): number[] {
    return DURATIONS.filter(d => remainBizSec >= d.min_remaining_business_sec).map(d => d.duration_id);
}

/** 当前空闲的员工位（位置从 0 开始；有 end_at > now 的班次即占用）。 */
function getFreeSlots(shop: any, nowSec: number): number[] {
    const level = config.MilkTeaStoreLevelConfig.find((v: any) => v.level === num(shop && shop.level));
    const count = Number(level?.employee_slot_count || 0);
    const slots: any[] = Array.isArray(shop && shop.slots) ? shop.slots : [];
    const free: number[] = [];
    for (let i = 0; i < count; i++) {
        if (!slots.some(s => num(s.slot_index) === i && num(s.end_at) > nowSec)) free.push(i);
    }
    return free;
}

/** 所有占用员工位中最早到期时间（无占用时 0）。 */
function getNextSlotEndSec(shop: any, nowSec: number): number {
    const ends = (Array.isArray(shop && shop.slots) ? shop.slots : [])
        .map((s: any) => num(s.end_at)).filter((t: number) => t > nowSec);
    return ends.length ? Math.min(...ends) : 0;
}

function isHireable(candidate: any, nowSec: number): boolean {
    return !!candidate && num(candidate.state) === 0 && num(candidate.rehire_available_at) <= nowSec && num(candidate.friend && candidate.friend.gid) > 0;
}

export interface HireChoice {
    targetGid: number;
    targetName: string;
    talentId: number;
    isRobot: boolean;
    reason: string;
}

/**
 * 在一份雇佣列表（某个时长的 milk_tea_get_hire_list 回包）中选人。
 * 纯函数，便于测试；random 可注入。
 */
function chooseCandidate(params: {
    hire: any;
    nowSec: number;
    talentId: number;
    allowRobots: boolean;
    excludeGids?: number[];
    random?: () => number;
}): HireChoice | null {
    const { hire, nowSec, talentId, allowRobots } = params;
    const random = params.random || Math.random;
    const exclude = new Set((params.excludeGids || []).map(Number));
    const pick = (list: any[], isRobot: boolean): HireChoice | null => {
        const pool = (Array.isArray(list) ? list : []).filter(c => isHireable(c, nowSec)
            && !exclude.has(num(c.friend.gid))
            && (!talentId || num(c.talent_id) === talentId));
        if (pool.length === 0) return null;
        const c = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
        return {
            targetGid: num(c.friend.gid),
            targetName: String(c.friend.name || '').trim() || `GID ${num(c.friend.gid)}`,
            talentId: num(c.talent_id),
            isRobot,
            reason: isRobot ? '好友都不可雇，雇佣系统员工' : '随机选择可雇佣好友',
        };
    };
    return pick(hire && hire.friends, false) || (allowRobots ? pick(hire && hire.robots, true) : null);
}

/** 在雇佣列表里找大号；返回其状态。 */
function findMaster(hire: any, masterGid: number, nowSec: number): { found: boolean; hireable: boolean; candidate: any } {
    const all = [...(hire?.friends || []), ...(hire?.robots || [])];
    const candidate = all.find(c => num(c?.friend?.gid) === masterGid);
    return { found: !!candidate, hireable: isHireable(candidate, nowSec), candidate };
}

/**
 * 决定本轮对一个空闲员工位的雇佣计划（不发请求）。
 * getHireList(durationId) 返回该时长的雇佣列表。
 */
async function planOneHire(params: {
    cfg: FnosMilkTeaAutoHireConfig;
    alt: { enabled: boolean; masterGid: number; masterName: string };
    remainBizSec: number;
    nowSec: number;
    getHireList: (durationId: number) => Promise<any>;
    excludeGids?: number[];
    random?: () => number;
}): Promise<{ durationId: number; choice: HireChoice; wage: number } | { skip: string }> {
    const { cfg, alt, remainBizSec, nowSec, getHireList } = params;
    const random = params.random || Math.random;
    const allowed = allowedDurationIds(remainBizSec);
    if (allowed.length === 0) return { skip: '活动剩余营业时间不足，无法再雇佣' };
    const exclude = [...(params.excludeGids || [])];

    if (alt && alt.enabled && alt.masterGid > 0) {
        const masterLabel = alt.masterName ? `大号 ${alt.masterName}` : `大号 GID ${alt.masterGid}`;
        // 大号优先：能 24 小时就 24 小时，营业时间不够则取能雇的最长时长
        const masterDuration = allowed.includes(MASTER_DURATION_ID) ? MASTER_DURATION_ID : Math.max(...allowed);
        const hire = await getHireList(masterDuration);
        const master = findMaster(hire, alt.masterGid, nowSec);
        if (master.hireable && !exclude.includes(alt.masterGid)) {
            return {
                durationId: masterDuration,
                wage: num(hire?.wage_total) || durationCost(masterDuration),
                choice: {
                    targetGid: alt.masterGid,
                    targetName: String(master.candidate.friend.name || alt.masterName || '').trim() || `GID ${alt.masterGid}`,
                    talentId: num(master.candidate.talent_id),
                    isRobot: false,
                    reason: `小号模式：${masterLabel}当前空闲，优先雇大号`,
                },
            };
        }
        const why = master.found ? `${masterLabel}已被雇佣或冷却中` : `${masterLabel}不在可雇佣列表`;
        const fallbackDuration = allowed.includes(FALLBACK_DURATION_ID) ? FALLBACK_DURATION_ID : Math.min(...allowed);
        const fallbackHire = fallbackDuration === masterDuration ? hire : await getHireList(fallbackDuration);
        const choice = chooseCandidate({
            hire: fallbackHire, nowSec, talentId: cfg.talentId, allowRobots: cfg.allowRobots,
            excludeGids: [...exclude, alt.masterGid], random,
        });
        if (!choice) return { skip: `${why}，且没有符合条件的其他可雇佣好友${cfg.talentId ? `（职业限定：${talentName(cfg.talentId)}）` : ''}` };
        return {
            durationId: fallbackDuration,
            wage: num(fallbackHire?.wage_total) || durationCost(fallbackDuration),
            choice: { ...choice, reason: `小号模式：${why}，随机雇其他好友` },
        };
    }

    let durationId = cfg.durationId;
    if (!durationId) durationId = allowed[Math.min(allowed.length - 1, Math.floor(random() * allowed.length))];
    if (!allowed.includes(durationId)) return { skip: `活动剩余营业时间不足以雇佣 ${DURATION_LABEL[durationId] || durationId}` };
    const hire = await getHireList(durationId);
    const choice = chooseCandidate({ hire, nowSec, talentId: cfg.talentId, allowRobots: cfg.allowRobots, excludeGids: exclude, random });
    if (!choice) return { skip: `没有符合条件的可雇佣好友${cfg.talentId ? `（职业限定：${talentName(cfg.talentId)}）` : ''}` };
    return { durationId, wage: num(hire?.wage_total) || durationCost(durationId), choice };
}

// ============ 运行时（worker 内） ============

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 90 * 1000;
const FAIL_BACKOFF_MS = 30 * 60 * 1000;
const SKIP_BACKOFF_MS = 15 * 60 * 1000;
let nextCheckAtMs = 0;
let lastSkipLog = '';
let lastSkipLogAt = 0;

function resetFnosMilkTeaAutoHireRuntime(): void {
    nextCheckAtMs = 0;
    lastSkipLog = '';
    lastSkipLogAt = 0;
}

function readConfigs(): { cfg: FnosMilkTeaAutoHireConfig; alt: { enabled: boolean; masterGid: number; masterName: string } } {
    // 2026.10.20.3：统一经 store.getConfigSnapshot() 读取（见 services/fnos-fork-config.ts）
    const { tea, alt } = require('./fnos-fork-config').readFnosForkConfigs();
    return { cfg: tea, alt };
}

function logSkip(message: string): void {
    const { log } = require('../utils/utils');
    const now = Date.now();
    if (message === lastSkipLog && now - lastSkipLogAt < 2 * 60 * 60 * 1000) return;
    lastSkipLog = message;
    lastSkipLogAt = now;
    log('奶茶雇佣', `跳过：${message}`, { module: 'activity', event: '奶茶自动雇佣', result: 'skip' });
}

/** 一轮检查：有空闲员工位就按规则雇佣。返回本轮雇佣次数。 */
async function runMilkTeaAutoHireTick(options: { force?: boolean; milkTea?: any; nowMs?: number } = {}): Promise<number> {
    const { cfg, alt } = readConfigs();
    if (!cfg.enabled) return 0;
    const nowMs = options.nowMs || Date.now();
    if (!options.force && nextCheckAtMs > nowMs) return 0;
    const { log, logWarn, getServerTimeSec } = require('../utils/utils');
    const milkTea = options.milkTea || require('./milk-tea');

    let state: any;
    try {
        state = await milkTea.getMilkTeaActivity('hireList', { durationId: FALLBACK_DURATION_ID });
    } catch (e: any) {
        nextCheckAtMs = nowMs + FAIL_BACKOFF_MS;
        logSkip(`读取奶茶活动失败（${e.message}），30 分钟后再试`);
        return 0;
    }
    const nowSec = Number(state?.serverTime) || getServerTimeSec();
    if (!state?.active) { nextCheckAtMs = nowMs + 6 * 3600 * 1000; logSkip('奶茶活动未开放或已结束'); return 0; }
    if (!num(state.summary?.shop_open_at) || !state.shop) { nextCheckAtMs = nowMs + 3600 * 1000; logSkip('奶茶店尚未开业'); return 0; }
    if (state.settling || state.shop.is_settling) { nextCheckAtMs = nowMs + 3600 * 1000; logSkip('奶茶活动结算期，不能雇佣'); return 0; }

    const freeSlots = getFreeSlots(state.shop, nowSec);
    if (freeSlots.length === 0) {
        const nextEnd = getNextSlotEndSec(state.shop, nowSec);
        // 员工位都满：到最早一个班次结束后 30 秒再查
        nextCheckAtMs = nextEnd > 0 ? nowMs + (nextEnd - nowSec + 30) * 1000 : nowMs + TICK_INTERVAL_MS;
        if (nextEnd > 0) {
            const at = new Date(nextEnd * 1000);
            const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
            logSkip(`员工位已满，最早 ${hhmm} 有员工下班，届时再检查`);
        } else {
            logSkip('员工位已满');
        }
        return 0;
    }

    const remainBizSec = num(state.settleStartTime) - nowSec;
    let balance = num(state.balances && state.balances[String(TOKEN_ITEM_ID)]);
    const listCache = new Map<number, any>();
    listCache.set(FALLBACK_DURATION_ID, state.hire);
    const getHireList = async (durationId: number) => {
        if (!listCache.has(durationId)) {
            const s = await milkTea.getMilkTeaActivity('hireList', { durationId });
            listCache.set(durationId, s?.hire || {});
        }
        return listCache.get(durationId);
    };

    // 已在本店上班的员工不再重复选择
    const working = (state.shop.slots || []).filter((s: any) => num(s.end_at) > nowSec).map((s: any) => num(s.employee && s.employee.gid)).filter(Boolean);
    let hired = 0;
    for (const _slot of freeSlots) {
        let plan: any;
        try {
            plan = await planOneHire({ cfg, alt, remainBizSec, nowSec, getHireList, excludeGids: working });
        } catch (e: any) {
            logSkip(`读取雇佣列表失败：${e.message}`);
            nextCheckAtMs = nowMs + FAIL_BACKOFF_MS;
            return hired;
        }
        if (plan.skip) { logSkip(plan.skip); nextCheckAtMs = nowMs + SKIP_BACKOFF_MS; return hired; }
        if (balance < plan.wage) {
            logSkip(`奶茶券不足（需要 ${plan.wage}，现有 ${balance}），无法雇佣 ${DURATION_LABEL[plan.durationId]}`);
            nextCheckAtMs = nowMs + FAIL_BACKOFF_MS;
            return hired;
        }
        const { choice } = plan;
        try {
            await milkTea.operateMilkTeaActivity('hire', {
                durationId: plan.durationId,
                targetGid: String(choice.targetGid),
                expectedCosts: [{ id: TOKEN_ITEM_ID, count: plan.wage }],
            });
            hired++;
            balance -= plan.wage;
            working.push(choice.targetGid);
            listCache.clear();
            log('奶茶雇佣', `已雇佣 ${choice.targetName}${choice.talentId ? `（${talentName(choice.talentId)}）` : ''} ${DURATION_LABEL[plan.durationId]}，花费奶茶券 ${plan.wage}。原因：${choice.reason}`, {
                module: 'activity', event: '奶茶自动雇佣', result: 'ok', targetGid: choice.targetGid, durationId: plan.durationId, cost: plan.wage,
            });
        } catch (e: any) {
            logWarn('奶茶雇佣', `雇佣 ${choice.targetName} ${DURATION_LABEL[plan.durationId]} 失败：${e.message}`, {
                module: 'activity', event: '奶茶自动雇佣', result: 'error', targetGid: choice.targetGid,
            });
            nextCheckAtMs = nowMs + FAIL_BACKOFF_MS;
            return hired;
        }
    }
    nextCheckAtMs = 0;
    return hired;
}

/** 保存设置后多久做一次检查（让新设置马上生效） */
const CONFIG_CHANGE_TICK_DELAY_MS = 5 * 1000;
let activeScheduler: any = null;
let activeTick: (() => Promise<any>) | null = null;
let lastTickErrorLogAt = 0;

/** 登录完成后由 worker 调用；任务挂在 workerScheduler 上，停号时随 clearAll 一起清理。 */
function startFnosMilkTeaAutoHire(scheduler: any, runExclusive: (name: string, fn: () => Promise<any>) => Promise<any>): void {
    resetFnosMilkTeaAutoHireRuntime();
    const tick = () => runExclusive('fnos_milk_tea_auto_hire', () => runMilkTeaAutoHireTick()).catch((e: any) => {
        // 不再静默吞掉异常（2026.10.20.3 之前读配置的 TypeError 就是这样被吞掉的）
        if (Date.now() - lastTickErrorLogAt > 30 * 60 * 1000) {
            lastTickErrorLogAt = Date.now();
            try { require('../utils/utils').logWarn('奶茶雇佣', `自动雇佣检查出错：${e && e.message ? e.message : e}`, { module: 'activity', event: '奶茶自动雇佣', result: 'error' }); } catch { /* ignore */ }
        }
        return null;
    });
    activeScheduler = scheduler;
    activeTick = tick;
    scheduler.setTimeoutTask('fnos_milk_tea_auto_hire_first', FIRST_TICK_DELAY_MS, tick);
    scheduler.setIntervalTask('fnos_milk_tea_auto_hire', TICK_INTERVAL_MS, tick);
    // 登录完成时打印两项设置的状态，便于在日志里确认已生效
    try { require('./fnos-fork-config').logFnosForkStatus('账号已登录', true); } catch { /* ignore */ }
}

/** 保存设置后：清掉退避，并在几秒后检查一次（只在 worker 里、登录后生效；主进程无调度器时什么也不做）。 */
function onFnosMilkTeaAutoHireConfigChanged(): void {
    nextCheckAtMs = 0;
    lastSkipLog = '';
    if (activeScheduler && activeTick) {
        try { activeScheduler.setTimeoutTask('fnos_milk_tea_auto_hire_first', CONFIG_CHANGE_TICK_DELAY_MS, activeTick); } catch { /* ignore */ }
    }
}

module.exports = {
    DEFAULT_FNOS_MILK_TEA_AUTO_HIRE,
    normalizeFnosMilkTeaAutoHire,
    getFreeSlots,
    getNextSlotEndSec,
    chooseCandidate,
    findMaster,
    planOneHire,
    allowedDurationIds,
    runMilkTeaAutoHireTick,
    startFnosMilkTeaAutoHire,
    onFnosMilkTeaAutoHireConfigChanged,
    resetFnosMilkTeaAutoHireRuntime,
    MILK_TEA_DURATION_OPTIONS: DURATIONS.map(d => ({ durationId: d.duration_id, label: DURATION_LABEL[d.duration_id], cost: durationCost(d.duration_id) })),
    MILK_TEA_TALENT_OPTIONS: TALENTS.map(t => ({ talentId: t.talent_id, name: t.talent_name })),
};
