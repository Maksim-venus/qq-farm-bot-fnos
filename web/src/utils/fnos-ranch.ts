/**
 * [fnos-fork] 2026-11-16 牧场增强（fnosRanch）与农场「最后 X 块地只种牧草」（fnosGrassLands）：前端纯函数（读取回包补默认值、夹取范围）。
 * 后端对应 core/src/services/ranch/fnos-ranch.ts、core/src/services/farm/fnos-grass-lands.ts，随 /api/settings/save 保存。
 */

export interface FnosRanch {
  rotation: boolean
  rotationIdleMinutes: number
  rotationMinGapSeconds: number
  altHold: boolean
  altHoldFallbackMinutes: number
  illustratedAutoClaim: boolean
  illustratedAutoComplete: boolean
  friendSteal: boolean
  friendClean: boolean
  friendMosquito: boolean
  friendFeed: boolean
  friendFeedPerTime: number
  friendFeedKeep: number
  friendHelpProduce: boolean
  friendPutMosquito: boolean
  friendPutPerFriend: number
  friendIntervalMinutes: number
  friendMaxPerPatrol: number
  friendDailyVisitLimit: number
}

export const FNOS_RANCH_DEFAULT: FnosRanch = {
  rotation: true,
  rotationIdleMinutes: 1,
  rotationMinGapSeconds: 30,
  altHold: true,
  altHoldFallbackMinutes: 60,
  illustratedAutoClaim: false,
  illustratedAutoComplete: false,
  friendSteal: false,
  friendClean: false,
  friendMosquito: false,
  friendFeed: false,
  friendFeedPerTime: 10,
  friendFeedKeep: 200,
  friendHelpProduce: false,
  friendPutMosquito: false,
  friendPutPerFriend: 3,
  friendIntervalMinutes: 10,
  friendMaxPerPatrol: 5,
  friendDailyVisitLimit: 100,
}

const RANGES: Partial<Record<keyof FnosRanch, [number, number]>> = {
  rotationIdleMinutes: [1, 60],
  rotationMinGapSeconds: [30, 600],
  altHoldFallbackMinutes: [5, 720],
  friendIntervalMinutes: [5, 180],
  friendMaxPerPatrol: [1, 20],
  friendDailyVisitLimit: [10, 500],
  friendFeedPerTime: [1, 500],
  friendFeedKeep: [0, 99999],
  friendPutPerFriend: [1, 9],
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
