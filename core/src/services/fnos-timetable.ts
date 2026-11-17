export {};
/**
 * [fnos-fork] 2026-11-17 好友时间表 + 自家提前蹲点 + 杂项只在空闲时做（用户原话：「固定几分钟轮一次好友 list，
 * 看看他们的菜什么时候熟，牧场什么时候成长，记录好每个好友还多久，然后到时候直接去……自己的也记录什么时候成熟成长收获，
 * 到期前 2 秒就去等着收，而不是全靠轮」「空闲时间再去完成其他的、任务 图鉴活动等」）。
 *
 * 协议里能拿到的时间（captures/1116-1~8 解码核对）：
 *   - 好友列表 GetAll / GetGameFriends 的 plant（friendpb.Plant）：
 *       字段 1/2/3（proto 名 dry/weed/insect_time_sec）实测是「绝对时间（服务器秒）」，大多在未来几分钟到几小时，
 *       推断是该好友下一次缺水 / 长草 / 生虫的时间 → 记为「下次需要帮忙」时间；
 *       字段 6 steal_plant_num 当前可偷块数，7/8/9 当前缺水 / 长草 / 生虫块数；
 *       字段 4 ripe_time_sec、5 ripe_fruit_id 在所有抓包里都没有出现 → 列表里没有成熟时间。
 *   - 进好友农场 Enter 回包的 lands：每块地 plant.phases 的 begin_time，最晚开始的阶段 = 成熟时间（与自家相同算法）
 *     → 进过的好友记下「下次成熟」时间。
 *   - 进好友牧场 GetRanchDetail 的 animals：produce_ready_at_ms / mature_ready_at_ms（服务器毫秒）
 *     → 记下「下次可偷（产出）」时间（推断：产出后上架才能偷）。
 *   - 服务器推送：LandsNotify / CellsNotify / FacilitiesNotify 带 host_gid，但抓包里好友 host_gid 的推送全部出现在
 *     「人在该好友农场 / 牧场里」期间；没有「好友作物成熟」「好友牧场可偷」「好友需要帮忙」这类主动推送。
 *     收到好友 host_gid 的土地推送时只用来更新时间表（不额外插队），见 notePushLands。
 *
 * 设计：
 *   - 每 friendScanMinutes 分钟扫一次好友列表（好友巡查本身），顺手：列表里可偷 / 要帮的照常去；
 *     记下每位好友下次需要帮忙的时间；2026-11-17 起每次自家一轮做完立刻「好友状态轮巡」（见 PROBE_MAX_PER_ROUND 的说明），进去读成熟时间。
 *   - 到点（成熟后 FRIEND_ARRIVE_AFTER_MS / 需要帮忙时间）直接去该好友，多位同时到点排队，每批最多 MAX_DUE_PER_BATCH 位，
 *     同一好友 REVISIT_GAP_MS 内不重复去。偷 / 帮 / 捣乱规则、次数上限、大小号规则全部沿用好友巡查（visit-plan + fnos-alt-coop）。
 *   - 好友牧场同理：牧场轮里先去到点的好友牧场，大小号规则沿用 fnos-ranch.wrapFriendWanted。
 *   - 数据按账号存 data/fnos-timetable/<账号>.json（本地毫秒时间），重启后接着用。
 *   - 杂项（任务、礼包、图鉴、神秘商店、偷收比统计、好友宠物同步、每日福利、牧场任务 / 分享 / 图鉴）只在 MISC_QUIET_WINDOW_MS 内没有任何
 *     到点事项（自家收获、好友时间表、好友巡查进行中）时做：miscShouldWait()。
 */

const path = require('node:path');

