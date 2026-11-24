export {};
/**
 * [fnos-fork] 在线期间来偷菜的自动删除（文件名沿用旧的 steal-ratio）
 *
 * 2026-11-23 起偷收比相关的阈值、忽略好友申请、Bark、好友页筛选、自动删除均已下架，
 * 旧配置 fnosStealRatio 里的这些字段读取时直接丢弃，只认 autoDeleteOnlineStealer（默认关）。
 *
 * 只删除「本次上线之后、程序正在跑时」新检测到的偷菜。检测用访客记录（InteractRecords，
 * action_type=1）。server_time > 0 视为可靠时间，必须晚于本次登录/重连成功；
 * 没有可靠时间的记录用「上线后第一次拉取作基线，之后新增的才算」。
 * 每次重连重置上线时刻并重建基线，掉线期间和启动后第一次拉到的历史记录不删。
 * 排除名单：大小号协作里的大号 GID、已记录到的小号 GID 一律不删。
 * 删除走 DelFriend，排队且两次至少间隔 1 分钟，同一 gid 本段在线不重复删。
 *
 * 小号 GID 记在 data/fnos-account-gids.json（账号登录后写入）。还没登录过这一版的小号，
 * 暂时无法从账号列表认出其 GID，因此不会被排除。
 * 在线期间删人的上线时刻和基线只放内存：重连是新进程，登录成功时重新计时。
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../json-db');

const CHECK_INTERVAL_MS = 3 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 20 * 1000;
/** [fnos-fork] 2026-11-17 杂项让路后多久再看 */
const MISC_RETRY_MS = 30 * 1000;
/** [fnos-fork] 在线期间偷菜自动删除：两次 DelFriend 至少间隔 1 分钟 */
const ONLINE_STEAL_DELETE_INTERVAL_MS = 60 * 1000;
const ONLINE_STEAL_DELETE_REASON = '在线期间偷菜';

export interface FnosStealRatioConfig {
    /** [fnos-fork] 在线期间来偷菜的自动删除，默认关。2026-11-23 起偷收比阈值 / 忽略申请 / Bark / 好友页筛选 / 自动删除均已下架，旧配置里的这些字段读取时丢弃 */
    autoDeleteOnlineStealer: boolean;
}

const DEFAULT_FNOS_STEAL_RATIO: FnosStealRatioConfig = {
    autoDeleteOnlineStealer: false,
};

export interface AltRelationSnapshot {
    accountId: string;
    selfGid: number;
    enabled: boolean;
    masterGid: number;
}

