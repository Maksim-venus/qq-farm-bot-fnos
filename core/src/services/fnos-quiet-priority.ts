export {};
/**
 * [fnos-fork] 2026-11-16「自己收菜优先」与「空闲时只保留心跳」（本 fork 新增，上游没有）
 *
 * 思路参考 Xb-Fishing/qq-farm-evolution 的 own-quiet-priority / idleProtection，代码按本项目结构重写（对方仓库无 LICENSE）。
 * 设置字段 fnosQuietPriority（按账号保存，在「设置 → 自动控制」里随「保存自动控制」一起保存）。
 *
 * 一、自己收菜优先（ownHarvestFirst，默认开）
 *   1. 精确唤醒：巡田后记下自家下一块作物的成熟时间，统一调度在「成熟 + 0.3 秒」安排一次巡田，
 *      不再只等固定巡田间隔。
 *   2. 好友让路：自家作物成熟前 10 秒到成熟后 8 秒内，不开始新一轮好友巡查；正在进行的好友巡查
 *      在访问下一位好友前等待（最多 30 秒），宠物同步这类后台补数据也跳过本轮。
 *   3. 连续成熟合并：本轮收获后，如果下一块自家作物在 mergeWindowSec 秒内（默认 10 秒）成熟，
 *      本轮先不铲地 / 补种 / 读地施肥，等那块成熟时一轮收完再一起种。最多连续合并 3 次，防止一直不种。
 *   小号保护：大小号协作里开启「成熟作物先留给大号偷」的小号，以上 1～3 全部不生效（作物成熟后本来
 *   就要留给大号，不能抢点、也不能为了合并去等）。本模块从不自己发收获请求，所有收获仍走
 *   farm/scheduler.ts 里原有的 filterHarvestForAltAccount 过滤，小号等大号偷过（或超时）才收的规则不受影响。
 *
 * 二、空闲时只保留心跳（idleKeepaliveOnly，默认关）
 *   最近一轮巡田没有任何动作、最近一轮好友巡查没有要访问的好友（或好友功能未开 / 在好友静默时段）时，
 *   进入空闲静默：暂停统一调度里的巡田与好友巡查（含任务领取、礼包、出售），以及每日任务、神秘商店、
 *   图鉴、偷收比、化肥购买检测、好友宠物同步这些定时任务；连接心跳和 ACE 上报照常，不掉线；
 *   面板上的手动操作不受影响。静默时长在 idleMinMinutes～idleMaxMinutes 之间随机，
 *   并且一定在自家下一块作物成熟前 10 秒结束；小号有留给大号的地时最多静默 60 秒就复查一次。
 *   少于 60 秒的空闲不进入静默。到点后立即巡田 + 巡查好友一轮，仍然空闲才再次静默。
 *   提前结束：土地推送触发的巡田有了动作（自己的农场照常处理）、修改了本设置、掉线重连。
 */

/** 精确唤醒：成熟后多少毫秒巡田（给服务端一点余量） */
const OWN_WAKE_AFTER_MS = 300;
/** 好友让路窗口：成熟前 / 成熟后 */
const OWN_YIELD_BEFORE_MS = 10_000;
const OWN_YIELD_AFTER_MS = 8_000;
/** 好友巡查中途等待自家收菜的最长时间 */
const FRIEND_YIELD_MAX_WAIT_MS = 30_000;
const MAX_MERGE_STREAK = 3;
const MIN_IDLE_MS = 60_000;
/** 空闲静默在自家作物成熟前多久结束 */
const IDLE_WAKE_BEFORE_MATURE_MS = 10_000;
/** 小号有留给大号的地时，静默最长多久复查一次 */
const ALT_HELD_RECHECK_MS = 60_000;
/** 巡田记录多久内算「最近一轮」 */
const ROUND_FRESH_MS = 3 * 60_000;

