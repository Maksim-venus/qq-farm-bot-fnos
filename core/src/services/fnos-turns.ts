export {};
/**
 * [fnos-fork] 2026-11-17 农场、牧场轮流（用户批准「农场、牧场轮流」）。
 *
 * 一轮农场 = 一次巡田（含任务 / 礼包等 farm_tick 里的例程）+ 一次好友巡查（好友开关开着、且这一轮里好友巡查到点 / 正在跑时）；
 * 一轮牧场 = 一次完整的牧场例程（自己牧场 + 好友牧场 + 牧场任务 / 分享 / 图鉴，ranch/automation.run 跑完一整轮不让路）。
 * 2026-11-17 用户改规则「农场跑完一轮，就去牧场，牧场跑完就去农场」：严格交替。
 *   农场一轮做完 → 直接切牧场（不再等 ranch_check_minutes / 动物成熟；只保留 20 秒的场景重进间隔，避免来回切场景刷请求）；
 *   牧场一轮做完 → 切回农场。牧场单轮超过 10 分钟强制回农场。
 * 好友巡查改为「按时间表」后间隔是几分钟一次，没到点时不等它：这一轮农场只算巡田。
 *
 * 插队（无论轮到谁都立即处理，处理完回到原轮次）：
 *   - 农场：自家作物将熟（提前 ownLeadSec 秒进去等，fnos-quiet-priority.ownPriorityMatureAt）；
 *     好友时间表到点（fnos-timetable：好友作物成熟 / 需要帮忙）→ 直接去该好友，不等整轮；
 *     推送收菜（farm_push_check）本来就有自己的定时器，不受轮次限制。
 *   - 牧场：自家动物成熟 / 建筑升级完成 / 小号等大号超时放行（ranch/automation.timedWakeAt，提前 ownLeadSec 秒）；
 *     好友牧场时间表到点（fnos-timetable）。
 * 「空闲时只保留心跳」静默期间两边都停（worker 原有判断），静默结束从农场开始。
 *
 * 这里只有纯状态机，worker.ts 负责调用；日志在切换时各写一条（农场日志 + 牧场日志）。
 */

export type FnosTurn = 'farm' | 'ranch';

/** 牧场一轮最长占多久；超过就交回农场，防止牧场例程反复让路 / 出错时农场被饿死 */
const RANCH_TURN_MAX_MS = 10 * 60 * 1000;

interface TurnState {
    turn: FnosTurn;
    since: number;
    farmTickDone: boolean;
    friendDone: boolean;
    switches: number;
}

let state: TurnState = { turn: 'farm', since: 0, farmTickDone: false, friendDone: false, switches: 0 };
let logger: ((msg: string, space: FnosTurn | 'both', meta?: Record<string, any>) => void) | null = null;

function resetTurns(nowMs: number = Date.now()): void {
    state = { turn: 'farm', since: nowMs, farmTickDone: false, friendDone: false, switches: 0 };
}

function setTurnLogger(fn: typeof logger): void { logger = fn; }

function getTurnState(): Readonly<TurnState> { return { ...state }; }

function currentTurn(): FnosTurn { return state.turn; }

function emit(msg: string, meta: Record<string, any> = {}): void {
    try { if (logger) logger(msg, 'both', meta); } catch { /* ignore */ }
}

function switchTo(turn: FnosTurn, nowMs: number, reason: string): void {
    if (state.turn === turn) return;
    const from = state.turn;
    state = { turn, since: nowMs, farmTickDone: false, friendDone: false, switches: state.switches + 1 };
    const label = (t: FnosTurn) => (t === 'farm' ? '农场' : '牧场');
    emit(`轮次切换：${label(from)} → ${label(turn)}（${reason}）`, { from, to: turn, reason });
}

/** 农场轮里一次常规巡田跑完（插队的不算） */
function noteFarmTickDone(): void {
    if (state.turn === 'farm') state.farmTickDone = true;
}

/** 农场轮里一次好友巡查跑完 */
function noteFriendDone(): void {
    if (state.turn === 'farm') state.friendDone = true;
}

/**
 * 牧场例程跑完一次。status：done = 一整轮做完；yielded = 给插队的农场让路，还没做完；skipped / disabled = 没东西可做；error = 出错。
 * 只有牧场轮里的才推动轮次；农场轮里插队跑的牧场不影响农场轮。
 */
function noteRanchRun(status: string, nowMs: number = Date.now()): void {
    if (state.turn !== 'ranch') return;
    if (status === 'yielded') return;
    const reason = status === 'done' ? '牧场一轮完成' : status === 'error' ? '牧场一轮出错，先回农场' : '牧场暂时没有要做的事';
    switchTo('farm', nowMs, reason);
}

