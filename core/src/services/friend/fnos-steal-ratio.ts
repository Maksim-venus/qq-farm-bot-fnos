export {};
/**
 * [fnos-fork] 偷收比（2026-10-31）
 *
 * 公式与好友卡片「收偷比」相同，用的是生涯接口 CareerInfoGet 的
 * total_steal_count / total_harvest_count：
 *   偷收比 = 生涯偷菜 ÷ 生涯收获 × 100%
 * 「超过阈值」是严格大于（默认 80%，80.0% 不触发）。
 * 生涯收获为 0 且生涯偷菜 > 0 视为超过任意阈值（只偷不收）；两者都是 0 视为 0%，不触发。
 * 这是该玩家的生涯总偷菜 / 总收获，不是「只统计偷我的数量」。
 *
 * 四项开关互相独立，默认全关，共用一个阈值：
 *   ignoreApplications  偷收比超过阈值的好友申请，走 RejectFriends 拒绝（不接受）
 *   listFilter          好友页显示偷收比筛选（筛选本身在前端）
 *   barkOnSteal         偷收比超过阈值的人来偷本账号的菜时，用下线提醒里的 Bark 渠道推送
 *   autoDelete          自动删除偷收比超过阈值的好友；大小号协作里的大号 GID、
 *                       以及已记录到的小号 GID 一律不删
 *
 * 小号 GID 记在 data/fnos-account-gids.json（账号登录后写入）。还没登录过这一版的小号，
 * 暂时无法从账号列表认出其 GID，因此不会被排除。Bark 水位和节流记在
 * data/fnos-steal-ratio/<账号>.json，避免重启后把历史访客再推一遍。
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../json-db');

const DEFAULT_THRESHOLD_PERCENT = 80;
const MIN_THRESHOLD_PERCENT = 1;
// [fnos-fork] 偷收比可以超过 100%（偷菜次数多于收获），阈值上限放宽到 100000%
const MAX_THRESHOLD_PERCENT = 100000;
const CHECK_INTERVAL_MS = 3 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 20 * 1000;
const DELETE_INTERVAL_MS = 10 * 60 * 1000;
const BARK_THROTTLE_MS = 30 * 60 * 1000;
const RATIO_CACHE_MS = 60 * 60 * 1000;
const MAX_LOOKUPS_PER_DELETE_TICK = 8;
const MAX_DELETES_PER_TICK = 1;
const LOOKUP_BATCH_LIMIT = 12;
const CAREER_GAP_MS = 150;

export interface FnosStealRatioConfig {
    /** 共用阈值（百分比，严格大于才触发），默认 80 */
    thresholdPercent: number;
    /** 偷收比超过阈值的好友申请直接拒绝 */
    ignoreApplications: boolean;
    /** 好友页显示偷收比筛选 */
    listFilter: boolean;
    /** 高偷收比好友来偷菜时发 Bark */
    barkOnSteal: boolean;
    /** 自动删除高偷收比好友（排除大小号协作关联号） */
    autoDelete: boolean;
}

const DEFAULT_FNOS_STEAL_RATIO: FnosStealRatioConfig = {
    thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
    ignoreApplications: false,
    listFilter: false,
    barkOnSteal: false,
    autoDelete: false,
};

export interface StealRatioInfo {
    percent: number;
    infinite: boolean;
    text: string;
}

export interface AltRelationSnapshot {
    accountId: string;
    selfGid: number;
    enabled: boolean;
    masterGid: number;
}

function normalizeFnosStealRatio(input: unknown, fallback: FnosStealRatioConfig = DEFAULT_FNOS_STEAL_RATIO): FnosStealRatioConfig {
    const base = { ...DEFAULT_FNOS_STEAL_RATIO, ...(fallback || {}) };
    const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, any> : {};
    const raw = src.thresholdPercent !== undefined ? Number(src.thresholdPercent) : base.thresholdPercent;
    const rounded = Number.isFinite(raw) ? Math.round(raw) : DEFAULT_THRESHOLD_PERCENT;
    const thresholdPercent = rounded >= MIN_THRESHOLD_PERCENT && rounded <= MAX_THRESHOLD_PERCENT
        ? rounded
        : (base.thresholdPercent || DEFAULT_THRESHOLD_PERCENT);
    const flag = (key: keyof FnosStealRatioConfig) => (src[key] !== undefined ? !!src[key] : !!base[key]);
    return {
        thresholdPercent,
        ignoreApplications: flag('ignoreApplications'),
        listFilter: flag('listFilter'),
        barkOnSteal: flag('barkOnSteal'),
        autoDelete: flag('autoDelete'),
    };
}