/** 好友作物成熟后多久到（给服务器一点余量） */
const FRIEND_ARRIVE_AFTER_MS = 800;
/** 同一位好友两次按时间表前往的最短间隔 */
const REVISIT_GAP_MS = 30_000;
/** 进过的好友，成熟时间记录多久后算「太旧」需要重新探 */
const PROBE_STALE_MS = 2 * 60 * 60 * 1000;
/** 每次扫列表最多探几位好友（旧规则；2026-11-17 起改为每轮自家工作做完后的「好友状态轮巡」，见 PROBE_MAX_PER_ROUND） */
const PROBE_PER_SCAN = 5;
/**
 * [fnos-fork] 2026-11-17 用户：「轮完自己的工作，立刻轮好友农牧场状态」。
 * 每次自家一轮（巡田 / 自家牧场）做完，立刻进好友家把成熟 / 可偷时间读一遍；为了不刷请求：
 *   - 已知未来成熟 / 可偷时间的好友跳过（到点按时间表直接去）；已过点的交给时间表到点处理；
 *   - 上次进去是空地 / 暂无可偷的，农场 15 分钟、牧场 10 分钟后才再看（参考空间版「每 15 分钟刷新我的农场」「每 10 分钟刷新可偷列表」）；
 *   - 进不去 / 失败的同一好友 15 分钟内不再试；
 *   - 每轮最多 PROBE_MAX_PER_ROUND 位，其余下一轮接着看；
 *   - 翻阅节奏参考空间版：每位之间 500～1000 毫秒，每翻阅 300 位休息 15～25 秒（农场、牧场共用计数）。
 */
const PROBE_MAX_PER_ROUND = 100;
const FARM_EMPTY_RECHECK_MS = 15 * 60 * 1000;
const RANCH_EMPTY_RECHECK_MS = 10 * 60 * 1000;
const PROBE_RETRY_MS = 15 * 60 * 1000;
const PAGE_GAP_MIN_MS = 500;
const PAGE_GAP_MAX_MS = 1000;
const REST_EVERY_PAGES = 300;
const REST_MIN_MS = 15_000;
const REST_MAX_MS = 25_000;
/** 一批最多去几位到点的好友（其余下一批） */
const MAX_DUE_PER_BATCH = 5;
/** 杂项让路窗口：这么久内有到点事项就先不做杂项 */
const MISC_QUIET_WINDOW_MS = 30_000;
/** 列表里可偷数为 0 时，过期多久的成熟时间作废（已被收 / 偷完） */
const RIPE_EXPIRE_MS = 10 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 5000;

export interface FarmEntry { name: string; ripeAt: number; helpAt: number; seenAt: number; visitedAt: number }
export interface RanchEntry { name: string; readyAt: number; seenAt: number; visitedAt: number }
export interface TimetableState { farm: Record<string, FarmEntry>; ranch: Record<string, RanchEntry> }
export interface DueTarget { gid: number; name: string; kind: 'steal' | 'help'; at: number }

function emptyState(): TimetableState { return { farm: {}, ranch: {} }; }

