/**
 * [fnos-fork] 运行日志分类：把「偷菜日志」「报错日志」从全量运行日志里拆出来。
 *
 * - 全量日志（globalLogs）仍由上游维护，最多 1000 条，不受影响；
 * - 这里为每个分类各维护一个独立的内存环形缓冲（各 1000 条），
 *   所以分类视图不会被刷屏的普通日志挤掉；
 * - 只在内存里，不写任何新文件（app.log 仍是上游原样）。
 *
 * 分类规则（偷菜）：
 *   1. meta.event = 照顾好友 且 meta.actions 里有「偷N」；
 *   2. meta.event = 好友巡查循环 且 meta.summary 里有「偷N」；
 *   3. meta.event = 偷菜后出售 / 小号留菜（小号把菜留给大号偷，即「被偷」相关）；
 *   4. 其他日志：msg 命中 偷N / 偷取 / 偷菜 / 被偷 / 偷大号。
 * 分类规则（报错）：
 *   - 错误级：tag = 错误，或 result（meta.result 或顶层 result）为 error / failed / fail；
 *   - 警告级：isWarn = true，或 tag = 警告。
 */

export type FnosLogCategory = 'steal' | 'error';
export type FnosErrorLevel = 'error' | 'warn' | '';

export const FNOS_LOG_CATEGORY_CAP = 1000;

const STEAL_EVENTS = new Set(['偷菜后出售', '小号留菜']);
const STEAL_ACTION_RE = /^偷\d/;
const STEAL_MSG_RE = /偷\d|偷取|偷菜|被偷|偷大号/;
const ERROR_RESULTS = new Set(['error', 'failed', 'fail']);

const buffers: Record<FnosLogCategory, any[]> = {
    steal: [],
    error: [],
};

function metaOf(entry: any): Record<string, any> {
    const meta = entry && entry.meta;
    return meta && typeof meta === 'object' ? meta : {};
}

function hasStealAction(list: unknown): boolean {
    return Array.isArray(list) && list.some(item => STEAL_ACTION_RE.test(String(item || '')));
}

export function isFnosStealLog(entry: any): boolean {
    if (!entry || typeof entry !== 'object') return false;
    const meta = metaOf(entry);
    const event = String(meta.event || '');
    if (event === '照顾好友') return hasStealAction(meta.actions);
    if (event === '好友巡查循环') return hasStealAction(meta.summary);
    if (STEAL_EVENTS.has(event)) return true;
    return STEAL_MSG_RE.test(String(entry.msg || ''));
}

export function getFnosErrorLevel(entry: any): FnosErrorLevel {
    if (!entry || typeof entry !== 'object') return '';
    const meta = metaOf(entry);
    const tag = String(entry.tag || '');
    const result = String(meta.result || entry.result || '').toLowerCase();
    if (tag === '错误' || ERROR_RESULTS.has(result)) return 'error';
    if (entry.isWarn === true || tag === '警告') return 'warn';
    return '';
}

export function classifyFnosLog(entry: any): FnosLogCategory[] {
    const out: FnosLogCategory[] = [];
    if (isFnosStealLog(entry)) out.push('steal');
    if (getFnosErrorLevel(entry)) out.push('error');
    return out;
}

/** 在日志进入 globalLogs 的同一处调用，按分类放进各自的环形缓冲。 */
export function recordFnosLogCategories(entry: any): void {
    for (const category of classifyFnosLog(entry)) {
        const list = buffers[category];
        list.push(entry);
        if (list.length > FNOS_LOG_CATEGORY_CAP) list.splice(0, list.length - FNOS_LOG_CATEGORY_CAP);
    }
}

export function normalizeFnosLogCategory(value: unknown): FnosLogCategory | '' {
    const v = String(value || '').trim().toLowerCase();
    return v === 'steal' || v === 'error' ? v : '';
}

export function normalizeFnosErrorLevel(value: unknown): FnosErrorLevel {
    const v = String(value || '').trim().toLowerCase();
    return v === 'error' || v === 'warn' ? v : '';
}

/** 取某个分类的缓冲；accountId 为空表示全部账号。 */
export function getFnosCategoryLogs(category: FnosLogCategory, accountId = '', level: FnosErrorLevel = ''): any[] {
    const list = buffers[category] || [];
    const accId = String(accountId || '');
    return list.filter((entry) => {
        if (accId && String(entry.accountId || '') !== accId) return false;
        if (category === 'error' && level && getFnosErrorLevel(entry) !== level) return false;
        return true;
    });
}

/** 与「清空日志」同步：accountId 为空清空全部，否则只清该账号。 */
export function clearFnosCategoryLogs(accountId = ''): void {
    const accId = String(accountId || '');
    for (const category of Object.keys(buffers) as FnosLogCategory[]) {
        if (!accId) {
            buffers[category].length = 0;
            continue;
        }
        buffers[category] = buffers[category].filter(entry => String(entry.accountId || '') !== accId);
    }
}

/** /api/logs 的查询参数：category=steal|error，level=error|warn（仅报错分类生效）。 */
export function fnosLogQueryOptions(query: any): { fnosCategory: FnosLogCategory | '', fnosLevel: FnosErrorLevel } {
    const q = query && typeof query === 'object' ? query : {};
    return {
        fnosCategory: normalizeFnosLogCategory(q.category),
        fnosLevel: normalizeFnosErrorLevel(q.level),
    };
}