export interface FnosQuietPriorityConfig {
    /** 自己收菜优先 */
    ownHarvestFirst: boolean;
    /** 连续成熟合并窗口（秒），0 = 不合并 */
    mergeWindowSec: number;
    /** 空闲时只保留心跳 */
    idleKeepaliveOnly: boolean;
    /** 每次空闲静默最短 / 最长分钟数 */
    idleMinMinutes: number;
    idleMaxMinutes: number;
}

const DEFAULT_FNOS_QUIET_PRIORITY: FnosQuietPriorityConfig = {
    ownHarvestFirst: true,
    mergeWindowSec: 10,
    idleKeepaliveOnly: false,
    idleMinMinutes: 1,
    idleMaxMinutes: 10,
};

function clampInt(value: any, min: number, max: number, fallback: number): number {
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function normalizeFnosQuietPriority(input: unknown, fallback: FnosQuietPriorityConfig = DEFAULT_FNOS_QUIET_PRIORITY): FnosQuietPriorityConfig {
    const base = { ...DEFAULT_FNOS_QUIET_PRIORITY, ...(fallback || {}) };
    const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, any> : {};
    const pick = (key: string) => (src[key] !== undefined && src[key] !== null && src[key] !== '' ? src[key] : (base as any)[key]);
    let idleMinMinutes = clampInt(pick('idleMinMinutes'), 1, 180, DEFAULT_FNOS_QUIET_PRIORITY.idleMinMinutes);
    let idleMaxMinutes = clampInt(pick('idleMaxMinutes'), 1, 180, DEFAULT_FNOS_QUIET_PRIORITY.idleMaxMinutes);
    if (idleMinMinutes > idleMaxMinutes) [idleMinMinutes, idleMaxMinutes] = [idleMaxMinutes, idleMinMinutes];
    return {
        ownHarvestFirst: src.ownHarvestFirst !== undefined ? !!src.ownHarvestFirst : base.ownHarvestFirst !== false,
        mergeWindowSec: clampInt(pick('mergeWindowSec'), 0, 30, DEFAULT_FNOS_QUIET_PRIORITY.mergeWindowSec),
        idleKeepaliveOnly: src.idleKeepaliveOnly !== undefined ? !!src.idleKeepaliveOnly : !!base.idleKeepaliveOnly,
        idleMinMinutes,
        idleMaxMinutes,
    };
}

// ============ 纯函数（可单测） ============

function toNumber(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value.toNumber === 'function') return value.toNumber();
    return Number(value) || 0;
}

function toSec(value: any): number {
    const n = toNumber(value);
    if (n <= 0) return 0;
    return n > 1e12 ? Math.floor(n / 1000) : n;
}

/** 自家土地里下一块作物进入成熟阶段的服务器时间（秒）；没有正在长的作物返回 0。 */
function nextOwnMatureSec(lands: any[], nowSec: number, excludeLandIds: number[] = []): number {
    const exclude = new Set((excludeLandIds || []).map(toNumber));
    let best = 0;
    for (const land of Array.isArray(lands) ? lands : []) {
        if (!land || land.unlocked === false) continue;
        if (exclude.has(toNumber(land.id))) continue;
        const phases = land.plant && Array.isArray(land.plant.phases) ? land.plant.phases : [];
        // 与上游 land-analysis 的 matureInSec 相同：phases 里最晚开始的那个阶段就是成熟阶段
        // （部分作物成熟时 phase 不是 6，不能按 phase 值找）
        let matureBegin = 0;
        for (const phase of phases) {
            const begin = phase ? toSec(phase.begin_time) : 0;
            if (begin > matureBegin) matureBegin = begin;
        }
        if (matureBegin > nowSec && (best === 0 || matureBegin < best)) best = matureBegin;
    }
    return best;
}

/** 小号且开启了「成熟作物先留给大号偷」：自己收菜优先的抢点 / 合并 / 好友让路都不生效。 */
function isAltHoldingForMaster(alt: any): boolean {
    return !!(alt && alt.enabled && toNumber(alt.masterGid) > 0 && alt.holdForMaster !== false);
}

