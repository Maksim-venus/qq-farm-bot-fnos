export {};
/**
 * [fnos-fork] 牧场 fork 功能（2026-11-16，本 fork 新增，上游没有）。设置在 accountConfigs.<id>.fnosRanch，
 * 页面在「设置 → 牧场空间 → 自动控制」的「飞牛增强」卡片，随 /api/settings/save 保存。
 *
 * 1. 牧场也等大号（小号）：复用「大小号协作」里的 holdForMaster / timeoutMinutes。
 *    依据 animalpb.ProductLotDetail.stealers（货架上每批产物的偷取者 GID 列表，上游好友偷取也用它判断「我偷过没有」）：
 *    - 货架 can_collect 时，若大号 GID 已在任一批的 stealers 里 → 放行；
 *    - 货架上已没有剩余产物（remain_num 全为 0）→ 放行；
 *    - 否则从首次看到可收算起超时放行：用农场的 timeoutMinutes；农场设为 0（一直等）时，牧场改用
 *      altHoldFallbackMinutes（默认 60 分钟），避免货架长期占满。
 *    协议里没有按货架单独收取的已验证写法（HarvestRanch op=1 一键收全部、op=4 只收动物），所以只要还有一个货架在等，
 *    就只用 op=4 收成熟动物，不碰货架；全部放行后再按上游 op=1 一键收。大号自己、非小号账号不受影响。
 * 2. 牧场图鉴：自动领取（上游 claimIllustrated normal/giant，同样先报价再按 expected 提交）；
 *    自动完成：自动买幼崽（上游「自动买幼崽」开关）时优先挑产物还没进图鉴的动物（Illustrated.json 牧场主产物 = 动物 product_item）。
 * 3. 轮换值守：农场一轮有活（收/种/务农…）或好友巡查有访问后，去牧场逛一圈；农场无事时每 rotationIdleMinutes 分钟
 *    去一次。两次进牧场至少间隔 rotationMinGapSeconds；自己农场作物 OWN_MATURE_GUARD_MS 内要成熟时先不去。
 *    关闭 rotation 即回到上游「每 ranch_check_minutes 分钟 + 动物/建筑到点唤醒」的固定逻辑。
 * 4. 好友牧场巡查（偷成熟产物）：每 friendIntervalMinutes 分钟最多在一次牧场轮换里顺带走 friendMaxPerPatrol 个好友；
 *    每个好友 EnterHomestead → GetRanchDetail → （可偷才）StealProduce(targets=[]，同上游一键偷) → LeaveHomestead。
 *    规则：跳过好友黑名单、好友静默时段；本账号是小号且「不偷大号的菜」时不偷大号；本账号是大号时优先巡查自己的小号
 *    （与农场一样，大号照常偷小号——这正是小号等大号的配合）。好友冷却：偷到 15 分钟、没东西 30 分钟、失败 6 小时；
 *    每日访问上限 friendDailyVisitLimit（只在内存计数，重启清零）。
 *    好友牧场照顾（2026-11-16 按 1116-6 / 1116-7 完整抓包）：顺序为 偷 → 帮忙生产（开了偷则等产物上架再偷一次）→ 清理 → 放蚊子 → 加牧草。
 *    - 清理：CleanAllRanch {host_gid}，一次清掉该好友全部害；friendMosquito（hazard_type=1 蚊子）/ friendClean（=2 便便）各自开关，
 *      有已开启种类的害才清；小号开了「只给大号放捣乱」时不帮大号清。自己牧场的打蚊子 / 清便便用上游「清理」（automation.ranch_clean）。
 *    - 帮忙生产 friendHelpProduce：好友动物 can_deliver 时 TriggerProduce {host_gid}。
 *    - 放蚊子 friendPutMosquito（捣乱）：PutHazard {ranch_inst_id, host_gid, op_id:11003, count:1}，每窝棚最多 3 只；
 *      与农场同一规则：小号开了「只给大号放捣乱」→ 只给大号放（即使本开关关着）；否则不给自己的大号 / 小号 / 同大号的其它小号放；
 *      受 GetRanchOpTimes 11003（100/日）限制。本次清过害的好友不放。
 *    - 加牧草 friendFeed：AddFeed {instance_id, add_count, use_gold:true, host_gid}（与 1116-7 #172 一致），扣金币约 60/份；
 *      每次最多 friendFeedPerTime，自己金币低于 friendFeedGoldKeep 不加，且不超过好友牧草机剩余容量。
 *    - 清理 / 帮忙生产 / 偷 / 加牧草在 GetRanchOpTimes 里没有对应次数（抓包前后不变），请求报次数类错误或无效果时当天停止。
 */

const OWN_MATURE_GUARD_MS = 60 * 1000;
const BOOK_INTERVAL_MS = 30 * 60 * 1000;
const FRIEND_COOLDOWN_STOLE_MS = 15 * 60 * 1000;
const FRIEND_COOLDOWN_EMPTY_MS = 30 * 60 * 1000;
const FRIEND_COOLDOWN_ERROR_MS = 6 * 60 * 60 * 1000;

export interface FnosRanchConfig {
    rotation: boolean;
    rotationIdleMinutes: number;
    rotationMinGapSeconds: number;
    altHold: boolean;
    altHoldFallbackMinutes: number;
    illustratedAutoClaim: boolean;
    illustratedAutoComplete: boolean;
    friendSteal: boolean;
    /** 好友牧场清便便（hazard_type=2） */
    friendClean: boolean;
    /** 好友牧场打蚊子（hazard_type=1） */
    friendMosquito: boolean;
    /** 给好友加牧草（AddFeed use_gold:true，扣金币约 60/份） */
    friendFeed: boolean;
    /** 帮好友生产（TriggerProduce，好友动物 can_deliver 时） */
    friendHelpProduce: boolean;
    /** 给好友放蚊子（PutHazard，捣乱，占每日 11003 额度） */
    friendPutMosquito: boolean;
    /** 每个好友每次最多放几只蚊子（每个窝棚最多 3 只） */
    friendPutPerFriend: number;
    /** 每次给一个好友最多加多少牧草 */
    friendFeedPerTime: number;
    /** 自己金币低于此值不给好友加牧草（给好友加牧草扣金币，约 60 金币/份） */
    friendFeedGoldKeep: number;
    friendIntervalMinutes: number;
    friendMaxPerPatrol: number;
    friendDailyVisitLimit: number;
}

