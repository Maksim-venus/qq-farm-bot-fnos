/**
 * 好友巡查调度 - 循环管理、每日重置、经验限制、自动接受好友、启动捣乱
 */

const { CONFIG } = require('../../config/config');
const crypto = require('node:crypto');
const { getUserState, getGatewayLoad, networkEvents } = require('../../utils/network');
const { isGatewayHealthyForBusiness, isGatewayYieldError } = require('../../utils/low-priority-gate');
const { toNum, getSystemDateKey, log, logWarn, randomDelay, sleep } = require('../../utils/utils');
const { getDataFile } = require('../../config/runtime-paths');
const { createScheduler } = require('../scheduler');
const { runExclusiveAutomationTask } = require('../automation-lock');
const { readJsonFile, writeJsonFileAtomic } = require('../json-db');
const { setOperationLimitsCallback } = require('../farm');
const {
    isAutomationOn,
    getFriendBlacklist,
    getStealDelaySeconds,
    getAutoAcceptFriendMinLevel,
    getAutoAcceptRequireOwnLevel,
    getAutoAcceptHarvestStealEnabled,
    getAutoAcceptHarvestStealHarvest,
    getAutoAcceptHarvestStealSteal,
} = require('../../models/store');
const { sellAllFruits } = require('../warehouse');
const { getCareerInfo } = require('../career');
const {
    getAllFriends,
    acceptFriends,
    rejectFriends,
    getApplications,
} = require('./api');
const {
    isHarvestStealFilterEnabled,
    evaluateLevelFilter,
    evaluateHarvestStealFilter,
} = require('./application-filter');
// [fnos-fork] 偷收比超过阈值时拒绝好友申请（与「自动通过好友申请」独立，默认关）
const { readFnosStealRatio, decideStealRatioApplication } = require('./fnos-steal-ratio');
const {
    extractReplyFriends,
    clearAllInvalidKnownFriendGidCooldowns,
} = require('./gid-manager');
const {
    visitFriend,
    inFriendQuietHours,
    cacheFriendsListFromReply,
    clearFriendsListCache,
    getFriendsListCacheOnly,
} = require('./visit-strategy');
// [fnos-fork] 2026-11-17 好友时间表：到点直接去、扫描时探成熟时间（见 services/fnos-timetable.ts）
const fnosTimetable = require('../fnos-timetable');
const { buildFriendVisitPlan } = require('./visit-plan');
// [fnos-fork] 2026.10.21.3 大小号协作：不偷大号、只给大号放捣乱
const { getAltCoopSettings, adjustVisitPlanForAltCoop, getVisitOptionsForAltCoop } = require('./fnos-alt-coop');
const { getFriendDogState, flushFriendPetCacheNow } = require('./pet-cache');

// 延迟引用 pet-sync，它反向依赖本模块的 isFriendCheckRunning
function petSyncRef(): any {
    return require('./pet-sync');
}

// ============ 内部状态 ============
let isCheckingFriends: boolean = false;
let friendLoopRunning: boolean = false;
let externalSchedulerMode: boolean = false;
let friendLoopGeneration = 0;
let lastResetDate: string = '';  // 上次重置日期 (YYYY-MM-DD)
const friendScheduler: any = createScheduler('friend');

const operationLimits: Map<number, any> = new Map();

let canGetHelpExp: boolean = true;
let helpAutoDisabledByLimit: boolean = false;
let badOperationLimitReached: boolean = false;

// Captured PutWeeds/PutInsects replies both consume operation 10003.
// PutInsects additionally reports 10004, but 10003 is the shared daily quota.
const BAD_SHARED_LIMIT_ID: number = 10003;
const BAD_DAILY_STATE_VERSION: number = 1;
// 一轮最多对多少位「没可偷也没可帮」的好友做纯捣乱访问（按等级降序）
const MAX_BAD_ONLY_VISITS_PER_ROUND: number = 20;

const OP_NAMES: Record<number, string> = {
    10001: '浇水',
    10002: '除虫',
    10003: '捣乱共享额度',
    10004: '放虫',
    10005: '帮助操作 #10005',
    10006: '帮助操作 #10006',
    10007: '帮助操作 #10007',
    10008: '铲除',
};

// ============ 操作限制相关 ============

function getBadDailyStateFile(): string {
    const accountId: string = String(process.env.FARM_ACCOUNT_ID || 'default');
    const token: string = crypto.createHash('sha256').update(accountId, 'utf8').digest('hex');
    return getDataFile(`friend-bad-state-${token}.json`);
}

function loadBadDailyStop(today: string): boolean {
    const state: any = readJsonFile(getBadDailyStateFile(), () => ({}));
    return Number(state?.version) === BAD_DAILY_STATE_VERSION
        && String(state?.date || '') === today
        && state?.stopped === true;
}