function num(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/** 服务器秒 → 本地毫秒 */
function serverSecToLocal(sec: number, nowMs: number, nowSec: number): number {
    return sec > 0 ? nowMs + (sec - nowSec) * 1000 : 0;
}

// ============ 纯函数（可单测） ============

/** 一组土地里下一块作物成熟的服务器时间（秒）：phases 最晚开始的阶段就是成熟阶段；已成熟 / 空地不算。0 = 没有。 */
function nextMatureSec(lands: any[], nowSec: number): number {
    let best = 0;
    for (const land of Array.isArray(lands) ? lands : []) {
        if (!land || land.unlocked === false) continue;
        const phases = land.plant && Array.isArray(land.plant.phases) ? land.plant.phases : [];
        let matureBegin = 0;
        for (const phase of phases) {
            let begin = phase ? num(phase.begin_time) : 0;
            if (begin > 1e12) begin = Math.floor(begin / 1000);
            if (begin > matureBegin) matureBegin = begin;
        }
        if (matureBegin > nowSec && (best === 0 || matureBegin < best)) best = matureBegin;
    }
    return best;
}

/** 好友列表 plant 字段 1/2/3（下次缺水 / 长草 / 生虫，服务器秒）里最近的未来时间；小于 1e9 的按倒计时秒处理。0 = 没有。 */
function nextHelpSecFromPlant(plant: any, nowSec: number): number {
    if (!plant) return 0;
    let best = 0;
    for (const key of ['dry_time_sec', 'weed_time_sec', 'insect_time_sec']) {
        let v = num(plant[key]);
        if (v <= 0) continue;
        if (v < 1e9) v = nowSec + v;
        if (v > nowSec && (best === 0 || v < best)) best = v;
    }
    return best;
}

/** 好友牧场动物里下一次产出 / 成熟的服务器毫秒时间。0 = 没有。 */
function nextRanchReadyMs(ranches: any[], nowSec: number): number {
    let best = 0;
    for (const ranch of Array.isArray(ranches) ? ranches : []) {
        for (const animal of (ranch && Array.isArray(ranch.animals)) ? ranch.animals : []) {
            for (const key of ['produce_ready_at_ms', 'mature_ready_at_ms']) {
                const v = num(animal && animal[key]);
                if (v > nowSec * 1000 && (best === 0 || v < best)) best = v;
            }
        }
    }
    return best;
}

function farmEntry(state: TimetableState, gid: number, name?: string): FarmEntry {
    const key = String(gid);
    const e = state.farm[key] || (state.farm[key] = { name: '', ripeAt: 0, helpAt: 0, seenAt: 0, visitedAt: 0 });
    if (name) e.name = name;
    return e;
}

function ranchEntry(state: TimetableState, gid: number, name?: string): RanchEntry {
    const key = String(gid);
    const e = state.ranch[key] || (state.ranch[key] = { name: '', readyAt: 0, seenAt: 0, visitedAt: 0 });
    if (name) e.name = name;
    return e;
}

function friendName(friend: any, gid: number): string {
    return (friend && (friend.remark || friend.name)) || `GID:${gid}`;
}

/** 扫好友列表：记名字、下次需要帮忙时间；可偷数为 0 时清掉过期很久的成熟时间；不在列表里的好友删掉。 */
function applyFarmList(state: TimetableState, friends: any[], nowMs: number, nowSec: number, selfGid: number): void {
    const list = Array.isArray(friends) ? friends : [];
    const alive = new Set<string>();
    for (const friend of list) {
        const gid = num(friend && friend.gid);
        if (gid <= 0 || gid === selfGid) continue;
        alive.add(String(gid));
        const e = farmEntry(state, gid, friendName(friend, gid));
        const plant = friend && friend.plant;
        const helpSec = nextHelpSecFromPlant(plant, nowSec);
        e.helpAt = helpSec > 0 ? serverSecToLocal(helpSec, nowMs, nowSec) : 0;
        if (num(plant && plant.steal_plant_num) <= 0 && e.ripeAt > 0 && nowMs - e.ripeAt > RIPE_EXPIRE_MS) e.ripeAt = 0;
        if (state.ranch[String(gid)]) state.ranch[String(gid)].name = e.name;
    }
    if (list.length > 0) {
        for (const key of Object.keys(state.farm)) if (!alive.has(key)) delete state.farm[key];
        for (const key of Object.keys(state.ranch)) if (!alive.has(key)) delete state.ranch[key];
    }
}

/** 进了好友农场：用 lands 记下次成熟时间（没有在长的作物 = 0），并记为已探过 / 已去过。 */
function applyFarmLands(state: TimetableState, gid: number, name: string, lands: any[], nowMs: number, nowSec: number): number {
    const e = farmEntry(state, gid, name);
    const sec = nextMatureSec(lands, nowSec);
    e.ripeAt = sec > 0 ? serverSecToLocal(sec, nowMs, nowSec) : 0;
    e.seenAt = nowMs;
    e.visitedAt = nowMs;
    return e.ripeAt;
}

/** 好友 host_gid 的土地推送（只含变化的地）：只把成熟时间往前更新，不额外插队。 */
function applyPushLands(state: TimetableState, gid: number, lands: any[], nowMs: number, nowSec: number): number {
    const sec = nextMatureSec(lands, nowSec);
    if (!(sec > 0)) return 0;
    const at = serverSecToLocal(sec, nowMs, nowSec);
    const e = farmEntry(state, gid);
    if (!(e.ripeAt > nowMs) || at < e.ripeAt) e.ripeAt = at;
    return e.ripeAt;
}

/** 进了好友牧场：记下次产出时间。 */
function applyRanch(state: TimetableState, gid: number, name: string, ranches: any[], nowMs: number, nowSec: number): number {
    const e = ranchEntry(state, gid, name);
    const ms = nextRanchReadyMs(ranches, nowSec);
    e.readyAt = ms > 0 ? nowMs + (ms - nowSec * 1000) : 0;
    e.seenAt = nowMs;
    e.visitedAt = nowMs;
    return e.readyAt;
}

function farmDueAt(e: FarmEntry): { at: number; kind: 'steal' | 'help' } | null {
    const ripe = e.ripeAt > 0 ? e.ripeAt + FRIEND_ARRIVE_AFTER_MS : 0;
    const help = e.helpAt > 0 ? e.helpAt + FRIEND_ARRIVE_AFTER_MS : 0;
    if (!ripe && !help) return null;
    // 偷优先：两个都有时取较早的；同时到点按「偷」记
    if (ripe && (!help || ripe <= help)) return { at: Math.max(ripe, e.visitedAt + REVISIT_GAP_MS), kind: 'steal' };
    return { at: Math.max(help, e.visitedAt + REVISIT_GAP_MS), kind: 'help' };
}

/** 现在到点要去的好友农场（偷优先，其次按时间），最多 limit 位；exclude 里的跳过（黑名单 / 自己）。 */
function listDueFarm(state: TimetableState, nowMs: number, limit: number = MAX_DUE_PER_BATCH, exclude: Set<number> = new Set()): DueTarget[] {
    const out: DueTarget[] = [];
    for (const [key, e] of Object.entries(state.farm)) {
        const gid = Number(key);
        if (exclude.has(gid)) continue;
        const due = farmDueAt(e);
        if (!due || due.at > nowMs) continue;
        // 偷：成熟时间已过；帮：需要帮忙时间已过
        out.push({ gid, name: e.name || `GID:${gid}`, kind: due.kind, at: due.kind === 'steal' ? e.ripeAt : e.helpAt });
    }
    out.sort((a, b) => (a.kind === b.kind ? a.at - b.at : a.kind === 'steal' ? -1 : 1));
    return out.slice(0, Math.max(0, limit));
}

function nextFarmDueAt(state: TimetableState, exclude: Set<number> = new Set()): number {
    let best = 0;
    for (const [key, e] of Object.entries(state.farm)) {
        if (exclude.has(Number(key))) continue;
        const due = farmDueAt(e);
        if (due && (best === 0 || due.at < best)) best = due.at;
    }
    return best;
}

function ranchDueAt(e: RanchEntry): number {
    return e.readyAt > 0 ? Math.max(e.readyAt + FRIEND_ARRIVE_AFTER_MS, e.visitedAt + REVISIT_GAP_MS) : 0;
}

function listDueRanch(state: TimetableState, nowMs: number, limit: number = MAX_DUE_PER_BATCH, exclude: Set<number> = new Set()): DueTarget[] {
    const out: DueTarget[] = [];
    for (const [key, e] of Object.entries(state.ranch)) {
        const gid = Number(key);
        if (exclude.has(gid)) continue;
        const at = ranchDueAt(e);
        if (!at || at > nowMs) continue;
        out.push({ gid, name: e.name || `GID:${gid}`, kind: 'steal', at: e.readyAt });
    }
    out.sort((a, b) => a.at - b.at);
    return out.slice(0, Math.max(0, limit));
}

function nextRanchDueAt(state: TimetableState, exclude: Set<number> = new Set()): number {
    let best = 0;
    for (const [key, e] of Object.entries(state.ranch)) {
        if (exclude.has(Number(key))) continue;
        const at = ranchDueAt(e);
        if (at && (best === 0 || at < best)) best = at;
    }
    return best;
}

/** 出发前标记（去重）：成熟 / 帮忙时间清零，进去后由 applyFarmLands / applyRanch 重新记。 */
function markFarmVisiting(state: TimetableState, gid: number, nowMs: number, kind: 'steal' | 'help'): void {
    const e = farmEntry(state, gid);
    e.visitedAt = nowMs;
    if (kind === 'steal') e.ripeAt = 0; else e.helpAt = 0;
}

function markRanchVisiting(state: TimetableState, gid: number, nowMs: number): void {
    const e = ranchEntry(state, gid);
    e.visitedAt = nowMs;
    e.readyAt = 0;
}

/**
 * 要「探一探」的好友（纯函数）：
 *   没进去读过 → 探（等级高的先）；已知成熟 / 可偷时间（未来或刚过点）→ 跳过；
 *   上次是空地 / 暂无可偷 → 过了 emptyRecheckMs 再探（最久没看的先）；tried 里 PROBE_RETRY_MS 内试过的跳过。
 */
function pickSideProbes(side: 'farm' | 'ranch', state: TimetableState, friends: any[], nowMs: number, limit: number, exclude: Set<number> = new Set(), tried: Map<number, number> = new Map()): any[] {
    const recheck = side === 'farm' ? FARM_EMPTY_RECHECK_MS : RANCH_EMPTY_RECHECK_MS;
    const unseen: any[] = [];
    const stale: Array<{ f: any; seenAt: number }> = [];
    for (const friend of Array.isArray(friends) ? friends : []) {
        const gid = num(friend && friend.gid);
        if (gid <= 0 || exclude.has(gid)) continue;
        const t = tried.get(gid) || 0;
        if (t > 0 && nowMs - t < PROBE_RETRY_MS) continue;
        const e: any = side === 'farm' ? state.farm[String(gid)] : state.ranch[String(gid)];
        if (!e || !e.seenAt) { unseen.push(friend); continue; }
        const at = side === 'farm' ? e.ripeAt : e.readyAt;
        if (at > 0) continue;
        if (nowMs - e.seenAt >= recheck) stale.push({ f: friend, seenAt: e.seenAt });
    }
    unseen.sort((a: any, b: any) => num(b && b.level) - num(a && a.level));
    stale.sort((a, b) => a.seenAt - b.seenAt);
    return [...unseen, ...stale.map(x => x.f)].slice(0, Math.max(0, limit));
}

function pickProbes(state: TimetableState, friends: any[], nowMs: number, limit: number = PROBE_MAX_PER_ROUND, exclude: Set<number> = new Set(), tried?: Map<number, number>): any[] {
    return pickSideProbes('farm', state, friends, nowMs, limit, exclude, tried);
}

function pickRanchProbes(state: TimetableState, friends: any[], nowMs: number, limit: number = PROBE_MAX_PER_ROUND, exclude: Set<number> = new Set(), tried?: Map<number, number>): any[] {
    return pickSideProbes('ranch', state, friends, nowMs, limit, exclude, tried);
}

/** 翻阅节奏（纯函数）：第 count 位翻完后等多久；每 REST_EVERY_PAGES 位额外休息。rand 返回 [0,1)。 */
function pageTurnDelay(count: number, rand: () => number = Math.random): { gapMs: number; restMs: number } {
    const gapMs = Math.round(PAGE_GAP_MIN_MS + (PAGE_GAP_MAX_MS - PAGE_GAP_MIN_MS) * rand());
    const restMs = count > 0 && count % REST_EVERY_PAGES === 0 ? Math.round(REST_MIN_MS + (REST_MAX_MS - REST_MIN_MS) * rand()) : 0;
    return { gapMs, restMs };
}

/** 杂项是否先让路：windowMs 内有任何到点事项（时间点 > 0 且 <= now + window）或有正在进行的高优先级任务。 */
function shouldMiscWait(input: { nowMs: number; busy?: boolean; times: number[]; windowMs?: number }): boolean {
    if (input.busy) return true;
    const limit = input.nowMs + (input.windowMs ?? MISC_QUIET_WINDOW_MS);
    return (input.times || []).some(t => t > 0 && t <= limit);
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }

/** 本地时间 hh:mm:ss（box / NAS 时区） */
function formatClock(ms: number): string {
    if (!(ms > 0)) return '--:--:--';
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 剩余时间：x 分 y 秒 / x 小时 y 分 */
function formatRemain(ms: number): string {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec} 秒`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分 ${sec % 60} 秒`;
    return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

// ============ 运行时（按账号持久化） ============

let state: TimetableState = emptyState();
let loadedFor: string | null = null;
let saveTimer: any = null;
let busyProbe: (() => { busy: boolean; times: number[] }) | null = null;

function accountId(): string { return String(process.env.FARM_ACCOUNT_ID || 'default'); }

function stateFile(id: string): string {
    const { getDataFile } = require('../config/runtime-paths');
    const safe = String(id || 'default').replace(/[^\w-]/g, '_');
    return getDataFile(path.join('fnos-timetable', `${safe}.json`));
}

function sanitize(raw: any): TimetableState {
    const out = emptyState();
    const src = raw && typeof raw === 'object' ? raw : {};
    for (const [key, e] of Object.entries(src.farm || {})) {
        if (!/^\d+$/.test(key) || !e || typeof e !== 'object') continue;
        const v: any = e;
        out.farm[key] = { name: String(v.name || ''), ripeAt: num(v.ripeAt), helpAt: num(v.helpAt), seenAt: num(v.seenAt), visitedAt: num(v.visitedAt) };
    }
    for (const [key, e] of Object.entries(src.ranch || {})) {
        if (!/^\d+$/.test(key) || !e || typeof e !== 'object') continue;
        const v: any = e;
        out.ranch[key] = { name: String(v.name || ''), readyAt: num(v.readyAt), seenAt: num(v.seenAt), visitedAt: num(v.visitedAt) };
    }
    return out;
}

function current(): TimetableState {
    const id = accountId();
    if (loadedFor !== id) {
        loadedFor = id;
        try {
            const { readJsonFile } = require('./json-db');
            state = sanitize(readJsonFile(stateFile(id), () => ({})));
        } catch { state = emptyState(); }
    }
    return state;
}

function flushNow(): void {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (loadedFor === null) return;
    try {
        const { writeJsonFileAtomic } = require('./json-db');
        writeJsonFileAtomic(stateFile(loadedFor), state);
    } catch { /* ignore */ }
}

function scheduleSave(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; flushNow(); }, SAVE_DEBOUNCE_MS);
    if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref();
}