const DEFAULT_FNOS_RANCH: FnosRanchConfig = {
    rotation: true,
    rotationIdleMinutes: 1,
    rotationMinGapSeconds: 30,
    altHold: true,
    altHoldFallbackMinutes: 60,
    illustratedAutoClaim: false,
    illustratedAutoComplete: false,
    friendSteal: false,
    friendClean: false,
    friendMosquito: false,
    friendFeed: false,
    friendFeedPerTime: 10,
    friendFeedGoldKeep: 10000,
    friendHelpProduce: false,
    friendPutMosquito: false,
    friendPutPerFriend: 3,
    friendIntervalMinutes: 10,
    friendMaxPerPatrol: 5,
    friendDailyVisitLimit: 100,
};

function clampInt(value: any, min: number, max: number, fallback: number): number {
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function normalizeFnosRanch(input: unknown, fallback: FnosRanchConfig = DEFAULT_FNOS_RANCH): FnosRanchConfig {
    const base = { ...DEFAULT_FNOS_RANCH, ...(fallback || {}) };
    const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, any> : {};
    const bool = (key: keyof FnosRanchConfig) => src[key] !== undefined ? !!src[key] : !!base[key];
    const int = (key: keyof FnosRanchConfig, min: number, max: number) => clampInt(src[key] !== undefined ? src[key] : base[key], min, max, DEFAULT_FNOS_RANCH[key] as number);
    return {
        rotation: bool('rotation'),
        rotationIdleMinutes: int('rotationIdleMinutes', 1, 60),
        rotationMinGapSeconds: int('rotationMinGapSeconds', 30, 600),
        altHold: bool('altHold'),
        altHoldFallbackMinutes: int('altHoldFallbackMinutes', 5, 720),
        illustratedAutoClaim: bool('illustratedAutoClaim'),
        illustratedAutoComplete: bool('illustratedAutoComplete'),
        friendSteal: bool('friendSteal'),
        friendClean: bool('friendClean'),
        friendMosquito: bool('friendMosquito'),
        friendFeed: bool('friendFeed'),
        friendFeedPerTime: int('friendFeedPerTime', 1, 500),
        friendFeedGoldKeep: int('friendFeedGoldKeep', 0, 999999999),
        friendHelpProduce: bool('friendHelpProduce'),
        friendPutMosquito: bool('friendPutMosquito'),
        friendPutPerFriend: int('friendPutPerFriend', 1, 9),
        friendIntervalMinutes: int('friendIntervalMinutes', 5, 180),
        friendMaxPerPatrol: int('friendMaxPerPatrol', 1, 20),
        friendDailyVisitLimit: int('friendDailyVisitLimit', 10, 500),
    };
}

// ============ 运行时状态（内存） ============
const rt = {
    lastRanchVisitAt: 0,
    pendingAfterFarmWork: false,
    farmIdleSince: 0,
    ownNextMatureAtMs: 0,
    shelfFirstSeen: new Map<string, number>(),
    lastHoldLog: '',
    nextBookAt: 0,
    uncollectedProducts: null as Set<number> | null,
    nextFriendPatrolAt: 0,
    friendCooldown: new Map<number, number>(),
    friendCursor: 0,
    dayKey: '',
    dayVisits: 0,
    lastLog: {} as Record<string, string>,
    opTimes: null as Map<number, { limit: number; used: number; remaining: number }> | null,
    exhausted: {} as { clean?: string; feed?: string; help?: string; put?: string },
};

function resetFnosRanchRuntime(): void {
    rt.lastRanchVisitAt = 0;
    rt.pendingAfterFarmWork = false;
    rt.farmIdleSince = 0;
    rt.ownNextMatureAtMs = 0;
    rt.shelfFirstSeen.clear();
    rt.lastHoldLog = '';
    rt.nextBookAt = 0;
    rt.uncollectedProducts = null;
    rt.nextFriendPatrolAt = 0;
    rt.friendCooldown.clear();
    rt.friendCursor = 0;
    rt.dayKey = '';
    rt.dayVisits = 0;
    rt.lastLog = {};
    rt.opTimes = null;
    rt.exhausted = {};
}

function readConfigs(): { ranch: FnosRanchConfig; alt: any } {
    const cfg = require('../fnos-fork-config').readFnosForkConfigs();
    return { ranch: cfg.ranch || normalizeFnosRanch(undefined), alt: cfg.alt };
}

function num(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value.toNumber === 'function') return value.toNumber();
    return Number(value) || 0;
}

function log(message: string, meta: Record<string, any> = {}, warn = false): void {
    try {
        const u = require('../../utils/utils');
        (warn ? u.logWarn : u.log)('牧场', message, { module: 'ranch', event: 'fnos牧场', ...meta });
    } catch { /* ignore */ }
}

function logOnce(channel: string, message: string, meta: Record<string, any> = {}): void {
    if (rt.lastLog[channel] === message) return;
    rt.lastLog[channel] = message;
    log(message, meta);
}

function selfGid(): number {
    try { return num(require('../../utils/network').getUserState().gid); } catch { return 0; }
}

// ============ 1. 小号等大号 ============
/** 只有「小号模式 + 已选大号 + holdForMaster + 牧场 altHold」都开时返回等待参数。 */
function altHoldSettings(cfg = readConfigs()): { masterGid: number; masterName: string; timeoutMs: number } | null {
    const { ranch, alt } = cfg;
    if (!ranch.altHold || !alt || !alt.enabled || !(num(alt.masterGid) > 0) || alt.holdForMaster === false) return null;
    if (num(alt.masterGid) === selfGid()) return null;
    const minutes = num(alt.timeoutMinutes) > 0 ? num(alt.timeoutMinutes) : ranch.altHoldFallbackMinutes;
    return { masterGid: num(alt.masterGid), masterName: String(alt.masterName || ''), timeoutMs: minutes * 60_000 };
}

export interface ShelfHoldDecision {
    key: string;
    release: boolean;
    reason: 'master_stole' | 'unstealable' | 'timeout' | 'waiting';
    waitMs: number;
}

/** 纯函数：对一个可收货架做「等大号」判断。 */
function decideShelfHold(shelf: any, masterGid: number, firstSeenMs: number, nowMs: number, timeoutMs: number): Omit<ShelfHoldDecision, 'key'> {
    const lots = Array.isArray(shelf?.lots) ? shelf.lots : [];
    const stolenByMaster = lots.some((lot: any) => (lot.stealers || []).some((id: any) => num(id) === masterGid));
    if (stolenByMaster) return { release: true, reason: 'master_stole', waitMs: 0 };
    // 主人视角下 can_steal 的含义未经抓包确认，不用它判断；只看是否还有剩余可被偷的产物
    const anyLeft = lots.some((lot: any) => num(lot.remain_num) > 0);
    if (!anyLeft) return { release: true, reason: 'unstealable', waitMs: 0 };
    const waited = nowMs - firstSeenMs;
    if (waited >= timeoutMs) return { release: true, reason: 'timeout', waitMs: 0 };
    return { release: false, reason: 'waiting', waitMs: timeoutMs - waited };
}