function readFnosStealRatio(accountId?: string): FnosStealRatioConfig {
    try {
        const store = require('../../models/store');
        const id = accountId || process.env.FARM_ACCOUNT_ID;
        const snapshot = store.getConfigSnapshot(id) || {};
        return normalizeFnosStealRatio(snapshot.fnosStealRatio);
    } catch {
        return normalizeFnosStealRatio(undefined);
    }
}

/** 生涯偷菜 / 生涯收获。harvest、steal 都按非负整数理解。 */
function stealRatioInfo(harvest: unknown, steal: unknown): StealRatioInfo {
    const h = Math.max(0, Math.floor(Number(harvest) || 0));
    const s = Math.max(0, Math.floor(Number(steal) || 0));
    if (h <= 0 && s <= 0) return { percent: 0, infinite: false, text: '0%' };
    if (h <= 0) return { percent: Number.POSITIVE_INFINITY, infinite: true, text: '只偷不收' };
    const percent = s / h * 100;
    return { percent, infinite: false, text: `${percent.toFixed(1).replace(/\.0$/, '')}%` };
}

function isStealRatioAbove(harvest: unknown, steal: unknown, thresholdPercent: unknown): boolean {
    const info = stealRatioInfo(harvest, steal);
    const threshold = Number(thresholdPercent);
    if (!Number.isFinite(threshold)) return false;
    if (info.infinite) return true;
    return info.percent > threshold;
}

function formatStealRatioReason(harvest: unknown, steal: unknown, thresholdPercent: number): string {
    const info = stealRatioInfo(harvest, steal);
    const h = Math.max(0, Math.floor(Number(harvest) || 0));
    const s = Math.max(0, Math.floor(Number(steal) || 0));
    return `偷收比 ${info.text}（生涯偷菜 ${s} / 生涯收获 ${h}）超过 ${thresholdPercent}%`;
}

/**
 * 好友申请：只在开关打开且偷收比超过阈值时拒绝。
 * 生涯查不到时返回 skip，调用方保持申请挂起，不接受也不拒绝。
 */
function decideStealRatioApplication(
    harvest: unknown,
    steal: unknown,
    thresholdPercent: number,
    enabled: boolean,
): { action: 'reject' | 'pass' | 'skip'; reason?: string } {
    if (!enabled) return { action: 'pass' };
    if (!isStealRatioAbove(harvest, steal, thresholdPercent)) return { action: 'pass' };
    return { action: 'reject', reason: formatStealRatioReason(harvest, steal, thresholdPercent) };
}

/**
 * 大小号协作关联号：所有账号配置里的大号 GID，以及「这是小号或填了大号」的账号自身 GID。
 * extraGids 用来塞本账号自己的 GID，避免删到自己。
 */
function collectProtectedGids(snaps: AltRelationSnapshot[], extraGids: number[] = []): number[] {
    const set = new Set<number>();
    for (const gid of extraGids) {
        const n = Math.floor(Number(gid) || 0);
        if (n > 0) set.add(n);
    }
    for (const snap of Array.isArray(snaps) ? snaps : []) {
        const master = Math.floor(Number(snap && snap.masterGid) || 0);
        if (master > 0) set.add(master);
        const self = Math.floor(Number(snap && snap.selfGid) || 0);
        const related = !!(snap && (snap.enabled || snap.masterGid > 0));
        if (related && self > 0) set.add(self);
    }
    return [...set];
}

interface FriendRef { gid: number; name?: string }
interface RatioSample { harvest: number; steal: number }

