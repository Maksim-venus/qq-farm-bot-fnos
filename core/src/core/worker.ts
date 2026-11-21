export {};
/**
 * 子进程 Worker - 负责运行单个账号的挂机逻辑
 */
const { parentPort, workerData } = require('node:worker_threads');

const { CONFIG, updateRuntimeConfig } = require('../config/config');
const { getLevelExpProgress, loadConfigs } = require('../config/gameConfig');
const { getAutomation, getPreferredSeed, getConfigSnapshot, applyConfigSnapshot } = require('../models/store');
const { checkAndClaimEmails, configureEmailClaim, getEmailDailyState } = require('../services/email');
const { checkFarm, startFarmCheckLoop, stopFarmCheckLoop, refreshFarmCheckLoop, getLandsDetail, getAvailableSeeds, purchaseSeed, runFarmOperation, runFertilizerByConfig, fertilizeOwnLand } = require('../services/farm');
const { checkFriends, startFriendCheckLoop, stopFriendCheckLoop, refreshFriendCheckLoop, getFriendsList, getFriendsListCacheOnly, getFriendLandsDetail, doFriendOperation, deleteFriend } = require('../services/friend');
const { getInteractRecords } = require('../services/interact');
const { processInviteCodes } = require('../services/invite');
const { autoBuyFertilizer, checkAndBuyFertilizerBoth, buyFreeGifts, getFreeGiftDailyState } = require('../services/mall');
const { performDailyMonthCardGift, getMonthCardDailyState } = require('../services/monthcard');
const { performDailyVipGift, getVipDailyState } = require('../services/qqvip');
const { runExclusiveAutomationTask, isAutomationTaskRunning } = require('../services/automation-lock');
const ranchAutomation = require('../services/ranch/automation');
const { isRanchMarketEnabled, RANCH_MARKET_SWITCH_BY_CURRENCY } = require('../config/ranch-automation');
const { createScheduler, getSchedulerRegistrySnapshot } = require('../services/scheduler');
const { checkDailyShareStatus, getShareDailyState } = require('../services/share');
const { refreshActivityWindows } = require('../services/activity-windows');
const { resetSessionGains, recordOperation, initStatsWithPersistence, saveStats } = require('../services/stats');
const { initStatusBar, setStatusPlatform, statusData } = require('../services/status');
const { setRecordGoldExpHook } = require('../services/status');
const { cleanupTaskSystem, checkAndClaimTasks, getTaskClaimDailyState, getTaskDailyStateLikeApp, getGrowthTaskStateLikeApp } = require('../services/task');
const {
    sellAllFruits,
    getBag,
    getBagItems,
    openFertilizerGiftPacksSilently,
    openCharitySettlementGiftPacksSilently,
} = require('../services/warehouse');
const { checkAndClaimDogSkillGifts } = require('../services/dog-skill-gifts');
const { isGatewayHealthyForBusiness, nextBusinessBackoffMs } = require('../utils/low-priority-gate');
const { connect, cleanup, getWs, getUserState, networkEvents, getGatewayLoad } = require('../utils/network');
const { loadProto } = require('../utils/proto');
const { runWithRequestClass } = require('../utils/request-context');
const { setLogHook, log, logWarn, toNum, getSystemDateKey, formatSystemDateTime24 } = require('../utils/utils');

// Extend CONFIG with the unified friend-task interval used by this worker.
interface WorkerRuntimeConfig {
    friendCheckIntervalMin: number;
    friendCheckIntervalMax: number;
    [key: string]: any;
}

const workerConfig = CONFIG as WorkerRuntimeConfig;

if (parentPort && workerData && workerData.accountId && !process.env.FARM_ACCOUNT_ID) {
    process.env.FARM_ACCOUNT_ID = String(workerData.accountId);
}

function sendToMaster(payload: Record<string, any>): void {
    if (process.send) {
        process.send(payload);
        return;
    }
    if (parentPort) {
        parentPort.postMessage(payload);
    }
}

function onMasterMessage(handler: (msg: any) => void): void {
    if (process.send) {
        process.on('message', handler);
    }
    if (parentPort) {
        parentPort.on('message', handler);
    }
}

function exitWorker(code: number = 0): void {
    if (parentPort) {
        try {
            parentPort.close();
        } catch {}
        return;
    }
    process.exit(code);
}

// 捕获日志发送给主进程
setLogHook((tag: string, msg: string, isWarn: boolean, meta: any) => {
    sendToMaster({
        type: 'log',
        data: {
            time: formatSystemDateTime24(),
            tag,
            msg,
            isWarn,
            meta: meta || {},
        }
    });
});

// 捕获金币经验变化
setRecordGoldExpHook((gold: number, exp: number) => {
    // 更新内部统计
    const { recordGoldExp } = require('../services/stats');
    recordGoldExp(gold, exp);

    // 发送给主进程
    sendToMaster({ type: 'stat_update', data: { gold, exp } });
});

let isRunning: boolean = false;
let loginReady: boolean = false;
let appliedConfigRevision: number = 0;
let unifiedSchedulerRunning: boolean = false;
let unifiedTickGeneration: number | null = null;
let farmTaskRunning: boolean = false;
let nextFarmRunAt: number = 0;
let friendTaskRunning: boolean = false;
let nextFriendRunAt: number = 0;
// 网关卡住时各定时任务的退避时长（毫秒），0 表示按正常间隔跑
const businessBackoffMs: Record<string, number> = { farm: 0, friend: 0, ranch: 0 };
let lastStatusHash: string = '';
let lastStatusSentAt: number = 0;
let onSellGain: ((deltaGold: any) => void) | null = null;
let onFarmHarvested: (() => Promise<void>) | null = null;
let onDogSkillGiftPending: ((count: any) => void) | null = null;
let harvestSellRunning: boolean = false;
let onWsError: ((payload: any) => void) | null = null;
let onDisconnected: ((payload: any) => void) | null = null;
let wsErrorHandledAt: number = 0;
let shutdownStarted: boolean = false;
let runtimeGeneration: number = 0;
let lastDailyRunDate: string = '';
let ranchRoutineQueued = false;
// [fnos-fork] 上游 #148 的 initialFarmCheckDone / initialFriendCheckDone / ranchDeferredUntil（牧场等首轮农场、好友巡查和低优先级闸门）不引入：何时进牧场由农牧轮流 fnos-turns 决定

function ranchNextRunAt(): number {
    if (ranchRoutineQueued) return Infinity;
    if (fnosQuietPriority().isFnosIdleActive()) return Infinity; // [fnos-fork] 空闲时只保留心跳：静默期间牧场自动化也暂停
    const state = ranchAutomation.getRoutineState();
    if (state.doneToday) return Infinity;
    // [fnos-fork] 2026-11-17 严格交替：牧场一轮做完立即可进（每边至少 1 分钟由 fnos-turns 控制；让路后 3 秒续跑），ranch_check_minutes 不再是进牧场的门槛
    return state.reentryAt !== undefined ? Number(state.reentryAt) || 0 : state.nextCheckAt;
}

// ============ [fnos-fork] 2026-11-17 农场、牧场轮流（services/fnos-turns.ts）+ 好友时间表（services/fnos-timetable.ts） ============
// 严格交替：农场一轮（巡田 + 到点的好友巡查）做完 → 牧场一轮 → 回农场。
// 插队：自家作物到期前 ownLeadSec 秒（默认 2）回农场等着收；自家动物 / 升级 / 等大号到期前同样提前进牧场；
//       好友时间表到点（好友作物成熟 / 需要帮忙）直接去该好友；好友牧场时间表到点先进牧场去偷。
const fnosTurns = require('../services/fnos-turns');
let fnosLastInsertLog = '';
let fnosFarmTickRan = false;
/** 已经提前蹲点收过的自家成熟时间（同一个成熟点只蹲一次，之后交回常规节奏，避免反复巡田） */
let fnosOwnWaitedFor = 0;
let fnosRanchLastEndAt = 0;
/** 好友时间表到点但这次没去成（好友静默时段 / 都被规则过滤）时，1 分钟内不再插队，避免空转和牧场反复让路 */
let fnosFriendTimedHoldUntil = 0;
/** [fnos-fork] 2026-11-17 自家巡田一轮做完后，有要探的好友农场（未扫描 / 空地到复查时间）→ 立刻做一次好友农场状态轮巡 */
let fnosProbeWanted = false;
function fnosHasFarmProbeWork(): boolean {
    const auto = getAutomation();
    if (!auto.friend || !auto.friend_steal) return false;
    try { if (require('../services/friend/visit-strategy').inFriendQuietHours()) return false; } catch { /* ignore */ }
    try { return !!fnosTimetable().hasFarmProbeWork(getFriendsListCacheOnly()); } catch { return false; }
}
const FNOS_TT_NOOP = {
    isEnabled: () => false, hasFarmProbeWork: () => false, farmDueTime: () => 0, ranchDueTime: () => 0, ownLeadMs: () => 2000, scanIntervalMs: () => 0,
    miscShouldWait: () => false, setBusyProbe: () => {}, formatClock: () => '', flushNow: () => {}, resetTimetableRuntime: () => {},
};
function fnosTimetable(): any {
    try {
        const m = require('../services/fnos-timetable');
        if (m && typeof m.farmDueTime === 'function') return m;
    } catch { /* ignore */ }
    return FNOS_TT_NOOP; // 上游测试用替身 require 加载 worker 时没有这个模块
}
function fnosSleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, Math.max(0, ms))); }

/** 自家作物成熟时间（自己收菜优先开着时）；0 = 无 */
function fnosOwnMatureAt(nowMs: number): number {
    if (!getAutomation().farm) return 0;
    return Number(fnosQuietPriority().ownPriorityMatureAt(nowMs)) || 0;
}

/** 农场插队时间点：自家作物成熟前 ownLeadSec 秒（进去等着收）；同一成熟点蹲过了就不再插队；0 = 无 */
function fnosFarmTimedAt(nowMs: number): number {
    const matureAt = fnosOwnMatureAt(nowMs);
    if (!(matureAt > 0) || fnosOwnWaitedFor === matureAt) return 0;
    return Math.max(0, matureAt - fnosTimetable().ownLeadMs()) || 1;
}

/** 好友时间表插队时间点（好友作物成熟 / 需要帮忙）；好友 / 偷 / 帮都关着返回 0 */
function fnosFriendTimedAt(): number {
    const auto = getAutomation();
    if (!auto.friend || (!auto.friend_steal && !auto.friend_help)) return 0;
    try { if (require('../services/friend/visit-strategy').inFriendQuietHours()) return 0; } catch { /* ignore */ }
    const at = Number(fnosTimetable().farmDueTime()) || 0;
    return at > 0 ? Math.max(at, fnosFriendTimedHoldUntil) : 0;
}

