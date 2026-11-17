// [fnos-fork] 2026-11-17 运行日志农场 / 牧场区分：一张卡片顶部「全部 / 农场 / 牧场」切换，农场、牧场各用自己的筛选。
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
  { label: '牧场巡查', value: 'ranch_automation,ranch_scene_restore,fnos牧场轮次' }, // [fnos-fork] 2026-11-17 含农牧轮次切换
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
  { label: '每日福利', value: 'ranch_daily_benefit' }, // [fnos-fork] 上游 PR #142
  { label: '其他增强', value: 'fnos牧场' },
]

/** 牧场范围筛选：自己牧场 / 好友牧场 / 任务礼包。 */
export const FNOS_RANCH_SCOPE_OPTIONS: Option[] = [
  { label: '全部范围', value: '' },
  { label: '自己牧场', value: 'ranch_automation,ranch_scene_restore,fnos牧场轮次,ranch_harvest,ranch_produce,ranch_feed,ranch_useCan,ranch_addGrass,ranch_buy,ranch_place,ranch_clean,ranch_sell,ranch_upgrade,ranch_completeUpgrade,fnos牧场等大号,fnos牧场图鉴,ranch_claimIllustrated,fnos牧场' },
  { label: '好友牧场', value: 'ranch_steal,ranch_putMosquito,ranch_fnosBad,ranch_cleanFriend,ranch_stroke,ranch_fnosHelpProduce,ranch_fnosFeedFriend,ranch_friend,ranch_friend_leave,fnos好友牧场' },
  { label: '任务与礼包', value: 'ranch_task_claim,ranch_daily_share,ranch_daily_benefit' },
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

// ============ [fnos-fork] 2026-11-17 农场、牧场日志合并成一张卡片：顶部「全部 / 农场 / 牧场」切换 ============
export type FnosLogSpaceView = 'all' | 'farm' | 'ranch'

export const FNOS_LOG_SPACE_VIEWS: { value: FnosLogSpaceView, label: string, icon: string }[] = [
  { value: 'all', label: '全部', icon: 'i-carbon-list' },
  { value: 'farm', label: '农场', icon: 'i-carbon-sprout' },
  { value: 'ranch', label: '牧场', icon: 'i-carbon-pedestrian-family' },
]

export const FNOS_LOG_SPACE_STORAGE_KEY = 'fnos-run-log-space'

/** 每个空间在前端保留的条数（服务端快照也是农场、牧场各 300 条）。 */
export const FNOS_LOG_PER_SPACE_CAP = 300

export function fnosNormalizeLogSpaceView(value: unknown): FnosLogSpaceView {
  return value === 'farm' || value === 'ranch' ? value : 'all'
}

/** 读上次的选择；没有或读不到时为「全部」。 */
export function fnosLoadLogSpaceView(storage: Pick<Storage, 'getItem'> | null | undefined = globalThis.localStorage): FnosLogSpaceView {
  try {
    return fnosNormalizeLogSpaceView(storage?.getItem(FNOS_LOG_SPACE_STORAGE_KEY))
  }
  catch {
    return 'all'
  }
}

export function fnosSaveLogSpaceView(value: unknown, storage: Pick<Storage, 'setItem'> | null | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(FNOS_LOG_SPACE_STORAGE_KEY, fnosNormalizeLogSpaceView(value))
  }
  catch {
    // 隐私模式等写不进去时只是不记住
  }
}

/** 按当前切换筛选；「全部」不过滤。 */
export function fnosFilterLogSpaceView<T>(list: T[], view: FnosLogSpaceView): T[] {
  return view === 'all' ? (list || []).slice() : fnosFilterLogSpace(list, view)
}

/** 农场、牧场各保留最后 cap 条（保持原顺序），实时日志不会让农场把牧场挤掉。 */
export function fnosTrimLogsPerSpace<T>(list: T[], cap = FNOS_LOG_PER_SPACE_CAP): T[] {
  const source = list || []
  let farm = 0
  let ranch = 0
  for (const entry of source) {
    if (fnosIsRanchLog(entry))
      ranch++
    else farm++
  }
  if (farm <= cap && ranch <= cap)
    return source
  let dropFarm = Math.max(0, farm - cap)
  let dropRanch = Math.max(0, ranch - cap)
  return source.filter((entry) => {
    if (fnosIsRanchLog(entry)) {
      if (dropRanch > 0) {
        dropRanch--
        return false
      }
      return true
    }
    if (dropFarm > 0) {
      dropFarm--
      return false
    }
    return true
  })
}

export interface FnosRanchDaySummary {
  date: string
  steal: { times: number, friends: string[], items: Record<string, number> }
  harvest: number
  produce: number
  sell: number
  addGrass: number
  clean: number
  buy: number
  cleanFriend: number
  putMosquito: number
  stroke: number
  helpProduce: number
  feedFriend: number
  errors: number
}

/** 牧场今日汇总的显示片段：偷取单独一段（含物品），其余非 0 的动作按次数列出。 */
export function fnosRanchSummaryParts(summary: Partial<FnosRanchDaySummary> | null | undefined): { steal: string, actions: string[] } {
  const s = summary || {}
  const steal = s.steal && s.steal.times > 0
    ? `偷取 ${s.steal.times} 次（${s.steal.friends?.length || 0} 位好友）：${Object.entries(s.steal.items || {}).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}×${count}`).join('、') || '物品未知'}`
    : '偷取 0 次'
  const labels: [keyof FnosRanchDaySummary, string][] = [
    ['harvest', '收获'],
    ['produce', '生产'],
    ['sell', '出售'],
    ['addGrass', '补牧草'],
    ['clean', '清理自家'],
    ['buy', '补栏'],
    ['cleanFriend', '帮好友清理'],
    ['helpProduce', '帮好友生产'],
    ['feedFriend', '给好友加草'],
    ['stroke', '抚摸'],
    ['putMosquito', '放蚊子'],
    ['errors', '出错'],
  ]
  const actions = labels
    .filter(([key]) => Number((s as any)[key]) > 0)
    .map(([key, label]) => `${label} ${Number((s as any)[key])}`)
  return { steal, actions }
}
