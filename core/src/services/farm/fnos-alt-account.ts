export {};
/**
 * [fnos-fork] 大号/小号（本 fork 新增功能，上游没有）
 *
 * 小号账号自己农场里成熟的作物先留给「大号」偷；只有检测到大号已经偷过这块地，
 * 小号的自动巡田才去收获。可选「超时后仍收获」兜底（分钟，0 = 一直等）。
 *
 * 判定依据（任一满足即视为“大号已偷”）：
 *   1. 土地数据 PlantInfo.stealers（field 14，偷菜者 GID 列表）里有大号 GID。
 *      其他同类项目把该字段定义为 `repeated int64 stealers = 14`（packed varint），
 *      上游 proto 改成了 bytes 且注明“服务端格式不一致”，因此这里自行解析：
 *      既按 packed varint 读，也兼容旧版 StealPlayer{gid=1,num=2} 嵌套消息。
 *   2. 访客记录（InteractRecords，即“农场动态”）里有大号的「偷取作物」(action_type=1)，
 *      且时间不早于该地作物成熟时间（取不到成熟时间时用本进程首次发现可收的时间）；
 *      记录带地块号时按地块匹配，否则按作物匹配。
 * 超时兜底的起点是「本进程首次观察到这块地可收」的时间，不用服务端的成熟/种植时间戳
 * （2026.10.20.3：花费催熟等情况下服务端时间戳可能早于实际可收时间，会让超时被误判为已到）。
 * 两个信号都未经真号验证，详见 fnos/飞牛部署与变更说明.md。
 *
 * 本文件只做判定与日志，不改动上游的收获/种植流程；scheduler.ts 中只有少量带
 * “[fnos-fork] 大号/小号” 注释的挂钩代码。非小号账号行为完全不变。
 */

const STEAL_ACTION_TYPE = 1;
/** 访客记录时间与成熟时间比较时的容差（秒），防止服务器时间与成熟时间的小偏差。 */
const RECORD_TIME_TOLERANCE_SEC = 120;
const MAX_TIMEOUT_MINUTES = 7 * 24 * 60;
const MATURE_PHASE = 6;

export interface FnosAltAccountConfig {
    /** 是否为小号 */
    enabled: boolean;
    /** 大号 GID（游戏内玩家 ID，好友列表中的 gid） */
    masterGid: number;
    /** 大号昵称（仅用于显示与日志） */
    masterName: string;
    /** 成熟后超过多少分钟仍未被大号偷就照常收获；0 = 一直等大号 */
    timeoutMinutes: number;
    /** 2026.10.21.3「大小号协作」：好友巡查时不偷大号的菜（见 services/friend/fnos-alt-coop.ts） */
    skipStealMaster: boolean;
    /** 2026.10.21.3「大小号协作」：放草/放虫只对大号做，不对其他好友做（不受「自动捣乱」开关限制） */
    badOnlyMaster: boolean;
}

const DEFAULT_FNOS_ALT_ACCOUNT: FnosAltAccountConfig = {
    enabled: false,
    masterGid: 0,
    masterName: '',
    timeoutMinutes: 0,
    skipStealMaster: false,
    badOnlyMaster: false,
};

function normalizeFnosAltAccount(input: unknown, fallback: FnosAltAccountConfig = DEFAULT_FNOS_ALT_ACCOUNT): FnosAltAccountConfig {
    const base = { ...DEFAULT_FNOS_ALT_ACCOUNT, ...(fallback || {}) };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...base };
    const src = input as Record<string, any>;
    const gidRaw = src.masterGid !== undefined ? Number.parseInt(String(src.masterGid), 10) : base.masterGid;
    const masterGid = Number.isSafeInteger(gidRaw) && gidRaw > 0 ? gidRaw : 0;
    const timeoutRaw = src.timeoutMinutes !== undefined ? Number.parseInt(String(src.timeoutMinutes), 10) : base.timeoutMinutes;
    const timeoutMinutes = Number.isFinite(timeoutRaw) ? Math.max(0, Math.min(MAX_TIMEOUT_MINUTES, timeoutRaw)) : 0;
    return {
        enabled: src.enabled !== undefined ? !!src.enabled : !!base.enabled,
        masterGid,
        masterName: masterGid > 0
            ? String(src.masterName !== undefined ? src.masterName : base.masterName || '').trim().slice(0, 64)
            : '',
        timeoutMinutes,
        skipStealMaster: src.skipStealMaster !== undefined ? !!src.skipStealMaster : !!base.skipStealMaster,
        badOnlyMaster: src.badOnlyMaster !== undefined ? !!src.badOnlyMaster : !!base.badOnlyMaster,
    };
}