function persistBadDailyStop(today: string): void {
    writeJsonFileAtomic(getBadDailyStateFile(), {
        version: BAD_DAILY_STATE_VERSION,
        date: today,
        stopped: true,
    });
}

/**
 * 检查是否需要重置每日限制 (0点刷新)
 */
export function checkDailyReset(): void {
    const today: string = getSystemDateKey();
    if (lastResetDate !== today) {
        if (lastResetDate !== '') {
            log('系统', '跨日重置，清空操作限制缓存');
        }
        operationLimits.clear();
        canGetHelpExp = true;
        badOperationLimitReached = loadBadDailyStop(today);
        if (helpAutoDisabledByLimit) {
            helpAutoDisabledByLimit = false;
            log('好友', '新的一天已开始，自动恢复帮忙操作功能', {
                module: 'friend',
                event: '好友巡查循环',
                result: 'ok',
            });
        }
        lastResetDate = today;
    }
}

export function isBadOperationLimitReached(): boolean {
    checkDailyReset();
    return badOperationLimitReached;
}

export function markBadOperationLimitReached(method: string = ''): boolean {
    checkDailyReset();
    if (badOperationLimitReached) return false;
    badOperationLimitReached = true;
    try {
        persistBadDailyStop(lastResetDate || getSystemDateKey());
    } catch (e: any) {
        logWarn('好友', `保存当日捣乱停用状态失败: ${e.message}`);
    }
    log('好友', '今日放虫/放草次数已达上限，停止两类操作', {
        module: 'friend',
        event: '放虫放草次数上限',
        result: 'limit',
        code: 1001046,
        method: String(method || ''),
    });
    return true;
}

export function autoDisableHelpByExpLimit(): void {
    if (!canGetHelpExp) return;
    canGetHelpExp = false;
    helpAutoDisabledByLimit = true;
    log('好友', '今日帮助经验已达上限，自动停止帮忙', {
        module: 'friend',
        event: '好友巡查循环',
        result: 'ok',
    });
}

/**
 * 更新操作限制状态
 */
export function updateOperationLimits(limits: any[]): void {
    if (!limits || limits.length === 0) return;
    checkDailyReset();
    for (const limit of limits) {
        const id: number = toNum(limit.id);
        if (id > 0) {
            const data: any = {
                dayTimes: toNum(limit.day_times),
                dayTimesLimit: toNum(limit.day_times_lt),
                dayExpTimes: toNum(limit.day_exp_times),
                dayExpTimesLimit: toNum(limit.day_ex_times_lt), // 协议字段名为 day_ex_times_lt
            };
            operationLimits.set(id, data);
            if (id === BAD_SHARED_LIMIT_ID && data.dayTimesLimit > 0 && data.dayTimes >= data.dayTimesLimit) {
                markBadOperationLimitReached('operation_limit');
            }
        }
    }
}

export function canGetExpByCandidates(opIds: number[] = []): boolean {
    const ids: number[] = Array.isArray(opIds) ? opIds : [opIds];
    for (const id of ids) {
        if (canGetExp(toNum(id))) return true;
    }
    return false;
}

/**
 * 检查某操作是否还能获得经验
 */
export function canGetExp(opId: number): boolean {
    const limit: any = operationLimits.get(opId);
    if (!limit) return false;  // 没有限制信息，保守起见不帮助（等待限制数据）
    if (limit.dayExpTimesLimit <= 0) return true;  // 没有经验上限
    return limit.dayExpTimes < limit.dayExpTimesLimit;
}

/**
 * 检查某操作是否还有次数
 */
export function canOperate(opId: number): boolean {
    checkDailyReset();
    if ((opId === BAD_SHARED_LIMIT_ID || opId === 10004) && badOperationLimitReached) return false;
    const limit: any = operationLimits.get(opId);
    if (!limit) return true;
    if (limit.dayTimesLimit <= 0) return true;
    return limit.dayTimes < limit.dayTimesLimit;
}

/**
 * 获取某操作剩余次数
 */
export function getRemainingTimes(opId: number): number {
    checkDailyReset();
    if ((opId === BAD_SHARED_LIMIT_ID || opId === 10004) && badOperationLimitReached) return 0;
    const limit: any = operationLimits.get(opId);
    if (!limit || limit.dayTimesLimit <= 0) return 999;
    return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
}

export function getRemainingBadOperationTimes(): number {
    checkDailyReset();
    if (badOperationLimitReached) return 0;
    const limit: any = operationLimits.get(BAD_SHARED_LIMIT_ID);
    if (!limit || limit.dayTimesLimit <= 0) return 999;
    return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
}

/**
 * 获取操作限制详情 (供管理面板使用)
 */