function planStealRatioDeletions(input: {
    friends: FriendRef[];
    ratios: Record<string, RatioSample | null | undefined>;
    thresholdPercent: number;
    protectedGids: number[];
    maxDeletes?: number;
}): Array<{ gid: number; name: string; harvest: number; steal: number; reason: string }> {
    const maxDeletes = Math.max(0, Number(input.maxDeletes ?? MAX_DELETES_PER_TICK) || 0);
    const protectedSet = new Set((input.protectedGids || []).map(gid => Math.floor(Number(gid) || 0)).filter(gid => gid > 0));
    const planned: Array<{ gid: number; name: string; harvest: number; steal: number; reason: string }> = [];
    for (const friend of Array.isArray(input.friends) ? input.friends : []) {
        if (planned.length >= maxDeletes) break;
        const gid = Math.floor(Number(friend && friend.gid) || 0);
        if (!gid || protectedSet.has(gid)) continue;
        const sample = input.ratios ? input.ratios[String(gid)] : null;
        if (!sample) continue;
        if (!isStealRatioAbove(sample.harvest, sample.steal, input.thresholdPercent)) continue;
        const name = String(friend.name || '').trim() || `GID:${gid}`;
        planned.push({
            gid,
            name,
            harvest: Math.max(0, Math.floor(Number(sample.harvest) || 0)),
            steal: Math.max(0, Math.floor(Number(sample.steal) || 0)),
            reason: formatStealRatioReason(sample.harvest, sample.steal, input.thresholdPercent),
        });
    }
    return planned;
}

interface StealRecord {
    visitorGid: number;
    serverTimeSec: number;
    nick?: string;
    actionDetail?: string;
    actionType?: number;
}

/**
 * 从访客记录里挑出「新的偷菜、且该发 Bark」的人。
 * 尚未建立水位时只记录当前最新时间，不推历史记录。
 * 生涯未知（unknown）的记录不推进水位，下一轮再试。
 * 同一人在 throttleMs 内只保留一条。
 */
function planStealAlerts(input: {
    records: StealRecord[];
    watermarkSec: number;
    initialized: boolean;
    ratios: Record<string, RatioSample | null | undefined>;
    unknownGids?: number[];
    thresholdPercent: number;
    notifiedAt: Record<string, number>;
    nowMs: number;
    throttleMs?: number;
}): {
    alerts: Array<{ gid: number; name: string; detail: string; reason: string; serverTimeSec: number }>;
    watermarkSec: number;
    initialized: boolean;
    notifiedAt: Record<string, number>;
} {
    const throttleMs = Math.max(0, Number(input.throttleMs ?? BARK_THROTTLE_MS) || 0);
    const steals = (Array.isArray(input.records) ? input.records : [])
        .filter(record => Number(record && record.actionType) === 1 && Math.floor(Number(record.visitorGid) || 0) > 0)
        .slice()
        .sort((a, b) => (Number(a.serverTimeSec) || 0) - (Number(b.serverTimeSec) || 0) || (Number(a.visitorGid) - Number(b.visitorGid)));
    if (!input.initialized) {
        const maxT = steals.reduce((max, record) => Math.max(max, Math.floor(Number(record.serverTimeSec) || 0)), 0);
        return { alerts: [], watermarkSec: maxT, initialized: true, notifiedAt: { ...(input.notifiedAt || {}) } };
    }
    const unknown = new Set((input.unknownGids || []).map(gid => Math.floor(Number(gid) || 0)));
    const notifiedAt = { ...(input.notifiedAt || {}) };
    const alerts: Array<{ gid: number; name: string; detail: string; reason: string; serverTimeSec: number }> = [];
    const alerted = new Set<number>();
    let watermarkSec = Math.max(0, Math.floor(Number(input.watermarkSec) || 0));
    for (const record of steals) {
        const at = Math.floor(Number(record.serverTimeSec) || 0);
        if (at <= watermarkSec) continue;
        const gid = Math.floor(Number(record.visitorGid) || 0);
        if (unknown.has(gid)) break;
        const last = Math.floor(Number(notifiedAt[String(gid)]) || 0);
        const throttled = last > 0 && input.nowMs - last < throttleMs;
        const sample = input.ratios ? input.ratios[String(gid)] : null;
        if (!throttled && sample && isStealRatioAbove(sample.harvest, sample.steal, input.thresholdPercent) && !alerted.has(gid)) {
            const name = String(record.nick || '').trim() || `GID:${gid}`;
            alerts.push({
                gid,
                name,
                detail: String(record.actionDetail || '偷取作物'),
                reason: formatStealRatioReason(sample.harvest, sample.steal, input.thresholdPercent),
                serverTimeSec: at,
            });
            notifiedAt[String(gid)] = input.nowMs;
            alerted.add(gid);
        }
        watermarkSec = at;
    }
    return { alerts, watermarkSec, initialized: true, notifiedAt };
}