/** 牧场插队时间点：自家动物 / 升级 / 等大号到期前 ownLeadSec 秒，或好友牧场时间表到点；牧场例程排队中 / 今天无事返回 0 */
function fnosRanchTimedAt(): number {
    if (!Number.isFinite(ranchNextRunAt())) return 0;
    const own = typeof ranchAutomation.timedWakeAt === 'function' ? Number(ranchAutomation.timedWakeAt()) || 0 : 0;
    const ownAt = own > 0 ? own - fnosTimetable().ownLeadMs() : 0;
    const friendActive = typeof ranchAutomation.friendTimetableActive === 'function' ? ranchAutomation.friendTimetableActive() : false;
    const friendAt = friendActive ? Number(fnosTimetable().ranchDueTime()) || 0 : 0;
    const pendingAt = typeof ranchAutomation.hasPendingDueFriends === 'function' && ranchAutomation.hasPendingDueFriends() ? ranchNextRunAt() : 0;
    const at = [ownAt, friendAt, pendingAt].filter(v => v > 0);
    if (!at.length) return 0;
    return Math.max(Math.min(...at), fnosRanchLastEndAt + 3000);
}

function fnosRanchHasWork(): boolean {
    try { return !ranchAutomation.getRoutineState().doneToday; } catch { return false; }
}

function fnosFriendPending(nowMs: number): boolean {
    return !!getAutomation().friend && (friendTaskRunning || nowMs >= nextFriendRunAt || fnosProbeWanted);
}

function fnosEvaluateTurn(nowMs: number): void {
    try {
        const ownRanchAt = typeof ranchAutomation.timedWakeAt === 'function' ? Number(ranchAutomation.timedWakeAt()) || 0 : 0;
        fnosTurns.evaluateTurn({
            nowMs, ranchDue: nowMs >= ranchNextRunAt(), ranchHasWork: fnosRanchHasWork(), friendActive: !!getAutomation().friend, friendPending: fnosFriendPending(nowMs),
            ownFarmAt: fnosOwnMatureAt(nowMs), ownRanchAt,
        });
    } catch { /* ignore */ }
}

function fnosLogInsert(key: string, msg: string, space: 'farm' | 'ranch'): void {
    if (fnosLastInsertLog === key) return;
    fnosLastInsertLog = key;
    if (space === 'farm') log('轮次', msg, { module: 'system', event: 'fnos轮次插队' });
    else log('牧场', msg, { module: 'ranch', event: 'fnos牧场轮次', result: 'insert' });
}

// 上游 #167：粑粑/松果到账只唤醒对应兑换开关（[fnos-fork] 何时进牧场仍由农牧轮流决定）
function wakeRanchMarketExchange({ id }: { id: 7002 | 1008 }): void {
    if (!loginReady) return;
    const auto = getAutomation();
    if ((auto[RANCH_MARKET_SWITCH_BY_CURRENCY[id]] ?? auto.ranch_market_organic) !== true) return;
    ranchAutomation.requestMarketCheck();
    scheduleUnifiedNextTick();
}

function onRanchMarketVisitChanged(rotation: any): void {
    if (!loginReady || !isRanchMarketEnabled(getAutomation())) return;
    if (ranchAutomation.noteMarketVisit(rotation)) scheduleUnifiedNextTick();
}

function onRanchBookReward(kind: 'normal' | 'giant', available: boolean): void {
    if (ranchAutomation.noteBookReward(kind, available) && loginReady && getAutomation().ranch_illustrated) scheduleUnifiedNextTick();
}

function onRanchFacilitiesChanged(facilities: any[]): void {
    if (!loginReady || !getAutomation().ranch_activate_shed) return;
    if (ranchAutomation.noteRanchFacilities(facilities)) scheduleUnifiedNextTick();
}

function runRanchRoutine(detached = false): Promise<void> {
    // 牧场今天无事 / 例程排队中 / 空闲静默：不跑
    if (!loginReady || !Number.isFinite(ranchNextRunAt())) return Promise.resolve();
    const now = Date.now();
    // [fnos-fork] 农牧轮流：牧场轮（过了场景重进间隔）或牧场定时事件插队时跑
    const ranchTimedAt = fnosRanchTimedAt();
    const timedDue = ranchTimedAt > 0 && now >= ranchTimedAt;
    const ranchTurn = fnosTurns.currentTurn() === 'ranch';
    const insert = !ranchTurn && timedDue;
    // 牧场轮这一轮已做完、在等满 1 分钟时不重跑，只处理插队（自家动物到期 / 好友牧场时间表）
    const roundDone = ranchTurn && typeof fnosTurns.ranchRoundDone === 'function' && fnosTurns.ranchRoundDone();
    if (ranchTurn ? ((roundDone || now < ranchNextRunAt()) && !timedDue) : !insert) return Promise.resolve();
    const generation = runtimeGeneration;
    ranchRoutineQueued = true;
    return runExclusiveAutomationTask('ranch_routine', async () => {
        if (!loginReady || generation !== runtimeGeneration) return;
        if (fnosQuietPriority().isFnosIdleActive()) return; // [fnos-fork]
        const state = ranchAutomation.getRoutineState();
        if (state.doneToday) {
            if (ranchTurn) fnosTurns.noteRanchRun('skipped'); // [fnos-fork]
            return;
        }
        // [fnos-fork] 2026-11-17 自家动物 / 升级到期前提前进来：等到点再开始，到点立即收
        const own = typeof ranchAutomation.timedWakeAt === 'function' ? Number(ranchAutomation.timedWakeAt()) || 0 : 0;
        const lead = fnosTimetable().ownLeadMs();
        if (own > Date.now() && own - Date.now() <= lead + 1000) {
            if (insert) fnosLogInsert(`ranch:${own}`, `插队：自家牧场 ${fnosTimetable().formatClock(own)} 到期，提前 ${Math.round(lead / 1000)} 秒进牧场等着收，处理完回到农场`, 'ranch');
            await fnosSleep(own - Date.now() + 150);
        } else if (insert) {
            fnosLogInsert(`ranch:${ranchTimedAt}`, '插队：好友牧场按时间表到点 / 等大号到点，农场轮次中先处理牧场，处理完回到农场', 'ranch');
        }
        // [fnos-fork] 牧场轮：一轮做完，只为插队（自家作物将熟 / 好友时间表到点）让路；
        // 农场轮里插队进来的牧场最多连续做 60 秒，同样为自家作物 / 好友时间表让路
        const deadline = () => Math.min(fnosFarmTimedAt(Date.now()) || Infinity, friendTaskRunning ? Infinity : (fnosFriendTimedAt() || Infinity));
        // 上游 #148：牧场请求按 friend 类排队，网关不健康时让路（canContinue）
        const canContinue = () => loginReady && generation === runtimeGeneration && isGatewayHealthyForBusiness(getGatewayLoad());
        const status = await runWithRequestClass('friend', () => ranchAutomation.run(ranchTurn
            ? { sliceMs: Number.POSITIVE_INFINITY, farmDeadline: deadline, canContinue }
            : { sliceMs: 60_000, farmDeadline: deadline, canContinue }));
        if (ranchTurn && !roundDone) fnosTurns.noteRanchRun(String(status || 'done')); // [fnos-fork]
    }, { detached }).finally(() => {
        ranchRoutineQueued = false;
        fnosRanchLastEndAt = Date.now();
        scheduleUnifiedNextTick();
    });
}
const workerScheduler = createScheduler('worker');
// [fnos-fork] 2026-11-16 自己收菜优先 / 空闲时只保留心跳（延迟加载，见 services/fnos-quiet-priority.ts）
const FNOS_QUIET_NOOP = {
    isFnosIdleActive: () => false, getFnosIdleUntil: () => 0, shouldYieldToOwnHarvest: () => false, ownYieldResumeAt: () => 0,
    ownPriorityMatureAt: () => 0, resetFnosQuietRuntime: () => {}, setIdleInterruptedListener: () => {},
    adjustUnifiedSchedule: (x: any) => ({ nextFarmRunAt: x.nextFarmRunAt, nextFriendRunAt: x.nextFriendRunAt }),
};
function fnosQuietPriority(): any {
    try {
        const m = require('../services/fnos-quiet-priority');
        if (m && typeof m.isFnosIdleActive === 'function') return m;
    } catch { /* ignore */ }
    return FNOS_QUIET_NOOP; // 上游测试用替身 require 加载 worker 时没有这个模块
}

async function runDailyRoutines(force: boolean = false): Promise<void> {
    if (!loginReady) return;
    try {
        await checkAndClaimEmails();
        await openCharitySettlementGiftPacksSilently();
        await checkDailyShareStatus(force);
        await performDailyMonthCardGift(force);
        await buyFreeGifts(force);
        await performDailyVipGift(force);
    } catch (e: any) {
        log('系统', `每日任务调度失败: ${e.message}`, { module: 'system', event: '每日任务', result: 'error' });
    }
}

function stopDailyRoutineTimer(): void {
    workerScheduler.clear('daily_routine_interval');
}

function startDailyRoutineTimer(runImmediately: boolean = true): void {
    stopDailyRoutineTimer();
    lastDailyRunDate = getSystemDateKey();
    // 登录时检查日常任务，邮箱仍遵守配置的领取时间。
    if (runImmediately) runExclusiveAutomationTask('daily_routines', () => runDailyRoutines(true)).catch(() => null);
    workerScheduler.setIntervalTask('daily_routine_interval', 30 * 1000, () => {
        if (!loginReady) return;
        if (fnosQuietPriority().isFnosIdleActive()) return; // [fnos-fork] 空闲时只保留心跳：静默期间牧场例程、每日任务都暂停，结束后的下一次检查再补做
        void runRanchRoutine(true).catch((error: any) => logWarn('牧场', `牧场例程失败：${error.message}`));
        if (fnosTimetable().miscShouldWait()) return; // [fnos-fork] 2026-11-17 每日福利 / 邮件是杂项：有收获 / 偷菜 / 帮忙即将到点时下次再查
        const today = getSystemDateKey();
        if (today === lastDailyRunDate) {
            const email = getEmailDailyState();
            if (!email.doneToday && email.result !== 'running' && Date.now() >= email.nextCheckAt) {
                runExclusiveAutomationTask('email_claim', async () => {
                    if (loginReady) await checkAndClaimEmails();
                }).catch(() => null);
            }
            return;
        }
        lastDailyRunDate = today;
        try { require('../services/friend/scheduler').checkDailyReset(); } catch { /* ignore */ } // [fnos-fork] 北京时间 0 点清空农场帮忙/捣乱次数缓存，下次从服务端重读当日余额
        runExclusiveAutomationTask('daily_routines', () => runDailyRoutines(true)).catch(() => null);
    });
}

