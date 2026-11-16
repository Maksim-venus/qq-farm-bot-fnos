// [fnos-fork] 2026-11-17 运行日志农场 / 牧场分开：农场概览只看农场日志、牧场概览只看牧场日志，各自一套筛选。
// 区分规则与 core/src/runtime/fnos-log-categories.ts 的 isFnosRanchLog 一致；/api/logs 带 space=farm|ranch 由服务端先按空间过滤。

export type FnosLogSpace = 'farm' | 'ranch'

export function fnosIsRanchLog(entry: any): boolean {
  if (!entry || typeof entry !== 'object')
    return false
  const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {}
  const event = String(meta.event || '')
  return String(meta.module || '') === 'ranch' || /^(?:ranch_|fnos牧场|fnos好友牧场)/.test(event) || String(entry.tag || '') === '牧场'
}

export function fnosFilterLogSpace<T>(list: T[], space: FnosLogSpace): T[] {
  return (list || []).filter(entry => fnosIsRanchLog(entry) === (space === 'ranch'))
}

interface Option { label: string, value: string }

/** 牧场事件筛选：一项可对应多个 meta.event（逗号分隔，服务端按“任一匹配”过滤）。 */
export const FNOS_RANCH_EVENT_OPTIONS: Option[] = [
  { label: '所有事件', value: '' },
  { label: '牧场巡查', value: 'ranch_automation,ranch_scene_restore' },
  { label: '收获', value: 'ranch_harvest' },
  { label: '生产', value: 'ranch_produce' },
  { label: '喂养 / 罐头', value: 'ranch_feed,ranch_useCan' },
  { label: '补充牧草', value: 'ranch_addGrass' },
  { label: '补栏（买幼崽 / 放养）', value: 'ranch_buy,ranch_place' },
  { label: '清理便便蚊子', value: 'ranch_clean' },
  { label: '出售产物', value: 'ranch_sell' },
  { label: '设施升级', value: 'ranch_upgrade,ranch_completeUpgrade' },
  { label: '偷取好友', value: 'ranch_steal' },
  { label: '放蚊子', value: 'ranch_putMosquito,ranch_fnosBad' },
  { label: '清理好友牧场', value: 'ranch_cleanFriend' },
  { label: '抚摸', value: 'ranch_stroke' },
  { label: '帮好友生产', value: 'ranch_fnosHelpProduce' },
  { label: '给好友加牧草', value: 'ranch_fnosFeedFriend' },
  { label: '拜访好友 / 大小号规则', value: 'ranch_friend,ranch_friend_leave,fnos好友牧场' },
  { label: '等大号', value: 'fnos牧场等大号' },
  { label: '牧场图鉴', value: 'fnos牧场图鉴,ranch_claimIllustrated' },
  { label: '牧场任务', value: 'ranch_task_claim' },
  { label: '分享礼包', value: 'ranch_daily_share' },
  { label: '其他增强', value: 'fnos牧场' },
]

/** 牧场范围筛选：自己牧场 / 好友牧场 / 任务礼包。 */
export const FNOS_RANCH_SCOPE_OPTIONS: Option[] = [
  { label: '全部范围', value: '' },
  { label: '自己牧场', value: 'ranch_automation,ranch_scene_restore,ranch_harvest,ranch_produce,ranch_feed,ranch_useCan,ranch_addGrass,ranch_buy,ranch_place,ranch_clean,ranch_sell,ranch_upgrade,ranch_completeUpgrade,fnos牧场等大号,fnos牧场图鉴,ranch_claimIllustrated,fnos牧场' },
  { label: '好友牧场', value: 'ranch_steal,ranch_putMosquito,ranch_fnosBad,ranch_cleanFriend,ranch_stroke,ranch_fnosHelpProduce,ranch_fnosFeedFriend,ranch_friend,ranch_friend_leave,fnos好友牧场' },
  { label: '任务与礼包', value: 'ranch_task_claim,ranch_daily_share' },
]

/** 单个事件的显示名（日志行上的小标签）。 */
export function fnosRanchEventLabel(event: string): string {
  const raw = String(event || '')
  if (!raw)
    return ''
  const hit = FNOS_RANCH_EVENT_OPTIONS.find(option => option.value && option.value.split(',').includes(raw))
  return hit ? hit.label : raw
}

/** 范围与事件同时选时取事件（事件本身就在某个范围内）；返回给 /api/logs 的 event 参数。 */
export function fnosRanchEventParam(scope: string, event: string): string | undefined {
  return event || scope || undefined
}
