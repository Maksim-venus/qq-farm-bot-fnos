export {};
/**
 * [fnos-fork] 2026-11-17 农场、牧场轮流（用户批准「农场、牧场轮流」）。
 *
 * 一轮农场 = 一次巡田（含任务 / 礼包等 farm_tick 里的例程）+ 一次好友巡查（好友开关开着时）；
 * 一轮牧场 = 一次完整的牧场例程（自己牧场 + 好友牧场 + 牧场任务 / 分享 / 图鉴，ranch/automation.run 跑完一整轮不让路）。
 * 农场一轮做完、且牧场到了该巡查的时间（牧场自己的 ranch_check_minutes / 动物成熟 / 等大号到点）→ 切到牧场；
 * 牧场一轮做完 → 切回农场。两边都没到点时按原来的间隔等，不空转。
 * 取代原来「牧场按 ranch_check_minutes 独立调度、每 5 秒切片给农场让路」：轮到谁，谁就把一轮做完。
 *
 * 插队（无论轮到谁都立即处理，处理完回到原轮次）：
 *   - 农场：自家作物将熟（fnos-quiet-priority.ownPriorityMatureAt，「自己收菜优先」开着时精确到点）；
 *     推送收菜（farm_push_check）、在线偷菜（fnos-steal-ratio）本来就有各自的定时器，不受轮次限制。
 *   - 牧场：自家动物成熟 / 建筑升级完成 / 小号等大号超时放行（ranch/automation.timedWakeAt）。
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
 * - 农场轮：巡田做完且（好友没开 / 好友巡查也做完），并且牧场已到点 → 切牧场；牧场没到点就开始新一轮农场（不写日志）。
 * - 牧场轮：牧场已经不需要做（关了 / 今天无事）或超时 → 回农场。
 */
function evaluateTurn(input: { nowMs: number; ranchDue: boolean; ranchHasWork: boolean; friendActive: boolean }): FnosTurn {
    const now = input.nowMs;
    if (state.turn === 'farm') {
        const farmRoundDone = state.farmTickDone && (!input.friendActive || state.friendDone);
        if (farmRoundDone) {
            if (input.ranchDue) switchTo('ranch', now, input.friendActive ? '农场一轮完成（巡田 + 好友巡查）' : '农场一轮完成（巡田）');
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
 *  - friend：只在农场轮；
 *  - ranch：牧场轮常规，或「动物成熟 / 等大号到点」插队。
 */
function allowedNow(input: { farmTimedDue: boolean; ranchTimedDue: boolean }): { farm: boolean; friend: boolean; ranch: boolean; farmInsert: boolean; ranchInsert: boolean } {
    const farmTurn = state.turn === 'farm';
    return {
        farm: farmTurn || input.farmTimedDue,
        friend: farmTurn,
        ranch: !farmTurn || input.ranchTimedDue,
        farmInsert: !farmTurn && input.farmTimedDue,
        ranchInsert: farmTurn && input.ranchTimedDue,
    };
}

/**
 * 下次调度时间：只看当前允许的一方 + 另一方的插队时间点，避免轮到对方时每秒空转。
 * farmTimedAt / ranchTimedAt：插队时间点（0 = 无）。
 */
function nextWakeAt(input: {
    nowMs: number; nextFarmRunAt: number; nextFriendRunAt: number; ranchNextRunAt: number;
    farmTimedAt: number; ranchTimedAt: number; farmBusy: boolean; friendBusy: boolean; ranchDue: boolean; friendActive: boolean;
}): number {
    const inf = Number.POSITIVE_INFINITY;
    const pos = (v: number) => (v > 0 ? v : inf);
    if (state.turn === 'farm') {
        const roundDone = state.farmTickDone && (!input.friendActive || state.friendDone);
        return Math.min(
            input.farmBusy ? inf : input.nextFarmRunAt,
            input.friendBusy || !input.friendActive ? inf : input.nextFriendRunAt,
            roundDone && input.ranchDue ? input.nowMs : inf,
            pos(input.ranchTimedAt),
        );
    }
    return Math.min(input.ranchNextRunAt, input.farmBusy ? inf : pos(input.farmTimedAt));
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