// ============ 协议解析 ============

function toNumber(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string') return Number(value) || 0;
    if (typeof value.toNumber === 'function') return value.toNumber();
    if (typeof value.low === 'number' && typeof value.high === 'number') {
        return value.high * 4294967296 + (value.low >>> 0);
    }
    return Number(value) || 0;
}

function toTimeSecLocal(value: any): number {
    const n = toNumber(value);
    if (n <= 0) return 0;
    return n > 1e12 ? Math.floor(n / 1000) : n;
}

function toBytes(value: any): Uint8Array | null {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return Uint8Array.from(value.map((v: any) => Number(v) & 0xFF));
    if (typeof value === 'string') {
        try { return Uint8Array.from(Buffer.from(value, 'base64')); } catch { return null; }
    }
    return null;
}

/** 读一个 varint，返回 [值, 下一个位置]；格式错误返回 null。 */
function readVarint(bytes: Uint8Array, start: number): [number, number] | null {
    let result = 0;
    let multiplier = 1;
    for (let i = start; i < bytes.length && i < start + 10; i++) {
        const b = bytes[i];
        result += (b & 0x7F) * multiplier;
        if ((b & 0x80) === 0) return [result, i + 1];
        multiplier *= 128;
    }
    return null;
}

function decodePackedVarints(bytes: Uint8Array): number[] | null {
    const out: number[] = [];
    let pos = 0;
    while (pos < bytes.length) {
        const r = readVarint(bytes, pos);
        if (!r) return null;
        out.push(r[0]);
        pos = r[1];
    }
    return out;
}

/** 旧版格式：StealPlayer { int64 gid = 1; int64 num = 2; }（一条或多条拼接） */
function decodeStealPlayerMessages(bytes: Uint8Array): number[] | null {
    const out: number[] = [];
    let pos = 0;
    while (pos < bytes.length) {
        const tag = readVarint(bytes, pos);
        if (!tag) return null;
        const field = Math.floor(tag[0] / 8);
        const wire = tag[0] % 8;
        pos = tag[1];
        if (wire === 0) {
            const v = readVarint(bytes, pos);
            if (!v) return null;
            if (field === 1) out.push(v[0]);
            pos = v[1];
        } else if (wire === 2) {
            const len = readVarint(bytes, pos);
            if (!len || len[1] + len[0] > bytes.length) return null;
            const inner = decodeStealPlayerMessages(bytes.subarray(len[1], len[1] + len[0]));
            if (inner) out.push(...inner);
            pos = len[1] + len[0];
        } else {
            return null;
        }
    }
    return out;
}

/**
 * 解析 PlantInfo.stealers，返回其中可能的偷菜者 GID（去重、> 0）。
 * 同时按两种已知格式解析并取并集；单纯的小数字（如次数）与真实 GID 不会冲突。
 */
function decodeStealerGids(raw: any): number[] {
    const set = new Set<number>();
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object' && raw[0] !== null && !(raw[0] instanceof Uint8Array)) {
        // 已被解码成对象（如 repeated StealPlayer）
        for (const item of raw) {
            const gid = toNumber(item && (item.gid ?? item));
            if (gid > 0) set.add(gid);
        }
        return [...set];
    }
    if (Array.isArray(raw) && raw.every((v: any) => typeof v !== 'object' || (v && typeof v.toNumber === 'function'))
        && raw.some((v: any) => toNumber(v) > 255)) {
        // 已被解码成 repeated int64
        for (const v of raw) {
            const gid = toNumber(v);
            if (gid > 0) set.add(gid);
        }
        return [...set];
    }
    const bytes = toBytes(raw);
    if (!bytes || bytes.length === 0) return [];
    for (const gid of decodePackedVarints(bytes) || []) {
        if (gid > 0) set.add(gid);
    }
    for (const gid of decodeStealPlayerMessages(bytes) || []) {
        if (gid > 0) set.add(gid);
    }
    return [...set];
}

