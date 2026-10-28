/**
 * [fnos-fork] 2026-10-28 奶茶自动制作 / 自动领工资、图鉴奖励自动领取 / 自动完成图鉴：前端纯函数
 * （读取回包补默认值、卡片上的说明文字）。接口见 core/src/controllers/admin/fnos-fork-routes.ts。
 */

export interface FnosMilkTeaExtra { autoCraft: boolean, craftGoldenCheese: boolean, autoClaimWages: boolean }
export interface FnosIllustratedAuto { autoClaimRewards: boolean, autoComplete: boolean }

export const FNOS_MILK_TEA_EXTRA_DEFAULT: FnosMilkTeaExtra = { autoCraft: false, craftGoldenCheese: false, autoClaimWages: false }
export const FNOS_ILLUSTRATED_AUTO_DEFAULT: FnosIllustratedAuto = { autoClaimRewards: false, autoComplete: false }

function bool(src: any, key: string, fallback: boolean): boolean {
  return src && typeof src === 'object' && src[key] !== undefined ? !!src[key] : fallback
}

export function fnosNormalizeMilkTeaExtra(input: unknown): FnosMilkTeaExtra {
  const d = FNOS_MILK_TEA_EXTRA_DEFAULT
  return {
    autoCraft: bool(input, 'autoCraft', d.autoCraft),
    craftGoldenCheese: bool(input, 'craftGoldenCheese', d.craftGoldenCheese),
    autoClaimWages: bool(input, 'autoClaimWages', d.autoClaimWages),
  }
}

export function fnosNormalizeIllustratedAuto(input: unknown): FnosIllustratedAuto {
  const d = FNOS_ILLUSTRATED_AUTO_DEFAULT
  return {
    autoClaimRewards: bool(input, 'autoClaimRewards', d.autoClaimRewards),
    autoComplete: bool(input, 'autoComplete', d.autoComplete),
  }
}

/** 自动制作奶茶的当前效果说明。 */
export function fnosCraftHint(cfg: FnosMilkTeaExtra): string {
  if (!cfg.autoCraft)
    return '未开启：背包里的森野果实不会被自动做成奶茶。'
  return cfg.craftGoldenCheese
    ? '会把背包里所有可做奶茶的果实（含森野黄金芽 → 金露云酪）做成奶茶。'
    : '会把背包里可做奶茶的果实做成奶茶，森野黄金芽保留不做（不做金露云酪）。'
}