/**
 * 根据当前牧场原始数据（state.loadRaw 的 raw.cells.facilities[].ranch.shelves）给出收获方式：
 * - mode 'all'：照上游一键收（op=1）；
 * - mode 'animals'：有货架还在等大号，只收成熟动物（op=4）；
 * wakeAtMs：最近一个货架超时放行的时间（供调度提前唤醒）。
 */
function planOwnHarvest(raw: any, nowMs: number = Date.now()): { mode: 'all' | 'animals'; held: number; wakeAtMs: number } {
    const hold = altHoldSettings();
    if (!hold) { rt.shelfFirstSeen.clear(); return { mode: 'all', held: 0, wakeAtMs: 0 }; }
    const quantity = (v: any) => String(v ?? '');
    const seen = new Set<string>();
    let held = 0;
    let wakeAtMs = 0;
    const reasons: Record<string, number> = {};
    for (const facility of raw?.cells?.facilities || []) {
        for (const shelf of facility?.ranch?.shelves || []) {
            if (!shelf.can_collect) continue;
            const key = `${quantity(facility.instance_id)}:${shelf.slot_index}`;
            seen.add(key);
            if (!rt.shelfFirstSeen.has(key)) rt.shelfFirstSeen.set(key, nowMs);
            const d = decideShelfHold(shelf, hold.masterGid, rt.shelfFirstSeen.get(key)!, nowMs, hold.timeoutMs);
            reasons[d.reason] = (reasons[d.reason] || 0) + 1;
            if (!d.release) {
                held++;
                const at = nowMs + d.waitMs;
                if (!wakeAtMs || at < wakeAtMs) wakeAtMs = at;
            }
        }
    }
    for (const key of [...rt.shelfFirstSeen.keys()]) if (!seen.has(key)) rt.shelfFirstSeen.delete(key);
    const master = hold.masterName ? `${hold.masterName}(${hold.masterGid})` : `GID ${hold.masterGid}`;
    const msg = held > 0
        ? `小号：${held} 个货架的产物先留给大号 ${master} 偷，最长等 ${Math.round(hold.timeoutMs / 60000)} 分钟；期间只收成熟动物`
        : (seen.size ? `小号：货架可收（大号已偷 ${reasons.master_stole || 0}、已无剩余 ${reasons.unstealable || 0}、超时 ${reasons.timeout || 0}），照常收取` : '');
    if (msg && msg !== rt.lastHoldLog) { rt.lastHoldLog = msg; log(msg, { event: 'fnos牧场等大号' }); }
    return { mode: held > 0 ? 'animals' : 'all', held, wakeAtMs };
}

// ============ 2. 牧场图鉴 ============
async function operateQuoted(action: string, input: any): Promise<any | null> {
    const { prepareAction, operate } = require('./actions');
    const quote = await prepareAction(action, input);
    if (quote.skipped || !quote.count) return null;
    const result = await operate(action, { ...input, expected: quote.expected });
    if (result.status === 'skipped') return null;
    return { quote, result };
}

async function runBook(nowMs: number = Date.now()): Promise<boolean> {
    const { ranch } = readConfigs();
    if (!ranch.illustratedAutoClaim && !ranch.illustratedAutoComplete) { rt.uncollectedProducts = null; return false; }
    if (nowMs < rt.nextBookAt) return false;
    rt.nextBookAt = nowMs + BOOK_INTERVAL_MS;
    let changed = false;
    try {
        const book = await require('./book').getBook();
        rt.uncollectedProducts = new Set((book.animals || []).filter((a: any) => !a.unlocked).map((a: any) => Number(a.id)));
        if (ranch.illustratedAutoClaim) {
            for (const kind of ['normal', 'giant']) {
                const can = kind === 'normal' ? !!book.normal?.canClaim : (book.giant?.levels || []).some((l: any) => l.canClaim);
                if (!can) continue;
                try {
                    const done = await operateQuoted('claimIllustrated', { kind });
                    if (done) {
                        changed = true;
                        log(`${done.quote.label || '领取牧场图鉴奖励'}（${kind === 'normal' ? '普通图鉴' : '巨大图鉴'}）${done.result.notice ? `：${done.result.notice}` : '完成'}`, { event: 'fnos牧场图鉴', result: 'ok' });
                    }
                } catch (e: any) {
                    log(`牧场图鉴奖励领取失败（${kind}）：${e.message}`, { event: 'fnos牧场图鉴', result: 'error' }, true);
                }
            }
        }
        if (ranch.illustratedAutoComplete) {
            logOnce('book-complete', rt.uncollectedProducts.size
                ? `牧场图鉴还差 ${rt.uncollectedProducts.size} 种产物，自动买幼崽时优先买这些动物`
                : '牧场图鉴产物已全部收集', { event: 'fnos牧场图鉴' });
        }
    } catch (e: any) {
        rt.nextBookAt = nowMs + 10 * 60 * 1000;
        logOnce('book-error', `读取牧场图鉴失败：${e.message}，10 分钟后再试`, { event: 'fnos牧场图鉴', result: 'error' });
    }
    return changed;
}

/** 自动完成图鉴：在上游选出的候选里，优先挑产物还没进图鉴的动物；没有就返回 null 交还上游策略。 */
function pickAnimalForBook(candidates: any[]): any | null {
    let enabled = false;
    try { enabled = readConfigs().ranch.illustratedAutoComplete; } catch { enabled = false; }
    const missing = rt.uncollectedProducts;
    if (!enabled || !missing || !missing.size) return null;
    const wanted = candidates.filter(good => missing.has(Number(good?.animal?.product_item?.id)));
    if (!wanted.length) return null;
    // 先买便宜（价格低）的，同价按动物 id 小的
    return [...wanted].sort((a, b) => num(a.price?.count) - num(b.price?.count) || num(a.animal?.id) - num(b.animal?.id))[0];
}

