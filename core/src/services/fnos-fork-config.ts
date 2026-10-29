export {};
/**
 * [fnos-fork] 本 fork 独有设置（大号/小号、奶茶活动自动雇佣、奶茶收益领取/种子兑换）在 worker 内的统一读取与状态日志。
 * 大号/小号在「设置 → 大小号协作」栏目（2026.10.21.3 起独立），奶茶相关在「设置 → 活动设置」。
 *
 * 2026.10.20.3 修复：之前两个功能都调用了 store 并不导出的 getAccountConfigSnapshot()，
 * 抛出的 TypeError 又被各自的 try/catch 吞掉，结果 worker 里永远读到「未开启」，
 * 小号照常收获、奶茶也从不雇佣且没有任何日志。现在统一走 store.getConfigSnapshot()
 * （与上游其它设置相同：worker 内按 FARM_ACCOUNT_ID 取本账号配置，运行中保存后
 * applyRuntimeConfigSnapshot → applyConfigSnapshot(persist:false) 立即可见），读取失败会写警告日志。
 */

export interface FnosForkConfigs {
    alt: { enabled: boolean; masterGid: number; masterName: string; holdForMaster: boolean; timeoutMinutes: number; skipStealMaster: boolean; badOnlyMaster: boolean };
    tea: {
        enabled: boolean; durationId: number; priorityFriends: Array<{ gid: number; name: string }>; // [fnos-fork] 2026-10-27 多个优先雇佣人
        priorityGid: number; priorityName: string; priorityConfigured: boolean;
        talentId: number; allowRobots: boolean; autoWork: boolean; workType: number;
    };
    daily: { autoClaim: boolean; autoExchangeSeed: boolean; seedExchange: Array<{ id: number; enabled: boolean }> }; // [fnos-fork] 需求 27 种子列表
    /** [fnos-fork] 2026-10-28 奶茶自动制作 / 自动领工资 */
    extra: { autoCraft: boolean; craftGoldenCheese: boolean; autoClaimWages: boolean; autoUpgradeShop: boolean }; // [fnos-fork] 需求 27 店铺自动升级
    /** [fnos-fork] 2026-10-28 图鉴奖励自动领取 / 自动完成图鉴 */
    illustrated: { autoClaimRewards: boolean; autoComplete: boolean };
    error: string;
}

let lastReadErrorLogAt = 0;

function readFnosForkConfigs(accountId?: string): FnosForkConfigs {
    const { normalizeFnosAltAccount } = require('./farm/fnos-alt-account');
    const { normalizeFnosMilkTeaAutoHire } = require('./fnos-milk-tea-auto-hire');
    const { normalizeFnosMilkTeaDaily } = require('./fnos-milk-tea-daily');
    const { normalizeFnosMilkTeaExtra } = require('./fnos-milk-tea-extra');
    const { normalizeFnosIllustratedAuto } = require('./fnos-illustrated-auto');
    try {
        const store = require('../models/store');
        const snapshot = store.getConfigSnapshot(accountId) || {};
        return {
            alt: normalizeFnosAltAccount(snapshot.fnosAltAccount),
            tea: normalizeFnosMilkTeaAutoHire(snapshot.fnosMilkTeaAutoHire),
            daily: normalizeFnosMilkTeaDaily(snapshot.fnosMilkTeaDaily),
            extra: normalizeFnosMilkTeaExtra(snapshot.fnosMilkTeaExtra),
            illustrated: normalizeFnosIllustratedAuto(snapshot.fnosIllustratedAuto),
            error: '',
        };
    } catch (e: any) {
        const message = String(e && e.message ? e.message : e);
        if (Date.now() - lastReadErrorLogAt > 10 * 60 * 1000) {
            lastReadErrorLogAt = Date.now();
            try { require('../utils/utils').logWarn('系统', `读取活动设置（大号/小号、奶茶）失败：${message}`, { module: 'system', event: 'fnos设置' }); } catch { /* ignore */ }
        }
        return { alt: normalizeFnosAltAccount(undefined), tea: normalizeFnosMilkTeaAutoHire(undefined), daily: normalizeFnosMilkTeaDaily(undefined), extra: normalizeFnosMilkTeaExtra(undefined), illustrated: normalizeFnosIllustratedAuto(undefined), error: message };
    }
}

const DURATION_TEXT: Record<number, string> = { 0: '随机', 1: '4 小时', 2: '12 小时', 3: '24 小时' };
const TALENT_TEXT: Record<number, string> = { 0: '不限', 9001: '金牌销售', 9002: '金牌宣传', 9003: '金牌服务', 9004: '默默搬砖' };

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

const WORK_TEXT: Record<number, string> = { 0: '随机（宣传推广/花式摇杯/招牌试饮）', 1: '宣传推广', 2: '花式摇杯', 3: '招牌试饮', 4: '划水摸鱼', 5: '申请涨薪' };

function describeWork(tea: FnosForkConfigs['tea']): string {
    return tea.autoWork ? `被雇佣时自动做工作事项已启用（${WORK_TEXT[tea.workType] || tea.workType}）` : '被雇佣时自动做工作事项未启用';
}

function describeTea(tea: FnosForkConfigs['tea'], alt: FnosForkConfigs['alt']): string {
    return `${describeHire(tea, alt)}；${describeWork(tea)}`;
}

