// [fnos-fork] 2026-11-23 首页合并概览：农场 / 牧场各自整理成同一种「概览快照」。
// 当前所在空间用实时数据现算，另一边读服务端按账号持久化的快照（/api/fnos/overview-cache），不再实时查游戏。
// 纯函数，不依赖 vue / pinia，方便单测。

export type OverviewSpace = 'farm' | 'ranch'

export interface OverviewTile { key: string | number, label: string, value: string, image?: string, imageId?: number }
export interface OverviewSnapshot {
  space: OverviewSpace
  level: number
  /** needed 为 0 表示满级 / 未知 */
  exp: { current: number, needed: number }
  assets: OverviewTile[]
  stock: OverviewTile[]
  /** 牧场：收获 / 成熟 / 收取好友；农场：只有收获 / 偷菜（mature 缺省） */
  career: { harvest: number, mature?: number, steal: number } | null
  facilities: Array<{ id: string, name: string, level: number, text: string, percent: number, pending: boolean }>
  todo: Array<{ key: string, label: string, value: number }>
  today: Array<{ key: string, label: string, count: number }>
  /** at：绝对时间（毫秒），null = 没有下次；note：静默中 / 今日已完成 等 */
  nextChecks: Array<{ key: string, label: string, at: number | null, note?: string }>
  notice?: string
  updatedAt?: number
}

export function formatCount(value: unknown): string {
  const text = String(value ?? '0')
  try {
    return BigInt(text).toLocaleString('zh-CN')
  }
  catch {
    const n = Number(text)
    return Number.isFinite(n) ? n.toLocaleString('zh-CN') : text
  }
}

export function formatHours(seconds: unknown): string {
  return `${((Number(seconds) || 0) / 3600).toFixed(1)}h`
}

function formatDuration(seconds: number): string {
  const n = Math.max(0, Math.ceil(seconds))
  const d = Math.floor(n / 86400)
  const h = Math.floor(n % 86400 / 3600)
  const m = Math.floor(n % 3600 / 60)
  if (d > 0)
    return `${d}天${h}小时`
  if (h > 0)
    return `${h}小时${m}分`
  return `${m}分${n % 60}秒`
}

function amount(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)).toLocaleString('zh-CN') : '0'
}

const FARM_OP_LABELS: Record<string, string> = {
  harvest: '收获',
  farming: '一键务农',
  fertilize: '施肥',
  plant: '种植',
  steal: '偷菜',
  helpFarming: '帮务农',
  taskClaim: '任务',
  sell: '出售',
}
export const farmOpLabel = (key: string) => FARM_OP_LABELS[key] || key

function remainToAt(sec: unknown, now: number): number | null {
  const n = Number(sec)
  return sec === null || sec === undefined || !Number.isFinite(n) ? null : now + Math.max(0, n) * 1000
}

export function buildFarmSnapshot(input: { status: any, items?: any[], diamond?: unknown, career?: { harvest: number, steal: number } | null, now?: number }): OverviewSnapshot {
  const now = input.now ?? Date.now()
  const s = input.status || {}
  const items = input.items || []
  const item = (id: number) => items.find((i: any) => Number(i.id) === id)
  const bucket = (id: number) => {
    const it = item(id)
    if (!it)
      return '0.0h'
    return it.hoursText ? String(it.hoursText).replace('小时', 'h') : `${((Number(it.count) || 0) / 3600).toFixed(1)}h`
  }
  const count = (id: number) => (Number(item(id)?.count) || 0).toLocaleString('zh-CN')
  const checks = s.nextChecks || {}
  const friendSec = checks.friendRemainSec ?? checks.helpRemainSec ?? checks.stealRemainSec
  const friendQuiet = checks.friendQuiet ?? checks.helpQuiet ?? checks.stealQuiet
  const ops = s.operations || {}
  return {
    space: 'farm',
    level: Number(s.status?.level) || 0,
    exp: { current: Number(s.levelProgress?.current) || 0, needed: Number(s.levelProgress?.needed) || 0 },
    assets: [
      { key: 'gold', label: '金币', value: amount(s.status?.gold) },
      { key: 'coupon', label: '点券', value: amount(s.status?.coupon) },
      { key: 'goldBean', label: '金豆豆', value: amount(s.status?.goldBean) },
      { key: 'diamond', label: '钻石', value: amount(input.diamond) },
    ],
    stock: [
      { key: 1011, label: '普通化肥', value: bucket(1011) },
      { key: 1012, label: '有机化肥', value: bucket(1012) },
      { key: 3001, label: '普通收藏点', value: count(3001) },
      { key: 3002, label: '典藏收藏点', value: count(3002) },
    ],
    career: input.career ? { harvest: Number(input.career.harvest) || 0, steal: Number(input.career.steal) || 0 } : null,
    facilities: [],
    todo: [],
    today: Object.keys(ops).filter(k => k !== 'upgrade' && k !== 'levelUp').map(k => ({ key: k, label: farmOpLabel(k), count: Number(ops[k]) || 0 })),
    nextChecks: [
      { key: 'farm', label: '农场', at: checks.farmQuiet ? null : remainToAt(checks.farmRemainSec, now), note: checks.farmQuiet ? '静默中' : undefined },
      { key: 'friend', label: '好友任务', at: friendQuiet ? null : remainToAt(friendSec, now), note: friendQuiet ? '静默中' : undefined },
    ],
  }
}