function normalizeIntervalRangeSec(minSec: any, maxSec: any, fallbackSec: any): { min: number; max: number } {
    const fallback = Math.max(1, Number.parseInt(fallbackSec, 10) || 1);
    let min = Math.max(1, Number.parseInt(minSec, 10) || fallback);
    let max = Math.max(1, Number.parseInt(maxSec, 10) || fallback);
    if (min > max) [min, max] = [max, min];
    return { min, max };
}

function applyIntervalsToRuntime(intervals: any): void {
    const data = (intervals && typeof intervals === 'object') ? intervals : {};

    const farmLegacy = Math.max(1, Number.parseInt(data.farm, 10) || 2);
    const farmRange = normalizeIntervalRangeSec(data.farmMin, data.farmMax, farmLegacy);
    CONFIG.farmCheckIntervalMin = farmRange.min * 1000;
    CONFIG.farmCheckIntervalMax = farmRange.max * 1000;
    CONFIG.farmCheckInterval = CONFIG.farmCheckIntervalMin;

    // 好友帮助、偷菜、放虫放草共用一个好友任务间隔。
    const helpMin = Number.parseInt(data.helpMin, 10) || 12;
    const helpMax = Number.parseInt(data.helpMax, 10) || 15;
    const stealMin = Number.parseInt(data.stealMin, 10) || 12;
    const stealMax = Number.parseInt(data.stealMax, 10) || 15;
    const friendMin = data.friendMin ?? Math.min(helpMin, stealMin);
    const friendMax = data.friendMax ?? Math.min(helpMax, stealMax);
    const friendRange = normalizeIntervalRangeSec(friendMin, friendMax, 12);
    workerConfig.friendCheckIntervalMin = friendRange.min * 1000;
    workerConfig.friendCheckIntervalMax = friendRange.max * 1000;
}

function randomIntervalMs(minMs: number, maxMs: number): number {
    const minSec = Math.max(1, Math.floor(Math.max(1000, Number(minMs) || 1000) / 1000));
    const maxSec = Math.max(minSec, Math.floor(Math.max(1000, Number(maxMs) || minSec * 1000) / 1000));
    if (maxSec === minSec) return minSec * 1000;
    const sec = minSec + Math.floor(Math.random() * (maxSec - minSec + 1));
    return sec * 1000;
}

function resetUnifiedSchedule(): void {
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    const friendMs = randomIntervalMs(
        workerConfig.friendCheckIntervalMin || 12000,
        workerConfig.friendCheckIntervalMax || 15000
    );
    const now = Date.now();
    nextFarmRunAt = now + farmMs;
    nextFriendRunAt = now + friendMs;
    businessBackoffMs.farm = 0;
    businessBackoffMs.friend = 0;
}

const BUSINESS_TICK_LABEL: Record<string, string> = { farm: '农场定时任务', friend: '好友定时任务', ranch: '牧场定时任务' };

function describeGatewayStall(load: any): string {
    const parts: string[] = [];
    const misses = Number(load && load.heartbeatMisses) || 0;
    const oldest = Number(load && load.oldestPendingAgeMs) || 0;
    if (misses > 0) parts.push(`心跳漏 ${misses} 次`);
    if (oldest > 0) parts.push(`最老在途 ${(oldest / 1000).toFixed(1)}s`);
    parts.push(`pending=${Number(load && load.pending) || 0}`);
    parts.push(`queued=${Number(load && load.queued) || 0}`);
    return parts.join(', ');
}

/**
 * 网关卡住（心跳漏拍或有在途请求超过 5 秒没回包）时定时任务整轮让路，把连接留给心跳和 ACE 上报。
 * 返回本轮需要推迟的毫秒数，0 表示可以正常跑。日志只在进入/退出退避时各打一次，避免刷屏。
 */
function nextBusinessTickDeferMs(kind: string): number {
    const load = getGatewayLoad();
    if (isGatewayHealthyForBusiness(load)) {
        if (businessBackoffMs[kind] > 0) {
            businessBackoffMs[kind] = 0;
            log('系统', `网关已恢复，${BUSINESS_TICK_LABEL[kind]}回到正常间隔`, {
                module: 'system',
                event: '网关退避',
                result: 'resume',
                requestClass: kind,
            });
        }
        return 0;
    }

    const firstDefer = businessBackoffMs[kind] === 0;
    const backoffMs = nextBusinessBackoffMs(businessBackoffMs[kind]);
    businessBackoffMs[kind] = backoffMs;
    if (firstDefer) {
        logWarn('系统', `网关无回包，${BUSINESS_TICK_LABEL[kind]}退避 ${Math.round(backoffMs / 1000)}s (${describeGatewayStall(load)})`, {
            module: 'system',
            event: '网关退避',
            result: 'defer',
            requestClass: kind,
            backoffMs,
        });
    }
    return backoffMs;
}

async function runFarmTick(auto: any): Promise<void> {
    if (farmTaskRunning) return;
    const farmDeferMs = nextBusinessTickDeferMs('farm');
    if (farmDeferMs > 0) {
        nextFarmRunAt = Date.now() + farmDeferMs;
        return;
    }
    farmTaskRunning = true;
    fnosFarmTickRan = true; // [fnos-fork] 农牧轮流：本次巡田真的跑了（没被网关退避跳过）
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    try {
        // 自己农场的定时任务统一挂在 farm 班次：优先级高于好友任务，低于用户前台操作。
        await runWithRequestClass('farm', async () => {
            if (auto.farm) await checkFarm();
            // [fnos-fork] 2026-11-17 任务 / 礼包是杂项：30 秒内有收获 / 偷菜 / 帮忙到点就留到下一次空闲巡田
            if (!fnosTimetable().miscShouldWait()) {
                if (auto.task) await checkAndClaimTasks();
                if (auto.email !== false) await openCharitySettlementGiftPacksSilently();
                if (auto.fertilizer_gift) await openFertilizerGiftPacksSilently();
            }
        });
    } catch {
        // ignore
    } finally {
        nextFarmRunAt = Date.now() + farmMs;
        farmTaskRunning = false;
    }
}

// ============ 好友统一任务：偷菜、帮助、放虫放草 ============
async function runFriendTick(auto: any): Promise<void> {
    if (friendTaskRunning) return;
    const generation = runtimeGeneration;
    // [fnos-fork] 2026-11-17 按时间表偷菜开着时：好友列表每 friendScanMinutes 分钟扫一次，中间靠时间表到点直接去
    const fnosScanMs = Number(fnosTimetable().scanIntervalMs()) || 0;
    const friendMs = fnosScanMs > 0 ? fnosScanMs : randomIntervalMs(
        workerConfig.friendCheckIntervalMin || 12000,
        workerConfig.friendCheckIntervalMax || 15000
    );
    // friend 总开关仍控制好友任务总入口；关闭时也要推进到期时间，避免调度器每秒空转。
    if (!auto.friend) {
        nextFriendRunAt = Date.now() + friendMs;
        return;
    }

    const friendDeferMs = nextBusinessTickDeferMs('friend');
    if (friendDeferMs > 0) {
        nextFriendRunAt = Date.now() + friendDeferMs;
        return;
    }

    friendTaskRunning = true;
    try {
        // checkFriends 内部保留各自开关、经验上限、黑名单和每日捣乱次数判断。
        // 好友农场任务排在自己农场之后，前台操作永远优先于它。
        await runWithRequestClass('friend', () => checkFriends());
    } catch (e: any) {
        log('系统', `好友统一任务执行失败: ${e.message}`, { module: 'system', event: '好友统一任务', result: 'error' });
    } finally {
        if (generation === runtimeGeneration) {
            nextFriendRunAt = Date.now() + friendMs;
            friendTaskRunning = false;
                fnosTurns.noteFriendDone(); // [fnos-fork] 农牧轮流：农场轮的好友巡查做完
            scheduleUnifiedNextTick();
        }
    }
}

// [fnos-fork] 2026-11-17 好友时间表到点：直接去到点的好友（不拉列表、不捣乱），常规巡查正在跑时由巡查自己插队处理
async function runFriendTimetableTick(auto: any): Promise<void> {
    if (friendTaskRunning || !auto.friend) return;
    const generation = runtimeGeneration;
    friendTaskRunning = true;
    try {
        await runWithRequestClass('friend', () => checkFriends({ fnosTimetable: true }));
        // 这次没取走到点的好友（静默时段 / 正在巡查 / 规则过滤）：1 分钟内不再插队
        const left = Number(fnosTimetable().farmDueTime()) || 0;
        if (left > 0 && left <= Date.now()) fnosFriendTimedHoldUntil = Date.now() + 60_000;
    } catch (e: any) {
        log('系统', `好友时间表任务执行失败: ${e.message}`, { module: 'system', event: '好友统一任务', result: 'error' });
    } finally {
        if (generation === runtimeGeneration) {
            friendTaskRunning = false;
            scheduleUnifiedNextTick();
        }
    }
}

// [fnos-fork] 2026-11-17 好友农场状态轮巡：自家巡田一轮做完后立刻进好友家读成熟时间（跳过已知时间的，翻阅节奏见 fnos-timetable）
async function runFriendProbeTick(auto: any): Promise<void> {
    if (friendTaskRunning || !auto.friend) { fnosProbeWanted = false; return; }
    const generation = runtimeGeneration;
    friendTaskRunning = true;
    try {
        await runWithRequestClass('friend', () => checkFriends({ fnosProbeRound: true }));
    } catch (e: any) {
        log('系统', `好友状态轮巡失败: ${e.message}`, { module: 'system', event: '好友统一任务', result: 'error' });
    } finally {
        fnosProbeWanted = false;
        if (generation === runtimeGeneration) {
            friendTaskRunning = false;
            fnosTurns.noteFriendDone();
            scheduleUnifiedNextTick();
        }
    }
}

