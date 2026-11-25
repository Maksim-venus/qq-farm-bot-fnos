/**
 * [fnos-fork] 2026-11-17 运行日志按账号、按空间（农场 / 牧场）分开存，并持久化到 data/。
 *
 * 背景：上游的 globalLogs 是所有账号共用的 1000 条内存环形缓冲，三个号一起跑时只能存 50 分钟左右，
 * 农场 / 好友日志占九成以上，牧场日志很快就被挤掉；重启后也全部丢失。
 *
 * 这里为每个账号的农场、牧场各维护一份独立缓冲：
 *   - 农场默认 20000 条、牧场默认 3000 条，另外只保留最近 3 天；
 *   - 追加写入 data/fnos-run-logs/<账号>/<farm|ranch>.jsonl（每 2 秒批量写一次），
 *     文件行数超过上限 + 1000 时按内存内容重写，所以文件大小有上限；
 *   - 启动后第一次用到某账号时从文件读回，重启后日志还在；
 *   - 牧场另记每日汇总 data/fnos-run-logs/<账号>/ranch-summary.json（最近 7 天）：
 *     偷了几次、偷到什么、收获 / 出售 / 帮好友 / 放蚊子各几次——不受条数上限影响。
 *   - 农场同样记每日汇总 data/fnos-run-logs/<账号>/farm-summary.json（最近 7 天）：
 *     自己收获 / 施肥 / 种植 / 铲除，以及偷好友、帮忙除草除虫浇水、放草放虫。
 *   两边的「今日」都按北京时间（Asia/Shanghai，游戏日切）分桶，过 0 点即算新的一天。
 * 「清空日志」同时清空该账号的内存与文件（每日汇总保留）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { isFnosRanchLog } = require('./fnos-log-categories');

export type FnosStoreSpace = 'farm' | 'ranch';

export interface FnosLogStoreOptions {
    dir?: string | (() => string);
    farmCap?: number;
    ranchCap?: number;
    maxAgeMs?: number;
    flushMs?: number;
    summaryDays?: number;
    now?: () => number;
}

export interface FnosRanchDaySummary {
    date: string;
    steal: { times: number, friends: string[], items: Record<string, number> };
    harvest: number;
    produce: number;
    sell: number;
    addGrass: number;
    clean: number;
    buy: number;
    cleanFriend: number;
    putMosquito: number;
    stroke: number;
    helpProduce: number;
    feedFriend: number;
    errors: number;
    updatedAt: number;
}

export interface FnosFarmDaySummary {
    date: string;
    steal: { times: number, friends: string[], items: Record<string, number> };
    harvest: number;
    fertilize: number;
    plant: number;
    shovel: number;
    helpWeed: number;
    helpBug: number;
    helpWater: number;
    putWeed: number;
    putBug: number;
    errors: number;
    updatedAt: number;
}

export const FNOS_LOG_STORE_DEFAULTS = {
    farmCap: 20000,
    ranchCap: 3000,
    maxAgeMs: 3 * 24 * 3600 * 1000,
    flushMs: 2000,
    summaryDays: 7,
};

const SUMMARY_COUNTERS: Record<string, keyof FnosRanchDaySummary> = {
    ranch_harvest: 'harvest',
    ranch_produce: 'produce',
    ranch_sell: 'sell',
    ranch_addGrass: 'addGrass',
    ranch_clean: 'clean',
    ranch_buy: 'buy',
    ranch_place: 'buy',
    ranch_cleanFriend: 'cleanFriend',
    ranch_putMosquito: 'putMosquito',
    ranch_fnosBad: 'putMosquito',
    ranch_stroke: 'stroke',
    ranch_produceFriend: 'helpProduce', // [fnos-fork] 2026-11-25 帮忙生产只剩上游 produceFriend
    ranch_fnosHelpProduce: 'helpProduce', // 旧版 fork 帮忙生产（历史日志）
    ranch_fnosFeedFriend: 'feedFriend',
};

/** 农场计数：只统计成功的（result=ok），数量优先用 meta.count（块数 / 次数）。 */
const FARM_SUMMARY_COUNTERS: Record<string, keyof FnosFarmDaySummary> = {
    收获作物: 'harvest',
    施肥后收获作物: 'harvest',
    施肥: 'fertilize',
    常规施肥: 'fertilize',
    多季节施肥: 'fertilize',
    一键施肥: 'fertilize',
    手动施肥: 'fertilize',
    种植种子: 'plant',
    铲除植物: 'shovel',
};

