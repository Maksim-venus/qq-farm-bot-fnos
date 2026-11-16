export {};
/**
 * [fnos-fork] 2026-11-17 好友牧场等级：按账号缓存，牧场好友列表按牧场等级排序（没有的按 Lv1）。
 *
 * 等级来源（按优先级）：
 * 1. 好友列表 GameFriend 字段 25（proto 里记为 fnos_ranch_level）：抓包 1116-1/6/7 的 GetAll 回包，
 *    与进入好友牧场 EnterHomestead 回包 basic.big_farm_level（字段 20）逐一对得上（11/3/5/15/15），84 位好友里 82 位带这个字段
 *    （缺的是自己和「小果」），所以平时不用进场，拉好友列表时就顺手更新；
 * 2. 任何进入好友牧场的路径（friends.visit：自动偷 / 清理 / 放蚊子 / 帮生产、手动展开详情、捣乱）拿到 big_farm_level 时更新；
 * 3. 兜底慢读：列表和缓存都没有（或超过 7 天没更新）的好友，由 worker 在完全空闲时每 60–120 秒进 1 位的牧场只读等级再离开。
 *
 * 缓存文件：data/fnos-ranch-friend-levels/<账号>.json，{ version, levels: { gid: { level, at, source } } }。
 */

const path = require('node:path');
const { getDataFile } = require('../../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../json-db');

const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const FAIL_RETRY_MS = 6 * 60 * 60 * 1000;
const READ_MIN_MS = 60_000;
const READ_MAX_MS = 120_000;
const BACKOFF_MAX_MS = 30 * 60_000;

type Entry = { level: number; at: number; source: string };

let cache: { file: string; levels: Record<string, Entry> } | null = null;
const failedUntil = new Map<string, number>();

function num(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value.toNumber === 'function') return value.toNumber();
    return Number(value) || 0;
}

function storeFile(accountId: string = String(process.env.FARM_ACCOUNT_ID || 'default')): string {
    const safe = String(accountId || 'default').replace(/[^\w-]/g, '_');
    return getDataFile(path.join('fnos-ranch-friend-levels', `${safe}.json`));
}

function load(): Record<string, Entry> {
    const file = storeFile();
    if (cache && cache.file === file) return cache.levels;
    const data = readJsonFile(file, () => ({}));
    const levels: Record<string, Entry> = {};
    const raw = data && typeof data.levels === 'object' && data.levels ? data.levels : {};
    for (const [gid, row] of Object.entries(raw) as Array<[string, any]>) {
        const level = Math.floor(num(row && row.level));
        if (/^\d+$/.test(gid) && level > 0) levels[gid] = { level, at: Math.max(0, num(row.at)), source: String(row.source || '') };
    }
    cache = { file, levels };
    return levels;
}

function save(): void {
    if (!cache) return;
    try { writeJsonFileAtomic(cache.file, { version: 1, savedAt: Date.now(), levels: cache.levels }); } catch { /* ignore */ }
}

/** 记一批等级；有变化（等级不同或时间推进超过 1 小时）才写盘。返回写入条数。 */
function recordLevels(rows: Array<{ gid: unknown; level: unknown }>, source: string, nowMs: number = Date.now()): number {
    const levels = load();
    let changed = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        const gid = String(Math.floor(num(row && row.gid)));
        const level = Math.floor(num(row && row.level));
        if (gid === '0' || level <= 0) continue;
        const prev = levels[gid];
        if (prev && prev.level === level && nowMs - prev.at < 60 * 60 * 1000) continue;
        levels[gid] = { level, at: nowMs, source };
        failedUntil.delete(gid);
        changed++;
    }
    if (changed) save();
    return changed;
}

function recordLevel(gid: unknown, level: unknown, source: string): void {
    try { recordLevels([{ gid, level }], source); } catch { /* ignore */ }
}

/** 好友列表回包（cacheFriendsListFromReply 的结果，带 ranchLevel）顺手入缓存。 */
function recordFromFriendList(list: any[]): void {
    try { recordLevels((Array.isArray(list) ? list : []).map(f => ({ gid: f && f.gid, level: f && f.ranchLevel })), 'friend_list'); } catch { /* ignore */ }
}

function getEntry(gid: unknown): Entry | null {
    const row = load()[String(Math.floor(num(gid)))];
    return row || null;
}

/**
 * 纯函数：给好友列表补上牧场等级并排序。列表自带的 ranchLevel 优先，其次缓存，都没有按 Lv1（ranchLevelKnown=false）。
 * 按牧场等级从高到低，同级保持原顺序（稳定排序）。
 */
