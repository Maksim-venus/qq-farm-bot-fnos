/**
 * [fnos-fork] 偷收比（2026-10-31）
 *
 * 与 core/src/services/friend/fnos-steal-ratio.ts、好友卡片「收偷比」同一公式：
 *   偷收比 = 生涯偷菜 ÷ 生涯收获 × 100%
 * 生涯收获为 0 且生涯偷菜 > 0 视为「只偷不收」（超过任意阈值）；两者都是 0 为 0%。
 * 「超过阈值」是严格大于。
 */

export interface FnosStealRatioConfig {
  thresholdPercent: number
  ignoreApplications: boolean
  listFilter: boolean
  barkOnSteal: boolean
  autoDelete: boolean
}

export interface FnosStealRatioInfo {
  percent: number
  infinite: boolean
  text: string
}

export type FnosStealFilterMode = 'all' | 'above' | 'below' | 'range'

const DEFAULTS: FnosStealRatioConfig = {
  thresholdPercent: 80,
  ignoreApplications: false,
  listFilter: false,
  barkOnSteal: false,
  autoDelete: false,
}

export function fnosNormalizeStealRatio(input: unknown, fallback: FnosStealRatioConfig = DEFAULTS): FnosStealRatioConfig {
  const base = { ...DEFAULTS, ...(fallback || {}) }
  const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, any> : {}
  const raw = src.thresholdPercent !== undefined ? Number(src.thresholdPercent) : base.thresholdPercent
  const rounded = Number.isFinite(raw) ? Math.round(raw) : 80
  const thresholdPercent = rounded >= 1 && rounded <= 100 ? rounded : (base.thresholdPercent || 80)
  const flag = (key: keyof FnosStealRatioConfig) => (src[key] !== undefined ? !!src[key] : !!base[key])
  return {
    thresholdPercent,
    ignoreApplications: flag('ignoreApplications'),
    listFilter: flag('listFilter'),
    barkOnSteal: flag('barkOnSteal'),
    autoDelete: flag('autoDelete'),
  }
}

export function fnosStealRatioInfo(harvest: unknown, steal: unknown): FnosStealRatioInfo {
  const h = Math.max(0, Math.floor(Number(harvest) || 0))
  const s = Math.max(0, Math.floor(Number(steal) || 0))
  if (h <= 0 && s <= 0)
    return { percent: 0, infinite: false, text: '0%' }
  if (h <= 0)
    return { percent: Number.POSITIVE_INFINITY, infinite: true, text: '只偷不收' }
  const percent = s / h * 100
  return { percent, infinite: false, text: `${percent.toFixed(1).replace(/\.0$/, '')}%` }
}

export function fnosStealRatioAbove(harvest: unknown, steal: unknown, thresholdPercent: number): boolean {
  const info = fnosStealRatioInfo(harvest, steal)
  if (info.infinite)
    return true
  return info.percent > thresholdPercent
}

/**
 * 好友列表筛选。还没读到生涯数据时，只有「全部」算命中，避免把未知好友误判成高或低。
 * 自定义区间含两端；只偷不收只在区间上限达到 100 时出现。
 */
export function fnosFriendMatchesStealFilter(
  career: { harvest?: number, steal?: number } | null | undefined,
  mode: FnosStealFilterMode,
  thresholdPercent: number,
  rangeMin: number,
  rangeMax: number,
): boolean {
  if (mode === 'all')
    return true
  if (!career)
    return false
  const info = fnosStealRatioInfo(career.harvest, career.steal)
  if (mode === 'above')
    return info.infinite || info.percent > thresholdPercent
  if (mode === 'below')
    return !info.infinite && info.percent <= thresholdPercent
  let min = Number(rangeMin)
  let max = Number(rangeMax)
  if (!Number.isFinite(min))
    min = 0
  if (!Number.isFinite(max))
    max = 100
  if (min > max)
    [min, max] = [max, min]
  if (info.infinite)
    return max >= 100
  return info.percent >= min && info.percent <= max
}