function nowSec(): number {
    try { return require('../utils/utils').getServerTimeSec(); } catch { return Math.floor(Date.now() / 1000); }
}

function selfGid(): number {
    try { return num(require('../utils/network').getUserState().gid); } catch { return 0; }
}

function readConfig(): { timetableSteal: boolean; friendScanMinutes: number; ownLeadSec: number } {
    try {
        const { quiet } = require('./fnos-fork-config').readFnosForkConfigs();
        return { timetableSteal: quiet.timetableSteal !== false, friendScanMinutes: num(quiet.friendScanMinutes) || 5, ownLeadSec: Math.max(0, num(quiet.ownLeadSec ?? 2)) };
    } catch { return { timetableSteal: true, friendScanMinutes: 5, ownLeadSec: 2 }; }
}

function isEnabled(): boolean { return readConfig().timetableSteal; }

/** 好友列表扫描间隔（毫秒，±10% 随机）；时间表关着返回 0（沿用原来的好友巡查间隔）。 */
function scanIntervalMs(): number {
    const cfg = readConfig();
    if (!cfg.timetableSteal) return 0;
    const base = Math.max(1, cfg.friendScanMinutes) * 60_000;
    return Math.round(base * (0.9 + Math.random() * 0.2));
}

/** 自家收获提前多少毫秒进去等（时间表开关不影响，默认 2 秒） */
function ownLeadMs(): number { return readConfig().ownLeadSec * 1000; }

