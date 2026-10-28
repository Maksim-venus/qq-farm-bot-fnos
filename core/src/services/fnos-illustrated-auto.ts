export {};
/**
 * [fnos-fork] 图鉴奖励自动领取、自动完成图鉴（本 fork 新增，上游没有；2026-10-28）
 *
 * 只复用上游已有并核对过的协议：
 * - 图鉴（services/illustrated.ts、proto/illustratedpb.proto）：
 *   IllustratedService.GetIllustratedLevelListV2{type}（level_list[].can_claim / claimed）判断是否有可领等级奖励；
 *   IllustratedService.ClaimAllRewardsV2{type} 一键领取（经上游 claimIllustratedRewards，串行、领取前复核）。
 *   type 1 = 作物图鉴，type 2 = 变异图鉴（上游只支持这两种；IllustratedRewardRedDotNotifyV2 里的牧场图鉴没有实现，不处理）。
 *   IllustratedService.GetIllustratedListV2{rarity:0,type:1} 的 list[].fruit_id / unlocked 判断作物是否已收藏。
 * - 商店（services/farm/planting.ts）：ShopService.ShopInfo(2) 种子商店（getAvailableSeeds：goodsId、price、
 *   locked、soldOut、requiresUnlockCard、itemCount），ShopService.BuyGoods 购买（经上游 purchaseSeed，
 *   购买前重新读商店并核对解锁/等级/解锁卡/限购/金币）。
 * - 背包（warehouse.getBag / getBagItems，含已锁定物品）、土地（farm/api getAllLands，plant.id → 植物表 seed_id）。
 *
 * 自动完成图鉴：每 10 分钟最多买 1 个种子；只买「未收藏 + 背包没有该种子 + 地里没种着 + 商店可买且金币够」的作物，
 * 买到的种子记为「待种」（持久化到数据目录 fnos-illustrated/<账号>.json，重启不丢），
 * 自动种植时（farm/planting.ts autoPlantEmptyLands 的 [fnos-fork] 挂钩）先把待种种子各种 1 块，再按原来的策略种剩余空地；
 * 种下或已收藏后从待种中移除，播种恢复原逻辑。同一种子最多自动买 MAX_ATTEMPTS 次，避免收不进图鉴时反复购买。
 */

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 12 * 1000;
const MAX_PENDING = 2; // 同时最多 2 个待种种子，满了不再买
const MAX_ATTEMPTS = 3; // 同一种子最多自动买 3 次
const BOOK_TYPES: Array<{ type: number; name: string }> = [{ type: 1, name: '作物图鉴' }, { type: 2, name: '变异图鉴' }];

export interface FnosIllustratedAutoConfig {
    /** 图鉴奖励自动领取 */
    autoClaimRewards: boolean;
    /** 自动完成图鉴（买未收藏作物的种子并优先播种） */
    autoComplete: boolean;
}

const DEFAULT_FNOS_ILLUSTRATED_AUTO: FnosIllustratedAutoConfig = { autoClaimRewards: false, autoComplete: false };

function normalizeFnosIllustratedAuto(input: unknown, fallback: FnosIllustratedAutoConfig = DEFAULT_FNOS_ILLUSTRATED_AUTO): FnosIllustratedAutoConfig {
    const base = { ...DEFAULT_FNOS_ILLUSTRATED_AUTO, ...(fallback || {}) };
    const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, any> : {};
    return {
        autoClaimRewards: src.autoClaimRewards !== undefined ? !!src.autoClaimRewards : !!base.autoClaimRewards,
        autoComplete: src.autoComplete !== undefined ? !!src.autoComplete : !!base.autoComplete,
    };
}

function num(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    return Number(value) || 0;
}

// ============ 待种记录（持久化） ============

interface PendingState {
    /** seedId → 购买信息 */
    pending: Record<string, { name: string; boughtAt: number }>;
    /** seedId → 已自动购买次数 */
    attempts: Record<string, number>;
}

let pendingCache: PendingState | null = null;
/** 同一条跳过原因只记一次（直到原因变化或设置变更） */
const lastLog: Record<string, string> = {};

function pendingFile(): string {
    const path = require('node:path');
    const { getDataDir } = require('../config/runtime-paths');
    const dir = process.env.FARM_DATA_DIR || getDataDir();
    const id = String(process.env.FARM_ACCOUNT_ID || 'default').replace(/[^\w-]/g, '_');
    return path.join(dir, 'fnos-illustrated', `${id}.json`);
}

