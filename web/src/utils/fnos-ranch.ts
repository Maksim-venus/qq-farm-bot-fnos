/**
 * [fnos-fork] 2026-11-16 牧场增强（fnosRanch）与农场「最后 X 块地只种牧草」（fnosGrassLands）：前端纯函数（读取回包补默认值、夹取范围）。
 * 后端对应 core/src/services/ranch/fnos-ranch.ts、core/src/services/farm/fnos-grass-lands.ts，随 /api/settings/save 保存。
 */

export interface FnosRanch {
  altHold: boolean
  altHoldFallbackMinutes: number
  illustratedAutoClaim: boolean
  illustratedAutoComplete: boolean
  mugeAutoClaim: boolean
  friendFeed: boolean
  /** [fnos-fork] 2026-11-17 加草来源：warehouse = 农场仓库牧草（默认）；gold = 金币 */
  friendFeedSource: 'warehouse' | 'gold'
  friendFeedPerTime: number
  friendFeedGoldKeep: number
  friendHelpProduce: boolean
}

export const FNOS_RANCH_DEFAULT: FnosRanch = {
  altHold: true,
  altHoldFallbackMinutes: 60,
  illustratedAutoClaim: true, // [fnos-fork] 2026-11-17 牧场图鉴 / 巨大图鉴奖励自动领取默认开启
  illustratedAutoComplete: false,
  mugeAutoClaim: true, // [fnos-fork] 牧歌初启成长手册奖励自动领取默认开
  friendFeed: false,
  friendFeedSource: 'warehouse',
  friendFeedPerTime: 10,
  friendFeedGoldKeep: 10000,
  friendHelpProduce: false,
}

const RANGES: Partial<Record<keyof FnosRanch, [number, number]>> = {
  altHoldFallbackMinutes: [5, 720],
  friendFeedPerTime: [1, 500],
  friendFeedGoldKeep: [0, 999999999],
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(String(value), 10)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

export function fnosNormalizeRanch(input: unknown): FnosRanch {
  const src: Record<string, any> = input && typeof input === 'object' ? input as Record<string, any> : {}
  const out: any = {}
  for (const key of Object.keys(FNOS_RANCH_DEFAULT) as (keyof FnosRanch)[]) {
    const d = FNOS_RANCH_DEFAULT[key]
    const range = RANGES[key]
    if (range)
      out[key] = clamp(src[key] ?? d, range[0], range[1], d as number)
    else if (key === 'friendFeedSource') // [fnos-fork] 2026-11-17 旧配置缺字段 → 仓库牧草
      out[key] = src[key] === 'gold' ? 'gold' : 'warehouse'
    else out[key] = src[key] !== undefined ? !!src[key] : d
  }
  return out as FnosRanch
}

export interface FnosGrassLands { count: number, autoBuy: boolean }

export const FNOS_GRASS_LANDS_DEFAULT: FnosGrassLands = { count: 0, autoBuy: true }

export function fnosNormalizeGrassLands(input: unknown): FnosGrassLands {
  const src: Record<string, any> = input && typeof input === 'object' ? input as Record<string, any> : {}
  return {
    count: clamp(src.count ?? 0, 0, 24, 0),
    autoBuy: src.autoBuy !== undefined ? !!src.autoBuy : true,
  }
}
