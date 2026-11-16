export {};
/**
 * [fnos-fork] 牧场 fork 功能（2026-11-16，本 fork 新增，上游没有）。设置在 accountConfigs.<id>.fnosRanch，
 * 页面在「设置 → 牧场空间 → 自动控制」的「飞牛增强」卡片，随 /api/settings/save 保存。
 * 上游 #135/#136 已有的好友牧场自动偷 / 清理 / 放蚊子 / 抚摸、牧场巡查按到期让路与优先农场，本 fork 不再另做（2026.11.16.1 起删除了
 * fork 的同类开关），只在上游流程上叠加：
 *
 * 1. 牧场也等大号（小号）：复用「大小号协作」里的 holdForMaster / timeoutMinutes，作用于上游「自动收获」。
 *    依据 animalpb.ProductLotDetail.stealers：货架 can_collect 时大号 GID 已在 stealers → 放行；remain_num 全为 0 → 放行；
 *    否则从首次看到可收算起超时放行（农场 timeoutMinutes；为 0 时用 altHoldFallbackMinutes，默认 60）。
 *    还有货架在等时只用 HarvestRanch op=4 收成熟动物，不碰货架；全部放行后按上游 op=1 一键收。
 * 2. 牧场图鉴：自动领取（上游 claimIllustrated normal/giant，先报价再按 expected 提交）；
 *    普通图鉴 = GetIllustratedListV2{type:101}.has_claimable_reward → ClaimAllRewardsV2{type:101}；
 *    巨大图鉴 = GetRanchWeightScoreV2 levels[].can_claim && !claimed → 逐级 ClaimRanchWeightScoreRewardV2{id}。
 *    2026-11-17 起默认开启；每 30 分钟最多读一次（红点 ranch_reward_available 提前），只有这项要做时不再每轮巡查都进牧场；
 *    自动完成：自动买幼崽时优先挑产物还没进图鉴的动物。
 * 3. 上游好友牧场自动化（friends.automateFriend）的大小号规则（类比农场 fnos-alt-coop）：
 *    - 偷：小号开了「不偷大号的菜」（skipStealMaster）不偷大号；
 *    - 清理：小号开了「只给大号放捣乱」（badOnlyMaster）不帮大号清，留给大号自己清；
 *    - 放蚊子：小号开了「只给大号放捣乱」→ 只给大号放；其余情况不给自己的大号 / 小号 / 同一大号下的其它小号放。
 * 4. 上游好友牧场自动化里的额外动作（上游没有）：
 *    - 帮好友生产 friendHelpProduce：好友动物 can_deliver 时 AnimalService.TriggerProduce {host_gid}（1116-6 #161）；
 *    - 给好友加牧草 friendFeed：FeedMachineService.AddFeed {instance_id, add_count, use_gold, host_gid}；每次最多 friendFeedPerTime，不超过好友牧草机剩余容量。
 *      2026-11-17 起「加草来源」friendFeedSource：
 *        warehouse（默认）= 用农场仓库的牧草（物品 7001），use_gold 不带（=false），每份扣 1 个 7001（1117-grass #70/#104：
 *          {1: 10002, 2: 1, 4: host_gid}，ItemNotify 7001 −1，回包 detail.feed_count）；仓库不够时只加够库存的份数，停下写日志，不改用金币；
 *        gold = 原来的 use_gold:true，扣金币约 60/份（1116-7 #172），自己金币低于 friendFeedGoldKeep 不加。
 *      好友牧草机 instance_id 从好友牧场 facilities 里取（feed_machine 那一格），不写死。
 *    这两项不占 GetRanchOpTimes 次数（抓包前后不变），请求报次数类错误或无效果时当天停止。
 */

const BOOK_INTERVAL_MS = 30 * 60 * 1000;
/** 给好友加牧草每份扣的金币（1116-7：加 2 份 −120、加 3 份 −180） */
const FEED_GOLD_PER_UNIT = 60;
/** 牧草（农场仓库物品 id） */
const GRASS_ITEM_ID = 7001;
export type FnosFriendFeedSource = 'warehouse' | 'gold';
const FRIEND_FEED_SOURCES: FnosFriendFeedSource[] = ['warehouse', 'gold'];