export function getOperationLimits(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const id of [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008]) {
        const limit: any = operationLimits.get(id);
        if (limit) {
            result[id] = {
                name: OP_NAMES[id] || `#${id}`,
                ...limit,
                remaining: getRemainingTimes(id),
            };
        }
    }
    return result;
}

// ============ 帮助经验状态访问器 ============

export function getCanGetHelpExp(): boolean {
    return canGetHelpExp;
}

export function setCanGetHelpExp(val: boolean): void {
    canGetHelpExp = val;
}

// ============ 好友巡查主循环 ============

interface CheckFriendsOptions {
    onlyHelp?: boolean;
    onlySteal?: boolean;
    onlyBad?: boolean;
    ignoreExpLimit?: boolean;
    /** [fnos-fork] 2026-11-17 只去好友时间表里到点的好友（不拉好友列表、不捣乱） */
    fnosTimetable?: boolean;
    /** [fnos-fork] 2026-11-17 好友农场状态轮巡：自家一轮做完后，用缓存的好友列表进好友家读成熟时间（能偷能帮的顺手做，不捣乱） */
    fnosProbeRound?: boolean;
}

// 好友巡查与面板的好友天气扫描共用“进入好友农场”这一游戏状态，
// 扫描靠这个标志让位，保证好友任务优先执行。
export function isFriendCheckRunning(): boolean {
    return isCheckingFriends;
}