function loadPending(): PendingState {
    if (pendingCache) return pendingCache;
    const fs = require('node:fs');
    let state: PendingState = { pending: {}, attempts: {} };
    try {
        const raw = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
        if (raw && typeof raw === 'object') {
            state = {
                pending: raw.pending && typeof raw.pending === 'object' ? raw.pending : {},
                attempts: raw.attempts && typeof raw.attempts === 'object' ? raw.attempts : {},
            };
        }
    } catch { /* 首次没有文件 */ }
    pendingCache = state;
    return state;
}

function savePending(): void {
    if (!pendingCache) return;
    const fs = require('node:fs');
    const path = require('node:path');
    const file = pendingFile();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(pendingCache, null, 2));
        fs.renameSync(tmp, file);
    } catch (e: any) {
        try { require('../utils/utils').logWarn('图鉴', `保存「自动完成图鉴」待种记录失败：${e.message}`, { module: 'farm', event: '自动完成图鉴', result: 'error' }); } catch { /* ignore */ }
    }
}

function getPendingSeedIds(): number[] {
    const st = loadPending();
    return Object.entries(st.pending)
        .sort((a, b) => num(a[1]?.boughtAt) - num(b[1]?.boughtAt))
        .map(([id]) => Number(id)).filter(id => id > 0);
}

function removePending(seedId: number): void {
    const st = loadPending();
    if (st.pending[String(seedId)]) {
        delete st.pending[String(seedId)];
        savePending();
    }
}

function resetFnosIllustratedRuntime(options: { clearPending?: boolean } = {}): void {
    for (const k of Object.keys(lastLog)) delete lastLog[k];
    pendingCache = null;
    if (options.clearPending) {
        pendingCache = { pending: {}, attempts: {} };
        savePending();
    }
}

// ============ 纯函数 ============

/** 作物图鉴条目 → 种子 id（与上游 buildIllustratedSnapshot 相同的映射）。 */
function bookItemSeedId(fruitId: number): number {
    const { getPlantBySeedId, getPlantByFruitId } = require('../config/gameConfig');
    const plant = getPlantBySeedId(fruitId) || getPlantByFruitId(fruitId);
    return num(plant && plant.seed_id) || fruitId;
}

/** 土地上正在种的作物 → 种子 id 集合。 */
function plantedSeedIds(lands: any[]): Set<number> {
    const { getPlantById } = require('../config/gameConfig');
    const set = new Set<number>();
    for (const land of Array.isArray(lands) ? lands : []) {
        const plantId = num(land?.plant?.id);
        if (plantId <= 0) continue;
        const seedId = num(getPlantById(plantId)?.seed_id);
        if (seedId > 0) set.add(seedId);
    }
    return set;
}

/**
 * 选出这一轮要买的种子（纯函数）。
 * uncollectedSeedIds：未收藏作物的种子 id；bagSeedIds：背包里有的物品 id（含锁定）；
 * shopSeeds：getAvailableSeeds() 结果；gold：当前金币；level：当前等级。
 */
function pickSeedToBuy(input: {
    uncollectedSeedIds: number[]; bagSeedIds: Set<number>; landSeedIds: Set<number>;
    pendingSeedIds: Set<number>; attempts: Record<string, number>; shopSeeds: any[]; gold: number; level: number;
}): { seed: any; candidates: number } | { skip: string; kind: string } {
    const shopBySeed = new Map<number, any>();
    for (const s of Array.isArray(input.shopSeeds) ? input.shopSeeds : []) {
        if (num(s?.goodsId) > 0 && !shopBySeed.has(num(s.seedId))) shopBySeed.set(num(s.seedId), s);
    }
    const missing = input.uncollectedSeedIds.filter(id => !input.bagSeedIds.has(id) && !input.landSeedIds.has(id) && !input.pendingSeedIds.has(id));
    if (!input.uncollectedSeedIds.length) return { skip: '作物图鉴已全部收藏', kind: 'complete' };
    if (!missing.length) return { skip: '未收藏的作物都已在背包或地里', kind: 'covered' };
    const { getPlantBySeedId } = require('../config/gameConfig');
    const buyable: any[] = [];
    let poor = 0;
    let exhausted = 0;
    for (const seedId of missing) {
        const s = shopBySeed.get(seedId);
        if (!s || s.locked || s.soldOut || s.requiresUnlockCard || !(num(s.price) > 0)) continue;
        if (num(s.requiredLevel) > input.level) continue;
        if (num(input.attempts[String(seedId)]) >= MAX_ATTEMPTS) { exhausted++; continue; }
        if (num(s.price) > input.gold) { poor++; continue; }
        buyable.push({ ...s, plantSize: Math.max(1, num(getPlantBySeedId(seedId)?.size) || 1) });
    }
    if (!buyable.length) {
        const why = poor ? `金币不足（${poor} 种买不起）` : exhausted ? `已达自动购买次数上限（${exhausted} 种）` : '商店里都不能买（未解锁、需要解锁卡、已售罄或商店没有）';
        return { skip: `${missing.length} 种未收藏作物没有可买的种子：${why}`, kind: poor ? 'poor' : exhausted ? 'exhausted' : 'unbuyable' };
    }
    // 先买单格作物，再按等级、价格从低到高
    buyable.sort((a, b) => (a.plantSize - b.plantSize) || (num(a.requiredLevel) - num(b.requiredLevel)) || (num(a.price) - num(b.price)) || (num(a.seedId) - num(b.seedId)));
    return { seed: buyable[0], candidates: buyable.length };
}

