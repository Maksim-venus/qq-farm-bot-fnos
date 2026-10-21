import config from '../activity-data/milk-tea-20261015.json';

export {};
/**
 * [fnos-fork] 奶茶活动自动雇佣（本 fork 新增功能，上游没有）
 *
 * 复用上游已在官方客户端验证过的雇佣流程（services/milk-tea.ts：
 * 操作号 56 雇佣列表 milk_tea_get_hire_list、57 雇佣 milk_tea_hire），本文件只负责“雇谁、雇多久”。
 *
 * 2026.10.21.2 起与大号/小号设置解耦，任何账号都可开启：
 * - 「优先雇佣人」（从本账号好友中选，可不指定）：空闲时先雇他（不受职业限制）；
 * - 优先雇佣人已被雇/冷却/不在列表，或未指定：从符合职业条件的可雇好友中随机雇一个（不会选优先雇佣人）；
 * - 时长只有一个统一设置「雇佣时长」（durationId），雇优先雇佣人和雇其他好友都用它：
 *   4/12/24 小时（官方 MilkTeaHireDurationConfig 的 duration_id 1/2/3）或随机（在剩余营业时间允许的档位中）。
 * - 兼容老配置：priorityConfigured=false（2026.10.21.2 之前保存的配置）且本账号是小号并已选大号时，
 *   视为「优先雇佣人 = 大号」，时长沿用本账号已有的「雇佣时长」；在新卡片保存一次后不再参考大小号设置。
 *
 * 雇佣会消耗奶茶券（物品 1041，按时长：4h 40、12h 130、24h 270，以服务端雇佣列表返回的 wage_total 为准）。
 * 余额不足、活动未开放/结算期、剩余营业时间不足时跳过并写日志，不会重试刷请求。
 */

const TOKEN_ITEM_ID = 1041;
const DURATIONS: Array<{ duration_id: number; duration_sec: number; duration_cost: string; min_remaining_business_sec: number }> = config.MilkTeaHireDurationConfig;
const TALENTS: Array<{ talent_id: number; talent_name: string }> = config.MilkTeaTalentConfig;
const WORK_TYPE_IDS: number[] = config.MilkTeaInteractionType.map((v: any) => Number(v.interaction_id));
const DURATION_LABEL: Record<number, string> = { 1: '4 小时', 2: '12 小时', 3: '24 小时' };
const FALLBACK_DURATION_ID = 1; // 读取活动状态时默认请求的雇佣列表档位（4 小时）

export interface FnosMilkTeaAutoHireConfig {
    enabled: boolean;
    /** 雇佣时长（优先雇佣人和其他好友统一）：0 = 随机；1/2/3 = 4/12/24 小时 */
    durationId: number;
    /** 优先雇佣人 GID（0 = 不指定） */
    priorityGid: number;
    /** 优先雇佣人名字（仅显示用） */
    priorityName: string;
    /** 是否已用 2026.10.21.2 起的新卡片保存过；false 时按旧版小号模式迁移（见 resolveEffectiveHireConfig） */
    priorityConfigured: boolean;
    /** 0 = 不限（随机）；否则只雇该特长（职业）的好友（优先雇佣人不受限） */
    talentId: number;
    /** 好友都不可雇时是否雇佣系统员工（机器人） */
    allowRobots: boolean;
    /** 2026.10.21.1：本账号被雇佣（有兼职班次）时自动做工作事项（见 fnos-milk-tea-auto-work.ts），与 enabled 独立 */
    autoWork: boolean;
    /** 工作事项：0 = 随机（只在 1/2/3 中选）；1~5 = 指定 */
    workType: number;
}

const DEFAULT_FNOS_MILK_TEA_AUTO_HIRE: FnosMilkTeaAutoHireConfig = {
    enabled: false,
    durationId: 0,
    priorityGid: 0,
    priorityName: '',
    priorityConfigured: false,
    talentId: 0,
    allowRobots: false,
    autoWork: false,
    workType: 0,
};

function validDuration(id: number, allowRandom = true): boolean {
    return (allowRandom && id === 0) || DURATIONS.some(d => d.duration_id === id);
}