export async function checkFriends(options: CheckFriendsOptions = {}): Promise<boolean> {
    const state: any = getUserState();
    if (!isAutomationOn('friend')) return false;

    const accountId: string = process.env.FARM_ACCOUNT_ID || '';

    const helpEnabled: boolean = !!isAutomationOn('friend_help');
    const stealEnabled: boolean = !!isAutomationOn('friend_steal');
    const badEnabled: boolean = !!isAutomationOn('friend_bad');

    const onlyHelp: boolean = options.onlyHelp || false;
    const onlySteal: boolean = options.onlySteal || false;
    const onlyBad: boolean = options.onlyBad || false;
    const ignoreExpLimit: boolean = options.ignoreExpLimit || false;

    const effectiveHelpEnabled: boolean = onlyHelp ? true : (onlySteal || onlyBad ? false : helpEnabled);
    const effectiveStealEnabled: boolean = onlySteal ? true : (onlyHelp || onlyBad ? false : stealEnabled);
    const effectiveBadEnabled: boolean = onlyBad ? true : (onlyHelp || onlySteal ? false : badEnabled);

    // [fnos-fork] 大小号协作：「只给大号放捣乱」不受「自动捣乱」开关限制（只帮忙/只偷菜的手动模式除外）
    const altCoop: any = getAltCoopSettings();
    const altCoopBad: boolean = !!(altCoop && altCoop.badOnly) && !onlyHelp && !onlySteal;
    const hasAnyFriendOp: boolean = effectiveHelpEnabled || effectiveStealEnabled || effectiveBadEnabled || altCoopBad;
    if (isCheckingFriends || !state.gid || !hasAnyFriendOp) return false;
    if (inFriendQuietHours()) return false;

    isCheckingFriends = true;
    checkDailyReset();
    const generation = friendLoopGeneration;
    const roundDate = getSystemDateKey();
    const canContinue = (): boolean => generation === friendLoopGeneration
        && !!getUserState().gid && isAutomationOn('friend') && !inFriendQuietHours()
        && getSystemDateKey() === roundDate && isGatewayHealthyForBusiness(getGatewayLoad());

    async function waitStealGap(target: any): Promise<void> {
        let remainingMs = getStealDelaySeconds(accountId) * 1000;
        while (remainingMs > 0 && canContinue() && isAutomationOn('friend_steal')
            && !getFriendBlacklist(accountId).includes(target.gid)) {
            const sliceMs = Math.min(remainingMs, 1000);
            await sleep(sliceMs);
            remainingMs -= sliceMs;
        }
    }

    try {
        const blacklist: Set<number> = new Set(getFriendBlacklist(accountId));

        // 经验满不帮时，本轮只帮当天缓存已确认是护主犬的好友；缓存没结论的交给每日宠物同步补齐。
        const stopWhenExpLimit: boolean = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;
        const protectDogBypassEnabled: boolean = !!isAutomationOn('friend_help_protect_dog_ignore_exp_limit');
        const helpAllowedForAll: boolean = !stopWhenExpLimit || canGetHelpExp;

        // [fnos-fork] 2026-11-17 好友时间表：取出到点的好友，套用同一套访问计划（偷 / 帮开关、经验上限、黑名单）与大小号规则；不捣乱
        const timetableMode: boolean = !!options.fnosTimetable;
        const buildTimetableVisits = (): any[] => {
            if (onlyBad || (!effectiveStealEnabled && !effectiveHelpEnabled)) return [];
            const due: any[] = fnosTimetable.takeDueFarm();
            if (due.length === 0) return [];
            const cached: any[] = (() => { try { return getFriendsListCacheOnly() || []; } catch { return []; } })();
            const byGid: Map<number, any> = new Map(cached.map((f: any) => [toNum(f && f.gid), f]));
            const rows: any[] = due.map((t: any) => {
                const f: any = byGid.get(t.gid) || { gid: t.gid, name: t.name, level: 0 };
                // 列表缓存可能是几分钟前的：按时间表认为可偷（成熟到点）/ 要帮（帮忙到点），进去后 visitFriend 以真实土地为准；
                // 偷菜到点不额外算「要帮」，免得为帮忙多进一次
                const plant: any = { steal_plant_num: 0, dry_num: 0, weed_num: 0, insect_num: 0 };
                if (t.kind === 'steal') plant.steal_plant_num = 1;
                else plant.dry_num = 1;
                return { ...f, plant };
            });
            const ttPlan: any = buildFriendVisitPlan({
                friends: rows, myGid: state.gid, blacklist,
                stealEnabled: effectiveStealEnabled, helpEnabled: effectiveHelpEnabled, badEnabled: false,
                helpAllowedForAll, protectDogBypassEnabled, getDogState: getFriendDogState,
                badBudget: 0, maxBadOnlyVisits: 0,
            });
            adjustVisitPlanForAltCoop(ttPlan, {
                coop: altCoop, friends: rows, blacklist, badActive: false, badBudget: 0,
                log: (msg: string) => log('小号', msg, { module: 'friend', event: '大小号协作' }),
            });
            for (const v of ttPlan.visits) {
                const d: any = due.find((x: any) => x.gid === v.gid);
                v.fnosTimetable = d || true;
                const when: string = d && d.kind === 'help' ? `预计需要帮忙 ${fnosTimetable.formatClock(d.at)}` : `预计成熟 ${fnosTimetable.formatClock(d ? d.at : 0)}`;
                log('好友', `按时间表前往 ${v.name}（${when}）`, {
                    module: 'friend', event: '按时间表前往', friendName: v.name, friendGid: v.gid, kind: d ? d.kind : 'steal', dueAt: d ? d.at : 0,
                });
            }
            return ttPlan.visits;
        };

        let friends: any[] = [];
        let plan: any;
        let probeCount = 0;
        const probeRound: boolean = !timetableMode && !!options.fnosProbeRound;
        if (probeRound) {
            if (!effectiveStealEnabled || onlyHelp || onlyBad) return false;
            friends = (() => { try { return getFriendsListCacheOnly() || []; } catch { return []; } })();
            if (friends.length === 0) return false; // 还没扫过好友列表：等常规扫描
            plan = { visits: [], stealCount: 0, helpCount: 0, badOnlyCount: 0, skippedExpLimit: 0, skippedUnknownDog: 0 };
            let unseen = 0;
            const seen: Set<number> = new Set(fnosTimetable.snapshotForUi().filter((r: any) => r.farmSeenAt > 0).map((r: any) => r.gid));
            for (const f of fnosTimetable.probeTargets(friends, blacklist)) {
                const gid: number = toNum(f && f.gid);
                if (gid <= 0 || gid === state.gid) continue;
                if (!seen.has(gid)) unseen++;
                plan.visits.push({ gid, name: (f.remark || f.name) || `GID:${gid}`, level: toNum(f.level), stealNum: 0, helpNum: 0, dryNum: 0, weedNum: 0, insectNum: 0, wantSteal: true, wantHelp: false, wantBad: false, fnosProbe: true });
            }
            adjustVisitPlanForAltCoop(plan, {
                coop: altCoop, friends, blacklist, badActive: false, badBudget: 0,
                log: (msg: string) => log('小号', msg, { module: 'friend', event: '大小号协作' }),
            });
            plan.visits = plan.visits.filter((v: any) => v.wantSteal || v.wantHelp);
            probeCount = plan.visits.length;
            plan.stealCount = probeCount;
            if (probeCount === 0) return false;
            log('好友', `好友农场状态轮巡：本轮 ${probeCount} 位（未扫描 ${Math.min(unseen, probeCount)} / 复查空地 ${Math.max(0, probeCount - unseen)}），已知成熟时间的跳过`, {
                module: 'friend', event: '好友状态轮巡', count: probeCount,
            });
        } else if (timetableMode) {
            const visits: any[] = buildTimetableVisits();
            if (visits.length === 0) return false;
            plan = { visits, stealCount: visits.filter((v: any) => v.wantSteal).length, helpCount: visits.filter((v: any) => v.wantHelp).length, badOnlyCount: 0, skippedExpLimit: 0, skippedUnknownDog: 0 };
        } else {
        const friendsReply: any = await runExclusiveAutomationTask('friend_list', () => (
            canContinue() ? getAllFriends() : null
        ), { detached: true });
        if (!canContinue()) return false;
        // 巡查结果同时刷新面板好友列表缓存，避免页面再次请求同一份列表。
        cacheFriendsListFromReply(friendsReply);
        friends = extractReplyFriends(friendsReply);
        if (friends.length === 0) {
            log('好友', '没有好友', { module: 'friend', event: '好友扫描', result: 'empty' });
            return false;
        }
        // [fnos-fork] 2026-11-17 好友时间表：记下每位好友下次需要帮忙的时间
        try { fnosTimetable.noteFarmList(friends); } catch { /* ignore */ }

        // 一次算清每位好友这轮要做哪几件事，然后每位好友只进一次农场把三件事一起做完。
        plan = buildFriendVisitPlan({
            friends,
            myGid: state.gid,
            blacklist,
            stealEnabled: effectiveStealEnabled,
            helpEnabled: effectiveHelpEnabled,
            badEnabled: effectiveBadEnabled && !isBadOperationLimitReached(),
            helpAllowedForAll,
            protectDogBypassEnabled,
            getDogState: getFriendDogState,
            badBudget: getRemainingBadOperationTimes(),
            maxBadOnlyVisits: MAX_BAD_ONLY_VISITS_PER_ROUND,
        });
        // [fnos-fork] 2026-11-17 探成熟时间改为自家一轮做完后的「好友状态轮巡」（checkFriends({ fnosProbeRound: true })），常规扫描不再探
        // [fnos-fork] 大小号协作：调整对大号/其他好友的偷菜与捣乱
        adjustVisitPlanForAltCoop(plan, {
            coop: altCoop,
            friends,
            blacklist,
            badActive: (effectiveBadEnabled || altCoopBad) && !isBadOperationLimitReached(),
            badBudget: getRemainingBadOperationTimes(),
            log: (msg: string) => log('小号', msg, { module: 'friend', event: '大小号协作' }),
        });

        probeCount = plan.visits.filter((v: any) => v.fnosProbe).length;
        // [fnos-fork] 空闲时只保留心跳：记下本轮要访问几位好友（0 = 好友这边空闲；探成熟时间的不算）
        try { require('../fnos-quiet-priority').recordFriendRound(plan.visits.length - probeCount); } catch { /* ignore */ }
        }

        const totalActions: any = { steal: 0, farming: 0, putBug: 0, putWeed: 0 };

        if (plan.skippedExpLimit > 0) {
            log('好友', `经验已达上限，本轮跳过 ${plan.skippedExpLimit} 位非护主犬好友（未进农场，其中 ${plan.skippedUnknownDog} 位宠物待同步）`, {
                module: 'friend',
                event: '好友巡查跳过',
                reason: 'protect_dog_cache_filtered',
                count: plan.skippedExpLimit,
                unknownDog: plan.skippedUnknownDog,
            });
        }

        if (plan.visits.length === 0) return false;

        if (!timetableMode && !probeRound) log('好友', `开始好友巡查，本轮 ${plan.visits.length} 位（可偷 ${plan.stealCount - probeCount} / 需帮 ${plan.helpCount} / 纯捣乱 ${plan.badOnlyCount}${probeCount ? ` / 探成熟时间 ${probeCount}` : ''}）`, {
            module: 'friend',
            event: '开始好友巡查',
            count: plan.visits.length,
            steal: plan.stealCount,
            help: plan.helpCount,
            bad: plan.badOnlyCount,
        });

        // 经验在本轮中途满掉之后被跳过的好友数
        let midRoundExpSkipped: number = 0;
        let attemptedStealVisit = false;

        // [fnos-fork] 2026-11-17 用队列：常规巡查每访问一位前，先把时间表里到点的好友插到最前面（偷 > 帮 > 捣乱）
        const queue: any[] = plan.visits.slice();
        while (queue.length > 0) {
            if (!timetableMode && fnosTimetable.isEnabled()) {
                try { const urgent: any[] = buildTimetableVisits(); if (urgent.length) queue.unshift(...urgent); } catch { /* ignore */ }
            }
            const target: any = queue.shift();
            if (!canContinue()) return false;
            // [fnos-fork] 自己收菜优先：自家作物正在成熟时，访问下一位好友前先等自家收完（最多 30 秒）
            await require('../fnos-quiet-priority').waitForOwnHarvestBeforeFriendVisit(canContinue);
            if (!canContinue()) return false;
            if (getFriendBlacklist(accountId).includes(target.gid)) continue;
            if (attemptedStealVisit && target.wantSteal && !target.fnosProbe && isAutomationOn('friend_steal')) {
                // 首位可偷好友立即访问，后续等待不持有自动化锁。
                await waitStealGap(target);
            }
            if (!canContinue()) return false;
            if (getFriendBlacklist(accountId).includes(target.gid)) continue;
            if (target.wantBad && !target.wantSteal && !target.wantHelp) { // [fnos-fork] 大号可能同时有偷/帮和捣乱
                // 纯捣乱的好友都排在队尾，额度一用完这一轮就可以收工
                if (isBadOperationLimitReached() || getRemainingBadOperationTimes() <= 0) {
                    log('好友', '放虫放草次数已用完，停止执行', { module: 'friend', event: '放虫放草次数用完' });
                    break;
                }
            } else if (target.wantHelp && !target.wantSteal && stopWhenExpLimit && !canGetHelpExp) {
                // 帮忙是这次进农场的唯一目的，但经验在本轮中途满了：不是护主犬就别进去了
                if (!protectDogBypassEnabled || getFriendDogState(target.gid) !== 'protect') {
                    midRoundExpSkipped += 1;
                    continue;
                }
            }

            try {
                await runExclusiveAutomationTask('friend_visit', async () => {
                    if (!canContinue() || getFriendBlacklist(accountId).includes(target.gid)) return;
                    const altVisitOpts = getVisitOptionsForAltCoop(altCoop, target); // [fnos-fork] 大小号协作
                    const allowSteal = target.wantSteal && isAutomationOn('friend_steal');
                    // [fnos-fork] 2026-11-17 按时间表去偷 / 探成熟时间时也顺手帮忙（经验上限、护主犬规则在 visitFriend 里照旧判断）
                    const allowHelp = (target.wantHelp || !!target.fnosTimetable || !!target.fnosProbe) && isAutomationOn('friend_help');
                    // [fnos-fork] forceBad 时允许对大号捣乱，即使「自动捣乱」关着
                    const allowBad = target.wantBad && (!!isAutomationOn('friend_bad') || !!(altVisitOpts && altVisitOpts.forceBad));
                    if (!allowSteal && !allowHelp && !allowBad) return;
                    if (allowSteal && !target.fnosProbe) attemptedStealVisit = true;
                    await visitFriend(target, totalActions, state.gid, state.accountId, {
                        allowSteal,
                        allowHelp,
                        allowBad,
                        ignoreExpLimit,
                        ...altVisitOpts, // [fnos-fork] 大小号协作
                    });
                }, { detached: true });
            } catch (e: any) {
                if (isGatewayYieldError(e) || String(e.message).includes('stage=pending')) throw e;
                log('好友', `巡查好友失败: ${target.name}, 错误: ${e.message}`, {
                    module: 'friend', event: '好友巡查失败', friendName: target.name, error: e.message,
                });
            }

            // 普通访问快速让位，捣乱仍保留较慢间隔。
            if (target.wantBad) await randomDelay(2000, 3500);
            else if (target.fnosProbe) {
                // [fnos-fork] 2026-11-17 状态轮巡的翻阅节奏（参考空间版）：每位 500～1000 毫秒，每翻阅 300 位休息 15～25 秒
                const pace: any = fnosTimetable.nextPageTurn();
                await sleep(pace.gapMs);
                if (pace.restMs > 0 && queue.length > 0) {
                    log('好友', `已翻阅 ${pace.count} 位好友，休息 ${Math.round(pace.restMs / 1000)} 秒`, { module: 'friend', event: '好友状态轮巡', result: 'rest' });
                    for (let left = pace.restMs; left > 0 && canContinue(); left -= 1000) await sleep(Math.min(1000, left));
                }
            } else await randomDelay(200, 350);
        }

        if (!canContinue()) return false;
        if (midRoundExpSkipped > 0) {
            log('好友', `本轮帮助经验在中途达到上限，跳过剩余 ${midRoundExpSkipped} 位非护主犬好友`, {
                module: 'friend', event: '好友巡查跳过', reason: 'exp_limit', count: midRoundExpSkipped,
            });
        }

        // 偷菜后自动出售
        if (totalActions.steal > 0) {
            try {
                await runExclusiveAutomationTask('friend_sell', () => (
                    canContinue() ? sellAllFruits() : undefined
                ), { detached: true });
            } catch {
                // ignore
            }
        }

        // 生成总结日志
        const summary: string[] = [];
        if (totalActions.steal > 0) summary.push(`偷${totalActions.steal}`);
        if (totalActions.farming > 0) summary.push(`一键务农${totalActions.farming}`);
        if (totalActions.putBug > 0) summary.push(`放虫${totalActions.putBug}`);
        if (totalActions.putWeed > 0) summary.push(`放草${totalActions.putWeed}`);

        const totalVisited: number = plan.visits.length;
        if (summary.length > 0) {
            log('好友', `巡查完成 → ${summary.join('/')}`, {
                module: 'friend', event: '好友巡查循环', result: 'ok', visited: totalVisited, summary
            });
        }
        return summary.length > 0;

    } catch (err: any) {
        logWarn('好友', `巡查异常: ${err.message}`);
        return false;
    } finally {
        isCheckingFriends = false;
    }
}

