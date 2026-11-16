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
 *    好友牧场照顾（2026-11-16 按 1116-3 抓包）：
 *    - 清理：animalpb.RanchService.CleanAllRanch {host_gid, ranch_inst_ids: []}（空列表=该好友全部窝棚），一次清掉全部害；
 *      friendMosquito（hazard_type=1，推测蚊子）/ friendClean（其它类型，推测便便）各自开关，存在已开启种类的害才发请求；
 *      小号开了「只给大号放捣乱」时不帮大号清（类比农场帮大号不除草除虫）。
 *    - 加牧草：homesteadpb.FeedMachineService.AddFeed {instance_id: 好友牧草机, add_count, use_gold:false, host_gid}，消耗自己的牧草 7001；
 *      每次最多 friendFeedPerTime、自己保留 friendFeedKeep，且不超过好友牧草机剩余容量。
 *    - 每日次数：GetRanchOpTimes 自动识别 op 并遵守 remaining_times，请求报错或清理无效果时当天停止该动作。
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
    /** 好友牧场清便便（hazard_type≠1，推测） */
    friendClean: boolean;
    /** 好友牧场打蚊子（hazard_type=1，推测） */
    friendMosquito: boolean;
    /** 给好友加牧草，消耗自己的牧草 7001 */
    friendFeed: boolean;
    /** 每次给一个好友最多加多少牧草 */
    friendFeedPerTime: number;
    /** 自己至少保留多少牧草，低于此不给好友加 */
    friendFeedKeep: number;
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
    friendFeedKeep: 200,
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
        friendFeedKeep: int('friendFeedKeep', 0, 99999),
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
    opMap: {} as { clean?: number; feed?: number },
    exhausted: {} as { clean?: string; feed?: string },
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
    rt.opMap = {};
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
        void alt;
        return ranch.friendSteal || ranch.friendClean || ranch.friendMosquito || ranch.friendFeed || ranch.illustratedAutoClaim || ranch.illustratedAutoComplete;
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

export interface FriendTarget { gid: number; name: string; steal: boolean; clean: boolean; feed: boolean; priority: boolean }

/** 纯函数：选出本轮要走的好友。 */
function pickFriendTargets(input: {
    friends: Array<{ gid: number; name?: string }>;
    myGid: number;
    blacklist: number[];
    alt: any;
    myAltGids: number[];
    cfg: FnosRanchConfig;
    cooldown: Map<number, number>;
    cursor: number;
    nowMs: number;
    limit: number;
    cleanAllowed?: boolean;
    feedAllowed?: boolean;
}): { targets: FriendTarget[]; cursor: number } {
    const { cfg, alt } = input;
    const black = new Set(input.blacklist.map(Number));
    const altSet = new Set(input.myAltGids);
    const masterGid = alt && alt.enabled ? num(alt.masterGid) : 0;
    const skipStealMaster = !!(alt && alt.enabled && alt.skipStealMaster);
    // 类比农场「只给大号放捣乱（帮大号时不除草除虫）」：小号开了 badOnlyMaster 时不帮大号清害，留给大号自己清
    const skipCleanMaster = !!(alt && alt.enabled && alt.badOnlyMaster);
    const cleanOn = (cfg.friendClean || cfg.friendMosquito) && input.cleanAllowed !== false;
    const feedOn = cfg.friendFeed && input.feedAllowed !== false;
    const pool = input.friends
        .map(f => ({ gid: num(f.gid), name: String(f.name || '') }))
        .filter(f => f.gid > 0 && f.gid !== input.myGid && !black.has(f.gid));
    const build = (f: { gid: number; name: string }): FriendTarget | null => {
        if ((input.cooldown.get(f.gid) || 0) > input.nowMs) return null;
        const isMaster = masterGid > 0 && f.gid === masterGid;
        const steal = cfg.friendSteal && !(skipStealMaster && isMaster);
        const clean = cleanOn && !(skipCleanMaster && isMaster);
        const feed = feedOn;
        if (!steal && !clean && !feed) return null;
        return { gid: f.gid, name: f.name, steal, clean, feed, priority: altSet.has(f.gid) };
    };
    const targets: FriendTarget[] = [];
    for (const f of pool.filter(p => altSet.has(p.gid))) {
        if (targets.length >= input.limit) break;
        const t = build(f);
        if (t) targets.push(t);
    }
    const rest = pool.filter(p => !altSet.has(p.gid));
    let cursor = rest.length ? input.cursor % rest.length : 0;
    for (let i = 0; i < rest.length && targets.length < input.limit; i++) {
        const idx = (cursor + i) % rest.length;
        const t = build(rest[idx]);
        if (t) targets.push(t);
        if (i === rest.length - 1 || targets.length >= input.limit) cursor = (idx + 1) % rest.length;
    }
    return { targets, cursor };
}