// ============ 3. 轮换值守 ============
function nextOwnMatureSec(lands: any[], nowSec: number): number {
    let best = 0;
    for (const land of lands || []) {
        const plant = land && land.plant;
        if (!plant || !Array.isArray(plant.phases)) continue;
        let matureBegin = 0;
        for (const phase of plant.phases) {
            const raw = num(phase && phase.begin_time);
            const begin = raw > 1e12 ? Math.floor(raw / 1000) : raw;
            if (begin > matureBegin) matureBegin = begin;
        }
        if (matureBegin > nowSec && (best === 0 || matureBegin < best)) best = matureBegin;
    }
    return best;
}

/** farm/scheduler 每轮巡田后调用。 */
function recordFarmRound(input: { lands?: any[]; hadWork: boolean }, nowMs: number = Date.now()): void {
    try {
        const u = require('../../utils/utils');
        const nowSec = u.getServerTimeSec();
        const sec = nextOwnMatureSec(input.lands || [], nowSec);
        rt.ownNextMatureAtMs = sec > 0 ? nowMs + (sec - nowSec) * 1000 : 0;
    } catch { /* ignore */ }
    if (input.hadWork) { rt.pendingAfterFarmWork = true; rt.farmIdleSince = 0; }
    else if (!rt.farmIdleSince) rt.farmIdleSince = nowMs;
}

/** 好友农场巡查一轮结束后调用（visited=有访问）。 */
function recordFriendRound(visited: boolean): void {
    if (visited) rt.pendingAfterFarmWork = true;
}

function rotationEnabled(): boolean {
    try { return readConfigs().ranch.rotation; } catch { return false; }
}

/**
 * 轮换模式下牧场是否该去了。upstreamDueAt 为上游算出的 nextCheckAt（动物/建筑到点唤醒、或 ranch_check_minutes）。
 * 返回 { due, reason, nextAt }。
 */
function rotationDue(upstreamDueAt: number, nowMs: number = Date.now(), cfg: FnosRanchConfig = readConfigs().ranch): { due: boolean; reason: string; nextAt: number } {
    const gapAt = rt.lastRanchVisitAt + cfg.rotationMinGapSeconds * 1000;
    if (nowMs < gapAt) return { due: false, reason: 'min_gap', nextAt: gapAt };
    if (rt.ownNextMatureAtMs > 0 && rt.ownNextMatureAtMs - nowMs <= OWN_MATURE_GUARD_MS && rt.ownNextMatureAtMs + 30_000 > nowMs) {
        return { due: false, reason: 'own_mature_soon', nextAt: rt.ownNextMatureAtMs + 30_000 };
    }
    if (rt.pendingAfterFarmWork) return { due: true, reason: 'after_farm_work', nextAt: nowMs };
    const idleAt = rt.lastRanchVisitAt + cfg.rotationIdleMinutes * 60_000;
    if (nowMs >= idleAt) return { due: true, reason: 'idle_interval', nextAt: nowMs };
    if (upstreamDueAt > 0 && nowMs >= upstreamDueAt) return { due: true, reason: 'upstream_wake', nextAt: nowMs };
    return { due: false, reason: 'waiting', nextAt: Math.min(idleAt, upstreamDueAt > 0 ? upstreamDueAt : idleAt) };
}

function markRanchVisited(nowMs: number = Date.now()): void {
    rt.lastRanchVisitAt = nowMs;
    rt.pendingAfterFarmWork = false;
}

/** 牧场一圈里还有 fork 要做的事（让上游 getRoutineState 不要判为「今日无事」）。 */
function hasForkWork(): boolean {
    try {
        const { ranch, alt } = readConfigs();
        const badOnlyMaster = !!(alt && alt.enabled && alt.badOnlyMaster && num(alt.masterGid) > 0);
        return badOnlyMaster || ranch.friendSteal || ranch.friendClean || ranch.friendMosquito || ranch.friendFeed || ranch.friendHelpProduce || ranch.friendPutMosquito || ranch.illustratedAutoClaim || ranch.illustratedAutoComplete;
    } catch { return false; }
}

/** 轮换期间自己的菜快熟了，要尽快回农场。 */
function shouldYieldToFarm(nowMs: number = Date.now()): boolean {
    return rt.ownNextMatureAtMs > 0 && rt.ownNextMatureAtMs - nowMs <= OWN_MATURE_GUARD_MS && rt.ownNextMatureAtMs + 30_000 > nowMs;
}

// ============ 4. 好友牧场巡查 ============
function readMyAltGids(myGid: number): number[] {
    try {
        const ratio = require('../friend/fnos-steal-ratio');
        const snaps = typeof ratio.loadAltRelationSnapshots === 'function' ? ratio.loadAltRelationSnapshots() : [];
        return snaps.filter((s: any) => s && s.enabled && num(s.masterGid) === myGid && num(s.selfGid) > 0).map((s: any) => num(s.selfGid));
    } catch { return []; }
}

export interface FriendTarget { gid: number; name: string; steal: boolean; clean: boolean; feed: boolean; help: boolean; put: boolean; priority: boolean }

