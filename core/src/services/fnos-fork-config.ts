export {};
/**
 * [fnos-fork] 本 fork 独有设置（大号/小号、奶茶活动自动雇佣、奶茶收益领取/种子兑换）在 worker 内的统一读取与状态日志。
 * 这些设置都在「设置 → 活动设置」栏目。
 *
 * 2026.10.20.3 修复：之前两个功能都调用了 store 并不导出的 getAccountConfigSnapshot()，
 * 抛出的 TypeError 又被各自的 try/catch 吞掉，结果 worker 里永远读到「未开启」，
 * 小号照常收获、奶茶也从不雇佣且没有任何日志。现在统一走 store.getConfigSnapshot()
 * （与上游其它设置相同：worker 内按 FARM_ACCOUNT_ID 取本账号配置，运行中保存后
 * applyRuntimeConfigSnapshot → applyConfigSnapshot(persist:false) 立即可见），读取失败会写警告日志。
 */

export interface FnosForkConfigs {
    alt: { enabled: boolean; masterGid: number; masterName: string; timeoutMinutes: number };
    tea: { enabled: boolean; durationId: number; talentId: number; allowRobots: boolean; autoWork: boolean; workType: number };
    daily: { autoClaim: boolean; autoExchangeSeed: boolean };
    error: string;
}

let lastReadErrorLogAt = 0;

function readFnosForkConfigs(accountId?: string): FnosForkConfigs {
    const { normalizeFnosAltAccount } = require('./farm/fnos-alt-account');
    const { normalizeFnosMilkTeaAutoHire } = require('./fnos-milk-tea-auto-hire');
    const { normalizeFnosMilkTeaDaily } = require('./fnos-milk-tea-daily');
    try {
        const store = require('../models/store');
        const snapshot = store.getConfigSnapshot(accountId) || {};
        return {
            alt: normalizeFnosAltAccount(snapshot.fnosAltAccount),
            tea: normalizeFnosMilkTeaAutoHire(snapshot.fnosMilkTeaAutoHire),
            daily: normalizeFnosMilkTeaDaily(snapshot.fnosMilkTeaDaily),
            error: '',
        };
    } catch (e: any) {
        const message = String(e && e.message ? e.message : e);
        if (Date.now() - lastReadErrorLogAt > 10 * 60 * 1000) {
            lastReadErrorLogAt = Date.now();
            try { require('../utils/utils').logWarn('系统', `读取活动设置（大号/小号、奶茶）失败：${message}`, { module: 'system', event: 'fnos设置' }); } catch { /* ignore */ }
        }
        return { alt: normalizeFnosAltAccount(undefined), tea: normalizeFnosMilkTeaAutoHire(undefined), daily: normalizeFnosMilkTeaDaily(undefined), error: message };
    }
}

const DURATION_TEXT: Record<number, string> = { 0: '随机', 1: '4 小时', 2: '12 小时', 3: '24 小时' };
const TALENT_TEXT: Record<number, string> = { 0: '不限', 9001: '金牌销售', 9002: '金牌宣传', 9003: '金牌服务', 9004: '默默搬砖' };

function describeAlt(alt: FnosForkConfigs['alt']): string {
    if (!alt.enabled) return '小号模式未启用（本账号按普通账号收获）';
    if (!(alt.masterGid > 0)) return '小号模式已开启但未选择大号（照常收获），请到 设置 → 活动设置 选择大号';
    const master = alt.masterName ? `${alt.masterName}(${alt.masterGid})` : `GID ${alt.masterGid}`;
    const timeout = alt.timeoutMinutes > 0 ? `超时 ${alt.timeoutMinutes} 分钟（从本进程首次发现可收时算起）` : '不超时（一直等大号）';
    return `小号模式已启用，大号 ${master}，${timeout}；自动巡田只收大号偷过的地，手动收获不受限`;
}

const WORK_TEXT: Record<number, string> = { 0: '随机（宣传推广/花式摇杯/招牌试饮）', 1: '宣传推广', 2: '花式摇杯', 3: '招牌试饮', 4: '划水摸鱼', 5: '申请涨薪' };

function describeWork(tea: FnosForkConfigs['tea']): string {
    return tea.autoWork ? `被雇佣时自动做工作事项已启用（${WORK_TEXT[tea.workType] || tea.workType}）` : '被雇佣时自动做工作事项未启用';
}

function describeTea(tea: FnosForkConfigs['tea'], alt: FnosForkConfigs['alt']): string {
    return `${describeHire(tea, alt)}；${describeWork(tea)}`;
}

function describeHire(tea: FnosForkConfigs['tea'], alt: FnosForkConfigs['alt']): string {
    if (!tea.enabled) return '奶茶自动雇佣未启用';
    if (alt.enabled && alt.masterGid > 0) {
        return `奶茶自动雇佣已启用（小号模式：优先雇大号 24 小时，否则随机好友 4 小时；职业 ${TALENT_TEXT[tea.talentId] || tea.talentId}；${tea.allowRobots ? '允许' : '不'}雇系统员工），会消耗奶茶券`;
    }
    return `奶茶自动雇佣已启用（时长 ${DURATION_TEXT[tea.durationId] || tea.durationId}；职业 ${TALENT_TEXT[tea.talentId] || tea.talentId}；${tea.allowRobots ? '允许' : '不'}雇系统员工），会消耗奶茶券`;
}

function describeDaily(daily: FnosForkConfigs['daily']): string {
    return `奶茶收益每小时自动领取${daily.autoClaim ? '已启用' : '未启用'}；森野黄金芽种子每日兑换${daily.autoExchangeSeed ? '已启用（会消耗兑换商店货币）' : '未启用'}`;
}

let lastStatusKey = '';

/**
 * 打印两项设置的当前状态。force=true 时总是打印（worker 登录完成时）；
 * 否则仅在设置与上次打印不同时打印（每次运行中保存配置后由 worker 调用）。
 */
function logFnosForkStatus(reason: string, force: boolean = false): boolean {
    const cfg = readFnosForkConfigs();
    if (cfg.error) return false;
    const key = JSON.stringify([cfg.alt, cfg.tea, cfg.daily]);
    if (!force && key === lastStatusKey) return false;
    const first = lastStatusKey === '';
    lastStatusKey = key;
    // 首次下发配置（worker 刚启动、尚未登录）时不打印，等登录完成 force 打印，避免重复
    if (!force && first) return false;
    const { log } = require('../utils/utils');
    const prefix = reason ? `${reason}：` : '';
    log('小号', `${prefix}${describeAlt(cfg.alt)}`, { module: 'farm', event: '小号设置', result: cfg.alt.enabled ? 'enabled' : 'disabled', masterGid: cfg.alt.masterGid, timeoutMinutes: cfg.alt.timeoutMinutes });
    log('奶茶雇佣', `${prefix}${describeTea(cfg.tea, cfg.alt)}`, { module: 'activity', event: '奶茶自动雇佣设置', result: cfg.tea.enabled ? 'enabled' : 'disabled' });
    log('奶茶收益', `${prefix}${describeDaily(cfg.daily)}`, { module: 'activity', event: '奶茶收益与兑换设置', result: cfg.daily.autoClaim || cfg.daily.autoExchangeSeed ? 'enabled' : 'disabled' });
    return true;
}

/** worker 每次应用下发的配置后调用（worker.ts applyRuntimeConfig 中的 [fnos-fork] 挂钩）。 */
function onWorkerConfigApplied(): void {
    logFnosForkStatus('设置已更新');
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
    describeTea,
    describeDaily,
};
