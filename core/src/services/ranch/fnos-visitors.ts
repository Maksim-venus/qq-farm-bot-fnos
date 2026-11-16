export {};
/**
 * [fnos-fork] 2026-11-17 牧场最近访客：好友来我牧场做了什么。
 *
 * 数据来源：gamepb.interactpb.InteractService.InteractRecords，请求带 scene_id=2（官方客户端在牧场里就是这么调的，
 * 抓包 1116-3 #229、1116-6 #301/#302、1116-7 #229/#230；农场访客是同一接口不带场景）。回包仍是 InteractRecord 列表，
 * 字段 9（from_type）在牧场记录里恒为 2。action_type 对照（1116-6/7 两次回包共 19 条，只有这四种）：
 *   13 = 偷取产物：带 crop_id（牧场产物，如 1060002 鸭蛋）与 crop_count（如 9）——字段语义明确；
 *    3 = 放蚊子（捣乱）：与农场 3=捣乱同号，带 times；推断，未能用自己的操作时间点核对；
 *    9 = 帮忙（清理便便/蚊子或帮生产）：带 times，最常见；推断，具体是清理还是帮生产无法从字段区分；
 *   11 = 抚摸动物：带字段 22 = 动物 id（如 60002 鸭）；推断。
 * 给好友加牧草在两次回包里都没有出现，暂时无法确认是否会被记录（出现未知类型时按「互动（类型 N）」原样展示）。
 *
 * 存储：每次读取都与本账号已存的记录合并（按 时间+访客+类型+次数+物品 去重），存 data/fnos-ranch-visitors/<账号>.json，
 * 最多保留 500 条，所以服务器只给最近一段时间时，较早的记录也还在。
 */

const path = require('node:path');
const { getDataFile } = require('../../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../json-db');

const MAX_RECORDS = 500;

const RANCH_ACTIONS: Record<number, { key: string; label: string; certain: boolean }> = {
    13: { key: 'steal', label: '偷取', certain: true },
    3: { key: 'bad', label: '放蚊子', certain: false },
    9: { key: 'help', label: '帮忙', certain: false },
    11: { key: 'stroke', label: '抚摸', certain: false },
};

function num(value: any): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value.toNumber === 'function') return value.toNumber();
    return Number(value) || 0;
}

function itemName(id: number): string {
    if (!id) return '';
    try {
        const dto = require('./model').itemDto({ id, count: 0 });
        return dto && dto.name && !/^物品\s*\d+$/.test(dto.name) ? String(dto.name) : '';
    } catch { return ''; }
}

function itemImage(id: number): string {
    if (!id) return '';
    try { return String(require('./model').itemDto({ id, count: 0 }).image || ''); } catch { return ''; }
}

/** 纯函数：把一条牧场 InteractRecord 转成与农场访客记录同形的对象（多 actionKey / productName / animalName）。 */
function normalizeRanchVisitor(record: any, resolve: (id: number) => string = itemName): any {
    const actionType = num(record && record.action_type);
    const visitorGid = num(record && record.visitor_gid);
    const serverTimeSec = num(record && record.server_time);
    const productId = num(record && record.crop_id);
    const productCount = num(record && record.crop_count);
    const times = num(record && record.times);
    const animalId = num(record && record.fnos_animal_id);
    const meta = RANCH_ACTIONS[actionType];
    const productName = resolve(productId) || (productId ? `物品 ${productId}` : '');
    const animalName = resolve(animalId) || (animalId ? `动物 ${animalId}` : '');
    let detail: string;
    if (actionType === 13) detail = productName ? `偷取 ${productName}${productCount > 0 ? ` × ${productCount}` : ''}` : '偷取产物';
    else if (actionType === 3) detail = times > 1 ? `放蚊子 ${times} 次` : '放蚊子';
    else if (actionType === 9) detail = times > 1 ? `帮忙 ${times} 次（清理或帮生产）` : '帮忙（清理或帮生产）';
    else if (actionType === 11) detail = animalName ? `抚摸 ${animalName}` : '抚摸动物';
    else detail = `互动（类型 ${actionType}）${times > 1 ? ` ${times} 次` : ''}`;
    const nick = String((record && record.nick) || '').trim() || `GID:${visitorGid}`;
    return {
        key: `${serverTimeSec}-${visitorGid}-${actionType}-${times}-${productId}-${productCount}-${animalId}`,
        serverTimeSec,
        serverTimeMs: serverTimeSec > 0 ? serverTimeSec * 1000 : 0,
        actionType,
        actionKey: meta ? meta.key : 'other',
        actionLabel: meta ? meta.label : '互动',
        actionCertain: meta ? meta.certain : false,
        visitorGid,
        nick,
        avatarUrl: String((record && record.avatar_url) || '').trim(),
        level: num(record && record.level),
        times,
        productId,
        productName: productId ? productName : '',
        productCount,
        productImage: productId ? itemImage(productId) : '',
        animalId,
        animalName: animalId ? animalName : '',
        actionDetail: detail,
    };
}

/** 纯函数：新旧记录按 key 合并，新的覆盖旧的，按时间倒序，最多 max 条。 */
function mergeVisitors(stored: any[], fresh: any[], max: number = MAX_RECORDS): any[] {
    const map = new Map<string, any>();
    for (const row of Array.isArray(stored) ? stored : []) if (row && row.key) map.set(String(row.key), row);
    for (const row of Array.isArray(fresh) ? fresh : []) if (row && row.key) map.set(String(row.key), row);
    return [...map.values()]
        .sort((a, b) => (num(b.serverTimeSec) - num(a.serverTimeSec)) || (num(b.visitorGid) - num(a.visitorGid)) || (num(b.actionType) - num(a.actionType)))
        .slice(0, Math.max(1, max));
}

function storeFile(accountId: string = String(process.env.FARM_ACCOUNT_ID || 'default')): string {
    const safe = String(accountId || 'default').replace(/[^\w-]/g, '_');
    return getDataFile(path.join('fnos-ranch-visitors', `${safe}.json`));
}

function readStored(accountId?: string): any[] {
    const data = readJsonFile(storeFile(accountId), () => ({}));
    return Array.isArray(data && data.records) ? data.records : [];
}

function writeStored(records: any[], accountId?: string): void {
    try {
        const fs = require('node:fs');
        const file = storeFile(accountId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeJsonFileAtomic(file, { version: 1, savedAt: Date.now(), records });
    } catch (e: any) {
        try { require('../../utils/utils').logWarn('牧场', `保存牧场访客记录失败：${e.message}`, { module: 'ranch', event: 'fnos牧场' }); } catch { /* ignore */ }
    }
}

/** 需在牧场场景（ranch inScene）里调用：拉服务器记录 → 与本账号已存记录合并 → 写回 → 返回合并后的列表。 */
async function fetchRanchVisitors(): Promise<any[]> {
    const { rpc } = require('./transport');
    const reply: any = await rpc('interactRecords', { scene_id: 2 });
    const fresh = (Array.isArray(reply && reply.records) ? reply.records : []).map((record: any) => normalizeRanchVisitor(record));
    const merged = mergeVisitors(readStored(), fresh);
    writeStored(merged);
    return merged;
}

module.exports = { RANCH_ACTIONS, MAX_RECORDS, normalizeRanchVisitor, mergeVisitors, fetchRanchVisitors, readStored, storeFile };