/** 是否在自家作物成熟的让路窗口内。 */
function inOwnYieldWindow(matureAtMs: number, nowMs: number): boolean {
    if (!(matureAtMs > 0)) return false;
    return nowMs >= matureAtMs - OWN_YIELD_BEFORE_MS && nowMs <= matureAtMs + OWN_YIELD_AFTER_MS;
}

/** 收获后是否把补种合并到下一轮。 */
function planMergeAfterHarvest(input: {
    enabled: boolean; altHolding: boolean; harvestedCount: number;
    nextMatureAtMs: number; nowMs: number; windowSec: number; streak: number;
}): boolean {
    if (!input.enabled || input.altHolding || !(input.harvestedCount > 0)) return false;
    if (!(input.windowSec > 0) || input.streak >= MAX_MERGE_STREAK) return false;
    const lead = input.nextMatureAtMs - input.nowMs;
    return lead > 0 && lead <= input.windowSec * 1000;
}

/**
 * 计算空闲静默到什么时候（毫秒时间戳）；不该静默返回 0。
 * rand 返回 [0,1)，测试时可固定。
 */
function planIdleUntil(input: {
    enabled: boolean; nowMs: number; farmIdle: boolean; friendIdle: boolean;
    nextOwnMatureAtMs: number; altHeldCount: number; minMinutes: number; maxMinutes: number;
    rand?: () => number;
}): number {
    if (!input.enabled || !input.farmIdle || !input.friendIdle) return 0;
    const now = input.nowMs;
    let hi = Math.max(1, input.maxMinutes) * 60_000;
    if (input.nextOwnMatureAtMs > 0) hi = Math.min(hi, input.nextOwnMatureAtMs - IDLE_WAKE_BEFORE_MATURE_MS - now);
    if (input.altHeldCount > 0) hi = Math.min(hi, ALT_HELD_RECHECK_MS);
    if (hi < MIN_IDLE_MS) return 0;
    const lo = Math.min(hi, Math.max(MIN_IDLE_MS, Math.max(1, input.minMinutes) * 60_000));
    const r = Math.max(0, Math.min(0.999999, (input.rand || Math.random)()));
    return now + Math.floor(lo + (hi - lo) * r);
}

// ============ 运行时状态（每个账号 worker 一份） ============

interface FarmRoundRecord { atMs: number; epoch: number; hadWork: boolean; nextMatureAtMs: number; altHeld: number; altHolding: boolean }
let lastFarm: FarmRoundRecord = { atMs: 0, epoch: -1, hadWork: true, nextMatureAtMs: 0, altHeld: 0, altHolding: false };
let lastFriend = { atMs: 0, epoch: -1, visits: 1 };
let idleUntil = 0;
/** 每次静默结束 / 重置加 1；只有本轮次之后完成的巡田和好友巡查才算「最近一轮」 */
let idleEpoch = 0;
let mergeStreak = 0;
let lastConfigKey = '';
let idleInterruptedListener: (() => void) | null = null;

/** worker 注册：静默被推送巡田提前打断时重新安排统一调度。 */
function setIdleInterruptedListener(fn: (() => void) | null): void {
    idleInterruptedListener = typeof fn === 'function' ? fn : null;
}

function resetFnosQuietRuntime(): void {
    lastFarm = { atMs: 0, epoch: -1, hadWork: true, nextMatureAtMs: 0, altHeld: 0, altHolding: false };
    lastFriend = { atMs: 0, epoch: -1, visits: 1 };
    idleUntil = 0;
    idleEpoch += 1;
    mergeStreak = 0;
}

function readConfigs(): { quiet: FnosQuietPriorityConfig; alt: any } {
    try {
        const cfg = require('./fnos-fork-config').readFnosForkConfigs();
        return { quiet: cfg.quiet || normalizeFnosQuietPriority(undefined), alt: cfg.alt };
    } catch {
        return { quiet: normalizeFnosQuietPriority(undefined), alt: null };
    }
}