// ============ 好友牧场照顾（1116-3 抓包） ============
/**
 * 害的种类：1116-3 里好友牧场只出现过 hazard_type=1，且 owner 是第三方玩家 GID（被人放的），推测为蚊子；
 * 便便是动物自己产生的，推测为其它类型。CleanAllRanch 一次清掉该好友牧场全部害、不分种类，
 * 所以开关语义是：存在「已开启种类」的害时才发清理请求（顺带清掉其它种类）。
 */
function hazardKind(type: number): 'mosquito' | 'poop' {
    return num(type) === 1 ? 'mosquito' : 'poop';
}

/** 纯函数：好友牧场里需要清理的害（按开关过滤）。 */
function hazardsToClean(ranches: any[], cfg: Pick<FnosRanchConfig, 'friendClean' | 'friendMosquito'>): { total: number; wanted: number; kinds: Record<string, number> } {
    const kinds: Record<string, number> = {};
    let total = 0;
    let wanted = 0;
    for (const r of ranches || []) {
        for (const h of r?.hazards || []) {
            total++;
            const kind = hazardKind(h?.hazard_type);
            kinds[kind] = (kinds[kind] || 0) + 1;
            if ((kind === 'mosquito' && cfg.friendMosquito) || (kind === 'poop' && cfg.friendClean)) wanted++;
        }
    }
    return { total, wanted, kinds };
}