// ============ 循环控制 ============

/**
 * 好友巡查循环 - 本次完成后等待指定秒数再开始下次
 */
async function friendCheckLoop(): Promise<void> {
    if (externalSchedulerMode) return;
    if (!friendLoopRunning) return;
    await checkFriends();
    if (!friendLoopRunning) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, CONFIG.friendCheckInterval), () => friendCheckLoop());
}

interface StartOptions {
    externalScheduler?: boolean;
}

function onFnosFriendLandsChanged(payload: any): void {
    try { fnosTimetable.notePushLands(payload && payload.hostGid, (payload && payload.lands) || []); } catch { /* ignore */ }
}

export function startFriendCheckLoop(options: StartOptions = {}): void {
    if (friendLoopRunning) return;
    externalSchedulerMode = !!options.externalScheduler;
    friendLoopRunning = true;

    // 注册操作限制更新回调，从农场检查中获取限制信息
    setOperationLimitsCallback(updateOperationLimits);

    // 监听好友申请推送 (微信同玩)
    networkEvents.on('friendApplicationReceived', onFriendApplicationReceived);
    // [fnos-fork] 2026-11-17 好友农场土地推送 → 好友时间表（只更新成熟时间，不额外插队）
    networkEvents.on('fnosFriendLandsChanged', onFnosFriendLandsChanged);

    if (!externalSchedulerMode) {
        // 延迟 5 秒后启动循环，等待登录和首次农场检查完成
        friendScheduler.setTimeoutTask('friend_check_loop', 5000, () => friendCheckLoop());
    }

    // 启动时检查一次待处理的好友申请
    friendScheduler.setTimeoutTask('friend_check_bootstrap_applications', 3000, () => (
        runExclusiveAutomationTask('friend_applications_bootstrap', checkAndAcceptApplications).catch(() => null)
    ));

    // 好友宠物每日同步（自带启动错峰与定时重试）
    petSyncRef().startFriendPetSyncTimer();
}