function describeHire(tea: FnosForkConfigs['tea'], alt: FnosForkConfigs['alt']): string {
    if (!tea.enabled) return '奶茶自动雇佣未启用';
    const eff = require('./fnos-milk-tea-auto-hire').resolveEffectiveHireConfig(tea, alt);
    const common = `雇佣时长 ${DURATION_TEXT[eff.durationId] || eff.durationId}；职业 ${TALENT_TEXT[eff.talentId] || eff.talentId}；${eff.allowRobots ? '允许' : '不'}雇系统员工`;
    // [fnos-fork] 2026-10-27 多个优先雇佣人按顺序列出
    const friends: Array<{ gid: number; name: string }> = eff.priorityFriends || [];
    if (friends.length > 0) {
        const who = friends.map(f => (f.name ? `${f.name}(${f.gid})` : `GID ${f.gid}`)).join(' → ');
        const rest = friends.length > 1 ? '按顺序优先雇佣，都不空闲时随机雇其他好友' : '否则随机雇其他好友';
        return `奶茶自动雇佣已启用（优先雇佣人 ${who}，${rest}${eff.migratedFromAlt ? '，沿用旧版小号设置' : ''}；${common}），会消耗奶茶券`;
    }
    return `奶茶自动雇佣已启用（未指定优先雇佣人，随机雇好友；${common}），会消耗奶茶券`;
}

function describeDaily(daily: FnosForkConfigs['daily']): string {
    // [fnos-fork] 需求 27：列出勾选的森野种子（按兑换顺序）
    const { FNOS_EXCHANGE_SEEDS } = require('./fnos-milk-tea-daily');
    const names = (daily.seedExchange || []).filter(v => v.enabled).map(v => (FNOS_EXCHANGE_SEEDS.find((s: any) => s.id === v.id) || { name: `物品 #${v.id}` }).name);
    const exchange = !daily.autoExchangeSeed ? '森野种子每日兑换未启用'
        : names.length === 1 && names[0] === '森野黄金芽种子' ? '森野黄金芽种子每日兑换已启用（按最大数量，会消耗兑换商店货币）'
            : names.length ? `森野种子每日兑换已启用（按顺序：${names.join(' → ')}，按最大数量，会消耗兑换商店货币）` : '森野种子每日兑换已启用，但没有勾选种子';
    return `奶茶收益每小时自动领取${daily.autoClaim ? '已启用' : '未启用'}；${exchange}`;
}

function describeExtra(extra: FnosForkConfigs['extra']): string {
    const craft = extra.autoCraft
        ? `奶茶自动制作已启用（${extra.craftGoldenCheese ? '包括金露云酪' : '不做金露云酪，只做其他奶茶'}，会消耗背包里的对应果实）`
        : '奶茶自动制作未启用';
    return `${craft}；奶茶工资自动领取${extra.autoClaimWages ? '已启用' : '未启用'}；店铺自动升级${extra.autoUpgradeShop ? '已启用' : '未启用'}`;
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
    const key = JSON.stringify([cfg.alt, cfg.tea, cfg.daily, cfg.extra, cfg.illustrated]);
    if (!force && key === lastStatusKey) return false;
    const first = lastStatusKey === '';
    lastStatusKey = key;
    // 首次下发配置（worker 刚启动、尚未登录）时不打印，等登录完成 force 打印，避免重复
    if (!force && first) return false;
    const { log } = require('../utils/utils');
    const prefix = reason ? `${reason}：` : '';
    log('小号', `${prefix}${describeAlt(cfg.alt)}`, { module: 'farm', event: '小号设置', result: cfg.alt.enabled ? 'enabled' : 'disabled', masterGid: cfg.alt.masterGid, holdForMaster: cfg.alt.holdForMaster, timeoutMinutes: cfg.alt.timeoutMinutes });
    log('奶茶雇佣', `${prefix}${describeTea(cfg.tea, cfg.alt)}`, { module: 'activity', event: '奶茶自动雇佣设置', result: cfg.tea.enabled ? 'enabled' : 'disabled' });
    log('奶茶收益', `${prefix}${describeDaily(cfg.daily)}`, { module: 'activity', event: '奶茶收益与兑换设置', result: cfg.daily.autoClaim || cfg.daily.autoExchangeSeed ? 'enabled' : 'disabled' });
    // [fnos-fork] 2026-10-28：只在开启时或设置变化时打印，避免登录时多两行「未启用」
    const extraOn = cfg.extra.autoCraft || cfg.extra.autoClaimWages || cfg.extra.autoUpgradeShop; // [fnos-fork] 需求 27
    if (force ? extraOn : true) log('奶茶制作', `${prefix}${describeExtra(cfg.extra)}`, { module: 'activity', event: '奶茶制作与工资设置', result: extraOn ? 'enabled' : 'disabled' });
    if (force ? (cfg.illustrated.autoClaimRewards || cfg.illustrated.autoComplete) : true) log('图鉴', `${prefix}${describeIllustrated(cfg.illustrated)}`, { module: 'farm', event: '图鉴自动设置', result: cfg.illustrated.autoClaimRewards || cfg.illustrated.autoComplete ? 'enabled' : 'disabled' });
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
    describeExtra,
    describeIllustrated,
};