async function runUnifiedTick(): Promise<void> {
    if (!unifiedSchedulerRunning || !loginReady) return;
    // [fnos-fork] 空闲时只保留心跳：静默期间巡田、好友巡查都不跑（心跳在 network 里独立维持）
    if (fnosQuietPriority().isFnosIdleActive()) return;
    const generation = runtimeGeneration;
    const now = Date.now();
    // [fnos-fork] 2026-11-17 农牧轮流：先判断轮次，再看本轮允许谁跑（插队除外）
    fnosEvaluateTurn(now);
    const farmTimedAt = fnosFarmTimedAt(now);
    const ranchTimedAt = fnosRanchTimedAt();
    const friendTimedAt = fnosFriendTimedAt();
    const farmTimedDue = farmTimedAt > 0 && now >= farmTimedAt;
    const ranchTimedDue = ranchTimedAt > 0 && now >= ranchTimedAt;
    const allow = fnosTurns.allowedNow({ farmTimedDue, ranchTimedDue, friendTimedDue: friendTimedAt > 0 && now >= friendTimedAt });
    // [fnos-fork] 自家作物到期前 ownLeadSec 秒：不管常规间隔，进去等着收
    const dueFarm = allow.farm && (now >= nextFarmRunAt || farmTimedDue);
    let dueFriend = allow.friend && now >= nextFriendRunAt;
    // [fnos-fork] 自己收菜优先：自家作物正在成熟时，好友巡查推到收完之后
    if (dueFriend && !friendTaskRunning && fnosQuietPriority().shouldYieldToOwnHarvest(now)) {
        nextFriendRunAt = Math.max(nextFriendRunAt, fnosQuietPriority().ownYieldResumeAt(now));
        dueFriend = now >= nextFriendRunAt;
    }
    const dueFriendTimed = allow.friendInsert && !friendTaskRunning;
    if (!dueFarm && !dueFriend && !dueFriendTimed && !(allow.ranch && (now >= ranchNextRunAt() || ranchTimedDue))) return;

    const auto = getAutomation();
    // 好友按单次访问持锁，等待间隔不阻塞后续农场巡查。
    if (dueFarm) {
        const ownMatureAt = farmTimedDue ? fnosOwnMatureAt(now) : 0;
        if (allow.farmInsert) fnosLogInsert(`farm:${farmTimedAt}`, `插队：自家作物 ${fnosTimetable().formatClock(ownMatureAt)} 成熟，提前回农场等着收，收完回到牧场`, 'farm'); // [fnos-fork]
        fnosFarmTickRan = false;
        if (ownMatureAt > 0) fnosOwnWaitedFor = ownMatureAt;
        await runExclusiveAutomationTask('farm_tick', async () => {
            // [fnos-fork] 2026-11-17 提前进来等：到成熟后 0.2 秒立即巡田收获
            if (ownMatureAt > Date.now()) await fnosSleep(ownMatureAt - Date.now() + 200);
            return runFarmTick(auto);
        });
        if (fnosFarmTickRan && !allow.farmInsert) {
            fnosTurns.noteFarmTickDone(); // [fnos-fork] 农场轮的常规巡田做完
            if (!fnosProbeWanted) fnosProbeWanted = fnosHasFarmProbeWork(); // [fnos-fork] 2026-11-17 轮完自己的，立刻轮好友农场状态
        }
    }
    if (!unifiedSchedulerRunning || !loginReady || generation !== runtimeGeneration) return;
    if (dueFriend && !friendTaskRunning) void runFriendTick(auto);
    else if (dueFriendTimed && !friendTaskRunning) void runFriendTimetableTick(auto); // [fnos-fork] 好友时间表到点（任何轮次都插队）
    else if (fnosProbeWanted && allow.friend && !friendTaskRunning) void runFriendProbeTick(auto); // [fnos-fork] 2026-11-17 好友农场状态轮巡
    fnosEvaluateTurn(Date.now()); // [fnos-fork] 农场一轮做完可能马上轮到牧场
    void runRanchRoutine(true).catch((error: any) => logWarn('牧场', `牧场例程失败：${error.message}`));
}

function scheduleUnifiedNextTick(): void {
    if (!unifiedSchedulerRunning) return;
    // 牧场离场可提前唤醒，但正在等待连接的农场巡查不能再排一轮。
    if (unifiedTickGeneration === runtimeGeneration) return;
    workerScheduler.clear('unified_next_tick');
    if (!loginReady) return;

    const now = Date.now();
    // [fnos-fork] 自己收菜优先（成熟时精确巡田、好友让路）/ 空闲时只保留心跳（静默到点再巡）
    try {
        const adjusted = fnosQuietPriority().adjustUnifiedSchedule({ nowMs: now, nextFarmRunAt, nextFriendRunAt, farmBusy: farmTaskRunning, friendBusy: friendTaskRunning, auto: getAutomation() });
        nextFarmRunAt = adjusted.nextFarmRunAt;
        nextFriendRunAt = adjusted.nextFriendRunAt;
    } catch { /* ignore */ }
    // [fnos-fork] 2026-11-17 农牧轮流：只看当前轮次允许的一方 + 对方的插队时间点，轮到对方时不空转
    fnosEvaluateTurn(now);
    const nextAt = fnosTurns.nextWakeAt({
        nowMs: now,
        nextFarmRunAt: Number(nextFarmRunAt) || (now + 1000),
        nextFriendRunAt: fnosProbeWanted && !friendTaskRunning ? now : (Number(nextFriendRunAt) || (now + 1000)), // [fnos-fork] 状态轮巡待做：马上唤醒
        ranchNextRunAt: ranchNextRunAt(),
        farmTimedAt: fnosFarmTimedAt(now),
        ranchTimedAt: fnosRanchTimedAt(),
        farmBusy: farmTaskRunning,
        friendBusy: friendTaskRunning,
        ranchDue: now >= ranchNextRunAt(),
        friendActive: !!getAutomation().friend,
        friendTimedAt: fnosFriendTimedAt(),
        ranchHasWork: fnosRanchHasWork(),
    });
    if (!Number.isFinite(nextAt)) return;
    const delayMs = Math.max(fnosQuietPriority().ownPriorityMatureAt(now) > 0 ? 200 : 1000, nextAt - now); // 最低 1 秒（[fnos-fork] 等自家作物成熟时 0.2 秒）

    const generation = runtimeGeneration;
    workerScheduler.setTimeoutTask('unified_next_tick', delayMs, async () => {
        if (generation !== runtimeGeneration || !unifiedSchedulerRunning || unifiedTickGeneration === generation) return;
        unifiedTickGeneration = generation;
        try {
            await runUnifiedTick();
        } finally {
            if (unifiedTickGeneration === generation) unifiedTickGeneration = null;
            if (generation === runtimeGeneration) scheduleUnifiedNextTick();
        }
    });
}

function startUnifiedScheduler(): void {
    if (unifiedSchedulerRunning) return;
    try {
        // [fnos-fork] 登录/重连后从头判断空闲；推送巡田有动作提前结束静默时立刻恢复巡田和好友巡查
        fnosQuietPriority().resetFnosQuietRuntime();
        fnosQuietPriority().setIdleInterruptedListener(() => {
            if (!unifiedSchedulerRunning || !loginReady) return;
            const t = Date.now();
            if (!farmTaskRunning) nextFarmRunAt = Math.min(nextFarmRunAt, t + 1000);
            if (!friendTaskRunning) nextFriendRunAt = Math.min(nextFriendRunAt, t + 1000);
            scheduleUnifiedNextTick();
        });
    } catch { /* ignore */ }
    businessBackoffMs.ranch = 0;
    unifiedSchedulerRunning = true;
    // [fnos-fork] 2026-11-17 农牧轮流：登录 / 重连后从农场开始；切换时农场日志、牧场日志各记一条
    fnosTurns.resetTurns();
    fnosLastInsertLog = '';
    fnosOwnWaitedFor = 0;
    fnosRanchLastEndAt = 0;
    fnosFriendTimedHoldUntil = 0;
    fnosProbeWanted = false;
    // [fnos-fork] 2026-11-17 杂项让路判断：自家作物 / 自家牧场定时 / 好友巡查进行中
    try {
        fnosTimetable().setBusyProbe(() => ({
            busy: friendTaskRunning,
            times: [fnosOwnMatureAt(Date.now()), typeof ranchAutomation.timedWakeAt === 'function' ? Number(ranchAutomation.timedWakeAt()) || 0 : 0],
        }));
    } catch { /* ignore */ }
    fnosTurns.setTurnLogger((msg: string) => {
        log('轮次', msg, { module: 'system', event: 'fnos轮次切换' });
        log('牧场', msg, { module: 'ranch', event: 'fnos牧场轮次' });
    });
    resetUnifiedSchedule();
    scheduleUnifiedNextTick();
    try { scheduleFnosRanchLevelRead(require('../services/ranch/fnos-friend-levels').nextReadDelayMs() + 60_000); } catch { /* [fnos-fork] */ }
}

function stopUnifiedScheduler(): void {
    try { fnosQuietPriority().resetFnosQuietRuntime(); } catch { /* [fnos-fork] 掉线/停止时结束空闲静默 */ }
    try { fnosTimetable().flushNow(); } catch { /* [fnos-fork] 2026-11-17 好友时间表落盘 */ }
    unifiedSchedulerRunning = false;
    farmTaskRunning = false;
    friendTaskRunning = false;
    workerScheduler.clear('unified_next_tick');
    workerScheduler.clear('fnos_ranch_level_read'); // [fnos-fork]
}

// [fnos-fork] 2026-11-17 好友牧场等级慢读：每 60–120 秒最多进 1 位好友牧场只读等级（见 services/ranch/fnos-friend-levels.ts）。
// 只在完全空闲时做：已登录、空闲静默未生效、没有任何自动化任务持锁（巡田 / 好友巡查 / 牧场巡查 / 推送收菜都走同一把锁）、
// 巡田 / 好友 / 牧场下一次都在 30 秒之后、不在「自己收菜优先」让路窗口；条件不满足就等下一轮。
const FNOS_RANCH_LEVEL_GAP_MS = 30_000;
function fnosRanchLevelIdle(): boolean {
    if (!loginReady || !unifiedSchedulerRunning || shutdownStarted) return false;
    if (farmTaskRunning || friendTaskRunning || ranchRoutineQueued || harvestSellRunning || isAutomationTaskRunning()) return false;
    const now = Date.now();
    try {
        if (fnosQuietPriority().isFnosIdleActive()) return false;
        if (fnosQuietPriority().shouldYieldToOwnHarvest(now)) return false;
    } catch { return false; }
    const soonest = Math.min(Number(nextFarmRunAt) || 0, Number(nextFriendRunAt) || 0, ranchNextRunAt());
    return soonest - now > FNOS_RANCH_LEVEL_GAP_MS;
}