/** 纯函数：给好友加多少牧草。 */
function planFriendFeed(machine: { capacity: number; feedCount: number } | null, ownGrass: number, cfg: Pick<FnosRanchConfig, 'friendFeedPerTime' | 'friendFeedKeep'>): number {
    if (!machine) return 0;
    const room = Math.max(0, num(machine.capacity) - num(machine.feedCount));
    const spare = Math.max(0, num(ownGrass) - cfg.friendFeedKeep);
    return Math.max(0, Math.min(room, spare, cfg.friendFeedPerTime));
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
 * 每日次数（animalpb.RanchService.GetRanchOpTimes {op_ids:[]}，抓包里请求为空列表=全部；回包 {op_id, times_limit, used_times, remaining_times}，
 * 1116-3 回包没抓到）。op_id 与「清理 / 加牧草」的对应关系未知，所以第一次做某个动作时前后各查一次，
 * used_times 增加的那个 op 就记为该动作的 op；之后每次巡查开头查一次，remaining_times<=0 就当天不再做。
 * 另外动作请求本身报错（次数用完等）时当天也停掉该动作。
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

/** 纯函数：两次快照对比，找出 used 增加的 op。 */
function diffOpTimes(before: Map<number, any> | null, after: Map<number, any> | null): number[] {
    if (!before || !after) return [];
    const out: number[] = [];
    for (const [id, v] of after) {
        const b = before.get(id);
        if (b && num(v.used) > num(b.used)) out.push(id);
    }
    return out;
}

function actionExhausted(action: 'clean' | 'feed'): boolean {
    if (rt.exhausted[action] === rt.dayKey) return true;
    const opId = rt.opMap[action];
    if (opId && rt.opTimes) {
        const v = rt.opTimes.get(opId);
        if (v && v.limit > 0 && v.remaining <= 0) { rt.exhausted[action] = rt.dayKey; return true; }
    }
    return false;
}

async function withOpLearning<T>(action: 'clean' | 'feed', run: () => Promise<T>): Promise<T> {
    const learn = !rt.opMap[action];
    const before = learn ? await readOpTimes() : null;
    const result = await run();
    if (learn && before) {
        const after = await readOpTimes();
        const changed = diffOpTimes(before, after);
        if (changed.length === 1) {
            rt.opMap[action] = changed[0];
            const v = after!.get(changed[0])!;
            log(`好友牧场：识别到「${action === 'clean' ? '清理' : '加牧草'}」的每日次数 op=${changed[0]}，今日 ${v.used}/${v.limit}，剩 ${v.remaining}`, { event: 'fnos好友牧场' });
        }
    } else if (rt.opMap[action] && rt.opTimes) {
        const v = rt.opTimes.get(rt.opMap[action]!);
        if (v) { v.used++; v.remaining = Math.max(0, v.remaining - 1); }
    }
    return result;
}

function markExhaustedIfLimit(action: 'clean' | 'feed', e: any): void {
    const msg = String(e && e.message || '');
    if (/次数|上限|已达|用完|limit/i.test(msg) || e?.code === 'RANCH_RESULT_UNKNOWN') {
        rt.exhausted[action] = rt.dayKey;
        log(`好友牧场：${action === 'clean' ? '清理' : '加牧草'}今日停止（${msg}）`, { event: 'fnos好友牧场', result: 'limit' });
    }
}

/** 清理好友牧场的害：CleanAllRanch {host_gid, ranch_inst_ids: []}（1116-3 #162/#191，两次都是空列表=全部）。 */
async function cleanFriendRanch(host: string, ranches: any[], cfg: FnosRanchConfig): Promise<{ cleaned: number; rewards: any[]; kinds: Record<string, number> } | null> {
    const plan = hazardsToClean(ranches, cfg);
    if (!plan.wanted || actionExhausted('clean')) return null;
    const { rpc } = require('./transport');
    const { sumItems } = require('./model');
    try {
        const reply: any = await withOpLearning('clean', () => rpc('clean', { host_gid: host, ranch_inst_ids: [] }, true));
        const rows = reply?.op_results || [];
        const left = (reply?.ranches || []).reduce((s: number, r: any) => s + (r?.hazards || []).length, 0);
        const cleaned = rows.length || Math.max(0, plan.total - left);
        if (!cleaned) { rt.exhausted.clean = rt.dayKey; log('好友牧场：清理请求没有清掉任何害，按今日次数用完处理', { event: 'fnos好友牧场', result: 'limit' }); }
        return { cleaned, rewards: sumItems(rows.flatMap((row: any) => row.rewards || [])), kinds: plan.kinds };
    } catch (e: any) {
        markExhaustedIfLimit('clean', e);
        throw e;
    }
}

/** 给好友加牧草：homesteadpb.FeedMachineService.AddFeed {instance_id, add_count, use_gold:false, host_gid}，消耗自己的牧草 7001。 */
async function feedFriend(host: string, entry: any, cfg: FnosRanchConfig, ownGrass: { left: number }): Promise<number> {
    if (actionExhausted('feed')) return 0;
    const machine = friendFeedMachine(entry);
    const count = planFriendFeed(machine, ownGrass.left, cfg);
    if (!machine || count <= 0) return 0;
    const { rpc } = require('./transport');
    try {
        const reply: any = await withOpLearning('feed', () => rpc('addGrass', { instance_id: machine.id, add_count: count, use_gold: false, host_gid: host }, true));
        const after = num(reply?.detail?.feed_count);
        const added = after > machine.feedCount ? after - machine.feedCount : count;
        ownGrass.left = Math.max(0, ownGrass.left - added);
        return added;
    } catch (e: any) {
        markExhaustedIfLimit('feed', e);
        throw e;
    }
}

async function visitFriend(target: FriendTarget, cfg: FnosRanchConfig = readConfigs().ranch, ownGrass: { left: number } = { left: 0 }): Promise<{ stolen: number; rewards: any[]; empty: boolean; cleaned: number; fed: number }> {
    const friends = require('./friends');
    const { rpc } = require('./transport');
    const { sumItems } = require('./model');
    return friends.visit(target.gid, async (entry: any, ranches: any[], host: string) => {
        let stolen = 0;
        let rewards: any[] = [];
        let cleaned = 0;
        let fed = 0;
        const eligible = friends.targets(ranches);
        if (target.steal && eligible.length) {
            const reply = await rpc('steal', { host_gid: host, targets: [] }, true);
            const rows = (reply.op_results || []).filter((row: any) => row.kind === 2 && !(row.costs || []).length);
            stolen = rows.length;
            rewards = sumItems(rows.flatMap((row: any) => row.rewards || []));
        }
        if (target.clean) {
            const c = await cleanFriendRanch(host, ranches, cfg);
            if (c) { cleaned = c.cleaned; rewards = sumItems([...rewards, ...c.rewards]); }
        }
        if (target.feed) fed = await feedFriend(host, entry, cfg, ownGrass);
        return { stolen, rewards, empty: !eligible.length && !cleaned && !fed, cleaned, fed };
    });
}

async function runFriendPatrol(nowMs: number = Date.now(), options: { ownGrass?: number } = {}): Promise<number> {
    const { ranch, alt } = readConfigs();
    if (!ranch.friendSteal && !ranch.friendClean && !ranch.friendMosquito && !ranch.friendFeed) return 0;
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
    if ((ranch.friendClean || ranch.friendMosquito || ranch.friendFeed) && (rt.opMap.clean || rt.opMap.feed)) await readOpTimes();
    const ownGrass = { left: Math.max(0, num(options.ownGrass)) };
    const cleanAllowed = !actionExhausted('clean');
    const feedAllowed = !actionExhausted('feed') && ownGrass.left > ranch.friendFeedKeep;
    if (!ranch.friendSteal && !(cleanAllowed && (ranch.friendClean || ranch.friendMosquito)) && !(feedAllowed && ranch.friendFeed)) {
        logOnce('friend-nothing', '好友牧场巡查：清理/加牧草今日次数已用完或牧草不够保留下限，偷取未开，本轮不访问');
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
        cooldown: rt.friendCooldown, cursor: rt.friendCursor, nowMs, limit: Math.min(ranch.friendMaxPerPatrol, left),
        cleanAllowed, feedAllowed,
    });
    rt.friendCursor = picked.cursor;
    let totalStolen = 0;
    const got: string[] = [];
    for (const target of picked.targets) {
        if (shouldYieldToFarm()) { log('好友牧场巡查：自己农场作物马上成熟，先回农场'); break; }
        rt.dayVisits++;
        const t = { ...target, clean: target.clean && !actionExhausted('clean'), feed: target.feed && !actionExhausted('feed') && ownGrass.left > ranch.friendFeedKeep };
        try {
            const r = await visitFriend(t, ranch, ownGrass);
            totalStolen += r.stolen;
            const parts: string[] = [];
            if (r.rewards.length) parts.push(r.rewards.map((it: any) => `${it.name} ×${it.count}`).join('、'));
            else if (r.stolen) parts.push(`偷 ${r.stolen} 个货架`);
            if (r.cleaned) parts.push(`清理 ${r.cleaned} 处`);
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
    else if (picked.targets.length) logOnce('friend-empty', `好友牧场巡查：走了 ${picked.targets.length} 个好友，暂无可偷/可清理/可加牧草`, { event: 'fnos好友牧场' });
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
    diffOpTimes,
    runFriendPatrol,
    _visitFriend: visitFriend,
    _rt: rt,
};