function blacklistSet(): Set<number> {
    const set = new Set<number>([selfGid()]);
    try {
        const { getFriendBlacklist } = require('../models/store');
        for (const gid of getFriendBlacklist(process.env.FARM_ACCOUNT_ID || '') || []) set.add(num(gid));
    } catch { /* ignore */ }
    return set;
}

function noteFarmList(friends: any[]): void {
    if (!isEnabled()) return;
    applyFarmList(current(), friends, Date.now(), nowSec(), selfGid());
    scheduleSave();
}

function noteFarmLands(gid: any, name: string, lands: any[]): void {
    const g = num(gid);
    if (g <= 0 || g === selfGid()) return;
    applyFarmLands(current(), g, name, lands, Date.now(), nowSec());
    scheduleSave();
}

function notePushLands(hostGid: any, lands: any[]): void {
    const g = num(hostGid);
    if (g <= 0 || g === selfGid() || !isEnabled()) return;
    if (applyPushLands(current(), g, lands, Date.now(), nowSec()) > 0) scheduleSave();
}

function noteRanch(gid: any, name: string, ranches: any[]): void {
    const g = num(gid);
    if (g <= 0 || g === selfGid()) return;
    applyRanch(current(), g, name, ranches, Date.now(), nowSec());
    scheduleSave();
}