function decorateAndSort(list: any[], levels: Record<string, Entry>): any[] {
    return (Array.isArray(list) ? list : [])
        .map((friend: any, index: number) => {
            const own = Math.floor(num(friend && friend.ranchLevel));
            const cached = levels[String(friend && friend.gid)];
            const level = own > 0 ? own : (cached ? cached.level : 0);
            return { friend: { ...friend, ranchLevel: level > 0 ? level : 1, ranchLevelKnown: level > 0, ranchLevelAt: own > 0 ? 0 : (cached ? cached.at : 0) }, index };
        })
        .sort((a, b) => (b.friend.ranchLevel - a.friend.ranchLevel) || (a.index - b.index))
        .map(row => row.friend);
}

function decorateFriends(list: any[]): any[] {
    return decorateAndSort(list, load());
}

/**
 * 纯函数：挑下一位需要慢读的好友：列表与缓存都没有等级，或缓存超过 staleMs；跳过失败冷却中的；
 * 农场等级高的优先，同级按列表顺序。没有返回 null。
 */
function pickReadCandidate(list: any[], levels: Record<string, Entry>, nowMs: number, failed: Map<string, number> = new Map(), staleMs: number = STALE_MS): any | null {
    const rows = (Array.isArray(list) ? list : []).map((friend: any, index: number) => ({ friend, index }))
        .filter(({ friend }) => {
            const gid = String(Math.floor(num(friend && friend.gid)));
            if (gid === '0') return false;
            if (Math.floor(num(friend.ranchLevel)) > 0) return false;
            if ((failed.get(gid) || 0) > nowMs) return false;
            const cached = levels[gid];
            return !cached || nowMs - cached.at > staleMs;
        })
        .sort((a, b) => (num(b.friend.level) - num(a.friend.level)) || (a.index - b.index));
    return rows.length ? rows[0].friend : null;
}

function nextReadDelayMs(random: () => number = Math.random): number {
    return READ_MIN_MS + Math.floor(random() * (READ_MAX_MS - READ_MIN_MS + 1));
}

/** 连续失败的全局退避：2、4、8…分钟，最多 30 分钟。 */
function backoffMs(failures: number): number {
    if (failures <= 0) return 0;
    return Math.min(BACKOFF_MAX_MS, 60_000 * 2 ** Math.min(failures, 10));
}

let failures = 0;
let lastLog = '';

/**
 * worker 调：慢读一位好友的牧场等级（只进场读 big_farm_level，不做任何偷 / 放蚊子 / 清理；离场沿用 friends.visit 的确认逻辑）。
 * canRun() 由 worker 判断是否完全空闲。返回下次调用的延迟（毫秒）。
 */
async function runSlowReadOnce(canRun: () => boolean): Promise<number> {
    const delay = nextReadDelayMs();
    try {
        if (!canRun()) return delay;
        if (!require('./transport').isUnlocked()) return 30 * 60_000;
        const list = require('../friend').getFriendsListCacheOnly ? require('../friend').getFriendsListCacheOnly() : [];
        const target = pickReadCandidate(list, load(), Date.now(), failedUntil);
        if (!target) return 10 * 60_000;
        const gid = String(target.gid);
        try {
            const level = await require('./friends').peekLevel(gid, canRun);
            if (level > 0) {
                recordLevel(gid, level, 'slow_read');
                failures = 0;
                const msg = `好友牧场等级：${target.name || gid} 为 Lv${level}（慢读）`;
                if (msg !== lastLog) { lastLog = msg; require('../../utils/utils').log('牧场', msg, { module: 'ranch', event: 'fnos好友牧场', result: 'ok' }); }
            } else {
                failedUntil.set(gid, Date.now() + FAIL_RETRY_MS);
            }
            return delay;
        } catch (e: any) {
            failedUntil.set(gid, Date.now() + FAIL_RETRY_MS);
            failures++;
            try { require('../../utils/utils').logWarn('牧场', `好友牧场等级慢读失败（${target.name || gid}）：${e.message}`, { module: 'ranch', event: 'fnos好友牧场', result: 'skip' }); } catch { /* ignore */ }
            return delay + backoffMs(failures);
        }
    } catch {
        return delay;
    }
}

function resetFnosFriendLevelsRuntime(): void {
    cache = null;
    failedUntil.clear();
    failures = 0;
    lastLog = '';
}

module.exports = {
    STALE_MS, READ_MIN_MS, READ_MAX_MS,
    storeFile, recordLevel, recordLevels, recordFromFriendList, getEntry,
    decorateAndSort, decorateFriends, pickReadCandidate, nextReadDelayMs, backoffMs,
    runSlowReadOnce, resetFnosFriendLevelsRuntime,
    _load: load,
};