function safeAccountId(accountId: unknown): string {
    return String(accountId || '').replace(/[^\w-]/g, '_').slice(0, 64);
}

/** 「今日农场 / 今日牧场」与游戏日切使用的时区：北京时间。 */
export const FNOS_SUMMARY_TIME_ZONE = 'Asia/Shanghai';

let beijingDateFormatter: Intl.DateTimeFormat | null = null;

function beijingDateParts(ms: number): Record<string, string> {
    if (!beijingDateFormatter) {
        beijingDateFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: FNOS_SUMMARY_TIME_ZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
    }
    const out: Record<string, string> = {};
    for (const part of beijingDateFormatter.formatToParts(new Date(ms))) {
        if (part.type !== 'literal') out[part.type] = part.value;
    }
    return out;
}

/** 北京时间的日期 YYYY-MM-DD（不依赖进程时区）。 */
export function fnosLocalDate(ms: number): string {
    const p = beijingDateParts(ms);
    return `${p.year}-${p.month}-${p.day}`;
}

/** 距下一北京时间 0 点的毫秒数；刚好落在 0 点时返回一整天。 */
export function fnosMsUntilNextBeijingMidnight(nowMs: number): number {
    const today = fnosLocalDate(nowMs);
    const todayStart = Date.parse(`${today}T00:00:00+08:00`);
    const next = Number.isFinite(todayStart) ? todayStart + 24 * 3600 * 1000 : nowMs + 24 * 3600 * 1000;
    const remain = next - nowMs;
    return remain > 0 ? remain : 24 * 3600 * 1000;
}

function emptyRanchSummary(date: string): FnosRanchDaySummary {
    return {
        date,
        steal: { times: 0, friends: [], items: {} },
        harvest: 0,
        produce: 0,
        sell: 0,
        addGrass: 0,
        clean: 0,
        buy: 0,
        cleanFriend: 0,
        putMosquito: 0,
        stroke: 0,
        helpProduce: 0,
        feedFriend: 0,
        errors: 0,
        updatedAt: 0,
    };
}

function emptyFarmSummary(date: string): FnosFarmDaySummary {
    return {
        date,
        steal: { times: 0, friends: [], items: {} },
        harvest: 0,
        fertilize: 0,
        plant: 0,
        shovel: 0,
        helpWeed: 0,
        helpBug: 0,
        helpWater: 0,
        putWeed: 0,
        putBug: 0,
        errors: 0,
        updatedAt: 0,
    };
}

/** 「好友名：获得 鸭蛋 ×3、巨大鹅蛋 ×1」→ { friend, items }。好友名里可能有冒号，按最后一个「：获得」切分。 */
export function parseFnosRanchStealMessage(msg: unknown): { friend: string, items: Record<string, number> } {
    const text = String(msg || '');
    const idx = text.lastIndexOf('：获得');
    const friend = idx > 0 ? text.slice(0, idx).trim() : '';
    const body = idx >= 0 ? text.slice(idx + 3) : text;
    const items: Record<string, number> = {};
    const re = /([^、，,\s×]+(?:\s[^、，,\s×]+)*)\s*×\s*(\d+)/g;
    let m: RegExpExecArray | null = re.exec(body);
    while (m) {
        const name = m[1].trim();
        const count = Number(m[2]) || 0;
        if (name && count > 0) items[name] = (items[name] || 0) + count;
        m = re.exec(body);
    }
    return { friend, items };
}

export interface FnosFarmCareParse {
    friend: string;
    stealTimes: number;
    items: Record<string, number>;
    helpWeed: number;
    helpBug: number;
    helpWater: number;
    putWeed: number;
    putBug: number;
}

