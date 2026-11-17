export {};
/**
 * [fnos-fork] 2026-11-17 农场、牧场轮流（用户批准「农场、牧场轮流」）。
 *
 * 一轮农场 = 一次巡田（含任务 / 礼包等 farm_tick 里的例程）+ 一次好友巡查（好友开关开着、且这一轮里好友巡查到点 / 正在跑时）；
 * 一轮牧场 = 一次完整的牧场例程（自己牧场 + 好友牧场 + 牧场任务 / 分享 / 图鉴，ranch/automation.run 跑完一整轮不让路）。
 * 2026-11-17 用户改规则「农场跑完一轮，就去牧场，牧场跑完就去农场」：严格交替（不再等 ranch_check_minutes / 动物成熟）。
 * 2026-11-17 用户追加「农牧场切换至少 1 分钟，在牧场 1 分钟再进农场，农场 1 分钟再进牧场；如果有 30 秒内自己的收获就先不进入，等待收获」：
 *   切换条件 = 这一边一轮做完 + 在这一边已满 1 分钟（MIN_DWELL_MS）+ 这一边 30 秒内没有自己的收获（OWN_HOLD_MS）。
 *   这一边一轮提前做完时不重跑，等满 1 分钟（期间自家收获 / 好友时间表插队照常）；
 *   等自家收获最多再多等 2 分钟（MAX_OWN_HOLD_MS），防止作物 / 动物一个接一个成熟把另一边饿死。
 *   牧场单轮超过 10 分钟强制回农场；牧场出错 / 没事可做立即回农场。
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
/** 每一边至少停留多久才切到另一边 */
const MIN_DWELL_MS = 60 * 1000;
/** 这一边多久内有自己的收获就先不切，等收完 */
const OWN_HOLD_MS = 30 * 1000;
/** 为等自家收获最多额外多停多久（满 1 分钟之后算起） */
const MAX_OWN_HOLD_MS = 2 * 60 * 1000;

interface TurnState {
    turn: FnosTurn;
    since: number;
    farmTickDone: boolean;
    friendDone: boolean;
    /** 牧场轮里这一轮牧场例程已经做完（等满停留时间再回农场，期间不重跑） */
    ranchRoundDone: boolean;
    /** 开始为等自家收获而推迟切换的时刻（0 = 没在等） */
    holdSince: number;
    switches: number;
}

function freshState(turn: FnosTurn, nowMs: number, switches: number): TurnState {
    return { turn, since: nowMs, farmTickDone: false, friendDone: false, ranchRoundDone: false, holdSince: 0, switches };
}

let state: TurnState = freshState('farm', 0, 0);
let logger: ((msg: string, space: FnosTurn | 'both', meta?: Record<string, any>) => void) | null = null;

function resetTurns(nowMs: number = Date.now()): void {
    state = freshState('farm', nowMs, 0);
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
    state = freshState(turn, nowMs, state.switches + 1);
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
    if (status === 'done') { state.ranchRoundDone = true; return; } // 满 1 分钟 + 30 秒内没有自家收获后由 evaluateTurn 切回农场
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

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function clock(ms: number): string { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }

/** 这一边 30 秒内有自己的收获（刚过点 10 秒内还没收也算）；0 / 无效 = 没有 */
function ownSoon(at: number | undefined, now: number): boolean {
    return !!at && at > 0 && at >= now - 10_000 && at <= now + OWN_HOLD_MS;
}

/**
 * 一轮做完后能不能切走：满 MIN_DWELL_MS，且这一边 30 秒内没有自家收获（最多为此多等 MAX_OWN_HOLD_MS）。
 * 返回 true = 可以切。
 */
function readyToLeave(now: number, ownAt: number | undefined, label: string): boolean {
    if (now - state.since < MIN_DWELL_MS) return false;
    if (ownSoon(ownAt, now)) {
        if (!state.holdSince) {
            state.holdSince = now;
            emit(`${label}一轮已完成，自家 ${clock(Number(ownAt))} 到期，先等收完再切换`, { hold: true, ownAt });
        }
        if (now - state.holdSince < MAX_OWN_HOLD_MS) return false;
    }
    return true;
}

function evaluateTurn(input: {
    nowMs: number; ranchDue: boolean; ranchHasWork: boolean; friendActive: boolean; friendPending?: boolean;
    /** 自家作物下次成熟时间（毫秒，0 = 无）：农场轮切走前 30 秒内有就先等 */
    ownFarmAt?: number;
    /** 自家牧场下次到期时间（动物 / 升级 / 等大号，毫秒，0 = 无）：牧场轮切走前 30 秒内有就先等 */
    ownRanchAt?: number;
}): FnosTurn {
    const now = input.nowMs;
    if (state.turn === 'farm') {
        if (farmRoundDone(input.friendActive, input.friendPending !== false)) {
            if (input.ranchHasWork && input.ranchDue) {
                if (readyToLeave(now, input.ownFarmAt, '农场')) switchTo('ranch', now, input.friendActive && state.friendDone ? '农场一轮完成（巡田 + 好友巡查）' : '农场一轮完成（巡田）');
                // 没满 1 分钟 / 等自家收获：保持这一轮完成状态，农场照常巡田
            } else { state.farmTickDone = false; state.friendDone = false; state.holdSince = 0; }
        }
    } else if (!input.ranchHasWork) {
        switchTo('farm', now, '牧场没有要做的事');
    } else if (now - state.since > RANCH_TURN_MAX_MS) {
        switchTo('farm', now, `牧场一轮超过 ${Math.round(RANCH_TURN_MAX_MS / 60000)} 分钟未完成，先回农场`);
    } else if (state.ranchRoundDone && readyToLeave(now, input.ownRanchAt, '牧场')) {
        switchTo('farm', now, '牧场一轮完成');
    }
    return state.turn;
}

/** 牧场轮里这一轮牧场已做完、正在等满停留时间（这期间常规牧场例程不重跑，只有插队） */
function ranchRoundDone(): boolean { return state.turn === 'ranch' && state.ranchRoundDone; }

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
            roundDone && input.ranchHasWork !== false ? Math.max(input.ranchDue ? input.nowMs : input.ranchNextRunAt, state.since + MIN_DWELL_MS) : inf,
            pos(input.ranchTimedAt),
            friendTimed,
        );
    }
    if (state.ranchRoundDone) {
        // 这一轮牧场做完了：等满停留时间（等自家收获时由 ranchTimedAt 唤醒，另加 5 秒兜底复查）
        const leaveAt = state.since + MIN_DWELL_MS;
        return Math.min(leaveAt > input.nowMs ? leaveAt : input.nowMs + 5000, pos(input.ranchTimedAt), input.farmBusy ? inf : pos(input.farmTimedAt), friendTimed);
    }
    return Math.min(input.ranchNextRunAt, input.farmBusy ? inf : pos(input.farmTimedAt), friendTimed);
}

module.exports = {
    RANCH_TURN_MAX_MS,
    MIN_DWELL_MS,
    OWN_HOLD_MS,
    MAX_OWN_HOLD_MS,
    ranchRoundDone,
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
