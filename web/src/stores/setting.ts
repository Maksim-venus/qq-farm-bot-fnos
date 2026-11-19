import { defineStore } from 'pinia'
import { ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'

export interface AutomationConfig {
  ranch_harvest?: boolean
  ranch_produce?: boolean
  ranch_buy?: boolean
  ranch_upgrade?: boolean
  ranch_sell?: boolean
  ranch_market_organic?: boolean
  ranch_market_organic_poop?: boolean
  ranch_market_organic_pinecone?: boolean
  ranch_grass?: boolean
  ranch_grass_buy?: boolean
  ranch_grass_threshold_percent?: number
  ranch_fill_cans?: boolean
  ranch_feed_normal?: boolean
  ranch_feed_organic?: boolean
  ranch_clean?: boolean
  ranch_stroke?: boolean
  ranch_friend_steal?: boolean
  ranch_friend_clean?: boolean
  ranch_friend_mosquito?: boolean
  ranch_task?: boolean
  ranch_illustrated?: boolean
  ranch_share?: boolean
  ranch_daily_benefit?: boolean
  ranch_check_minutes?: number
  ranch_strategy?: string
  ranch_bag_fallback?: string
  ranch_coop_animal?: number
  ranch_shed_animal?: number
  ranch_coop_cub_priority?: number[]
  ranch_shed_cub_priority?: number[]
  farm?: boolean
  farm_harvest_tiangong?: boolean
  farm_push?: boolean
  land_upgrade?: boolean
  friend?: boolean
  friend_auto_accept?: boolean
  task?: boolean
  sell?: boolean
  fertilizer?: string
  fertilizer_multi_season?: boolean
  fertilizer_land_types?: string[]
  fertilizer_smart_seconds?: number
  friend_steal?: boolean
  friend_help?: boolean
  friend_bad?: boolean
  friend_help_exp_limit?: boolean
  friend_help_protect_dog_ignore_exp_limit?: boolean
  fertilizer_gift?: boolean
  fertilizer_buy_organic?: boolean
  fertilizer_buy_normal?: boolean
  mystery_shop_auto_buy?: boolean
  mystery_shop_allow_gold?: boolean
  mystery_shop_allow_coupon?: boolean
  mystery_shop_allow_gold_bean?: boolean
  mystery_shop_allow_diamond?: boolean
  mystery_shop_arrival_notify?: boolean
  mystery_shop_purchase_notify?: boolean
  skip_own_weed_bug?: boolean
  show_manual_fertilizer?: boolean
}

export interface IntervalsConfig {
  farm?: number
  friend?: number
  farmMin?: number
  farmMax?: number
  friendMin?: number
  friendMax?: number
  helpMin?: number
  helpMax?: number
  stealMin?: number
  stealMax?: number
}

export interface FriendQuietHoursConfig {
  enabled?: boolean
  start?: string
  end?: string
  continueFarm?: boolean
}

export interface OfflineConfig {
  channel: string
  endpoint: string
  token: string
  secret: string
  title: string
  msg: string
  offlineDeleteSec: number
  /** [fnos-fork] Bark 下线提醒使用重要警告（静音/勿扰也响铃），缺省视为开启 */
  barkCritical?: boolean
}

export interface UIConfig {
  theme?: string
}

// [fnos-fork] 界面主题固定浅色。服务端若仍保存 dark，读入时覆盖，不回写（主题接口保持兼容）。
function lockLightUi(ui: UIConfig | undefined | null): UIConfig {
  return { ...(ui || {}), theme: 'light' }
}

// [fnos-fork] 2026-11-16 牧场增强 / 牧草地（与 utils/fnos-ranch.ts 相同；此处内联，store 不多依赖其他模块）
export interface FnosRanch {
  altHold: boolean
  altHoldFallbackMinutes: number
  illustratedAutoClaim: boolean
  illustratedAutoComplete: boolean
  friendFeed: boolean
  /** [fnos-fork] 2026-11-17 加草来源：warehouse = 农场仓库牧草（默认）；gold = 金币 */
  friendFeedSource: 'warehouse' | 'gold'
  friendFeedPerTime: number
  friendFeedGoldKeep: number
  friendHelpProduce: boolean
}

const FNOS_RANCH_DEFAULT: FnosRanch = {
  altHold: true,
  altHoldFallbackMinutes: 60,
  illustratedAutoClaim: true, // [fnos-fork] 2026-11-17 默认开
  illustratedAutoComplete: false,
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

function fnosNormalizeRanch(input: unknown): FnosRanch {
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

function fnosNormalizeGrassLands(input: unknown): FnosGrassLands {
  const src: Record<string, any> = input && typeof input === 'object' ? input as Record<string, any> : {}
  return {
    count: clamp(src.count ?? 0, 0, 24, 0),
    autoBuy: src.autoBuy !== undefined ? !!src.autoBuy : true,
  }
}

// [fnos-fork] 图鉴自动设置（与 utils/fnos-illustrated-auto.ts 相同；此处内联，store 不多依赖其他模块）
export interface FnosIllustratedAuto { autoClaimRewards: boolean, autoComplete: boolean }
function fnosNormalizeIllustratedAuto(input: any): FnosIllustratedAuto {
  const src = input && typeof input === 'object' ? input : {}
  return { autoClaimRewards: src.autoClaimRewards !== undefined ? !!src.autoClaimRewards : true /* [fnos-fork] 2026-11-17 默认开 */, autoComplete: src.autoComplete !== undefined ? !!src.autoComplete : false }
}

// [fnos-fork] 2026-11-16 自己收菜优先 / 空闲时只保留心跳（与 utils/fnos-quiet-priority.ts 相同；此处内联，store 不多依赖其他模块）
export interface FnosQuietPriority { ownHarvestFirst: boolean, mergeWindowSec: number, idleKeepaliveOnly: boolean, idleMinMinutes: number, idleMaxMinutes: number, timetableSteal: boolean, friendScanMinutes: number, ownLeadSec: number }
function fnosQuietInt(src: any, key: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(String(src?.[key] ?? ''), 10)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}
function fnosNormalizeQuietPriority(input: any): FnosQuietPriority {
  const src = input && typeof input === 'object' ? input : {}
  let idleMinMinutes = fnosQuietInt(src, 'idleMinMinutes', 1, 180, 1)
  let idleMaxMinutes = fnosQuietInt(src, 'idleMaxMinutes', 1, 180, 10)
  if (idleMinMinutes > idleMaxMinutes)
    [idleMinMinutes, idleMaxMinutes] = [idleMaxMinutes, idleMinMinutes]
  return {
    ownHarvestFirst: src.ownHarvestFirst !== undefined ? !!src.ownHarvestFirst : true,
    mergeWindowSec: fnosQuietInt(src, 'mergeWindowSec', 0, 30, 10),
    idleKeepaliveOnly: src.idleKeepaliveOnly !== undefined ? !!src.idleKeepaliveOnly : false,
    idleMinMinutes,
    idleMaxMinutes,
    timetableSteal: src.timetableSteal !== undefined ? !!src.timetableSteal : true, // [fnos-fork] 2026-11-17 按时间表偷菜
    friendScanMinutes: fnosQuietInt(src, 'friendScanMinutes', 1, 60, 5),
    ownLeadSec: fnosQuietInt(src, 'ownLeadSec', 0, 10, 2),
  }
}

export interface SettingsState {
  plantingStrategy: string
  preferredSeedId: number
  bagSeedPriority: number[]
  bagSeedMultiLandReservationEnabled: boolean
  bagSeedLandTypes: Record<string, string[]>
  bagSeedFallbackStrategy: string
  intervals: IntervalsConfig
  friendQuietHours: FriendQuietHoursConfig
  automation: AutomationConfig
  ui: UIConfig
  offlineReminder: OfflineConfig
  stealDelaySeconds: number
  plantOrderRandom: boolean
  plantDelaySeconds: number
  fertilizerBuyOrganicCount: number
  fertilizerBuyOrganicThresholdHours: number
  fertilizerBuyNormalCount: number
  fertilizerBuyNormalThresholdHours: number
  fertilizerBuyCheckIntervalMinutes: number
  emailClaimHour: number
  autoAcceptFriendMinLevel: number
  autoAcceptRequireOwnLevel: boolean
  autoAcceptHarvestStealEnabled: boolean
  autoAcceptHarvestStealHarvest: number
  autoAcceptHarvestStealSteal: number
  /** [fnos-fork] 图鉴奖励自动领取 / 自动完成图鉴（2026-11-15 起在「自动控制」里随设置一起保存） */
  fnosIllustratedAuto: FnosIllustratedAuto
  /** [fnos-fork] 2026-11-16 自己收菜优先 / 空闲时只保留心跳（「自动控制」里随设置一起保存） */
  fnosQuietPriority: FnosQuietPriority
  /** [fnos-fork] 2026-11-16 牧场增强（牧场空间「自动控制」） */
  fnosRanch: FnosRanch
  /** [fnos-fork] 2026-11-16 最后 X 块地只种牧草（农场「自动控制」） */
  fnosGrassLands: FnosGrassLands
}

type SaveableSettingsKey
  = | 'plantingStrategy'
    | 'preferredSeedId'
    | 'bagSeedPriority'
    | 'bagSeedMultiLandReservationEnabled'
    | 'bagSeedLandTypes'
    | 'bagSeedFallbackStrategy'
    | 'intervals'
    | 'friendQuietHours'
    | 'automation'
    | 'stealDelaySeconds'
    | 'plantOrderRandom'
    | 'plantDelaySeconds'
    | 'fertilizerBuyOrganicCount'
    | 'fertilizerBuyOrganicThresholdHours'
    | 'fertilizerBuyNormalCount'
    | 'fertilizerBuyNormalThresholdHours'
    | 'fertilizerBuyCheckIntervalMinutes'
    | 'emailClaimHour'
    | 'autoAcceptFriendMinLevel'
    | 'autoAcceptRequireOwnLevel'
    | 'autoAcceptHarvestStealEnabled'
    | 'autoAcceptHarvestStealHarvest'
    | 'autoAcceptHarvestStealSteal'
    | 'fnosIllustratedAuto' // [fnos-fork]
    | 'fnosQuietPriority' // [fnos-fork]
    | 'fnosRanch' // [fnos-fork]
    | 'fnosGrassLands' // [fnos-fork]

export type SettingsSavePayload = Partial<Pick<SettingsState, SaveableSettingsKey>>

const SAVEABLE_SETTINGS_KEYS: SaveableSettingsKey[] = [
  'plantingStrategy',
  'preferredSeedId',
  'bagSeedPriority',
  'bagSeedMultiLandReservationEnabled',
  'bagSeedLandTypes',
  'bagSeedFallbackStrategy',
  'intervals',
  'friendQuietHours',
  'automation',
  'stealDelaySeconds',
  'plantOrderRandom',
  'plantDelaySeconds',
  'fertilizerBuyOrganicCount',
  'fertilizerBuyOrganicThresholdHours',
  'fertilizerBuyNormalCount',
  'fertilizerBuyNormalThresholdHours',
  'fertilizerBuyCheckIntervalMinutes',
  'emailClaimHour',
  'autoAcceptFriendMinLevel',
  'autoAcceptRequireOwnLevel',
  'autoAcceptHarvestStealEnabled',
  'autoAcceptHarvestStealHarvest',
  'autoAcceptHarvestStealSteal',
  'fnosIllustratedAuto', // [fnos-fork]
  'fnosQuietPriority', // [fnos-fork]
  'fnosRanch', // [fnos-fork]
  'fnosGrassLands', // [fnos-fork]
]

function createDefaultSettings(): SettingsState {
  return {
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    bagSeedPriority: [],
    bagSeedMultiLandReservationEnabled: false,
    bagSeedLandTypes: {},
    bagSeedFallbackStrategy: 'level',
    intervals: {},
    friendQuietHours: { enabled: false, start: '23:00', end: '07:00', continueFarm: true },
    automation: {},
    ui: { theme: 'light' }, // [fnos-fork]
    offlineReminder: {
      channel: 'webhook',
      endpoint: '',
      token: '',
      secret: '',
      title: '账号下线提醒',
      msg: '账号下线',
      offlineDeleteSec: 0,
      barkCritical: true, // [fnos-fork]
    },
    stealDelaySeconds: 0,
    plantOrderRandom: false,
    plantDelaySeconds: 0,
    fertilizerBuyOrganicCount: 10,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 10,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 30,
    emailClaimHour: 10,
    autoAcceptFriendMinLevel: 0,
    autoAcceptRequireOwnLevel: false,
    autoAcceptHarvestStealEnabled: true,
    autoAcceptHarvestStealHarvest: 8,
    autoAcceptHarvestStealSteal: 1,
    fnosIllustratedAuto: fnosNormalizeIllustratedAuto(null), // [fnos-fork]
    fnosQuietPriority: fnosNormalizeQuietPriority(null), // [fnos-fork]
    fnosRanch: fnosNormalizeRanch(null), // [fnos-fork]
    fnosGrassLands: fnosNormalizeGrassLands(null), // [fnos-fork]
  }
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null)
    return value
  return JSON.parse(JSON.stringify(value))
}

export const useSettingStore = defineStore('setting', () => {
  const settings = ref<SettingsState>(createDefaultSettings())
  const loading = ref(false)
  const loadedAccountId = ref('')
  let pendingRequests = 0
  let fetchRevision = 0
  let latestRequestedAccountId = ''

  function beginRequest() {
    pendingRequests++
    loading.value = true
  }

  function endRequest() {
    pendingRequests = Math.max(0, pendingRequests - 1)
    loading.value = pendingRequests > 0
  }

  function applyFetchedSettings(data: any) {
    const defaults = createDefaultSettings()
    settings.value = {
      plantingStrategy: data.strategy || defaults.plantingStrategy,
      preferredSeedId: data.preferredSeed || defaults.preferredSeedId,
      bagSeedPriority: cloneValue(data.bagSeedPriority ?? defaults.bagSeedPriority),
      bagSeedMultiLandReservationEnabled: data.bagSeedMultiLandReservationEnabled ?? defaults.bagSeedMultiLandReservationEnabled,
      bagSeedLandTypes: cloneValue(data.bagSeedLandTypes ?? defaults.bagSeedLandTypes),
      bagSeedFallbackStrategy: data.bagSeedFallbackStrategy ?? defaults.bagSeedFallbackStrategy,
      intervals: cloneValue(data.intervals || defaults.intervals),
      friendQuietHours: {
        ...defaults.friendQuietHours,
        ...(cloneValue(data.friendQuietHours) || {}),
      },
      automation: cloneValue(data.automation || defaults.automation),
      ui: lockLightUi(cloneValue(data.ui || defaults.ui)), // [fnos-fork]
      offlineReminder: {
        ...defaults.offlineReminder,
        ...(cloneValue(data.offlineReminder) || {}),
      },
      stealDelaySeconds: data.stealDelaySeconds ?? defaults.stealDelaySeconds,
      plantOrderRandom: data.plantOrderRandom ?? defaults.plantOrderRandom,
      plantDelaySeconds: data.plantDelaySeconds ?? defaults.plantDelaySeconds,
      fertilizerBuyOrganicCount: data.fertilizerBuyOrganicCount ?? defaults.fertilizerBuyOrganicCount,
      fertilizerBuyOrganicThresholdHours: data.fertilizerBuyOrganicThresholdHours ?? defaults.fertilizerBuyOrganicThresholdHours,
      fertilizerBuyNormalCount: data.fertilizerBuyNormalCount ?? defaults.fertilizerBuyNormalCount,
      fertilizerBuyNormalThresholdHours: data.fertilizerBuyNormalThresholdHours ?? defaults.fertilizerBuyNormalThresholdHours,
      fertilizerBuyCheckIntervalMinutes: data.fertilizerBuyCheckIntervalMinutes ?? defaults.fertilizerBuyCheckIntervalMinutes,
      emailClaimHour: data.emailClaimHour ?? defaults.emailClaimHour,
      autoAcceptFriendMinLevel: data.autoAcceptFriendMinLevel ?? defaults.autoAcceptFriendMinLevel,
      autoAcceptRequireOwnLevel: data.autoAcceptRequireOwnLevel ?? defaults.autoAcceptRequireOwnLevel,
      autoAcceptHarvestStealEnabled: data.autoAcceptHarvestStealEnabled ?? defaults.autoAcceptHarvestStealEnabled,
      autoAcceptHarvestStealHarvest: data.autoAcceptHarvestStealHarvest ?? defaults.autoAcceptHarvestStealHarvest,
      autoAcceptHarvestStealSteal: data.autoAcceptHarvestStealSteal ?? defaults.autoAcceptHarvestStealSteal,
      fnosIllustratedAuto: fnosNormalizeIllustratedAuto(data.fnosIllustratedAuto), // [fnos-fork]
      fnosQuietPriority: fnosNormalizeQuietPriority(data.fnosQuietPriority), // [fnos-fork]
      fnosRanch: fnosNormalizeRanch(data.fnosRanch), // [fnos-fork]
      fnosGrassLands: fnosNormalizeGrassLands(data.fnosGrassLands), // [fnos-fork]
    }
  }

  function applySavedSettings(payload: SettingsSavePayload, data: any) {
    const normalized = data && typeof data === 'object' ? data : {}
    for (const key of SAVEABLE_SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(payload, key))
        (settings.value as any)[key] = cloneValue(payload[key])
      if (Object.prototype.hasOwnProperty.call(normalized, key))
        (settings.value as any)[key] = cloneValue(normalized[key])
    }

    if (normalized.strategy !== undefined)
      settings.value.plantingStrategy = normalized.strategy || 'max_exp'
    if (normalized.preferredSeed !== undefined)
      settings.value.preferredSeedId = normalized.preferredSeed || 0
  }

  async function fetchSettings(accountId: string) {
    if (!accountId)
      return false
    const requestRevision = ++fetchRevision
    latestRequestedAccountId = accountId
    loadedAccountId.value = ''
    beginRequest()
    try {
      const { data } = await api.get('/api/settings', {
        headers: { 'x-account-id': accountId },
      })
      if (requestRevision !== fetchRevision)
        return false
      if (data && data.ok && data.data) {
        applyFetchedSettings(data.data)
        loadedAccountId.value = accountId
        return true
      }
      return false
    }
    finally {
      endRequest()
    }
  }

  async function saveSettings(accountId: string, newSettings: SettingsSavePayload) {
    if (!accountId)
      return { ok: false, error: '未选择账号' }

    const payload: SettingsSavePayload = {}
    for (const key of SAVEABLE_SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(newSettings, key))
        (payload as any)[key] = cloneValue(newSettings[key])
    }

    if (Object.keys(payload).length === 0)
      return { ok: false, error: '没有需要保存的设置' }

    beginRequest()
    try {
      const { data } = await api.post('/api/settings/save', payload, {
        headers: { 'x-account-id': accountId },
        timeout: 15000,
      })
      if (!data?.ok) {
        if (data?.saved && (!latestRequestedAccountId || latestRequestedAccountId === accountId)) {
          loadedAccountId.value = accountId
          applySavedSettings(payload, data.data)
        }
        return {
          ok: false,
          saved: !!data?.saved,
          unconfirmed: !!data?.unconfirmed,
          data: data?.data,
          error: getApiErrorMessage(data, '保存失败'),
        }
      }

      if (!latestRequestedAccountId || latestRequestedAccountId === accountId) {
        loadedAccountId.value = accountId
        applySavedSettings(payload, data.data)
      }
      return { ok: true, data: data.data }
    }
    catch (error: any) {
      return { ok: false, error: getApiErrorMessage(error, '保存失败') }
    }
    finally {
      endRequest()
    }
  }

  async function saveOfflineConfig(config: OfflineConfig) {
    beginRequest()
    try {
      const { data } = await api.post('/api/settings/offline-reminder', config)
      if (data && data.ok) {
        settings.value.offlineReminder = cloneValue(config)
        return { ok: true }
      }
      return { ok: false, error: '保存失败' }
    }
    catch (error: any) {
      return { ok: false, error: getApiErrorMessage(error, '保存失败') }
    }
    finally {
      endRequest()
    }
  }

  return { settings, loading, loadedAccountId, fetchSettings, saveSettings, saveOfflineConfig }
})