function logInfo(msg: string, meta: Record<string, any> = {}): void {
    try { require('../utils/utils').log('系统', msg, { module: 'system', event: '空闲静默', ...meta }); } catch { /* ignore */ }
}

function serverNowSec(): number {
    try { return require('../utils/utils').getServerTimeSec(); } catch { return Math.floor(Date.now() / 1000); }
}

function serverSecToLocalMs(sec: number, nowMs: number = Date.now()): number {
    if (!(sec > 0)) return 0;
    return nowMs + (sec - serverNowSec()) * 1000;
}

/** farm/scheduler.ts 自动巡田（runFarmOperation 'all' 自动路径）结束时调用。 */
function recordFarmRound(input: { lands: any[]; hadWork: boolean; altHeld?: number; excludeLandIds?: number[] }): void {
    const now = Date.now();
    const { alt } = readConfigs();
    const matureSec = nextOwnMatureSec(input.lands, serverNowSec(), input.excludeLandIds || []);
    lastFarm = {
        atMs: now,
        epoch: idleEpoch,
        hadWork: !!input.hadWork,
        nextMatureAtMs: serverSecToLocalMs(matureSec, now),
        altHeld: Math.max(0, toNumber(input.altHeld)),
        altHolding: isAltHoldingForMaster(alt),
    };
    if (input.hadWork && idleUntil > now) {
        endIdle('自家农场有新动作');
        const listener = idleInterruptedListener;
        if (listener) setTimeout(() => { try { listener(); } catch { /* ignore */ } }, 0);
    }
}

/** friend/scheduler.ts 好友巡查算出本轮访问计划后调用。 */
function recordFriendRound(visits: number): void {
    lastFriend = { atMs: Date.now(), epoch: idleEpoch, visits: Math.max(0, toNumber(visits)) };
}

function isFnosIdleActive(nowMs: number = Date.now()): boolean {
    return idleUntil > nowMs;
}

function getFnosIdleUntil(): number {
    return idleUntil;
}

function endIdle(reason: string): void {
    if (idleUntil <= 0) return;
    idleUntil = 0;
    idleEpoch += 1;
    logInfo(`空闲静默结束（${reason}），恢复巡田和好友巡查`, { result: 'resume', reason });
}

