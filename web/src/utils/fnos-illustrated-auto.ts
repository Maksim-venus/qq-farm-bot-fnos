/**
 * [fnos-fork] 2026-10-28 图鉴奖励自动领取 / 自动完成图鉴：前端纯函数（读取回包补默认值）。
 * 2026-11-15 起卡片在「设置 → 自动控制」，字段 fnosIllustratedAuto 随 /api/settings/save 一起保存（字段与持久化不变）。
 */

export interface FnosIllustratedAuto { autoClaimRewards: boolean, autoComplete: boolean }

// [fnos-fork] 2026-11-17 图鉴奖励自动领取默认开启（与后端一致）
export const FNOS_ILLUSTRATED_AUTO_DEFAULT: FnosIllustratedAuto = { autoClaimRewards: true, autoComplete: false }

function bool(src: any, key: string, fallback: boolean): boolean {
  return src && typeof src === 'object' && src[key] !== undefined ? !!src[key] : fallback
}

export function fnosNormalizeIllustratedAuto(input: unknown): FnosIllustratedAuto {
  const d = FNOS_ILLUSTRATED_AUTO_DEFAULT
  return {
    autoClaimRewards: bool(input, 'autoClaimRewards', d.autoClaimRewards),
    autoComplete: bool(input, 'autoComplete', d.autoComplete),
  }
}