export function stopFriendCheckLoop(): void {
    friendLoopRunning = false;
    friendLoopGeneration++;
    externalSchedulerMode = false;
    petSyncRef().stopFriendPetSyncTimer();
    flushFriendPetCacheNow();
    clearAllInvalidKnownFriendGidCooldowns();
    clearFriendsListCache();
    networkEvents.off('friendApplicationReceived', onFriendApplicationReceived);
    networkEvents.off('fnosFriendLandsChanged', onFnosFriendLandsChanged);
    try { fnosTimetable.flushNow(); } catch { /* ignore */ }
    friendScheduler.clearAll();
}

export function refreshFriendCheckLoop(delayMs: number = 200): void {
    if (!friendLoopRunning || externalSchedulerMode) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, delayMs), () => friendCheckLoop());
}

// ============ 自动同意好友申请 (微信同玩) ============

let applicationQueue: Promise<void> = Promise.resolve();

function getApplicationFilterConfig(): any {
    return {
        minLevel: getAutoAcceptFriendMinLevel(),
        requireOwnLevel: getAutoAcceptRequireOwnLevel(),
        ownLevel: toNum((getUserState() || {}).level),
        harvestStealEnabled: getAutoAcceptHarvestStealEnabled(),
        harvestPart: getAutoAcceptHarvestStealHarvest(),
        stealPart: getAutoAcceptHarvestStealSteal(),
    };
}

