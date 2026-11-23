export {};
/**
 * [fnos-fork] 本 fork 独有设置（大号/小号、图鉴、偷收比、自己收菜优先 / 空闲时只保留心跳）在 worker 内的统一读取与状态日志。
 * 大号/小号在「设置 → 大小号协作」栏目，图鉴在「设置 → 自动控制」。奶茶 fork 功能已于 2026-11-15 按用户要求下架。
 *
 * 2026.10.20.3 修复：之前两个功能都调用了 store 并不导出的 getAccountConfigSnapshot()，
 * 抛出的 TypeError 又被各自的 try/catch 吞掉，结果 worker 里永远读到「未开启」，
 * 小号照常收获且没有任何日志。现在统一走 store.getConfigSnapshot()
 * （与上游其它设置相同：worker 内按 FARM_ACCOUNT_ID 取本账号配置，运行中保存后
 * applyRuntimeConfigSnapshot → applyConfigSnapshot(persist:false) 立即可见），读取失败会写警告日志。
 */

export interface FnosForkConfigs {
    alt: { enabled: boolean; masterGid: number; masterName: string; holdForMaster: boolean; timeoutMinutes: number; skipStealMaster: boolean; badOnlyMaster: boolean };
    /** [fnos-fork] 2026-10-28 图鉴奖励自动领取 / 自动完成图鉴 */
    illustrated: { autoClaimRewards: boolean; autoComplete: boolean };
    /** [fnos-fork] 在线期间来偷菜的自动删除（旧偷收比设置已下架） */
    /** [fnos-fork] 2026-11-16 牧场：等大号、图鉴、轮换值守、好友牧场 */
    ranch: import('./ranch/fnos-ranch').FnosRanchConfig;
    stealRatio: {
        autoDeleteOnlineStealer: boolean;
    };
    /** [fnos-fork] 2026-11-16 自己收菜优先 / 空闲时只保留心跳（见 services/fnos-quiet-priority.ts） */
    quiet: { ownHarvestFirst: boolean; mergeWindowSec: number; idleKeepaliveOnly: boolean; idleMinMinutes: number; idleMaxMinutes: number; timetableSteal: boolean; friendScanMinutes: number; ownLeadSec: number };
    error: string;
}

let lastReadErrorLogAt = 0;

function readFnosForkConfigs(accountId?: string): FnosForkConfigs {
    const { normalizeFnosAltAccount } = require('./farm/fnos-alt-account');
    const { normalizeFnosIllustratedAuto } = require('./fnos-illustrated-auto');
    const { normalizeFnosStealRatio } = require('./friend/fnos-steal-ratio');
    const { normalizeFnosQuietPriority } = require('./fnos-quiet-priority');
    const { normalizeFnosRanch } = require('./ranch/fnos-ranch');
    try {
        const store = require('../models/store');
        const snapshot = store.getConfigSnapshot(accountId) || {};
        return {
            alt: normalizeFnosAltAccount(snapshot.fnosAltAccount),
            illustrated: normalizeFnosIllustratedAuto(snapshot.fnosIllustratedAuto),
            stealRatio: normalizeFnosStealRatio(snapshot.fnosStealRatio),
            quiet: normalizeFnosQuietPriority(snapshot.fnosQuietPriority),
            ranch: normalizeFnosRanch(snapshot.fnosRanch),
            error: '',
        };
    } catch (e: any) {
        const message = String(e && e.message ? e.message : e);
        if (Date.now() - lastReadErrorLogAt > 10 * 60 * 1000) {
            lastReadErrorLogAt = Date.now();
            try { require('../utils/utils').logWarn('系统', `读取 fork 设置（大号/小号、图鉴、在线偷菜删除）失败：${message}`, { module: 'system', event: 'fnos设置' }); } catch { /* ignore */ }
        }
        return { alt: normalizeFnosAltAccount(undefined), illustrated: normalizeFnosIllustratedAuto(undefined), stealRatio: normalizeFnosStealRatio(undefined), quiet: normalizeFnosQuietPriority(undefined), ranch: normalizeFnosRanch(undefined), error: message };
    }
}