/**
 * 作物进入成熟阶段的时间（秒）：已开始（begin_time ≤ 现在）的「成熟」阶段中最晚的一个；
 * 没有时取最晚的已开始阶段（部分作物服务端只下发剩余阶段，见 land-analysis.getCurrentPhase）。
 */
function getMatureBeginSec(plant: any, nowSec: number): number {
    const phases: any[] = Array.isArray(plant && plant.phases) ? plant.phases : [];
    let mature = 0;
    let latestStarted = 0;
    for (const phase of phases) {
        const begin = toTimeSecLocal(phase && phase.begin_time);
        if (begin <= 0 || begin > nowSec) continue;
        if (toNumber(phase.phase) === MATURE_PHASE && begin > mature) mature = begin;
        if (begin > latestStarted) latestStarted = begin;
    }
    return mature || latestStarted;
}

// ============ 判定 ============

export interface AltHarvestRecord {
    actionType: number;
    visitorGid: number;
    serverTimeSec: number;
    landId?: number;
    cropId?: number;
}

export interface AltHarvestDecision {
    landId: number;
    plantName: string;
    harvest: boolean;
    /** stolen_by_master | timeout | waiting | not_configured */
    reason: string;
    /** 判定来源说明（日志用） */
    detail: string;
    matureBeginSec: number;
    /** 从本进程首次发现可收到现在的秒数（超时兜底用） */
    waitedSec: number;
}

function decideAltHarvest(params: {
    lands: any[];
    harvestableIds: number[];
    config: FnosAltAccountConfig;
    records?: AltHarvestRecord[] | null;
    nowSec: number;
    /** landId → 本进程首次发现该地可收的时间（秒）；缺省视为现在（即刚发现，不会超时） */
    firstSeenSecByLand?: Map<number, number> | null;
}): AltHarvestDecision[] {
    const { lands, harvestableIds, config, nowSec } = params;
    const firstSeenMap = params.firstSeenSecByLand || null;
    const records = Array.isArray(params.records) ? params.records : [];
    const landMap = new Map<number, any>();
    for (const land of Array.isArray(lands) ? lands : []) {
        const id = toNumber(land && land.id);
        if (id > 0) landMap.set(id, land);
    }
    const masterGid = toNumber(config && config.masterGid);
    const masterSteals = records.filter(r => r
        && toNumber(r.actionType) === STEAL_ACTION_TYPE
        && toNumber(r.visitorGid) === masterGid);

    return (Array.isArray(harvestableIds) ? harvestableIds : []).map((rawId) => {
        const landId = toNumber(rawId);
        const land = landMap.get(landId);
        const plant = land && land.plant;
        const plantName = String((plant && plant.name) || '').trim() || '作物';
        const matureBeginSec = plant ? getMatureBeginSec(plant, nowSec) : 0;
        const firstSeenSec = (firstSeenMap && firstSeenMap.get(landId)) || nowSec;
        const waitedSec = Math.max(0, nowSec - firstSeenSec);
        const base = { landId, plantName, matureBeginSec, waitedSec };

        if (!config || !config.enabled || masterGid <= 0) {
            return { ...base, harvest: true, reason: 'not_configured', detail: '未设置大号' };
        }

        const stealers = plant ? decodeStealerGids(plant.stealers) : [];
        if (stealers.includes(masterGid)) {
            return { ...base, harvest: true, reason: 'stolen_by_master', detail: '土地偷菜者列表中有大号' };
        }

        const plantId = toNumber(plant && plant.id);
        const fruitId = toNumber(plant && plant.fruit_id);
        // 只认这一茬作物成熟之后的偷菜记录；取不到成熟时间时退而用首次发现可收的时间，
        // 不能放宽到 0，否则大号很久以前偷过这块地的旧记录也会被当成“已偷”。
        const minTime = (matureBeginSec > 0 ? Math.min(matureBeginSec, firstSeenSec) : firstSeenSec) - RECORD_TIME_TOLERANCE_SEC;
        const matched = masterSteals.find((r) => {
            if (toNumber(r.serverTimeSec) < minTime) return false;
            const recordLandId = toNumber(r.landId);
            if (recordLandId > 0) return recordLandId === landId;
            const cropId = toNumber(r.cropId);
            return cropId > 0 && (cropId === plantId || cropId === fruitId);
        });
        if (matched) {
            return {
                ...base,
                harvest: true,
                reason: 'stolen_by_master',
                detail: toNumber(matched.landId) > 0 ? '访客记录：大号偷了这块地' : '访客记录：大号偷了同种作物',
            };
        }

        const timeoutSec = Math.max(0, toNumber(config.timeoutMinutes)) * 60;
        if (timeoutSec > 0 && waitedSec >= timeoutSec) {
            return { ...base, harvest: true, reason: 'timeout', detail: `发现可收已超过 ${config.timeoutMinutes} 分钟，大号仍未偷（超时兜底）` };
        }
        return { ...base, harvest: false, reason: 'waiting', detail: '等待大号来偷' };
    });
}