export interface FnosRanchConfig {
    altHold: boolean;
    altHoldFallbackMinutes: number;
    illustratedAutoClaim: boolean;
    illustratedAutoComplete: boolean;
    /** 帮好友生产（TriggerProduce，好友动物 can_deliver 时） */
    friendHelpProduce: boolean;
    /** 给好友加牧草（AddFeed） */
    friendFeed: boolean;
    /** [fnos-fork] 2026-11-17 加草来源：warehouse = 农场仓库牧草 7001（默认，use_gold:false）；gold = 金币（约 60/份） */
    friendFeedSource: FnosFriendFeedSource;
    /** 每次给一个好友最多加多少牧草 */
    friendFeedPerTime: number;
    /** 自己金币低于此值不给好友加牧草 */
    friendFeedGoldKeep: number;
}

/** 2026.11.16.1 起删除的旧字段（被上游 #135/#136 取代，从未发布过）；读到时丢弃。 */
const REMOVED_FNOS_RANCH_KEYS = [
    'rotation', 'rotationIdleMinutes', 'rotationMinGapSeconds',
    'friendSteal', 'friendClean', 'friendMosquito', 'friendPutMosquito', 'friendPutPerFriend',
    'friendIntervalMinutes', 'friendMaxPerPatrol', 'friendDailyVisitLimit', 'friendFeedKeep',
];

const DEFAULT_FNOS_RANCH: FnosRanchConfig = {
    altHold: true,
    altHoldFallbackMinutes: 60,
    illustratedAutoClaim: true, // [fnos-fork] 2026-11-17 牧场图鉴 / 巨大图鉴奖励自动领取默认开启（老配置一次性迁移见 fnos-claim-default-migration）
    illustratedAutoComplete: false,
    friendHelpProduce: false,
    friendFeed: false,
    friendFeedSource: 'warehouse',
    friendFeedPerTime: 10,
    friendFeedGoldKeep: 10000,
};