function normalizeFnosMilkTeaAutoHire(input: unknown, fallback: FnosMilkTeaAutoHireConfig = DEFAULT_FNOS_MILK_TEA_AUTO_HIRE): FnosMilkTeaAutoHireConfig {
    const base = { ...DEFAULT_FNOS_MILK_TEA_AUTO_HIRE, ...(fallback || {}) };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...base };
    const src = input as Record<string, any>;
    const pick = (key: string) => (src[key] !== undefined ? Number.parseInt(String(src[key]), 10) : Number((base as any)[key]) || 0);
    const durationId = pick('durationId');
    const talentId = pick('talentId');
    const workType = pick('workType');
    const gidRaw = src.priorityGid !== undefined ? Number.parseInt(String(src.priorityGid), 10) : Number(base.priorityGid) || 0;
    const priorityGid = Number.isSafeInteger(gidRaw) && gidRaw > 0 ? gidRaw : 0;
    return {
        enabled: src.enabled !== undefined ? !!src.enabled : !!base.enabled,
        durationId: validDuration(durationId) ? durationId : 0,
        priorityGid,
        priorityName: priorityGid ? String(src.priorityName !== undefined ? src.priorityName : base.priorityName || '').trim().slice(0, 64) : '',
        priorityConfigured: src.priorityConfigured !== undefined ? !!src.priorityConfigured : !!base.priorityConfigured,
        talentId: TALENTS.some(t => t.talent_id === talentId) ? talentId : 0,
        allowRobots: src.allowRobots !== undefined ? !!src.allowRobots : !!base.allowRobots,
        autoWork: src.autoWork !== undefined ? !!src.autoWork : !!base.autoWork,
        workType: WORK_TYPE_IDS.includes(workType) ? workType : 0,
    };
}

/**
 * 兼容 2026.10.21.2 之前的配置：未用新卡片保存过（priorityConfigured=false）、未指定优先雇佣人、
 * 且本账号是小号并已选大号 → 优先雇佣人 = 大号；时长沿用本账号的「雇佣时长」，不另设。
 */