export function sortFacilities<T extends { moduleType?: number | string, id?: number | string }>(list: T[]): T[] {
  const order: Record<number, number> = { 6: 0, 7: 1, 8: 2 }
  return [...list].sort((a, b) => (order[Number(a.moduleType)] ?? 9) - (order[Number(b.moduleType)] ?? 9)
    || String(a.id ?? '').localeCompare(String(b.id ?? ''), undefined, { numeric: true }))
}

export function buildRanchSnapshot(input: {
  state: any
  ranchOperations?: Record<string, number> | null
  ranchRemainSec?: number | null
  imageOf: (id: number) => string
  now?: number
}): OverviewSnapshot {
  const now = input.now ?? Date.now()
  const st = input.state || {}
  const facilities = sortFacilities<any>(st.facilities || [])
  const pens = facilities.filter(f => f.ranch)
  const animals = pens.flatMap(f => (f.ranch.animals || []))
  const shelvesReady = pens.reduce((sum, f) => sum + (f.ranch.shelves || []).filter((x: any) => x.canCollect).length, 0)
  const hazards = pens.reduce((sum, f) => sum + (f.ranch.hazards?.length || 0), 0)
  const blocked = animals.filter((a: any) => a.grassBlocked).length
  const currency = (id: number) => (st.currencies || []).find((c: any) => Number(c.id) === id)
  const dung = currency(7002)
  const serverNow = Number(st.serverTime) || now
  const ops = input.ranchOperations || null
  const meter = (f: any) => {
    if (f.state === 2)
      return { text: '待建造', percent: 0 }
    if (f.upgradeState) {
      const end = Number(f.upgradeEndTime)
      const ms = end < 100_000_000_000 ? end * 1000 : end
      return { text: `升级中 · ${formatDuration((ms - serverNow) / 1000)}`, percent: 0 }
    }
    if (f.ranch)
      return { text: `${f.ranch.count} / ${f.ranch.capacity}`, percent: f.ranch.capacity ? f.ranch.count / f.ranch.capacity * 100 : 0 }
    if (f.feed)
      return { text: `牧草 ${f.feed.count} / ${f.capacity}`, percent: f.capacity ? f.feed.count / f.capacity * 100 : 0 }
    return { text: `容量 ${f.capacity}`, percent: 0 }
  }
  const bucketDefs = [{ id: 7003, name: '普通罐头', image: 80021 }, { id: 7004, name: '有机罐头', image: 80031 }]
  const remain = input.ranchRemainSec
  return {
    space: 'ranch',
    level: Number(st.level) || 0,
    exp: { current: Number(st.currentExp) || 0, needed: Number(st.neededExp) || 0 },
    assets: [1007, 1002, 1005, 1008].map(currency).filter(Boolean).map((c: any) => ({ key: c.id, label: c.name, value: formatCount(c.count), image: c.image })),
    stock: [
      { key: 7001, label: '牧草', value: formatCount(st.grass ?? 0), image: input.imageOf(7001) },
      ...(dung ? [{ key: 7002, label: dung.name, value: formatCount(dung.count), image: dung.image }] : []),
      ...bucketDefs.map(b => ({ key: b.id, label: b.name, value: formatHours((st.buckets || []).find((x: any) => Number(x.id) === b.id)?.seconds ?? 0), image: input.imageOf(b.image) })),
    ],
    career: st.career ? { harvest: Number(st.career.harvest) || 0, mature: Number(st.career.mature) || 0, steal: Number(st.career.steal) || 0 } : null,
    facilities: facilities.map(f => ({ id: String(f.id), name: String(f.name), level: Number(f.level) || 0, ...meter(f), pending: f.state === 2 })),
    todo: [
      { key: 'harvest', label: '可收获', value: animals.filter((a: any) => a.canHarvest).length + shelvesReady },
      { key: 'produce', label: '可生产', value: animals.filter((a: any) => a.canProduce).length },
      { key: 'feed', label: '可喂养', value: animals.filter((a: any) => a.canFeed).length },
      { key: 'clean', label: '待清理', value: hazards },
    ],
    today: ops
      ? [
          { key: 'harvest', label: '收获', count: Number(ops.harvest) || 0 },
          { key: 'produce', label: '生产', count: Number(ops.produce) || 0 },
          { key: 'helpFarming', label: '帮忙清理', count: Number(ops.helpFarming) || 0 },
          { key: 'steal', label: '偷取货架', count: Number(ops.steal) || 0 },
        ]
      : [],
    nextChecks: [{ key: 'ranch', label: '牧场', at: remainToAt(remain, now), note: remain === null || remain === undefined ? '今日已完成或暂停' : undefined }],
    notice: blocked ? `牧草不足，${blocked} 只动物已暂停成长。` : undefined,
  }
}