/** 取出到点的好友农场并标记出发（去重）。时间表关着返回空。 */
function takeDueFarm(nowMs: number = Date.now(), limit: number = MAX_DUE_PER_BATCH): DueTarget[] {
    if (!isEnabled()) return [];
    const s = current();
    const due = listDueFarm(s, nowMs, limit, blacklistSet());
    for (const t of due) markFarmVisiting(s, t.gid, nowMs, t.kind);
    if (due.length) scheduleSave();
    return due;
}

function takeDueRanch(nowMs: number = Date.now(), limit: number = MAX_DUE_PER_BATCH): DueTarget[] {
    if (!isEnabled()) return [];
    const s = current();
    const due = listDueRanch(s, nowMs, limit, blacklistSet());
    for (const t of due) markRanchVisiting(s, t.gid, nowMs);
    if (due.length) scheduleSave();
    return due;
}

function farmDueTime(): number { return isEnabled() ? nextFarmDueAt(current(), blacklistSet()) : 0; }
function ranchDueTime(): number { return isEnabled() ? nextRanchDueAt(current(), blacklistSet()) : 0; }

const farmTried: Map<number, number> = new Map();
const ranchTried: Map<number, number> = new Map();
let pagesTurned = 0;

function probeExclude(exclude?: Set<number>): Set<number> {
    const ex = new Set<number>([...blacklistSet(), ...(exclude || [])]);
    const me = selfGid();
    if (me > 0) ex.add(me);
    return ex;
}

