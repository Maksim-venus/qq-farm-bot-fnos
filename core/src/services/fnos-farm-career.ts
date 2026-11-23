// [fnos-fork] 2026-11-23 首页概览的农场生涯：游戏生涯接口 CareerInfoGet 里自己的累计收获（total_harvest_count）和累计偷菜（total_steal_count）。
// 农场每轮巡查最多拉一次（默认间隔 4 分钟，失败也算一次），拿到后交给概览缓存（fnos-overview-hooks → 主进程写盘）。
export {};

const FARM_CAREER_REFRESH_MS = 4 * 60_000;
let farmCareerRefreshAt = 0;

async function refreshFarmCareer(now: number = Date.now(), minIntervalMs: number = FARM_CAREER_REFRESH_MS): Promise<boolean> {
    if (now - farmCareerRefreshAt < minIntervalMs) return false;
    farmCareerRefreshAt = now;
    try {
        const gid = require('../utils/network').getUserState().gid;
        if (!gid) return false;
        const career = await require('./career').getCareerInfoOrNull(gid);
        if (!career) return false;
        require('../runtime/fnos-overview-hooks').emitOverviewData('farmCareer', { harvest: career.harvest, steal: career.steal });
        return true;
    } catch {
        return false;
    }
}

function resetFarmCareerRefreshForTest(): void { farmCareerRefreshAt = 0; }

module.exports = { refreshFarmCareer, resetFarmCareerRefreshForTest };