/** 更新时间的展示：刚刚 / N 分钟前 / N 小时前 / 月日时分 */
export function formatUpdatedAt(updatedAt: number | undefined, now = Date.now()): string {
  if (!updatedAt)
    return ''
  const diff = Math.max(0, now - updatedAt)
  if (diff < 60_000)
    return '刚刚'
  if (diff < 3_600_000)
    return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000)
    return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(updatedAt + 8 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

export interface MergedAsset { key: string | number, label: string, value: string, image?: string, imageId?: number, shared?: boolean, from: OverviewSpace }

/**
 * 首页资产：农场、牧场合成一排。点券、金豆豆两边是同一个货币，只显示一个值，取「更新的那边」（asOf 大的；实时数据用当前时间）；
 * 钻石也是通用货币，只在农场一侧读取，同样只显示一次。金币、金券、松果各自只属于一边。
 * 某一边没有数据（没缓存）时，只显示另一边有的项。
 */
export function mergeOverviewAssets(farm: OverviewSnapshot | null, ranch: OverviewSnapshot | null, farmAsOf = 0, ranchAsOf = 0): MergedAsset[] {
  const out: MergedAsset[] = []
  const farmTile = (key: string) => farm?.assets.find(t => String(t.key) === key)
  const ranchTile = (key: number) => ranch?.assets.find(t => Number(t.key) === key)
  const newest = (f?: OverviewTile, r?: OverviewTile): { tile: OverviewTile, from: OverviewSpace } | null => {
    if (f && r)
      return ranchAsOf > farmAsOf ? { tile: r, from: 'ranch' } : { tile: f, from: 'farm' }
    if (f)
      return { tile: f, from: 'farm' }
    return r ? { tile: r, from: 'ranch' } : null
  }
  const gold = farmTile('gold')
  if (gold)
    out.push({ ...gold, from: 'farm' })
  const coupon = newest(farmTile('coupon'), ranchTile(1002))
  if (coupon)
    out.push({ ...coupon.tile, key: 'coupon', label: '点券', shared: true, from: coupon.from })
  const bean = newest(farmTile('goldBean'), ranchTile(1005))
  if (bean)
    out.push({ ...bean.tile, key: 'goldBean', label: '金豆豆', shared: true, from: bean.from })
  const diamond = farmTile('diamond')
  if (diamond)
    out.push({ ...diamond, from: 'farm' })
  for (const id of [1007, 1008]) {
    const t = ranchTile(id)
    if (t)
      out.push({ ...t, from: 'ranch' })
  }
  return out
}