function addItemGuess(items: Record<string, number>, names: string[], times: number): void {
    const clean = names.map(n => n.trim()).filter(Boolean);
    if (!clean.length || times <= 0) return;
    if (clean.length === 1) {
        items[clean[0]] = (items[clean[0]] || 0) + times;
        return;
    }
    // 日志里多种作物只保留去重后的名字，份数均分（除不尽时前面的多种 1）
    const base = Math.floor(times / clean.length);
    let rest = times - base * clean.length;
    for (const name of clean) {
        const n = base + (rest > 0 ? 1 : 0);
        if (rest > 0) rest -= 1;
        if (n > 0) items[name] = (items[name] || 0) + n;
    }
}

function applyFarmCareAction(out: FnosFarmCareParse, action: string): void {
    const text = String(action || '').trim();
    if (!text) return;
    const steal = text.match(/^偷(\d+)(?:\(([^)]*)\))?$/);
    if (steal) {
        const times = Number(steal[1]) || 0;
        out.stealTimes += times;
        addItemGuess(out.items, steal[2] ? steal[2].split('/') : [], times);
        return;
    }
    const help = text.match(/^一键务农\d+块\/\d+项\(([^)]*)\)$/);
    if (help) {
        for (const part of help[1].split('/')) {
            const m = part.trim().match(/^(草|虫|水)(\d+)$/);
            if (!m) continue;
            const n = Number(m[2]) || 0;
            if (m[1] === '草') out.helpWeed += n;
            else if (m[1] === '虫') out.helpBug += n;
            else out.helpWater += n;
        }
        return;
    }
    const weed = text.match(/^放草(\d+)$/);
    if (weed) { out.putWeed += Number(weed[1]) || 0; return; }
    const bug = text.match(/^放虫(\d+)$/);
    if (bug) { out.putBug += Number(bug[1]) || 0; }
}