/** 纯函数：选出本轮要走的好友。 */
function pickFriendTargets(input: {
    friends: Array<{ gid: number; name?: string }>;
    myGid: number;
    blacklist: number[];
    alt: any;
    myAltGids: number[];
    /** 与我有大小号关系的 GID（我的大号、我的小号、同一大号下的其它小号），不给他们放蚊子 */
    relatedGids?: number[];
    cfg: FnosRanchConfig;
    cooldown: Map<number, number>;
    cursor: number;
    nowMs: number;
    limit: number;
    cleanAllowed?: boolean;
    feedAllowed?: boolean;
    helpAllowed?: boolean;
    putAllowed?: boolean;
}): { targets: FriendTarget[]; cursor: number } {
    const { cfg, alt } = input;
    const black = new Set(input.blacklist.map(Number));
    const altSet = new Set(input.myAltGids);
    const masterGid = alt && alt.enabled ? num(alt.masterGid) : 0;
    const related = new Set<number>([...(input.relatedGids || []), ...input.myAltGids, ...(masterGid ? [masterGid] : [])]);
    const skipStealMaster = !!(alt && alt.enabled && alt.skipStealMaster);
    // 类比农场「只给大号放捣乱（帮大号时不除草除虫）」：小号开了 badOnlyMaster 时不帮大号清害，留给大号自己清
    const skipCleanMaster = !!(alt && alt.enabled && alt.badOnlyMaster);
    const cleanOn = (cfg.friendClean || cfg.friendMosquito) && input.cleanAllowed !== false;
    const feedOn = cfg.friendFeed && input.feedAllowed !== false;
    const helpOn = cfg.friendHelpProduce && input.helpAllowed !== false;
    const putOn = cfg.friendPutMosquito && input.putAllowed !== false;
    // 与农场「只给大号放捣乱」（fnos-alt-coop badOnlyMaster）一致：小号开了它 → 只给大号放（即使「放蚊子」开关关着），其他好友一律不放
    const badOnlyMaster = !!(alt && alt.enabled && alt.badOnlyMaster && masterGid > 0);
    const putMasterOn = badOnlyMaster && input.putAllowed !== false;
    const pool = input.friends
        .map(f => ({ gid: num(f.gid), name: String(f.name || '') }))
        .filter(f => f.gid > 0 && f.gid !== input.myGid && !black.has(f.gid));
    const build = (f: { gid: number; name: string }): FriendTarget | null => {
        if ((input.cooldown.get(f.gid) || 0) > input.nowMs) return null;
        const isMaster = masterGid > 0 && f.gid === masterGid;
        const steal = cfg.friendSteal && !(skipStealMaster && isMaster);
        const clean = cleanOn && !(skipCleanMaster && isMaster);
        const feed = feedOn;
        const help = helpOn;
        // 放蚊子属捣乱：小号 badOnlyMaster 时只给大号放；否则不给自己的大号 / 小号 / 同大号的其它小号放
        const put = badOnlyMaster ? (isMaster && putMasterOn) : (putOn && !related.has(f.gid));
        if (!steal && !clean && !feed && !help && !put) return null;
        return { gid: f.gid, name: f.name, steal, clean, feed, help, put, priority: altSet.has(f.gid) || (put && isMaster) };
    };
    const targets: FriendTarget[] = [];
    // 优先：大号的自己的小号；小号 badOnlyMaster 时的大号（与农场一样把大号加入本轮访问）
    const first = (gid: number) => altSet.has(gid) || (putMasterOn && gid === masterGid);
    for (const f of pool.filter(p => first(p.gid))) {
        if (targets.length >= input.limit) break;
        const t = build(f);
        if (t) targets.push(t);
    }
    const rest = pool.filter(p => !first(p.gid));
    let cursor = rest.length ? input.cursor % rest.length : 0;
    for (let i = 0; i < rest.length && targets.length < input.limit; i++) {
        const idx = (cursor + i) % rest.length;
        const t = build(rest[idx]);
        if (t) targets.push(t);
        if (i === rest.length - 1 || targets.length >= input.limit) cursor = (idx + 1) % rest.length;
    }
    return { targets, cursor };
}

/** 与本账号有大小号关系的 GID：我的大号、我的小号、同一大号下的其它小号（本实例内已登记的账号）。 */
function readRelatedGids(myGid: number, alt: any): number[] {
    const out = new Set<number>();
    const masterGid = alt && alt.enabled ? num(alt.masterGid) : 0;
    if (masterGid) out.add(masterGid);
    try {
        const ratio = require('../friend/fnos-steal-ratio');
        const snaps = typeof ratio.loadAltRelationSnapshots === 'function' ? ratio.loadAltRelationSnapshots() : [];
        for (const s of snaps) {
            if (!s || !s.enabled) continue;
            const self = num(s.selfGid);
            const master = num(s.masterGid);
            if (master === myGid && self > 0) out.add(self);
            if (masterGid && master === masterGid && self > 0) out.add(self);
            if (self === myGid && master > 0) out.add(master);
        }
    } catch { /* ignore */ }
    out.delete(myGid);
    return [...out];
}

// ============ 好友牧场照顾（1116-6 / 1116-7 完整抓包，2026-11-16） ============
/** GetRanchOpTimes 里放蚊子（PutHazard）的每日额度 op：1116-6 PutHazard 请求带 op_id=11003，每放一次 used_times+1，上限 100。 */
const OP_PUT_HAZARD = 11003;
/** PutHazard 报「这里的蚊子已经够多啦」的错误码（1116-6 #212，同一窝棚第 4 只时） */
const ERR_HAZARD_FULL = 1045230;
/** 1116-6 里同一窝棚放到 3 只就报 ERR_HAZARD_FULL；已有这么多蚊子的窝棚不再放 */
const HAZARD_PER_RANCH_MAX = 3;
/** 帮好友生产后等产物上架再偷，最多等多久 */
const HELP_STEAL_WAIT_MAX_MS = 10_000;

/** 害的种类（1116-6/1116-7 确认）：1 = 蚊子（PutHazard 放出来的就是 1，owner = 放的人）；2 = 便便（无 owner，清理奖励 7002 便便）。 */
function hazardKind(type: number): 'mosquito' | 'poop' | 'other' {
    const t = num(type);
    return t === 1 ? 'mosquito' : t === 2 ? 'poop' : 'other';
}

/** 纯函数：好友牧场里需要清理的害（按开关过滤；未知种类任一开关开着就算）。 */
function hazardsToClean(ranches: any[], cfg: Pick<FnosRanchConfig, 'friendClean' | 'friendMosquito'>): { total: number; wanted: number; kinds: Record<string, number> } {
    const kinds: Record<string, number> = {};
    let total = 0;
    let wanted = 0;
    for (const r of ranches || []) {
        for (const h of r?.hazards || []) {
            total++;
            const kind = hazardKind(h?.hazard_type);
            kinds[kind] = (kinds[kind] || 0) + 1;
            if ((kind === 'mosquito' && cfg.friendMosquito) || (kind === 'poop' && cfg.friendClean) || (kind === 'other' && (cfg.friendClean || cfg.friendMosquito))) wanted++;
        }
    }
    return { total, wanted, kinds };
}

/** 纯函数：好友牧场里可以「帮忙生产」的动物数（GetRanchDetail 里 can_deliver=true，与上游自己牧场「触发生产」同一字段）。 */
function helpableAnimals(ranches: any[]): number {
    return (ranches || []).reduce((sum: number, r: any) => sum + (r?.animals || []).filter((a: any) => a && a.can_deliver).length, 0);
}

/** 纯函数：每个窝棚还能放几只蚊子（上限 HAZARD_PER_RANCH_MAX，按已有蚊子数扣），返回 [{ranchId, count}]。 */
function planPutMosquito(ranches: any[], perFriend: number): Array<{ ranchId: string; count: number }> {
    const out: Array<{ ranchId: string; count: number }> = [];
    let left = Math.max(0, num(perFriend));
    for (const r of ranches || []) {
        if (left <= 0) break;
        if (!r || !num(r.ranch_inst_id) || !num(r.animal_count) && !(r.animals || []).length) continue;
        const have = (r.hazards || []).filter((h: any) => hazardKind(h?.hazard_type) === 'mosquito').length;
        const room = Math.max(0, HAZARD_PER_RANCH_MAX - have);
        const count = Math.min(room, left);
        if (count > 0) { out.push({ ranchId: String(r.ranch_inst_id), count }); left -= count; }
    }
    return out;
}