function scheduleFnosRanchLevelRead(delayMs: number): void {
    if (!unifiedSchedulerRunning) return;
    const generation = runtimeGeneration;
    workerScheduler.setTimeoutTask('fnos_ranch_level_read', Math.max(10_000, delayMs), async () => {
        if (generation !== runtimeGeneration || !unifiedSchedulerRunning) return;
        let next = 120_000;
        try {
            next = await require('../services/ranch/fnos-friend-levels').runSlowReadOnce(fnosRanchLevelIdle);
        } catch { /* ignore */ }
        if (generation === runtimeGeneration) scheduleFnosRanchLevelRead(next);
    });
}

function stopMysteryShopTimer(): void {
    workerScheduler.clear('mystery_shop_initial');
    workerScheduler.clear('mystery_shop_interval');
    workerScheduler.clear('mystery_shop_after_save');
    workerScheduler.clear('mystery_shop_after_idle'); // [fnos-fork]
}


/**
 * 登录完成后的启动序列。
 *
 * 以前这里是四个错峰定时器（2s / 8s / 45s / 60s），结果每日礼包和任务要等到登录一分钟后
 * 才领，而且那时农场和好友循环已经在跑，几件事叠在一起反而把连接打满。
 * 现在改成登录动作一结束就**串行**跑完：串行意味着同一时刻只有一个业务请求在飞，
 * 既领得及时，也不会和心跳抢连接。
 */
async function runStartupSequence(canContinue: () => boolean = () => loginReady): Promise<void> {
    if (!loginReady || !canContinue()) return;

    // 这个序列跑在登录初始化的 await 链上（心跳和 ACE 此时已经启动），
    // 抛出去会被 network.ts 当成「登录初始化失败」直接掐掉连接，所以整段自己兜住异常。
    try {
        // 登录期要领的东西按 farm 班次串行跑完：邮件 / 每日分享 / 月卡 / 免费礼包 / VIP → 任务。
        await runWithRequestClass('farm', async () => {
            if (!loginReady || !canContinue()) return;
            await runExclusiveAutomationTask('daily_routines', () => runDailyRoutines(true));

            if (!loginReady || !canContinue()) return;
            try {
                await checkAndClaimTasks();
            } catch (e: any) {
                log('系统', `登录后领取任务失败: ${e.message}`, { module: 'system', event: '启动序列', result: 'error' });
            }
        });

        if (!loginReady || !canContinue()) return;
        // 登录串行部分跑完，才挂上主循环和后续周期性定时器，避免启动期任务叠跑。
        startFarmCheckLoop({ externalScheduler: true });
        startFriendCheckLoop({ externalScheduler: true });
        startUnifiedScheduler();
        startDailyRoutineTimer(false);
        startMysteryShopTimer();
        // [fnos-fork] 图鉴奖励自动领取 / 自动完成图鉴（都未开启时每轮直接返回，不发请求）
        require('../services/fnos-illustrated-auto').startFnosIllustratedAuto(workerScheduler, runExclusiveAutomationTask);
        // [fnos-fork] 偷收比：忽略高比例申请、来偷菜 Bark、自动删除、在线期间偷菜删除（开关都关时不发请求）
        require('../services/friend/fnos-steal-ratio').startFnosStealRatio(workerScheduler, runExclusiveAutomationTask);
    } catch (e: any) {
        log('系统', `登录启动序列执行失败: ${e.message}`, { module: 'system', event: '启动序列', result: 'error' });
    }
}

function runMysteryShopTick(): Promise<void> {
    if (!loginReady) return Promise.resolve();
    if (fnosTimetable().miscShouldWait()) return Promise.resolve(); // [fnos-fork] 2026-11-17 神秘商店是杂项：本次跳过，下个间隔再查
    // [fnos-fork] 空闲时只保留心跳：静默中不查神秘商店，静默结束后补查一次
    const fnosIdleUntil = fnosQuietPriority().getFnosIdleUntil();
    if (fnosIdleUntil > Date.now()) {
        workerScheduler.setTimeoutTask('mystery_shop_after_idle', fnosIdleUntil - Date.now() + 5000, () => {
            runExclusiveAutomationTask('mystery_shop', runMysteryShopTick).catch(() => null);
        });
        return Promise.resolve();
    }
    const {
        isMysteryShopWatchEnabled,
        checkMysteryShopTick,
    } = require('../services/mystery-shop-auto');
    if (!isMysteryShopWatchEnabled(getAutomation())) return Promise.resolve();
    return checkMysteryShopTick().then((result: any) => {
        if (result?.push?.title && result?.push?.content) {
            sendToMaster({ type: 'push_notify', title: result.push.title, content: result.push.content });
        }
    });
}

function startMysteryShopTimer(): void {
    const {
        isMysteryShopWatchEnabled,
        AUTO_BUY_CHECK_INTERVAL_MS,
    } = require('../services/mystery-shop-auto');
    stopMysteryShopTimer();
    if (!loginReady || !isMysteryShopWatchEnabled(getAutomation())) return;
    workerScheduler.setIntervalTask('mystery_shop_interval', AUTO_BUY_CHECK_INTERVAL_MS, () => {
        runExclusiveAutomationTask('mystery_shop', runMysteryShopTick).catch(() => null);
    });
}

function applyRuntimeConfig(snapshot: any, syncNow: boolean = false): number {
    const rev = Number((snapshot || {}).__revision || 0);
    if (rev > 0 && rev < appliedConfigRevision) {
        if (syncNow) syncStatus();
        return appliedConfigRevision;
    }

    const prevAuto = getAutomation();
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    if (snapshot && snapshot.systemTimeZone !== undefined) {
        updateRuntimeConfig({ timeZone: snapshot.systemTimeZone });
    }
    if (!loginReady && snapshot && snapshot.systemServerUrl !== undefined) {
        updateRuntimeConfig({ serverUrl: String(snapshot.systemServerUrl || '') });
    }
    if (!loginReady && snapshot?.systemDeviceInfo) {
        updateRuntimeConfig({ deviceInfo: snapshot.systemDeviceInfo });
    }
    if (!loginReady && snapshot?.systemWxClientVersion !== undefined) {
        updateRuntimeConfig({ wxClientVersion: String(snapshot.systemWxClientVersion || '') });
    }
    if (!loginReady && snapshot && snapshot.systemClientVersion !== undefined) {
        updateRuntimeConfig({ clientVersion: String(snapshot.systemClientVersion || '') });
    }
    const appliedSnapshot = applyConfigSnapshot(snapshot || {}, { persist: false, accountId });
    configureEmailClaim({ hour: appliedSnapshot.emailClaimHour, accountId });
    const nextRanchAuto = getAutomation();
    const ranchChanged = Object.keys(nextRanchAuto).some(key => key.startsWith('ranch_')
        && JSON.stringify(nextRanchAuto[key]) !== JSON.stringify(prevAuto[key]));
    if (ranchChanged) ranchAutomation.resetSchedule();
    if (rev > appliedConfigRevision) appliedConfigRevision = rev;
    // [fnos-fork] 大号/小号、图鉴、偷收比：设置有变化时在日志里打印当前状态
    try { require('../services/fnos-fork-config').onWorkerConfigApplied(); } catch { /* ignore */ }

    // 优先使用本次下发的间隔，避免 worker 内部 store 漂移导致回退默认值
    const incomingIntervals = (snapshot && snapshot.intervals && typeof snapshot.intervals === 'object')
        ? snapshot.intervals
        : null;
    if (incomingIntervals) {
        applyIntervalsToRuntime(incomingIntervals);
    }

    if (loginReady) {
        refreshFarmCheckLoop(200);
        refreshFriendCheckLoop(200);
        resetUnifiedSchedule();
        scheduleUnifiedNextTick();

        const hasAutomationPayload = !!(snapshot && snapshot.automation && typeof snapshot.automation === 'object');
        if (hasAutomationPayload) {
            const nextAuto = getAutomation();

            const prevFertilizerMode = String(prevAuto && prevAuto.fertilizer ? prevAuto.fertilizer : '').toLowerCase();
            const nextFertilizerMode = String(nextAuto && nextAuto.fertilizer ? nextAuto.fertilizer : '').toLowerCase();
            const fertilizerChanged = prevFertilizerMode !== nextFertilizerMode;
            if (fertilizerChanged && (nextFertilizerMode === 'both' || nextFertilizerMode === 'organic' || nextFertilizerMode === 'smart')) {
                workerScheduler.setTimeoutTask('fertilizer_immediate_after_save', 600, async () => {
                    if (!loginReady) return;
                    try {
                        await runExclusiveAutomationTask('fertilizer_immediate', () => runFertilizerByConfig([], { skipNormal: true }));
                    } catch (e: any) {
                        log('施肥', `保存配置后立即施肥失败: ${e.message}`, {
                            module: 'farm',
                            event: '施肥',
                            result: 'error',
                        });
                    }
                });
            }

            startMysteryShopTimer();
        }
    }

    if (syncNow) syncStatus();
    return appliedConfigRevision;
}

// 接收主进程指令
onMasterMessage(async (msg: any) => {
    try {
        if (msg.type === 'start') {
            await startBot(msg.config);
        } else if (msg.type === 'stop') {
            await stopBot();
        } else if (msg.type === 'api_call') {
            handleApiCall(msg);
        } else if (msg.type === 'config_sync') {
            applyRuntimeConfig(msg.config || {}, true);
        } else if (msg.type === 'reload_config') {
            if (typeof loadConfigs === 'function') loadConfigs();
        }
    } catch (e: any) {
        sendToMaster({
            type: 'error',
            error: {
                message: String(e?.message || e || 'Worker error'),
                code: e?.code,
                errorMessage: e?.errorMessage ?? e?.error_message,
                name: String(e?.name || 'Error'),
            },
        });
    }
});

