// [fnos-fork] 2026-11-17 好友时间表「还多久可偷」列（参考空间版农牧助手的「成熟倒计时 / 赶产倒计时」）：纯函数

/** 后端 /api/fnos/timetable 的一行（本地毫秒，服务器时钟） */
export interface FnosTimetableRow {
  gid: number
  name: string
  farmRipeAt: number
  farmHelpAt: number
  farmSeenAt: number
  farmVisitedAt: number
  ranchReadyAt: number
  ranchSeenAt: number
  ranchVisitedAt: number
}

export interface FnosCountdownCell {
  /** 列里显示的文字：hh:mm:ss 倒计时，或「可偷」「未扫描」，农场「空地」/ 牧场「暂无可偷」 */
  text: string
  /** 现在可偷（整行高亮） */
  ready: boolean
  /** 倒计时中 */
  counting: boolean
  title: string
}

function num(v: any): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function fnosNormalizeTimetableRows(raw: any): FnosTimetableRow[] {
  return (Array.isArray(raw) ? raw : []).map((r: any) => ({
    gid: num(r?.gid),
    name: String(r?.name || ''),
    farmRipeAt: num(r?.farmRipeAt),
    farmHelpAt: num(r?.farmHelpAt),
    farmSeenAt: num(r?.farmSeenAt),
    farmVisitedAt: num(r?.farmVisitedAt),
    ranchReadyAt: num(r?.ranchReadyAt),
    ranchSeenAt: num(r?.ranchSeenAt),
    ranchVisitedAt: num(r?.ranchVisitedAt),
  })).filter(r => r.gid > 0)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 倒计时 hh:mm:ss（超过 24 小时照样累计小时，如 26:03:11） */
export function fnosFormatCountdown(ms: number): string {
  const sec = Math.max(0, Math.ceil(num(ms) / 1000))
  return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor(sec / 60) % 60)}:${pad2(sec % 60)}`
}

/** 时刻 hh:mm:ss（浏览器本地时区） */
export function fnosFormatClock(ms: number): string {
  if (!(ms > 0))
    return '--:--:--'
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function cell(row: { at: number, seenAt: number, visitedAt: number } | null, nowMs: number, liveCanSteal: boolean, what: { ripe: string, unseen: string, empty: string }): FnosCountdownCell {
  if (liveCanSteal)
    return { text: '可偷', ready: true, counting: false, title: '好友列表显示现在有可偷的' }
  if (!row || !(row.seenAt > 0))
    return { text: '未扫描', ready: false, counting: false, title: what.unseen }
  if (row.at > nowMs)
    return { text: fnosFormatCountdown(row.at - nowMs), ready: false, counting: true, title: `预计 ${fnosFormatClock(row.at)} ${what.ripe}` }
  if (row.at > 0)
    return { text: '可偷', ready: true, counting: false, title: `${fnosFormatClock(row.at)} 已${what.ripe}，按时间表会马上去` }
  return { text: what.empty, ready: false, counting: false, title: row.visitedAt > 0 ? `${fnosFormatClock(row.visitedAt)} 去过，暂时没有在长的` : '暂时没有在长的' }
}

/** 农场好友「还多久可偷」：nowMs 用服务器时钟（浏览器时间 + 偏差） */
export function fnosFarmCountdown(row: FnosTimetableRow | undefined, nowMs: number, liveCanSteal = false): FnosCountdownCell {
  const c = cell(row ? { at: row.farmRipeAt, seenAt: row.farmSeenAt, visitedAt: row.farmVisitedAt } : null, nowMs, liveCanSteal, {
    ripe: '成熟',
    empty: '空地',
    unseen: '还没进过这位好友的农场，好友列表每次扫描会顺手探几位',
  })
  if (row && row.farmHelpAt > 0)
    c.title += row.farmHelpAt > nowMs ? `；预计 ${fnosFormatClock(row.farmHelpAt)} 需要帮忙` : '；现在需要帮忙'
  return c
}

/** 牧场好友「还多久可偷」（赶产倒计时） */
export function fnosRanchCountdown(row: FnosTimetableRow | undefined, nowMs: number, liveCanSteal = false): FnosCountdownCell {
  return cell(row ? { at: row.ranchReadyAt, seenAt: row.ranchSeenAt, visitedAt: row.ranchVisitedAt } : null, nowMs, liveCanSteal, {
    ripe: '可偷',
    empty: '暂无可偷',
    unseen: '还没进过这位好友的牧场，牧场轮次每轮会顺手看几位',
  })
}