/** 给好友加牧草每份扣的金币（1116-7：加 2 份 −120、加 3 份 −180） */
const FEED_GOLD_PER_UNIT = 60;

/** 纯函数：给好友加多少牧草（金币扣到 friendFeedGoldKeep 为止）。 */
function planFriendFeed(machine: { capacity: number; feedCount: number } | null, gold: number, cfg: Pick<FnosRanchConfig, 'friendFeedPerTime' | 'friendFeedGoldKeep'>): number {
    if (!machine) return 0;
    const room = Math.max(0, num(machine.capacity) - num(machine.feedCount));
    const affordable = Math.max(0, Math.floor((num(gold) - cfg.friendFeedGoldKeep) / FEED_GOLD_PER_UNIT));
    return Math.max(0, Math.min(room, affordable, cfg.friendFeedPerTime));
}

function friendFeedMachine(entry: any): { id: string; capacity: number; feedCount: number } | null {
    for (const f of entry?.homestead_cells?.facilities || []) {
        if (f && f.feed_machine && num(f.state) === 1) {
            return { id: String(f.instance_id), capacity: num(f.capacity), feedCount: num(f.feed_machine.feed_count) };
        }
    }
    return null;
}

/**
 * 每日次数：animalpb.RanchService.GetRanchOpTimes {op_ids: []} → ops[{op_id, times_limit, used_times, remaining_times}]。
 * 1116-6/1116-7 回包固定 3 个 op：11003（100/日）、11008（20/日）、11009（10/日）。
 * 只有 PutHazard 消耗 11003；清理、帮忙生产、偷、给好友加牧草前后三个 op 都没变（没有这个表里的次数）。
 * 所以只对放蚊子按 11003 判断；其它动作请求报错（次数/上限类）时当天停止该动作。
 */
async function readOpTimes(): Promise<Map<number, { limit: number; used: number; remaining: number }> | null> {
    try {
        const { rpc } = require('./transport');
        const reply = await rpc('opTimes', { op_ids: [] });
        const map = new Map<number, { limit: number; used: number; remaining: number }>();
        for (const op of reply.ops || []) map.set(num(op.op_id), { limit: num(op.times_limit), used: num(op.used_times), remaining: num(op.remaining_times) });
        rt.opTimes = map;
        return map;
    } catch (e: any) {
        logOnce('op-times', `好友牧场：读取每日次数失败（${e.message}），按请求结果判断是否用完`);
        return null;
    }
}

type CareAction = 'clean' | 'feed' | 'help' | 'put';
const CARE_LABEL: Record<CareAction, string> = { clean: '清理', feed: '加牧草', help: '帮忙生产', put: '放蚊子' };

function actionExhausted(action: CareAction): boolean {
    if (rt.exhausted[action] === rt.dayKey) return true;
    if (action === 'put' && rt.opTimes) {
        const v = rt.opTimes.get(OP_PUT_HAZARD);
        if (v && v.limit > 0 && v.remaining <= 0) { rt.exhausted.put = rt.dayKey; return true; }
    }
    return false;
}

function errCode(e: any): number {
    if (typeof e?.code === 'number') return e.code;
    return num((/code=(\d+)/.exec(String(e?.message || '')) || [])[1]);
}

function markExhaustedIfLimit(action: CareAction, e: any): void {
    const msg = String(e && e.message || '');
    if (/次数|上限|已达|用完|limit/i.test(msg) || e?.code === 'RANCH_RESULT_UNKNOWN') {
        rt.exhausted[action] = rt.dayKey;
        log(`好友牧场：${CARE_LABEL[action]}今日停止（${msg}）`, { event: 'fnos好友牧场', result: 'limit' });
    }
}

/**
 * 清理好友牧场的害：CleanAllRanch {host_gid}（1116-6/1116-7 共 5 次给好友清理都是只带 host_gid；给自己清理是空请求 {}）。
 * 回包 ranches（清理后的窝棚）+ op_results[{facility_inst_id, kind:3, target_id: hazard_id, rewards}]，
 * 每只蚊子 / 每坨便便奖励 1102 牧场经验 ×5，便便另得 7002 便便 ×1。
 */
async function cleanFriendRanch(host: string, ranches: any[], cfg: FnosRanchConfig): Promise<{ cleaned: number; rewards: any[]; kinds: Record<string, number> } | null> {
    const plan = hazardsToClean(ranches, cfg);
    if (!plan.wanted || actionExhausted('clean')) return null;
    const { rpc } = require('./transport');
    const { sumItems } = require('./model');
    try {
        const reply: any = await rpc('clean', { host_gid: host }, true);
        const rows = (reply?.op_results || []).filter((row: any) => num(row.kind) === 3);
        const left = (reply?.ranches || []).reduce((s: number, r: any) => s + (r?.hazards || []).length, 0);
        const cleaned = rows.length || Math.max(0, plan.total - left);
        if (!cleaned) { rt.exhausted.clean = rt.dayKey; log('好友牧场：清理请求没有清掉任何害，今日不再清理', { event: 'fnos好友牧场', result: 'limit' }); }
        return { cleaned, rewards: sumItems(rows.flatMap((row: any) => row.rewards || [])), kinds: plan.kinds };
    } catch (e: any) {
        markExhaustedIfLimit('clean', e);
        throw e;
    }
}

/**
 * 帮好友生产：AnimalService.TriggerProduce {host_gid}（1116-6 #161，不带 targets = 全部 can_deliver 动物）。
 * 回包 ranches（动物带 delivering_until_ms / mature_ready_at_ms）+ op_results[{kind:1, target_id: animal_inst_id, rewards: 1102×5}]。
 */