function enqueueApplications(applications: any[]): void {
    applicationQueue = applicationQueue
        .then(() => runExclusiveAutomationTask('friend_applications_push', () => processFriendApplications(applications)))
        .catch((e: any) => {
            logWarn('申请', `处理好友申请失败: ${e && e.message ? e.message : e}`);
        });
}

/**
 * 处理服务器推送的好友申请
 */
export function onFriendApplicationReceived(applications: any[]): void {
    if (!Array.isArray(applications) || applications.length === 0) return;
    const names: string = applications.map((a: any) => a.name || `GID:${toNum(a.gid)}`).join(', ');
    log('申请', `收到 ${applications.length} 个好友申请: ${names}`);
    enqueueApplications(applications);
}

/**
 * 检查并处理所有待处理的好友申请
 */
async function checkAndAcceptApplications(): Promise<void> {
    // [fnos-fork] 仅打开「忽略高偷收比申请」时也要处理，不能等自动通过好友申请
    const stealRatio = readFnosStealRatio();
    if (!isAutomationOn('friend_auto_accept') && !stealRatio.ignoreApplications) return;
    try {
        const reply: any = await getApplications();
        const applications: any[] = reply.applications || [];
        if (applications.length === 0) return;

        const names: string = applications.map((a: any) => a.name || `GID:${toNum(a.gid)}`).join(', ');
        log('申请', `发现 ${applications.length} 个待处理申请: ${names}`);
        await processFriendApplications(applications);
    } catch {
        // 静默失败，可能是 QQ 平台不支持
    }
}