function accountConfigDir(): string {
    return path.join(path.dirname(getDataFile('store.json')), 'account-configs');
}

function accountFilename(id: string): string {
    const text = String(id || '');
    return /^\d+$/.test(text) ? `${text}.json` : `id-${Buffer.from(text, 'utf8').toString('hex')}.json`;
}

function accountIdFromFilename(filename: string): string {
    const name = filename.slice(0, -5);
    if (/^\d+$/.test(name)) return name;
    if (/^id-(?:[0-9a-f]{2})+$/.test(name)) return Buffer.from(name.slice(3), 'hex').toString('utf8');
    throw new Error('invalid account filename');
}

function selfGidFile(): string {
    return getDataFile('fnos-account-gids.json');
}

function readSelfGidMap(): Record<string, number> {
    const data = readJsonFile(selfGidFile(), () => ({}));
    const out: Record<string, number> = {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
    for (const [id, gid] of Object.entries(data)) {
        const n = Math.floor(Number(gid) || 0);
        if (id && n > 0) out[String(id)] = n;
    }
    return out;
}

function writeSelfGid(accountId: string, gid: number): void {
    const id = String(accountId || '').trim();
    const n = Math.floor(Number(gid) || 0);
    if (!id || n <= 0) return;
    const current = readSelfGidMap();
    if (current[id] === n) return;
    current[id] = n;
    writeJsonFileAtomic(selfGidFile(), current);
}

function rememberSelfGid(): void {
    try {
        const { getUserState } = require('../../utils/network');
        const gid = Math.floor(Number((getUserState() || {}).gid) || 0);
        const accountId = String(process.env.FARM_ACCOUNT_ID || '').trim();
        if (gid > 0 && accountId) writeSelfGid(accountId, gid);
    } catch {
        // 登录前没有 GID，下一轮再记
    }
}

function listAccountIds(): string[] {
    const ids = new Set<string>();
    try {
        const accounts = require('../../models/store').getAccounts().accounts || [];
        for (const account of accounts) {
            const id = String(account && account.id || '').trim();
            if (id) ids.add(id);
        }
    } catch { /* 账号列表读不到时仍扫描配置目录 */ }
    try {
        const dir = accountConfigDir();
        if (fs.existsSync(dir)) {
            for (const name of fs.readdirSync(dir)) {
                if (!name.endsWith('.json') || name === '.format.json') continue;
                try { ids.add(accountIdFromFilename(name)); } catch { /* 跳过无法识别的文件 */ }
            }
        }
    } catch { /* ignore */ }
    return [...ids];
}

function readAccountAlt(accountId: string): { enabled: boolean; masterGid: number } {
    const currentId = String(process.env.FARM_ACCOUNT_ID || '');
    let raw: any = null;
    if (accountId && accountId === currentId) {
        try { raw = require('../../models/store').getConfigSnapshot(accountId); } catch { raw = null; }
    }
    if (!raw) {
        try {
            const file = path.join(accountConfigDir(), accountFilename(accountId));
            if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch { raw = null; }
    }
    try {
        const { normalizeFnosAltAccount } = require('../farm/fnos-alt-account');
        const alt = normalizeFnosAltAccount(raw && raw.fnosAltAccount);
        return { enabled: !!alt.enabled, masterGid: Math.floor(Number(alt.masterGid) || 0) };
    } catch {
        const alt = raw && raw.fnosAltAccount;
        return {
            enabled: !!(alt && alt.enabled),
            masterGid: Math.floor(Number(alt && alt.masterGid) || 0),
        };
    }
}

function loadAltRelationSnapshots(): AltRelationSnapshot[] {
    const gids = readSelfGidMap();
    return listAccountIds().map(accountId => {
        const alt = readAccountAlt(accountId);
        return { accountId, selfGid: gids[accountId] || 0, enabled: alt.enabled, masterGid: alt.masterGid };
    });
}

function readProtectedGidList(): number[] {
    const self = currentSelfGid();
    return collectProtectedGids(loadAltRelationSnapshots(), self > 0 ? [self] : []);
}

function currentSelfGid(): number {
    try {
        const { getUserState } = require('../../utils/network');
        return Math.floor(Number((getUserState() || {}).gid) || 0);
    } catch {
        return 0;
    }
}

function stateFile(accountId: string): string {
    const safe = String(accountId || 'default').replace(/[^\w-]/g, '_');
    return getDataFile(path.join('fnos-steal-ratio', `${safe}.json`));
}

function readBarkState(accountId: string): { watermarkSec: number; initialized: boolean; notifiedAt: Record<string, number> } {
    const data = readJsonFile(stateFile(accountId), () => ({}));
    const notifiedAt: Record<string, number> = {};
    const raw = data && data.notifiedAt;
    if (raw && typeof raw === 'object') {
        for (const [gid, at] of Object.entries(raw)) {
            const n = Math.floor(Number(at) || 0);
            if (n > 0) notifiedAt[String(gid)] = n;
        }
    }
    return {
        watermarkSec: Math.max(0, Math.floor(Number(data && data.watermarkSec) || 0)),
        initialized: !!(data && data.initialized),
        notifiedAt,
    };
}

function writeBarkState(accountId: string, state: { watermarkSec: number; initialized: boolean; notifiedAt: Record<string, number> }): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const notifiedAt: Record<string, number> = {};
    for (const [gid, at] of Object.entries(state.notifiedAt || {})) {
        if (Number(at) >= cutoff) notifiedAt[gid] = Number(at);
    }
    writeJsonFileAtomic(stateFile(accountId), {
        watermarkSec: state.watermarkSec,
        initialized: !!state.initialized,
        notifiedAt,
    });
}

const ratioCache = new Map<number, { harvest: number; steal: number; at: number }>();
let deleteCursor = 0;
let nextDeleteAt = 0;
let pendingDelete: { gid: number; name: string; reason: string } | null = null;
let barkChannelWarnedAt = 0;
let activeScheduler: any = null;
let activeTick: (() => Promise<any>) | null = null;

function resetFnosStealRatioRuntime(): void {
    ratioCache.clear();
    deleteCursor = 0;
    nextDeleteAt = 0;
    pendingDelete = null;
}

async function lookupStealRatios(gids: unknown): Promise<Array<{ gid: number; harvest: number; steal: number; percent: number | null; infinite: boolean; text: string }>> {
    const { getCareerInfo } = require('../career');
    const { sleep } = require('../../utils/utils');
    const list: number[] = [];
    for (const gid of Array.isArray(gids) ? gids : []) {
        const n = Math.floor(Number(gid) || 0);
        if (n > 0 && !list.includes(n)) list.push(n);
        if (list.length >= LOOKUP_BATCH_LIMIT) break;
    }
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const gid = list[i];
        const career = await getCareerInfo(gid);
        const info = stealRatioInfo(career.harvest, career.steal);
        ratioCache.set(gid, {
            harvest: Math.max(0, Math.floor(Number(career.harvest) || 0)),
            steal: Math.max(0, Math.floor(Number(career.steal) || 0)),
            at: Date.now(),
        });
        out.push({
            gid,
            harvest: Math.max(0, Math.floor(Number(career.harvest) || 0)),
            steal: Math.max(0, Math.floor(Number(career.steal) || 0)),
            percent: info.infinite ? null : info.percent,
            infinite: info.infinite,
            text: info.text,
        });
        if (i < list.length - 1) await sleep(CAREER_GAP_MS);
    }
    return out;
}