function clampInt(value: any, min: number, max: number, fallback: number): number {
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

/** 只输出当前字段（旧字段自然丢弃，下次保存即从配置文件清掉）。 */
function normalizeFnosRanch(input: unknown, fallback: FnosRanchConfig = DEFAULT_FNOS_RANCH): FnosRanchConfig {
    const base = { ...DEFAULT_FNOS_RANCH, ...(fallback || {}) };
    const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, any> : {};
    const bool = (key: keyof FnosRanchConfig) => src[key] !== undefined ? !!src[key] : !!base[key];
    const int = (key: keyof FnosRanchConfig, min: number, max: number) => clampInt(src[key] !== undefined ? src[key] : base[key], min, max, DEFAULT_FNOS_RANCH[key] as number);
    return {
        altHold: bool('altHold'),
        altHoldFallbackMinutes: int('altHoldFallbackMinutes', 5, 720),
        illustratedAutoClaim: bool('illustratedAutoClaim'),
        illustratedAutoComplete: bool('illustratedAutoComplete'),
        friendHelpProduce: bool('friendHelpProduce'),
        friendFeed: bool('friendFeed'),
        // [fnos-fork] 2026-11-17 旧配置没有此字段 → 默认仓库牧草
        friendFeedSource: FRIEND_FEED_SOURCES.includes(src.friendFeedSource) ? src.friendFeedSource : (FRIEND_FEED_SOURCES.includes(base.friendFeedSource) ? base.friendFeedSource : 'warehouse'),
        friendFeedPerTime: int('friendFeedPerTime', 1, 500),
        friendFeedGoldKeep: int('friendFeedGoldKeep', 0, 999999999),
    };
}

// ============ 运行时状态（内存） ============
const rt = {
    shelfFirstSeen: new Map<string, number>(),
    lastHoldLog: '',
    holdWakeAtMs: 0,
    nextBookAt: 0,
    uncollectedProducts: null as Set<number> | null,
    dayKey: '',
    lastLog: {} as Record<string, string>,
    exhausted: {} as { feed?: string; help?: string },
    wallet: { gold: 0, grass: 0 },
    relatedCache: { at: 0, gids: [] as number[] },
};

function resetFnosRanchRuntime(): void {
    rt.shelfFirstSeen.clear();
    rt.lastHoldLog = '';
    rt.holdWakeAtMs = 0;
    rt.nextBookAt = 0;
    rt.uncollectedProducts = null;
    rt.dayKey = '';
    rt.lastLog = {};
    rt.exhausted = {};
    rt.wallet = { gold: 0, grass: 0 };
    rt.relatedCache = { at: 0, gids: [] };
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
    if (!hold) { rt.shelfFirstSeen.clear(); rt.holdWakeAtMs = 0; return { mode: 'all', held: 0, wakeAtMs: 0 }; }
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
    rt.holdWakeAtMs = wakeAtMs;
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
                        // [fnos-fork] 2026-11-17 日志写明领到的东西（巨大图鉴附领取的等级数）
                        const got = (done.result.rewards || []).map((item: any) => `${item.name || `物品 #${item.id}`} ×${item.count}`).join('、');
                        const levels = kind === 'giant' && done.quote.count ? `${done.quote.count} 级` : '';
                        log(`${kind === 'normal' ? '牧场图鉴' : '巨大图鉴'}奖励已领取${levels ? `（${levels}）` : ''}：${got || done.result.notice || '（回包未列出物品）'}`, { event: 'fnos牧场图鉴', result: 'ok', kind });
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


/** 上游 updateDeadline 用：自己牧场有没有「现在就该收」的东西（等大号的货架不算，避免反复进场）。 */
function ownHarvestReady(raw: any): boolean {
    const facilities = raw?.cells?.facilities || [];
    if (facilities.some((f: any) => (f?.ranch?.animals || []).some((a: any) => a?.can_harvest))) return true;
    if (!facilities.some((f: any) => (f?.ranch?.shelves || []).some((s: any) => s?.can_collect))) return false;
    if (!altHoldSettings()) return true;
    return planOwnHarvest(raw).mode === 'all';
}

/** 牧场一圈里还有 fork 要做的事（让上游 getRoutineState 不要判为「今日无事」）。 */
function hasForkWork(nowMs: number = Date.now()): boolean {
    try {
        const { ranch } = readConfigs();
        // [fnos-fork] 2026-11-17 图鉴只在到期时算「有活」，避免只开了图鉴领取也每轮巡查都进牧场
        return ((ranch.illustratedAutoClaim || ranch.illustratedAutoComplete) && nowMs >= rt.nextBookAt) || ranch.friendHelpProduce || ranch.friendFeed;
    } catch { return false; }
}

/** [fnos-fork] 红点 ranch_reward_available：下次牧场巡查就检查图鉴。开关关着返回 false。 */
function markBookDue(): boolean {
    try {
        const { ranch } = readConfigs();
        if (!ranch.illustratedAutoClaim) return false;
    } catch { return false; }
    rt.nextBookAt = 0;
    return true;
}

// ============ 3. 上游好友牧场自动化的大小号规则 ============
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


/**
 * 纯函数：某个好友在上游 automateFriend 里某个动作是否允许（action 为上游 FRIEND_CONTROLS 的键：steal / cleanFriend / putMosquito / stroke）。
 * alt 为本账号 fnosAltAccount（小号设置）；relatedGids 为与本账号有大小号关系的 GID。
 */
function friendActionAllowed(input: { gid: number; action: string; alt: any; relatedGids: number[] }): boolean {
    const { alt } = input;
    const gid = num(input.gid);
    const masterGid = alt && alt.enabled ? num(alt.masterGid) : 0;
    const isMaster = masterGid > 0 && gid === masterGid;
    const badOnlyMaster = !!(alt && alt.enabled && alt.badOnlyMaster && masterGid > 0);
    if (input.action === 'steal') return !(isMaster && alt && alt.skipStealMaster);
    if (input.action === 'cleanFriend') return !(isMaster && badOnlyMaster);
    if (input.action === 'putMosquito') {
        if (badOnlyMaster) return isMaster;
        const related = new Set<number>([...(input.relatedGids || []).map(num), ...(masterGid ? [masterGid] : [])]);
        return !related.has(gid);
    }
    return true;
}

/**
 * [fnos-fork] 纯函数：面板手动按钮用的置灰原因（与 friendActionAllowed 同一套规则），允许时返回空串。
 * 牧场好友列表的「偷取 / 捣乱」与详情里的「一键清理 / 放蚊子」都按这个置灰，后端手动入口也按这个拦截。
 */
function friendActionBlockReason(input: { gid: number; action: string; alt: any; relatedGids: number[] }): string {
    if (friendActionAllowed(input)) return '';
    const { alt } = input;
    const masterGid = alt && alt.enabled ? num(alt.masterGid) : 0;
    const isMaster = masterGid > 0 && num(input.gid) === masterGid;
    const badOnlyMaster = !!(alt && alt.enabled && alt.badOnlyMaster && masterGid > 0);
    if (input.action === 'steal') return '小号不偷大号（大小号协作已开「不偷大号的菜」）';
    if (input.action === 'cleanFriend') return '已开「只给大号放捣乱」，大号牧场留给大号自己清理';
    if (input.action === 'putMosquito') {
        if (badOnlyMaster && !isMaster) return '已开「只给大号放捣乱」，只给大号放蚊子';
        return '大小号关系账号之间不放蚊子';
    }
    return '大小号协作规则不允许';
}

/** [fnos-fork] 当前账号对某个好友的手动操作置灰原因：{ steal, putMosquito, cleanFriend }，空串表示允许。 */
function manualFriendRules(hostGid: unknown): Record<'steal' | 'putMosquito' | 'cleanFriend', string> {
    let alt: any = null;
    try { alt = readConfigs().alt; } catch { alt = null; }
    const gid = num(hostGid);
    const relatedGids = relatedGidsCached(selfGid(), alt);
    const reason = (action: string) => friendActionBlockReason({ gid, action, alt, relatedGids });
    return { steal: reason('steal'), putMosquito: reason('putMosquito'), cleanFriend: reason('cleanFriend') };
}

/** [fnos-fork] 手动入口（报价与执行）按大小号规则拦截。 */
function assertManualFriendAction(hostGid: unknown, action: string): void {
    const rules: Record<string, string> = manualFriendRules(hostGid);
    const reason = rules[action];
    if (reason) {
        const err: any = new Error(reason);
        err.code = 'RANCH_ALT_RULE';
        throw err;
    }
}

function relatedGidsCached(myGid: number, alt: any, nowMs: number = Date.now()): number[] {
    if (nowMs - rt.relatedCache.at > 60_000) rt.relatedCache = { at: nowMs, gids: readRelatedGids(myGid, alt) };
    return rt.relatedCache.gids;
}

let lastRuleLog = '';
/** 包一层上游 automateFriend 的 enabled 回调，叠加大小号规则。 */
function wrapFriendWanted(hostGid: unknown, wanted: (action: string) => boolean): (action: string) => boolean {
    let alt: any = null;
    try { alt = readConfigs().alt; } catch { alt = null; }
    const myGid = selfGid();
    const gid = num(hostGid);
    const related = relatedGidsCached(myGid, alt);
    return (action: string) => {
        if (!wanted(action)) return false;
        const ok = friendActionAllowed({ gid, action, alt, relatedGids: related });
        if (!ok) {
            const msg = `好友牧场：${gid} 是大小号关系账号，按大小号协作规则跳过「${({ steal: '偷取', cleanFriend: '清理', putMosquito: '放蚊子' } as any)[action] || action}」`;
            if (msg !== lastRuleLog) { lastRuleLog = msg; log(msg, { event: 'fnos好友牧场' }); }
        }
        return ok;
    };
}

// ============ 4. 上游好友牧场自动化里的额外动作 ============
function friendExtrasEnabled(): boolean {
    try { const { ranch } = readConfigs(); return ranch.friendHelpProduce || ranch.friendFeed; } catch { return false; }
}

/** 上游 friends 阶段开始时调用：记下可用金币、仓库牧草（含预留扣减）。 */
function beginFriendPhase(input: { gold: number; grass?: number }): void {
    const today = (() => { try { return require('../../utils/utils').getSystemDateKey(); } catch { return ''; } })();
    if (rt.dayKey !== today) { rt.dayKey = today; rt.exhausted = {}; }
    rt.wallet = { gold: Math.max(0, num(input.gold)), grass: Math.max(0, num(input.grass)) };
    if (rt.wallet.grass > 0) rt.lastLog['feed-grass-out'] = ''; // [fnos-fork] 仓库又有牧草了，下次用完再提示
}

/** 纯函数：好友牧场里可以「帮忙生产」的动物数（can_deliver，与上游自己牧场「触发生产」同一字段）。 */
function helpableAnimals(ranches: any[]): number {
    return (ranches || []).reduce((sum: number, r: any) => sum + (r?.animals || []).filter((a: any) => a && a.can_deliver).length, 0);
}

/**
 * 纯函数：给好友加多少牧草。
 * - 金币：扣到 friendFeedGoldKeep 为止（约 60 金币/份）；
 * - 仓库牧草（[fnos-fork] 2026-11-17 默认）：最多用到仓库 7001 的库存，不看金币。
 * wallet 传数字时按金币（兼容旧调用）。
 */
function planFriendFeed(machine: { capacity: number; feedCount: number } | null, wallet: number | { gold?: number; grass?: number },
    cfg: Pick<FnosRanchConfig, 'friendFeedPerTime' | 'friendFeedGoldKeep'> & { friendFeedSource?: FnosFriendFeedSource }): number {
    if (!machine) return 0;
    const room = Math.max(0, num(machine.capacity) - num(machine.feedCount));
    const w = typeof wallet === 'object' && wallet ? wallet : { gold: wallet as number, grass: 0 };
    const affordable = (cfg.friendFeedSource || 'gold') === 'warehouse'
        ? Math.max(0, Math.floor(num(w.grass)))
        : Math.max(0, Math.floor((num(w.gold) - cfg.friendFeedGoldKeep) / FEED_GOLD_PER_UNIT));
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

function markExhaustedIfLimit(action: 'feed' | 'help', e: any): void {
    const msg = String(e && e.message || '');
    if (/次数|上限|已达|用完|limit/i.test(msg)) {
        rt.exhausted[action] = rt.dayKey;
        log(`好友牧场：${action === 'feed' ? '给好友加牧草' : '帮忙生产'}今日停止（${msg}）`, { event: 'fnos好友牧场', result: 'limit' });
    }
}

/**
 * 帮好友生产：AnimalService.TriggerProduce {host_gid}（1116-6 #161，不带 targets = 全部 can_deliver 动物）。
 * 回包 op_results[{kind:1, target_id: animal_inst_id, rewards: 1102×5}]。返回上游 results 形状的 outcome。
 */
async function helpFriendProduce(host: string, ranches: any[]): Promise<any | null> {
    const { ranch } = readConfigs();
    if (!ranch.friendHelpProduce || rt.exhausted.help === rt.dayKey || !helpableAnimals(ranches)) return null;
    const { rpc } = require('./transport');
    const { sumItems } = require('./model');
    try {
        const reply: any = await rpc('produce', { host_gid: host }, true);
        const rows = (reply?.op_results || []).filter((row: any) => num(row.kind) === 1);
        if (!rows.length) { rt.exhausted.help = rt.dayKey; log('好友牧场：帮忙生产没有生效，今日不再帮忙生产', { event: 'fnos好友牧场', result: 'limit' }); return null; }
        const items = sumItems(rows.flatMap((row: any) => row.rewards || []));
        return { action: 'fnosHelpProduce', status: 'confirmed', completed: rows.length, rewards: items,
            notice: `帮忙生产 ${rows.length} 只${items.length ? `，获得 ${items.map((item: any) => `${item.name} ×${item.count}`).join('、')}` : ''}` };
    } catch (e: any) {
        markExhaustedIfLimit('help', e);
        throw e;
    }
}

/**
 * 给好友加牧草：FeedMachineService.AddFeed {instance_id, add_count, use_gold:true, host_gid}（与 1116-7 #172 一致，扣金币约 60/份）。
 */
async function feedFriend(host: string, entry: any): Promise<any | null> {
    const { ranch } = readConfigs();
    if (!ranch.friendFeed || rt.exhausted.feed === rt.dayKey) return null;
    const machine = friendFeedMachine(entry);
    if (!machine) return null;
    const useWarehouse = ranch.friendFeedSource !== 'gold'; // [fnos-fork] 2026-11-17 默认用仓库牧草
    const room = Math.max(0, machine.capacity - machine.feedCount);
    const wanted = Math.min(room, ranch.friendFeedPerTime);
    const count = planFriendFeed(machine, rt.wallet, ranch);
    if (useWarehouse && wanted > 0 && count < wanted) {
        // 仓库牧草不够：只加够库存的份数，然后停下写日志，不改用金币
        logOnce('feed-grass-out', `给好友加牧草：农场仓库牧草（${GRASS_ITEM_ID}）不够（剩 ${rt.wallet.grass} 份），${count > 0 ? `只加 ${count} 份，` : ''}之后暂停给好友加牧草，不会改用金币；仓库有牧草后继续`, { event: 'fnos好友牧场', result: 'grass_short' });
    }
    if (count <= 0) return null;
    const { rpc } = require('./transport');
    try {
        // 仓库牧草：不带 use_gold（与官方客户端 1117-grass 一致）；金币：use_gold:true（1116-7）
        const payload: any = { instance_id: machine.id, add_count: count, host_gid: host };
        if (!useWarehouse) payload.use_gold = true;
        const reply: any = await rpc('addGrass', payload, true);
        const after = num(reply?.detail?.feed_count);
        const added = after > machine.feedCount ? after - machine.feedCount : count;
        if (useWarehouse) rt.wallet.grass = Math.max(0, rt.wallet.grass - added);
        else rt.wallet.gold = Math.max(0, rt.wallet.gold - added * FEED_GOLD_PER_UNIT);
        return { action: 'fnosFeedFriend', status: 'confirmed', completed: 1, rewards: [],
            notice: useWarehouse ? `给好友牧草机加牧草 ${added} 份（用农场仓库牧草，剩 ${rt.wallet.grass} 份）` : `给好友牧草机加牧草 ${added} 份（约 ${added * FEED_GOLD_PER_UNIT} 金币）` };
    } catch (e: any) {
        markExhaustedIfLimit('feed', e);
        throw e;
    }
}

module.exports = {
    DEFAULT_FNOS_RANCH,
    REMOVED_FNOS_RANCH_KEYS,
    FEED_GOLD_PER_UNIT,
    GRASS_ITEM_ID,
    normalizeFnosRanch,
    resetFnosRanchRuntime,
    decideShelfHold,
    planOwnHarvest,
    ownHarvestReady,
    holdWakeAt: () => rt.holdWakeAtMs,
    runBook,
    pickAnimalForBook,
    hasForkWork,
    markBookDue,
    friendActionAllowed,
    friendActionBlockReason,
    manualFriendRules,
    assertManualFriendAction,
    readRelatedGids,
    wrapFriendWanted,
    friendExtrasEnabled,
    beginFriendPhase,
    helpableAnimals,
    planFriendFeed,
    friendFeedMachine,
    helpFriendProduce,
    feedFriend,
    _rt: rt,
};