/** 「张三: 偷3(白萝卜/胡萝卜)/一键务农2块/3项(草1/水2)/放草1」或 meta.actions。 */
export function parseFnosFarmCareMessage(msg: unknown, meta: any = null): FnosFarmCareParse {
    const out: FnosFarmCareParse = {
        friend: '', stealTimes: 0, items: {}, helpWeed: 0, helpBug: 0, helpWater: 0, putWeed: 0, putBug: 0,
    };
    const info = meta && typeof meta === 'object' ? meta : {};
    if (typeof info.friendName === 'string' && info.friendName.trim()) out.friend = info.friendName.trim();
    const actions = Array.isArray(info.actions) ? info.actions.map((a: any) => String(a || '')) : [];
    const text = String(msg || '');
    if (!actions.length && text) {
        const idx = text.indexOf(': ');
        if (idx > 0 && !out.friend) out.friend = text.slice(0, idx).trim();
        const body = idx >= 0 ? text.slice(idx + 2) : text;
        // 一键务农片段本身含「/」，按已知动作切开
        const parts = body.split(/(?=\/?(?:偷\d+|一键务农\d+块|放草\d+|放虫\d+|同气连枝))/).map(s => s.replace(/^\//, '').trim()).filter(Boolean);
        actions.push(...parts);
    }
    for (const action of actions) applyFarmCareAction(out, action);
    return out;
}

function cleanEntry(entry: any): any {
    if (!entry || typeof entry !== 'object') return null;
    const { _searchText, ...rest } = entry;
    return rest;
}

function withSearchText(entry: any): any {
    if (entry && typeof entry === 'object' && !entry._searchText) {
        entry._searchText = `${entry.msg || ''} ${entry.tag || ''} ${JSON.stringify(entry.meta || {})}`.toLowerCase();
    }
    return entry;
}

interface AccountState {
    loaded: boolean;
    farm: any[];
    ranch: any[];
    pending: Record<FnosStoreSpace, string[]>;
    fileLines: Record<FnosStoreSpace, number>;
    summary: Record<string, FnosRanchDaySummary>;
    farmSummary: Record<string, FnosFarmDaySummary>;
    summaryDirty: boolean;
    farmSummaryDirty: boolean;
}

export function createFnosLogStore(options: FnosLogStoreOptions = {}) {
    const caps: Record<FnosStoreSpace, number> = {
        farm: Math.max(1, Number(options.farmCap) || FNOS_LOG_STORE_DEFAULTS.farmCap),
        ranch: Math.max(1, Number(options.ranchCap) || FNOS_LOG_STORE_DEFAULTS.ranchCap),
    };
    const maxAgeMs = Math.max(60000, Number(options.maxAgeMs) || FNOS_LOG_STORE_DEFAULTS.maxAgeMs);
    const flushMs = Math.max(0, Number(options.flushMs ?? FNOS_LOG_STORE_DEFAULTS.flushMs));
    const summaryDays = Math.max(1, Number(options.summaryDays) || FNOS_LOG_STORE_DEFAULTS.summaryDays);
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const accounts = new Map<string, AccountState>();
    let flushTimer: NodeJS.Timeout | null = null;

    function baseDir(): string {
        const d = typeof options.dir === 'function' ? options.dir() : options.dir;
        if (d) return d;
        const { getDataDir } = require('../config/runtime-paths');
        return path.join(getDataDir(), 'fnos-run-logs');
    }

    function accountDir(accId: string): string {
        return path.join(baseDir(), safeAccountId(accId));
    }

    function spaceFile(accId: string, space: FnosStoreSpace): string {
        return path.join(accountDir(accId), `${space}.jsonl`);
    }

    function summaryFile(accId: string, space: FnosStoreSpace = 'ranch'): string {
        return path.join(accountDir(accId), space === 'farm' ? 'farm-summary.json' : 'ranch-summary.json');
    }

    function readJsonl(file: string): any[] {
        try {
            if (!fs.existsSync(file)) return [];
            const out: any[] = [];
            for (const line of String(fs.readFileSync(file, 'utf8')).split('\n')) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed && typeof parsed === 'object') out.push(parsed);
                } catch {
                    // 跳过写了一半的坏行
                }
            }
            return out;
        } catch {
            return [];
        }
    }

    function trimList(list: any[], space: FnosStoreSpace): any[] {
        const cutoff = now() - maxAgeMs;
        let start = 0;
        while (start < list.length && (Number(list[start] && list[start].ts) || 0) < cutoff) start++;
        const kept = start > 0 ? list.slice(start) : list;
        return kept.length > caps[space] ? kept.slice(kept.length - caps[space]) : kept;
    }

    function rewriteFile(accId: string, space: FnosStoreSpace, list: any[]): void {
        try {
            fs.mkdirSync(accountDir(accId), { recursive: true });
            const file = spaceFile(accId, space);
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, list.map(e => JSON.stringify(cleanEntry(e))).join('\n') + (list.length ? '\n' : ''));
            fs.renameSync(tmp, file);
        } catch {
            // 写盘失败不影响内存日志
        }
    }

    function pruneSummary(summary: Record<string, { date?: string }>): void {
        const dates = Object.keys(summary).sort();
        while (dates.length > summaryDays) delete summary[dates.shift() as string];
    }

    function addCount(day: Record<string, any>, key: string, raw: unknown): void {
        const n = Number(raw);
        day[key] = (Number(day[key]) || 0) + (Number.isFinite(n) && n > 0 ? n : 1);
    }

    function loadSummaryFile(accId: string, space: FnosStoreSpace): Record<string, any> {
        try {
            const file = summaryFile(accId, space);
            if (!fs.existsSync(file)) return {};
            const parsed = JSON.parse(String(fs.readFileSync(file, 'utf8')));
            if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') return parsed.days;
        } catch {
            // 坏文件当空汇总
        }
        return {};
    }

    function writeSummaryFile(accId: string, space: FnosStoreSpace, days: Record<string, any>): void {
        try {
            fs.mkdirSync(accountDir(accId), { recursive: true });
            const file = summaryFile(accId, space);
            fs.writeFileSync(`${file}.tmp`, JSON.stringify({ days }, null, 2));
            fs.renameSync(`${file}.tmp`, file);
        } catch {
            // ignore
        }
    }

    function ensure(accountId: unknown): AccountState | null {
        const accId = String(accountId || '').trim();
        if (!accId) return null;
        let state = accounts.get(accId);
        if (state) return state;
        state = {
            loaded: true,
            farm: [],
            ranch: [],
            pending: { farm: [], ranch: [] },
            fileLines: { farm: 0, ranch: 0 },
            summary: {},
            farmSummary: {},
            summaryDirty: false,
            farmSummaryDirty: false,
        };
        for (const space of ['farm', 'ranch'] as FnosStoreSpace[]) {
            const raw = readJsonl(spaceFile(accId, space));
            const sorted = raw.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
            const kept = trimList(sorted, space).map(withSearchText);
            state[space] = kept;
            state.fileLines[space] = raw.length;
            if (raw.length !== kept.length) {
                rewriteFile(accId, space, kept);
                state.fileLines[space] = kept.length;
            }
        }
        state.summary = loadSummaryFile(accId, 'ranch');
        state.farmSummary = loadSummaryFile(accId, 'farm');
        accounts.set(accId, state);
        return state;
    }

    function updateRanchSummary(state: AccountState, entry: any): void {
        const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};
        const event = String(meta.event || '');
        const result = String(meta.result || entry.result || '').toLowerCase();
        const date = fnosLocalDate(Number(entry.ts) || now());
        const day = state.summary[date] || emptyRanchSummary(date);
        let touched = false;
        if (entry.tag === '错误' || result === 'error' || result === 'failed') {
            day.errors += 1;
            touched = true;
        }
        else if (result === 'ok' || result === 'success' || result === '') {
            if (event === 'ranch_steal') {
                const { friend, items } = parseFnosRanchStealMessage(entry.msg);
                day.steal.times += 1;
                if (friend && !day.steal.friends.includes(friend)) day.steal.friends.push(friend);
                for (const [name, count] of Object.entries(items)) day.steal.items[name] = (day.steal.items[name] || 0) + count;
                touched = true;
            }
            else if (SUMMARY_COUNTERS[event] && result === 'ok') {
                const key = SUMMARY_COUNTERS[event] as string;
                (day as any)[key] = (Number((day as any)[key]) || 0) + 1;
                touched = true;
            }
        }
        if (!touched) return;
        day.updatedAt = now();
        state.summary[date] = day;
        pruneSummary(state.summary);
        state.summaryDirty = true;
    }

    function updateFarmSummary(state: AccountState, entry: any): void {
        const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};
        const event = String(meta.event || '');
        const result = String(meta.result || entry.result || '').toLowerCase();
        const date = fnosLocalDate(Number(entry.ts) || now());
        const day = state.farmSummary[date] || emptyFarmSummary(date);
        let touched = false;
        if (entry.tag === '错误' || result === 'error' || result === 'failed') {
            day.errors += 1;
            touched = true;
        }
        else if (result === 'ok' || result === 'success') {
            if (event === '照顾好友') {
                const care = parseFnosFarmCareMessage(entry.msg, meta);
                if (care.stealTimes > 0) {
                    day.steal.times += care.stealTimes;
                    if (care.friend && !day.steal.friends.includes(care.friend)) day.steal.friends.push(care.friend);
                    for (const [name, count] of Object.entries(care.items)) day.steal.items[name] = (day.steal.items[name] || 0) + count;
                    touched = true;
                }
                for (const key of ['helpWeed', 'helpBug', 'helpWater', 'putWeed', 'putBug'] as const) {
                    if (care[key] > 0) {
                        day[key] += care[key];
                        touched = true;
                    }
                }
            }
            else if (FARM_SUMMARY_COUNTERS[event]) {
                addCount(day as any, FARM_SUMMARY_COUNTERS[event] as string, meta.count);
                touched = true;
            }
        }
        if (!touched) return;
        day.updatedAt = now();
        state.farmSummary[date] = day;
        pruneSummary(state.farmSummary);
        state.farmSummaryDirty = true;
    }

    function flush(): void {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        for (const [accId, state] of accounts) {
            for (const space of ['farm', 'ranch'] as FnosStoreSpace[]) {
                const lines = state.pending[space];
                if (!lines.length) continue;
                state.pending[space] = [];
                if (state.fileLines[space] + lines.length > caps[space] + 1000) {
                    rewriteFile(accId, space, state[space]);
                    state.fileLines[space] = state[space].length;
                    continue;
                }
                try {
                    fs.mkdirSync(accountDir(accId), { recursive: true });
                    fs.appendFileSync(spaceFile(accId, space), `${lines.join('\n')}\n`);
                    state.fileLines[space] += lines.length;
                } catch {
                    // ignore
                }
            }
            if (state.summaryDirty) {
                state.summaryDirty = false;
                writeSummaryFile(accId, 'ranch', state.summary);
            }
            if (state.farmSummaryDirty) {
                state.farmSummaryDirty = false;
                writeSummaryFile(accId, 'farm', state.farmSummary);
            }
        }
    }

    function scheduleFlush(): void {
        if (flushMs === 0) {
            flush();
            return;
        }
        if (flushTimer) return;
        flushTimer = setTimeout(flush, flushMs);
        if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
    }

    function spaceOf(entry: any): FnosStoreSpace {
        return isFnosRanchLog(entry) ? 'ranch' : 'farm';
    }

    /** worker 日志进入 globalLogs 的同一处调用。 */
    function record(entry: any): void {
        if (!entry || typeof entry !== 'object') return;
        const state = ensure(entry.accountId);
        if (!state) return;
        const space = spaceOf(entry);
        const list = state[space];
        list.push(withSearchText(entry));
        if (list.length > caps[space]) list.splice(0, list.length - caps[space]);
        state.pending[space].push(JSON.stringify(cleanEntry(entry)));
        if (space === 'ranch') updateRanchSummary(state, entry);
        else updateFarmSummary(state, entry);
        scheduleFlush();
    }

    /** 取某账号日志；space 为空 / all 时农场、牧场按时间合并。 */
    function getLogs(accountId: unknown, space: unknown = ''): any[] {
        const state = ensure(accountId);
        if (!state) return [];
        if (space === 'farm') return state.farm.slice();
        if (space === 'ranch') return state.ranch.slice();
        return state.farm.concat(state.ranch).sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    }

    /** 农场、牧场各取最后 perSpace 条再按时间合并（「全部」视图用，避免一边把另一边挤掉）。 */
    function getBalanced(list: { farm: any[], ranch: any[] }, perSpace: number): any[] {
        const n = Math.max(1, perSpace);
        return list.farm.slice(-n).concat(list.ranch.slice(-n)).sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    }

    function daysForQuery(days: unknown): number {
        return Math.max(1, Math.min(summaryDays, Number(days) || 1));
    }

    function collectDays<T>(map: Record<string, T>, empty: (date: string) => T, days = 1): T[] {
        const out: T[] = [];
        const today = now();
        for (let i = 0; i < daysForQuery(days); i++) {
            const date = fnosLocalDate(today - i * 24 * 3600 * 1000);
            out.push(map[date] ? JSON.parse(JSON.stringify(map[date])) : empty(date));
        }
        return out;
    }

    function getRanchSummary(accountId: unknown, days = 1): FnosRanchDaySummary[] {
        const state = ensure(accountId);
        if (!state) return [];
        return collectDays(state.summary, emptyRanchSummary, days);
    }

    function getFarmSummary(accountId: unknown, days = 1): FnosFarmDaySummary[] {
        const state = ensure(accountId);
        if (!state) return [];
        return collectDays(state.farmSummary, emptyFarmSummary, days);
    }

    function clear(accountId: unknown = ''): void {
        const accId = String(accountId || '').trim();
        const targets = accId ? [accId] : Array.from(accounts.keys());
        for (const id of targets) {
            const state = ensure(id);
            if (!state) continue;
            for (const space of ['farm', 'ranch'] as FnosStoreSpace[]) {
                state[space] = [];
                state.pending[space] = [];
                state.fileLines[space] = 0;
                rewriteFile(id, space, []);
            }
        }
    }

    return { record, getLogs, getBalanced, getRanchSummary, getFarmSummary, clear, flush, caps, spaceOf };
}

let defaultStore: ReturnType<typeof createFnosLogStore> | null = null;

export function getFnosLogStore(): ReturnType<typeof createFnosLogStore> {
    if (!defaultStore) {
        defaultStore = createFnosLogStore();
        process.once('exit', () => {
            try {
                defaultStore && defaultStore.flush();
            } catch {
                // ignore
            }
        });
    }
    return defaultStore;
}

/** 测试用：替换默认实例。 */
export function setFnosLogStoreForTest(store: ReturnType<typeof createFnosLogStore> | null): void {
    defaultStore = store;
}
