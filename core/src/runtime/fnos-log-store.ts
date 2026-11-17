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
    ranch_fnosHelpProduce: 'helpProduce',
    ranch_fnosFeedFriend: 'feedFriend',
};

function safeAccountId(accountId: unknown): string {
    return String(accountId || '').replace(/[^\w-]/g, '_').slice(0, 64);
}

function pad(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/** 本机时区的日期 YYYY-MM-DD（飞牛上即北京时间）。 */
export function fnosLocalDate(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptySummary(date: string): FnosRanchDaySummary {
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
    summaryDirty: boolean;
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

    function summaryFile(accId: string): string {
        return path.join(accountDir(accId), 'ranch-summary.json');
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

    function pruneSummary(summary: Record<string, FnosRanchDaySummary>): void {
        const dates = Object.keys(summary).sort();
        while (dates.length > summaryDays) delete summary[dates.shift() as string];
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
            summaryDirty: false,
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
        try {
            const file = summaryFile(accId);
            if (fs.existsSync(file)) {
                const parsed = JSON.parse(String(fs.readFileSync(file, 'utf8')));
                if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') state.summary = parsed.days;
            }
        } catch {
            state.summary = {};
        }
        accounts.set(accId, state);
        return state;
    }

    function updateSummary(state: AccountState, entry: any): void {
        const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};
        const event = String(meta.event || '');
        const result = String(meta.result || entry.result || '').toLowerCase();
        const date = fnosLocalDate(Number(entry.ts) || now());
        const day = state.summary[date] || emptySummary(date);
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
                try {
                    fs.mkdirSync(accountDir(accId), { recursive: true });
                    const file = summaryFile(accId);
                    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ days: state.summary }, null, 2));
                    fs.renameSync(`${file}.tmp`, file);
                } catch {
                    // ignore
                }
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
        if (space === 'ranch') updateSummary(state, entry);
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

    function getRanchSummary(accountId: unknown, days = 1): FnosRanchDaySummary[] {
        const state = ensure(accountId);
        if (!state) return [];
        const out: FnosRanchDaySummary[] = [];
        const today = now();
        for (let i = 0; i < Math.max(1, Math.min(summaryDays, Number(days) || 1)); i++) {
            const date = fnosLocalDate(today - i * 24 * 3600 * 1000);
            out.push(state.summary[date] ? JSON.parse(JSON.stringify(state.summary[date])) : emptySummary(date));
        }
        return out;
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

    return { record, getLogs, getBalanced, getRanchSummary, clear, flush, caps, spaceOf };
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