async function runAutoDelete(cfg: FnosStealRatioConfig): Promise<void> {
    if (!cfg.autoDelete) return;
    const now = Date.now();
    const { getFriendsList, deleteFriend } = require('./visit-strategy');
    const { getCareerInfo } = require('../career');
    const { log, logWarn, sleep } = require('../../utils/utils');
    const friends: FriendRef[] = (await getFriendsList(false, 'low')) || [];
    const ordered = friends
        .map(friend => ({ gid: Math.floor(Number(friend && (friend as any).gid) || 0), name: String((friend as any).name || '') }))
        .filter(friend => friend.gid > 0)
        .sort((a, b) => a.gid - b.gid);
    if (ordered.length === 0) return;
    const protectedGids = readProtectedGidList();
    const protectedSet = new Set(protectedGids);
    const ratios: Record<string, RatioSample> = {};
    let lookups = 0;
    let considered = 0;
    for (let n = 0; n < ordered.length && lookups < MAX_LOOKUPS_PER_DELETE_TICK; n++) {
        const friend = ordered[(deleteCursor + n) % ordered.length];
        considered++;
        if (protectedSet.has(friend.gid)) continue;
        const cached = ratioCache.get(friend.gid);
        if (cached && now - cached.at < RATIO_CACHE_MS) {
            ratios[String(friend.gid)] = { harvest: cached.harvest, steal: cached.steal };
            continue;
        }
        lookups++;
        try {
            const career = await getCareerInfo(friend.gid);
            const sample = { harvest: Math.max(0, Math.floor(Number(career.harvest) || 0)), steal: Math.max(0, Math.floor(Number(career.steal) || 0)) };
            ratioCache.set(friend.gid, { ...sample, at: Date.now() });
            ratios[String(friend.gid)] = sample;
        } catch (e: any) {
            logWarn('偷收比', `${friend.name || `GID:${friend.gid}`} 生涯查询失败，本轮不删除：${e && e.message ? e.message : e}`, {
                module: 'friend', event: '偷收比删除', result: 'error', friendGid: friend.gid,
            });
        }
        if (lookups < MAX_LOOKUPS_PER_DELETE_TICK) await sleep(CAREER_GAP_MS);
    }
    deleteCursor = ordered.length ? (deleteCursor + considered) % ordered.length : 0;
    const planned = planStealRatioDeletions({
        friends: ordered,
        ratios,
        thresholdPercent: cfg.thresholdPercent,
        protectedGids,
        maxDeletes: MAX_DELETES_PER_TICK,
    });
    if (pendingDelete) {
        const queued = pendingDelete;
        const cached = ratioCache.get(queued.gid);
        const stillFriend = ordered.some(friend => friend.gid === queued.gid);
        const stillHigh = !!cached && isStealRatioAbove(cached.harvest, cached.steal, cfg.thresholdPercent);
        if (!stillFriend || !stillHigh || protectedSet.has(queued.gid)) pendingDelete = null;
    }
    if (!pendingDelete && planned[0]) {
        pendingDelete = { gid: planned[0].gid, name: planned[0].name, reason: planned[0].reason };
    }
    const target = pendingDelete;
    if (!target || now < nextDeleteAt) return;
    nextDeleteAt = now + DELETE_INTERVAL_MS;
    pendingDelete = null;
    log('偷收比', `准备删除好友 ${target.name}：${target.reason}`, {
        module: 'friend',
        event: '偷收比删除',
        result: 'pending',
        friendName: target.name,
        friendGid: target.gid,
        thresholdPercent: cfg.thresholdPercent,
    });
    try {
        await deleteFriend(target.gid, target.reason);
    } catch (e: any) {
        logWarn('偷收比', `删除 ${target.name} 失败：${e && e.message ? e.message : e}`, {
            module: 'friend', event: '偷收比删除', result: 'error', friendGid: target.gid, friendName: target.name,
        });
    }
}