// ============ 运行时 ============

function readConfig(): FnosIllustratedAutoConfig {
    return require('./fnos-fork-config').readFnosForkConfigs().illustrated;
}

function logOnce(channel: string, message: string, meta: any, warn = false): void {
    if (lastLog[channel] === message) return;
    lastLog[channel] = message;
    const u = require('../utils/utils');
    (warn ? u.logWarn : u.log)('图鉴', message, meta);
}

function describeRewards(list: any[]): string {
    const parts = (Array.isArray(list) ? list : []).filter(v => num(v?.count) > 0).map(v => `${v.name || `物品 #${v.itemId || v.id}`}×${num(v.count)}`);
    return parts.length ? parts.join('、') : '（回包未列出物品）';
}

async function runClaimRewards(deps: any): Promise<number> {
    const { log } = require('../utils/utils');
    const meta = { module: 'farm', event: '图鉴奖励领取' };
    let claimed = 0;
    for (const book of BOOK_TYPES) {
        let levels: any;
        try {
            levels = await deps.illustrated.getIllustratedLevels(book.type);
        } catch (e: any) {
            logOnce(`claim${book.type}`, `${book.name}奖励领取跳过：读取图鉴等级失败（${e.message}），10 分钟后再试`, { ...meta, result: 'error' }, true);
            continue;
        }
        const can = (levels?.level_list || []).filter((v: any) => v && v.can_claim && !v.claimed);
        if (!can.length) { logOnce(`claim${book.type}`, `${book.name}暂无可领取奖励`, { ...meta, result: 'skip' }); continue; }
        try {
            const res = await deps.illustrated.claimIllustratedRewards(book.type);
            lastLog[`claim${book.type}`] = '';
            const lv = (res?.claimedLevels || []).map((v: any) => num(v)).join('、');
            log('图鉴', `${book.name}奖励已领取${lv ? `（等级 ${lv}）` : ''}：${describeRewards(res?.rewards)}`, { ...meta, result: 'ok', type: book.type });
            claimed++;
        } catch (e: any) {
            logOnce(`claim${book.type}`, `${book.name}奖励领取失败：${e.message}，10 分钟后再试`, { ...meta, result: 'error' }, true);
        }
    }
    return claimed;
}

async function runAutoComplete(deps: any): Promise<boolean> {
    const { log } = require('../utils/utils');
    const meta = { module: 'farm', event: '自动完成图鉴' };
    let list: any; let bagItems: any[]; let lands: any[]; let shopSeeds: any[];
    try {
        list = await deps.illustrated.getIllustratedList(1);
        bagItems = deps.warehouse.getBagItems(await deps.warehouse.getBag()) || [];
        const landsReply = await deps.farmApi.getAllLands();
        lands = Array.isArray(landsReply?.lands) ? landsReply.lands : [];
    } catch (e: any) {
        logOnce('complete', `自动完成图鉴跳过：读取图鉴/背包/土地失败（${e.message}），10 分钟后再试`, { ...meta, result: 'error' }, true);
        return false;
    }
    const items: any[] = Array.isArray(list?.list) ? list.list : [];
    const uncollected = [...new Set(items.filter(v => v && v.unlocked !== true).map(v => bookItemSeedId(num(v.fruit_id))).filter(id => id > 0))];
    const collected = new Set(items.filter(v => v && v.unlocked === true).map(v => bookItemSeedId(num(v.fruit_id))));
    const bagSeedIds = new Set<number>(bagItems.filter(v => num(v?.count) > 0).map(v => num(v.id)));
    const landSeedIds = plantedSeedIds(lands);

    // 清理待种：已收藏 / 已种下 / 背包里已没有 → 移除，恢复原播种逻辑
    const st = loadPending();
    let changed = false;
    for (const seedId of getPendingSeedIds()) {
        const name = st.pending[String(seedId)]?.name || `种子#${seedId}`;
        let reason = '';
        if (collected.has(seedId)) reason = '已收藏';
        else if (landSeedIds.has(seedId)) reason = '已种在地里';
        else if (!bagSeedIds.has(seedId)) reason = '背包里已没有';
        if (reason) {
            delete st.pending[String(seedId)];
            changed = true;
            log('图鉴', `自动完成图鉴：${name} ${reason}，取消优先播种`, { ...meta, result: 'pending_clear', seedId });
        }
    }
    if (changed) savePending();

    const pendingIds = new Set(getPendingSeedIds());
    if (pendingIds.size >= MAX_PENDING) {
        logOnce('complete', `自动完成图鉴：已有 ${pendingIds.size} 个待种种子，等种下后再买`, { ...meta, result: 'skip', kind: 'pending_full' });
        return false;
    }
    try {
        shopSeeds = await deps.planting.getAvailableSeeds(true);
    } catch (e: any) {
        logOnce('complete', `自动完成图鉴跳过：读取种子商店失败（${e.message}），10 分钟后再试`, { ...meta, result: 'error' }, true);
        return false;
    }
    const userState = deps.getUserState() || {};
    const plan = pickSeedToBuy({
        uncollectedSeedIds: uncollected, bagSeedIds, landSeedIds, pendingSeedIds: pendingIds,
        attempts: st.attempts, shopSeeds, gold: num(userState.gold), level: num(userState.level),
    });
    if ('skip' in plan) {
        logOnce('complete', `自动完成图鉴跳过：${plan.skip}`, { ...meta, result: 'skip', kind: plan.kind });
        return false;
    }
    const seed = plan.seed;
    const seedId = num(seed.seedId);
    const name = String(seed.name || `种子#${seedId}`);
    // 先记一次尝试，购买结果不确定时也不会反复买
    st.attempts[String(seedId)] = num(st.attempts[String(seedId)]) + 1;
    savePending();
    try {
        const reply = await deps.planting.purchaseSeed(seed.goodsId, 1);
        const got = (reply?.get_items || []).find((v: any) => num(v?.id) > 0);
        const gotId = num(got?.id) || seedId;
        st.pending[String(gotId)] = { name, boughtAt: Date.now() };
        savePending();
        lastLog.complete = '';
        log('图鉴', `自动完成图鉴：${name} 未收藏，已买种子 ×${num(got?.count) || num(seed.itemCount) || 1}（${num(seed.price)} 金币），下次播种优先种下`, {
            ...meta, result: 'ok', seedId: gotId, goodsId: num(seed.goodsId), price: num(seed.price), candidates: plan.candidates,
        });
        return true;
    } catch (e: any) {
        logOnce('complete', `自动完成图鉴：购买 ${name} 种子失败：${e.message}，10 分钟后再看`, { ...meta, result: 'error', seedId }, true);
        return false;
    }
}

function defaultDeps(): any {
    return {
        illustrated: require('./illustrated'),
        warehouse: require('./warehouse'),
        farmApi: require('./farm/api'),
        planting: require('./farm/planting'),
        getUserState: () => require('../utils/network').getUserState(),
    };
}

/** 一轮：领取图鉴奖励、自动完成图鉴。 */
async function runIllustratedAutoTick(options: { deps?: any } = {}) {
    const cfg = readConfig();
    const result = { claimed: 0, bought: false };
    if (!cfg.autoClaimRewards && !cfg.autoComplete) return result;
    const deps = { ...defaultDeps(), ...(options.deps || {}) };
    if (cfg.autoClaimRewards) result.claimed = await runClaimRewards(deps);
    if (cfg.autoComplete) result.bought = await runAutoComplete(deps);
    return result;
}

/**
 * 自动种植挂钩（farm/planting.ts autoPlantEmptyLands 的 [fnos-fork]）：
 * 先把「自动完成图鉴」买的待种种子各种 1 块，返回剩余空地给原策略。
 * 未开启或没有待种种子时不发任何请求，原样返回。
 */
async function plantFnosIllustratedSeeds(landIds: number[], options: { propagateErrors?: boolean; deps?: any } = {}): Promise<{ plantedLandIds: number[]; remainingLandIds: number[]; uncertain: boolean }> {
    let remaining = [...new Set((Array.isArray(landIds) ? landIds : []).map(v => num(v)).filter(v => v > 0))];
    const out = { plantedLandIds: [] as number[], remainingLandIds: remaining, uncertain: false };
    if (!remaining.length) return out;
    if (!readConfig().autoComplete) return out;
    const pendingIds = getPendingSeedIds();
    if (!pendingIds.length) return out;
    const deps = options.deps || {};
    const warehouse = deps.warehouse || require('./warehouse');
    const planting = deps.planting || require('./farm/planting');
    const { buildPlantingLayouts, selectNonOverlappingLayouts } = require('./farm/land-analysis');
    const { log, logWarn } = require('../utils/utils');
    const meta = { module: 'farm', event: '自动完成图鉴' };
    const bagSeeds: any[] = await warehouse.getBagSeeds();
    const st = loadPending();
    for (const seedId of pendingIds) {
        if (!remaining.length) break;
        const bag = bagSeeds.find(v => num(v?.seedId) === seedId && num(v?.count) > 0);
        if (!bag) continue; // 背包里暂时没有（或已锁定），10 分钟检查时会清理
        const name = st.pending[String(seedId)]?.name || bag.name || `种子#${seedId}`;
        const size = Math.max(1, num(bag.plantSize) || num(planting.getPlantSizeBySeedId?.(seedId)) || 1);
        const layouts = selectNonOverlappingLayouts(buildPlantingLayouts(remaining, size), 1);
        if (!layouts.length) {
            logOnce(`plant${seedId}`, `自动完成图鉴：${name} 需要 ${size}x${size} 空地，本轮没有合适位置，下次再种`, { ...meta, result: 'skip_no_layout', seedId });
            continue;
        }
        const result = await planting.plantSeeds(seedId, layouts.map((l: any) => l.anchorLandId), { maxPlantCount: 1, layouts, propagateErrors: options.propagateErrors });
        const consumed = new Set<number>([...(result.reservedLandIds || []), ...(result.occupiedLandIds || [])].map((v: any) => num(v)));
        remaining = remaining.filter(id => !consumed.has(id));
        if (result.planted > 0) {
            out.plantedLandIds.push(...result.plantedLandIds);
            removePending(seedId);
            log('图鉴', `自动完成图鉴：已优先种下 ${name}（土地 ${result.plantedLandIds.join(',')}），恢复原播种顺序`, { ...meta, result: 'planted', seedId });
        }
        if (result.uncertain) {
            out.uncertain = true;
            logWarn('图鉴', `自动完成图鉴：${name} 种植状态不确定，本轮停止后续播种`, { ...meta, result: 'uncertain', seedId });
            break;
        }
    }
    out.remainingLandIds = remaining;
    return out;
}

let activeScheduler: any = null;
let activeTick: (() => Promise<any>) | null = null;
let lastTickErrorLogAt = 0;

function startFnosIllustratedAuto(scheduler: any, runExclusive: (name: string, fn: () => Promise<any>) => Promise<any>): void {
    for (const k of Object.keys(lastLog)) delete lastLog[k];
    pendingCache = null;
    const tick = () => runExclusive('fnos_illustrated_auto', () => runIllustratedAutoTick()).catch((e: any) => {
        if (Date.now() - lastTickErrorLogAt > 30 * 60 * 1000) {
            lastTickErrorLogAt = Date.now();
            try { require('../utils/utils').logWarn('图鉴', `图鉴自动检查出错：${e && e.message ? e.message : e}`, { module: 'farm', event: '图鉴自动', result: 'error' }); } catch { /* ignore */ }
        }
        return null;
    });
    activeScheduler = scheduler;
    activeTick = tick;
    scheduler.setTimeoutTask('fnos_illustrated_auto_first', FIRST_TICK_DELAY_MS, tick);
    scheduler.setIntervalTask('fnos_illustrated_auto', CHECK_INTERVAL_MS, tick);
}

function onFnosIllustratedAutoConfigChanged(): void {
    for (const k of Object.keys(lastLog)) delete lastLog[k];
    if (activeScheduler && activeTick) {
        try { activeScheduler.setTimeoutTask('fnos_illustrated_auto_first', FIRST_TICK_DELAY_MS, activeTick); } catch { /* ignore */ }
    }
}

module.exports = {
    CHECK_INTERVAL_MS,
    MAX_PENDING,
    MAX_ATTEMPTS,
    DEFAULT_FNOS_ILLUSTRATED_AUTO,
    normalizeFnosIllustratedAuto,
    pickSeedToBuy,
    plantedSeedIds,
    bookItemSeedId,
    getPendingSeedIds,
    runIllustratedAutoTick,
    plantFnosIllustratedSeeds,
    startFnosIllustratedAuto,
    onFnosIllustratedAutoConfigChanged,
    resetFnosIllustratedRuntime,
};