// ============ 运行时挂钩（worker 内使用） ============

const RECORDS_CACHE_MS = 60 * 1000;
const WAIT_LOG_INTERVAL_MS = 10 * 60 * 1000;
let recordsCache: { at: number; records: AltHarvestRecord[] } | null = null;
let lastWaitLogKey = '';
let lastWaitLogAt = 0;
let lastNotConfiguredLogAt = 0;
/** landId → { 作物 id, 本进程首次发现可收的时间（秒） } */
const firstSeenByLand = new Map<number, { plantId: number; sec: number }>();

function resetFnosAltAccountRuntime(): void {
    recordsCache = null;
    firstSeenByLand.clear();
    lastWaitLogKey = '';
    lastWaitLogAt = 0;
    lastNotConfiguredLogAt = 0;
}

async function loadMasterStealRecords(): Promise<{ records: AltHarvestRecord[]; error: string }> {
    const now = Date.now();
    if (recordsCache && now - recordsCache.at < RECORDS_CACHE_MS) return { records: recordsCache.records, error: '' };
    try {
        const list = await require('../interact').getInteractRecords('low');
        const records: AltHarvestRecord[] = (Array.isArray(list) ? list : []).map((r: any) => ({
            actionType: toNumber(r && r.actionType),
            visitorGid: toNumber(r && r.visitorGid),
            serverTimeSec: toNumber(r && r.serverTimeSec),
            landId: toNumber(r && r.landId),
            cropId: toNumber(r && r.cropId),
        }));
        recordsCache = { at: now, records };
        return { records, error: '' };
    } catch (e: any) {
        return { records: recordsCache ? recordsCache.records : [], error: String(e && e.message ? e.message : e) };
    }
}

function getConfigForCurrentAccount(): FnosAltAccountConfig {
    // 2026.10.20.3：统一经 store.getConfigSnapshot() 读取（见 services/fnos-fork-config.ts）
    return require('../fnos-fork-config').readFnosForkConfigs().alt;
}

/** 更新「首次发现可收」时间表：不再可收或换了作物的地清掉，新发现的记下现在。 */
function updateFirstSeen(lands: any[], harvestableIds: number[], nowSec: number): Map<number, number> {
    const harvestable = new Set(harvestableIds.map(toNumber));
    const plantIdByLand = new Map<number, number>();
    for (const land of Array.isArray(lands) ? lands : []) {
        const id = toNumber(land && land.id);
        if (id > 0) plantIdByLand.set(id, toNumber(land.plant && land.plant.id));
    }
    for (const [landId, entry] of [...firstSeenByLand]) {
        if (!harvestable.has(landId) || (plantIdByLand.has(landId) && plantIdByLand.get(landId) !== entry.plantId)) {
            firstSeenByLand.delete(landId);
        }
    }
    const out = new Map<number, number>();
    for (const landId of harvestable) {
        let entry = firstSeenByLand.get(landId);
        if (!entry) {
            entry = { plantId: plantIdByLand.get(landId) || 0, sec: nowSec };
            firstSeenByLand.set(landId, entry);
        }
        out.set(landId, entry.sec);
    }
    return out;
}