function describeAlt(alt: FnosForkConfigs['alt']): string {
    if (!alt.enabled) return '小号模式未启用（本账号按普通账号收获）';
    if (!(alt.masterGid > 0)) return '小号模式已开启但未选择大号（照常收获），请到 设置 → 大小号协作 选择大号';
    const master = alt.masterName ? `${alt.masterName}(${alt.masterGid})` : `GID ${alt.masterGid}`;
    const coop = `${alt.skipStealMaster ? '不偷大号的菜' : '会偷大号的菜'}；${alt.badOnlyMaster ? '放草/放虫只对大号（帮大号时不除草除虫）' : '捣乱按「自动捣乱」设置'}`;
    // [fnos-fork] 「成熟作物先留给大号偷」开关
    if (alt.holdForMaster === false) {
        return `小号模式已启用，大号 ${master}；「成熟作物先留给大号偷」未开启，自动巡田正常收获自己的地；${coop}`;
    }
    const timeout = alt.timeoutMinutes > 0 ? `超时 ${alt.timeoutMinutes} 分钟（从本进程首次发现可收时算起）` : '不超时（一直等大号）';
    return `小号模式已启用，大号 ${master}，成熟作物先留给大号偷，${timeout}；自动巡田只收大号偷过的地，手动收获不受限；${coop}`;
}

function describeIllustrated(ill: FnosForkConfigs['illustrated']): string {
    return `图鉴奖励自动领取${ill.autoClaimRewards ? '已启用' : '未启用'}；自动完成图鉴${ill.autoComplete ? '已启用（会花金币买未收藏作物的种子并优先播种）' : '未启用'}`;
}

let lastStatusKey = '';

/**
 * 打印两项设置的当前状态。force=true 时总是打印（worker 登录完成时）；
 * 否则仅在设置与上次打印不同时打印（每次运行中保存配置后由 worker 调用）。
 */
function logFnosForkStatus(reason: string, force: boolean = false): boolean {
    const cfg = readFnosForkConfigs();
    if (cfg.error) return false;
    const key = JSON.stringify([cfg.alt, cfg.illustrated, cfg.stealRatio, cfg.quiet]);
    if (!force && key === lastStatusKey) return false;
    const first = lastStatusKey === '';
    lastStatusKey = key;
    // 首次下发配置（worker 刚启动、尚未登录）时不打印，等登录完成 force 打印，避免重复
    if (!force && first) return false;
    const { log } = require('../utils/utils');
    const prefix = reason ? `${reason}：` : '';
    log('小号', `${prefix}${describeAlt(cfg.alt)}`, { module: 'farm', event: '小号设置', result: cfg.alt.enabled ? 'enabled' : 'disabled', masterGid: cfg.alt.masterGid, holdForMaster: cfg.alt.holdForMaster, timeoutMinutes: cfg.alt.timeoutMinutes });
    if (force ? (cfg.illustrated.autoClaimRewards || cfg.illustrated.autoComplete) : true) log('图鉴', `${prefix}${describeIllustrated(cfg.illustrated)}`, { module: 'farm', event: '图鉴自动设置', result: cfg.illustrated.autoClaimRewards || cfg.illustrated.autoComplete ? 'enabled' : 'disabled' });
    // [fnos-fork] 在线偷菜删除：只在开启时或设置变化时打印
    const { describeFnosStealRatio } = require('./friend/fnos-steal-ratio');
    const stealOn = cfg.stealRatio.autoDeleteOnlineStealer;
    if (force ? stealOn : true) log('偷收比', `${prefix}${describeFnosStealRatio(cfg.stealRatio)}`, { module: 'friend', event: '偷收比设置', result: stealOn ? 'enabled' : 'disabled' });
    // [fnos-fork] 2026-11-16 自己收菜优先 / 空闲时只保留心跳：登录时只在开启时打印，设置变化时总是打印
    const { describeFnosQuietPriority } = require('./fnos-quiet-priority');
    if (force ? (cfg.quiet.ownHarvestFirst || cfg.quiet.idleKeepaliveOnly) : true) log('系统', `${prefix}${describeFnosQuietPriority(cfg.quiet)}`, { module: 'system', event: '收菜优先与空闲设置', ownHarvestFirst: cfg.quiet.ownHarvestFirst, idleKeepaliveOnly: cfg.quiet.idleKeepaliveOnly });
    return true;
}

/** worker 每次应用下发的配置后调用（worker.ts applyRuntimeConfig 中的 [fnos-fork] 挂钩）。 */
function onWorkerConfigApplied(): void {
    logFnosForkStatus('设置已更新');
    try { require('./fnos-quiet-priority').onFnosQuietConfigApplied(); } catch { /* ignore */ }
}

function resetFnosForkStatusLog(): void {
    lastStatusKey = '';
}

module.exports = {
    readFnosForkConfigs,
    logFnosForkStatus,
    onWorkerConfigApplied,
    resetFnosForkStatusLog,
    describeAlt,
    describeIllustrated,
};
