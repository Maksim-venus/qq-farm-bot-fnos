// [fnos-fork] 2026-11-23 首页合并概览：农场 / 牧场各存一份概览快照（按账号持久化）。
// 当前所在空间用实时数据，另一边读这里的快照，不再额外实时查询游戏；每次读取到数据时由前端回写。
export {};
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 256 * 1024;
const SPACES = ['farm', 'ranch'];

function safeAccountId(accountId: unknown): string {
    return String(accountId || '').replace(/[^\w-]/g, '_').slice(0, 64);
}

function createOverviewCache(options: { dir?: string | (() => string), now?: () => number } = {}) {
    const now = typeof options.now === 'function' ? options.now : () => Date.now();

    function baseDir(): string {
        const d = typeof options.dir === 'function' ? options.dir() : options.dir;
        if (d) return d;
        const { getDataDir } = require('../config/runtime-paths');
        return path.join(getDataDir(), 'fnos-overview-cache');
    }

    function file(accountId: string): string {
        return path.join(baseDir(), `${safeAccountId(accountId)}.json`);
    }

    /** 读取失败、文件损坏都当作没有缓存。 */
    function get(accountId: string): { farm: any, ranch: any } {
        const empty = { farm: null, ranch: null };
        try {
            const parsed = JSON.parse(fs.readFileSync(file(accountId), 'utf8'));
            if (!parsed || typeof parsed !== 'object') return empty;
            return {
                farm: parsed.farm && typeof parsed.farm === 'object' ? parsed.farm : null,
                ranch: parsed.ranch && typeof parsed.ranch === 'object' ? parsed.ranch : null,
            };
        } catch {
            return empty;
        }
    }

    function set(accountId: string, space: string, snapshot: any): { updatedAt: number } {
        if (!SPACES.includes(space)) throw new Error('space 只能是 farm 或 ranch');
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('快照格式不对');
        if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BYTES) throw new Error('快照过大');
        const current = get(accountId);
        const updatedAt = now();
        const next: any = { ...current, [space]: { ...snapshot, updatedAt } };
        const target = file(accountId);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(next));
        fs.renameSync(tmp, target);
        return { updatedAt };
    }

    return { get, set };
}

let defaultCache: ReturnType<typeof createOverviewCache> | null = null;
function getOverviewCache(): ReturnType<typeof createOverviewCache> {
    if (!defaultCache) defaultCache = createOverviewCache();
    return defaultCache;
}

module.exports = { createOverviewCache, getOverviewCache, OVERVIEW_CACHE_SPACES: SPACES };