async function startBot(config: any): Promise<void> {
    if (isRunning) return;
    isRunning = true;
    shutdownStarted = false;
    runtimeGeneration += 1;

    const { code, platform, systemTimeZone, systemServerUrl, systemClientVersion, systemWxClientVersion, systemDeviceInfo } = config;

    if (systemTimeZone !== undefined) updateRuntimeConfig({ timeZone: systemTimeZone });
    if (systemServerUrl !== undefined) updateRuntimeConfig({ serverUrl: String(systemServerUrl || '') });
    if (systemDeviceInfo) updateRuntimeConfig({ deviceInfo: systemDeviceInfo });
    if (systemWxClientVersion !== undefined) updateRuntimeConfig({ wxClientVersion: String(systemWxClientVersion || '') });
    if (systemClientVersion !== undefined) updateRuntimeConfig({ clientVersion: String(systemClientVersion || '') });
    CONFIG.platform = platform || 'qq';
    // 注意：间隔配置由 applyIntervalsToRuntime 统一处理，不要在这里覆盖

    await loadProto();

    log('系统', '正在连接服务器...');

    // 加载保存的配置
    applyRuntimeConfig(getConfigSnapshot(), false);

    initStatusBar();
    setStatusPlatform(CONFIG.platform);

    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    onWsError = (payload: any) => {
        if ((Number(payload?.code) || 0) !== 400) return;
        const now = Date.now();
        if (now - wsErrorHandledAt < 4000) return;
        wsErrorHandledAt = now;
        log('系统', '连接被拒绝，可能需要更新 Code');
        sendToMaster({
            type: 'ws_error',
            code: 400,
            message: payload?.message || '',
        });
        if (isRunning) {
            handleTerminalDisconnect({
                source: 'ws_error',
                code: 400,
                reason: payload?.message || '连接被拒绝',
                phase: 'connecting',
            });
        }
    };
    networkEvents.on('ws_error', onWsError);

    if (onDisconnected) {
        networkEvents.off('disconnected', onDisconnected);
    }
    onDisconnected = (payload: any) => {
        handleTerminalDisconnect(payload);
    };
    networkEvents.on('disconnected', onDisconnected);
    networkEvents.on('kickout', onKickout);
    networkEvents.off('ranchBookReward', onRanchBookReward);
    networkEvents.on('ranchBookReward', onRanchBookReward);
    networkEvents.off('ranchFacilitiesChanged', onRanchFacilitiesChanged);
    networkEvents.on('ranchFacilitiesChanged', onRanchFacilitiesChanged);

    const generation = runtimeGeneration;
    const canContinueLogin = (): boolean => isRunning && !shutdownStarted && generation === runtimeGeneration;
    const onLoginSuccess = async (): Promise<void> => {
        if (!canContinueLogin() || loginReady) return;
        loginReady = true;
        try { require('../services/friend/fnos-steal-ratio').noteFnosOnlineSession(); } catch { /* [fnos-fork] 在线期间偷菜：记下本次登录/重连成功时刻，掉线期间的记录不算 */ }
        ranchAutomation.resetSchedule();
        if (onSellGain) {
            networkEvents.off('sell', onSellGain);
        }
        onSellGain = (deltaGold: any) => {
            const delta = Number(deltaGold || 0);
            if (!Number.isFinite(delta) || delta <= 0) return;
            recordOperation('sell', 1);
        };
        networkEvents.on('sell', onSellGain);

        if (onFarmHarvested) {
            networkEvents.off('farmHarvested', onFarmHarvested);
        }
        onFarmHarvested = async () => {
            if (harvestSellRunning) return;
            if (!getAutomation().sell) return;
            harvestSellRunning = true;
            try {
                await runExclusiveAutomationTask('harvest_sell', sellAllFruits);
            } catch (e: any) {
                log('仓库', `收获后自动出售失败: ${e.message}`, { module: 'warehouse', event: '收获后出售', result: 'error' });
            } finally {
                harvestSellRunning = false;
            }
        };
        networkEvents.on('farmHarvested', onFarmHarvested);

        networkEvents.off('ranchMarketStockReady', wakeRanchMarketExchange);
        networkEvents.on('ranchMarketStockReady', wakeRanchMarketExchange);
        networkEvents.off('ranchMarketVisitChanged', onRanchMarketVisitChanged);
        networkEvents.on('ranchMarketVisitChanged', onRanchMarketVisitChanged);

        if (onDogSkillGiftPending) {
            networkEvents.off('dogSkillGiftPending', onDogSkillGiftPending);
        }
        onDogSkillGiftPending = (count: any) => {
            const pendingCount = Math.max(0, toNum(count));
            if (pendingCount <= 0 || !loginReady) return;
            runExclusiveAutomationTask('dog_skill_gifts', () => checkAndClaimDogSkillGifts(pendingCount)).catch(() => null);
        };
        networkEvents.on('dogSkillGiftPending', onDogSkillGiftPending);

        try {
            await runExclusiveAutomationTask('activity_windows_refresh', refreshActivityWindows);
        } catch (e: any) {
            logWarn('仓库', `活动时间初始化失败: ${e?.message || e}`);
        }
        if (!canContinueLogin()) return;

        // 登录后只拉一次背包，同时初始化点券（1002）和金豆豆（1005）
        try {
            const bagReply = await runExclusiveAutomationTask('login_bag_init', getBag);
            const items = getBagItems(bagReply);
            let coupon = 0;
            let goldBean = 0;
            for (const it of (items || [])) {
                const id = toNum(it && it.id);
                if (id === 1002) {
                    coupon = toNum(it.count);
                } else if (id === 1005) {
                    goldBean = toNum(it.count);
                }
            }
            const state = getUserState();
            state.coupon = Math.max(0, coupon);
            state.goldBean = Math.max(0, goldBean);
        } catch {
            // ignore
        }
        // 登录成功后，以当前金币/经验/点券作为统计基线，并清空会话增量
        const latest = getUserState();
        try { require('../services/friend/fnos-steal-ratio').rememberSelfGid(); } catch { /* [fnos-fork] 记下本账号 GID，供其他账号排除大小号 */ }
        const accountId = process.env.FARM_ACCOUNT_ID || '';
        initStatsWithPersistence(accountId, Number(latest.gold || 0), Number(latest.exp || 0), Number(latest.coupon || 0));
        resetSessionGains();

        // 登录成功后启动各模块
        await runExclusiveAutomationTask('invite_codes', processInviteCodes);
        if (!canContinueLogin()) return;
        if (getAutomation().fertilizer_gift) {
            await runExclusiveAutomationTask('fertilizer_gifts_login', openFertilizerGiftPacksSilently).catch(() => 0);
            if (!canContinueLogin()) return;
        }

        if (!canContinueLogin()) return;
        // 立即发送一次状态，再串行跑启动序列（不阻塞状态上报）
        syncStatus();
        await runExclusiveAutomationTask('startup_sequence', () => runStartupSequence(canContinueLogin));
    };

    connect(code, onLoginSuccess);

    // 启动定时状态同步
    workerScheduler.setIntervalTask('status_sync', 3000, syncStatus, { preventOverlap: true });
}

function detachRuntimeListeners(): void {
    networkEvents.off('kickout', onKickout);
    if (onDisconnected) {
        networkEvents.off('disconnected', onDisconnected);
        onDisconnected = null;
    }
    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    if (onSellGain) {
        networkEvents.off('sell', onSellGain);
        onSellGain = null;
    }
    if (onFarmHarvested) {
        networkEvents.off('farmHarvested', onFarmHarvested);
        onFarmHarvested = null;
    }
    networkEvents.off('ranchMarketStockReady', wakeRanchMarketExchange);
    networkEvents.off('ranchMarketVisitChanged', onRanchMarketVisitChanged);
    networkEvents.off('ranchBookReward', onRanchBookReward);
    networkEvents.off('ranchFacilitiesChanged', onRanchFacilitiesChanged);
    if (onDogSkillGiftPending) {
        networkEvents.off('dogSkillGiftPending', onDogSkillGiftPending);
        onDogSkillGiftPending = null;
    }
}

function quiesceBot(reason: string): void {
    shutdownStarted = true;
    runtimeGeneration += 1;
    isRunning = false;
    loginReady = false;
    stopUnifiedScheduler();
    stopFarmCheckLoop();
    stopFriendCheckLoop();
    stopDailyRoutineTimer();
    cleanupTaskSystem();
    workerScheduler.clearAll();
    detachRuntimeListeners();
    cleanup(reason);
    syncStatus(true);
}

async function stopBot(): Promise<void> {
    if (!shutdownStarted) {
        saveStats();
        quiesceBot('主动停止');
    }
    exitWorker(0);
}

function handleTerminalDisconnect(payload: any): void {
    if (shutdownStarted) return;
    const source = String(payload?.source || 'ws_close');
    const code = Number(payload?.code) || 0;
    const reason = String(payload?.reason || '连接已断开');
    const phase = String(payload?.phase || 'unknown');
    log('系统', `连接已断开，不再使用旧 Code 重连 (source=${source}, code=${code}, phase=${phase})`, {
        source, disconnectCode: code, reason, phase, diagnostics: payload?.diagnostics || null,
    });
    saveStats();
    quiesceBot(`连接断开: ${source}`);
    sendToMaster({
        type: 'account_disconnected',
        source,
        code,
        reason,
        phase,
        connectionId: Number(payload?.connectionId) || 0,
        diagnostics: payload?.diagnostics || null,
        at: Number(payload?.at) || Date.now(),
    });
    setTimeout(exitWorker, 300, 0);
}

function onKickout(payload: any): void {
    if (shutdownStarted) return;
    const reason = payload && payload.reason ? payload.reason : '未知';
    const reasonCode = Number(payload?.reasonCode) || 0;
    const diagnostics = payload?.diagnostics || null;
    log('系统', `检测到踢下线，准备自动停止账号。原因: ${reason} (${reasonCode})`, { reasonCode, diagnostics });
    saveStats();
    quiesceBot(`踢下线: ${reason}`);
    sendToMaster({ type: 'account_kicked', reason, reasonCode, diagnostics });
    setTimeout(exitWorker, 300, 0);
}