async function runBarkOnSteal(cfg: FnosStealRatioConfig): Promise<void> {
    if (!cfg.barkOnSteal) return;
    const { getInteractRecords } = require('../interact');
    const { getCareerInfo } = require('../career');
    const { log, logWarn, sleep } = require('../../utils/utils');
    const accountId = String(process.env.FARM_ACCOUNT_ID || 'default');
    const state = readBarkState(accountId);
    let records: StealRecord[] = [];
    try {
        records = await getInteractRecords('low');
    } catch (e: any) {
        logWarn('偷收比', `读取访客记录失败，本轮不推送：${e && e.message ? e.message : e}`, {
            module: 'friend', event: '偷收比通知', result: 'error',
        });
        return;
    }
    const steals = (records || []).filter(record => Number(record.actionType) === 1);
    if (!state.initialized) {
        const planned = planStealAlerts({
            records: steals,
            watermarkSec: 0,
            initialized: false,
            ratios: {},
            thresholdPercent: cfg.thresholdPercent,
            notifiedAt: state.notifiedAt,
            nowMs: Date.now(),
        });
        writeBarkState(accountId, { watermarkSec: planned.watermarkSec, initialized: true, notifiedAt: planned.notifiedAt });
        log('偷收比', '已记下当前访客记录，之后才推送新的偷菜（不补发历史记录）', {
            module: 'friend', event: '偷收比通知', result: 'ok',
        });
        return;
    }
    const freshGids: number[] = [];
    for (const record of steals) {
        const gid = Math.floor(Number(record.visitorGid) || 0);
        const at = Math.floor(Number(record.serverTimeSec) || 0);
        if (gid > 0 && at > state.watermarkSec && !freshGids.includes(gid)) freshGids.push(gid);
    }
    const ratios: Record<string, RatioSample> = {};
    const unknownGids: number[] = [];
    for (let i = 0; i < freshGids.length; i++) {
        const gid = freshGids[i];
        const cached = ratioCache.get(gid);
        if (cached && Date.now() - cached.at < RATIO_CACHE_MS) {
            ratios[String(gid)] = { harvest: cached.harvest, steal: cached.steal };
            continue;
        }
        try {
            const career = await getCareerInfo(gid);
            const sample = { harvest: Math.max(0, Math.floor(Number(career.harvest) || 0)), steal: Math.max(0, Math.floor(Number(career.steal) || 0)) };
            ratioCache.set(gid, { ...sample, at: Date.now() });
            ratios[String(gid)] = sample;
        } catch {
            unknownGids.push(gid);
        }
        if (i < freshGids.length - 1) await sleep(CAREER_GAP_MS);
    }
    const planned = planStealAlerts({
        records: steals,
        watermarkSec: state.watermarkSec,
        initialized: true,
        ratios,
        unknownGids,
        thresholdPercent: cfg.thresholdPercent,
        notifiedAt: state.notifiedAt,
        nowMs: Date.now(),
    });
    writeBarkState(accountId, { watermarkSec: planned.watermarkSec, initialized: true, notifiedAt: planned.notifiedAt });
    if (planned.alerts.length === 0) return;
    await sendBarkAlerts(planned.alerts);
}

