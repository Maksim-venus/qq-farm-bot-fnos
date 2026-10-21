export {};
/**
 * [fnos-fork] 大小号协作（2026.10.21.3，本 fork 新增，上游没有）
 *
 * 只对「这是小号」且已选大号的账号生效，在上游好友巡查（friend/scheduler.ts checkFriends）
 * 算好访问计划之后做调整，不改上游的偷菜/帮忙/捣乱实现本身：
 *
 * - skipStealMaster「不偷大号的菜」：大号的 wantSteal 置为 false（只影响自动巡查；面板里对大号手动点「偷取」不受限）。
 * - badOnlyMaster「只给大号放捣乱」：
 *   - 其他好友一律不放草/放虫；
 *   - 大号：只要今日捣乱额度还有，就把大号加入本轮访问并放草/放虫（即使「自动捣乱」开关关着）；
 *     上游规则不变：每块未成熟的地我最多放 1 草 1 虫、每块地最多 2 个，额度共用 10003；
 *   - 帮大号时只帮「只缺水、没有草/虫」的地（帮忙协议 Farming 会把整块地的草、虫、缺水一起处理），草/虫留给大号自己清；
 *   - 为避免每轮都进大号农场，纯为捣乱的访问至少间隔 MASTER_BAD_INTERVAL_MS。
 * 配置在 accountConfigs.<id>.fnosAltAccount（skipStealMaster / badOnlyMaster），经 fnos-fork-config 的
 * store.getConfigSnapshot() 读取。日志标签「小号」。
 */

const MASTER_BAD_INTERVAL_MS = 10 * 60 * 1000;
const SKIP_LOG_INTERVAL_MS = 30 * 60 * 1000;

export interface AltCoopSettings {
    masterGid: number;
    masterName: string;
    skipSteal: boolean;
    badOnly: boolean;
}

let nextMasterBadAtMs = 0;
let lastSkipStealLogAt = 0;
let lastMissingLogAt = 0;

function resetFnosAltCoopRuntime(): void {
    nextMasterBadAtMs = 0;
    lastSkipStealLogAt = 0;
    lastMissingLogAt = 0;
}

/** 当前账号的大小号协作设置；不是小号、没选大号或两个选项都没开时返回 null。 */
function getAltCoopSettings(): AltCoopSettings | null {
    const { readFnosForkConfigs } = require('../fnos-fork-config');
    const { alt } = readFnosForkConfigs();
    if (!alt.enabled || !(alt.masterGid > 0)) return null;
    if (!alt.skipStealMaster && !alt.badOnlyMaster) return null;
    return { masterGid: alt.masterGid, masterName: alt.masterName, skipSteal: !!alt.skipStealMaster, badOnly: !!alt.badOnlyMaster };
}

function toInt(value: any): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function buildTarget(friend: any): any {
    const gid = toInt(friend && friend.gid);
    const plant = (friend && friend.plant) || null;
    const dryNum = plant ? toInt(plant.dry_num) : 0;
    const weedNum = plant ? toInt(plant.weed_num) : 0;
    const insectNum = plant ? toInt(plant.insect_num) : 0;
    return {
        gid,
        name: (friend && (friend.remark || friend.name)) || `GID:${gid}`,
        level: toInt(friend && friend.level),
        stealNum: plant ? toInt(plant.steal_plant_num) : 0,
        helpNum: dryNum + weedNum + insectNum,
        dryNum,
        weedNum,
        insectNum,
        wantSteal: false,
        wantHelp: false,
        wantBad: false,
    };
}

/**
 * 按大小号协作设置调整上游 buildFriendVisitPlan 的结果（就地修改并返回同一个 plan）。
 * badActive：本轮是否允许放草/放虫（非「只帮忙/只偷菜」的手动模式、今日额度未用完）。
 */
function adjustVisitPlanForAltCoop(plan: any, params: {
    coop: AltCoopSettings | null;
    friends: any[];
    blacklist?: Set<number> | null;
    badActive: boolean;
    badBudget: number;
    nowMs?: number;
    log?: (msg: string) => void;
}): any {
    const coop = params.coop;
    if (!coop || !plan || !Array.isArray(plan.visits)) return plan;
    const nowMs = params.nowMs || Date.now();
    const log = params.log || (() => {});
    const masterGid = coop.masterGid;
    const masterLabel = coop.masterName ? `${coop.masterName}(${masterGid})` : `GID ${masterGid}`;
    let visits: any[] = plan.visits.slice();

    if (coop.skipSteal) {
        for (const t of visits) {
            if (t.gid !== masterGid || !t.wantSteal) continue;
            t.wantSteal = false;
            if (nowMs - lastSkipStealLogAt >= SKIP_LOG_INTERVAL_MS) {
                lastSkipStealLogAt = nowMs;
                log(`大号 ${masterLabel} 有 ${t.stealNum} 块可偷，按「不偷大号的菜」跳过`);
            }
        }
    }

    if (coop.badOnly) {
        for (const t of visits) {
            if (t.gid !== masterGid) t.wantBad = false;
        }
        const blocked = !!(params.blacklist && params.blacklist.has(masterGid));
        if (params.badActive && params.badBudget > 0 && !blocked && nowMs >= nextMasterBadAtMs) {
            let target = visits.find(t => t.gid === masterGid);
            if (!target) {
                const friend = (Array.isArray(params.friends) ? params.friends : []).find(f => toInt(f && f.gid) === masterGid);
                if (friend) {
                    target = buildTarget(friend);
                    visits.push(target);
                } else if (nowMs - lastMissingLogAt >= SKIP_LOG_INTERVAL_MS) {
                    lastMissingLogAt = nowMs;
                    log(`「只给大号放捣乱」：好友列表里没有大号 ${masterLabel}，本轮不放`);
                }
            }
            if (target) {
                target.wantBad = true;
                nextMasterBadAtMs = nowMs + MASTER_BAD_INTERVAL_MS;
            }
        }
    }

    visits = visits.filter(t => t.wantSteal || t.wantHelp || t.wantBad);
    // 有偷/帮任务的先走，纯捣乱的排在后面（与上游一致）
    const primary = visits.filter(t => t.wantSteal || t.wantHelp);
    const badOnly = visits.filter(t => !t.wantSteal && !t.wantHelp);
    plan.visits = [...primary, ...badOnly];
    plan.stealCount = primary.filter(t => t.wantSteal).length;
    plan.helpCount = primary.filter(t => t.wantHelp).length;
    plan.badOnlyCount = badOnly.length;
    return plan;
}

/** 给 visitFriend 的额外选项：对大号强制捣乱、帮忙只浇水。 */
function getVisitOptionsForAltCoop(coop: AltCoopSettings | null, target: any): { forceBad?: boolean; helpWaterOnly?: boolean } {
    if (!coop || !coop.badOnly || !target || target.gid !== coop.masterGid) return {};
    return { forceBad: !!target.wantBad, helpWaterOnly: true };
}

module.exports = {
    MASTER_BAD_INTERVAL_MS,
    getAltCoopSettings,
    adjustVisitPlanForAltCoop,
    getVisitOptionsForAltCoop,
    resetFnosAltCoopRuntime,
};