// 处理来自 Admin 面板的直接调用请求 (如: 购买种子、开关设置等)
async function handleApiCall(msg: any): Promise<void> {
    const { id, method, args } = msg;
    let result: any = null;
    let error: { message: string; code?: string | number; errorMessage?: string; name?: string } | string | null = null;

    try {
        if (method === 'applyRuntimeConfigSnapshot') {
            const appliedRevision = applyRuntimeConfig((args && args[0]) || {}, true);
            result = { appliedRevision };
        } else {
            if (!isRunning || shutdownStarted || !loginReady) {
                throw new Error('账号未连接');
            }
            await runExclusiveAutomationTask(`api:${method}`, async () => {
                if (!loginReady || shutdownStarted) throw new Error('账号未连接');
                switch (method) {
                case 'getRanchState':
                    // 打包版的 fork 使用 JSON IPC，会把缺省的好友 GID 编码成 null。
                    result = await require('../services/ranch').getRanchState(args[0], args[1], args[2] ?? undefined);
                    break;
                case 'clearRanchIllustratedNew':
                    result = await require('../services/ranch/book').clearGiantBookNew();
                    break;
                case 'prepareRanchAction':
                    result = await require('../services/ranch').prepareRanchAction(args[0], args[1]);
                    break;
                case 'operateRanch':
                    result = await require('../services/ranch').operateRanch(args[0], args[1]);
                    break;
                case 'getLands':
                    result = await getLandsDetail(args[0] === true);
                    break;
                case 'getIllustratedSnapshot':
                    result = await require('../services/illustrated').getIllustratedSnapshot();
                    break;
                case 'getCollectionsSnapshot':
                    result = await require('../services/collections').getCollectionsSnapshot();
                    break;
                case 'getBulletinList': // [fnos-fork] 游戏公告列表，只读
                    result = await require('../services/fnos-bulletin').getBulletinList();
                    break;
                case 'getBulletinDetail': // [fnos-fork] 游戏公告正文，只读，不报已读
                    result = await require('../services/fnos-bulletin').getBulletinDetail(args[0]);
                    break;
                case 'operateCollections':
                    result = await require('../services/collections').operateCollections(args[0], args[1]);
                    break;
                case 'claimIllustratedRewards':
                    result = await require('../services/illustrated').claimIllustratedRewards(args[0]);
                    break;
                case 'clearIllustratedNew':
                    result = await require('../services/illustrated').clearIllustratedNew(args[0]);
                    break;
                case 'getSolarCalendar':
                    result = await require('../services/solar-calendar').getSolarCalendar();
                    break;
                case 'operateSolarCalendar':
                    result = await require('../services/solar-calendar').operateSolarCalendar(args[0], args[1]);
                    break;
                case 'getFriends':
                    result = await getFriendsList(args[0] === true, 'normal', args[1] === true);
                    break;
                case 'getFriendsCache':
                    result = getFriendsListCacheOnly();
                    break;
                case 'clearFriendsCache':
                    require('../services/friend').clearFriendsListCache();
                    result = { ok: true };
                    break;
                case 'getInteractRecords':
                    result = await getInteractRecords();
                    break;
                case 'getFriendLands':
                    result = await getFriendLandsDetail(args[0], args[1] === true);
                    break;
                case 'getFriendInteractionItems':
                    result = await require('../services/friend-interaction-items').getFriendInteractionItems(args[0] === true);
                    break;
                case 'useFriendInteractionItemBatch':
                    result = await require('../services/friend-interaction-items').useFriendInteractionItemBatch(args[0], args[1], args[2], args[3] === true);
                    break;
                case 'useFriendFarmInteractionItem':
                    result = await require('../services/friend-interaction-items').useFriendFarmInteractionItem(args[0], args[1], args[2] === true);
                    break;
                case 'getSelfInteractionItems':
                    result = await require('../services/friend-interaction-items').getSelfInteractionItems(args[0] === true);
                    break;
                case 'useSelfInteractionItemBatch':
                    result = await require('../services/friend-interaction-items').useSelfInteractionItemBatch(args[0], args[1], args[2] === true);
                    break;
                case 'doFriendOp':
                    result = await doFriendOperation(args[0], args[1], args[2] === true);
                    break;
                case 'delFriend':
                    result = await deleteFriend(args[0]);
                    break;
                case 'lookupStealRatios': // [fnos-fork] 好友页按偷收比筛选时批量查生涯
                    result = await require('../services/friend/fnos-steal-ratio').lookupStealRatios(args[0]);
                    break;
                case 'getSeeds':
                    result = await getAvailableSeeds(args[0] === true);
                    break;
                case 'purchaseSeed':
                    result = await purchaseSeed(args[0], args[1]);
                    break;
                case 'getBag':
                    result = await require('../services/warehouse').getBagDetail();
                    break;
                case 'getBagSeeds':
                    result = await require('../services/warehouse').getBagSeeds();
                    break;
                case 'getDiamondBalance':
                    result = await require('../services/pay').getDiamondBalance();
                    break;
                case 'useItem': {
                    const { useItem: _useItem } = require('../services/warehouse');
                    const itemId = Number(args[0]) || 0;
                    const count = Math.max(1, Number(args[1]) || 1);
                    const uid = Number(args[2]) || 0;
                    result = await _useItem(itemId, count, [], uid);
                    break;
                }
                case 'sellItems': {
                    const { sellItems: _sell } = require('../services/warehouse');
                    const sellList = Array.isArray(args[0]) ? args[0] : [];
                    result = await _sell(sellList.map((it: any) => ({
                        id: it.id,
                        count: it.count,
                        uid: it.uid || 0,
                        expire_time: it.expireTime ?? it.expire_time,
                    })));
                    break;
                }
                case 'setItemsLocked':
                    result = await require('../services/warehouse').setItemsLocked(args[0], args[1] === true);
                    break;
                case 'getDogSkillGiftStatus': {
                    const dogGifts = require('../services/dog-skill-gifts');
                    const info = await dogGifts.getDogInfo();
                    result = { pendingCount: dogGifts.getPendingGiftCount(info) };
                    break;
                }
                case 'claimDogSkillGifts':
                    result = await require('../services/dog-skill-gifts').checkAndClaimDogSkillGifts(undefined, true);
                    break;
                case 'getPetInfo':
                    result = await require('../services/pets').getPetInfo();
                    break;
                case 'activateDog':
                    result = await require('../services/pets').activateDog(args[0]);
                    break;
                case 'deployDog':
                    result = await require('../services/pets').deployDog(args[0]);
                    break;
                case 'withdrawDog':
                    result = await require('../services/pets').withdrawDog();
                    break;
                case 'useDogFood':
                    result = await require('../services/pets').useDogFood(args[0], args[1], args[2]);
                    break;
                case 'getPetProtectLogs':
                    result = await require('../services/pets').getProtectLogs();
                    break;
                case 'setAutomation': {
                    const payload = args && args[0] ? args[0] : {};
                    applyRuntimeConfig({ automation: { [payload.key]: payload.value } }, true);
                    result = getAutomation();
                    break;
                }
                case 'doFarmOp':
                    result = await runFarmOperation(args[0], args[1], args[2] === true); // opType, optional targetLandId
                    break;
                case 'fertilizeOwnLand':
                    result = await fertilizeOwnLand(args[0], args[1]);
                    break;
                case 'fertilizeAllOwnLands':
                    result = await require('../services/farm').fertilizeAllOwnLands(args[0], args[1]);
                    break;
                case 'buyFertilizer': {
                    const fertilizerType = args[0] || 'organic';
                    const fertilizerCount = Number(args[1]) || 0;
                    result = await autoBuyFertilizer(true, fertilizerType, fertilizerCount, args[2] === true);
                    break;
                }
                case 'checkAndBuyFertilizer': {
                    const options = args[0] || {};
                    result = await checkAndBuyFertilizerBoth(options, args[1] === true);
                    break;
                }
                case 'getAnalytics': {
                    const { getPlantRankings } = require('../services/analytics');
                    result = getPlantRankings(args[0]); // sortBy
                    break;
                }
                case 'getDailyGiftOverview':
                    result = await getDailyGiftOverview(args[0] === true);
                    break;
                case 'getRanchActivityDirectorySnapshot':
                    result = await require('../services/activity-center').getRanchActivityDirectorySnapshot();
                    break;
                case 'getActivityDirectorySnapshot':
                    result = await require('../services/activity-center').getActivityDirectorySnapshot();
                    break;
                case 'getActivityCenterSnapshot':
                    result = await require('../services/activity-center').getActivityCenterSnapshot();
                    break;
                case 'getCurrentSeasonEvent':
                    result = await require('../services/activity-center').getCurrentSeasonEvent();
                    break;
                case 'getCurrentStellarActivity':
                    result = await require('../services/activity-center').getCurrentStellarActivity();
                    break;
                case 'getCurrentStarSandShop':
                    result = await require('../services/activity-center').getCurrentStarSandShop();
                    break;
                case 'getCurrentSolarTerms':
                    result = await require('../services/activity-center').getCurrentSolarTerms();
                    break;
                case 'getCurrentQixiActivity':
                    result = await require('../services/activity-center').getCurrentQixiActivity();
                    break;
                case 'getCurrentCharityRedFlowerActivity':
                    result = await require('../services/activity-center').getCurrentCharityRedFlowerActivity();
                    break;
                case 'getPetDiary':
                    result = await require('../services/activity-center').getPetDiary();
                    break;
                case 'operatePetDiary':
                    result = await require('../services/activity-center').operatePetDiary(args[0], args[1]);
                    break;
                case 'getPetDiaryRecords':
                    result = await require('../services/activity-center').getPetDiaryRecords(args[0]);
                    break;
                case 'getPetDiaryFriend':
                    result = await require('../services/activity-center').getPetDiaryFriend(args[0]);
                    break;
                case 'claimCharityRedFlowerSeeds':
                    result = await require('../services/activity-center').claimCharityRedFlowerSeeds();
                    break;
                case 'donateCharityRedFlowerLove':
                    result = await require('../services/activity-center').donateCharityRedFlowerLove();
                    break;
                case 'claimCharityRedFlowerDailyGift':
                    result = await require('../services/activity-center').claimCharityRedFlowerDailyGift();
                    break;
                case 'claimCharityRedFlowerProgressReward':
                    result = await require('../services/activity-center').claimCharityRedFlowerProgressReward(args[0]);
                    break;
                case 'getCurrentWeatherActivity':
                    result = await require('../services/activity-center').getCurrentWeatherActivity();
                    break;
                case 'buyWeatherBottle':
                    result = await require('../services/activity-center').buyWeatherBottle(args[0]);
                    break;
                case 'collectWeatherBottle':
                    result = await require('../services/activity-center').collectWeatherBottle(args[0]);
                    break;
                case 'lightWeatherResearch':
                    result = await require('../services/activity-center').lightWeatherResearch(args[0]);
                    break;
                case 'summonWeatherRain':
                    result = await require('../services/activity-center').summonWeatherRain();
                    break;
                case 'claimBattlePassRewards':
                    result = await require('../services/activity-center').claimBattlePassRewards();
                    break;
                case 'exchangeStarSandGoods':
                    result = await require('../services/activity-center').exchangeStarSandGoods(args[0], args[1]);
                    break;
                case 'lightConstellation':
                    result = await require('../services/activity-center').lightConstellation();
                    break;
                case 'claimSolarTerm':
                    result = await require('../services/activity-center').claimSolarTerm(String(args[0] || ''));
                    break;
                case 'getCurrentQingMeiActivity':
                    result = await require('../services/activity-center').getCurrentQingMeiActivity();
                    break;
                case 'claimQingMeiDailySeed':
                    result = await require('../services/activity-center').claimQingMeiDailySeed();
                    break;
                case 'startQingMeiBrew':
                    result = await require('../services/activity-center').startQingMeiBrew(args[0]);
                    break;
                case 'continueQingMeiBrew':
                    result = await require('../services/activity-center').continueQingMeiBrew();
                    break;
                case 'settleQingMeiBrew':
                    result = await require('../services/activity-center').settleQingMeiBrew();
                    break;
                case 'claimQixiBridgeRewards':
                    result = await require('../services/activity-center').claimQixiBridgeRewards();
                    break;
                case 'giftQixiSachet':
                    result = await require('../services/activity-center').giftQixiSachet(args[0], args[1]);
                    break;
                case 'exchangeWeatherCollectorBottle':
                    result = await require('../services/activity-center').exchangeWeatherCollectorBottle();
                    break;
                case 'getWeatherFriends':
                    result = await require('../services/activity-center').getWeatherFriends();
                    break;
                case 'scanWeatherFriends':
                    result = await require('../services/activity-center').scanWeatherFriends(args[0]);
                    break;
                case 'useWeatherCollectorBottle':
                    result = await require('../services/activity-center').useWeatherCollectorBottle(args[0]);
                    break;
                case 'useWeatherSummonBottle':
                    result = await require('../services/activity-center').useWeatherSummonBottle();
                    break;
                case 'useWeatherFrogBottle':
                    result = await require('../services/activity-center').useWeatherFrogBottle(args[0]);
                    break;
                case 'useWeatherCloudBottle':
                    result = await require('../services/activity-center').useWeatherCloudBottle(args[0], args[1]);
                    break;
                case 'advanceWeatherResearch':
                    result = await require('../services/activity-center').advanceWeatherResearch(args[0]);
                    break;
                case 'getAutumnActivity':
                    result = await require('../services/autumn-activities').getAutumnActivity(args[0]);
                    break;
                case 'getMugeActivity':
                    result = await require('../services/muge-activity').getMugeActivity();
                    break;
                case 'operateMugeActivity':
                    result = await require('../services/muge-activity').operateMugeActivity(args[0], args[1]);
                    break;
                case 'getMilkTeaActivity':
                    result = await require('../services/milk-tea').getMilkTeaActivity(args[0], args[1]);
                    break;
                case 'operateMilkTeaActivity':
                    result = await require('../services/milk-tea').operateMilkTeaActivity(args[0], args[1]);
                    break;
                case 'getShareRewardActivity':
                    result = await require('../services/share-reward-activity').getShareRewardActivity(args[0]);
                    break;
                case 'operateShareRewardActivity':
                    result = await require('../services/share-reward-activity').operateShareRewardActivity(args[0], args[1], args[2]);
                    break;
                case 'operateAutumnActivity':
                    result = await require('../services/autumn-activities').operateAutumnActivity(args[0], args[1], args[2]);
                    break;
                case 'getPropsShop':
                    result = await require('../services/commerce').getPropsShop();
                    break;
                case 'purchaseProps':
                    result = await require('../services/commerce').purchaseProps(args[0], args[1], args[2]);
                    break;
                case 'getMallCatalog':
                    result = await require('../services/commerce').getMallCatalog(args[0], args[1]);
                    break;
                case 'purchaseMallProduct':
                    result = await require('../services/commerce').purchaseMallProduct(args[0], args[1], args[2], args[3]);
                    break;
                case 'getMysteryShop':
                    result = await require('../services/commerce').getMysteryShop();
                    break;
                case 'purchaseMysteryOffer':
                    result = await require('../services/commerce').purchaseMysteryOffer(args[0]);
                    break;
                case 'getSchedulers':
                    result = getSchedulerRegistrySnapshot();
                    break;
                default:
                    error = 'Unknown method';
                }
            });
        }
    } catch (e: any) {
        error = {
            message: String(e?.message || e || 'Worker API error'),
            code: e?.code,
            errorMessage: e?.errorMessage ?? e?.error_message,
            name: String(e?.name || 'Error'),
        };
    }

    sendToMaster({ type: 'api_response', id, result, error });
}

