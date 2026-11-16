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
 *    好友牧场「清理便便 / 打蚊子 / 给好友加牧草」暂未实现：1116-2 抓包里这几个写操作的帧没有被保存（序号大段缺失），
 *    只确认了好友牧场 ranch.hazards[]（hazard_id/hazard_type）与牧草机 feed_machine 字段；按约定不按猜测发请求。
 *    friendClean / friendMosquito / friendFeed 设置位保留（页面上禁用并注明「待抓包」），见 cleanFriendRanch。
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
    friendClean: boolean;
    /** 好友牧场打蚊子（待抓包，当前不发请求） */
    friendMosquito: boolean;
    /** 给好友加牧草，消耗自己的牧草 7001（待抓包，当前不发请求） */
    friendFeed: boolean;
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
        return ranch.friendSteal || ranch.illustratedAutoClaim || ranch.illustratedAutoComplete;
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

export interface FriendTarget { gid: number; name: string; steal: boolean; clean: boolean; priority: boolean }

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
}): { targets: FriendTarget[]; cursor: number } {
    const { cfg, alt } = input;
    const black = new Set(input.blacklist.map(Number));
    const altSet = new Set(input.myAltGids);
    const masterGid = alt && alt.enabled ? num(alt.masterGid) : 0;
    const skipStealMaster = !!(alt && alt.enabled && alt.skipStealMaster);
    const pool = input.friends
        .map(f => ({ gid: num(f.gid), name: String(f.name || '') }))
        .filter(f => f.gid > 0 && f.gid !== input.myGid && !black.has(f.gid));
    const build = (f: { gid: number; name: string }): FriendTarget | null => {
        if ((input.cooldown.get(f.gid) || 0) > input.nowMs) return null;
        const steal = cfg.friendSteal && !(skipStealMaster && masterGid > 0 && f.gid === masterGid);
        const clean = false; // [fnos-fork] 好友牧场清理等抓包后再实现
        if (!steal && !clean) return null;
        return { gid: f.gid, name: f.name, steal, clean, priority: altSet.has(f.gid) };
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

/** 好友牧场清理：未抓到真实请求前不实现，恒返回 null（保留接口，抓包后在这里补 CleanAllRanch{host_gid,…}）。 */
async function cleanFriendRanch(_host: string, _ranches: any[]): Promise<null> {
    return null;
}

async function visitFriend(target: FriendTarget): Promise<{ stolen: number; rewards: any[]; empty: boolean }> {
    const friends = require('./friends');
    const { rpc } = require('./transport');
    const { quantity, sumItems } = require('./model');
    return friends.visit(target.gid, async (_entry: any, ranches: any[], host: string) => {
        let stolen = 0;
        let rewards: any[] = [];
        const eligible = friends.targets(ranches);
        if (target.steal && eligible.length) {
            const reply = await rpc('steal', { host_gid: host, targets: [] }, true);
            const rows = (reply.op_results || []).filter((row: any) => row.kind === 2 && !(row.costs || []).length);
            stolen = rows.length;
            rewards = sumItems(rows.flatMap((row: any) => row.rewards || []));
            void quantity;
        }
        if (target.clean) await cleanFriendRanch(host, ranches);
        return { stolen, rewards, empty: !eligible.length };
    });
}

async function runFriendPatrol(nowMs: number = Date.now()): Promise<number> {
    const { ranch, alt } = readConfigs();
    if (!ranch.friendSteal) return 0;
    if (nowMs < rt.nextFriendPatrolAt) return 0;
    rt.nextFriendPatrolAt = nowMs + ranch.friendIntervalMinutes * 60_000;
    try {
        const { inFriendQuietHours } = require('../friend/visit-strategy');
        if (inFriendQuietHours()) { logOnce('friend-quiet', '好友牧场巡查：好友静默时段内，跳过'); return 0; }
    } catch { /* ignore */ }
    const u = require('../../utils/utils');
    const today = u.getSystemDateKey();
    if (rt.dayKey !== today) { rt.dayKey = today; rt.dayVisits = 0; }
    const left = ranch.friendDailyVisitLimit - rt.dayVisits;
    if (left <= 0) { logOnce('friend-limit', `好友牧场巡查：今日已访问 ${rt.dayVisits} 次，达到上限 ${ranch.friendDailyVisitLimit}，明天继续`); return 0; }
    const myGid = selfGid();
    if (!myGid) return 0;
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
    });
    rt.friendCursor = picked.cursor;
    let totalStolen = 0;
    const got: string[] = [];
    for (const target of picked.targets) {
        if (shouldYieldToFarm()) { log('好友牧场巡查：自己农场作物马上成熟，先回农场'); break; }
        rt.dayVisits++;
        try {
            const r = await visitFriend(target);
            totalStolen += r.stolen;
            if (r.stolen) got.push(`${target.name || target.gid}：${r.rewards.map((it: any) => `${it.name} ×${it.count}`).join('、') || `${r.stolen} 个货架`}`);
            rt.friendCooldown.set(target.gid, Date.now() + (r.stolen ? FRIEND_COOLDOWN_STOLE_MS : FRIEND_COOLDOWN_EMPTY_MS));
        } catch (e: any) {
            rt.friendCooldown.set(target.gid, Date.now() + FRIEND_COOLDOWN_ERROR_MS);
            log(`好友牧场巡查：${target.name || target.gid} 失败（${e.message}），6 小时内不再访问`, { result: 'error' }, true);
            if (e && (e.code === 'RANCH_RESULT_UNKNOWN' || /重新登录/.test(String(e.message)))) break;
        }
    }
    if (got.length) log(`好友牧场巡查：偷取 ${got.join('；')}`, { event: 'fnos好友牧场', result: 'ok' });
    else if (picked.targets.length) logOnce('friend-empty', `好友牧场巡查：走了 ${picked.targets.length} 个好友，暂无可偷产物`, { event: 'fnos好友牧场' });
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
    runFriendPatrol,
    _rt: rt,
};