function formatRemain(ms: number): string {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec} 秒`;
    const min = Math.floor(sec / 60);
    const rest = sec % 60;
    return rest ? `${min} 分 ${rest} 秒` : `${min} 分钟`;
}

/** 自家下一块作物成熟时间（毫秒）；小号留给大号时返回 0（不抢点）。 */
function ownPriorityMatureAt(nowMs: number = Date.now()): number {
    const { quiet } = readConfigs();
    if (!quiet.ownHarvestFirst || lastFarm.altHolding) return 0;
    const at = lastFarm.nextMatureAtMs;
    // 成熟后 8 秒还没有新的巡田记录，说明这一轮已经错过或失败了，交回常规间隔
    if (!(at > 0) || nowMs > at + OWN_YIELD_AFTER_MS) return 0;
    return at;
}

/** 好友巡查最早什么时候可以开始（自家成熟后 8 秒）；不在让路窗口返回 0。 */
function ownYieldResumeAt(nowMs: number = Date.now()): number {
    const at = ownPriorityMatureAt(nowMs);
    return inOwnYieldWindow(at, nowMs) ? at + OWN_YIELD_AFTER_MS : 0;
}

/** 好友 / 后台补数据是否应该给自家收菜让路。 */
function shouldYieldToOwnHarvest(nowMs: number = Date.now()): boolean {
    return inOwnYieldWindow(ownPriorityMatureAt(nowMs), nowMs);
}

/** 宠物同步等后台补数据：空闲静默或自家收菜窗口内跳过本轮。 */
function shouldPauseBackgroundSync(nowMs: number = Date.now()): boolean {
    return isFnosIdleActive(nowMs) || shouldYieldToOwnHarvest(nowMs);
}

/** 好友巡查访问下一位好友前调用：自家作物正在成熟时先等等（最多 30 秒）。 */
async function waitForOwnHarvestBeforeFriendVisit(canContinue: () => boolean = () => true): Promise<void> {
    const started = Date.now();
    let logged = false;
    while (canContinue() && shouldYieldToOwnHarvest() && Date.now() - started < FRIEND_YIELD_MAX_WAIT_MS) {
        if (!logged) {
            logged = true;
            try { require('../utils/utils').log('好友', '自己收菜优先：自家作物正在成熟，好友巡查暂停片刻', { module: 'friend', event: '自己收菜优先' }); } catch { /* ignore */ }
        }
        await new Promise(r => setTimeout(r, 500));
    }
}

/**
 * runFarmOperation 收获后调用：是否把补种并入下一轮。返回 true 时调用方跳过本轮的铲地 / 补种 / 施肥 / 升级。
 */
function shouldMergeReplantAfterHarvest(lands: any[], harvestedLandIds: number[]): { merge: boolean; matureInSec: number } {
    const { quiet, alt } = readConfigs();
    const nowSec = serverNowSec();
    const matureSec = nextOwnMatureSec(lands, nowSec, harvestedLandIds);
    const merge = planMergeAfterHarvest({
        enabled: quiet.ownHarvestFirst,
        altHolding: isAltHoldingForMaster(alt),
        harvestedCount: Array.isArray(harvestedLandIds) ? harvestedLandIds.length : 0,
        nextMatureAtMs: matureSec > 0 ? matureSec * 1000 : 0,
        nowMs: nowSec * 1000,
        windowSec: quiet.mergeWindowSec,
        streak: mergeStreak,
    });
    mergeStreak = merge ? mergeStreak + 1 : 0;
    return { merge, matureInSec: matureSec > 0 ? matureSec - nowSec : 0 };
}

function isFarmActive(): boolean {
    try {
        const store = require('../models/store');
        if (!store.isAutomationOn('farm')) return false;
        return !require('./friend/visit-strategy').inFarmQuietHours();
    } catch { return true; }
}

function isFriendActive(auto: any, alt: any): boolean {
    try {
        if (!auto || !auto.friend) return false;
        const anyOp = !!(auto.friend_help || auto.friend_steal || auto.friend_bad || (alt && alt.enabled && alt.badOnlyMaster));
        if (!anyOp) return false;
        return !require('./friend/visit-strategy').inFriendQuietHours();
    } catch { return true; }
}

/**
 * worker.ts scheduleUnifiedNextTick 里调用：根据两个功能调整下一次巡田 / 好友巡查时间。
 */
function adjustUnifiedSchedule(input: {
    nowMs: number; nextFarmRunAt: number; nextFriendRunAt: number;
    farmBusy: boolean; friendBusy: boolean; auto: any;
}): { nextFarmRunAt: number; nextFriendRunAt: number } {
    const now = input.nowMs;
    let nextFarmRunAt = input.nextFarmRunAt;
    let nextFriendRunAt = input.nextFriendRunAt;
    const { quiet, alt } = readConfigs();

    if (idleUntil > 0 && !quiet.idleKeepaliveOnly) endIdle('已关闭「空闲时只保留心跳」');
    if (idleUntil > now) {
        return { nextFarmRunAt: Math.max(nextFarmRunAt, idleUntil), nextFriendRunAt: Math.max(nextFriendRunAt, idleUntil) };
    }
    if (idleUntil > 0) {
        endIdle('静默时间到');
        return { nextFarmRunAt: now, nextFriendRunAt: now };
    }

    if (quiet.idleKeepaliveOnly && !input.farmBusy && !input.friendBusy) {
        const farmActive = isFarmActive();
        const friendActive = isFriendActive(input.auto, alt);
        const farmFresh = lastFarm.epoch === idleEpoch && now - lastFarm.atMs <= ROUND_FRESH_MS;
        const friendFresh = lastFriend.epoch === idleEpoch;
        const farmIdle = !farmActive || (farmFresh && !lastFarm.hadWork);
        const friendIdle = !friendActive || (friendFresh && lastFriend.visits === 0);
        const until = planIdleUntil({
            enabled: true,
            nowMs: now,
            farmIdle,
            friendIdle,
            nextOwnMatureAtMs: farmActive && lastFarm.nextMatureAtMs > now ? lastFarm.nextMatureAtMs : 0,
            altHeldCount: farmActive ? lastFarm.altHeld : 0,
            minMinutes: quiet.idleMinMinutes,
            maxMinutes: quiet.idleMaxMinutes,
        });
        if (until > now) {
            idleUntil = until;
            logInfo(`空闲：巡田和好友巡查都没有要做的事，只保留心跳 ${formatRemain(until - now)}${lastFarm.nextMatureAtMs > now ? '（自家作物成熟前 10 秒恢复）' : ''}`, { result: 'idle', sleepMs: until - now, until });
            return { nextFarmRunAt: Math.max(nextFarmRunAt, until), nextFriendRunAt: Math.max(nextFriendRunAt, until) };
        }
    }

    const matureAt = input.auto && input.auto.farm ? ownPriorityMatureAt(now) : 0;
    if (matureAt > 0) {
        const wakeAt = matureAt + OWN_WAKE_AFTER_MS;
        if (wakeAt > now && wakeAt < nextFarmRunAt) nextFarmRunAt = wakeAt;
        // 好友巡查不在自家成熟窗口里开始
        if (inOwnYieldWindow(matureAt, nextFriendRunAt) || (inOwnYieldWindow(matureAt, now) && nextFriendRunAt <= now)) {
            nextFriendRunAt = Math.max(nextFriendRunAt, matureAt + OWN_YIELD_AFTER_MS);
        }
    }
    return { nextFarmRunAt, nextFriendRunAt };
}

/** 设置下发后调用（fnos-fork-config onWorkerConfigApplied）：本设置变了就结束当前静默。 */
function onFnosQuietConfigApplied(): void {
    const { quiet } = readConfigs();
    const key = JSON.stringify(quiet);
    if (lastConfigKey && key !== lastConfigKey) {
        endIdle('设置已更新');
        mergeStreak = 0;
    }
    lastConfigKey = key;
}

function describeFnosQuietPriority(q: FnosQuietPriorityConfig): string {
    const own = q.ownHarvestFirst
        ? `自己收菜优先已启用（成熟时精确巡田、好友巡查让路${q.mergeWindowSec > 0 ? `、${q.mergeWindowSec} 秒内连续成熟合并补种` : ''}；开启「先留给大号偷」的小号不生效）`
        : '自己收菜优先未启用';
    const idle = q.idleKeepaliveOnly
        ? `空闲时只保留心跳已启用（每次静默 ${q.idleMinMinutes}～${q.idleMaxMinutes} 分钟，自家作物成熟前 10 秒恢复）`
        : '空闲时只保留心跳未启用';
    return `${own}；${idle}`;
}

module.exports = {
    DEFAULT_FNOS_QUIET_PRIORITY,
    normalizeFnosQuietPriority,
    nextOwnMatureSec,
    isAltHoldingForMaster,
    inOwnYieldWindow,
    planMergeAfterHarvest,
    planIdleUntil,
    recordFarmRound,
    recordFriendRound,
    isFnosIdleActive,
    getFnosIdleUntil,
    endIdle,
    ownPriorityMatureAt,
    shouldYieldToOwnHarvest,
    ownYieldResumeAt,
    setIdleInterruptedListener,
    shouldPauseBackgroundSync,
    waitForOwnHarvestBeforeFriendVisit,
    shouldMergeReplantAfterHarvest,
    adjustUnifiedSchedule,
    onFnosQuietConfigApplied,
    describeFnosQuietPriority,
    resetFnosQuietRuntime,
    MIN_IDLE_MS,
    ALT_HELD_RECHECK_MS,
    MAX_MERGE_STREAK,
};