async function getDailyGiftOverview(propagateErrors: boolean = false): Promise<any> {
    const auto = getAutomation() || {};
    const task = getTaskDailyStateLikeApp
        ? await getTaskDailyStateLikeApp(propagateErrors)
        : (getTaskClaimDailyState ? getTaskClaimDailyState() : { doneToday: false, lastClaimAt: 0 });
    const growthTask = getGrowthTaskStateLikeApp
        ? await getGrowthTaskStateLikeApp(propagateErrors)
        : { doneToday: false, completedCount: 0, totalCount: 0, tasks: [] };
    const email = getEmailDailyState ? getEmailDailyState() : { doneToday: false, lastCheckAt: 0 };
    const free = getFreeGiftDailyState ? getFreeGiftDailyState() : { doneToday: false, lastClaimAt: 0 };
    const share = getShareDailyState ? getShareDailyState() : { doneToday: false, lastClaimAt: 0 };
    const vip = getVipDailyState ? getVipDailyState() : { doneToday: false, lastClaimAt: 0 };
    const month = getMonthCardDailyState ? getMonthCardDailyState() : { doneToday: false, lastClaimAt: 0 };

    return {
        date: getSystemDateKey(),
        timeZone: CONFIG.timeZone,
        growth: {
            key: 'growth_task',
            label: '成长任务',
            doneToday: !!growthTask.doneToday,
            completedCount: Number(growthTask.completedCount || 0),
            totalCount: Number(growthTask.totalCount || 0),
            currentTask: growthTask.currentTask || null,
            tasks: Array.isArray(growthTask.tasks) ? growthTask.tasks : [],
        },
        ranch: require('../services/ranch/daily').getOverview(!!auto.ranch_task, !!auto.ranch_share, !!auto.ranch_daily_benefit),
        gifts: [
            {
                key: 'task_claim',
                label: '每日任务',
                enabled: !!auto.task,
                doneToday: !!task.doneToday,
                lastAt: Number(task.lastClaimAt || 0),
                completedCount: Number(task.completedCount || 0),
                totalCount: Number(task.totalCount || 3),
            },
            // 以下功能默认启用，enabled 固定为 true
            {
                key: 'email_rewards',
                label: '邮箱奖励',
                enabled: true,
                doneToday: email.doneToday,
                lastAt: email.lastCheckAt,
                nextAt: email.nextCheckAt,
                scheduledHour: email.scheduledHour,
                result: email.result,
                lastError: email.lastError,
            },
            { key: 'mall_free_gifts', label: '商城免费礼包', enabled: true, doneToday: !!free.doneToday, lastAt: Number(free.lastClaimAt || 0) },
            {
                key: 'daily_share',
                label: '分享礼包',
                enabled: true,
                mode: 'auto_claim',
                doneToday: !!share.doneToday,
                checkedToday: !!share.checkedToday,
                checkStatus: String(share.checkStatus || 'unchecked'),
                canShare: typeof share.canShare === 'boolean' ? share.canShare : null,
                lastAt: Number(share.lastClaimAt || share.lastCheckAt || 0),
            },
            {
                key: 'vip_daily_gift',
                label: '会员礼包',
                enabled: true,
                doneToday: !!vip.doneToday,
                lastAt: Math.max(Number(vip.lastClaimAt || 0), Number(vip.lastCheckAt || 0)),
                isVip: typeof vip.isVip === 'boolean' ? vip.isVip : null,
                hasGift: typeof vip.hasGift === 'boolean' ? vip.hasGift : null,
                canClaim: typeof vip.canClaim === 'boolean' ? vip.canClaim : null,
                result: vip.result || '',
                lastError: vip.lastError || '',
            },
            {
                key: 'month_card_gift',
                label: '月卡礼包',
                enabled: true,
                doneToday: !!month.doneToday,
                lastAt: Number(month.lastClaimAt || month.lastCheckAt || 0),
                hasCard: Object.hasOwn(month, 'hasCard') ? !!month.hasCard : undefined,
                hasClaimable: Object.hasOwn(month, 'hasClaimable') ? !!month.hasClaimable : undefined,
                result: month.result || '',
            },
        ],
    };
}

function syncStatus(force: boolean = false): void {
    if (!process.send && !parentPort) return;

    const userState = getUserState();
    const ws = getWs();
    const connected = !!(loginReady && ws && ws.readyState === 1);

    let expProgress: any = null;
    const level = (userState.level ?? statusData.level ?? 0);
    const exp = (userState.exp ?? statusData.exp ?? 0);

    if (level > 0 && exp >= 0) {
        expProgress = getLevelExpProgress(level, exp);
    }

    const limits = require('../services/friend').getOperationLimits();
    const fullStats = require('../services/stats').getStats(statusData, userState, connected, limits);
    const nowMs = Date.now();
    const farmRemainSec = Math.max(0, Math.ceil((Number(nextFarmRunAt || 0) - nowMs) / 1000));
    const friendRemainSec = Math.max(0, Math.ceil((Number(nextFriendRunAt || 0) - nowMs) / 1000));
    const visitStrategy = require('../services/friend/visit-strategy');
    const friendQuiet = !!visitStrategy.inFriendQuietHours();
    const farmQuiet = !!visitStrategy.inFarmQuietHours();
    fullStats.nextChecks = {
        farmRemainSec,
        helpRemainSec: friendRemainSec,
        stealRemainSec: friendRemainSec,
        friendRemainSec,
        farmQuiet,
        friendQuiet,
        helpQuiet: friendQuiet,
        stealQuiet: friendQuiet,
    };

    fullStats.automation = getAutomation();
    fullStats.preferredSeed = getPreferredSeed();
    fullStats.levelProgress = expProgress;
    fullStats.levelForecast = require('../services/level-forecast').getLevelForecast(
        userState, expProgress, fullStats, fullStats.automation, farmQuiet,
    );
    fullStats.configRevision = appliedConfigRevision;
    const hash = JSON.stringify(fullStats);
    const now = Date.now();
    if (force || hash !== lastStatusHash || now - lastStatusSentAt > 8000) {
        lastStatusHash = hash;
        lastStatusSentAt = now;
        sendToMaster({ type: 'status_sync', data: fullStats });
    }
}