async function helpFriendProduce(host: string, ranches: any[]): Promise<{ helped: number; rewards: any[]; ranches: any[]; readyAtMs: number } | null> {
    if (!helpableAnimals(ranches) || actionExhausted('help')) return null;
    const { rpc } = require('./transport');
    const { sumItems } = require('./model');
    try {
        const reply: any = await rpc('produce', { host_gid: host }, true);
        const rows = (reply?.op_results || []).filter((row: any) => num(row.kind) === 1);
        if (!rows.length) { rt.exhausted.help = rt.dayKey; log('好友牧场：帮忙生产没有生效，今日不再帮忙生产', { event: 'fnos好友牧场', result: 'limit' }); }
        const readyAtMs = (reply?.ranches || []).flatMap((r: any) => r?.animals || []).reduce((m: number, a: any) => Math.max(m, num(a?.delivering_until_ms)), 0);
        return { helped: rows.length, rewards: sumItems(rows.flatMap((row: any) => row.rewards || [])), ranches: reply?.ranches || [], readyAtMs };
    } catch (e: any) {
        markExhaustedIfLimit('help', e);
        throw e;
    }
}

/**
 * 给好友放蚊子：RanchService.PutHazard {ranch_inst_id, host_gid, op_id: 11003, count: 1}（1116-6 #182/#191/#200/#211）。
 * 回包 {actual_count, remaining_times（11003 剩余）, hazards（该窝棚现有害）, rewards: 1102×5}；
 * 同一窝棚第 4 只报 1045230「这里的蚊子已经够多啦，换一处试试吧」。
 */
async function putFriendMosquito(host: string, ranches: any[], cfg: FnosRanchConfig): Promise<{ put: number; rewards: any[] }> {
    const plan = planPutMosquito(ranches, cfg.friendPutPerFriend);
    let put = 0;
    const rewards: any[] = [];
    if (!plan.length) return { put, rewards };
    const { rpc } = require('./transport');
    for (const step of plan) {
        for (let i = 0; i < step.count; i++) {
            if (actionExhausted('put')) return { put, rewards };
            let reply: any;
            try {
                reply = await rpc('putHazard', { ranch_inst_id: step.ranchId, host_gid: host, op_id: OP_PUT_HAZARD, count: 1 }, true);
            } catch (e: any) {
                if (errCode(e) === ERR_HAZARD_FULL || /够多/.test(String(e?.message || ''))) break;
                markExhaustedIfLimit('put', e);
                if (put) return { put, rewards };
                throw e;
            }
            const n = num(reply?.actual_count);
            put += n;
            rewards.push(...(reply?.rewards || []));
            const v = rt.opTimes?.get(OP_PUT_HAZARD);
            const remaining = reply?.remaining_times;
            if (v && remaining !== undefined && remaining !== null) { v.remaining = num(remaining); v.used = Math.max(0, v.limit - v.remaining); }
            if (remaining !== undefined && remaining !== null && num(remaining) <= 0) { rt.exhausted.put = rt.dayKey; return { put, rewards }; }
            if (!n) break;
        }
    }
    return { put, rewards };
}

/**
 * 给好友加牧草：homesteadpb.FeedMachineService.AddFeed {instance_id, add_count, use_gold:true, host_gid}。
 * 与 1116-7 #172 真实客户端完全一致（加 3 份，ItemNotify 金币 1007 −180）。
 */