async function sendBarkAlerts(
    alerts: Array<{ gid: number; name: string; detail: string; reason: string }>,
): Promise<void> {
    const { log, logWarn } = require('../../utils/utils');
    const store = require('../../models/store');
    const reminder = store.getOfflineReminder ? store.getOfflineReminder() : null;
    const channel = String(reminder && reminder.channel || '').trim().toLowerCase();
    const token = String(reminder && reminder.token || '').trim();
    if (channel !== 'bark' || !token) {
        if (Date.now() - barkChannelWarnedAt > 60 * 60 * 1000) {
            barkChannelWarnedAt = Date.now();
            logWarn('偷收比', '高偷收比偷菜通知未发送：下线提醒的渠道不是 Bark，或没有填写 Bark Key', {
                module: 'friend', event: '偷收比通知', result: 'skipped',
            });
        }
        return;
    }
    const { sendPushooMessage } = require('../push');
    const { getUserState } = require('../../utils/network');
    const accountName = String((getUserState() || {}).name || '').trim();
    for (const alert of alerts) {
        const title = accountName ? `高偷收比偷菜 ${accountName}` : '高偷收比偷菜';
        const content = `${alert.name}（GID ${alert.gid}）${alert.detail}。${alert.reason}。`;
        try {
            const result = await sendPushooMessage({
                channel: 'bark',
                endpoint: String(reminder.endpoint || ''),
                token,
                secret: String(reminder.secret || ''),
                title,
                content,
                barkCritical: reminder.barkCritical !== false,
            });
            if (result && result.ok) {
                log('偷收比', `已通知：${alert.name} ${alert.reason}`, {
                    module: 'friend', event: '偷收比通知', result: 'ok', friendGid: alert.gid, friendName: alert.name,
                });
            } else {
                logWarn('偷收比', `Bark 发送失败：${result && result.msg ? result.msg : 'unknown'}（${alert.name}）`, {
                    module: 'friend', event: '偷收比通知', result: 'error', friendGid: alert.gid,
                });
            }
        } catch (e: any) {
            logWarn('偷收比', `Bark 发送异常：${e && e.message ? e.message : e}`, {
                module: 'friend', event: '偷收比通知', result: 'error', friendGid: alert.gid,
            });
        }
    }
}