/** 本轮要探的好友农场（最多 PROBE_MAX_PER_ROUND 位），取出即记为「试过」 */
function probeTargets(friends: any[], exclude?: Set<number>, nowMs: number = Date.now()): any[] {
    if (!isEnabled()) return [];
    const rows = pickProbes(current(), friends, nowMs, PROBE_MAX_PER_ROUND, probeExclude(exclude), farmTried);
    for (const f of rows) farmTried.set(num(f.gid), nowMs);
    return rows;
}

/** 本轮要探的好友牧场 */
function ranchProbeTargets(friends: any[], exclude?: Set<number>, nowMs: number = Date.now()): any[] {
    if (!isEnabled()) return [];
    const rows = pickRanchProbes(current(), friends, nowMs, PROBE_MAX_PER_ROUND, probeExclude(exclude), ranchTried);
    for (const f of rows) ranchTried.set(num(f.gid), nowMs);
    return rows;
}

/** 还有没有要探的好友农场（不取出） */
function hasFarmProbeWork(friends: any[], nowMs: number = Date.now()): boolean {
    if (!isEnabled()) return false;
    return pickProbes(current(), friends, nowMs, 1, probeExclude(), farmTried).length > 0;
}

/** 还有没有要探的好友牧场（不取出） */
function hasRanchProbeWork(friends: any[], nowMs: number = Date.now()): boolean {
    if (!isEnabled()) return false;
    return pickRanchProbes(current(), friends, nowMs, 1, probeExclude(), ranchTried).length > 0;
}

/** 好友牧场进不去（没开牧场 / 拒绝拜访）：1 小时内不再探，免得每轮都试 */
function noteRanchProbeFailed(gid: any, nowMs: number = Date.now()): void {
    const g = num(gid);
    if (g > 0) ranchTried.set(g, nowMs + 60 * 60 * 1000 - PROBE_RETRY_MS);
}

/** 翻阅一位好友后的等待（农场 / 牧场共用计数） */
function nextPageTurn(): { gapMs: number; restMs: number; count: number } {
    pagesTurned += 1;
    return { ...pageTurnDelay(pagesTurned), count: pagesTurned };
}

/** worker 注册：自家收获 / 自家牧场定时 / 好友巡查是否在跑 */
function setBusyProbe(fn: typeof busyProbe): void { busyProbe = fn; }