/**
 * 评估是否切换轮次（worker 每次调度前调用）。
 * - 农场轮：巡田做完且（好友没开 / 好友巡查做完 / 这一轮好友巡查没到点），牧场有事可做且过了场景重进间隔（ranchDue）→ 切牧场；
 *   牧场还在重进间隔里 / 今天无事 → 开始新一轮农场（不写日志）。
 * - 牧场轮：牧场已经不需要做（关了 / 今天无事）或超时 → 回农场。
 * friendPending：好友巡查到点了或正在跑（缺省视为 true，与旧行为一致）。
 */
function farmRoundDone(friendActive: boolean, friendPending: boolean): boolean {
    return state.farmTickDone && (!friendActive || state.friendDone || !friendPending);
}

function evaluateTurn(input: { nowMs: number; ranchDue: boolean; ranchHasWork: boolean; friendActive: boolean; friendPending?: boolean }): FnosTurn {
    const now = input.nowMs;
    if (state.turn === 'farm') {
        if (farmRoundDone(input.friendActive, input.friendPending !== false)) {
            if (input.ranchHasWork && input.ranchDue) switchTo('ranch', now, input.friendActive && state.friendDone ? '农场一轮完成（巡田 + 好友巡查）' : '农场一轮完成（巡田）');
            else { state.farmTickDone = false; state.friendDone = false; }
        }
    } else if (!input.ranchHasWork) {
        switchTo('farm', now, '牧场没有要做的事');
    } else if (now - state.since > RANCH_TURN_MAX_MS) {
        switchTo('farm', now, `牧场一轮超过 ${Math.round(RANCH_TURN_MAX_MS / 60000)} 分钟未完成，先回农场`);
    }
    return state.turn;
}

/**
 * 本次调度允许谁跑：
 *  - farm：农场轮常规巡田，或「自家作物将熟」插队；
 *  - friend：常规好友巡查只在农场轮；好友时间表到点（friendTimedDue）无论轮次都插队（friendInsert）；
 *  - ranch：牧场轮常规，或「动物成熟 / 等大号到点 / 好友牧场时间表到点」插队。
 */
function allowedNow(input: { farmTimedDue: boolean; ranchTimedDue: boolean; friendTimedDue?: boolean }): { farm: boolean; friend: boolean; ranch: boolean; farmInsert: boolean; ranchInsert: boolean; friendInsert: boolean } {
    const farmTurn = state.turn === 'farm';
    return {
        farm: farmTurn || input.farmTimedDue,
        friend: farmTurn,
        ranch: !farmTurn || input.ranchTimedDue,
        farmInsert: !farmTurn && input.farmTimedDue,
        ranchInsert: farmTurn && input.ranchTimedDue,
        friendInsert: !!input.friendTimedDue,
    };
}

/**
 * 下次调度时间：只看当前允许的一方 + 插队时间点（自家作物 / 自家牧场 / 好友时间表），避免轮到对方时每秒空转。
 * farmTimedAt / ranchTimedAt / friendTimedAt：插队时间点（0 = 无）。
 */
function nextWakeAt(input: {
    nowMs: number; nextFarmRunAt: number; nextFriendRunAt: number; ranchNextRunAt: number;
    farmTimedAt: number; ranchTimedAt: number; farmBusy: boolean; friendBusy: boolean; ranchDue: boolean; friendActive: boolean;
    friendTimedAt?: number; ranchHasWork?: boolean;
}): number {
    const inf = Number.POSITIVE_INFINITY;
    const pos = (v: number | undefined) => (v && v > 0 ? v : inf);
    const friendTimed = input.friendBusy ? inf : pos(input.friendTimedAt);
    if (state.turn === 'farm') {
        const friendPending = input.friendActive && (input.friendBusy || input.nextFriendRunAt <= input.nowMs);
        const roundDone = farmRoundDone(input.friendActive, friendPending);
        return Math.min(
            input.farmBusy ? inf : Math.min(input.nextFarmRunAt, pos(input.farmTimedAt)),
            input.friendBusy || !input.friendActive ? inf : input.nextFriendRunAt,
            roundDone && input.ranchHasWork !== false ? (input.ranchDue ? input.nowMs : input.ranchNextRunAt) : inf,
            pos(input.ranchTimedAt),
            friendTimed,
        );
    }
    return Math.min(input.ranchNextRunAt, input.farmBusy ? inf : pos(input.farmTimedAt), friendTimed);
}

module.exports = {
    RANCH_TURN_MAX_MS,
    resetTurns,
    setTurnLogger,
    getTurnState,
    currentTurn,
    noteFarmTickDone,
    noteFriendDone,
    noteRanchRun,
    evaluateTurn,
    allowedNow,
    nextWakeAt,
};
