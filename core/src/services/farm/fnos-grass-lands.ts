export {};
/**
 * [fnos-fork] 农场「最后 X 块地只种牧草」（2026-11-16，本 fork 新增，上游没有）
 *
 * 设置：accountConfigs.<id>.fnosGrassLands = { count, autoBuy }，页面在「设置 → 自动控制 → 种植」卡片，随 /api/settings/save 保存。
 * - count = X（0 = 关闭，最大 24）：已解锁土地按地块编号从小到大排序，最后 X 块只种牧草（作物 1020040，种子 20040，
 *   收获牧草 7001 ×20，生长 10 分钟，1×1）。这些地空出来时只种牧草，不参与图鉴优先播种和原有策略；其余空地照旧。
 * - autoBuy（默认开）：背包牧草种子不够时，从商店 4 的商品 2129（牧草种子，20 金币/个，最低等级 1，单次最多 99，
 *   来源：Goods.json 与 1116-2 抓包 ShopInfo{shop_id:4} 回包一致）补买差额；关闭或买不到时这几块地留空并记日志（每种原因只记一次）。
 * 只在自动播种（farm/planting.ts autoPlantEmptyLands 的 [fnos-fork] 挂钩）生效；手动播种、大小号协作（收获规则）不受影响。
 */

const GRASS_SEED_ID = 20040;
const GRASS_PLANT_ID = 1020040;
const GRASS_FRUIT_ID = 7001; // [fnos-fork] 2026-11-16 牧草收获物：不自动出售（留给牧场）
const GRASS_SHOP_ID = 4;
const GRASS_GOODS_ID = 2129;
const MAX_COUNT = 24;
const MAX_BUY_PER_TIME = 99;

export interface FnosGrassLandsConfig { count: number; autoBuy: boolean }
const DEFAULT_FNOS_GRASS_LANDS: FnosGrassLandsConfig = { count: 0, autoBuy: true };

function num(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value.toNumber === 'function') return value.toNumber();
    return Number(value) || 0;
}

function normalizeFnosGrassLands(input: unknown, fallback: FnosGrassLandsConfig = DEFAULT_FNOS_GRASS_LANDS): FnosGrassLandsConfig {
    const base = { ...DEFAULT_FNOS_GRASS_LANDS, ...(fallback || {}) };
    const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, any> : {};
    const raw = Number.parseInt(String(src.count !== undefined ? src.count : base.count), 10);
    return {
        count: Number.isFinite(raw) ? Math.max(0, Math.min(MAX_COUNT, raw)) : 0,
        autoBuy: src.autoBuy !== undefined ? !!src.autoBuy : base.autoBuy !== false,
    };
}

/** 纯函数：最后 X 块已解锁土地的编号（按编号升序取尾部）。 */
function pickGrassLandIds(lands: any[], count: number): number[] {
    if (!(count > 0)) return [];
    const ids = [...new Set((Array.isArray(lands) ? lands : []).filter(l => l && l.unlocked).map(l => num(l.id)).filter(id => id > 0))].sort((a, b) => a - b);
    return ids.slice(Math.max(0, ids.length - count));
}

const lastLog: Record<string, string> = {};
function logOnce(channel: string, message: string, meta: any, warn = false): void {
    if (lastLog[channel] === message) return;
    lastLog[channel] = message;
    const u = require('../../utils/utils');
    (warn ? u.logWarn : u.log)('牧草地', message, { module: 'farm', event: 'fnos牧草地', ...meta });
}

function readConfig(): FnosGrassLandsConfig {
    try {
        const snap = require('../../models/store').getConfigSnapshot() || {};
        return normalizeFnosGrassLands(snap.fnosGrassLands);
    } catch { return normalizeFnosGrassLands(undefined); }
}

async function buyGrassSeeds(count: number, deps: any): Promise<number> {
    const shop = await deps.farmApi.getShopInfo(GRASS_SHOP_ID);
    const goods = (shop?.goods_list || []).find((g: any) => num(g.id) === GRASS_GOODS_ID || num(g.item_id) === GRASS_SEED_ID);
    if (!goods) throw new Error('商店里没有牧草种子');
    if (goods.unlocked === false) throw new Error('牧草种子尚未解锁');
    const price = num(goods.price);
    const state = deps.getUserState();
    const want = Math.min(count, MAX_BUY_PER_TIME);
    if (price <= 0 || num(state.gold) < price * want) throw new Error('金币不足或价格无效');
    const reply = await deps.farmApi.buyGoods(num(goods.id), want, price);
    for (const item of reply?.cost_items || []) {
        if (num(item.id) === 1001) state.gold = Math.max(0, num(state.gold) - num(item.count));
    }
    const got = (reply?.get_items || []).filter((it: any) => num(it.id) === GRASS_SEED_ID).reduce((s: number, it: any) => s + num(it.count), 0);
    return got || want;
}