async function runApplicationIgnore(cfg: FnosStealRatioConfig): Promise<void> {
    if (!cfg.ignoreApplications) return;
    try {
        await require('./scheduler').checkFriendApplicationsNow();
    } catch (e: any) {
        try {
            require('../../utils/utils').logWarn('偷收比', `检查好友申请失败：${e && e.message ? e.message : e}`, {
                module: 'friend', event: '偷收比申请', result: 'error',
            });
        } catch { /* ignore */ }
    }
}

async function runFnosStealRatioTick(): Promise<void> {
    rememberSelfGid();
    const cfg = readFnosStealRatio();
    if (!cfg.ignoreApplications && !cfg.barkOnSteal && !cfg.autoDelete) return;
    await runApplicationIgnore(cfg);
    await runBarkOnSteal(cfg);
    await runAutoDelete(cfg);
}

function startFnosStealRatio(scheduler: any, runExclusive: (name: string, fn: () => Promise<any>) => Promise<any>): void {
    resetFnosStealRatioRuntime();
    const tick = () => runExclusive('fnos_steal_ratio', () => runFnosStealRatioTick()).catch((e: any) => {
        try {
            require('../../utils/utils').logWarn('偷收比', `检查出错：${e && e.message ? e.message : e}`, {
                module: 'friend', event: '偷收比', result: 'error',
            });
        } catch { /* ignore */ }
        return null;
    });
    activeScheduler = scheduler;
    activeTick = tick;
    scheduler.setTimeoutTask('fnos_steal_ratio_first', FIRST_TICK_DELAY_MS, tick);
    scheduler.setIntervalTask('fnos_steal_ratio', CHECK_INTERVAL_MS, tick);
}

function onFnosStealRatioConfigChanged(): void {
    if (activeScheduler && activeTick) {
        try { activeScheduler.setTimeoutTask('fnos_steal_ratio_soon', 3000, activeTick); } catch { /* ignore */ }
    }
}

function describeFnosStealRatio(cfg: FnosStealRatioConfig): string {
    const on = cfg.ignoreApplications || cfg.listFilter || cfg.barkOnSteal || cfg.autoDelete;
    if (!on) return '偷收比相关功能未启用';
    const parts: string[] = [];
    if (cfg.ignoreApplications) parts.push('忽略高偷收比好友申请');
    if (cfg.listFilter) parts.push('好友页筛选');
    if (cfg.barkOnSteal) parts.push('高偷收比来偷菜发 Bark');
    if (cfg.autoDelete) parts.push('自动删除高偷收比好友（排除大小号）');
    return `偷收比已启用（阈值 ${cfg.thresholdPercent}%，超过才触发）：${parts.join('、')}`;
}

module.exports = {
    DEFAULT_FNOS_STEAL_RATIO,
    DEFAULT_THRESHOLD_PERCENT,
    CHECK_INTERVAL_MS,
    DELETE_INTERVAL_MS,
    BARK_THROTTLE_MS,
    MAX_DELETES_PER_TICK,
    MAX_LOOKUPS_PER_DELETE_TICK,
    LOOKUP_BATCH_LIMIT,
    normalizeFnosStealRatio,
    readFnosStealRatio,
    stealRatioInfo,
    isStealRatioAbove,
    formatStealRatioReason,
    decideStealRatioApplication,
    collectProtectedGids,
    planStealRatioDeletions,
    planStealAlerts,
    writeSelfGid,
    rememberSelfGid,
    readProtectedGidList,
    lookupStealRatios,
    startFnosStealRatio,
    onFnosStealRatioConfigChanged,
    describeFnosStealRatio,
    resetFnosStealRatioRuntime,
};