/** 杂项（任务、礼包、图鉴、活动、商店、每日福利等）现在是否该让路给收获 / 偷菜 / 帮忙。 */
function miscShouldWait(nowMs: number = Date.now()): boolean {
    let probe = { busy: false, times: [] as number[] };
    try { if (busyProbe) probe = busyProbe(); } catch { /* ignore */ }
    return shouldMiscWait({ nowMs, busy: probe.busy, times: [...probe.times, farmDueTime(), ranchDueTime()] });
}

/** 给前端的一行：本地毫秒；*SeenAt = 进去读过的时间（0 = 还没扫描过成熟时间） */
export interface TimetableUiRow {
    gid: number; name: string;
    farmRipeAt: number; farmHelpAt: number; farmSeenAt: number; farmVisitedAt: number;
    ranchReadyAt: number; ranchSeenAt: number; ranchVisitedAt: number;
}

/** 纯函数：状态 → 前端行（「还多久可偷」列） */
function buildSnapshot(s: TimetableState): TimetableUiRow[] {
    const keys = new Set([...Object.keys(s.farm), ...Object.keys(s.ranch)]);
    return [...keys].map(key => {
        const f = s.farm[key];
        const r = s.ranch[key];
        return {
            gid: Number(key),
            name: (f && f.name) || (r && r.name) || '',
            farmRipeAt: f ? f.ripeAt : 0,
            farmHelpAt: f ? f.helpAt : 0,
            farmSeenAt: f ? f.seenAt : 0,
            farmVisitedAt: f ? f.visitedAt : 0,
            ranchReadyAt: r ? r.readyAt : 0,
            ranchSeenAt: r ? r.seenAt : 0,
            ranchVisitedAt: r ? r.visitedAt : 0,
        };
    });
}

/** 给前端：每位好友还多久可偷 / 要帮 / 牧场可偷（本地毫秒；worker 内） */
function snapshotForUi(): TimetableUiRow[] {
    return buildSnapshot(current());
}

/** 管理端（主进程）读某账号的时间表文件：worker 每次变化 5 秒内落盘 */
function readSnapshotForAccount(id: string): TimetableUiRow[] {
    try {
        const { readJsonFile } = require('./json-db');
        return buildSnapshot(sanitize(readJsonFile(stateFile(id), () => ({}))));
    } catch { return []; }
}

function resetTimetableRuntime(): void {
    farmTried.clear();
    ranchTried.clear();
    pagesTurned = 0;
    flushNow();
    loadedFor = null;
    state = emptyState();
}

module.exports = {
    FRIEND_ARRIVE_AFTER_MS,
    REVISIT_GAP_MS,
    PROBE_STALE_MS,
    PROBE_PER_SCAN,
    MAX_DUE_PER_BATCH,
    MISC_QUIET_WINDOW_MS,
    emptyState,
    nextMatureSec,
    nextHelpSecFromPlant,
    nextRanchReadyMs,
    applyFarmList,
    applyFarmLands,
    applyPushLands,
    applyRanch,
    listDueFarm,
    listDueRanch,
    nextFarmDueAt,
    nextRanchDueAt,
    markFarmVisiting,
    markRanchVisiting,
    pickProbes,
    shouldMiscWait,
    formatClock,
    formatRemain,
    isEnabled,
    scanIntervalMs,
    ownLeadMs,
    noteFarmList,
    noteFarmLands,
    notePushLands,
    noteRanch,
    takeDueFarm,
    takeDueRanch,
    farmDueTime,
    ranchDueTime,
    probeTargets,
    setBusyProbe,
    miscShouldWait,
    snapshotForUi,
    pickRanchProbes,
    pageTurnDelay,
    ranchProbeTargets,
    hasFarmProbeWork,
    hasRanchProbeWork,
    nextPageTurn,
    noteRanchProbeFailed,
    PROBE_MAX_PER_ROUND,
    FARM_EMPTY_RECHECK_MS,
    RANCH_EMPTY_RECHECK_MS,
    PROBE_RETRY_MS,
    REST_EVERY_PAGES,
    buildSnapshot,
    readSnapshotForAccount,
    flushNow,
    resetTimetableRuntime,
};