async function feedFriend(host: string, entry: any, cfg: FnosRanchConfig, wallet: { gold: number }): Promise<number> {
    if (actionExhausted('feed')) return 0;
    const machine = friendFeedMachine(entry);
    const count = planFriendFeed(machine, wallet.gold, cfg);
    if (!machine || count <= 0) return 0;
    const { rpc } = require('./transport');
    try {
        const reply: any = await rpc('addGrass', { instance_id: machine.id, add_count: count, use_gold: true, host_gid: host }, true);
        const after = num(reply?.detail?.feed_count);
        const added = after > machine.feedCount ? after - machine.feedCount : count;
        wallet.gold = Math.max(0, wallet.gold - added * FEED_GOLD_PER_UNIT);
        return added;
    } catch (e: any) {
        markExhaustedIfLimit('feed', e);
        throw e;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function visitFriend(target: FriendTarget, cfg: FnosRanchConfig = readConfigs().ranch, wallet: { gold: number } = { gold: 0 }): Promise<{ stolen: number; rewards: any[]; empty: boolean; cleaned: number; fed: number; helped: number; put: number }> {
    const friends = require('./friends');
    const { rpc } = require('./transport');
    const { sumItems } = require('./model');
    return friends.visit(target.gid, async (entry: any, ranches: any[], host: string) => {
        let stolen = 0;
        let rewards: any[] = [];
        let cleaned = 0;
        let fed = 0;
        let helped = 0;
        let put = 0;
        const doSteal = async (list: any[]) => {
            if (!target.steal || !friends.targets(list).length) return;
            const reply = await rpc('steal', { host_gid: host, targets: [] }, true);
            const rows = (reply.op_results || []).filter((row: any) => row.kind === 2 && !(row.costs || []).length);
            stolen += rows.length;
            rewards = sumItems([...rewards, ...rows.flatMap((row: any) => row.rewards || [])]);
        };
        await doSteal(ranches);
        if (target.help) {
            const h = await helpFriendProduce(host, ranches);
            if (h && h.helped) {
                helped = h.helped;
                rewards = sumItems([...rewards, ...h.rewards]);
                // 1116-6：帮忙生产后约 4 秒客户端就一键偷到了刚产出的产物；等到 delivering_until 再重新查一次
                if (target.steal) {
                    const nowMs = Number(require('../../utils/utils').getServerTimeSec()) * 1000;
                    const wait = h.readyAtMs > nowMs ? Math.min(HELP_STEAL_WAIT_MAX_MS, h.readyAtMs - nowMs + 500) : 0;
                    if (wait > 0) await sleep(wait);
                    const detail = await rpc('animals', { host_gid: host });
                    ranches = detail.ranches || [];
                    await doSteal(ranches);
                }
            }
        }
        if (target.clean) {
            const c = await cleanFriendRanch(host, ranches, cfg);
            if (c) { cleaned = c.cleaned; rewards = sumItems([...rewards, ...c.rewards]); }
        }
        // 本次刚帮好友清过害就不再给他放蚊子
        if (target.put && !cleaned && !actionExhausted('put')) {
            const p = await putFriendMosquito(host, ranches, cfg);
            put = p.put;
            if (p.rewards.length) rewards = sumItems([...rewards, ...p.rewards]);
        }
        if (target.feed) fed = await feedFriend(host, entry, cfg, wallet);
        return { stolen, rewards, empty: !stolen && !cleaned && !fed && !helped && !put, cleaned, fed, helped, put };
    });
}

async function runFriendPatrol(nowMs: number = Date.now(), options: { gold?: number } = {}): Promise<number> {
    const { ranch, alt } = readConfigs();
    const badOnlyMaster = !!(alt && alt.enabled && alt.badOnlyMaster && num(alt.masterGid) > 0);
    if (!ranch.friendSteal && !ranch.friendClean && !ranch.friendMosquito && !ranch.friendFeed && !ranch.friendHelpProduce && !ranch.friendPutMosquito && !badOnlyMaster) return 0;
    if (nowMs < rt.nextFriendPatrolAt) return 0;
    rt.nextFriendPatrolAt = nowMs + ranch.friendIntervalMinutes * 60_000;
    try {
        const { inFriendQuietHours } = require('../friend/visit-strategy');
        if (inFriendQuietHours()) { logOnce('friend-quiet', '好友牧场巡查：好友静默时段内，跳过'); return 0; }
    } catch { /* ignore */ }
    const u = require('../../utils/utils');
    const today = u.getSystemDateKey();
    if (rt.dayKey !== today) { rt.dayKey = today; rt.dayVisits = 0; rt.opTimes = null; }
    const left = ranch.friendDailyVisitLimit - rt.dayVisits;
    if (left <= 0) { logOnce('friend-limit', `好友牧场巡查：今日已访问 ${rt.dayVisits} 次，达到上限 ${ranch.friendDailyVisitLimit}，明天继续`); return 0; }
    const myGid = selfGid();
    if (!myGid) return 0;
    if ((ranch.friendPutMosquito || badOnlyMaster) && rt.exhausted.put !== rt.dayKey) await readOpTimes();
    const wallet = { gold: Math.max(0, num(options.gold !== undefined ? options.gold : require('../../utils/network').getUserState().gold)) };
    const cleanAllowed = !actionExhausted('clean');
    const feedAllowed = !actionExhausted('feed') && wallet.gold - ranch.friendFeedGoldKeep >= FEED_GOLD_PER_UNIT;
    const helpAllowed = !actionExhausted('help');
    const putAllowed = !actionExhausted('put');
    if (!ranch.friendSteal && !(cleanAllowed && (ranch.friendClean || ranch.friendMosquito)) && !(feedAllowed && ranch.friendFeed)
        && !(helpAllowed && ranch.friendHelpProduce) && !(putAllowed && (ranch.friendPutMosquito || badOnlyMaster))) {
        logOnce('friend-nothing', '好友牧场巡查：清理/帮忙生产/放蚊子/加牧草今日已停或金币低于保留值，偷取未开，本轮不访问');
        return 0;
    }
    let friends: any[] = [];
    try {
        const fv = require('../friend/visit-strategy');
        friends = fv.getFriendsListCacheOnly();
        if (!friends.length) friends = await fv.getFriendsList(false, 'low');
    } catch (e: any) {
        logOnce('friend-list', `好友牧场巡查：读取好友列表失败（${e.message}）`);
        return 0;
    }
    let blacklist: number[] = [];
    try { blacklist = require('../../models/store').getFriendBlacklist(process.env.FARM_ACCOUNT_ID) || []; } catch { blacklist = []; }
    const picked = pickFriendTargets({
        friends, myGid, blacklist, alt, myAltGids: readMyAltGids(myGid), cfg: ranch,
        relatedGids: readRelatedGids(myGid, alt),
        cooldown: rt.friendCooldown, cursor: rt.friendCursor, nowMs, limit: Math.min(ranch.friendMaxPerPatrol, left),
        cleanAllowed, feedAllowed, helpAllowed, putAllowed,
    });
    rt.friendCursor = picked.cursor;
    let totalStolen = 0;
    const got: string[] = [];
    for (const target of picked.targets) {
        if (shouldYieldToFarm()) { log('好友牧场巡查：自己农场作物马上成熟，先回农场'); break; }
        rt.dayVisits++;
        const t = { ...target, clean: target.clean && !actionExhausted('clean'), feed: target.feed && !actionExhausted('feed') && wallet.gold - ranch.friendFeedGoldKeep >= FEED_GOLD_PER_UNIT, help: target.help && !actionExhausted('help'), put: target.put && !actionExhausted('put') };
        try {
            const r = await visitFriend(t, ranch, wallet);
            totalStolen += r.stolen;
            const parts: string[] = [];
            if (r.rewards.length) parts.push(r.rewards.map((it: any) => `${it.name} ×${it.count}`).join('、'));
            else if (r.stolen) parts.push(`偷 ${r.stolen} 个货架`);
            if (r.helped) parts.push(`帮忙生产 ${r.helped} 只`);
            if (r.cleaned) parts.push(`清理 ${r.cleaned} 处`);
            if (r.put) parts.push(`放蚊子 ${r.put} 只`);
            if (r.fed) parts.push(`加牧草 ${r.fed}`);
            if (parts.length) got.push(`${target.name || target.gid}：${parts.join('，')}`);
            rt.friendCooldown.set(target.gid, Date.now() + (parts.length ? FRIEND_COOLDOWN_STOLE_MS : FRIEND_COOLDOWN_EMPTY_MS));
        } catch (e: any) {
            rt.friendCooldown.set(target.gid, Date.now() + FRIEND_COOLDOWN_ERROR_MS);
            log(`好友牧场巡查：${target.name || target.gid} 失败（${e.message}），6 小时内不再访问`, { result: 'error' }, true);
            if (e && (e.code === 'RANCH_RESULT_UNKNOWN' || /重新登录/.test(String(e.message)))) break;
        }
    }
    if (got.length) log(`好友牧场巡查：${got.join('；')}`, { event: 'fnos好友牧场', result: 'ok' });
    else if (picked.targets.length) logOnce('friend-empty', `好友牧场巡查：走了 ${picked.targets.length} 个好友，暂无可偷/可帮/可清理/可放/可加牧草`, { event: 'fnos好友牧场' });
    return totalStolen;
}

module.exports = {
    DEFAULT_FNOS_RANCH,
    normalizeFnosRanch,
    resetFnosRanchRuntime,
    decideShelfHold,
    planOwnHarvest,
    runBook,
    pickAnimalForBook,
    nextOwnMatureSec,
    recordFarmRound,
    recordFriendRound,
    rotationEnabled,
    rotationDue,
    markRanchVisited,
    hasForkWork,
    shouldYieldToFarm,
    pickFriendTargets,
    cleanFriendRanch,
    hazardKind,
    hazardsToClean,
    planFriendFeed,
    friendFeedMachine,
    helpableAnimals,
    planPutMosquito,
    readRelatedGids,
    OP_PUT_HAZARD,
    FEED_GOLD_PER_UNIT,
    runFriendPatrol,
    _visitFriend: visitFriend,
    _rt: rt,
};
