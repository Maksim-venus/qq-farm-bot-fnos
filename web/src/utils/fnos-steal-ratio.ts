/**
 * [fnos-fork] 在线期间来偷菜的自动删除（文件名沿用旧的 steal-ratio）
 *
 * 2026-11-23 起偷收比阈值 / 忽略申请 / Bark / 好友页筛选 / 自动删除已下架，
 * 旧配置里的这些字段读取时直接丢弃，只认 autoDeleteOnlineStealer。
 */

export interface FnosStealRatioConfig {
  /** 在线期间来偷菜的自动删除，默认关 */
  autoDeleteOnlineStealer: boolean
}

const DEFAULTS: FnosStealRatioConfig = {
  autoDeleteOnlineStealer: false,
}

export function fnosNormalizeStealRatio(input: unknown, fallback: FnosStealRatioConfig = DEFAULTS): FnosStealRatioConfig {
  const base = { ...DEFAULTS, ...(fallback || {}) }
  const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, any> : {}
  return {
    autoDeleteOnlineStealer: src.autoDeleteOnlineStealer !== undefined ? !!src.autoDeleteOnlineStealer : !!base.autoDeleteOnlineStealer,
  }
}