function formatMinutes(sec: number): string {
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟`;
    return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}

/**
 * 自动巡田收获前调用。非小号直接原样返回（filtered=false）。
 * filtered=true 时调用方应只收 landIds，且不能用“全部收获”(is_all)。
 */
async function filterHarvestForAltAccount(
    lands: any[],
    harvestableIds: number[],
    options: { nowSec?: number; source?: string } = {},
): Promise<{ landIds: number[]; filtered: boolean; held: AltHarvestDecision[] }> {
    const ids = Array.isArray(harvestableIds) ? [...harvestableIds] : [];
    const config = getConfigForCurrentAccount();
    if (!config.enabled) {
        firstSeenByLand.clear();
        return { landIds: ids, filtered: false, held: [] };
    }

    const { log, logWarn, getServerTimeSec } = require('../../utils/utils');
    if (config.masterGid <= 0) {
        if (Date.now() - lastNotConfiguredLogAt > WAIT_LOG_INTERVAL_MS) {
            lastNotConfiguredLogAt = Date.now();
            logWarn('小号', '已开启「这是小号」但还没有选择大号，本次照常收获。请到 设置 → 活动设置 选择大号', {
                module: 'farm', event: '小号留菜', result: 'not_configured',
            });
        }
        return { landIds: ids, filtered: false, held: [] };
    }

    const nowSec = options.nowSec || getServerTimeSec();
    const firstSeenSecByLand = updateFirstSeen(lands, ids, nowSec);
    if (ids.length === 0) return { landIds: ids, filtered: false, held: [] };
    // 先只看土地数据：都已被大号偷过就不必再拉访客记录。
    let decisions = decideAltHarvest({ lands, harvestableIds: ids, config, records: [], nowSec, firstSeenSecByLand });
    let recordError = '';
    if (decisions.some(d => !d.harvest)) {
        const loaded = await loadMasterStealRecords();
        recordError = loaded.error;
        decisions = decideAltHarvest({ lands, harvestableIds: ids, config, records: loaded.records, nowSec, firstSeenSecByLand });
    }

    const allowed = decisions.filter(d => d.harvest);
    const held = decisions.filter(d => !d.harvest);
    const masterLabel = config.masterName ? `${config.masterName}(${config.masterGid})` : `GID ${config.masterGid}`;

    for (const d of allowed) {
        log('小号', `土地#${d.landId}(${d.plantName}) 可以收获：${d.detail}`, {
            module: 'farm', event: '小号留菜', result: d.reason, landId: d.landId, masterGid: config.masterGid,
        });
    }
    if (held.length > 0) {
        const key = held.map(d => d.landId).sort((a, b) => a - b).join(',');
        const now = Date.now();
        if (key !== lastWaitLogKey || now - lastWaitLogAt > WAIT_LOG_INTERVAL_MS) {
            lastWaitLogKey = key;
            lastWaitLogAt = now;
            const parts = held.map(d => `#${d.landId}${d.plantName}(已等${formatMinutes(d.waitedSec)})`);
            const timeoutText = config.timeoutMinutes > 0 ? `，发现可收后超过 ${config.timeoutMinutes} 分钟仍未偷则照常收获` : '，一直等到大号偷过为止';
            log('小号', `留给大号 ${masterLabel} 偷，暂不收获 ${held.length} 块：${parts.join('、')}（未在土地偷菜者和访客记录里发现大号${timeoutText}）${recordError ? `；访客记录读取失败：${recordError}` : ''}`, {
                module: 'farm', event: '小号留菜', result: 'waiting', count: held.length, landIds: held.map(d => d.landId), masterGid: config.masterGid,
            });
        }
    } else {
        lastWaitLogKey = '';
    }

    return { landIds: allowed.map(d => d.landId), filtered: held.length > 0, held };
}

/** 只收部分地块时逐块收获（is_all=false），返回合并回包与成功地块。 */
async function harvestSelectedLands(landIds: number[]): Promise<{ reply: any; harvested: number[] }> {
    const { harvest } = require('./api');
    const { logWarn, randomDelay } = require('../../utils/utils');
    let reply: any = null;
    const harvested: number[] = [];
    let lastError: any = null;
    for (const landId of landIds) {
        try {
            const r = await harvest([landId], { isAll: false });
            if (!reply) reply = { land: [] };
            if (r && Array.isArray(r.land)) reply.land.push(...r.land);
            harvested.push(landId);
        } catch (e: any) {
            lastError = e;
            logWarn('小号', `土地#${landId} 收获失败: ${e.message}`);
        }
        if (landIds.length > 1) await randomDelay(300, 600);
    }
    if (harvested.length === 0 && lastError) throw lastError;
    return { reply, harvested };
}

module.exports = {
    harvestSelectedLands,
    DEFAULT_FNOS_ALT_ACCOUNT,
    normalizeFnosAltAccount,
    decodeStealerGids,
    getMatureBeginSec,
    decideAltHarvest,
    filterHarvestForAltAccount,
    resetFnosAltAccountRuntime,
};