/**
 * 自动种植挂钩：把落在「牧草地」里的空地种上牧草，返回剩余空地给原逻辑（含图鉴优先播种）。
 * 关闭时不发请求原样返回。uncertain=true 时调用方应停止本轮后续播种。
 */
async function plantFnosGrassLands(landIds: number[], options: { lands?: any[]; propagateErrors?: boolean; deps?: any; config?: FnosGrassLandsConfig } = {}): Promise<{ plantedLandIds: number[]; remainingLandIds: number[]; uncertain: boolean; reserved: number[] }> {
    const empty = [...new Set((Array.isArray(landIds) ? landIds : []).map(num).filter(v => v > 0))];
    const out = { plantedLandIds: [] as number[], remainingLandIds: empty, uncertain: false, reserved: [] as number[] };
    const cfg = options.config || readConfig();
    if (!(cfg.count > 0) || !empty.length) return out;
    const deps = {
        farmApi: require('./api'),
        warehouse: require('../warehouse'),
        planting: require('./planting'),
        getUserState: () => require('../../utils/network').getUserState(),
        ...(options.deps || {}),
    };
    let lands = Array.isArray(options.lands) ? options.lands : [];
    if (!lands.length) {
        const reply = await deps.farmApi.getAllLands();
        lands = Array.isArray(reply?.lands) ? reply.lands : [];
    }
    const grassSet = new Set(pickGrassLandIds(lands, cfg.count));
    const targets = empty.filter(id => grassSet.has(id));
    out.reserved = [...grassSet].sort((a, b) => a - b);
    out.remainingLandIds = empty.filter(id => !grassSet.has(id));
    if (!targets.length) return out;
    const meta = { landIds: targets };
    const bag = (await deps.warehouse.getBagSeeds()).find((s: any) => num(s?.seedId) === GRASS_SEED_ID);
    let have = num(bag?.count);
    if (have < targets.length && cfg.autoBuy) {
        try {
            have += await buyGrassSeeds(targets.length - have, deps);
            logOnce('buy', `牧草地：背包牧草种子不足，已补买 ${targets.length - num(bag?.count)} 个`, { ...meta, result: 'bought' });
            lastLog.buy = '';
        } catch (e: any) {
            logOnce('buy', `牧草地：补买牧草种子失败（${e.message}），差的地先空着`, { ...meta, result: 'buy_error' }, true);
            if (options.propagateErrors) throw e;
        }
    }
    const plantIds = targets.slice(0, Math.max(0, have));
    if (plantIds.length < targets.length) {
        logOnce('lack', `牧草地：牧草种子不够（有 ${have}，需 ${targets.length}${cfg.autoBuy ? '' : '，未开自动补买'}），土地 ${targets.slice(plantIds.length).join(',')} 先空着`, { ...meta, result: 'skip_no_seed' });
    }
    if (!plantIds.length) return out;
    const result = await deps.planting.plantSeeds(GRASS_SEED_ID, plantIds, { propagateErrors: options.propagateErrors });
    out.plantedLandIds = (result?.plantedLandIds || []).map(num);
    out.uncertain = !!result?.uncertain;
    if (out.plantedLandIds.length) {
        lastLog.lack = '';
        require('../../utils/utils').log('牧草地', `牧草地：已种牧草 ${out.plantedLandIds.length} 块（土地 ${out.plantedLandIds.join(',')}）`, { module: 'farm', event: 'fnos牧草地', result: 'planted' });
    }
    return out;
}

/** [fnos-fork] 2026-11-16 所有正在长牧草的地（无论是否自动种的）都不自动施肥：从目标里剔除。 */
function isGrassLand(land: any): boolean {
    const plant = land && land.plant;
    if (!plant) return false;
    return num(plant.id) === GRASS_PLANT_ID || num(plant.seed_id ?? plant.seedId) === GRASS_SEED_ID;
}
function excludeGrassLandIds(landIds: number[], lands: any[]): number[] {
    const grass = new Set((Array.isArray(lands) ? lands : []).filter(isGrassLand).map(l => num(l.id)));
    return (Array.isArray(landIds) ? landIds : []).filter(id => !grass.has(num(id)));
}

module.exports = { GRASS_SEED_ID, GRASS_PLANT_ID, GRASS_FRUIT_ID, isGrassLand, excludeGrassLandIds, GRASS_GOODS_ID, DEFAULT_FNOS_GRASS_LANDS, normalizeFnosGrassLands, pickGrassLandIds, plantFnosGrassLands };