// [fnos-fork] 偷收比定时检查复用同一套申请处理
export async function checkFriendApplicationsNow(): Promise<void> {
    await checkAndAcceptApplications();
}

async function processFriendApplications(applications: any[]): Promise<void> {
    const stealRatio = readFnosStealRatio();
    const autoAccept = isAutomationOn('friend_auto_accept');
    // [fnos-fork] 忽略高偷收比申请可以单独开；没开时行为与上游一致
    if (!autoAccept && !stealRatio.ignoreApplications) return;
    const list: any[] = Array.isArray(applications) ? applications : [];
    if (list.length === 0) return;

    const config = getApplicationFilterConfig();
    const checkRatio = autoAccept && isHarvestStealFilterEnabled(config);
    const needCareer = !!stealRatio.ignoreApplications || checkRatio;
    const accountId: string = process.env.FARM_ACCOUNT_ID || '';
    const blacklist: Set<number> = new Set(getFriendBlacklist(accountId));
    const toAccept: number[] = [];
    const toReject: Array<{ gid: number; name: string; reason: string }> = [];

    for (let i = 0; i < list.length; i++) {
        const app: any = list[i];
        const gid: number = toNum(app && app.gid);
        const name: string = (app && app.name) || `GID:${gid}`;
        const level: number = toNum(app && app.level);
        if (!gid) continue;

        if (autoAccept && blacklist.has(gid)) {
            toReject.push({ gid, name, reason: '已在本地黑名单' });
            continue;
        }

        if (autoAccept) {
            const levelDecision = evaluateLevelFilter(level, config);
            if (levelDecision.action === 'reject') {
                toReject.push({ gid, name, reason: levelDecision.reason || '等级不足' });
                continue;
            }
        }

        let career: any = null;
        if (needCareer) {
            try {
                career = await getCareerInfo(gid);
            } catch (e: any) {
                logWarn('申请', `${name} 生涯查询失败，暂不处理: ${e && e.message ? e.message : e}`);
                if (i < list.length - 1) await randomDelay(150, 300);
                continue;
            }
        }

        // [fnos-fork] 偷收比超过阈值则拒绝，不进入自动通过
        if (stealRatio.ignoreApplications && career) {
            const stealDecision = decideStealRatioApplication(career.harvest, career.steal, stealRatio.thresholdPercent, true);
            if (stealDecision.action === 'reject') {
                toReject.push({ gid, name, reason: stealDecision.reason || '偷收比过高' });
                if (i < list.length - 1) await randomDelay(150, 300);
                continue;
            }
        }

        if (!autoAccept) {
            if (i < list.length - 1 && needCareer) await randomDelay(150, 300);
            continue;
        }

        if (!checkRatio) {
            toAccept.push(gid);
        } else {
            const ratioDecision = evaluateHarvestStealFilter(career.harvest, career.steal, config);
            if (ratioDecision.action === 'reject') {
                toReject.push({ gid, name, reason: ratioDecision.reason || '收偷比不足' });
            } else {
                toAccept.push(gid);
            }
        }

        if (i < list.length - 1 && needCareer) {
            await randomDelay(150, 300);
        }
    }

    for (const item of toReject) {
        log('申请', `拒绝 ${item.name}: ${item.reason}`);
    }

    await rejectFriendsWithRetry(toReject.map((item) => item.gid));
    await acceptFriendsWithRetry(toAccept);
}

async function rejectFriendsWithRetry(gids: number[]): Promise<void> {
    if (gids.length === 0) return;
    try {
        await rejectFriends(gids);
        log('申请', `已拒绝 ${gids.length} 人`);
    } catch (e: any) {
        logWarn('申请', `拒绝失败: ${e.message}`);
    }
}

/**
 * 同意好友申请 (带重试)
 */
async function acceptFriendsWithRetry(gids: number[]): Promise<void> {
    if (gids.length === 0) return;
    try {
        const reply: any = await acceptFriends(gids);
        const friends: any[] = reply.friends || [];
        if (friends.length > 0) {
            const names: string = friends.map((f: any) => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
            log('申请', `已同意 ${friends.length} 人: ${names}`);
        }
    } catch (e: any) {
        logWarn('申请', `同意失败: ${e.message}`);
    }
}

// ============ 公开状态查询 ============

// 检查帮助经验是否已达上限（用于外部判断是否需要执行帮助巡查）
export function isHelpExpLimitReached(): boolean {
    return helpAutoDisabledByLimit;
}