function resolveEffectiveHireConfig(tea: FnosMilkTeaAutoHireConfig, alt: { enabled: boolean; masterGid: number; masterName: string } | null | undefined): FnosMilkTeaAutoHireConfig & { migratedFromAlt: boolean } {
    const cfg = normalizeFnosMilkTeaAutoHire(tea);
    if (!cfg.priorityConfigured && !cfg.priorityGid && alt && alt.enabled && Number(alt.masterGid) > 0) {
        return { ...cfg, priorityGid: Number(alt.masterGid), priorityName: String(alt.masterName || ''), migratedFromAlt: true };
    }
    return { ...cfg, migratedFromAlt: false };
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

/** 按「雇佣时长」选档位：0 = 在营业时间允许的档位中随机；指定档位不被允许时返回 0（本轮跳过）。 */
function pickDuration(wanted: number, allowed: number[], random: () => number): number {
    if (!wanted) return allowed[Math.min(allowed.length - 1, Math.floor(random() * allowed.length))];
    return allowed.includes(wanted) ? wanted : 0;
}

/**
 * 决定本轮对一个空闲员工位的雇佣计划（不发请求）。
 * cfg 应为 resolveEffectiveHireConfig 之后的配置；getHireList(durationId) 返回该时长的雇佣列表。
 */
async function planOneHire(params: {
    cfg: FnosMilkTeaAutoHireConfig;
    remainBizSec: number;
    nowSec: number;
    getHireList: (durationId: number) => Promise<any>;
    excludeGids?: number[];
    random?: () => number;
}): Promise<{ durationId: number; choice: HireChoice; wage: number } | { skip: string }> {
    const { cfg, remainBizSec, nowSec, getHireList } = params;
    const random = params.random || Math.random;
    const allowed = allowedDurationIds(remainBizSec);
    if (allowed.length === 0) return { skip: '活动剩余营业时间不足，无法再雇佣' };
    const durationId = pickDuration(cfg.durationId, allowed, random);
    if (!durationId) return { skip: `活动剩余营业时间不足以雇佣 ${DURATION_LABEL[cfg.durationId] || cfg.durationId}` };
    const exclude = [...(params.excludeGids || [])];
    const talentNote = cfg.talentId ? `（职业限定：${talentName(cfg.talentId)}）` : '';
    const hire = await getHireList(durationId);
    const wage = num(hire?.wage_total) || durationCost(durationId);
    let why = '';

    if (cfg.priorityGid > 0) {
        const label = cfg.priorityName ? `优先雇佣人 ${cfg.priorityName}` : `优先雇佣人 GID ${cfg.priorityGid}`;
        const target = findMaster(hire, cfg.priorityGid, nowSec);
        if (target.hireable && !exclude.includes(cfg.priorityGid)) {
            return {
                durationId,
                wage,
                choice: {
                    targetGid: cfg.priorityGid,
                    targetName: String(target.candidate.friend.name || cfg.priorityName || '').trim() || `GID ${cfg.priorityGid}`,
                    talentId: num(target.candidate.talent_id),
                    isRobot: false,
                    reason: `${label}当前空闲，优先雇佣`,
                },
            };
        }
        why = exclude.includes(cfg.priorityGid) ? `${label}已在本店上班` : target.found ? `${label}已被雇佣或冷却中` : `${label}不在可雇佣列表`;
    }

    const choice = chooseCandidate({
        hire, nowSec, talentId: cfg.talentId, allowRobots: cfg.allowRobots,
        excludeGids: cfg.priorityGid > 0 ? [...exclude, cfg.priorityGid] : exclude, random,
    });
    if (!choice) return { skip: `${why ? `${why}，且` : ''}没有符合条件的${why ? '其他' : ''}可雇佣好友${talentNote}` };
    return {
        durationId,
        wage,
        choice: why ? { ...choice, reason: `${why}，${choice.isRobot ? '雇佣系统员工' : '随机雇其他好友'}` } : choice,
    };
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

function readConfigs(): { cfg: FnosMilkTeaAutoHireConfig } {
    // 2026.10.20.3：统一经 store.getConfigSnapshot() 读取（见 services/fnos-fork-config.ts）
    // 2026.10.21.2：与大小号解耦；老配置按 resolveEffectiveHireConfig 迁移
    const { tea, alt } = require('./fnos-fork-config').readFnosForkConfigs();
    return { cfg: resolveEffectiveHireConfig(tea, alt) };
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
    const { cfg } = readConfigs();
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
            plan = await planOneHire({ cfg, remainBizSec, nowSec, getHireList, excludeGids: working });
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
    // [fnos-fork] 2026.10.21.1 被雇佣时自动做工作事项（未开启时每轮直接返回，不发请求）
    try { require('./fnos-milk-tea-auto-work').startFnosMilkTeaAutoWork(scheduler, runExclusive); } catch { /* ignore */ }
    // 登录完成时打印两项设置的状态，便于在日志里确认已生效
    try { require('./fnos-fork-config').logFnosForkStatus('账号已登录', true); } catch { /* ignore */ }
}

/** 保存设置后：清掉退避，并在几秒后检查一次（只在 worker 里、登录后生效；主进程无调度器时什么也不做）。 */
function onFnosMilkTeaAutoHireConfigChanged(): void {
    try { require('./fnos-milk-tea-auto-work').onFnosMilkTeaAutoWorkConfigChanged(); } catch { /* ignore */ }
    nextCheckAtMs = 0;
    lastSkipLog = '';
    if (activeScheduler && activeTick) {
        try { activeScheduler.setTimeoutTask('fnos_milk_tea_auto_hire_first', CONFIG_CHANGE_TICK_DELAY_MS, activeTick); } catch { /* ignore */ }
    }
}

module.exports = {
    DEFAULT_FNOS_MILK_TEA_AUTO_HIRE,
    normalizeFnosMilkTeaAutoHire,
    resolveEffectiveHireConfig,
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
    MILK_TEA_WORK_OPTIONS: config.MilkTeaInteractionType.map((v: any) => ({
        workType: Number(v.interaction_id), name: v.name,
        description: String(v.des || '').replace(/<[^>]+>/g, '').replace('{0}', 'N'),
        risky: [4, 5].includes(Number(v.interaction_id)),
    })),
};