function normalizeFnosStealRatio(input: unknown, fallback: FnosStealRatioConfig = DEFAULT_FNOS_STEAL_RATIO): FnosStealRatioConfig {
    const base = { ...DEFAULT_FNOS_STEAL_RATIO, ...(fallback || {}) };
    const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, any> : {};
    return {
        autoDeleteOnlineStealer: src.autoDeleteOnlineStealer !== undefined ? !!src.autoDeleteOnlineStealer : !!base.autoDeleteOnlineStealer,
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

interface StealRecord {
    visitorGid: number;
    serverTimeSec: number;
    nick?: string;
    actionDetail?: string;
    actionType?: number;
    landId?: number;
    cropId?: number;
    cropCount?: number;
}

export interface OnlineStealQueueItem {
    gid: number;
    name: string;
    stolenAtSec: number;
    detail: string;
    reason: string;
}

export interface OnlineStealSession {
    /** 本次登录/重连成功的服务器时间（秒）。每次重连都要换新会话 */
    onlineSinceSec: number;
    /** false：下一次拉取只做基线，不删人 */
    initialized: boolean;
    /** 已见过的可靠 server_time（秒）。只认比它更新、且晚于 onlineSinceSec 的记录 */
    watermarkSec: number;
    /** 没有可靠时间戳的记录身份。上线后第一次拉取写入，之后新增的才算 */
    baselineKeys: string[];
    /** 本段在线已经删过或已经尝试删除的 gid，不重复删 */
    deletedGids: number[];
    queue: OnlineStealQueueItem[];
    /** 下一次允许 DelFriend 的本地时间（毫秒），0 表示可以立刻删 */
    nextDeleteAt: number;
}

function beginOnlineStealSession(onlineSinceSec: number): OnlineStealSession {
    return {
        onlineSinceSec: Math.max(0, Math.floor(Number(onlineSinceSec) || 0)),
        initialized: false,
        watermarkSec: 0,
        baselineKeys: [],
        deletedGids: [],
        queue: [],
        nextDeleteAt: 0,
    };
}

/** 没有可靠 server_time 时用来区分「是不是同一条记录」。不使用列表下标，避免顺序一变就被当成新偷菜。 */
function onlineStealRecordKey(record: StealRecord): string {
    const gid = Math.floor(Number(record && record.visitorGid) || 0);
    const land = Math.floor(Number(record && record.landId) || 0);
    const crop = Math.floor(Number(record && record.cropId) || 0);
    const count = Math.floor(Number(record && record.cropCount) || 0);
    const detail = String(record && record.actionDetail || '');
    return `u:${gid}:${land}:${crop}:${count}:${detail}`;
}

function collectOnlineStealProtectedGids(input: {
    snaps?: AltRelationSnapshot[];
    extraGids?: number[];
    priorityGids?: number[];
}): number[] {
    const extra = [...(input.extraGids || []), ...(input.priorityGids || [])];
    return collectProtectedGids(input.snaps || [], extra);
}

/**
 * 下线提醒渠道是 Bark 且填了 Key 时可以推送。
 * 渠道不是 Bark 时发不出去，不推。
 */
/** 上游 #188 起推送支持多渠道：优先取已启用的 Bark 渠道，老配置（无 channels）退回主渠道。 */
function findOnlineStealBarkChannel(reminder: any): { endpoint?: string; token?: string; secret?: string } | null {
    const list = reminder && Array.isArray(reminder.channels) ? reminder.channels : [];
    const hit = list.find((e: any) => e && String(e.channel || '').trim().toLowerCase() === 'bark'
        && e.enabled !== false && String(e.token || '').trim().length > 0);
    if (hit) return hit;
    const channel = String(reminder && reminder.channel || '').trim().toLowerCase();
    const token = String(reminder && reminder.token || '').trim();
    return channel === 'bark' && token.length > 0 ? reminder : null;
}

function shouldNotifyOnlineStealDelete(cfg: unknown, reminder: { channel?: string; token?: string; channels?: any[] } | null | undefined): boolean {
    return !!findOnlineStealBarkChannel(reminder);
}

/**
 * 从访客记录里挑出「本次上线之后才发生、且应该删除」的偷菜。
 * 会话尚未建立基线时，只记下当前记录，不删任何人（启动后第一次拉取、以及每次重连后的第一次拉取）。
 * serverTimeSec > 0 视为可靠时间，必须同时晚于 onlineSinceSec 和水位；否则走基线身份。
 * 同一 gid 只进一次队列。到点只弹出 1 人，nextDeleteAt 推到至少 minIntervalMs 之后。
 */
function planOnlineStealDeletes(input: {
    session: OnlineStealSession;
    records: StealRecord[];
    protectedGids?: number[];
    nowMs: number;
    minIntervalMs?: number;
}): { session: OnlineStealSession; deleteNow: OnlineStealQueueItem | null; baselined: boolean; skipped: OnlineStealQueueItem[] } {
    const minIntervalMs = Math.max(0, Number(input.minIntervalMs ?? ONLINE_STEAL_DELETE_INTERVAL_MS) || 0);
    const prev = input.session || beginOnlineStealSession(0);
    const session: OnlineStealSession = {
        onlineSinceSec: Math.max(0, Math.floor(Number(prev.onlineSinceSec) || 0)),
        initialized: !!prev.initialized,
        watermarkSec: Math.max(0, Math.floor(Number(prev.watermarkSec) || 0)),
        baselineKeys: [...(prev.baselineKeys || [])],
        deletedGids: (prev.deletedGids || []).map(gid => Math.floor(Number(gid) || 0)).filter(gid => gid > 0),
        queue: (prev.queue || []).map(item => ({
            gid: Math.floor(Number(item && item.gid) || 0),
            name: String(item && item.name || ''),
            stolenAtSec: Math.max(0, Math.floor(Number(item && item.stolenAtSec) || 0)),
            detail: String(item && item.detail || ''),
            reason: ONLINE_STEAL_DELETE_REASON,
        })).filter(item => item.gid > 0),
        nextDeleteAt: Math.max(0, Math.floor(Number(prev.nextDeleteAt) || 0)),
    };
    const protectedSet = new Set((input.protectedGids || []).map(gid => Math.floor(Number(gid) || 0)).filter(gid => gid > 0));
    const steals = (Array.isArray(input.records) ? input.records : [])
        .filter(record => Number(record && record.actionType) === 1 && Math.floor(Number(record.visitorGid) || 0) > 0)
        .slice()
        .sort((a, b) => (Number(a.serverTimeSec) || 0) - (Number(b.serverTimeSec) || 0) || (Number(a.visitorGid) - Number(b.visitorGid)));
    if (!session.initialized) {
        const keys = new Set(session.baselineKeys);
        let watermark = session.watermarkSec;
        for (const record of steals) {
            const at = Math.floor(Number(record.serverTimeSec) || 0);
            if (at > watermark) watermark = at;
            if (at <= 0) keys.add(onlineStealRecordKey(record));
        }
        session.watermarkSec = watermark;
        session.baselineKeys = [...keys];
        session.initialized = true;
        return { session, deleteNow: null, baselined: true, skipped: [] };
    }
    const deleted = new Set(session.deletedGids);
    const queued = new Set(session.queue.map(item => item.gid));
    const seenKeys = new Set(session.baselineKeys);
    const skipped: OnlineStealQueueItem[] = [];
    let watermark = session.watermarkSec;
    for (const record of steals) {
        const gid = Math.floor(Number(record.visitorGid) || 0);
        const at = Math.floor(Number(record.serverTimeSec) || 0);
        if (at > 0) {
            if (at <= session.onlineSinceSec || at <= watermark) {
                if (at > watermark) watermark = at;
                continue;
            }
            watermark = at;
        } else {
            const key = onlineStealRecordKey(record);
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
        }
        const name = String(record.nick || '').trim() || `GID:${gid}`;
        const item: OnlineStealQueueItem = {
            gid,
            name,
            stolenAtSec: at,
            detail: String(record.actionDetail || '偷取作物'),
            reason: ONLINE_STEAL_DELETE_REASON,
        };
        if (protectedSet.has(gid)) {
            skipped.push(item);
            continue;
        }
        if (deleted.has(gid) || queued.has(gid)) continue;
        session.queue.push(item);
        queued.add(gid);
    }
    session.watermarkSec = watermark;
    session.baselineKeys = [...seenKeys];
    const now = Math.floor(Number(input.nowMs) || 0);
    let deleteNow: OnlineStealQueueItem | null = null;
    while (session.queue.length > 0) {
        const head = session.queue[0];
        if (protectedSet.has(head.gid) || deleted.has(head.gid)) {
            session.queue.shift();
            continue;
        }
        if (session.nextDeleteAt > 0 && now < session.nextDeleteAt) break;
        deleteNow = session.queue.shift() || null;
        if (deleteNow) {
            deleted.add(deleteNow.gid);
            session.nextDeleteAt = now + minIntervalMs;
        }
        break;
    }
    session.deletedGids = [...deleted];
    return { session, deleteNow, baselined: false, skipped };
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

function readOnlineStealProtectedGids(): number[] {
    return collectOnlineStealProtectedGids({
        snaps: loadAltRelationSnapshots(),
        extraGids: currentSelfGid() > 0 ? [currentSelfGid()] : [],
    });
}

function formatOnlineStealWhen(stolenAtSec: number): string {
    const sec = Math.floor(Number(stolenAtSec) || 0);
    if (sec <= 0) return '时间未知（上线后新出现的偷菜记录）';
    try {
        const text = require('../../utils/utils').formatSystemDateTime24(sec * 1000);
        if (text) return String(text);
    } catch { /* 用本地时间兜底 */ }
    return new Date(sec * 1000).toISOString();
}

function currentSelfGid(): number {
    try {
        const { getUserState } = require('../../utils/network');
        return Math.floor(Number((getUserState() || {}).gid) || 0);
    } catch {
        return 0;
    }
}

let activeScheduler: any = null;
let activeTick: (() => Promise<any>) | null = null;
/** [fnos-fork] 在线期间偷菜：只活在本进程。重连会起新进程，登录成功时 noteFnosOnlineSession 重建 */
let onlineSession: OnlineStealSession | null = null;

function resetFnosStealRatioRuntime(): void {
}

/** 登录成功 / 重连成功时调用。重置上线时刻和基线，断线到重连之间的记录不会被算进去。 */
function noteFnosOnlineSession(atSec?: number): OnlineStealSession {
    let sec = Math.floor(Number(atSec) || 0);
    if (sec <= 0) {
        try { sec = Math.floor(Number(require('../../utils/utils').getServerTimeSec()) || 0); } catch { sec = 0; }
    }
    if (sec <= 0) sec = Math.floor(Date.now() / 1000);
    onlineSession = beginOnlineStealSession(sec);
    return onlineSession;
}

function scheduleOnlineStealDrain(waitMs: number): void {
    if (!activeScheduler || !activeTick) return;
    const wait = Math.max(1000, Math.floor(Number(waitMs) || 0));
    try { activeScheduler.setTimeoutTask('fnos_online_steal_delete', wait, activeTick); } catch { /* ignore */ }
}

/** 开关关掉后清掉基线和排队，下次打开重新做基线，避免把关闭期间的记录当成新偷菜。已删过的 gid 仍保留。 */
function pauseOnlineStealWatch(): void {
    if (!onlineSession) return;
    const deletedGids = onlineSession.deletedGids;
    const since = onlineSession.onlineSinceSec;
    onlineSession = beginOnlineStealSession(since);
    onlineSession.deletedGids = deletedGids;
}

async function notifyOnlineStealDeleted(cfg: FnosStealRatioConfig, item: OnlineStealQueueItem): Promise<void> {
    const { logWarn } = require('../../utils/utils');
    try {
        const store = require('../../models/store');
        const reminder = store.getOfflineReminder ? store.getOfflineReminder() : null;
        if (!shouldNotifyOnlineStealDelete(cfg, reminder)) return;
        const { sendPushooMessage } = require('../push');
        const { getUserState } = require('../../utils/network');
        const accountName = String((getUserState() || {}).name || '').trim();
        const when = formatOnlineStealWhen(item.stolenAtSec);
        const title = accountName ? `在线期间偷菜已删除 ${accountName}` : '在线期间偷菜已删除';
        const content = `${item.name}（GID ${item.gid}）于 ${when} ${item.detail}。已删除该好友。原因：${ONLINE_STEAL_DELETE_REASON}。`;
        const bark = findOnlineStealBarkChannel(reminder) || {};
        const result = await sendPushooMessage({
            channel: 'bark',
            endpoint: String(bark.endpoint || ''),
            token: String(bark.token || '').trim(),
            secret: String(bark.secret || ''),
            title,
            content,
            barkCritical: reminder.barkCritical !== false,
        });
        if (!result || !result.ok) {
            logWarn('偷收比', `在线期间偷菜的删除通知发送失败：${result && result.msg ? result.msg : 'unknown'}（${item.name}）。删除本身不受影响`, {
                module: 'friend', event: '在线期间偷菜', result: 'error', friendGid: item.gid,
            });
        }
    } catch (e: any) {
        logWarn('偷收比', `在线期间偷菜的删除通知异常：${e && e.message ? e.message : e}。删除本身不受影响`, {
            module: 'friend', event: '在线期间偷菜', result: 'error', friendGid: item.gid,
        });
    }
}

async function runAutoDeleteOnlineStealer(cfg: FnosStealRatioConfig): Promise<void> {
    if (!cfg.autoDeleteOnlineStealer) {
        pauseOnlineStealWatch();
        return;
    }
    if (!onlineSession || onlineSession.onlineSinceSec <= 0) noteFnosOnlineSession();
    const { getInteractRecords } = require('../interact');
    const { deleteFriend } = require('./visit-strategy');
    const { log, logWarn } = require('../../utils/utils');
    let records: StealRecord[] = [];
    try {
        records = await getInteractRecords('low');
    } catch (e: any) {
        logWarn('偷收比', `读取访客记录失败，本轮不删除在线期间偷菜的人：${e && e.message ? e.message : e}`, {
            module: 'friend', event: '在线期间偷菜', result: 'error',
        });
        return;
    }
    const planned = planOnlineStealDeletes({
        session: onlineSession as OnlineStealSession,
        records,
        protectedGids: readOnlineStealProtectedGids(),
        nowMs: Date.now(),
        minIntervalMs: ONLINE_STEAL_DELETE_INTERVAL_MS,
    });
    onlineSession = planned.session;
    if (planned.baselined) {
        log('偷收比', '已记下本次上线后的访客记录作为基线，只删除之后新检测到的偷菜（掉线期间和历史记录不删）', {
            module: 'friend', event: '在线期间偷菜', result: 'ok', onlineSinceSec: onlineSession.onlineSinceSec,
        });
    }
    for (const skipped of planned.skipped) {
        const when = formatOnlineStealWhen(skipped.stolenAtSec);
        log('偷收比', `跳过 ${skipped.name}（GID ${skipped.gid}）：${when} 来偷菜，但不删除（大号、小号或优先雇佣人）`, {
            module: 'friend', event: '在线期间偷菜', result: 'skipped', friendGid: skipped.gid, friendName: skipped.name,
        });
    }
    const target = planned.deleteNow;
    if (target) {
        const when = formatOnlineStealWhen(target.stolenAtSec);
        log('偷收比', `准备删除好友 ${target.name}（GID ${target.gid}）：${when} 来偷菜，原因：${ONLINE_STEAL_DELETE_REASON}`, {
            module: 'friend',
            event: '在线期间偷菜',
            result: 'pending',
            friendName: target.name,
            friendGid: target.gid,
            stolenAtSec: target.stolenAtSec,
        });
        try {
            await deleteFriend(target.gid, `${ONLINE_STEAL_DELETE_REASON}（${when} ${target.detail}）`);
            log('偷收比', `已删除好友 ${target.name}（GID ${target.gid}）：${when} 来偷菜，原因：${ONLINE_STEAL_DELETE_REASON}`, {
                module: 'friend',
                event: '在线期间偷菜',
                result: 'ok',
                friendName: target.name,
                friendGid: target.gid,
                stolenAtSec: target.stolenAtSec,
            });
            await notifyOnlineStealDeleted(cfg, target);
        } catch (e: any) {
            logWarn('偷收比', `删除 ${target.name}（GID ${target.gid}）失败：${when} 来偷菜，原因：${ONLINE_STEAL_DELETE_REASON}。${e && e.message ? e.message : e}`, {
                module: 'friend', event: '在线期间偷菜', result: 'error', friendGid: target.gid, friendName: target.name,
            });
        }
    }
    if (onlineSession && onlineSession.queue.length > 0 && onlineSession.nextDeleteAt > Date.now()) {
        scheduleOnlineStealDrain(onlineSession.nextDeleteAt - Date.now());
    }
}

async function runFnosStealRatioTick(): Promise<void> {
    rememberSelfGid();
    const cfg = readFnosStealRatio();
    await runAutoDeleteOnlineStealer(cfg);
}

function startFnosStealRatio(scheduler: any, runExclusive: (name: string, fn: () => Promise<any>) => Promise<any>): void {
    resetFnosStealRatioRuntime();
    // 登录成功回调里已经记过上线时刻时不要再记一次，否则会把时刻推晚并清掉基线
    if (!onlineSession || onlineSession.onlineSinceSec <= 0) noteFnosOnlineSession();
    // [fnos-fork] 2026-11-17 偷收比统计是杂项：自家收获 / 偷菜 / 帮忙即将到点或好友巡查在跑时先不做，30 秒后再看
    const fnosMiscWait = () => { try { return !!require('../fnos-timetable').miscShouldWait(); } catch { return false; } };
    const tick = (): Promise<any> => (require('../fnos-quiet-priority').isFnosIdleActive() ? Promise.resolve(null) /* 空闲时只保留心跳：本次跳过 */ : fnosMiscWait() ? (() => {
        try { scheduler.setTimeoutTask('fnos_steal_ratio_soon', MISC_RETRY_MS, tick); } catch { /* ignore */ }
        return Promise.resolve(null);
    })() : runExclusive('fnos_steal_ratio', () => runFnosStealRatioTick())).catch((e: any) => {
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
    if (cfg.autoDeleteOnlineStealer) return '在线期间来偷菜自动删除已启用（只删本次上线后新检测到的偷菜；排除大号和小号）';
    return '在线期间来偷菜自动删除未启用';
}

module.exports = {
    loadAltRelationSnapshots, // [fnos-fork] 2026-11-16 fnos-ranch 大号优先巡查自己的小号牧场
    DEFAULT_FNOS_STEAL_RATIO,
    CHECK_INTERVAL_MS,
    ONLINE_STEAL_DELETE_INTERVAL_MS,
    ONLINE_STEAL_DELETE_REASON,
    normalizeFnosStealRatio,
    readFnosStealRatio,
    collectProtectedGids,
    beginOnlineStealSession,
    planOnlineStealDeletes,
    collectOnlineStealProtectedGids,
    shouldNotifyOnlineStealDelete,
    noteFnosOnlineSession,
    readOnlineStealProtectedGids,
    writeSelfGid,
    rememberSelfGid,
    readProtectedGidList,
    startFnosStealRatio,
    onFnosStealRatioConfigChanged,
    describeFnosStealRatio,
    resetFnosStealRatioRuntime,
};
